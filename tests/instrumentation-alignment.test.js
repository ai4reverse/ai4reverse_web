import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { createCodeInstrumenter } from '../tools/instrumentation/code.js'
import { detectDispatch, locateInterpreter } from '../tools/instrumentation/jsvmp.js'
import { parse } from '../tools/restore/parse.js'
import { analyzeVM, buildVM, buildSampleProgram } from '../tools/jsvmp/index.js'
import { analyzeSample } from '../tools/analysis/orchestrator.js'

test('JSVMP public barrel does not expose the internal structural detector', async () => {
  const surface = await import('../tools/jsvmp/index.js')
  assert.equal(Object.hasOwn(surface, 'analyzeVMStructure'), false)
  for (const name of ['analyzeVM', 'extractHandlers', 'isJSVMP', 'summarizeVM', 'buildVM', 'buildSampleProgram']) {
    assert.equal(typeof surface[name], 'function', name)
  }
})

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'anti-fingerprint']
const LEVELS = ['off', 'function', 'branch', 'statement', undefined]
const STRICT_CASES = [
  ['function this', 'function f(){"use strict";return this===undefined} f()', true],
  ['function ASI', 'function f(){"custom"\n"use strict"\nreturn this===undefined} f()', true],
  ['program inherited strict', '"use strict";function f(){return this===undefined} f()', true],
  ['program ASI', '"custom"\n"use strict"\nfunction f(){return this===undefined}\nf()', true],
  ['hashbang program', '#!/usr/bin/env node\n"use strict"\nfunction f(){return this===undefined}\nf()', true],
  ['directive source masking', 'function f(){"use strict"\nreturn this} f.toString()', 'function f(){"use strict"\nreturn this}'],
  ['strict assignment error', '"use strict";var result;try{missingStrictBinding=1}catch(e){result=e.name}result', 'ReferenceError'],
  ['strict readonly error', 'function f(){"use strict";try{Object.freeze({x:1}).x=2}catch(e){return e.name}}f()', 'TypeError'],
  ['sloppy control', 'function f(){return this===globalThis}f()', true],
  ['non-directive string control', 'function f(){0;"use strict";return this===globalThis}f()', true],
]

for (const level of LEVELS) {
  test(`H1 preserves strict and sloppy semantics at ${level ?? 'default'} level`, async (t) => {
    const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: false, only: ENV } })
    try {
      for (const [name, source, expected] of STRICT_CASES) {
        await t.test(name, async () => {
          const run = await sb.run(source, level === undefined ? {} : { level })
          assert.equal(run.ok, true, JSON.stringify(run.error))
          assert.equal(run.result.value, expected)
          assert.equal(run.disposal.ok, true)
        })
      }
    } finally {
      sb.dispose()
    }
  })
}

test('H1 source splicing keeps directives and hashbangs in their AST positions', () => {
  const sources = [
    '#!/usr/bin/env node\n"use strict"\nfunction f(){"custom"\n"use strict"\nreturn this}',
    '#!/usr/bin/env node\nfunction f(){return 1}',
    '#!/usr/bin/env node',
    '"use strict"',
    'function f(){"use strict"}',
    'function f(){"use strict" // trailing comment\nreturn this}',
    '',
  ]
  for (const source of sources) {
    const before = parse(source).ast.program
    for (const level of LEVELS) {
      const instrumented = createCodeInstrumenter({ level }).instrument(source).code
      const after = parse(instrumented).ast.program
      assert.deepEqual(after.directives.map((node) => node.value.value), before.directives.map((node) => node.value.value))
      assert.equal(after.interpreter?.value, before.interpreter?.value)
      const fnBefore = before.body.find((node) => node.type === 'FunctionDeclaration')
      const fnAfter = after.body.find((node) => node.type === 'FunctionDeclaration')
      if (fnBefore) {
        assert.deepEqual(fnAfter.body.directives.map((node) => node.value.value), fnBefore.body.directives.map((node) => node.value.value))
      }
    }
  }
})

const ORDINARY_SWITCH = `
function dispatch(rows) {
  var sum = 0;
  for (var i = 0; i < rows.length; i++) {
    switch (rows[i]) {
      case 0: sum += 1; break;
      case 1: sum += 2; break;
      case 2: sum += 3; break;
      case 3: sum += 4; break;
      case 4: sum += 5; break;
    }
  }
  return sum;
}
dispatch([0, 1, 2, 3, 4])
`

const STRICT_VM = `
function interpreter() {
  "custom"
  "use strict"
  var pc = 0, bytecode = [0, 1, 2, 3, 4], stack = [];
  while (pc < bytecode.length) {
    switch (bytecode[pc++]) {
      case 0: stack.push(1); break;
      case 1: stack.push(2); break;
      case 2: stack.push(3); break;
      case 3: stack.push(4); break;
      case 4: return this === undefined;
    }
  }
}
interpreter()
`

test('H1 VM channel binding follows the interpreter directive prologue', async () => {
  const detection = detectDispatch(parse(STRICT_VM).ast)
  assert.equal(detection.found, true)
  const location = locateInterpreter(STRICT_VM, detection.dispatch)
  const fn = parse(STRICT_VM).ast.program.body[0]
  assert.equal(location.functionBodyStart, fn.body.directives.at(-1).end)
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: false, only: ENV } })
  try {
    for (const level of LEVELS) {
      const run = await sb.run(STRICT_VM, level === undefined ? {} : { level })
      assert.equal(run.ok, true, JSON.stringify(run.error))
      assert.equal(run.result.value, true)
      assert.equal(run.vm?.detected, true)
      assert.equal(run.events.some((event) => event.event === 'jsvmp:opcode'), level !== 'off')
      assert.equal(run.disposal.ok, true)
    }
  } finally {
    sb.dispose()
  }
})

test('M3 runtime dispatch detection shares static interpreter evidence requirements', () => {
  const noIndexedDiscriminant = ORDINARY_SWITCH.replace('var sum = 0;', 'var pc = 0, stack = [], sum = 0;').replace('switch (rows[i])', 'switch (i)')
  const sources = [ORDINARY_SWITCH, noIndexedDiscriminant, 'function add(a,b){return a+b}', STRICT_VM]
  for (const source of sources) {
    assert.equal(detectDispatch(parse(source).ast).found, analyzeVM(source).detected)
  }
  for (const obfuscate of [false, true]) {
    const vm = buildVM(buildSampleProgram(), { seed: 11, obfuscate })
    assert.equal(analyzeVM(vm.code).detected, true)
    assert.equal(detectDispatch(parse(vm.code).ast).found, true)
  }
  assert.equal(analyzeVM(ORDINARY_SWITCH).detected, false)
  const mixed = `${ORDINARY_SWITCH}\n${STRICT_VM}`
  const detection = detectDispatch(parse(mixed).ast)
  assert.equal(detection.dispatch.switchStart, mixed.indexOf('switch (bytecode'))
  const smallVm = STRICT_VM.replace(/      case [123]:[^\n]+\n/g, '')
  assert.equal(analyzeVM(smallVm).detected, true)
  assert.equal(detectDispatch(parse(smallVm).ast).found, true)
})

test('M3 interpreter evidence cannot leak between function or program scopes', () => {
  const unrelated = 'function unrelated(){var pc=0,stack=[],bytecode=[0];stack.push(pc)}'
  const sources = [
    `${unrelated}\n${ORDINARY_SWITCH}`,
    `${unrelated}\n${ORDINARY_SWITCH.replace('switch (rows[i])', 'switch (i)')}`,
    `var pc=0,stack=[],bytecode=[0];\n${ORDINARY_SWITCH}`,
    ORDINARY_SWITCH.replace('var sum = 0;', `${unrelated};var sum = 0;`),
  ]
  for (const source of sources) {
    const analysis = analyzeVM(source)
    assert.equal(analysis.detected, false)
    assert.equal(analysis.dispatch.cases.length, 5)
    assert.equal(detectDispatch(parse(source).ast).found, false)
  }
})

test('M3 mixed indexed switches trace the actual interpreter in either source order', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: false, only: ENV } })
  try {
    for (const source of [`${ORDINARY_SWITCH}\n${STRICT_VM}`, `${STRICT_VM}\n${ORDINARY_SWITCH}`]) {
      const detection = detectDispatch(parse(source).ast)
      const analysis = analyzeVM(source)
      assert.equal(detection.dispatch.switchStart, source.indexOf('switch (bytecode'))
      assert.equal(analysis.dispatch.discriminant, 'bytecode[pc++]')
      const run = await sb.run(source)
      assert.equal(run.ok, true, JSON.stringify(run.error))
      assert.equal(run.vm.detected, true)
      assert.equal(run.vm.interpreter.functionStart, source.indexOf('function interpreter'))
      const opcodes = run.events.filter((event) => event.event === 'jsvmp:opcode')
      assert.equal(opcodes.length, 5)
      assert.deepEqual(opcodes.map((event) => event.opcode), ['0', '1', '2', '3', '4'])
      assert.equal(run.disposal.ok, true)
    }
  } finally {
    sb.dispose()
  }
})

const POOL_VM = `function interpreter(){
  var pc=0,bytecode=[0,1],stack=[];
  while(pc<bytecode.length){
    switch(bytecode[pc++]){
      case 0:stack.push(consts[0]);break;
      case 1:return stack.pop();
    }
  }
}`

const POOL_CASES = [
  ['referenced program pool', `const consts=[42];${POOL_VM}`, [42]],
  ['referenced enclosing function pool', `function factory(){const consts=[42];${POOL_VM};return interpreter}`, [42]],
  ['referenced enclosing block pool', `{const consts=[42];${POOL_VM}}`, [42]],
  ['local pool shadows program pool', `const consts=[42];${POOL_VM.replace('var pc', 'const consts=[7];var pc')}`, [7]],
  ['parameter shadows program pool', `const consts=[42];${POOL_VM.replace('interpreter()', 'interpreter(consts)')}`, []],
  ['empty local pool shadows program pool', `const consts=[42];${POOL_VM.replace('var pc', 'const consts=[];var pc')}`, []],
  ['unreferenced program pool', `const consts=[42];${POOL_VM.replace('consts[0]', '1')}`, []],
  ['unrelated sibling pool', `function unrelated(){const consts=[42]}${POOL_VM}`, []],
  ['nested function reference is not interpreter reference', `const consts=[42];${POOL_VM.replace('var pc', 'function nested(){return consts[0]}var pc').replace('stack.push(consts[0])', 'stack.push(1)')}`, []],
]

for (const [name, source, expected] of POOL_CASES) {
  test(`M3 resolves only lexical constant pools: ${name}`, () => {
    const analysis = analyzeVM(source)
    assert.equal(analysis.detected, true)
    assert.deepEqual(analysis.consts, expected)
    const detection = detectDispatch(parse(source).ast)
    assert.equal(detection.found, true)
    assert.equal(detection.score, analysis.score)
    assert.equal(analysis.score, expected.length > 0 ? 100 : 95)
  })
}

test('M3 ordinary five-case switch loops produce no VM trace or verdict bonus', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: false, only: ENV } })
  try {
    const run = await sb.run(ORDINARY_SWITCH)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 15)
    assert.equal(run.vm, null)
    assert.equal(run.events.some((event) => event.event === 'jsvmp:opcode' || event.event === 'jsvmp.detected'), false)
    assert.equal(run.instrumentation.describe.jsvmpDetections, 0)
    assert.equal(run.disposal.ok, true)
    const { report } = await analyzeSample(ORDINARY_SWITCH, { sandbox: sb, restore: false })
    assert.equal(report.tracing.jsvmp.detected, false)
    assert.equal(report.verdict.reasons.some((reason) => reason.code === 'TRACING_JSVMP'), false)
  } finally {
    sb.dispose()
  }
})
