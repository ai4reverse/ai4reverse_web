/**
 * NSL bytecode interpreter.
 *
 * Three independent dispatch strategies are implemented and selected per
 * invocation:
 *
 *   0. direct table   — runtime opcode indexes a function table
 *   1. routed table   — build opcode → session opcode → handler id → function
 *   2. binary search  — a sorted (runtime opcode, handler id) table
 *
 * The opcode byte seen by the dispatcher is remapped with a fresh permutation
 * on every run, so the same blob executes through different numeric opcodes
 * each time. This is the "dynamic and polymorphic" property: neither the
 * static container nor a single trace describes the next execution.
 *
 * The interpreter is a plain loop; there is no `eval`, no `Function` constructor
 * and no host `with` scope, so a hostile program cannot escape the VM's control
 * flow. It can only call functions reachable from its argument object, which is
 * the documented host API.
 */

import { concatBytes, utf8ToBytes } from '../core/bytes.js'
import { kdfSm3 } from '../core/hash.js'
import { createPrng } from '../core/prng.js'
import { ISA, OPCODE_ID } from './isa.js'
import { decodeBlob } from './format.js'

/** @param {string} message @param {string} [code] @returns {never} */
function vmError(message, code = 'NSDK_VM_ERROR') {
  const error = new Error(message)
  error.code = code
  throw error
}

const OPS = new Array(ISA.length)

/** @param {string} name @param {(machine: object, instruction: number[]) => void} fn */
function define(name, fn) {
  const id = OPCODE_ID.get(name)
  if (id === undefined) throw new Error(`unknown opcode ${name}`)
  OPS[id] = fn
}

const binary = (name, operation) =>
  define(name, (m) => {
    const right = m.stack.pop()
    const left = m.stack.pop()
    m.stack.push(operation(left, right))
  })

const compare = (name, operation) =>
  define(name, (m) => {
    const right = m.stack.pop()
    const left = m.stack.pop()
    m.stack.push(operation(left, right))
  })

define('CONST', (m, ins) => m.stack.push(m.consts[ins[1]]))
define('LOAD_ARG', (m, ins) => m.stack.push(m.args[ins[1]]))
define('LOAD_LOCAL', (m, ins) => m.stack.push(m.locals[ins[1]]))
define('STORE_LOCAL', (m, ins) => {
  m.locals[ins[1]] = m.stack.pop()
})
define('UNDEF', (m) => m.stack.push(undefined))
define('NULL', (m) => m.stack.push(null))
define('TRUE', (m) => m.stack.push(true))
define('FALSE', (m) => m.stack.push(false))
define('POP', (m) => m.stack.pop())
define('DUP', (m) => m.stack.push(m.stack[m.stack.length - 1]))
define('SWAP', (m) => {
  const top = m.stack.pop()
  const next = m.stack.pop()
  m.stack.push(top, next)
})

binary('ADD', (a, b) => a + b)
binary('SUB', (a, b) => a - b)
binary('MUL', (a, b) => a * b)
binary('DIV', (a, b) => a / b)
binary('MOD', (a, b) => a % b)
binary('BIT_AND', (a, b) => a & b)
binary('BIT_OR', (a, b) => a | b)
binary('BIT_XOR', (a, b) => a ^ b)
binary('SHL', (a, b) => a << b)
binary('SHR', (a, b) => a >> b)
binary('USHR', (a, b) => a >>> b)
compare('EQ', (a, b) => a == b) // eslint-disable-line eqeqeq
compare('NEQ', (a, b) => a != b) // eslint-disable-line eqeqeq
compare('SEQ', (a, b) => a === b)
compare('SNEQ', (a, b) => a !== b)
compare('LT', (a, b) => a < b)
compare('GT', (a, b) => a > b)
compare('LTE', (a, b) => a <= b)
compare('GTE', (a, b) => a >= b)

define('NEG', (m) => m.stack.push(-m.stack.pop()))
define('NOT', (m) => m.stack.push(!m.stack.pop()))
define('BNOT', (m) => m.stack.push(~m.stack.pop()))
define('TYPEOF', (m) => m.stack.push(typeof m.stack.pop()))
define('TO_STR', (m) => m.stack.push(String(m.stack.pop())))
define('TO_NUM', (m) => m.stack.push(Number(m.stack.pop())))

define('JMP', (m, ins) => {
  m.pc = ins[1] - 1
})
define('JZ', (m, ins) => {
  if (!m.stack.pop()) m.pc = ins[1] - 1
})
define('JNZ', (m, ins) => {
  if (m.stack.pop()) m.pc = ins[1] - 1
})

define('GET_PROP', (m, ins) => {
  const object = m.stack.pop()
  m.stack.push(object == null ? undefined : object[m.consts[ins[1]]])
})
define('GET_INDEX', (m) => {
  const key = m.stack.pop()
  const object = m.stack.pop()
  m.stack.push(object == null ? undefined : object[key])
})
define('SET_PROP', (m, ins) => {
  const value = m.stack.pop()
  const object = m.stack.pop()
  if (object == null) vmError('cannot set a property on null/undefined')
  object[m.consts[ins[1]]] = value
  m.stack.push(value)
})
define('SET_INDEX', (m) => {
  const value = m.stack.pop()
  const key = m.stack.pop()
  const object = m.stack.pop()
  if (object == null) vmError('cannot set a property on null/undefined')
  object[key] = value
  m.stack.push(value)
})
define('NEW_ARRAY', (m, ins) => {
  const count = ins[1]
  if (count === 0) {
    m.stack.push([])
    return
  }
  m.stack.push(m.stack.splice(m.stack.length - count, count))
})
define('NEW_OBJECT', (m) => m.stack.push({}))

define('CALL', (m, ins) => {
  const argc = ins[1]
  const args = argc === 0 ? [] : m.stack.splice(m.stack.length - argc, argc)
  const callee = m.stack.pop()
  if (typeof callee !== 'function') vmError(`call target is ${typeof callee}, not a function`)
  m.stack.push(Reflect.apply(callee, undefined, args))
})
define('CALL_METHOD', (m, ins) => {
  const argc = ins[1]
  const args = argc === 0 ? [] : m.stack.splice(m.stack.length - argc, argc)
  const callee = m.stack.pop()
  const self = m.stack.pop()
  if (typeof callee !== 'function') vmError(`method target is ${typeof callee}, not a function`)
  m.stack.push(Reflect.apply(callee, self, args))
})
define('RETURN', (m) => {
  m.result = m.stack.pop()
  m.done = true
})
define('HALT', (m) => {
  m.result = m.stack.length > 0 ? m.stack[m.stack.length - 1] : undefined
  m.done = true
})

/**
 * @param {number[]} keys ascending runtime codes
 * @param {number[]} values handler ids
 * @param {number} target
 * @returns {number}
 */
function binarySearch(keys, values, target) {
  let low = 0
  let high = keys.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const key = keys[middle]
    if (key === target) return values[middle]
    if (key < target) low = middle + 1
    else high = middle - 1
  }
  vmError(`unknown runtime opcode ${target}`, 'NSDK_VM_OPCODE')
}

/**
 * @param {{blob: object, key: Uint8Array|number[], budget?: number, trace?: Function}} options
 */
export function createVm(options) {
  const key = Uint8Array.from(options.key)
  const program = decodeBlob(options.blob, key)
  const budget = options.budget ?? 2_000_000
  const size = ISA.length

  /**
   * @param {unknown[]} args
   * @param {{seed?: string|number, budget?: number, trace?: Function}} [runOptions]
   */
  function run(args, runOptions = {}) {
    const seed = runOptions.seed ?? `${Date.now()}:${Math.random()}`
    const prng = createPrng(concatBytes(key, utf8ToBytes(String(seed))), 'vm-session')
    const codes = Array.from({ length: size }, (_, index) => index)
    const sessionMap = prng.shuffle(codes)
    const variant = prng.int(3)

    // runtime code -> handler id. Session mapping is a permutation of the
    // build-code space, so this is well defined for every runtime code.
    const runtimeHandler = new Uint8Array(size)
    for (let buildCode = 0; buildCode < size; buildCode += 1) {
      runtimeHandler[sessionMap[buildCode]] = program.perm[buildCode]
    }
    const direct = new Array(size)
    for (let runtime = 0; runtime < size; runtime += 1) direct[runtime] = OPS[runtimeHandler[runtime]]

    const pairs = codes
      .map((runtime) => [runtime, runtimeHandler[runtime]])
      .sort((left, right) => left[0] - right[0])
    const searchKeys = pairs.map((pair) => pair[0])
    const searchValues = pairs.map((pair) => pair[1])

    const machine = {
      stack: [],
      locals: new Array(program.locals.length),
      args: args ?? [],
      consts: program.consts,
      code: program.code,
      pc: 0,
      done: false,
      result: undefined,
      steps: 0,
      budget: runOptions.budget ?? budget,
      variant,
      sessionMap,
      runtimeHandler,
      perm: program.perm,
      direct,
    }
    const trace = runOptions.trace ?? options.trace
    // Parameters occupy the first local slots (the compiler guarantees this),
    // so a VM frame starts with its arguments bound exactly like a JS call.
    for (let index = 0; index < machine.args.length && index < machine.locals.length; index += 1) {
      machine.locals[index] = machine.args[index]
    }

    while (!machine.done) {
      if (machine.steps >= machine.budget) vmError(`instruction budget exceeded (${machine.budget})`, 'NSDK_VM_BUDGET')
      if (machine.pc < 0 || machine.pc >= machine.code.length) vmError(`program counter out of range: ${machine.pc}`, 'NSDK_VM_PC')
      const instruction = machine.code[machine.pc]
      const buildCode = instruction[0]
      const runtime = sessionMap[buildCode]
      machine.steps += 1
      if (trace) trace({ pc: machine.pc, runtime, handler: runtimeHandler[runtime], variant })
      if (variant === 0) {
        direct[runtime](machine, instruction)
      } else if (variant === 1) {
        const route = runtimeHandler[runtime]
        OPS[route](machine, instruction)
      } else {
        const handler = binarySearch(searchKeys, searchValues, runtime)
        OPS[handler](machine, instruction)
      }
      machine.pc += 1
    }
    return machine.result
  }

  return {
    run,
    variantCount: 3,
    meta: {
      family: 'jsvmp-nsl',
      instructions: program.instructions,
      constants: program.consts.length,
      locals: program.locals.length,
      opcodes: size,
      budget,
    },
    /** Static view for tests and reports; never part of a protected bundle. */
    inspect() {
      return { program: { ...program, perm: program.perm.slice() }, meta: this.meta }
    },
  }
}

/**
 * Build a VM whose key exists only as a white-box keystream.
 * @param {{blob: object, spn: {keystream: Function}, label?: string, budget?: number}} options
 */
export function createVmFromSpn(options) {
  const label = options.label ?? 'signing'
  const iv = kdfSm3(utf8ToBytes(`nsdk/vm/key/${label}`), 'vm-key-iv', 16)
  const key = options.spn.keystream(iv, 32)
  return createVm({ blob: options.blob, key, budget: options.budget })
}

export { ISA, OPS }
