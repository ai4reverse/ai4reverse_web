/**
 * String-array recovery pass.
 *
 * Obfuscators replace string literals with indices into a scrambled array and
 * scramble that array at load time with a rotation/reverse IIFE. Undoing the
 * scramble and inlining the constant reads is what makes the rest of a sample
 * readable, so this pass:
 *
 * 1. simulates the rotation/reverse IIFE on a permutation of *indices* (no code
 *    execution: only the small statement/expression subset implemented below is
 *    interpreted, and any unrecognized shape rejects the whole simulation);
 * 2. reorders the array literal accordingly and drops the IIFE;
 * 3. inlines `ARR[<constant>]` reads, folding literal arithmetic on the index;
 * 4. inlines small decoders whose body is a single `return ARR[<index>]`;
 * 5. deletes array/decoder declarations once nothing references them.
 *
 * Conservatism rules: an array is never inlined when a reference to it is a
 * write, a method call, or a value escape, and the rotation is only applied when
 * every read provably executes after the IIFE.
 */

import { generateExpression } from '../generate.js'

export const meta = {
  id: 'string-array',
  order: 50,
  description: 'rotate scrambled string arrays and inline constant reads and small decoders',
  idempotent: true,
}

/** Minimum element count for a candidate string array. */
const MIN_ARRAY_LENGTH = 4

/** Loop/statement budget for one simulated rotation. */
const MAX_SIMULATION_STEPS = 200000

/** Nested call depth budget for simulated helper functions. */
const MAX_CALL_DEPTH = 4

/** Safety bound on how many rotation IIFEs one pass run may apply. */
const MAX_ROTATION_ROUNDS = 64

/** Safety bound on inlining rounds; nested calls need more than one. */
const MAX_INLINE_ROUNDS = 16

/** @param {object} context */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/** Sentinel thrown by the simulator; never escapes `RotationSimulator.run`. */
const ROTATION_REJECTED = Symbol('rotation-rejected')

/** Arithmetic operators the numeric folder understands. */
const ARITHMETIC_BINARY = Object.freeze({
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
  '**': (a, b) => a ** b,
  '|': (a, b) => a | b,
  '&': (a, b) => a & b,
  '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b,
  '>>': (a, b) => a >> b,
  '>>>': (a, b) => a >>> b,
})

/**
 * Fold a pure numeric expression to a number.
 *
 * @param {object} t - `@babel/types`
 * @param {object} node
 * @param {(name: string) => (number|undefined)} [resolveIdentifier] - lookup used when folding decoder bodies
 * @returns {number|undefined} `undefined` when the expression is not foldable
 */
function foldNumber(t, node, resolveIdentifier) {
  if (!node) return undefined
  if (t.isNumericLiteral(node)) return node.value
  if (t.isParenthesizedExpression?.(node)) return foldNumber(t, node.expression, resolveIdentifier)
  if (t.isIdentifier(node)) return resolveIdentifier?.(node.name)
  if (t.isUnaryExpression(node)) {
    const argument = foldNumber(t, node.argument, resolveIdentifier)
    if (argument === undefined) return undefined
    if (node.operator === '-') return -argument
    if (node.operator === '+') return +argument
    if (node.operator === '~') return ~argument
    return undefined
  }
  if (t.isBinaryExpression(node)) {
    const operation = ARITHMETIC_BINARY[node.operator]
    if (!operation) return undefined
    const left = foldNumber(t, node.left, resolveIdentifier)
    const right = foldNumber(t, node.right, resolveIdentifier)
    if (left === undefined || right === undefined) return undefined
    return operation(left, right)
  }
  return undefined
}

/**
 * Resolve the static name of a member expression (`a.b`, `a['b']`, `a[0]`).
 *
 * @param {object} t
 * @param {object} node
 * @returns {string|null} `null` when the key is computed from a non-literal
 */
function memberName(t, node) {
  if (!t.isMemberExpression(node)) return null
  if (!node.computed) return t.isIdentifier(node.property) ? node.property.name : null
  if (t.isStringLiteral(node.property)) return node.property.value
  if (t.isNumericLiteral(node.property)) return String(node.property.value)
  return null
}

/**
 * Interprets the tiny subset of JavaScript used by string-array rotation
 * helpers, applying every array operation to a permutation of the original
 * indices instead of to the strings themselves.
 */
class RotationSimulator {
  /**
   * @param {object} t
   * @param {number} arrayLength
   * @param {string} arrayName
   */
  constructor(t, arrayLength, arrayName) {
    this.t = t
    this.arrayLength = arrayLength
    this.arrayName = arrayName
    /** @type {number[]} */
    this.order = Array.from({ length: arrayLength }, (_, index) => index)
    this.steps = 0
  }

  /**
   * @param {object} functionNode
   * @param {Array<{kind: string, value?: number}>} args
   * @returns {number[]|null} resulting element order, or `null` when unsupported
   */
  run(functionNode, args) {
    try {
      this.invoke({ kind: 'function', node: functionNode, env: null }, args, 0)
      return this.isPermutation() ? this.order : null
    } catch (error) {
      if (error === ROTATION_REJECTED) return null
      throw error
    }
  }

  /** @returns {boolean} true when the operations produced a pure index permutation */
  isPermutation() {
    if (this.order.length !== this.arrayLength) return false
    const seen = new Set(this.order)
    if (seen.size !== this.arrayLength) return false
    return this.order.every((value) => Number.isInteger(value) && value >= 0 && value < this.arrayLength)
  }

  /** Count one interpreted step; abort runaway loops. */
  budget() {
    this.steps += 1
    if (this.steps > MAX_SIMULATION_STEPS) throw ROTATION_REJECTED
  }

  /**
   * @param {{kind: string, env: object}} env
   * @param {string} name
   * @returns {{kind: string}|undefined}
   */
  lookup(env, name) {
    for (let scope = env; scope; scope = scope.parent) {
      const value = scope.vars.get(name)
      if (value) return value
    }
    return undefined
  }

  /**
   * @param {object} env
   * @param {string} name
   * @returns {{env: object, value: {kind: string}}|null}
   */
  lookupSlot(env, name) {
    for (let scope = env; scope; scope = scope.parent) {
      const value = scope.vars.get(name)
      if (value) return { env: scope, value }
    }
    return null
  }

  /**
   * @param {{kind: string, node: object, env: object}} fn
   * @param {Array<{kind: string}>} args
   * @param {number} depth
   * @returns {{kind: string}}
   */
  invoke(fn, args, depth) {
    const t = this.t
    if (depth > MAX_CALL_DEPTH) throw ROTATION_REJECTED
    const node = fn.node
    if (node.async || node.generator) throw ROTATION_REJECTED
    if (!Array.isArray(node.params) || node.params.length !== args.length) throw ROTATION_REJECTED
    if (!node.params.every((param) => t.isIdentifier(param))) throw ROTATION_REJECTED
    if (!t.isBlockStatement(node.body)) throw ROTATION_REJECTED
    const env = { vars: new Map(), parent: fn.env }
    node.params.forEach((param, index) => env.vars.set(param.name, args[index]))
    this.runStatements(node.body.body, env, depth)
    return { kind: 'number', value: 0 }
  }

  /**
   * @param {object[]} statements
   * @param {object} env
   * @param {number} depth
   */
  runStatements(statements, env, depth) {
    const t = this.t
    for (const statement of statements) {
      if (!t.isFunctionDeclaration(statement)) continue
      if (!t.isIdentifier(statement.id)) throw ROTATION_REJECTED
      env.vars.set(statement.id.name, { kind: 'function', node: statement, env })
    }
    for (const statement of statements) this.runStatement(statement, env, depth)
  }

  /**
   * @param {object} node
   * @param {object} env
   * @param {number} depth
   */
  runStatement(node, env, depth) {
    const t = this.t
    this.budget()
    if (t.isFunctionDeclaration(node)) return
    if (t.isBlockStatement(node)) {
      this.runStatements(node.body, env, depth)
      return
    }
    if (t.isEmptyStatement(node)) return
    if (t.isExpressionStatement(node)) {
      this.evaluate(node.expression, env, depth)
      return
    }
    if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (!t.isIdentifier(declarator.id) || !declarator.init) throw ROTATION_REJECTED
        if (t.isFunctionExpression(declarator.init) || t.isArrowFunctionExpression(declarator.init)) {
          env.vars.set(declarator.id.name, { kind: 'function', node: declarator.init, env })
        } else {
          env.vars.set(declarator.id.name, this.evaluate(declarator.init, env, depth))
        }
      }
      return
    }
    if (t.isWhileStatement(node)) {
      for (;;) {
        this.budget()
        const test = this.evaluate(node.test, env, depth)
        if (test.kind !== 'number') throw ROTATION_REJECTED
        if (!test.value) break
        this.runStatement(node.body, env, depth)
      }
      return
    }
    throw ROTATION_REJECTED
  }

  /**
   * @param {object} node
   * @param {object} env
   * @param {number} depth
   * @returns {{kind: string}}
   */
  evaluate(node, env, depth) {
    const t = this.t
    this.budget()
    if (!node) throw ROTATION_REJECTED
    switch (node.type) {
      case 'NumericLiteral':
        return { kind: 'number', value: node.value }
      case 'BooleanLiteral':
        return { kind: 'number', value: node.value ? 1 : 0 }
      case 'ParenthesizedExpression':
        return this.evaluate(node.expression, env, depth)
      case 'Identifier': {
        const value = this.lookup(env, node.name)
        if (value) return value
        if (node.name === this.arrayName) return { kind: 'array' }
        throw ROTATION_REJECTED
      }
      case 'UnaryExpression': {
        const argument = this.evaluate(node.argument, env, depth)
        if (argument.kind !== 'number') throw ROTATION_REJECTED
        if (node.operator === '-') return { kind: 'number', value: -argument.value }
        if (node.operator === '+') return { kind: 'number', value: +argument.value }
        if (node.operator === '~') return { kind: 'number', value: ~argument.value }
        if (node.operator === '!') return { kind: 'number', value: argument.value ? 0 : 1 }
        throw ROTATION_REJECTED
      }
      case 'BinaryExpression': {
        const operation = ARITHMETIC_BINARY[node.operator]
        if (!operation) throw ROTATION_REJECTED
        const left = this.evaluate(node.left, env, depth)
        const right = this.evaluate(node.right, env, depth)
        if (left.kind !== 'number' || right.kind !== 'number') throw ROTATION_REJECTED
        return { kind: 'number', value: operation(left.value, right.value) }
      }
      case 'UpdateExpression': {
        if (!t.isIdentifier(node.argument)) throw ROTATION_REJECTED
        if (node.operator !== '++' && node.operator !== '--') throw ROTATION_REJECTED
        const slot = this.lookupSlot(env, node.argument.name)
        if (!slot || slot.value.kind !== 'number') throw ROTATION_REJECTED
        const previous = slot.value.value
        const next = node.operator === '++' ? previous + 1 : previous - 1
        slot.env.vars.set(node.argument.name, { kind: 'number', value: next })
        return { kind: 'number', value: node.prefix ? next : previous }
      }
      case 'SequenceExpression': {
        let result = { kind: 'number', value: 0 }
        for (const expression of node.expressions) result = this.evaluate(expression, env, depth)
        return result
      }
      case 'MemberExpression': {
        const object = this.evaluate(node.object, env, depth)
        if (object.kind !== 'array') throw ROTATION_REJECTED
        if (memberName(t, node) !== 'length') throw ROTATION_REJECTED
        return { kind: 'number', value: this.order.length }
      }
      case 'CallExpression':
        return this.evaluateCall(node, env, depth)
      default:
        throw ROTATION_REJECTED
    }
  }

  /**
   * @param {object} node
   * @param {object} env
   * @param {number} depth
   * @returns {{kind: string}}
   */
  evaluateCall(node, env, depth) {
    const t = this.t
    this.budget()
    if (node.arguments.some((argument) => t.isSpreadElement(argument))) throw ROTATION_REJECTED
    if (t.isIdentifier(node.callee)) {
      const fn = this.lookup(env, node.callee.name)
      if (!fn || fn.kind !== 'function') throw ROTATION_REJECTED
      const args = node.arguments.map((argument) => this.evaluate(argument, env, depth))
      return this.invoke(fn, args, depth + 1)
    }
    if (t.isMemberExpression(node.callee)) {
      const object = this.evaluate(node.callee.object, env, depth)
      if (object.kind !== 'array') throw ROTATION_REJECTED
      const method = memberName(t, node.callee)
      const args = node.arguments.map((argument) => this.evaluate(argument, env, depth))
      return this.applyArrayMethod(method, args)
    }
    throw ROTATION_REJECTED
  }

  /**
   * @param {string|null} method
   * @param {Array<{kind: string}>} args
   * @returns {{kind: string}}
   */
  applyArrayMethod(method, args) {
    const numbers = () =>
      args.map((argument) => {
        if (argument.kind !== 'number') throw ROTATION_REJECTED
        return argument.value
      })
    switch (method) {
      case 'push': {
        for (const value of numbers()) this.order.push(value)
        return { kind: 'number', value: this.order.length }
      }
      case 'unshift': {
        this.order.unshift(...numbers())
        return { kind: 'number', value: this.order.length }
      }
      case 'shift': {
        if (this.order.length === 0) throw ROTATION_REJECTED
        return { kind: 'number', value: this.order.shift() }
      }
      case 'pop': {
        if (this.order.length === 0) throw ROTATION_REJECTED
        return { kind: 'number', value: this.order.pop() }
      }
      case 'reverse': {
        this.order.reverse()
        return { kind: 'array' }
      }
      default:
        throw ROTATION_REJECTED
    }
  }
}

/**
 * @typedef {object} ArrayRecord
 * @property {string} name
 * @property {object} declaratorPath
 * @property {object} bindingScope - scope that owns the array binding
 * @property {object} arrayNode - the `ArrayExpression` node (mutated by rotations)
 * @property {string[]} elements
 * @property {boolean} poisoned - set when rotation/inlining would be unsafe
 */

/**
 * @typedef {object} DecoderRecord
 * @property {string} name
 * @property {object} bindingScope
 * @property {object} functionPath - FunctionDeclaration path or VariableDeclarator path
 * @property {string[]} params
 * @property {ArrayRecord} array
 * @property {object} indexNode
 * @property {object} declarationPath - node removed when the decoder becomes unreferenced
 */

/**
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @returns {ArrayRecord[]}
 */
function collectStringArrays(t, traverse, ast) {
  const records = []
  traverse(ast, {
    VariableDeclarator(path) {
      const { node } = path
      if (!t.isIdentifier(node.id) || !t.isArrayExpression(node.init)) return
      const elements = node.init.elements
      if (elements.length < MIN_ARRAY_LENGTH) return
      if (!elements.every((element) => t.isStringLiteral(element))) return
      const binding = path.scope.getBinding(node.id.name)
      if (!binding || binding.path.node !== node) return
      records.push({
        name: node.id.name,
        declaratorPath: path,
        bindingScope: path.scope,
        arrayNode: node.init,
        elements: elements.map((element) => element.value),
        poisoned: false,
      })
    },
  })
  return records
}

/**
 * True when `path` appears textually before the declaration it would be folded
 * from. Conservative: hoisted functions called earlier are also skipped.
 * @param {object|null} declaratorPath
 * @param {object} path
 */
function isBeforeDeclaration(declaratorPath, path) {
  const declarationStart = declaratorPath?.node?.start
  const referenceStart = path?.node?.start
  if (!Number.isFinite(declarationStart) || !Number.isFinite(referenceStart)) return false
  return referenceStart < declarationStart
}

/** Rebuild scope bindings after structural edits so reference counts are exact. */
function refreshScopes(traverse, ast) {
  traverse(ast, {
    Program(path) {
      path.scope.crawl()
    },
  })
}

/**
 * @param {ArrayRecord} record
 * @returns {object|null} fresh binding for the record's array
 */
function currentArrayBinding(record) {
  return record.bindingScope.getBinding(record.name) ?? null
}

/**
 * @param {object} path
 * @returns {object|null} nearest statement directly inside a Program/Block body
 */
function enclosingStatementPath(path) {
  let current = path
  while (current?.parentPath && !current.parentPath.isProgram() && !current.parentPath.isBlockStatement()) {
    current = current.parentPath
  }
  if (!current?.parentPath) return null
  return current
}

/**
 * @param {object} path
 * @param {object} ancestorPath
 * @returns {boolean}
 */
function isDescendantOf(path, ancestorPath) {
  for (let current = path; current; current = current.parentPath) {
    if (current.node === ancestorPath.node) return true
  }
  return false
}

/**
 * @param {object} t
 * @param {object} functionPath
 * @returns {string|null} name the function is bound to, if any
 */
function functionBindingName(t, functionPath) {
  if (functionPath.node.id && t.isIdentifier(functionPath.node.id)) return functionPath.node.id.name
  const parent = functionPath.parentPath
  if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name
  return null
}

/**
 * Find the ancestor statement that is a direct child of `statementList`.
 *
 * @param {object} path
 * @param {object[]} statementList
 * @returns {object|null}
 */
function topLevelStatementIn(path, statementList) {
  let current = path
  while (current?.parentPath) {
    const parent = current.parentPath
    if ((parent.isProgram() || parent.isBlockStatement()) && parent.node.body === statementList) return current
    current = parent
  }
  return null
}

/**
 * True when the reference provably executes after `boundaryIndex`: it is either
 * lexically later, or it sits inside a helper whose every call is later.
 *
 * @param {object} t
 * @param {object} referencePath
 * @param {object[]} statementList
 * @param {number} boundaryIndex
 * @returns {boolean}
 */
function statementExecutesAfter(t, referencePath, statementList, boundaryIndex) {
  const statement = topLevelStatementIn(referencePath, statementList)
  if (!statement) return false
  if (statement.key > boundaryIndex) return true
  // A read inside a helper declared before the IIFE is safe only when every call
  // to that helper happens after the IIFE.
  const functionPath = referencePath.getFunctionParent()
  if (!functionPath) return false
  const name = functionBindingName(t, functionPath)
  if (!name) return false
  const binding = functionPath.scope.getBinding(name)
  if (!binding) return false
  for (const helperReference of binding.referencePaths) {
    const callPath = helperReference.parentPath
    if (!callPath.isCallExpression() || callPath.node.callee !== helperReference.node) return false
    const callStatement = topLevelStatementIn(callPath, statementList)
    if (!callStatement) return false
    if (callStatement.key <= boundaryIndex) return false
  }
  return true
}

/**
 * Every read of the array must happen after the rotation IIFE, otherwise
 * reordering the literal would change the values read before it.
 *
 * @param {object} t
 * @param {object} iifePath
 * @param {ArrayRecord} record
 * @returns {boolean}
 */
function readsExecuteAfterRotation(t, iifePath, record) {
  const iifeStatement = enclosingStatementPath(iifePath)
  if (!iifeStatement) return false
  const statementList = iifeStatement.parentPath.node.body
  const iifeIndex = iifeStatement.key
  const declarationStatement = enclosingStatementPath(record.declaratorPath)
  if (!declarationStatement) return false
  if (declarationStatement.parentPath.node.body !== statementList) return false
  if (declarationStatement.key >= iifeIndex) return false
  const binding = currentArrayBinding(record)
  if (!binding) return false
  for (const reference of binding.referencePaths) {
    if (isDescendantOf(reference, iifePath)) continue
    if (statementExecutesAfter(t, reference, statementList, iifeIndex)) continue
    return false
  }
  return true
}

/**
 * Find the next rotation/reverse IIFE targeting one of the collected arrays.
 *
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @param {ArrayRecord[]} records
 * @param {Set<object>} skipped - statements already known not to be rotations
 * @returns {{path: object, record: ArrayRecord, order: number[]}|null}
 */
function findRotation(t, traverse, ast, records, skipped) {
  let found = null
  traverse(ast, {
    ExpressionStatement(path) {
      if (found || skipped.has(path.node)) return
      const candidate = matchRotation(t, path, records)
      if (candidate) found = candidate
    },
  })
  return found
}

/**
 * @param {object} t
 * @param {object} statementPath
 * @param {ArrayRecord[]} records
 * @returns {{path: object, record: ArrayRecord, order: number[]}|null}
 */
function matchRotation(t, statementPath, records) {
  // A rotation always runs in the sample; a conditional call must not be hoisted.
  const container = statementPath.parentPath
  if (!container.isProgram() && !container.isBlockStatement()) return null
  const expression = statementPath.node.expression
  if (!t.isCallExpression(expression)) return null
  const callee = expression.callee
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return null
  const args = expression.arguments
  if (args.length < 1 || args.some((argument) => t.isSpreadElement(argument))) return null
  const target = args[0]
  if (!t.isIdentifier(target)) return null
  const binding = statementPath.scope.getBinding(target.name)
  if (!binding) return null
  const record = records.find((candidate) => !candidate.poisoned && currentArrayBinding(candidate) === binding)
  if (!record) return null
  const positions = []
  for (const argument of args.slice(1)) {
    const value = foldNumber(t, argument)
    if (value === undefined) return null
    positions.push(value)
  }
  const simulator = new RotationSimulator(t, record.arrayNode.elements.length, record.name)
  const order = simulator.run(callee, [{ kind: 'array' }, ...positions.map((value) => ({ kind: 'number', value }))])
  if (!order) return null
  return { path: statementPath, record, order }
}

/**
 * Apply every recognized rotation/reverse IIFE to its array literal.
 *
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @param {ArrayRecord[]} records
 * @param {string[]} notes
 * @param {function} report
 * @returns {number} number of applied rotations
 */
function applyRotations(t, traverse, ast, records, notes, report) {
  const skipped = new Set()
  let applied = 0
  for (let round = 0; round < MAX_ROTATION_ROUNDS; round += 1) {
    const candidate = findRotation(t, traverse, ast, records, skipped)
    if (!candidate) break
    const { path, record, order } = candidate
    if (!readsExecuteAfterRotation(t, path, record)) {
      skipped.add(path.node)
      record.poisoned = true
      notes.push(`kept ${record.name}: a read may execute before its rotation`)
      continue
    }
    const elements = record.arrayNode.elements
    record.arrayNode.elements = order.map((index) => elements[index])
    record.elements = record.arrayNode.elements.map((element) => element.value)
    report({ rule: 'rotation', from: record.name, to: `order ${order.join(',')}` })
    path.remove()
    // Structural edits invalidate cached reference paths; the next candidate's
    // safety check must see the new statement positions.
    refreshScopes(traverse, ast)
    applied += 1
  }
  if (applied > 0) notes.push(`applied ${applied} string-array rotation${applied === 1 ? '' : 's'}`)
  return applied
}

/**
 * A decoder is a function whose whole body is `return ARR[<foldable index>]`
 * with the index built only from its parameters.
 *
 * @param {object} t
 * @param {object} functionNode
 * @returns {object|null} returned expression
 */
function singleReturnedExpression(t, functionNode) {
  if (functionNode.async || functionNode.generator) return null
  if (t.isArrowFunctionExpression(functionNode) && !t.isBlockStatement(functionNode.body)) return functionNode.body
  const body = functionNode.body
  if (!t.isBlockStatement(body)) return null
  if ((body.directives?.length ?? 0) > 0) return null
  if (body.body.length !== 1) return null
  const statement = body.body[0]
  if (!t.isReturnStatement(statement) || !statement.argument) return null
  return statement.argument
}

/**
 * @param {object} t
 * @param {object} node
 * @param {Set<string>} paramNames
 * @returns {boolean}
 */
function usesOnlyParams(t, node, paramNames) {
  if (t.isNumericLiteral(node)) return true
  if (t.isIdentifier(node)) return paramNames.has(node.name)
  if (t.isParenthesizedExpression?.(node)) return usesOnlyParams(t, node.expression, paramNames)
  if (t.isUnaryExpression(node)) {
    return ['-', '+', '~'].includes(node.operator) && usesOnlyParams(t, node.argument, paramNames)
  }
  if (t.isBinaryExpression(node)) {
    return (
      Boolean(ARITHMETIC_BINARY[node.operator]) &&
      usesOnlyParams(t, node.left, paramNames) &&
      usesOnlyParams(t, node.right, paramNames)
    )
  }
  return false
}

/**
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @param {ArrayRecord[]} records
 * @returns {DecoderRecord[]}
 */
function collectDecoders(t, traverse, ast, records) {
  /** @type {DecoderRecord[]} */
  const decoders = []

  const consider = (bindingScope, functionPath, functionNode) => {
    const boundName = functionPath.isVariableDeclarator()
      ? t.isIdentifier(functionPath.node.id)
        ? functionPath.node.id.name
        : null
      : functionNode.id && t.isIdentifier(functionNode.id)
        ? functionNode.id.name
        : null
    if (!boundName) return
    if (!functionNode.params.every((param) => t.isIdentifier(param))) return
    if (functionNode.params.length === 0) return
    const returned = singleReturnedExpression(t, functionNode)
    if (!t.isMemberExpression(returned) || !returned.computed) return
    if (!t.isIdentifier(returned.object)) return
    const arrayBinding = functionPath.scope.getBinding(returned.object.name)
    if (!arrayBinding) return
    const array = records.find(
      (candidate) => !candidate.poisoned && currentArrayBinding(candidate) === arrayBinding,
    )
    if (!array) return
    const paramNames = new Set(functionNode.params.map((param) => param.name))
    if (!usesOnlyParams(t, returned.property, paramNames)) return
    const binding = bindingScope.getBinding(boundName)
    if (!binding) return
    // Only direct calls may be inlined; a decoder used as a value stays.
    for (const reference of binding.referencePaths) {
      const callPath = reference.parentPath
      if (!callPath.isCallExpression() || callPath.node.callee !== reference.node) return
    }
    decoders.push({
      name: boundName,
      bindingScope,
      functionPath,
      params: functionNode.params.map((param) => param.name),
      array,
      indexNode: returned.property,
      declarationPath: functionPath,
    })
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      if (!t.isIdentifier(path.node.id)) return
      consider(path.parentPath.scope, path, path.node)
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return
      if (!t.isFunctionExpression(path.node.init)) return
      consider(path.scope, path, path.node.init)
    },
  })
  return decoders
}

/**
 * @param {DecoderRecord} decoder
 * @returns {object|null} fresh binding for the decoder
 */
function currentDecoderBinding(decoder) {
  return decoder.bindingScope.getBinding(decoder.name) ?? null
}

/**
 * @param {object} memberPath
 * @returns {boolean} true when the member expression is an assignment target
 */
function isWriteTarget(memberPath) {
  const parent = memberPath.parentPath
  if (!parent) return false
  if (parent.isAssignmentExpression() && parent.node.left === memberPath.node) return true
  if (parent.isUpdateExpression()) return true
  if (parent.isUnaryExpression() && parent.node.operator === 'delete') return true
  return false
}

/**
 * Every reference to the array must be a plain read (`ARR[k]`, `ARR.length`).
 * Method calls, writes and value escapes would make inlining unsound.
 *
 * @param {ArrayRecord} record
 * @returns {boolean}
 */
function arrayIsReadOnly(record) {
  const binding = currentArrayBinding(record)
  if (!binding) return false
  if (binding.constantViolations.length > 0) return false
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath
    if (!parent?.isMemberExpression() || parent.node.object !== reference.node) return false
    if (isWriteTarget(parent)) return false
    if (parent.parentPath.isCallExpression() && parent.parentPath.node.callee === parent.node) return false
  }
  return true
}

/**
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @param {ArrayRecord[]} records
 * @param {function} report
 * @returns {number} number of inlined reads
 */
function inlineArrayReads(t, traverse, ast, records, report) {
  let inlined = 0
  traverse(ast, {
    MemberExpression(path) {
      if (!t.isIdentifier(path.node.object) || !path.node.computed) return
      const binding = path.scope.getBinding(path.node.object.name)
      if (!binding) return
      const record = records.find((candidate) => !candidate.poisoned && currentArrayBinding(candidate) === binding)
      if (!record) return
      // A read that precedes the declaration cannot be inlined: at runtime it
      // would throw (or read a pre-existing global).
      if (isBeforeDeclaration(record.declaratorPath, path)) return
      const index = foldNumber(t, path.node.property)
      if (index === undefined) return
      if (!Number.isInteger(index) || index < 0 || index >= record.elements.length) return
      report({
        rule: 'array-read',
        from: generateExpression(path.node),
        to: JSON.stringify(record.elements[index]),
      })
      path.replaceWith(t.stringLiteral(record.elements[index]))
      path.skip()
      inlined += 1
    },
  })
  return inlined
}

/**
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @param {DecoderRecord[]} decoders
 * @param {function} report
 * @returns {number} number of inlined decoder calls
 */
function inlineDecoderCalls(t, traverse, ast, decoders, report) {
  let inlined = 0
  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee)) return
      if (path.node.arguments.some((argument) => t.isSpreadElement(argument))) return
      const binding = path.scope.getBinding(path.node.callee.name)
      if (!binding) return
      const decoder = decoders.find((candidate) => currentDecoderBinding(candidate) === binding)
      if (!decoder) return
      if (isBeforeDeclaration(decoder.functionPath, path)) return
      if (path.node.arguments.length !== decoder.params.length) return
      const values = new Map()
      for (let index = 0; index < decoder.params.length; index += 1) {
        const value = foldNumber(t, path.node.arguments[index])
        if (value === undefined) return
        values.set(decoder.params[index], value)
      }
      const arrayIndex = foldNumber(t, decoder.indexNode, (name) => values.get(name))
      if (arrayIndex === undefined) return
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= decoder.array.elements.length) return
      report({
        rule: 'decoder-call',
        from: generateExpression(path.node),
        to: JSON.stringify(decoder.array.elements[arrayIndex]),
      })
      path.replaceWith(t.stringLiteral(decoder.array.elements[arrayIndex]))
      path.skip()
      inlined += 1
    },
  })
  return inlined
}

/**
 * Inline constant reads and decoder calls until nothing changes, so one pass run
 * reaches a fixpoint even for nested calls such as `dec(dec(1))`.
 *
 * @param {object} t
 * @param {object} traverse
 * @param {object} ast
 * @param {ArrayRecord[]} records
 * @param {DecoderRecord[]} decoders
 * @param {string[]} notes
 * @param {function} report
 * @returns {number} total number of inlined expressions
 */
function inlineAll(t, traverse, ast, records, decoders, notes, report) {
  let decoderInlines = 0
  let readInlines = 0
  for (let round = 0; round < MAX_INLINE_ROUNDS; round += 1) {
    const decoderRound = inlineDecoderCalls(t, traverse, ast, decoders, report)
    const readRound = inlineArrayReads(t, traverse, ast, records, report)
    decoderInlines += decoderRound
    readInlines += readRound
    if (decoderRound + readRound === 0) break
  }
  if (decoderInlines > 0) {
    notes.push(`inlined ${decoderInlines} decoder call${decoderInlines === 1 ? '' : 's'}`)
  }
  if (readInlines > 0) notes.push(`inlined ${readInlines} string-array read${readInlines === 1 ? '' : 's'}`)
  return decoderInlines + readInlines
}

/**
 * Remove a declaration once its binding is unreferenced.
 *
 * @param {object} path - VariableDeclarator or statement path
 */
function removeDeclaration(path) {
  if (!path.isVariableDeclarator()) {
    path.remove()
    return
  }
  const declaration = path.parentPath
  const container = declaration.parentPath
  // A lone `for (var arr = [...];;)` init cannot lose its declaration node.
  if (!container.isProgram() && !container.isBlockStatement() && !container.isSwitchCase()) {
    if (declaration.node.declarations.length > 1) path.remove()
    return
  }
  if (declaration.node.declarations.length === 1) {
    declaration.remove()
    return
  }
  path.remove()
}

/**
 * @param {object} traverse
 * @param {object} ast
 * @param {ArrayRecord[]} records
 * @param {DecoderRecord[]} decoders
 * @param {string[]} notes
 * @param {function} report
 * @returns {number} number of removed declarations
 */
function removeUnreferencedDeclarations(traverse, ast, records, decoders, notes, report) {
  let removed = 0
  // Decoders may be the last reference to an array, so repeat until stable.
  for (let round = 0; round < 3; round += 1) {
    refreshScopes(traverse, ast)
    const pending = []
    for (const record of records) {
      if (record.poisoned) continue
      const binding = currentArrayBinding(record)
      if (!binding || binding.referencePaths.length > 0 || binding.constantViolations.length > 0) continue
      // P0-7: empty referencePaths is not enough — window._0xa / eval / with can
      // still reach the binding without a static Identifier reference.
      if (hasDynamicAccess(traverse, ast, record.name)) {
        notes.push(`kept ${record.name}: reachable via dynamic access`)
        continue
      }
      pending.push({ path: record.declaratorPath, name: record.name })
    }
    for (const decoder of decoders) {
      const binding = currentDecoderBinding(decoder)
      if (!binding || binding.referencePaths.length > 0) continue
      if (hasDynamicAccess(traverse, ast, decoder.name)) {
        notes.push(`kept ${decoder.name}: reachable via dynamic access`)
        continue
      }
      pending.push({ path: decoder.declarationPath, name: decoder.name })
    }
    if (pending.length === 0) break
    for (const entry of pending) {
      report({ rule: 'declaration-removal', from: entry.name, to: 'unreferenced' })
      removeDeclaration(entry.path)
      removed += 1
    }
  }
  if (removed > 0) notes.push(`removed ${removed} unreferenced string-array declaration${removed === 1 ? '' : 's'}`)
  return removed
}

const GLOBAL_ALIASES = new Set(['window', 'globalThis', 'self', 'global'])

/**
 * True when `name` may still be reached without a static binding reference
 * (`window.name`, `eval`, `with`). Mirrors rename.js dynamic-scope bail (P0-7).
 */
function hasDynamicAccess(traverse, ast, name) {
  let found = false
  traverse(ast, {
    WithStatement(path) {
      found = true
      path.stop()
    },
    CallExpression(path) {
      if (found) return
      if (path.node.callee?.type !== 'Identifier' || path.node.callee.name !== 'eval') return
      if (path.scope.getBinding('eval')) return
      found = true
      path.stop()
    },
    MemberExpression(path) {
      if (found) return
      const property = path.node.property
      const propertyName = path.node.computed
        ? property?.type === 'StringLiteral'
          ? property.value
          : null
        : property?.type === 'Identifier'
          ? property.name
          : null
      if (propertyName !== name) return
      const object = path.node.object
      if (object?.type === 'Identifier' && GLOBAL_ALIASES.has(object.name)) {
        found = true
        path.stop()
      }
    },
  })
  return found
}

/**
 * @param {object} ast - parsed Program/File, mutated in place
 * @param {object} context
 * @param {object} context.types - `@babel/types`
 * @param {object} context.traverse - `@babel/traverse`
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const { types: t, traverse } = context
  const report = createReporter(context)
  /** @type {string[]} */
  const notes = []
  const records = collectStringArrays(t, traverse, ast)
  if (records.length === 0) return { changed: false, notes }

  const rotations = applyRotations(t, traverse, ast, records, notes, report)
  if (rotations > 0) refreshScopes(traverse, ast)
  const decoders = collectDecoders(t, traverse, ast, records)
  const usable = records.filter((record) => !record.poisoned)
  for (const record of usable) {
    if (!arrayIsReadOnly(record)) {
      record.poisoned = true
      notes.push(`kept ${record.name}: it is mutated or escapes as a value`)
    }
  }
  const decodersAfterCheck = decoders.filter((decoder) => !decoder.array.poisoned)

  const inlines = inlineAll(t, traverse, ast, records, decodersAfterCheck, notes, report)
  const removed = removeUnreferencedDeclarations(traverse, ast, records, decodersAfterCheck, notes, report)

  return {
    changed: rotations + inlines + removed > 0,
    notes,
  }
}
