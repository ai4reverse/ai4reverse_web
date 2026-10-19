import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generate, generateExpression } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as stringsPass from '../tools/restore/passes/strings.js'

const pass = { ...stringsPass.meta, run: stringsPass.run }

/**
 * Evaluate a JS expression source string the way the guest engine would. The
 * host globals are passed explicitly so browser-only names (`window`, `self`)
 * used by decoder idioms resolve.
 *
 * @param {string} source
 * @returns {*}
 */
function evaluate(source) {
  const evaluateSource = new Function('window', 'self', 'return (' + source + ')')
  return evaluateSource(globalThis, globalThis)
}

/**
 * Run the strings pass over `<assignment> = <expression>;` and return both
 * sources. The assignment wrapper keeps the expression out of the
 * directive-prologue slot so the pass sees a normal value context.
 *
 * @param {string} expression
 * @returns {{original: string, folded: string, result: object}}
 */
function fold(expression) {
  const { ast } = parse(`captured = ${expression};`)
  const original = generateExpression(ast.program.body[0].expression.right)
  const result = runPass(pass, ast)
  const folded = generateExpression(ast.program.body[0].expression.right)
  return { original, folded, result }
}

/**
 * Assert the pass rewrote the expression (and reports it) while preserving the
 * value, optionally pinning the folded value.
 *
 * @param {string} expression
 * @param {*} [expected] expected value of the folded expression
 * @returns {string} the folded source
 */
function assertFolded(expression, expected) {
  const { original, folded, result } = fold(expression)
  assert.equal(result.changed, true, `expected a reported change for ${expression}`)
  assert.deepEqual(evaluate(folded), evaluate(original), `semantics changed for ${expression}`)
  if (arguments.length > 1) assert.deepEqual(evaluate(folded), expected, `unexpected value for ${expression}`)
  return folded
}

/**
 * Assert the pass left a whole program untouched (and optionally recorded a note).
 *
 * @param {string} code
 * @param {RegExp} [notePattern]
 */
function assertUnchanged(code, notePattern) {
  const { ast } = parse(code)
  const before = generate(ast).code
  const result = runPass(pass, ast)
  const after = generate(ast).code
  assert.equal(after, before, `expected no rewrite for ${code}`)
  assert.equal(result.changed, false, `expected no reported change for ${code}`)
  if (notePattern) {
    assert.ok(
      result.notes.some((note) => notePattern.test(note)),
      `expected a note matching ${notePattern}, got ${JSON.stringify(result.notes)}`,
    )
  }
}

test('strings: decodes hex, unicode and octal escapes to their cooked value', () => {
  const { original, folded } = fold("'\\x41\\x42\\x43'")
  assert.equal(original, "'\\x41\\x42\\x43'")
  assert.equal(folded, "'ABC'")
  assertFolded("'\\x41\\x42\\x43'", 'ABC')
  assertFolded("'\\u0048\\u0069'", 'Hi')
  assertFolded("'\\u{1F600}'", '\u{1F600}')
  assertFolded("'\\101\\102\\103'", 'ABC')
  assertFolded("'\\x48\\u0069'", 'Hi')
})

test('strings: drops unnecessary escapes and re-escapes only what is required', () => {
  // A double quote needs no escape inside single quotes, so the text changes.
  assertFolded("'say \\\"hi\\\"'", 'say "hi"')
})

test('strings: keeps an escape whose canonical spelling is identical', () => {
  // `'it\'s'`, `'back\\slash'` and `'line\nbreak'` regenerate to exactly the
  // same text, so clearing the raw text is not a change: reporting one made the
  // pass miss its own fixed point (docs/EVALUATION-TOOLS.md D5).
  for (const expression of ["'it\\'s'", "'back\\\\slash'", "'line\\nbreak'"]) {
    const { original, folded, result } = fold(expression)
    assert.equal(folded, original, `expected ${expression} to regenerate byte-identically`)
    assert.equal(result.changed, false, `expected no reported change for ${expression}`)
  }
})

test('strings: folds adjacent string literal chains in one pass', () => {
  assertFolded("'a' + 'b'", 'ab')
  assertFolded("'a' + 'b' + 'c'", 'abc')
  assertFolded("('a' + 'b') + ('c' + 'd')", 'abcd')
  const { folded } = fold("'\\x61' + '\\x62' + '\\x63'")
  assert.deepEqual(evaluate(folded), 'abc')
})

test('strings: decodes String.fromCharCode with literal code units', () => {
  assertFolded('String.fromCharCode(72, 105)', 'Hi')
  assertFolded("String['fromCharCode'](0x48, 105, 33)", 'Hi!')
  assertFolded('String.fromCharCode(-1)', String.fromCharCode(-1))
})

test('strings: decodes String.fromCharCode.apply with a literal array', () => {
  assertFolded('String.fromCharCode.apply(null, [72, 105, 33])', 'Hi!')
  assertFolded('String.fromCharCode.apply(undefined, [0x48, 105])', 'Hi')
  assertFolded('String.fromCharCode.apply(null, [104])', 'h')
})

test('strings: decodes literal-argument URI, escape and base64 decoders', () => {
  assertFolded("decodeURIComponent('%41%42%43')", 'ABC')
  assertFolded("unescape('%41%42')", 'AB')
  assertFolded("atob('SGk=')", 'Hi')
  assertFolded("window.atob('SGk=')", 'Hi')
})

test('strings: decodes the char-code map/join idiom', () => {
  assertFolded('[104, 105].map((c) => String.fromCharCode(c)).join("")', 'hi')
  assertFolded('[104, 105].map(function (c) { return String.fromCharCode(c) }).join("")', 'hi')
  assertFolded('[0x48, 0x69, 0x21].map((c) => String.fromCharCode(c)).join("")', 'Hi!')
})

test('strings: leaves decoder calls with non-literal arguments untouched', () => {
  assertUnchanged('captured = String.fromCharCode(x);')
  assertUnchanged('captured = String.fromCharCode(72, x);')
  assertUnchanged('captured = atob(payload);')
  assertUnchanged('captured = String.fromCharCode.apply(null, codes);')
  assertUnchanged('captured = String.fromCharCode.apply(this, [72, 105]);')
  assertUnchanged('captured = [104, x].map((c) => String.fromCharCode(c)).join("");')
  assertUnchanged('captured = [104, 105].map((c) => String.fromCharCode(c + 1)).join("");')
})

test('strings: never folds a shadowed global', () => {
  assertUnchanged("function decode(atob) { return atob('SGk='); }")
  assertUnchanged("var atob = function (s) { return s; }; captured = atob('SGk=');")
  assertUnchanged(
    'var String = { fromCharCode: function () { return "no"; } }; captured = String.fromCharCode(72, 105);',
  )
})

test('strings: keeps lone surrogates escaped and records a note', () => {
  assertUnchanged("captured = '\\uD800';", /lone surrogate/)
  assertUnchanged("captured = '\\uDC00\\uD800';", /lone surrogate/)
  // A well-formed pair is safe to decode.
  assertFolded("'\\uD83D\\uDE00'", '\u{1F600}')
})

test('strings: never turns a prologue expression into a directive', () => {
  // `'a' + 'b';` is not a Use Strict Directive, but `'ab';` would be a
  // directive entry, so the fold must be refused.
  const { ast } = parse("'a' + 'b';\nvar value = 1;")
  const before = generate(ast).code
  const result = runPass(pass, ast)
  assert.equal(generate(ast).code, before)
  assert.equal(result.changed, false)
  assert.ok(result.notes.some((note) => /directive/.test(note)), JSON.stringify(result.notes))
})

test('strings: is idempotent across two runs', () => {
  const { ast } = parse("captured = '\\x41' + String.fromCharCode(66) + atob('Qw==');")
  const first = runPass(pass, ast)
  assert.equal(first.changed, true)
  assert.equal(generateExpression(ast.program.body[0].expression.right), "'ABC'")
  const second = runPass(pass, ast)
  assert.equal(second.changed, false)
  assert.equal(generateExpression(ast.program.body[0].expression.right), "'ABC'")
})

test('strings: decoded control characters still round-trip', () => {
  const { ast } = parse("captured = '\\u0000\\u0007\\u001b';")
  const before = generateExpression(ast.program.body[0].expression.right)
  const result = runPass(pass, ast)
  const after = generateExpression(ast.program.body[0].expression.right)
  assert.equal(result.changed, true)
  assert.deepEqual(evaluate(after), evaluate(before))
  assert.deepEqual(evaluate(after), '\u0000\u0007\u001b')
})
