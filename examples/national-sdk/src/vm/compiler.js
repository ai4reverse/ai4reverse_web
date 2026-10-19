/**
 * NSL → bytecode compiler.
 *
 * The protected signing logic is written in NSL: a deliberately small
 * JavaScript subset. A compiler for a *subset written by us* is auditable,
 * while compiling arbitrary JavaScript would drag in closures, prototypes,
 * generators and `eval` — every one of which is both a correctness risk and an
 * escape from the VM's control-flow model.
 *
 * Supported: one `function main(ctx)`, `var`, assignment, compound assignment,
 * `++`/`--`, `if/else`, `while`, classic `for`, `break`/`continue`, `return`,
 * arithmetic/bitwise/comparison/equality, `&&`/`||`/ternary, member access,
 * calls, array/object literals and literals. Not supported: closures, nested
 * functions, `this`, `new`, `try`, `switch`, `typeof` on undeclared names,
 * spread, destructuring, async. Unsupported syntax fails loudly at build time.
 */

import { parse } from '@babel/parser'
import * as t from '@babel/types'

import { ISA } from './isa.js'

export { ISA }

const BINARY = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '/': 'DIV',
  '%': 'MOD',
  '&': 'BIT_AND',
  '|': 'BIT_OR',
  '^': 'BIT_XOR',
  '<<': 'SHL',
  '>>': 'SHR',
  '>>>': 'USHR',
  '==': 'EQ',
  '!=': 'NEQ',
  '===': 'SEQ',
  '!==': 'SNEQ',
  '<': 'LT',
  '>': 'GT',
  '<=': 'LTE',
  '>=': 'GTE',
}

const UNARY = {
  '-': 'NEG',
  '+': 'TO_NUM',
  '!': 'NOT',
  '~': 'BNOT',
  typeof: 'TYPEOF',
}

/** @param {string} message @returns {never} */
function unsupported(message) {
  const error = new Error(`NSL: ${message}`)
  error.code = 'NSL_UNSUPPORTED'
  throw error
}

/**
 * @param {string} source
 * @returns {{instructions: Array<Array<string|number>>, consts: Array<string|number|boolean|null>, locals: string[], params: string[]}}
 */
export function compile(source) {
  const ast = parse(String(source), { sourceType: 'script', plugins: [] })
  const functions = ast.program.body.filter((node) => t.isFunctionDeclaration(node))
  if (functions.length !== 1) unsupported(`expected exactly one function declaration, found ${functions.length}`)
  const fn = functions[0]
  if (!fn.id || fn.id.name !== 'main') unsupported('the entry function must be named main')
  if (fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) unsupported('main must take exactly one identifier parameter (ctx)')

  const locals = [fn.params[0].name]
  const localIndex = new Map([[fn.params[0].name, 0]])
  const collectLocals = (node) => {
    if (!node) return
    if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (!t.isIdentifier(declarator.id)) unsupported('destructuring declarations are not supported')
        if (!localIndex.has(declarator.id.name)) {
          localIndex.set(declarator.id.name, locals.length)
          locals.push(declarator.id.name)
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') collectLocals(child)
      } else if (value && typeof value.type === 'string') {
        collectLocals(value)
      }
    }
  }
  collectLocals(fn.body)

  const instructions = []
  const consts = []
  /** @type {Array<{breaks: number[], continues: number[]}>} */
  const loops = []

  const intern = (value) => {
    const index = consts.findIndex((entry) => Object.is(entry, value))
    if (index >= 0) return index
    consts.push(value)
    return consts.length - 1
  }
  const emit = (op, ...args) => {
    if (!ISA.includes(op)) unsupported(`unknown opcode ${op}`)
    instructions.push([op, ...args])
    return instructions.length - 1
  }
  const emitConst = (value) => emit('CONST', intern(value))
  const patch = (index, target) => {
    instructions[index][1] = target
  }

  const compileExpression = (node) => {
    if (!node) return
    if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) {
      emitConst(node.value)
      return
    }
    if (t.isNullLiteral(node)) {
      emit('NULL')
      return
    }
    if (t.isIdentifier(node)) {
      if (node.name === 'undefined') {
        emit('UNDEF')
        return
      }
      if (node.name === 'NaN') {
        emitConst(NaN)
        return
      }
      if (node.name === 'Infinity') {
        emitConst(Infinity)
        return
      }
      const index = localIndex.get(node.name)
      if (index === undefined) unsupported(`reference to undeclared variable '${node.name}'`)
      emit('LOAD_LOCAL', index)
      return
    }
    if (t.isMemberExpression(node)) {
      compileExpression(node.object)
      if (node.computed) {
        compileExpression(node.property)
        emit('GET_INDEX')
      } else {
        const key = t.isIdentifier(node.property) ? node.property.name : node.property.value
        emit('GET_PROP', intern(String(key)))
      }
      return
    }
    if (t.isCallExpression(node)) {
      if (t.isMemberExpression(node.callee)) {
        const callee = node.callee
        compileExpression(callee.object)
        emit('DUP')
        if (callee.computed) {
          compileExpression(callee.property)
          emit('GET_INDEX')
        } else {
          const key = t.isIdentifier(callee.property) ? callee.property.name : callee.property.value
          emit('GET_PROP', intern(String(key)))
        }
        for (const argument of node.arguments) compileExpression(argument)
        emit('CALL_METHOD', node.arguments.length)
      } else {
        if (t.isSuper(node.callee)) unsupported('super is not supported')
        compileExpression(node.callee)
        for (const argument of node.arguments) compileExpression(argument)
        emit('CALL', node.arguments.length)
      }
      return
    }
    if (t.isUnaryExpression(node)) {
      if (node.operator === 'void') {
        compileExpression(node.argument)
        emit('POP')
        emit('UNDEF')
        return
      }
      const op = UNARY[node.operator]
      if (!op) unsupported(`unary operator ${node.operator}`)
      compileExpression(node.argument)
      emit(op)
      return
    }
    if (t.isBinaryExpression(node)) {
      const op = BINARY[node.operator]
      if (!op) unsupported(`binary operator ${node.operator}`)
      compileExpression(node.left)
      compileExpression(node.right)
      emit(op)
      return
    }
    if (t.isLogicalExpression(node)) {
      compileExpression(node.left)
      emit('DUP')
      const jump = emit(node.operator === '&&' ? 'JZ' : 'JNZ', 0)
      emit('POP')
      compileExpression(node.right)
      patch(jump, instructions.length)
      return
    }
    if (t.isConditionalExpression(node)) {
      compileExpression(node.test)
      const elseJump = emit('JZ', 0)
      compileExpression(node.consequent)
      const endJump = emit('JMP', 0)
      patch(elseJump, instructions.length)
      compileExpression(node.alternate)
      patch(endJump, instructions.length)
      return
    }
    if (t.isAssignmentExpression(node)) {
      const compound = node.operator !== '='
      const binary = compound ? BINARY[node.operator.slice(0, -1)] : null
      if (compound && !binary) unsupported(`assignment operator ${node.operator}`)
      if (t.isIdentifier(node.left)) {
        const index = localIndex.get(node.left.name)
        if (index === undefined) unsupported(`assignment to undeclared variable '${node.left.name}'`)
        if (compound) {
          emit('LOAD_LOCAL', index)
          compileExpression(node.right)
          emit(binary)
        } else {
          compileExpression(node.right)
        }
        emit('DUP')
        emit('STORE_LOCAL', index)
        return
      }
      if (t.isMemberExpression(node.left)) {
        const target = node.left
        compileExpression(target.object)
        if (target.computed) {
          if (compound) unsupported('compound assignment to a computed member is not supported')
          compileExpression(target.property)
          compileExpression(node.right)
          emit('SET_INDEX')
        } else {
          const key = intern(String(t.isIdentifier(target.property) ? target.property.name : target.property.value))
          if (compound) {
            emit('DUP')
            emit('GET_PROP', key)
          }
          compileExpression(node.right)
          if (compound) emit(binary)
          emit('SET_PROP', key)
        }
        return
      }
      unsupported('unsupported assignment target')
    }
    if (t.isUpdateExpression(node)) {
      if (!t.isIdentifier(node.argument)) unsupported('update expressions only support identifiers')
      const index = localIndex.get(node.argument.name)
      if (index === undefined) unsupported(`update of undeclared variable '${node.argument.name}'`)
      emit('LOAD_LOCAL', index)
      emitConst(1)
      emit(node.operator === '++' ? 'ADD' : 'SUB')
      emit('DUP')
      emit('STORE_LOCAL', index)
      return
    }
    if (t.isArrayExpression(node)) {
      for (const element of node.elements) {
        if (!element) unsupported('array holes are not supported')
        if (t.isSpreadElement(element)) unsupported('spread is not supported')
        compileExpression(element)
      }
      emit('NEW_ARRAY', node.elements.length)
      return
    }
    if (t.isObjectExpression(node)) {
      emit('NEW_OBJECT')
      for (const property of node.properties) {
        if (!t.isObjectProperty(property) || property.computed) unsupported('only static object properties are supported')
        const key = t.isIdentifier(property.key) ? property.key.name : String(property.key.value)
        emit('DUP')
        compileExpression(property.value)
        emit('SET_PROP', intern(key))
        emit('POP')
      }
      return
    }
    if (t.isSequenceExpression(node)) {
      node.expressions.forEach((expression, index) => {
        compileExpression(expression)
        if (index < node.expressions.length - 1) emit('POP')
      })
      return
    }
    unsupported(`expression ${node.type}`)
  }

  const compileStatements = (statements) => {
    for (const statement of statements) compileStatement(statement)
  }

  const compileStatement = (node) => {
    if (t.isBlockStatement(node)) {
      compileStatements(node.body)
      return
    }
    if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (declarator.init) {
          compileExpression(declarator.init)
          emit('STORE_LOCAL', localIndex.get(declarator.id.name))
        }
      }
      return
    }
    if (t.isEmptyStatement(node)) return
    if (t.isExpressionStatement(node)) {
      compileExpression(node.expression)
      emit('POP')
      return
    }
    if (t.isReturnStatement(node)) {
      if (node.argument) compileExpression(node.argument)
      else emit('UNDEF')
      emit('RETURN')
      return
    }
    if (t.isIfStatement(node)) {
      compileExpression(node.test)
      const elseJump = emit('JZ', 0)
      compileStatement(node.consequent)
      if (node.alternate) {
        const endJump = emit('JMP', 0)
        patch(elseJump, instructions.length)
        compileStatement(node.alternate)
        patch(endJump, instructions.length)
      } else {
        patch(elseJump, instructions.length)
      }
      return
    }
    if (t.isWhileStatement(node)) {
      const loop = { breaks: [], continues: [] }
      loops.push(loop)
      const start = instructions.length
      compileExpression(node.test)
      const exit = emit('JZ', 0)
      compileStatement(node.body)
      emit('JMP', start)
      patch(exit, instructions.length)
      for (const jump of loop.breaks) patch(jump, instructions.length)
      for (const jump of loop.continues) patch(jump, start)
      loops.pop()
      return
    }
    if (t.isForStatement(node)) {
      const loop = { breaks: [], continues: [] }
      loops.push(loop)
      if (node.init) {
        if (t.isVariableDeclaration(node.init)) compileStatement(node.init)
        else {
          compileExpression(node.init)
          emit('POP')
        }
      }
      const start = instructions.length
      let exit = -1
      if (node.test) {
        compileExpression(node.test)
        exit = emit('JZ', 0)
      }
      compileStatement(node.body)
      const updateStart = instructions.length
      if (node.update) {
        compileExpression(node.update)
        emit('POP')
      }
      emit('JMP', start)
      if (exit >= 0) patch(exit, instructions.length)
      for (const jump of loop.breaks) patch(jump, instructions.length)
      for (const jump of loop.continues) patch(jump, updateStart)
      loops.pop()
      return
    }
    if (t.isBreakStatement(node)) {
      if (node.label) unsupported('labelled break')
      const loop = loops[loops.length - 1]
      if (!loop) unsupported('break outside a loop')
      loop.breaks.push(emit('JMP', 0))
      return
    }
    if (t.isContinueStatement(node)) {
      if (node.label) unsupported('labelled continue')
      const loop = loops[loops.length - 1]
      if (!loop) unsupported('continue outside a loop')
      loop.continues.push(emit('JMP', 0))
      return
    }
    unsupported(`statement ${node.type}`)
  }

  compileStatements(fn.body.body)
  emit('HALT')

  return { instructions, consts, locals, params: [fn.params[0].name] }
}

/**
 * Compile and sanity-check a program without executing it.
 * @param {string} source
 */
export function compileAndValidate(source) {
  const program = compile(source)
  for (const [index, instruction] of program.instructions.entries()) {
    const [op, ...args] = instruction
    if (['JMP', 'JZ', 'JNZ'].includes(op)) {
      const target = args[0]
      if (!Number.isInteger(target) || target < 0 || target >= program.instructions.length) {
        throw new Error(`NSL: jump at ${index} targets ${target}, outside [0, ${program.instructions.length})`)
      }
    }
    if (['CONST'].includes(op) && (args[0] < 0 || args[0] >= program.consts.length)) {
      throw new Error(`NSL: constant index out of range at ${index}`)
    }
    if (['LOAD_LOCAL', 'STORE_LOCAL'].includes(op) && (args[0] < 0 || args[0] >= program.locals.length)) {
      throw new Error(`NSL: local index out of range at ${index}`)
    }
  }
  return program
}
