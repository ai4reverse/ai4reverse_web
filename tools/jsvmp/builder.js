/**
 * JSVMP builder.
 *
 * The generated artifact is a self-contained JavaScript source string that
 * implements a stack machine: `BYTECODE` (array of `[opcode, ...args]` tuples),
 * a constant pool, a program counter, a value stack and a `while` /
 * integer-`switch` interpreter.
 *
 * Everything an analyst sees is produced from the canonical table in
 * `spec.js`; nothing in the generated source calls `eval` or `Function`.
 */

import { OPCODE_BY_CODE, assemble } from './spec.js'
import { createSeededRandom } from '../util/random.js'
import { TrustError } from '../util/errors.js'

export const DEFAULT_VM_NAME = '__vm_run'

/** The only `trust` value `run()` accepts: an explicit host-execution opt-in. */
const REQUIRED_TRUST = 'host'

/** Names that cannot be used as the generated global function identifier. */
const RESERVED_NAMES = new Set([
  '__proto__',
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'globalThis',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'Infinity',
  'interface',
  'let',
  'NaN',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** @param {string} text */
function quote(text) {
  return JSON.stringify(String(text))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Serialize a constant-pool value as JavaScript source. Only primitives,
 * arrays and plain objects are accepted, which keeps generated output
 * deterministic and free of executable values.
 *
 * @param {unknown} value
 * @param {Set<object>} [seen]
 * @returns {string}
 */
function serializeValue(value, seen = new Set()) {
  if (value === undefined) return 'void 0'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN'
    if (value === Infinity) return 'Infinity'
    if (value === -Infinity) return '-Infinity'
    if (Object.is(value, -0)) return '-0'
    return String(value)
  }
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'function') throw new Error('cannot serialize a function constant')
  if (typeof value !== 'object') throw new Error(`cannot serialize constant type ${typeof value}`)

  if (seen.has(value)) throw new Error('cannot serialize a cyclic constant')
  seen.add(value)
  let source
  if (Array.isArray(value)) {
    source = `[${Array.from(value, (item) => serializeValue(item, seen)).join(', ')}]`
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('only plain objects and arrays can be serialized')
    }
    const entries = Object.keys(value).map((key) => {
      // A plain `"__proto__":` key would set the prototype in an object
      // literal; a computed key keeps it as an ordinary own property.
      const propertyKey = key === '__proto__' ? `[${quote(key)}]` : quote(key)
      return `${propertyKey}: ${serializeValue(value[key], seen)}`
    })
    source = `{ ${entries.join(', ')} }`
  }
  seen.delete(value)
  return source
}

/** @param {unknown[]} consts */
function serializeConsts(consts) {
  return consts.map((value) => serializeValue(value)).join(', ')
}

/** @param {Array<{code: number, args: unknown[]}>} bytecode */
function serializeBytecode(bytecode) {
  return bytecode
    .map((instruction) => `[${[instruction.code, ...instruction.args].map((value) => serializeValue(value)).join(', ')}]`)
    .join(', ')
}

/**
 * @param {boolean} obfuscate
 * @param {{int: (min: number, max: number) => number}} rng
 */
function createOpcodeCipher(obfuscate, rng) {
  if (!obfuscate) {
    return { mode: 'none', key: 0, encode: (code) => code }
  }
  const mode = rng.int(0, 1) === 0 ? 'xor' : 'add'
  const key = mode === 'xor' ? rng.int(1, 31) : rng.int(1, 127)
  return {
    mode,
    key,
    encode: (code) => (mode === 'xor' ? code ^ key : code + key),
  }
}

/**
 * Encode string constant-pool indices. A string index is stored as
 * `STRING_BASE + index`; the interpreter subtracts the base when the encoded
 * index is at or above it, so numeric constants keep their direct indices.
 *
 * @param {Array<{code: number, args: unknown[]}>} bytecode
 * @param {unknown[]} consts
 * @param {number} stringBase
 * @param {boolean} obfuscate
 */
function encodeConstIndices(bytecode, consts, stringBase, obfuscate) {
  return bytecode.map((instruction) => {
    const spec = OPCODE_BY_CODE.get(instruction.code)
    if (!obfuscate || !spec || !['LOAD_CONST', 'GET_PROP', 'SET_PROP'].includes(spec.name)) {
      return { code: instruction.code, args: [...instruction.args] }
    }
    const index = instruction.args[0]
    if (typeof consts[index] === 'string') {
      return { code: instruction.code, args: [stringBase + index] }
    }
    return { code: instruction.code, args: [...instruction.args] }
  })
}

/**
 * @param {Array<{code: number, args: unknown[]}>} bytecode
 * @param {(code: number) => number} encode
 */
function encodeBytecode(bytecode, encode) {
  return bytecode.map((instruction) => ({
    code: encode(instruction.code),
    args: [...instruction.args],
  }))
}

/**
 * Fisher-Yates shuffle on a copy, using the build's seeded RNG.
 * @template T
 * @param {T[]} items
 * @param {{int: (min: number, max: number) => number}} rng
 * @returns {T[]}
 */
function shuffle(items, rng) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = rng.int(0, index)
    const value = copy[index]
    copy[index] = copy[swapIndex]
    copy[swapIndex] = value
  }
  return copy
}

/**
 * Body lines for one opcode handler. Each line is emitted inside the matching
 * `case` label.
 * @param {string} name
 * @returns {string[]}
 */
function handlerLines(name) {
  switch (name) {
    case 'LOAD_CONST':
      return ['stack.push(readConst(inst[1]));']
    case 'LOAD_UNDEF':
      return ['stack.push(void 0);']
    case 'PUSH':
      return ['stack.push(inst[1]);']
    case 'POP':
      return ['stack.pop();']
    case 'ADD':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a + b);']
    case 'SUB':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a - b);']
    case 'MUL':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a * b);']
    case 'DIV':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a / b);']
    case 'MOD':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a % b);']
    case 'NEG':
      return ['a = stack.pop();', 'stack.push(-a);']
    case 'NOT':
      return ['a = stack.pop();', 'stack.push(!a);']
    case 'EQ':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a == b);']
    case 'NEQ':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a != b);']
    case 'LT':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a < b);']
    case 'GT':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a > b);']
    case 'LTE':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a <= b);']
    case 'GTE':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a >= b);']
    case 'AND':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a && b);']
    case 'OR':
      return ['b = stack.pop();', 'a = stack.pop();', 'stack.push(a || b);']
    case 'JMP':
      return ['pc = inst[1];']
    case 'JMP_IF':
      return ['if (stack.pop()) pc = inst[1];']
    case 'JMP_IF_NOT':
      return ['if (!stack.pop()) pc = inst[1];']
    case 'GET_PROP':
      return ['key = readConst(inst[1]);', 'a = stack.pop();', 'stack.push(a[key]);']
    case 'SET_PROP':
      return [
        'key = readConst(inst[1]);',
        'b = stack.pop();',
        'a = stack.pop();',
        'a[key] = b;',
        'stack.push(b);',
      ]
    case 'NEW_OBJ':
      return ['stack.push({});']
    case 'NEW_ARR':
      return [
        'n = inst[1];',
        'arr = [];',
        'while (n-- > 0) arr.unshift(stack.pop());',
        'stack.push(arr);',
      ]
    case 'CALL':
      return [
        'n = inst[1];',
        'callArgs = [];',
        'while (n-- > 0) callArgs.unshift(stack.pop());',
        'callee = stack.pop();',
        'stack.push(callee.apply(void 0, callArgs));',
      ]
    case 'RET':
      return ['return stack.length ? stack.pop() : void 0;']
    case 'DUP':
      return ['stack.push(stack[stack.length - 1]);']
    case 'SWAP':
      return ['a = stack.pop();', 'b = stack.pop();', 'stack.push(a);', 'stack.push(b);']
    case 'TOSTR':
      return ['stack.push(String(stack.pop()));']
    case 'TONUM':
      return ['stack.push(Number(stack.pop()));']
    case 'HALT':
      return ['return stack.length ? stack[stack.length - 1] : void 0;']
    case 'LOAD_ARG':
      return ['stack.push(args[inst[1]]);']
    default:
      throw new Error(`no handler for opcode ${name}`)
  }
}

/** Opcodes whose handler ends the VM instead of falling through to `break`. */
const TERMINATING_OPCODES = new Set(['RET', 'HALT'])

/**
 * @typedef {object} BuildVMOptions
 * @property {number|string} [seed=1] Seed for obfuscation choices. Identical
 *   seeds produce identical source; the default is deterministic.
 * @property {string} [name='__vm_run'] Global function name defined by the
 *   generated source. Must be a valid non-reserved identifier.
 * @property {boolean} [obfuscate=false] Apply per-build opcode encoding,
 *   string-index encoding and shuffled dispatch-case order.
 */

/**
 * @typedef {object} VMArtifact
 * @property {string} code Self-contained generated JavaScript source.
 * @property {Record<string, {code: number, name: string, argc: number, stack: object, caseLine: number, count: number}>} dispatchTable
 *   Encoded opcode -> canonical metadata. Keys are the numbers that actually
 *   appear in the generated `switch`.
 * @property {Array<{code: number, name: string, argc: number, stack: object}>} opcodes
 *   Canonical opcodes used by this program.
 * @property {Array<{pc: number, code: number, name: string, line: number}>} sourceMap
 *   Bytecode instruction -> handler line in `code`.
 * @property {(options: { trust: 'host', args?: unknown[] }) => unknown} run
 *   Convenience host runner. Requires the explicit `{ trust: 'host' }`
 *   acknowledgement because it executes the generated source in the host
 *   process.
 * @property {Array<{code: number, args: unknown[]}>} bytecode Canonical bytecode
 *   (unencoded opcodes), useful for disassembly and assertions.
 */

/**
 * Build a JSVMP artifact for a readable program.
 *
 * @param {Array<{op: string, args?: unknown[]}>} program
 * @param {BuildVMOptions} [options]
 * @returns {VMArtifact}
 */
export function buildVM(program, options = {}) {
  const { seed = 1, name = DEFAULT_VM_NAME, obfuscate = false } = options
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name) || RESERVED_NAMES.has(name)) {
    throw new Error(`invalid VM global name: ${String(name)}`)
  }

  const { bytecode, consts } = assemble(program)
  const rng = createSeededRandom(seed)
  const cipher = createOpcodeCipher(obfuscate, rng)
  const stringBase = obfuscate ? consts.length + rng.int(1, 64) : consts.length
  const indexedBytecode = encodeConstIndices(bytecode, consts, stringBase, obfuscate)
  const encodedBytecode = encodeBytecode(indexedBytecode, cipher.encode)

  const counts = new Map()
  for (const instruction of bytecode) counts.set(instruction.code, (counts.get(instruction.code) ?? 0) + 1)
  const usedCodes = [...counts.keys()].sort((left, right) => left - right)
  const caseOrder = obfuscate ? shuffle(usedCodes, rng) : usedCodes

  const lines = []
  const caseLines = new Map()
  lines.push(`globalThis.${name} = (function () {`)
  lines.push(`  var BYTECODE = [${serializeBytecode(encodedBytecode)}];`)
  lines.push(`  var STRING_BASE = ${stringBase};`)
  lines.push('  return function (args) {')
  lines.push(`    var consts = [${serializeConsts(consts)}];`)
  lines.push('    var readConst = function (index) {')
  lines.push('      return consts[index >= STRING_BASE ? index - STRING_BASE : index];')
  lines.push('    };')
  lines.push('    var stack = [];')
  lines.push('    var pc = 0;')
  lines.push('    var a = 0, b = 0, n = 0, key = "", callee = null, callArgs = [], arr = [], i = 0;')
  lines.push('    args = args == null ? [] : args;')
  lines.push('    while (pc < BYTECODE.length) {')
  lines.push('      var inst = BYTECODE[pc++];')
  lines.push('      switch (inst[0]) {')

  for (const baseCode of caseOrder) {
    const spec = OPCODE_BY_CODE.get(baseCode)
    if (!spec) throw new Error(`unknown opcode code: ${baseCode}`)
    const encoded = cipher.encode(baseCode)
    caseLines.set(baseCode, lines.length + 1)
    lines.push(`        case ${encoded}:`)
    for (const line of handlerLines(spec.name)) lines.push(`          ${line}`)
    if (!TERMINATING_OPCODES.has(spec.name)) lines.push('          break;')
  }

  lines.push('      }')
  lines.push('    }')
  lines.push('    return stack.length ? stack[stack.length - 1] : void 0;')
  lines.push('  };')
  lines.push('})();')

  const code = lines.join('\n')

  /** @type {Record<string, {code: number, name: string, argc: number, stack: object, caseLine: number, count: number}>} */
  const dispatchTable = {}
  /** @type {Array<{code: number, name: string, argc: number, stack: object}>} */
  const opcodes = []
  for (const baseCode of usedCodes) {
    const spec = OPCODE_BY_CODE.get(baseCode)
    if (!spec) throw new Error(`unknown opcode code: ${baseCode}`)
    const encoded = cipher.encode(baseCode)
    const count = counts.get(baseCode) ?? 0
    dispatchTable[String(encoded)] = {
      code: spec.code,
      name: spec.name,
      argc: spec.argc,
      stack: spec.stack,
      caseLine: caseLines.get(baseCode),
      count,
    }
    opcodes.push({ code: spec.code, name: spec.name, argc: spec.argc, stack: spec.stack })
  }

  const sourceMap = bytecode.map((instruction, pc) => {
    const spec = OPCODE_BY_CODE.get(instruction.code)
    if (!spec) throw new Error(`unknown opcode code: ${instruction.code}`)
    return {
      pc,
      code: instruction.code,
      name: spec.name,
      line: caseLines.get(instruction.code),
    }
  })

  /**
   * Execute the generated artifact in the host process. The generated global
   * is restored afterwards so a convenience run does not leave host state
   * behind.
   *
   * Hazard: `new Function` executes with full host globals, so an artifact
   * assembled from sample-derived constants or bytecode is host-side code
   * execution. The call therefore requires the explicit `trust: 'host'`
   * acknowledgement and throws `TrustError` without it; artifacts that are not
   * known to be platform-originated should be executed with `vm.code` inside a
   * `TracelessSandbox` instead.
   *
   * @param {{ trust: 'host', args?: unknown[] }} options `trust` must be the
   *   literal `'host'`; `args` fills the VM's `LOAD_ARG` slots.
   * @returns {unknown}
   */
  function run(options) {
    const trust = options !== null && typeof options === 'object' ? options.trust : undefined
    if (trust !== REQUIRED_TRUST) {
      throw new TrustError(
        `buildVM().run() executes sample-derived code in the host process; pass { trust: '${REQUIRED_TRUST}' } to acknowledge the artifact is platform-originated, or execute vm.code inside a TracelessSandbox.`,
        { details: { expected: `{ trust: '${REQUIRED_TRUST}' }`, received: trust } },
      )
    }
    const hadGlobal = Object.prototype.hasOwnProperty.call(globalThis, name)
    const previous = globalThis[name]
    try {
      const factory = new Function(`${code}\nreturn ${name};`)
      const vm = factory()
      return vm(options.args)
    } finally {
      if (hadGlobal) globalThis[name] = previous
      else delete globalThis[name]
    }
  }

  return { code, dispatchTable, opcodes, sourceMap, run, bytecode }
}

/**
 * A small but non-trivial program used by tests, examples and integration
 * checks:
 *
 * - `fib(10) === 55` computed by a real loop with object-backed locals;
 * - `String(55)` concat `"fib(10)="` -> `"fib(10)=55"`;
 * - a result object receives `label` via `SET_PROP` and reads it back via
 *   `GET_PROP`.
 *
 * The program returns `"fib(10)=55 via VM"`.
 *
 * @returns {Array<{op: string, args?: unknown[]}>}
 */
export function buildSampleProgram() {
  /** @type {Array<{op: string, args?: unknown[]}>} */
  const program = []
  /** @param {string} op @param {...unknown} args */
  const emit = (op, ...args) => {
    program.push({ op, args })
    return program.length - 1
  }

  // The result object is kept below the Fibonacci frame. DUP supplies the
  // second reference that SET_PROP consumes, leaving the first for GET_PROP.
  emit('NEW_OBJ')
  emit('DUP')

  // State object: i = 1, a = 0, b = 1. With a = F(0), b = F(1), nine
  // iterations of i = 1 .. 9 produce b = F(10) = 55.
  emit('NEW_OBJ')
  emit('DUP')
  emit('PUSH', 1)
  emit('SET_PROP', 'i')
  emit('POP')
  emit('DUP')
  emit('PUSH', 0)
  emit('SET_PROP', 'a')
  emit('POP')
  emit('DUP')
  emit('PUSH', 1)
  emit('SET_PROP', 'b')
  emit('POP')

  const loopStart = program.length

  // while (state.i < 10)
  emit('DUP')
  emit('GET_PROP', 'i')
  emit('PUSH', 10)
  emit('LT')
  const exitJump = emit('JMP_IF_NOT', 0)

  // tmp = a + b
  emit('DUP')
  emit('DUP')
  emit('DUP')
  emit('GET_PROP', 'a')
  emit('SWAP')
  emit('GET_PROP', 'b')
  emit('ADD')
  emit('SET_PROP', 'tmp')
  emit('POP')

  // a = b
  emit('DUP')
  emit('DUP')
  emit('GET_PROP', 'b')
  emit('SET_PROP', 'a')
  emit('POP')

  // b = tmp
  emit('DUP')
  emit('DUP')
  emit('GET_PROP', 'tmp')
  emit('SET_PROP', 'b')
  emit('POP')

  // i = i + 1
  emit('DUP')
  emit('DUP')
  emit('GET_PROP', 'i')
  emit('PUSH', 1)
  emit('ADD')
  emit('SET_PROP', 'i')
  emit('POP')

  emit('JMP', loopStart)
  const exit = program.length
  program[exitJump].args = [exit]

  // Stack is [resultObject, resultObject, 55] here.
  emit('GET_PROP', 'b')
  emit('TOSTR')
  emit('LOAD_CONST', 'fib(10)=')
  emit('SWAP')
  emit('ADD')

  // Store the label, then read it back.
  emit('SET_PROP', 'label')
  emit('POP')
  emit('GET_PROP', 'label')
  emit('LOAD_CONST', ' via VM')
  emit('ADD')
  emit('HALT')

  return program
}
