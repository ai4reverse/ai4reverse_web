/**
 * JSFuck recovery pass.
 *
 * JSFuck encodes strings and numbers with nothing but `[]`, `()`, `!`, `+`,
 * `{}` and member access. Evaluating those shapes statically removes the layer
 * without ever executing the sample: this pass implements a total, side-effect
 * free evaluator over the literals above, and leaves every node it cannot prove
 * to be a constant untouched.
 *
 * Deliberate limits (all keep the pass sound):
 * - no calls, `new`, spread, assignments or template expressions;
 * - member access is only index/`length` on strings and arrays, so
 *   `[]['filter']` (a function value) is never folded;
 * - only primitive results are written back, so an array/object literal is never
 *   replaced by its own copy.
 */

import { valueToNode, isDirectiveSlot, compareGeneratedText } from '../pass-context.js'

export const meta = {
  id: 'jsfuck',
  order: 55,
  description: 'statically evaluate JSFuck-shaped literals without executing code',
  idempotent: true,
}

/** Marker for the plain `{}` atom; never exposed as a value. */
const PLAIN_OBJECT = Object.freeze({ __plainObject: true })

/** Thrown when a node is outside the evaluable subset. */
const UNEVALUABLE = Symbol('unevaluable')

/** Guard against stack exhaustion on pathologically long concatenation chains. */
const MAX_EVALUATION_DEPTH = 8000

/** Node types worth evaluating at the top level (all may yield a primitive). */
const CANDIDATE_TYPES = new Set([
  'BinaryExpression',
  'MemberExpression',
  'ParenthesizedExpression',
  'SequenceExpression',
  'TemplateLiteral',
  'UnaryExpression',
])

/**
 * Convert a value to its primitive string form the way `+` does, without
 * invoking any prototype methods.
 *
 * @param {unknown} value
 * @returns {string}
 */
function toPrimitiveString(value) {
  if (Array.isArray(value)) {
    return value
      .map((element) => (element === null || element === undefined ? '' : toPrimitiveString(element)))
      .join('')
  }
  if (value === PLAIN_OBJECT) return '[object Object]'
  return String(value)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null) return 0
  if (value === undefined) return NaN
  if (typeof value === 'string') return Number(value)
  if (Array.isArray(value) || value === PLAIN_OBJECT) return Number(toPrimitiveString(value))
  throw UNEVALUABLE
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthy(value) {
  if (Array.isArray(value) || value === PLAIN_OBJECT) return true
  return Boolean(value)
}

/**
 * Property-key string conversion for member access.
 *
 * @param {unknown} key
 * @returns {string}
 */
function toPropertyKey(key) {
  if (typeof key === 'string') return key
  if (typeof key === 'number') return String(key)
  if (key === null) return 'null'
  if (key === undefined) return 'undefined'
  if (Array.isArray(key) || key === PLAIN_OBJECT) return toPrimitiveString(key)
  throw UNEVALUABLE
}

/**
 * Read a property of a string or array without touching the prototype chain.
 *
 * @param {object} t
 * @param {object} node
 * @param {number} depth
 * @returns {unknown}
 */
function readMember(t, node, depth) {
  const object = evaluateNode(t, node.object, depth + 1)
  const key = node.computed
    ? evaluateNode(t, node.property, depth + 1)
    : t.isIdentifier(node.property)
      ? node.property.name
      : null
  if (key === null) throw UNEVALUABLE
  if (Array.isArray(object)) {
    const name = toPropertyKey(key)
    if (name === 'length') return object.length
    if (name === '') return undefined
    if (!/^\d+$/.test(name)) throw UNEVALUABLE
    const index = Number(name)
    return index < object.length ? object[index] : undefined
  }
  if (typeof object === 'string') {
    const name = toPropertyKey(key)
    if (name === 'length') return object.length
    if (!/^\d+$/.test(name)) throw UNEVALUABLE
    const index = Number(name)
    return index < object.length ? object[index] : undefined
  }
  throw UNEVALUABLE
}

/**
 * @param {object} t
 * @param {object} node
 * @param {number} depth
 * @returns {unknown} primitive, array of evaluated values, or `PLAIN_OBJECT`
 */
function evaluateNode(t, node, depth) {
  if (!node || depth > MAX_EVALUATION_DEPTH) throw UNEVALUABLE
  evaluationBudget -= 1
  if (evaluationBudget < 0) throw UNEVALUABLE
  switch (node.type) {
    case 'StringLiteral':
      return node.value
    case 'NumericLiteral':
      return node.value
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'Identifier': {
      if (node.name === 'undefined') return undefined
      if (node.name === 'NaN') return NaN
      if (node.name === 'Infinity') return Infinity
      throw UNEVALUABLE
    }
    case 'ParenthesizedExpression':
      return evaluateNode(t, node.expression, depth + 1)
    case 'TemplateLiteral': {
      if (node.expressions.length > 0) throw UNEVALUABLE
      return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
    }
    case 'ArrayExpression': {
      const values = []
      for (const element of node.elements) {
        if (!element || t.isSpreadElement(element)) throw UNEVALUABLE
        values.push(evaluateNode(t, element, depth + 1))
      }
      return values
    }
    case 'ObjectExpression': {
      if (node.properties.length > 0) throw UNEVALUABLE
      return PLAIN_OBJECT
    }
    case 'SequenceExpression': {
      let result
      for (const expression of node.expressions) result = evaluateNode(t, expression, depth + 1)
      return result
    }
    case 'MemberExpression':
      return readMember(t, node, depth)
    case 'UnaryExpression': {
      const argument = evaluateNode(t, node.argument, depth + 1)
      switch (node.operator) {
        case '!':
          return !isTruthy(argument)
        case '+':
          return toNumber(argument)
        case '-':
          return -toNumber(argument)
        case '~':
          return ~toNumber(argument)
        default:
          throw UNEVALUABLE
      }
    }
    case 'BinaryExpression': {
      const left = evaluateNode(t, node.left, depth + 1)
      const right = evaluateNode(t, node.right, depth + 1)
      if (node.operator === '+') {
        const stringish =
          typeof left === 'string' ||
          typeof right === 'string' ||
          Array.isArray(left) ||
          Array.isArray(right) ||
          left === PLAIN_OBJECT ||
          right === PLAIN_OBJECT
        if (stringish) return toPrimitiveString(left) + toPrimitiveString(right)
        return left + right
      }
      const leftNumber = toNumber(left)
      const rightNumber = toNumber(right)
      switch (node.operator) {
        case '-':
          return leftNumber - rightNumber
        case '*':
          return leftNumber * rightNumber
        case '/':
          return leftNumber / rightNumber
        case '%':
          return leftNumber % rightNumber
        case '**':
          return leftNumber ** rightNumber
        default:
          throw UNEVALUABLE
      }
    }
    default:
      throw UNEVALUABLE
  }
}

/**
 * @param {object} t
 * @param {object} node
 * @returns {unknown} `UNEVALUABLE` when the node is outside the subset
 */
function evaluate(t, node) {
  try {
    return evaluateNode(t, node, 0)
  } catch (error) {
    // A RangeError means the chain outran the stack; leave the node untouched.
    if (error === UNEVALUABLE || error instanceof RangeError) return UNEVALUABLE
    throw error
  }
}

/**
 * @param {object} t
 * @param {unknown} value
 * @returns {object|null} literal node, or `null` when no faithful node exists
 */
function literalNode(t, value) {
  if (typeof value === 'number' && Object.is(value, -0)) return t.unaryExpression('-', t.numericLiteral(0))
  if (typeof value === 'bigint') return null
  if (typeof value === 'symbol' || (typeof value === 'object' && value !== null)) return null
  return valueToNode(value)
}

/**
 * `undefined`, `NaN` and `Infinity` are ordinary bindings in JS, so a folded
 * value may only be written back when the name still means the global.
 *
 * @param {object} t
 * @param {object} node
 * @param {object} scope
 * @returns {boolean}
 */
function referencesShadowedGlobal(t, node, scope) {
  let shadowed = false
  t.traverseFast(node, (child) => {
    if (!t.isIdentifier(child)) return
    if (!['undefined', 'NaN', 'Infinity'].includes(child.name)) return
    if (scope.hasBinding(child.name, true)) shadowed = true
  })
  return shadowed
}

/** @param {object} context */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/** Per-pass evaluation budget: a pathological `'a'+'a'+...` chain must not hang. */
const MAX_EVALUATION_STEPS = 20_000
let evaluationBudget = MAX_EVALUATION_STEPS

/**
 * Replacing an assignment/update/delete target would corrupt the AST (and the
 * original program's meaning): skip those positions.
 * @param {object} path
 */
function isMutationTarget(path) {
  const parent = path.parentPath
  if (!parent) return false
  const node = parent.node
  if (node.type === 'AssignmentExpression' && node.left === path.node) return true
  if (node.type === 'UpdateExpression' && node.argument === path.node) return true
  if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left === path.node) return true
  if (node.type === 'UnaryExpression' && node.operator === 'delete' && node.argument === path.node) return true
  return false
}

/**
 * @param {object} ast
 * @param {object} context
 * @param {object} context.types
 * @param {object} context.traverse
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const { types: t, traverse } = context
  evaluationBudget = MAX_EVALUATION_STEPS
  const report = createReporter(context)
  /** @type {string[]} */
  const notes = []
  let folded = 0

  traverse(ast, {
    enter(path) {
      if (!CANDIDATE_TYPES.has(path.node.type)) return
      if (!path.isExpression()) return
      // A tag consumes a TemplateLiteral (including raw text), not a string value.
      if (path.parentPath?.isTaggedTemplateExpression() && path.key === 'quasi') return
      if (isMutationTarget(path)) return
      if (isDirectiveSlot(path)) return
      // `undefined`, `NaN` and `Infinity` are ordinary bindings: evaluating an
      // expression that reads a shadowed one folds against global semantics,
      // and the resulting literal can carry no identifier for the replacement
      // check below to catch (`var NaN = 'x'; NaN + []` folds to the string
      // 'NaN').
      if (referencesShadowedGlobal(t, path.node, path.scope)) return
      const value = evaluate(t, path.node)
      if (value === UNEVALUABLE) return
      const replacement = literalNode(t, value)
      if (!replacement) return
      if (referencesShadowedGlobal(t, replacement, path.scope)) return
      // A candidate may evaluate to a node that prints exactly like it already
      // does (`-1` folds to `-1`): writing that back is not a change, and
      // reporting one would miss the pass's own fixed point (D5).
      const { from, to, changed } = compareGeneratedText(path.node, replacement)
      if (!changed) return
      report({ rule: 'jsfuck', from, to })
      path.replaceWith(replacement)
      path.skip()
      folded += 1
    },
  })

  if (folded > 0) notes.push(`evaluated ${folded} JSFuck expression${folded === 1 ? '' : 's'}`)
  return { changed: folded > 0, notes }
}
