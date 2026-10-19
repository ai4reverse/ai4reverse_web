/**
 * Restoration pass 35 — constant folding.
 *
 * A small, deliberately limited evaluator over primitive literals. It never
 * calls into the guest, never touches `eval`/`Function`, never coerces objects
 * and never reads a prototype: the only values it can produce are string,
 * number, boolean, null and undefined, computed with the ordinary JS operators.
 *
 * Folded operators:
 *   `+ - * / % ** << >> >>> & | ^ ~ ! typeof void == === != !== < <= > >=`
 *   `&& || ??` and the conditional (`?:`) operator, plus string concatenation.
 *
 * Safety rules enforced here:
 *  - operands that are not primitive literals (identifiers with bindings, calls,
 *    member access, templates with substitutions, bigints) abort the fold, so
 *    side effects and shadowed names are never lost;
 *  - `NaN`, `Infinity` and `-0` results are not materialised (there is no
 *    primitive literal for them, and `NaN`/`Infinity` are shadowable identifiers);
 *  - `undefined` is emitted as `void 0`, never as the shadowable identifier;
 *  - string results are length-capped and never placed in a directive slot;
 *  - a fixed point plus a hard iteration cap keeps the pass idempotent.
 *
 * @see docs/CONTRACTS.md — "Restoration pass contract"
 */

import { generateExpression } from '../generate.js'

/** Longest string this pass will materialise. */
const MAX_STRING_LENGTH = 100_000

/** Node-budget per candidate expression; keeps hostile trees from exploding. */
const EVALUATION_BUDGET = 512

/** Upper bound on traversal rounds (the pass reaches a fixed point in 2–3). */
const MAX_ROUNDS = 5

/** Shortest form used when a report entry quotes source text. */
const REPORT_TEXT_LIMIT = 120

/** Returned by {@link evaluate} when a node is not a foldable primitive. */
const NOT_FOLDABLE = Symbol('not-foldable')

const UNARY_OPERATORS = new Set(['+', '-', '!', '~', 'typeof', 'void'])

const BINARY_OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '<<',
  '>>',
  '>>>',
  '&',
  '|',
  '^',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
])

const LOGICAL_OPERATORS = new Set(['&&', '||', '??'])

export const meta = {
  id: 'constant-fold',
  order: 35,
  description: 'fold primitive constant expressions',
  idempotent: true,
}

/**
 * @param {import('@babel/core').types.Node} ast - mutated in place
 * @param {object} context
 * @param {object} context.types - @babel/types
 * @param {object} context.traverse - traverse function
 * @param {function} context.report - report(change) for the pass report
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const t = context.types
  const notes = []
  let changed = false

  /**
   * Fold one candidate node. Returns true when the tree was rewritten.
   *
   * @param {object} path
   * @returns {boolean}
   */
  const foldPath = (path) => {
    const node = path.node
    if (path.findParent?.((parent) => parent.isWithStatement?.())) {
      notes.push(`skipped ${safeExpressionText(node)}: inside a with statement`)
      return false
    }
    if (isAlreadyCanonical(node, t)) return false
    const source = safeExpressionText(node)
    try {
      const value = evaluate(node, { remaining: EVALUATION_BUDGET }, (name) => Boolean(path.scope?.getBinding(name)))
      if (value === NOT_FOLDABLE) return false
      const replacement = toLiteral(t, value)
      if (!replacement) return false
      if (typeof value === 'string' && isDirectiveSlot(path)) {
        notes.push(`skipped ${source}: result would become a directive`)
        return false
      }
      path.replaceWith(replacement)
      path.skip()
      changed = true
      context.report({
        pass: meta.id,
        rule: `${node.type}:${operatorOf(node)}`,
        from: truncate(source),
        to: truncate(safeExpressionText(replacement)),
      })
      return true
    } catch (error) {
      notes.push(`fold of ${source} failed: ${error.message}`)
      return false
    }
  }

  // Outer-first folding cannot see a fold that only its children create, so the
  // traversal repeats until nothing changes (capped for hostile inputs).
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changedThisRound = false
    const visit = (path) => {
      if (foldPath(path)) changedThisRound = true
    }
    context.traverse(ast, {
      UnaryExpression: visit,
      BinaryExpression: visit,
      LogicalExpression: visit,
      ConditionalExpression: visit,
    })
    if (!changedThisRound) break
  }

  return { changed, notes }
}

/**
 * Nodes that already have the shape this pass produces; folding them again
 * would report a change without changing anything.
 *
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {boolean}
 */
function isAlreadyCanonical(node, t) {
  if (!node) return true
  if (t.isUnaryExpression(node)) {
    if (node.operator === 'void' && t.isNumericLiteral(node.argument) && node.argument.value === 0) return true
    if (node.operator === '-' && t.isNumericLiteral(node.argument)) return true
  }
  return false
}

/**
 * Recursive evaluator. Returns a primitive value or {@link NOT_FOLDABLE}.
 *
 * @param {object} node
 * @param {{remaining: number}} budget
 * @param {(name: string) => boolean} isShadowed
 * @returns {string|number|boolean|null|undefined|symbol}
 */
function evaluate(node, budget, isShadowed) {
  if (!node || budget.remaining <= 0) return NOT_FOLDABLE
  budget.remaining -= 1

  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'Identifier':
      // `undefined` is a global, so only usable when nothing shadows it.
      return node.name === 'undefined' && !isShadowed('undefined') ? undefined : NOT_FOLDABLE
    case 'TemplateLiteral': {
      if (node.expressions.length > 0) return NOT_FOLDABLE
      return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
    }
    case 'UnaryExpression':
      return evaluateUnary(node, budget, isShadowed)
    case 'BinaryExpression':
      return evaluateBinary(node, budget, isShadowed)
    case 'LogicalExpression':
      return evaluateLogical(node, budget, isShadowed)
    case 'ConditionalExpression':
      return evaluateConditional(node, budget, isShadowed)
    default:
      return NOT_FOLDABLE
  }
}

/**
 * @param {object} node
 * @param {{remaining: number}} budget
 * @param {(name: string) => boolean} isShadowed
 * @returns {string|number|boolean|undefined|symbol}
 */
function evaluateUnary(node, budget, isShadowed) {
  if (!UNARY_OPERATORS.has(node.operator)) return NOT_FOLDABLE
  const argument = evaluate(node.argument, budget, isShadowed)
  if (argument === NOT_FOLDABLE) return NOT_FOLDABLE
  try {
    switch (node.operator) {
      case '+':
        return +argument
      case '-':
        return -argument
      case '!':
        return !argument
      case '~':
        return ~argument
      case 'typeof':
        return typeof argument
      case 'void':
        // The operand was a side-effect-free literal, so discarding it is fine.
        return undefined
      default:
        return NOT_FOLDABLE
    }
  } catch {
    return NOT_FOLDABLE
  }
}

/**
 * @param {object} node
 * @param {{remaining: number}} budget
 * @param {(name: string) => boolean} isShadowed
 * @returns {string|number|boolean|symbol}
 */
function evaluateBinary(node, budget, isShadowed) {
  if (!BINARY_OPERATORS.has(node.operator)) return NOT_FOLDABLE
  const left = evaluate(node.left, budget, isShadowed)
  if (left === NOT_FOLDABLE) return NOT_FOLDABLE
  const right = evaluate(node.right, budget, isShadowed)
  if (right === NOT_FOLDABLE) return NOT_FOLDABLE
  if (typeof left === 'string' && left.length > MAX_STRING_LENGTH) return NOT_FOLDABLE
  if (typeof right === 'string' && right.length > MAX_STRING_LENGTH) return NOT_FOLDABLE
  try {
    switch (node.operator) {
      case '+':
        return left + right
      case '-':
        return left - right
      case '*':
        return left * right
      case '/':
        return left / right
      case '%':
        return left % right
      case '**':
        return left ** right
      case '<<':
        return left << right
      case '>>':
        return left >> right
      case '>>>':
        return left >>> right
      case '&':
        return left & right
      case '|':
        return left | right
      case '^':
        return left ^ right
      case '==':
        // eslint-disable-next-line eqeqeq -- the operator being folded is `==`
        return left == right
      case '===':
        return left === right
      case '!=':
        // eslint-disable-next-line eqeqeq
        return left != right
      case '!==':
        return left !== right
      case '<':
        return left < right
      case '<=':
        return left <= right
      case '>':
        return left > right
      case '>=':
        return left >= right
      default:
        return NOT_FOLDABLE
    }
  } catch {
    return NOT_FOLDABLE
  }
}

/**
 * @param {object} node
 * @param {{remaining: number}} budget
 * @param {(name: string) => boolean} isShadowed
 * @returns {string|number|boolean|null|undefined|symbol}
 */
function evaluateLogical(node, budget, isShadowed) {
  if (!LOGICAL_OPERATORS.has(node.operator)) return NOT_FOLDABLE
  const left = evaluate(node.left, budget, isShadowed)
  if (left === NOT_FOLDABLE) return NOT_FOLDABLE
  if (node.operator === '&&') {
    if (!left) return left
    return evaluate(node.right, budget, isShadowed)
  }
  if (node.operator === '||') {
    if (left) return left
    return evaluate(node.right, budget, isShadowed)
  }
  if (left === null || left === undefined) return evaluate(node.right, budget, isShadowed)
  return left
}

/**
 * @param {object} node
 * @param {{remaining: number}} budget
 * @param {(name: string) => boolean} isShadowed
 * @returns {string|number|boolean|null|undefined|symbol}
 */
function evaluateConditional(node, budget, isShadowed) {
  const test = evaluate(node.test, budget, isShadowed)
  if (test === NOT_FOLDABLE) return NOT_FOLDABLE
  return evaluate(test ? node.consequent : node.alternate, budget, isShadowed)
}

/**
 * Convert a folded primitive into a node, or `null` when it must not be
 * materialised.
 *
 * @param {object} t - @babel/types
 * @param {string|number|boolean|null|undefined} value
 * @returns {object|null}
 */
function toLiteral(t, value) {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) return null
    return t.stringLiteral(value)
  }
  if (typeof value === 'number') {
    // NaN/Infinity have no literal spelling, and -0 must keep its sign.
    if (!Number.isFinite(value) || Object.is(value, -0)) return null
    return value < 0 ? t.unaryExpression('-', t.numericLiteral(-value)) : t.numericLiteral(value)
  }
  if (typeof value === 'boolean') return t.booleanLiteral(value)
  if (value === null) return t.nullLiteral()
  if (value === undefined) return t.unaryExpression('void', t.numericLiteral(0))
  return null
}

/**
 * @param {object} node
 * @returns {string}
 */
function operatorOf(node) {
  return node.operator ?? '?'
}

/**
 * True when the expression sits in a directive-prologue slot; a folded string
 * there could turn into a `'use strict'` (or other) directive.
 *
 * @param {object} path - expression NodePath
 * @returns {boolean}
 */
function isDirectiveSlot(path) {
  const statement = path.parentPath
  if (!statement || statement.node.type !== 'ExpressionStatement') return false
  if (statement.node.directive != null) return true
  const body = statement.parentPath?.node.body
  const index = Array.isArray(body) ? body.indexOf(statement.node) : -1
  if (index < 0) return false
  return body.slice(0, index).every(isPrologueEntry)
}

/**
 * One entry of a possible directive prologue: a parsed directive, or a bare
 * string-literal expression statement (the shape a fold would turn into one).
 *
 * @param {object} node
 * @returns {boolean}
 */
function isPrologueEntry(node) {
  if (node.type === 'Directive') return true
  return node.type === 'ExpressionStatement' && node.expression.type === 'StringLiteral'
}

/**
 * @param {object} node
 * @returns {string}
 */
function safeExpressionText(node) {
  try {
    return generateExpression(node)
  } catch {
    return node.type ?? 'unknown'
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const value = String(text)
  return value.length > REPORT_TEXT_LIMIT ? `${value.slice(0, REPORT_TEXT_LIMIT)}…` : value
}
