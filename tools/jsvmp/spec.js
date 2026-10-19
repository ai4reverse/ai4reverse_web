/**
 * Canonical JSVMP opcode table.
 *
 * `spec.js` is the single owner of opcode numbers, names, argument counts and
 * stack effects. The builder, the analyzer and any future disassembler must
 * import from here so that "LOAD_CONST is opcode 1" is true in exactly one
 * place.
 *
 * Program representation (input to {@link assemble}):
 *
 * ```js
 * [{ op: 'LOAD_CONST', args: ['hello'] }, { op: 'HALT' }]
 * ```
 *
 * For `LOAD_CONST`, `GET_PROP` and `SET_PROP` the single argument is a value
 * (not a pre-computed pool index); {@link assemble} interns it into `consts`
 * and rewrites the instruction argument to the pool index.
 */

/**
 * @typedef {object} OpcodeSpec
 * @property {number} code Canonical (unobfuscated) opcode number.
 * @property {string} name Mnemonic.
 * @property {number} argc Number of immediate arguments in the program.
 * @property {{in: number|string, out: number}} stack Stack effect. `argc`
 *   appears in `in` for variadic opcodes (`NEW_ARR`, `CALL`).
 * @property {string} doc One-line description used by disassemblers.
 */

/** @param {number} code @param {string} name @param {number} argc @param {{in: number|string, out: number}} stack @param {string} doc */
function opcode(code, name, argc, stack, doc) {
  return Object.freeze({ code, name, argc, stack: Object.freeze(stack), doc })
}

/**
 * Canonical opcode table. Codes are stable: change the name, never the number.
 * @type {readonly OpcodeSpec[]}
 */
export const OPCODES = Object.freeze([
  opcode(1, 'LOAD_CONST', 1, { in: 0, out: 1 }, 'push the interned constant at the given pool index'),
  opcode(2, 'LOAD_UNDEF', 0, { in: 0, out: 1 }, 'push undefined'),
  opcode(3, 'PUSH', 1, { in: 0, out: 1 }, 'push a primitive immediate encoded in the instruction'),
  opcode(4, 'POP', 0, { in: 1, out: 0 }, 'discard the top of the stack'),
  opcode(5, 'ADD', 0, { in: 2, out: 1 }, 'pop two values and push a + b'),
  opcode(6, 'SUB', 0, { in: 2, out: 1 }, 'pop two values and push a - b'),
  opcode(7, 'MUL', 0, { in: 2, out: 1 }, 'pop two values and push a * b'),
  opcode(8, 'DIV', 0, { in: 2, out: 1 }, 'pop two values and push a / b'),
  opcode(9, 'MOD', 0, { in: 2, out: 1 }, 'pop two values and push a % b'),
  opcode(10, 'NEG', 0, { in: 1, out: 1 }, 'pop a value and push its arithmetic negation'),
  opcode(11, 'NOT', 0, { in: 1, out: 1 }, 'pop a value and push its boolean negation'),
  opcode(12, 'EQ', 0, { in: 2, out: 1 }, 'pop two values and push a == b'),
  opcode(13, 'NEQ', 0, { in: 2, out: 1 }, 'pop two values and push a != b'),
  opcode(14, 'LT', 0, { in: 2, out: 1 }, 'pop two values and push a < b'),
  opcode(15, 'GT', 0, { in: 2, out: 1 }, 'pop two values and push a > b'),
  opcode(16, 'LTE', 0, { in: 2, out: 1 }, 'pop two values and push a <= b'),
  opcode(17, 'GTE', 0, { in: 2, out: 1 }, 'pop two values and push a >= b'),
  opcode(18, 'AND', 0, { in: 2, out: 1 }, 'pop two values and push a && b'),
  opcode(19, 'OR', 0, { in: 2, out: 1 }, 'pop two values and push a || b'),
  opcode(20, 'JMP', 1, { in: 0, out: 0 }, 'jump unconditionally to an absolute bytecode index'),
  opcode(21, 'JMP_IF', 1, { in: 1, out: 0 }, 'pop a condition and jump when it is truthy'),
  opcode(22, 'JMP_IF_NOT', 1, { in: 1, out: 0 }, 'pop a condition and jump when it is falsy'),
  opcode(23, 'GET_PROP', 1, { in: 1, out: 1 }, 'pop an object and push object[key] for the interned key'),
  opcode(24, 'SET_PROP', 1, { in: 2, out: 1 }, 'pop a value and object, assign object[key] = value, push the value'),
  opcode(25, 'NEW_OBJ', 0, { in: 0, out: 1 }, 'push a fresh empty object'),
  opcode(26, 'NEW_ARR', 1, { in: 'argc', out: 1 }, 'pop argc values and push an array containing them in original order'),
  opcode(27, 'CALL', 1, { in: 'argc+1', out: 1 }, 'pop argc arguments and a callee, then push the call result'),
  opcode(28, 'RET', 0, { in: 1, out: 0 }, 'pop the top value and return it from the VM'),
  opcode(29, 'DUP', 0, { in: 1, out: 2 }, 'duplicate the top stack value'),
  opcode(30, 'SWAP', 0, { in: 2, out: 2 }, 'exchange the top two stack values'),
  opcode(31, 'TOSTR', 0, { in: 1, out: 1 }, 'pop a value and push String(value)'),
  opcode(32, 'TONUM', 0, { in: 1, out: 1 }, 'pop a value and push Number(value)'),
  opcode(33, 'HALT', 0, { in: 0, out: 0 }, 'stop execution and return the value on top of the stack'),
  opcode(34, 'LOAD_ARG', 1, { in: 0, out: 1 }, 'push the VM argument at the given index'),
])

/** @type {ReadonlyMap<string, OpcodeSpec>} */
export const OPCODE_BY_NAME = new Map(OPCODES.map((spec) => [spec.name, spec]))

/** @type {ReadonlyMap<number, OpcodeSpec>} */
export const OPCODE_BY_CODE = new Map(OPCODES.map((spec) => [spec.code, spec]))

/**
 * One-sentence execution semantics per mnemonic. Kept separate from `doc` so
 * reports can show a stable, human-readable explanation without importing the
 * interpreter.
 * @type {Readonly<Record<string, string>>}
 */
export const SEMANTICS = Object.freeze({
  LOAD_CONST: 'Reads the constant pool entry selected by the immediate index and pushes it.',
  LOAD_UNDEF: 'Pushes the undefined value.',
  PUSH: 'Pushes the primitive immediate carried by the instruction.',
  POP: 'Removes the top stack value.',
  ADD: 'Pops two values and pushes their sum (JS + semantics, including string concatenation).',
  SUB: 'Pops two values and pushes their difference.',
  MUL: 'Pops two values and pushes their product.',
  DIV: 'Pops two values and pushes their quotient.',
  MOD: 'Pops two values and pushes their remainder.',
  NEG: 'Pops a value and pushes its arithmetic negation.',
  NOT: 'Pops a value and pushes its logical negation.',
  EQ: 'Pops two values and pushes the result of loose equality (==).',
  NEQ: 'Pops two values and pushes the result of loose inequality (!=).',
  LT: 'Pops two values and pushes whether the first is less than the second.',
  GT: 'Pops two values and pushes whether the first is greater than the second.',
  LTE: 'Pops two values and pushes whether the first is less than or equal to the second.',
  GTE: 'Pops two values and pushes whether the first is greater than or equal to the second.',
  AND: 'Pops two values and pushes a && b using JavaScript operand semantics.',
  OR: 'Pops two values and pushes a || b using JavaScript operand semantics.',
  JMP: 'Sets the program counter to the absolute target index.',
  JMP_IF: 'Pops a condition and jumps to the absolute target when it is truthy.',
  JMP_IF_NOT: 'Pops a condition and jumps to the absolute target when it is falsy.',
  GET_PROP: 'Pops an object and pushes object[key] using the interned key immediate.',
  SET_PROP: 'Pops a value and an object, assigns object[key] = value, and pushes the value.',
  NEW_OBJ: 'Pushes a fresh empty object.',
  NEW_ARR: 'Pops the requested number of values and pushes them as an array in original order.',
  CALL: 'Pops the requested arguments and a callee, calls the callee with this=undefined, and pushes the result.',
  RET: 'Pops the top value and returns it from the VM immediately.',
  DUP: 'Pushes a second reference to the current top value.',
  SWAP: 'Exchanges the top two stack values.',
  TOSTR: 'Pops a value and pushes String(value).',
  TONUM: 'Pops a value and pushes Number(value).',
  HALT: 'Stops execution and returns the value currently on top of the stack.',
  LOAD_ARG: 'Pushes the invocation argument at the given index, or undefined when absent.',
})

/** @param {string} message @returns {never} */
function fail(message) {
  const error = new Error(message)
  error.code = 'JSVMP_ERROR'
  throw error
}

/** @param {unknown} value */
function isPrimitiveImmediate(value) {
  return (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
}

/**
 * Validate a value that will be serialized into the generated constant pool.
 * @param {unknown} value
 * @param {Set<object>} [seen]
 * @param {string} [path]
 */
function assertSerializableConstant(value, seen = new Set(), path = 'value') {
  if (isPrimitiveImmediate(value)) return
  if (typeof value === 'function') fail(`${path}: functions cannot be stored in the constant pool`)
  if (typeof value !== 'object') fail(`${path}: unsupported constant type ${typeof value}`)
  if (seen.has(value)) fail(`${path}: cyclic constants are not supported`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableConstant(item, seen, `${path}[${index}]`))
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      fail(`${path}: only plain objects and arrays can be stored in the constant pool`)
    }
    for (const key of Object.keys(value)) {
      assertSerializableConstant(value[key], seen, `${path}.${key}`)
    }
  }
  seen.delete(value)
}

/**
 * Intern a value using SameValueZero-style identity, keeping `-0` distinct
 * from `0` because a VM constant pool is observable through arithmetic.
 * @param {unknown} value
 * @param {unknown[]} consts
 */
function intern(value, consts) {
  for (let index = 0; index < consts.length; index += 1) {
    if (Object.is(consts[index], value)) return index
  }
  consts.push(value)
  return consts.length - 1
}

/** Opcodes whose single immediate is a constant-pool index. */
const CONST_INDEX_OPCODES = new Set(['LOAD_CONST', 'GET_PROP', 'SET_PROP'])

/**
 * Translate a readable program into canonical bytecode and a constant pool.
 *
 * @param {Array<{op: string, args?: unknown[]}>} program
 * @returns {{bytecode: Array<{code: number, args: unknown[]}>, consts: unknown[]}}
 * @throws {Error} on an unknown opcode, a wrong argument count, or an invalid
 *   jump target / constant value.
 */
export function assemble(program) {
  if (!Array.isArray(program)) fail('program must be an array of { op, args } instructions')

  /** @type {unknown[]} */
  const consts = []
  /** @type {Array<{code: number, args: unknown[]}>} */
  const bytecode = []

  for (let pc = 0; pc < program.length; pc += 1) {
    const entry = program[pc]
    if (!entry || typeof entry !== 'object' || typeof entry.op !== 'string') {
      fail(`instruction ${pc} must be an object with a string op`)
    }
    const spec = OPCODE_BY_NAME.get(entry.op)
    if (!spec) fail(`unknown opcode: ${entry.op}`)
    const rawArgs = entry.args ?? []
    if (!Array.isArray(rawArgs)) fail(`instruction ${pc} (${spec.name}) args must be an array`)
    if (rawArgs.length !== spec.argc) {
      fail(`instruction ${pc} (${spec.name}) expects ${spec.argc} argument(s), received ${rawArgs.length}`)
    }

    let args
    if (CONST_INDEX_OPCODES.has(spec.name)) {
      assertSerializableConstant(rawArgs[0])
      args = [intern(rawArgs[0], consts)]
    } else if (spec.name === 'PUSH') {
      if (!isPrimitiveImmediate(rawArgs[0])) {
        fail(`instruction ${pc} (PUSH) requires a primitive immediate; use LOAD_CONST for objects`)
      }
      args = [rawArgs[0]]
    } else if (spec.name === 'JMP' || spec.name === 'JMP_IF' || spec.name === 'JMP_IF_NOT') {
      const target = rawArgs[0]
      if (!Number.isInteger(target) || target < 0 || target > program.length) {
        fail(`instruction ${pc} (${spec.name}) jump target must be an integer in [0, ${program.length}]`)
      }
      args = [target]
    } else if (spec.name === 'NEW_ARR' || spec.name === 'CALL') {
      const count = rawArgs[0]
      if (!Number.isInteger(count) || count < 0) {
        fail(`instruction ${pc} (${spec.name}) requires a non-negative integer argument`)
      }
      args = [count]
    } else if (spec.name === 'LOAD_ARG') {
      const index = rawArgs[0]
      if (!Number.isInteger(index) || index < 0) {
        fail(`instruction ${pc} (LOAD_ARG) requires a non-negative integer index`)
      }
      args = [index]
    } else {
      args = []
    }

    bytecode.push({ code: spec.code, args })
  }

  return { bytecode, consts }
}

/**
 * Canonical mnemonic for a numerical opcode.
 * @param {number} code
 * @returns {string|undefined}
 */
export function opcodeName(code) {
  return OPCODE_BY_CODE.get(code)?.name
}
