/**
 * Restoration pass 30 — literal string decoding.
 *
 * Two kinds of work, both semantics-preserving:
 *
 *  1. Canonicalise the raw text of string literals written with escapes
 *     (`'\x41'`, `'\u0041'`, `'\u{1F600}'`, `'\101'`, `'it\'s'`). The parser
 *     already cooked those values, so "decoding" means dropping the original
 *     raw text and letting the generator re-escape it. Documented obfuscation
 *     therefore disappears from the restored source.
 *  2. Materialise strings that are built by evaluation-only idioms:
 *     `'a' + 'b'` chains, `String.fromCharCode(72, 105)`,
 *     `String.fromCharCode.apply(null, [72, 105])`, `decodeURIComponent` /
 *     `unescape` / `atob` on a literal, and
 *     `[104, 105].map(c => String.fromCharCode(c)).join('')`.
 *
 * Safety rules enforced here:
 *  - a literal containing an unpaired surrogate stays escaped (re-emitting it
 *    can mangle the output encoding);
 *  - a string literal in a directive-prologue slot is never rewritten, because
 *    `'use strict'` written with escapes is *not* a Use Strict Directive and
 *    turning it into one would switch the whole body into strict mode;
 *  - a global (`String`, `atob`, `unescape`, `decodeURIComponent`) that is
 *    shadowed by a binding in scope is not folded;
 *  - every decoder runs inside try/catch; failures become notes, never a throw;
 *  - huge results are left alone.
 *
 * @see docs/CONTRACTS.md — "Restoration pass contract"
 */

import { generateExpression } from '../generate.js'

/** Longest string this pass will materialise (guards hostile inputs). */
const MAX_STRING_LENGTH = 100_000

/** Entry cap for the value→generated-text memo; hostile inputs cannot grow it forever. */
const PLAIN_TEXT_CACHE_LIMIT = 4096

/** Generated text of a plain string literal, memoized by its value. */
const plainTextCache = new Map()

/** Shortest form used when a report entry quotes source text. */
const REPORT_TEXT_LIMIT = 120

/** Global-object prefixes accepted for decoder calls (`window.atob(...)`). */
const GLOBAL_HOSTS = new Set(['window', 'globalThis', 'self'])

/**
 * Global functions that are pure for a literal argument and return a string.
 * Applied through the real function so the result is exactly what the guest
 * would have computed (including failures).
 */
const LITERAL_DECODERS = Object.freeze({
  decodeURIComponent,
  unescape,
  atob,
})

export const meta = {
  id: 'strings',
  order: 30,
  description: 'decode escape sequences and encoded string literals',
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

  /** @param {string} rule @param {string} from @param {string} to */
  const report = (rule, from, to) =>
    context.report({
      pass: meta.id,
      rule,
      from: truncate(from),
      to: truncate(to),
    })

  /** @param {string} message */
  const note = (message) => {
    notes.push(message)
  }

  // 1. Canonical escaping + decoding of literal-built strings.
  context.traverse(ast, {
    StringLiteral: (path) => {
      try {
        normaliseEscapes(path, note, report, () => {
          changed = true
        })
      } catch (error) {
        note(`escape normalisation failed: ${error.message}`)
      }
    },
    CallExpression: (path) => {
      try {
        const decoded = decodeCall(path, t)
        if (!decoded) return
        if (decoded.value.length > MAX_STRING_LENGTH) {
          note(`${decoded.rule}: result too large, left untouched`)
          return
        }
        if (isDirectiveSlot(path)) {
          note(`${decoded.rule}: would create a directive, left untouched`)
          return
        }
        path.replaceWith(stringLiteral(t, decoded.value))
        path.skip()
        changed = true
        report(decoded.rule, decoded.source, decoded.value)
      } catch (error) {
        note(`decoder failed: ${error.message}`)
      }
    },
  })

  // 2. Fold `'a' + 'b'` chains. Exit visitors so nested chains fold first and a
  //    single traversal reaches the outermost literal.
  context.traverse(ast, {
    BinaryExpression: {
      exit: (path) => {
        try {
          const node = path.node
          if (node.operator !== '+') return
          if (!t.isStringLiteral(node.left) || !t.isStringLiteral(node.right)) return
          const value = node.left.value + node.right.value
          if (value.length > MAX_STRING_LENGTH) {
            note('string concatenation result too large, left untouched')
            return
          }
          if (isDirectiveSlot(path)) {
            note('string concatenation in a directive slot, left untouched')
            return
          }
          path.replaceWith(stringLiteral(t, value))
          path.skip()
          changed = true
          report("'+' chain", `${node.left.value}+${node.right.value}`, value)
        } catch (error) {
          note(`string concatenation failed: ${error.message}`)
        }
      },
    },
  })

  return { changed, notes }
}

/**
 * Replace a literal's original raw text (which encodes the escapes) with the
 * plain cooked value so the shared generator applies its own escaping.
 *
 * A re-parse re-attaches `extra.raw` to every literal that still needs a
 * backslash (`'a\nb'` keeps one), so the guard has to be the generated text and
 * not the presence of an escape: clearing `extra.raw` is only a change when the
 * generator writes something different (D5 — a fixed point must report
 * `changed: false`).
 *
 * @param {object} path - StringLiteral path
 * @param {(message: string) => void} note
 * @param {(rule: string, from: string, to: string) => void} report
 * @param {() => void} markChanged
 */
function normaliseEscapes(path, note, report, markChanged) {
  const node = path.node
  const raw = node.extra?.raw
  if (typeof raw !== 'string' || !raw.includes('\\')) return
  if (hasLoneSurrogate(node.value)) {
    note(`kept escaped lone surrogate (${JSON.stringify(raw.slice(0, REPORT_TEXT_LIMIT))})`)
    return
  }
  if (isDirectiveSlot(path)) {
    note('kept escapes in a directive slot (rewriting would change strictness)')
    return
  }
  if (node.value.length > MAX_STRING_LENGTH) {
    note('string literal too large to decode, left untouched')
    return
  }
  // Dropping the raw text makes the generator emit exactly the plain literal,
  // so comparing against that text is the text-change test. Both sides are
  // memoized (per node and per value) and the node itself is rewritten right
  // after, so this is the only generation an unchanged literal costs per round.
  if (generateExpression(node) === plainStringText(node.value)) return
  node.extra = { rawValue: node.value }
  markChanged()
  report('string-escape', raw, node.value)
}

/**
 * Text the shared generator emits for a plain string literal. Depends only on
 * the value, so it is memoized by value instead of regenerating a throwaway
 * node for every escaped literal on every round.
 *
 * @param {string} value
 * @returns {string}
 */
function plainStringText(value) {
  const cached = plainTextCache.get(value)
  if (cached !== undefined) return cached
  const text = generateExpression({ type: 'StringLiteral', value })
  if (plainTextCache.size >= PLAIN_TEXT_CACHE_LIMIT) plainTextCache.clear()
  plainTextCache.set(value, text)
  return text
}

/**
 * Recognise the literal-built string idioms. Called inside a try/catch by the
 * caller; returns `null` when the node is not one of them.
 *
 * @param {object} path - CallExpression path
 * @param {object} t - @babel/types
 * @returns {{rule: string, value: string, source: string} | null}
 */
function decodeCall(path, t) {
  const node = path.node
  const callee = node.callee

  if (t.isMemberExpression(callee)) {
    const name = memberName(callee, t)

    // String.fromCharCode(<ints...>)
    if (name === 'fromCharCode' && isNamed(callee.object, 'String', t)) {
      if (isShadowed(path, 'String')) return null
      const units = readNumberList(node.arguments, t)
      if (!units) return null
      return { rule: 'String.fromCharCode', value: String.fromCharCode(...units), source: 'String.fromCharCode' }
    }

    // String.fromCharCode.apply(<null|undefined>, [<ints...>])
    if (name === 'apply' && t.isMemberExpression(callee.object) && isStringFromCharCode(callee.object, t)) {
      if (isShadowed(path, 'String')) return null
      const [thisArg, list] = node.arguments
      if (!isNullishLiteral(thisArg, t)) return null
      if (!t.isArrayExpression(list)) return null
      const units = readNumberList(list.elements, t)
      if (!units) return null
      return {
        rule: 'String.fromCharCode.apply',
        value: String.fromCharCode(...units),
        source: 'String.fromCharCode.apply',
      }
    }

    // [<ints...>].map(c => String.fromCharCode(c)).join('')
    if (name === 'join') {
      const mapped = decodeCharCodeMap(callee.object, node.arguments, path, t)
      if (!mapped) return null
      return { rule: 'charCode map/join', value: mapped, source: '[…].map(String.fromCharCode).join' }
    }
  }

  return decodeGlobalCall(path, node, t)
}

/**
 * `atob('…')`, `unescape('…')`, `decodeURIComponent('…')` and the same three
 * reached through a `window`/`globalThis`/`self` prefix.
 *
 * @param {object} path - CallExpression path
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {{rule: string, value: string, source: string} | null}
 */
function decodeGlobalCall(path, node, t) {
  const callee = node.callee
  let name = null
  if (t.isIdentifier(callee)) {
    name = callee.name
  } else if (t.isMemberExpression(callee)) {
    const host = callee.object
    if (isGlobalHost(path, host, t)) name = memberName(callee, t)
  }
  if (!name || !Object.hasOwn(LITERAL_DECODERS, name)) return null
  if (isShadowed(path, name)) return null
  if (node.arguments.length !== 1) return null
  const [argument] = node.arguments
  if (!t.isStringLiteral(argument)) return null
  const decode = LITERAL_DECODERS[name]
  const value = decode(argument.value)
  if (typeof value !== 'string') return null
  return { rule: name, value, source: `${name}(…)` }
}

/**
 * Decode `[104, 105].map(c => String.fromCharCode(c)).join('')`.
 *
 * @param {object} mapCall - the object of `.join(...)`
 * @param {object[]} joinArgs - arguments of `.join(...)`
 * @param {object} path - outer CallExpression path (for scope checks)
 * @param {object} t - @babel/types
 * @returns {string | null}
 */
function decodeCharCodeMap(mapCall, joinArgs, path, t) {
  if (!t.isCallExpression(mapCall)) return null
  if (!t.isMemberExpression(mapCall.callee) || memberName(mapCall.callee, t) !== 'map') return null
  const source = mapCall.callee.object
  if (!t.isArrayExpression(source)) return null
  const units = readNumberList(source.elements, t)
  if (!units) return null
  // `Array.prototype.join()` defaults to ',' — only an explicit empty
  // separator reproduces the folded string.
  if (joinArgs.length !== 1) return null
  if (!(t.isStringLiteral(joinArgs[0]) && joinArgs[0].value === '')) return null
  const [callback] = mapCall.arguments
  if (!callback) return null
  const param = firstParameterName(callback, t)
  if (!param) return null
  const body = functionBodyExpression(callback, t)
  if (!body) return null
  if (!t.isCallExpression(body) || !t.isMemberExpression(body.callee)) return null
  if (!isStringFromCharCode(body.callee, t)) return null
  if (isShadowed(path, 'String')) return null
  const [argument] = body.arguments
  if (!t.isIdentifier(argument) || argument.name !== param) return null
  return String.fromCharCode(...units)
}

/**
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {boolean}
 */
function isStringFromCharCode(node, t) {
  return (
    t.isMemberExpression(node) && memberName(node, t) === 'fromCharCode' && isNamed(node.object, 'String', t)
  )
}

/**
 * @param {object[]} list - argument or element nodes
 * @param {object} t - @babel/types
 * @returns {number[] | null} `null` when any entry is not a literal number
 */
function readNumberList(list, t) {
  if (!Array.isArray(list) || list.length === 0) return null
  const numbers = []
  for (const item of list) {
    const value = readNumber(item, t)
    if (value === undefined) return null
    numbers.push(value)
  }
  return numbers
}

/**
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {number | undefined}
 */
function readNumber(node, t) {
  if (!node) return undefined
  if (t.isNumericLiteral(node)) return node.value
  if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
    return -node.argument.value
  }
  return undefined
}

/**
 * True when `node` names a global object the script has not redefined, so a call
 * through it really reaches the built-in decoder.
 *
 * @param {object} path - NodePath with a `scope`
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {boolean}
 */
function isGlobalHost(path, node, t) {
  return t.isIdentifier(node) && GLOBAL_HOSTS.has(node.name) && !isShadowed(path, node.name)
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
 * @param {object} node
 * @param {string} name
 * @param {object} t - @babel/types
 * @returns {boolean}
 */
function isNamed(node, name, t) {
  return t.isIdentifier(node) && node.name === name
}

/**
 * @param {object} node
 * @param {object} t - @babel/types
 * @returns {boolean}
 */
function isNullishLiteral(node, t) {
  if (!node) return false
  if (t.isNullLiteral(node)) return true
  return t.isIdentifier(node) && node.name === 'undefined'
}

/**
 * Name of the single parameter of an inline callback.
 *
 * @param {object} fn - ArrowFunctionExpression | FunctionExpression
 * @param {object} t - @babel/types
 * @returns {string | undefined}
 */
function firstParameterName(fn, t) {
  if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) return undefined
  if (fn.params.length !== 1) return undefined
  const [param] = fn.params
  return t.isIdentifier(param) ? param.name : undefined
}

/**
 * The single expression an inline callback returns, or `undefined` when the
 * body is something more complex (which we never rewrite).
 *
 * @param {object} fn - ArrowFunctionExpression | FunctionExpression
 * @param {object} t - @babel/types
 * @returns {object | undefined}
 */
function functionBodyExpression(fn, t) {
  if (t.isArrowFunctionExpression(fn) && !t.isBlockStatement(fn.body)) return fn.body
  if (!t.isBlockStatement(fn.body) || fn.body.body.length !== 1) return undefined
  const [statement] = fn.body.body
  if (!t.isReturnStatement(statement)) return undefined
  return statement.argument ?? undefined
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
  // `with` makes every static scope lookup unreliable.
  if (path && typeof path.findParent === 'function' && path.findParent((parent) => parent.isWithStatement?.())) return true
  return Boolean(path.scope?.getBinding(name))
}

/**
 * True when the expression sits in a directive-prologue slot. Rewriting such an
 * expression into a plain string literal can create a `'use strict'` directive
 * (or any other directive) and change how the enclosing body is parsed.
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
 * True when the string contains an unpaired UTF-16 surrogate, which must stay
 * escaped in generated source.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
      return true
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

/**
 * Build a string literal that always regenerates from its value.
 *
 * @param {object} t - @babel/types
 * @param {string} value
 * @returns {object}
 */
function stringLiteral(t, value) {
  const node = t.stringLiteral(value)
  node.extra = { rawValue: value }
  return node
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const value = String(text)
  return value.length > REPORT_TEXT_LIMIT ? `${value.slice(0, REPORT_TEXT_LIMIT)}…` : value
}
