import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSampleProgram, buildVM, DEFAULT_VM_NAME } from '../tools/jsvmp/builder.js'
import { OPCODE_BY_NAME } from '../tools/jsvmp/spec.js'
import { analyzeVM, extractHandlers, isJSVMP, summarizeVM } from '../tools/jsvmp/analyze.js'
import { TrustError } from '../tools/util/errors.js'

const sampleVM = () => buildVM(buildSampleProgram())

test('analyzeVM detects the generated VM dispatch and interpreter shape', () => {
  const vm = sampleVM()
  const analysis = analyzeVM(vm.code)

  assert.equal(analysis.detected, true)
  assert.equal(analysis.kind, 'stack-vm')
  assert.ok(analysis.score >= 50)
  assert.equal(analysis.dispatch.discriminant, 'inst[0]')
  assert.ok(analysis.dispatch.cases.length >= vm.opcodes.length)
  assert.equal(analysis.dispatch.loop.type, 'WhileStatement')
  assert.equal(analysis.interpreter.hasSwitch, true)
  assert.equal(analysis.interpreter.hasWhile, true)
  assert.ok(analysis.interpreter.pcVariables.includes('pc'))
  assert.ok(analysis.consts.includes('fib(10)='))
})

test('analyzeVM extracts parseable cases and handlers for every used opcode', () => {
  const vm = sampleVM()
  const analysis = analyzeVM(vm.code)
  const caseOpcodes = new Set(analysis.dispatch.cases.map((entry) => entry.opcode))

  for (const entry of analysis.dispatch.cases) {
    assert.equal(typeof entry.opcode, 'string')
    assert.equal(typeof entry.test, 'string')
    assert.equal(typeof entry.body, 'string')
    assert.equal(typeof entry.start, 'number')
    assert.equal(typeof entry.end, 'number')
    assert.ok(OPCODE_BY_NAME.has(entry.opcode), `unexpected opcode ${entry.opcode}`)
    assert.ok(analysis.handlers[entry.opcode], `missing handler for ${entry.opcode}`)
    assert.equal(analysis.handlers[entry.opcode].ast.type, 'BlockStatement')
  }

  for (const name of ['LOAD_CONST', 'GET_PROP', 'SET_PROP', 'JMP_IF_NOT', 'HALT']) {
    assert.ok(caseOpcodes.has(name), `dispatcher should contain ${name}`)
  }

  const handlers = extractHandlers(vm.code)
  assert.deepEqual(Object.keys(handlers).sort(), Object.keys(analysis.handlers).sort())
  assert.ok(handlers.LOAD_CONST.source.includes('stack.push'))
  assert.ok(handlers.HALT.source.includes('return'))
})

test('analyzeVM maps obfuscated dispatch codes with a hint and by handler shape', () => {
  const vm = buildVM(buildSampleProgram(), { obfuscate: true, seed: 'dispatch-table' })
  const hinted = analyzeVM(vm.code, { dispatchTable: vm.dispatchTable })
  const inferred = analyzeVM(vm.code)

  for (const analysis of [hinted, inferred]) {
    assert.equal(analysis.detected, true)
    assert.ok(analysis.dispatch.cases.length >= vm.opcodes.length)
    for (const entry of analysis.dispatch.cases) {
      assert.ok(OPCODE_BY_NAME.has(entry.opcode), `unmapped obfuscated opcode ${entry.opcode}`)
      assert.ok(analysis.handlers[entry.opcode])
    }
  }
})

test('plain functions are not classified as JSVMP', () => {
  const source = 'function add(a, b) { return a + b; }'
  const analysis = analyzeVM(source)

  assert.equal(analysis.detected, false)
  assert.equal(analysis.kind, 'none')
  assert.equal(analysis.dispatch.cases.length, 0)
  assert.deepEqual(analysis.handlers, {})
  assert.equal(analysis.interpreter.hasSwitch, false)
  assert.equal(isJSVMP(source), false)
  assert.equal(isJSVMP(sampleVM().code), true)
})

test('ordinary loop+switch+array is not classified as JSVMP', () => {
  const source = `
function ordinary(rows) {
  var out = [];
  var index = 0;
  while (rows.length) {
    switch (rows[0]) {
      case 1: out.push(1); break
      case 2: out.push(2); break
      default: rows.shift()
    }
    index++;
  }
  return out;
}
ordinary([1,2,3])
`
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, false)
  assert.equal(analysis.kind, 'none')
  assert.equal(isJSVMP(source), false)
})

test('unused stack array and renamed loop counter do not make a VM', () => {
  // `idx` matches the pc-like name pattern and `stack` is stack-shaped, but
  // neither participates in an interpreter: the stack is never pushed/popped
  // in the dispatch loop and `idx` indexes a caller parameter, not a declared
  // bytecode/pool array.
  const source = `
function ordinary(rows) {
  var stack = [];
  var idx = 0;
  var out = [];
  while (rows.length) {
    switch (rows[idx]) {
      case 1: out.push(1); break
      case 2: out.push(2); break
      case 3: out.push(3); break
      case 4: out.push(4); break
    }
    idx++;
  }
  return out;
}
ordinary([1,2,3,4])
`
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, false)
  assert.equal(analysis.kind, 'none')
  assert.equal(isJSVMP(source), false)
})

test('a local array-of-arrays loop without a used stack is not a VM', () => {
  // `table` is local and array-of-arrays, `idx` is pc-shaped, and the switch
  // reads `table[idx][0]`: that is bytecode-shaped linkage. But no declared
  // stack-like variable receives push/pop inside the dispatch loop, so this is
  // an ordinary table walk rather than an interpreter (ACCEPTANCE H5).
  const source = `
function sumTable() {
  var table = [[1, 10], [2, 20], [3, 30], [4, 40]];
  var idx = 0, total = 0;
  while (idx < table.length) {
    switch (table[idx][0]) {
      case 1: total += table[idx][1]; break
      case 2: total += table[idx][1]; break
      case 3: total += table[idx][1]; break
      case 4: total += table[idx][1]; break
    }
    idx++;
  }
  return total;
}
sumTable()
`
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, false)
  assert.equal(analysis.kind, 'none')
  assert.equal(isJSVMP(source), false)
})

test('a pc-advancing dispatch loop is detected without a value stack', () => {
  // A dispatch loop may have no value stack at all (e.g. a pure control-flow
  // VM). `inst[pc++]` in the switch discriminant and `pc += 1` inside the case
  // bodies is pc/bytecode evidence: the dispatch itself advances the program
  // counter. This must be detected even though nothing is pushed or popped.
  const source = `
function run(inst) {
  var pc = 0;
  while (pc < inst.length)
    switch (inst[pc++]) {
      case 1: pc += 1; break;
      case 2: pc += 1; break;
      case 3: break;
      case 4: break;
      case 5: break;
    }
  return pc;
}
run([[1], [2], [3], [4], [5]])
`
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, true)
  assert.equal(analysis.kind, 'switch-dispatch')
  assert.equal(analysis.dispatch.discriminant, 'inst[pc++]')
  assert.equal(isJSVMP(source), true)
})

test('non-array bytecode initializers count for bytecode-like names only', () => {
  // `var BYTECODE = decode()` is still a program counter source even though the
  // initializer is not an ArrayExpression. The name check must run first.
  const bytecode = `
function runVM() {
  var BYTECODE = decode();
  var stack = [];
  var pc = 0;
  while (pc < BYTECODE.length) {
    var inst = BYTECODE[pc++];
    switch (inst[0]) {
      case 1: stack.push(inst[1]); break;
      case 2: stack.pop(); break;
    }
  }
  return stack;
}
runVM()
`
  const analysis = analyzeVM(bytecode)
  assert.equal(analysis.detected, true)
  assert.equal(analysis.kind, 'stack-vm')
  assert.equal(isJSVMP(bytecode), true)

  // A non-bytecode name with the same call initializer is not evidence.
  const ordinary = bytecode.replaceAll('BYTECODE', 'data')
  assert.equal(analyzeVM(ordinary).detected, false)
  assert.equal(isJSVMP(ordinary), false)
})

test('bytecode supplied as a function or IIFE parameter yields pc evidence', () => {
  // The interpreter may receive its bytecode from the caller instead of
  // declaring it in its own body. Parameter and function-argument bindings
  // must count exactly like a local `var BYTECODE = [...]`.
  const declared = `
function runVM() {
  var BYTECODE = [[1, 0], [2, 0]];
  var stack = [];
  var pc = 0;
  while (pc < BYTECODE.length) {
    var inst = BYTECODE[pc++];
    switch (inst[0]) {
      case 1: stack.push(inst[1]); break
      case 2: stack.pop(); break
    }
  }
  return stack;
}
runVM()
`
  const parameter = `
function runVM(BYTECODE) {
  var stack = [];
  var pc = 0;
  while (pc < BYTECODE.length) {
    var inst = BYTECODE[pc++];
    switch (inst[0]) {
      case 1: stack.push(inst[1]); break
      case 2: stack.pop(); break
    }
  }
  return stack;
}
runVM([[1, 0], [2, 0]])
`
  const iife = `
(function (bytecode) {
  var stack = [];
  var pc = 0;
  while (pc < bytecode.length) {
    var inst = bytecode[pc++];
    switch (inst[0]) {
      case 1: stack.push(inst[1]); break
      case 2: stack.pop(); break
    }
  }
  return stack;
})([[1, 0], [2, 0]])
`
  const argument = `
(function (rows) {
  var stack = [];
  var pc = 0;
  while (pc < rows.length) {
    var inst = rows[pc++];
    switch (inst[0]) {
      case 1: stack.push(inst[1]); break
      case 2: stack.pop(); break
    }
  }
  return stack;
})([[1, 0], [2, 0]])
`
  assert.equal(analyzeVM(declared).detected, true)
  for (const source of [parameter, iife, argument]) {
    const analysis = analyzeVM(source)
    assert.equal(analysis.detected, true)
    assert.equal(analysis.kind, 'stack-vm')
    assert.equal(analysis.dispatch.discriminant, 'inst[0]')
  }
})

test('pickDispatch prefers the switch linked to the pc/bytecode read', () => {
  const source = `
function both(rows) {
  var BYTECODE = [[1, 0], [2, 0]];
  var stack = [];
  var pc = 0;
  var out = [];
  while (out.length < 2) {
    switch (rows[out.length]) {
      case 1: out.push(1); break
      case 2: out.push(2); break
      case 3: out.push(3); break
    }
  }
  while (pc < BYTECODE.length) {
    var inst = BYTECODE[pc++];
    switch (inst[0]) {
      case 1: stack.push(inst[1]); break
      case 2: stack.pop(); break
    }
  }
  return stack;
}
both([[1]])
`
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, true)
  // Both switches score the same structurally (in a loop, indexed). The second
  // is the real dispatcher because it reads BYTECODE through `pc`.
  assert.equal(analysis.dispatch.discriminant, 'inst[0]')
  assert.ok(analysis.dispatch.cases.some((entry) => entry.body.includes('stack.push')))
  assert.equal(analysis.dispatch.cases.some((entry) => entry.body.includes('out.push')), false)
})

test('foreign numeric case bodies are not assigned canonical ISA mnemonics', () => {
  // Case numbers 4/19/30 collide with POP/OR/SWAP, but the handler bodies do
  // not match the canonical shapes and no dispatch-table hint was supplied.
  const source = `
function foreign() {
  var BYTECODE = [[4, 0], [19, 0], [30, 0]];
  var stack = [];
  var pc = 0;
  while (pc < BYTECODE.length) {
    var inst = BYTECODE[pc++];
    switch (inst[0]) {
      case 4: stack.push(inst[1] + 100); break
      case 19: stack.push(inst[1] * 2); break
      case 30: stack.push(inst[1] - 7); break
    }
  }
  return stack;
}
foreign()
`
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, true)
  const opcodes = analysis.dispatch.cases.map((entry) => entry.opcode)
  assert.equal(opcodes.length, 3)
  for (const opcode of opcodes) {
    assert.equal(OPCODE_BY_NAME.has(opcode), false, `fabricated ISA mnemonic ${opcode}`)
  }
  assert.equal(new Set(opcodes).size, 3, 'distinct handlers must not collapse')
  assert.equal(Object.keys(analysis.handlers).length, 3)
  assert.equal(analysis.handlers.POP, undefined)
  assert.equal(analysis.handlers.OR, undefined)
  assert.equal(analysis.handlers.SWAP, undefined)
})

test('the real jsvmp example is still detected', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../examples/jsvmp-sample.js', import.meta.url), 'utf8')
  const analysis = analyzeVM(source)
  assert.equal(analysis.detected, true)
  assert.equal(analysis.kind, 'stack-vm')
  assert.ok(analysis.dispatch.cases.length >= 10)
})

test('analyzeVM, extractHandlers and summarizeVM never crash on malformed input', () => {
  const malformed = [null, undefined, '', '   ', 'function(', 'switch (x) {', 42, { source: '' }]
  for (const input of malformed) {
    assert.doesNotThrow(() => analyzeVM(input))
    const analysis = analyzeVM(input)
    assert.equal(analysis.detected, false)
    assert.equal(typeof analysis.note, 'string')
    assert.doesNotThrow(() => summarizeVM(analysis))
    assert.doesNotThrow(() => extractHandlers(input))
    assert.equal(isJSVMP(input), false)
  }
  assert.doesNotThrow(() => summarizeVM(null))
})

test('summarizeVM returns a compact JSON-safe summary without AST nodes', () => {
  const vm = sampleVM()
  const analysis = analyzeVM(vm.code)
  const summary = summarizeVM(analysis)

  const serialized = JSON.stringify(summary)
  assert.equal(typeof serialized, 'string')
  assert.ok(serialized.length > 0)
  assert.equal(summary.detected, true)
  assert.equal(summary.kind, 'stack-vm')
  assert.equal(summary.dispatch.caseCount, analysis.dispatch.cases.length)
  assert.deepEqual(summary.dispatch.opcodes, analysis.dispatch.cases.map((entry) => entry.opcode))
  assert.equal(summary.handlers.length, Object.keys(analysis.handlers).length)
  assert.ok(summary.handlers.every((entry) => !('ast' in entry)))
  assert.ok(!serialized.includes('"ast"'))
  assert.ok(summary.consts.count >= 1)
  assert.ok(summary.consts.sample.includes('fib(10)='))
  assert.deepEqual(summary.interpreter.pcVariables, ['pc'])
})

test('run() without the trust acknowledgement throws TrustError naming the host-execution hazard', () => {
  const vm = sampleVM()
  const rejections = [undefined, null, {}, { trust: 'sandbox' }, 'host']
  for (const options of rejections) {
    assert.throws(
      () => vm.run(options),
      (error) =>
        error instanceof TrustError &&
        error.code === 'TRUST_ERROR' &&
        /executes sample-derived code in the host process/.test(error.message),
    )
  }
  // The refusal precedes any host execution: the generated global never lands
  // on globalThis.
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, DEFAULT_VM_NAME), false)
})

test('run() with trust host executes a trivial generated program and restores the host global', () => {
  const vm = buildVM([
    { op: 'LOAD_CONST', args: ['trusted-ok'] },
    { op: 'HALT' },
  ])
  assert.equal(vm.run({ trust: 'host' }), 'trusted-ok')
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, DEFAULT_VM_NAME), false)
})
