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
