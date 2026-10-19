import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPCODES,
  OPCODE_BY_CODE,
  OPCODE_BY_NAME,
  SEMANTICS,
  assemble,
  opcodeName,
} from '../tools/jsvmp/spec.js'
import { buildSampleProgram, buildVM } from '../tools/jsvmp/builder.js'

const REQUIRED_OPCODES = [
  'LOAD_CONST',
  'LOAD_UNDEF',
  'PUSH',
  'POP',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'MOD',
  'NEG',
  'NOT',
  'EQ',
  'NEQ',
  'LT',
  'GT',
  'LTE',
  'GTE',
  'AND',
  'OR',
  'JMP',
  'JMP_IF',
  'JMP_IF_NOT',
  'GET_PROP',
  'SET_PROP',
  'NEW_OBJ',
  'NEW_ARR',
  'CALL',
  'RET',
  'DUP',
  'SWAP',
  'TOSTR',
  'TONUM',
  'HALT',
]

test('spec exports the canonical opcode table and semantics', () => {
  for (const name of REQUIRED_OPCODES) {
    const spec = OPCODE_BY_NAME.get(name)
    assert.ok(spec, `missing opcode ${name}`)
    assert.equal(typeof spec.code, 'number')
    assert.equal(typeof spec.argc, 'number')
    assert.equal(spec.stack && typeof spec.stack === 'object', true)
    assert.ok('in' in spec.stack)
    assert.ok('out' in spec.stack)
    assert.equal(typeof spec.doc, 'string')
    assert.equal(OPCODE_BY_CODE.get(spec.code), spec)
    assert.equal(typeof SEMANTICS[name], 'string')
    assert.ok(SEMANTICS[name].length > 10)
  }
  assert.equal(OPCODES.length, OPCODE_BY_CODE.size)
  assert.equal(opcodeName(OPCODE_BY_NAME.get('LOAD_CONST').code), 'LOAD_CONST')
  assert.equal(opcodeName(-1), undefined)
})

test('assemble interns constants and rewrites constant operands to pool indices', () => {
  const { bytecode, consts } = assemble([
    { op: 'LOAD_CONST', args: ['shared'] },
    { op: 'GET_PROP', args: ['shared'] },
    { op: 'HALT' },
  ])

  assert.deepEqual(consts, ['shared'])
  assert.deepEqual(bytecode, [
    { code: OPCODE_BY_NAME.get('LOAD_CONST').code, args: [0] },
    { code: OPCODE_BY_NAME.get('GET_PROP').code, args: [0] },
    { code: OPCODE_BY_NAME.get('HALT').code, args: [] },
  ])
})

test('assemble rejects an unknown opcode', () => {
  assert.throws(() => assemble([{ op: 'NOT_A_REAL_OPCODE' }]), /unknown opcode/)
})

test('assemble rejects invalid arguments and jump targets', () => {
  assert.throws(() => assemble([{ op: 'LOAD_CONST' }]), /expects 1 argument/)
  assert.throws(() => assemble([{ op: 'JMP', args: [99] }]), /jump target/)
  assert.throws(() => assemble([{ op: 'PUSH', args: [{ nested: true }] }]), /primitive immediate/)
  assert.throws(() => assemble([{ op: 'NEW_ARR', args: [-1] }]), /non-negative integer/)
})

test('buildVM computes fibonacci(10) and exercises string concat plus object get/set', () => {
  const vm = buildVM(buildSampleProgram())

  assert.equal(vm.run(), 'fib(10)=55 via VM')
  assert.equal(vm.run(), 'fib(10)=55 via VM')
  assert.ok(vm.bytecode.length > 0)
  assert.equal(vm.sourceMap.length, vm.bytecode.length)
  assert.ok(vm.opcodes.some((spec) => spec.name === 'JMP_IF_NOT'))
  assert.ok(vm.opcodes.some((spec) => spec.name === 'GET_PROP'))
  assert.ok(vm.opcodes.some((spec) => spec.name === 'SET_PROP'))
  assert.equal(vm.code.includes('eval('), false)
  assert.equal(vm.code.includes('Function('), false)
  assert.ok(vm.code.startsWith('globalThis.__vm_run = (function () {'))
})

test('new Function(code + return name) produces the same result as run()', () => {
  const name = '__jsvmp_test_vm'
  const vm = buildVM(buildSampleProgram(), { name })

  try {
    const factory = new Function(`${vm.code}; return ${name};`)
    const generated = factory()
    assert.equal(generated([]), vm.run())
    assert.equal(generated([]), 'fib(10)=55 via VM')
  } finally {
    delete globalThis[name]
  }
})

test('run() forwards arguments through LOAD_ARG and restores the host global', () => {
  const name = '__jsvmp_arg_vm'
  const vm = buildVM(
    [
      { op: 'LOAD_ARG', args: [0] },
      { op: 'LOAD_ARG', args: [1] },
      { op: 'ADD' },
      { op: 'HALT' },
    ],
    { name },
  )
  const previous = globalThis[name]
  try {
    assert.equal(vm.run(20, 22), 42)
    assert.equal(Object.prototype.hasOwnProperty.call(globalThis, name), Boolean(previous))
  } finally {
    if (previous === undefined) delete globalThis[name]
    else globalThis[name] = previous
  }
})

test('obfuscate:true changes source and dispatch codes without changing behaviour', () => {
  const program = buildSampleProgram()
  const plain = buildVM(program)
  const first = buildVM(program, { obfuscate: true, seed: 'alpha' })
  const second = buildVM(program, { obfuscate: true, seed: 'beta' })

  assert.notEqual(plain.code, first.code)
  assert.notEqual(first.code, second.code)
  assert.equal(first.run(), plain.run())
  assert.equal(second.run(), plain.run())
  assert.equal(first.run(), 'fib(10)=55 via VM')

  // Canonical bytecode is still available, while the generated switch uses
  // per-build encoded opcode numbers.
  assert.deepEqual(first.bytecode, plain.bytecode)
  assert.notDeepEqual(first.dispatchTable, plain.dispatchTable)
  for (const entry of Object.values(first.dispatchTable)) {
    assert.equal(typeof entry.name, 'string')
    assert.equal(typeof entry.code, 'number')
    assert.equal(typeof entry.caseLine, 'number')
  }
  assert.ok(first.code.includes('var STRING_BASE ='))
  assert.ok(first.code.includes('readConst(inst[1])'))
})

test('buildVM validates the generated global name', () => {
  assert.throws(() => buildVM(buildSampleProgram(), { name: 'not a name' }), /invalid VM global name/)
  assert.throws(() => buildVM(buildSampleProgram(), { name: 'return' }), /invalid VM global name/)
})
