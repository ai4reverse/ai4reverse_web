/**
 * Proxy unwrapping pass.
 *
 * Malware hides real values behind single-use wrappers: identity functions,
 * one-element arrays, arrow aliases, comma expressions with a literal head,
 * `void 0`, and IIFEs that only return an expression. Removing those wrappers
 * exposes the value the rest of the pipeline has to reason about.
 *
 * Every rewrite is a local, semantics-preserving substitution: an identity
 * wrapper evaluates its argument exactly once and reads a fixed property chain,
 * `[fn][0]` only evaluates `fn`, comma heads are literals (no side effects), and
 * a single-expression IIFE is only unwrapped when it declares nothing and
 * references no `this`, `arguments`, `super`, `new.target` or its own name.
 */

import { generateExpression } from '../generate.js'
import { isDirectiveSlot } from '../pass-context.js'

export const meta = {
  id: 'proxy-unwrap',
  order: 60,
  description: 'unwrap identity proxies, single-element arrays, comma wrappers, void 0 and expression IIFEs',
  idempotent: true,
}

/** Wrappers can nest; unwrap until a full traversal changes nothing. */
const MAX_UNWRAP_ROUNDS = 16

/** @param {object} context */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/**
 * @param {object} t
 * @param {object} functionNode
 * @returns {object|null} the single returned expression, if the body is one
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
 * Rebuild `expression` with `paramName` replaced by `value`.
 * Only identifier / literal-key member chains are accepted.
 *
 * @param {object} t
 * @param {object} expression
 * @param {string} paramName
 * @param {object} value
 * @returns {object|null}
 */
function substituteParam(t, expression, paramName, value) {
  if (t.isIdentifier(expression)) {
    return expression.name === paramName ? t.cloneNode(value, true) : null
  }
  if (t.isMemberExpression(expression)) {
    if (expression.computed && !t.isLiteral(expression.property)) return null
    const object = substituteParam(t, expression.object, paramName, value)
    if (!object) return null
    return t.memberExpression(object, expression.property, expression.computed)
  }
  return null
}

/**
 * @param {object} t
 * @param {object} expression
 * @returns {boolean} true when `expression` mentions a value only an inner scope owns
 */
function referencesInnerScope(t, expression) {
  let found = false
  t.traverseFast(expression, (node) => {
    if (
      t.isThisExpression(node) ||
      t.isSuper(node) ||
      t.isMetaProperty(node) ||
      t.isYieldExpression(node) ||
      t.isAwaitExpression(node) ||
      (t.isIdentifier(node, { name: 'arguments' }))
    ) {
      found = true
    }
  })
  return found
}

/**
 * Rewrite `(function(a){return a.b})(x)` into `x.b`.
 *
 * @param {object} t
 * @param {object} callee
 * @param {object[]} args
 * @returns {object|null}
 */
function unwrapIdentityProxy(t, callee, args) {
  if (callee.params.length !== 1) return null
  const param = callee.params[0]
  if (!t.isIdentifier(param)) return null
  if (args.length !== 1 || t.isSpreadElement(args[0])) return null
  const expression = singleReturnedExpression(t, callee)
  if (!expression) return null
  if (referencesInnerScope(t, expression)) return null
  return substituteParam(t, expression, param.name, args[0])
}

/**
 * Rewrite `(function(){return expr})()` into `expr` when the body owns no scope.
 *
 * @param {object} t
 * @param {object} callee
 * @param {object[]} args
 * @returns {object|null}
 */
function unwrapExpressionIife(t, callee, args) {
  if (args.length !== 0) return null
  if (callee.params.length !== 0) return null
  if (callee.id) return null
  const expression = singleReturnedExpression(t, callee)
  if (!expression) return null
  if (referencesInnerScope(t, expression)) return null
  return expression
}

/**
 * @param {object} t
 * @param {object} node
 * @returns {boolean} true when the expression is a literal with no effects
 */
function isDiscardableLiteral(t, node) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) {
    return true
  }
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return true
  if (t.isBigIntLiteral(node)) return true
  return false
}

/**
 * Calling a member expression binds `this` to its object, so a rewrite must not
 * turn a plain call target into a member expression in call position.
 *
 * @param {object} t
 * @param {object} path
 * @param {object} replacement
 * @returns {boolean}
 */
function wouldRebindThis(t, path, replacement) {
  const parent = path.parentPath
  if (!parent) return false
  const callsNode =
    parent.isCallExpression() || parent.isOptionalCallExpression() || parent.isTaggedTemplateExpression()
  if (!callsNode || parent.node.callee !== path.node) return false
  return t.isMemberExpression(replacement) || t.isOptionalMemberExpression(replacement)
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
  const report = createReporter(context)
  /** @type {string[]} */
  const notes = []
  let unwrapped = 0

  for (let round = 0; round < MAX_UNWRAP_ROUNDS; round += 1) {
    let roundCount = 0
    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee
        const args = path.node.arguments

        if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
          const identity = unwrapIdentityProxy(t, callee, args)
          const replacement = identity ?? unwrapExpressionIife(t, callee, args)
          if (!replacement || wouldRebindThis(t, path, replacement)) return
          report({
            rule: identity ? 'identity-proxy' : 'expression-iife',
            from: generateExpression(path.node),
            to: generateExpression(replacement),
          })
          path.replaceWith(replacement)
          path.skip()
          roundCount += 1
          return
        }

        // `[fn][0](x)` evaluates `fn` once and calls it; so does `fn(x)`.
        if (
          t.isMemberExpression(callee) &&
          t.isArrayExpression(callee.object) &&
          callee.object.elements.length === 1 &&
          callee.object.elements[0] &&
          !t.isSpreadElement(callee.object.elements[0])
        ) {
          const index = callee.computed && t.isNumericLiteral(callee.property) ? callee.property.value : null
          if (index !== 0) return
          const element = callee.object.elements[0]
          const replacement = t.callExpression(element, args)
          // `[obj.method][0]()` calls with `this === undefined`; `obj.method()` does not.
          if (t.isMemberExpression(element) || t.isOptionalMemberExpression(element)) return
          report({
            rule: 'single-element-array',
            from: generateExpression(path.node),
            to: generateExpression(replacement),
          })
          path.replaceWith(replacement)
          path.skip()
          roundCount += 1
        }
      },

      UnaryExpression(path) {
        if (path.node.operator !== 'void') return
        if (!t.isPureish(path.node.argument)) return
        if (path.scope.hasBinding('undefined', true)) return
        report({ rule: 'void-0', from: generateExpression(path.node), to: 'undefined' })
        path.replaceWith(t.identifier('undefined'))
        path.skip()
        roundCount += 1
      },

      SequenceExpression(path) {
        const kept = path.node.expressions.filter((expression) => !isDiscardableLiteral(t, expression))
        if (kept.length === path.node.expressions.length) return
        const replacement =
          kept.length === 0
            ? path.node.expressions[path.node.expressions.length - 1]
            : kept.length === 1
              ? kept[0]
              : t.sequenceExpression(kept)
        if (wouldRebindThis(t, path, replacement)) return
        if (isDirectiveSlot(path)) return
        report({ rule: 'sequence-head', from: generateExpression(path.node), to: generateExpression(replacement) })
        path.replaceWith(replacement)
        path.skip()
        roundCount += 1
      },
    })
    unwrapped += roundCount
    if (roundCount === 0) break
  }

  if (unwrapped > 0) notes.push(`unwrapped ${unwrapped} proxy expression${unwrapped === 1 ? '' : 's'}`)
  return { changed: unwrapped > 0, notes }
}
