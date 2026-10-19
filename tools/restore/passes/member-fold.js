/**
 * Restoration pass 40 — member/property folding.
 *
 * Folds property reads on literal containers and a small set of pure methods,
 * but only when the result is itself a primitive literal:
 *
 *   `'abc'['length']`            -> `3`
 *   `'abc'.length`               -> `3`
 *   `'abc'[0]`                   -> `'a'`
 *   `[1, 2, 3][1]`               -> `2`
 *   `{'a': 1}['a']`              -> `1`
 *   `'hello'.charCodeAt(1)`      -> numeric literal
 *   `'hello'.charAt(4)`          -> `'o'`
 *   `'hello'.indexOf('ll')`      -> `2`
 *   `'hello'.slice(1, 3)`        -> `'el'`
 *   `Math.max(3, 7)`             -> `7`
 *
 * Safety rules enforced here:
 *  - the container must be a *literal* array/object of primitive literals, so
 *    no evaluation order or side effect can be lost;
 *  - a key that is not an own property of a literal object is left alone (the
 *    prototype chain could supply it) and `__proto__` keys are never interpreted;
 *  - a member that is an assignment/delete/for-in target is left alone (folding
 *    would turn `'abc'[0] = 1` into invalid syntax);
 *  - `NaN`, `Infinity` and `-0` results are not materialised; `undefined`
 *    becomes `void 0` so no shadowable identifier is introduced;
 *  - `Math` must not be shadowed, and only pure `Math` functions with exact
 *    arity are folded — `Math.random` is never touched;
 *  - results in a directive-prologue slot are skipped;
 *  - a fixed point plus an iteration cap keeps the pass idempotent.
 *
 * @see docs/CONTRACTS.md — "Restoration pass contract"
 */

import { generateExpression } from '../generate.js'

/** Longest string this pass will materialise. */
const MAX_STRING_LENGTH = 100_000

/** Upper bound on traversal rounds (nested member chains need one per level). */
const MAX_ROUNDS = 5

/** Shortest form used when a report entry quotes source text. */
const REPORT_TEXT_LIMIT = 120

/** Returned when a node is not a literal container/value. */
const NOT_STATIC = Symbol('not-static')

/** String methods that are pure and return a primitive for literal arguments. */
const STRING_METHODS = new Set(['charAt', 'charCodeAt', 'indexOf', 'slice'])

/**
 * Pure `Math` functions mapped to their required arity. `null` means variadic;
 * `Math.random` and every non-numeric helper are deliberately absent.
 */
const PURE_MATH = new Map([
  ['abs', 1],
  ['acos', 1],
  ['acosh', 1],
  ['asin', 1],
  ['asinh', 1],
  ['atan', 1],
  ['atan2', 2],
  ['atanh', 1],
  ['cbrt', 1],
  ['ceil', 1],
  ['clz32', 1],
  ['cos', 1],
  ['cosh', 1],
  ['exp', 1],
  ['expm1', 1],
  ['floor', 1],
  ['fround', 1],
  ['hypot', null],
  ['imul', 2],
  ['log', 1],
  ['log10', 1],
  ['log1p', 1],
  ['log2', 1],
  ['max', null],
  ['min', null],
  ['pow', 2],
  ['round', 1],
  ['sign', 1],
  ['sin', 1],
  ['sinh', 1],
  ['sqrt', 1],
  ['tan', 1],
  ['tanh', 1],
  ['trunc', 1],
])

/** Array-index spelling accepted for computed access (`0`, `12`, not `01`). */
const INDEX_PATTERN = /^(?:0|[1-9]\d*)$/

export const meta = {
  id: 'member-fold',
  order: 40,
  description: 'fold literal member access and pure Math/string methods',
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
   * @param {object} path
   * @param {() => ({value: *, rule: string} | null)} fold
   */
  const foldAt = (path, fold) => {
    const before = path.node
    const source = safeExpressionText(before)
    try {
      if (isMutationTarget(path)) return
      const folded = fold()
      if (!folded) return
      const replacement = toLiteral(t, folded.value)
      if (!replacement) return
      if (typeof folded.value === 'string' && isDirectiveSlot(path)) {
        notes.push(`skipped ${source}: result would become a directive`)
        return
      }
      path.replaceWith(replacement)
      path.skip()
      changed = true
      context.report({
        pass: meta.id,
        rule: folded.rule,
        from: truncate(source),
        to: truncate(safeExpressionText(replacement)),
      })
    } catch (error) {
      notes.push(`fold of ${source} failed: ${error.message}`)
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changedThisRound = false
    context.traverse(ast, {
      MemberExpression: (path) => {
        const before = path.node
        foldAt(path, () => foldMemberAccess(path, t))
        if (path.node !== before) changedThisRound = true
      },
      CallExpression: (path) => {
        const before = path.node
        foldAt(path, () => foldCall(path, t))
        if (path.node !== before) changedThisRound = true
      },
    })
    if (!changedThisRound) break
  }

  return { changed, notes }
}

/**
 * Fold `container[key]` / `container.key` when the container is a literal.
 *
 * @param {object} path - MemberExpression path
 * @param {object} t - @babel/types
 * @returns {{value: *, rule: string} | null}
 */
function foldMemberAccess(path, t) {
  const node = path.node
  const container = staticValue(node.object, t)
  if (container === NOT_STATIC) return null
  const key = memberKey(node, t)
  if (key === undefined) return null

  if (typeof container === 'string' || Array.isArray(container)) {
    if (key === 'length') return { value: container.length, rule: 'length' }
    const index = readIndex(key)
    if (index === undefined) return null
    // Out-of-range indices are genuinely `undefined` for strings and arrays
    // (neither prototype defines numeric properties).
    return { value: container[index], rule: 'index' }
  }

  if (typeof container === 'object' && container !== null) {
    const property = typeof key === 'number' ? String(key) : key
    if (!Object.hasOwn(container, property)) return null
    return { value: container[property], rule: 'property' }
  }

  return null
}

/**
 * Fold pure string methods on literal receivers and pure `Math` calls.
 *
 * @param {object} path - CallExpression path
 * @param {object} t - @babel/types
 * @returns {{value: *, rule: string} | null}
 */
function foldCall(path, t) {
  const node = path.node
  const callee = node.callee
  if (!t.isMemberExpression(callee)) return null
  const name = memberName(callee, t)
  if (!name) return null

  if (t.isIdentifier(callee.object) && callee.object.name === 'Math') {
    if (isShadowed(path, 'Math')) return null
    if (!PURE_MATH.has(name)) return null
    const arity = PURE_MATH.get(name)
    if (arity !== null && node.arguments.length !== arity) return null
    const args = []
    for (const argument of node.arguments) {
      const value = primitiveValue(argument, t)
      if (typeof value !== 'number') return null
      args.push(value)
    }
    return finiteNumber(fnResult(() => Math[name](...args)), `Math.${name}`)
  }

  if (STRING_METHODS.has(name)) {
    const receiver = primitiveValue(callee.object, t)
    if (typeof receiver !== 'string') return null
    const args = []
    for (const argument of node.arguments) {
      const value = primitiveValue(argument, t)
      if (value === NOT_STATIC || value === null) return null
      args.push(value)
    }
    const result = fnResult(() => String.prototype[name].apply(receiver, args))
    if (result === NOT_STATIC) return null
    if (typeof result === 'string') {
      if (result.length > MAX_STRING_LENGTH) return null
      return { value: result, rule: `String.prototype.${name}` }
    }
    return finiteNumber(result, `String.prototype.${name}`)
  }

  return null
}

/**
 * Enforce the numeric guards shared by every fold that can produce a number.
 *
 * @param {*} value
 * @param {string} rule
 * @returns {{value: number, rule: string} | null}
 */
function finiteNumber(value, rule) {
  if (typeof value !== 'number') return null
  // NaN/Infinity have no literal spelling, and -0 must keep its sign.
  if (!Number.isFinite(value) || Object.is(value, -0)) return null
  return { value, rule }
}

/**
 * Run a computation, reporting failure as "not foldable" instead of throwing.
 *
 * @param {() => *} compute
 * @returns {*}
 */
function fnResult(compute) {
  try {
    return compute()
  } catch {
    return NOT_STATIC
  }
}

/**
 * Read a literal container: array or object expression whose every entry is a
 * primitive literal.
 *
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {string|number|boolean|Array|object|symbol}
 */
function staticValue(node, t) {
  const primitive = primitiveValue(node, t)
  if (primitive !== NOT_STATIC) return primitive

  if (t.isArrayExpression(node)) {
    const items = []
    for (const element of node.elements) {
      const value = primitiveValue(element, t)
      if (value === NOT_STATIC) return NOT_STATIC
      items.push(value)
    }
    return items
  }

  if (t.isObjectExpression(node)) {
    const object = {}
    for (const property of node.properties) {
      if (!t.isObjectProperty(property) || property.computed || property.method) return NOT_STATIC
      const key = propertyKey(property.key, t)
      // `{'__proto__': x}` sets the prototype instead of creating a property.
      if (key === undefined || key === '__proto__') return NOT_STATIC
      const value = primitiveValue(property.value, t)
      if (value === NOT_STATIC) return NOT_STATIC
      object[key] = value
    }
    return object
  }

  return NOT_STATIC
}

/**
 * Read a primitive literal (`null` included). `undefined` is deliberately not
 * accepted: the identifier can be shadowed.
 *
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {string|number|boolean|null|symbol}
 */
function primitiveValue(node, t) {
  if (!node) return NOT_STATIC
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value
  if (t.isNullLiteral(node)) return null
  if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
    return -node.argument.value
  }
  return NOT_STATIC
}

/**
 * Key of an object literal property, or `undefined` when it is not static.
 *
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {string | undefined}
 */
function propertyKey(node, t) {
  if (t.isIdentifier(node)) return node.name
  if (t.isStringLiteral(node)) return node.value
  if (t.isNumericLiteral(node)) return String(node.value)
  return undefined
}

/**
 * Key of a member access, for both `a.b` and `a['b']` spellings.
 *
 * @param {object} node - MemberExpression
 * @param {object} t - @babel/types
 * @returns {string|number|undefined}
 */
function memberKey(node, t) {
  if (!node.computed) return t.isIdentifier(node.property) ? node.property.name : undefined
  const property = node.property
  if (t.isStringLiteral(property)) return property.value
  if (t.isNumericLiteral(property)) return property.value
  if (t.isUnaryExpression(property) && property.operator === '-' && t.isNumericLiteral(property.argument)) {
    return -property.argument.value
  }
  return undefined
}

/**
 * Property name of a member expression, for both `a.b` and `a['b']` spellings.
 *
 * @param {object} node - MemberExpression
 * @param {object} t - @babel/types
 * @returns {string | undefined}
 */
function memberName(node, t) {
  if (!node.computed) return t.isIdentifier(node.property) ? node.property.name : undefined
  if (t.isStringLiteral(node.property)) return node.property.value
  if (t.isNumericLiteral(node.property)) return String(node.property.value)
  return undefined
}

/**
 * Normalise an accepted array-index spelling to a number.
 *
 * @param {string|number} key
 * @returns {number | undefined}
 */
function readIndex(key) {
  if (typeof key === 'number') return Number.isInteger(key) && key >= 0 ? key : undefined
  if (typeof key === 'string' && INDEX_PATTERN.test(key)) return Number(key)
  return undefined
}

/**
 * True when the member is written to or deleted; folding it would produce
 * invalid assignment syntax or hide the write.
 *
 * @param {object} path - MemberExpression path
 * @returns {boolean}
 */
function isMutationTarget(path) {
  const parent = path.parentPath
  if (!parent) return false
  if (parent.isAssignmentExpression() && parent.node.left === path.node) return true
  if (parent.isUpdateExpression()) return true
  if ((parent.isForInStatement() || parent.isForOfStatement()) && parent.node.left === path.node) return true
  if (parent.isUnaryExpression({ operator: 'delete' })) return true
  return false
}

/**
 * True when `name` is bound in the surrounding program, i.e. the code redefines
 * a global we would otherwise fold.
 *
 * @param {object} path - NodePath with a `scope`
 * @param {string} name
 * @returns {boolean}
 */
function isShadowed(path, name) {
  if (path && typeof path.findParent === 'function' && path.findParent((parent) => parent.isWithStatement?.())) return true
  return Boolean(path.scope?.getBinding(name))
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
