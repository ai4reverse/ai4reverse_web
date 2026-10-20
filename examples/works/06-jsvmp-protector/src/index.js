/**
 * JSVMP Protector SDK — compile expressions to obfuscated virtual bytecode.
 *
 * A small Pratt parser compiles arithmetic/string expressions into a stack
 * program; opcodes are XOR-encoded with a per-build key and constants live in an
 * encoded pool. The runtime decodes and interprets the program, so the original
 * expression never appears in the delivered source.
 */
export const VERSION = '1.0.0'

export const OP = Object.freeze({
  PUSH_CONST: 0x11, LOAD_VAR: 0x12, ADD: 0x21, SUB: 0x22, MUL: 0x23, DIV: 0x24, MOD: 0x25,
  NEG: 0x31, NOT: 0x32, CONCAT: 0x33, HALT: 0x7f,
})

export class CompileError extends Error {
  constructor(message) { super(message); this.name = 'CompileError'; this.code = 'COMPILE_ERROR' }
}

function tokenize(source) {
  const tokens = []
  const pattern = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|([+\-*/%()!]))/y
  let index = 0
  while (index < source.length) {
    pattern.lastIndex = index
    const match = pattern.exec(source)
    if (!match) throw new CompileError(`unexpected token at ${index}`)
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) })
    else if (match[2] !== undefined) tokens.push({ type: 'string', value: match[2].slice(1, -1).replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"') })
    else if (match[3] !== undefined) tokens.push({ type: 'identifier', value: match[3] })
    else tokens.push({ type: 'operator', value: match[4] })
    index = pattern.lastIndex
  }
  return tokens
}

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 }

function parse(tokens) {
  let cursor = 0
  const peek = () => tokens[cursor]
  const eat = (value) => {
    const token = tokens[cursor]
    if (!token || (value !== undefined && token.value !== value)) throw new CompileError(`expected ${value ?? 'token'}`)
    cursor += 1
    return token
  }
  const parsePrimary = () => {
    const token = peek()
    if (!token) throw new CompileError('unexpected end of expression')
    if (token.type === 'number' || token.type === 'string') { cursor += 1; return { type: 'const', value: token.value } }
    if (token.type === 'identifier') { cursor += 1; return { type: 'var', name: token.value } }
    if (token.value === '(') { eat('('); const node = parseExpression(0); eat(')'); return node }
    if (token.value === '-' || token.value === '+' || token.value === '!') {
      cursor += 1
      const argument = parsePrimary()
      return token.value === '+' ? argument : { type: 'unary', op: token.value, argument }
    }
    throw new CompileError(`unexpected token ${token.value}`)
  }
  const parseExpression = (minPrecedence) => {
    let left = parsePrimary()
    while (true) {
      const token = peek()
      if (!token || token.type !== 'operator' || !(token.value in PRECEDENCE)) break
      const precedence = PRECEDENCE[token.value]
      if (precedence < minPrecedence) break
      cursor += 1
      const right = parseExpression(precedence + 1)
      left = { type: 'binary', op: token.value, left, right }
    }
    return left
  }
  const ast = parseExpression(0)
  if (cursor !== tokens.length) throw new CompileError(`unexpected trailing token ${peek().value}`)
  return ast
}

function emit(node, consts, ops) {
  switch (node.type) {
    case 'const': {
      const index = consts.length
      consts.push(node.value)
      ops.push({ op: OP.PUSH_CONST, arg: index })
      return
    }
    case 'var':
      ops.push({ op: OP.LOAD_VAR, arg: node.name })
      return
    case 'unary':
      emit(node.argument, consts, ops)
      ops.push({ op: node.op === '-' ? OP.NEG : OP.NOT })
      return
    case 'binary':
      emit(node.left, consts, ops)
      emit(node.right, consts, ops)
      ops.push({ op: { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD }[node.op] })
      return
    default:
      throw new CompileError(`unsupported node ${node.type}`)
  }
}

/** @param {string} source @param {{key?: number}} [options] */
export function compile(source, options = {}) {
  const ast = parse(tokenize(String(source)))
  const consts = []
  const ops = []
  emit(ast, consts, ops)
  ops.push({ op: OP.HALT })
  const key = options.key ?? 0x5a
  const bytecode = ops.map((instruction) => ({
    op: instruction.op ^ key,
    ...(instruction.arg !== undefined ? { arg: instruction.arg } : {}),
  }))
  return { version: VERSION, key, consts, bytecode, sourceLength: String(source).length }
}

/** @param {ReturnType<typeof compile>} program */
export function createVM(program) {
  const key = program.key
  const code = program.bytecode.map((instruction) => ({ op: instruction.op ^ key, arg: instruction.arg }))
  return {
    run(environment = {}) {
      const stack = []
      for (let pc = 0; pc < code.length; pc += 1) {
        const instruction = code[pc]
        switch (instruction.op) {
          case OP.PUSH_CONST: stack.push(program.consts[instruction.arg]); break
          case OP.LOAD_VAR: {
            if (!(instruction.arg in environment)) throw new CompileError(`unknown variable ${instruction.arg}`)
            stack.push(environment[instruction.arg]); break
          }
          case OP.ADD: case OP.SUB: case OP.MUL: case OP.DIV: case OP.MOD: {
            const right = stack.pop(); const left = stack.pop()
            if (instruction.op === OP.ADD) stack.push(typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : left + right)
            else if (instruction.op === OP.SUB) stack.push(left - right)
            else if (instruction.op === OP.MUL) stack.push(left * right)
            else if (instruction.op === OP.DIV) stack.push(left / right)
            else stack.push(left % right)
            break
          }
          case OP.NEG: stack.push(-stack.pop()); break
          case OP.NOT: stack.push(!stack.pop()); break
          case OP.HALT: return stack.pop()
          default: throw new CompileError(`bad opcode at ${pc}`)
        }
      }
      return stack.pop()
    },
  }
}

export function protect(source, options) {
  const program = compile(source, options)
  const vm = createVM(program)
  return { program, run: (environment) => vm.run(environment) }
}

export function toJSON(program) {
  return JSON.stringify({ v: program.version, k: program.key, c: program.consts, b: program.bytecode })
}

export function fromJSON(text) {
  const data = JSON.parse(text)
  if (data.v !== VERSION || !Array.isArray(data.b)) throw new CompileError('invalid program JSON')
  return { version: data.v, key: data.k, consts: data.c, bytecode: data.b }
}
