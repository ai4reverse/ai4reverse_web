import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { buildVM, buildSampleProgram, analyzeVM, summarizeVM, SEMANTICS } from '../tools/jsvmp/index.js'
import { summarizeOpcodeTrace } from '../tools/instrumentation/jsvmp.js'

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'anti-fingerprint']

test('JSVMP source is detected, instrumented and traced at opcode level', async () => {
  const vm = buildVM(buildSampleProgram(), { seed: 11 })
  assert.equal(vm.run({ trust: 'host' }), 'fib(10)=55 via VM')

  const sb = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    instrumentation: { jsvmp: true, code: { level: 'function' } },
  })
  try {
    const run = await sb.run(`${vm.code}\n__vm_run()`, { filename: 'https://cdn.test/vm.js' })
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 'fib(10)=55 via VM')

    assert.ok(run.vm, 'VM was not detected at runtime')
    assert.equal(run.vm.detected, true)
    assert.ok(run.vm.opcodes >= 10, `unexpected opcode count ${run.vm.opcodes}`)

    const opcodeEvents = (run.events ?? []).filter(
      (event) => event.kind === 'code' && event.event === 'jsvmp:opcode',
    )
    assert.ok(opcodeEvents.length >= 20, `only ${opcodeEvents.length} opcode events`)
    const distinct = new Set(opcodeEvents.map((event) => event.opcode))
    assert.ok(distinct.size >= 8, `only ${distinct.size} distinct opcodes`)

    const summary = summarizeOpcodeTrace(run.events ?? [], { semantics: SEMANTICS })
    assert.ok(summary.steps >= 20)
    assert.ok(summary.opcodes.length >= 8)
    assert.ok(summary.sequence.length >= 20)
  } finally {
    sb.dispose()
  }
})

test('obfuscated VM traces identically at the semantic level', async () => {
  const plain = buildVM(buildSampleProgram(), { seed: 3 })
  const obfuscated = buildVM(buildSampleProgram(), { seed: 3, obfuscate: true })
  assert.notEqual(plain.code, obfuscated.code)
  assert.equal(obfuscated.run({ trust: 'host' }), plain.run({ trust: 'host' }))

  const sb = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    instrumentation: { jsvmp: true, code: { level: 'function' } },
  })
  try {
    const run = await sb.run(`${obfuscated.code}\n__vm_run()`, { filename: 'https://cdn.test/vm-obf.js' })
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 'fib(10)=55 via VM')
    assert.equal(run.vm.detected, true)
    // Encoded opcodes are still traced: the channel records the case label.
    const labels = new Set(
      (run.events ?? [])
        .filter((event) => event.kind === 'code' && event.event === 'jsvmp:opcode')
        .map((event) => event.opcode),
    )
    assert.ok(labels.size >= 5, `only ${labels.size} case labels traced`)
  } finally {
    sb.dispose()
  }
})

test('static analyzer agrees with runtime detection', () => {
  const vm = buildVM(buildSampleProgram(), { seed: 5 })
  const analysis = analyzeVM(vm.code)
  assert.equal(analysis.detected, true)
  assert.ok(analysis.dispatch.cases.length >= 10)
  assert.equal(analysis.interpreter.hasSwitch, true)
  const summary = summarizeVM(analysis)
  assert.equal(summary.detected, true)
  assert.ok(summary.dispatch.caseCount >= 10)
  assert.ok(analysis.handlers && Object.keys(analysis.handlers).length >= 8)

  const plain = analyzeVM('function add(a, b) { return a + b }')
  assert.equal(plain.detected, false)
})

test('non-VM sample is not instrumented as a VM', async () => {
  const sb = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    instrumentation: { jsvmp: true },
  })
  try {
    const run = await sb.run('var a = 1; switch (a) { case 1: a = 2; break; default: a = 3 } a')
    assert.equal(run.result.value, 2)
    assert.equal(run.vm, null)
  } finally {
    sb.dispose()
  }
})

test('dispatch instrumentation tolerates empty/fall-through case labels', async () => {
  const { detectDispatch, instrumentDispatch } = await import('../tools/instrumentation/jsvmp.js')
  const { parse } = await import('../tools/restore/parse.js')
  const source = `
    var pc = 0, stack = [], inst = [[1], [2]];
    while (pc < inst.length) {
      switch (inst[pc][0]) {
        case 1:
        case 2:
          stack.push(1); pc += 1; continue;
        case 3:
          break;
        case 4:
          break;
        case 5:
          break;
        case 6:
          break;
      }
      break;
    }
    stack.length;
  `
  const detection = detectDispatch(parse(source).ast)
  assert.equal(detection.found, true)
  const { locateInterpreter } = await import('../tools/instrumentation/jsvmp.js')
  const interpreter = locateInterpreter(source, detection.dispatch)
  // A top-level dispatch loop has no function-scoped channel binding, so
  // instrumentation must refuse instead of emitting ReferenceError probes.
  assert.equal(interpreter, null)
  const instrumented = instrumentDispatch(source, {
    dispatch: detection.dispatch,
    channelExpression: 'globalThis.channel',
    bindingName: '_$v',
    marker: 'v',
    interpreter,
  })
  assert.equal(instrumented.stats.skipped, 'no-interpreter-binding')
  assert.equal(instrumented.code, source)
  assert.equal(instrumented.stats.opcodesInstrumented, 0)
  assert.doesNotThrow(() => parse(instrumented.code))
}) 

test('braceless dispatch loops are never spliced into', async () => {
  const { detectDispatch, instrumentDispatch, locateInterpreter } = await import('../tools/instrumentation/jsvmp.js')
  const { parse } = await import('../tools/restore/parse.js')
  const source = `
    function run(inst) {
      var pc = 0;
      while (pc < inst.length)
        switch (inst[pc++]) { case 1: pc += 1; break; case 2: pc += 1; break; case 3: break; case 4: break; case 5: break; }
      return pc;
    }
  `
  const detection = detectDispatch(parse(source).ast)
  assert.equal(detection.found, true)
  const interpreter = locateInterpreter(source, detection.dispatch)
  assert.equal(interpreter, null)
  const instrumented = instrumentDispatch(source, {
    dispatch: detection.dispatch,
    channelExpression: 'globalThis.channel',
    interpreter,
  })
  assert.equal(instrumented.code, source)
  assert.doesNotThrow(() => parse(instrumented.code))
})

test('ordinary switch tables in loops are not misclassified as VMs', async () => {
  const { analyzeVM, isJSVMP } = await import('../tools/jsvmp/index.js')
  const ordinary = `
    var out = [];
    function a(){} function b(){} function c(){} function d(){} function e(){}
    for (var i = 0; i < rows.length; i++) {
      switch (rows[i]) {
        case 0: a(); break;
        case 1: b(); break;
        case 2: c(); break;
        case 3: d(); break;
        case 4: e(); break;
      }
    }
  `
  assert.equal(isJSVMP(ordinary), false)
  assert.equal(analyzeVM(ordinary).detected, false)
})
