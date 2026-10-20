import { generate as babelGenerate } from '@babel/generator'
import * as t from '@babel/types'

/**
 * Single generate() wrapper used by every pass and by the CLI. Keeping one
 * implementation is what makes "统一的解析、转换、生成" (unified parse /
 * transform / generate) real rather than aspirational: output formatting,
 * escape handling and comment policy are all decided here.
 */

export const DEFAULT_GENERATE_OPTIONS = Object.freeze({
  comments: true,
  compact: false,
  concise: false,
  decoratorsBeforeExport: true,
  jsescOption: {
    minimal: true,
    quotes: 'single',
    numbers: 'decimal',
  },
  retainLines: false,
  minified: false,
})

/**
 * @param {object} ast Babel AST (File or Program)
 * @param {string} [code] original source (for source maps)
 * @param {object} [options]
 * @returns {{code: string, map: object|null, rawMappings?: unknown}}
 */
export function generate(ast, code = '', options = {}) {
  const merged = {
    ...DEFAULT_GENERATE_OPTIONS,
    ...options,
    jsescOption: { ...DEFAULT_GENERATE_OPTIONS.jsescOption, ...(options.jsescOption ?? {}) },
  }
  const result = babelGenerate(ast, merged, code)
  return {
    code: result.code,
    map: result.map && Object.keys(result.map).length > 0 ? result.map : null,
    rawMappings: result.rawMappings,
  }
}

/**
 * Memo for {@link generateExpression}, keyed on the node itself. Passes ask for
 * the same node's text again on later pipeline rounds, so a hit skips the Babel
 * generator entirely.
 *
 * ASTs are rewritten in place (strings.js drops `extra.raw`, passes replace
 * descendant nodes), so a hit is only served when a cheap structural
 * fingerprint of the subtree still matches the one recorded with the text —
 * a plain forever-cache would serve stale text after those rewrites.
 */
const expressionTextCache = new WeakMap()

/** Node fields that never reach generated text. */
const TEXT_IRRELEVANT_KEYS = new Set([
  'start',
  'end',
  'loc',
  'range',
  'leadingComments',
  'trailingComments',
  'innerComments',
])

/** FNV-1a offset basis. */
const FNV_OFFSET = 0x811c9dc5

/** FNV-1a prime. */
const FNV_PRIME = 0x01000193

/**
 * @param {number} hash
 * @param {string} text
 * @returns {number}
 */
function mixText(hash, text) {
  let mixed = hash
  for (let index = 0; index < text.length; index += 1) {
    mixed ^= text.charCodeAt(index)
    mixed = Math.imul(mixed, FNV_PRIME) >>> 0
  }
  return mixed
}

/**
 * Fingerprint of everything in a subtree that can change generated text:
 * node types, own property names, primitive values and child structure.
 * Position/comment fields are skipped because the expression helper never
 * prints them.
 *
 * @param {object} node
 * @param {number} [hash]
 * @returns {number}
 */
function subtreeFingerprint(node, hash = FNV_OFFSET) {
  let mixed = mixText(hash, `(${node.type}`)
  for (const key of Object.keys(node)) {
    if (TEXT_IRRELEVANT_KEYS.has(key)) continue
    mixed = mixText(mixed, `|${key}:`)
    const value = node[key]
    mixed = Array.isArray(value) ? mixText(mixed, `[${value.length}]`) : mixValue(mixed, value)
  }
  return mixText(mixed, ')')
}

/**
 * @param {number} hash
 * @param {*} value
 * @returns {number}
 */
function mixValue(hash, value) {
  if (value === null) return mixText(hash, 'null')
  if (value === undefined) return mixText(hash, 'undefined')
  if (Array.isArray(value)) {
    let mixed = mixText(hash, '[')
    for (const item of value) mixed = mixValue(mixed, item)
    return mixText(mixed, ']')
  }
  if (typeof value === 'object') {
    if (typeof value.type === 'string') return subtreeFingerprint(value, hash)
    let mixed = mixText(hash, '{')
    for (const key of Object.keys(value)) mixed = mixValue(mixText(mixed, `${key}=`), value[key])
    return mixText(mixed, '}')
  }
  return mixText(hash, `${typeof value}:${String(value)}`)
}

/** Real generator invocations from the expression helper since module load. */
let expressionGeneratorCalls = 0

/**
 * Test diagnostics: how often the expression helper actually ran the Babel
 * generator. Memo hits and lazily-skipped candidates never increment it.
 *
 * @returns {number}
 */
export function expressionGeneratorCallCount() {
  return expressionGeneratorCalls
}

/**
 * Render an expression node as source text.
 * @param {object} node
 * @param {object} [options]
 */
export function generateExpression(node, options = {}) {
  const memoizable = typeof node === 'object' && node !== null && Object.keys(options).length === 0
  if (memoizable) {
    const cached = expressionTextCache.get(node)
    if (cached && cached.fingerprint === subtreeFingerprint(node)) return cached.text
  }
  const file = t.file(t.program([t.expressionStatement(node)]))
  expressionGeneratorCalls += 1
  const { code } = generate(file, '', { comments: false, ...options })
  const text = code.replace(/;\s*$/, '')
  if (memoizable) expressionTextCache.set(node, { text, fingerprint: subtreeFingerprint(node) })
  return text
}
