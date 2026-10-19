import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generate } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as stringArray from '../tools/restore/passes/string-array.js'

/**
 * Run the string-array pass on a snippet.
 *
 * @param {string} source
 * @returns {{code: string, changed: boolean, notes: string[], changes: object[]}}
 */
function transform(source) {
  const { ast } = parse(source)
  const result = runPass(stringArray, ast)
  assert.equal(result.error, undefined, `pass threw: ${result.error?.message ?? ''}`)
  return { code: generate(ast).code, changed: result.changed, notes: result.notes, changes: result.changes }
}

/**
 * Execute a self-contained snippet in plain Node and capture `log(...)` calls.
 *
 * @param {string} code
 * @returns {{logged: unknown[][], error: string|null}}
 */
function runSnippet(code) {
  /** @type {unknown[][]} */
  const logged = []
  try {
    // eslint-disable-next-line no-new-func
    new Function('log', code)((...args) => logged.push(args))
    return { logged, error: null }
  } catch (error) {
    return { logged, error: error.message }
  }
}

/**
 * The transformed snippet must produce exactly what the original produced.
 *
 * @param {string} source
 * @returns {{code: string, changed: boolean, notes: string[], changes: object[]}}
 */
function assertSemanticsPreserved(source) {
  const result = transform(source)
  const before = runSnippet(source)
  const after = runSnippet(result.code)
  assert.deepEqual(after.logged, before.logged, `logged values differ for:\n${result.code}`)
  assert.equal(after.error, before.error, `error behaviour differs for:\n${result.code}`)
  return result
}

test('meta declares the documented order and idempotency', () => {
  assert.equal(stringArray.meta.id, 'string-array')
  assert.equal(stringArray.meta.order, 50)
  assert.equal(stringArray.meta.idempotent, true)
  assert.equal(typeof stringArray.meta.description, 'string')
})

test('applies a rotation IIFE and inlines every constant read', () => {
  const source = `
var _0xaa1 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
(function (_0xa, _0xn) {
  var _0xr = function (_0xk) {
    while (--_0xk) {
      _0xa['push'](_0xa['shift']());
    }
  };
  _0xr(++_0xn);
})(_0xaa1, 2);
log(_0xaa1[0], _0xaa1[1], _0xaa1[2], _0xaa1[3], _0xaa1[4]);
`
  const { code, changed, notes, changes } = assertSemanticsPreserved(source)
  assert.equal(changed, true)
  assert.ok(changes.some((change) => change.rule === 'rotation' && change.pass === 'string-array'))
  assert.ok(changes.some((change) => change.rule === 'array-read'))
  assert.match(code, /'gamma'/)
  assert.match(code, /'beta'/)
  assert.ok(!code.includes('_0xaa1'), 'the unreferenced array is deleted')
  assert.ok(!code.includes('push'), 'the rotation IIFE is deleted')
  assert.ok(notes.some((note) => note.includes('rotation')))
  assert.deepEqual(runSnippet(code).logged, [['gamma', 'delta', 'epsilon', 'alpha', 'beta']])
})

test('applies a reverse IIFE', () => {
  const source = `
var _0xbb2 = ['one', 'two', 'three', 'four'];
(function (_0xb) { _0xb.reverse(); })(_0xbb2);
log(_0xbb2[0], _0xbb2[3]);
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, true)
  assert.deepEqual(runSnippet(code).logged, [['four', 'one']])
  assert.ok(!code.includes('_0xbb2'))
})

test('inlines a small decoder called with literals', () => {
  const source = `
var _0xcc3 = ['zero', 'one', 'two', 'three'];
function _0xdec(_0xi) { return _0xcc3[_0xi - 1]; }
log(_0xdec(1), _0xdec(3));
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, true)
  assert.deepEqual(runSnippet(code).logged, [['zero', 'two']])
  assert.ok(!code.includes('_0xdec'), 'the decoder declaration is deleted')
  assert.ok(!code.includes('_0xcc3'), 'the array declaration is deleted')
})

test('folds literal arithmetic in the index', () => {
  const source = `
var _0xdd4 = ['p', 'q', 'r', 's'];
log(_0xdd4[1 + 1], _0xdd4[2 * 1], _0xdd4[3]);
`
  const { code } = assertSemanticsPreserved(source)
  assert.deepEqual(runSnippet(code).logged, [['r', 'r', 's']])
  assert.match(code, /log\('r', 'r', 's'\)/)
})

test('leaves dynamic indices alone but still inlines constant reads', () => {
  const source = `
var _0xee5 = ['a', 'b', 'c', 'd'];
var _0xidx = 2;
log(_0xee5[_0xidx], _0xee5[0]);
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, true)
  assert.match(code, /_0xee5\[_0xidx\]/, 'the dynamic read survives')
  assert.match(code, /'a'/, 'the constant read is inlined')
  assert.deepEqual(runSnippet(code).logged, [['c', 'a']])
})

test('negative: an array that is mutated is left completely untouched', () => {
  const source = `
var _0xff6 = ['a', 'b', 'c', 'd'];
_0xff6.push('e');
log(_0xff6[0], _0xff6[4]);
`
  const { code, changed, notes } = assertSemanticsPreserved(source)
  assert.equal(changed, false)
  assert.match(code, /_0xff6\.push\('e'\)/)
  assert.match(code, /_0xff6\[0\]/)
  assert.ok(notes.some((note) => note.includes('mutated')))
})

test('negative: a read before the rotation IIFE blocks the rotation', () => {
  const source = `
var _0xg7 = ['a', 'b', 'c', 'd'];
log(_0xg7[0]);
(function (_0xa) { _0xa.reverse(); })(_0xg7);
log(_0xg7[0]);
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, false)
  assert.match(code, /\.reverse\(\)/)
  assert.deepEqual(runSnippet(code).logged, [['a'], ['d']])
})

test('negative: arrays shorter than four entries and non-string arrays are ignored', () => {
  const short = transform(`var _0xh8 = ['a', 'b', 'c']; log(_0xh8[0]);`)
  assert.equal(short.changed, false)
  assert.match(short.code, /_0xh8\[0\]/)

  const numeric = transform('var _0xn9 = [1, 2, 3, 4]; log(_0xn9[0]);')
  assert.equal(numeric.changed, false)
  assert.match(numeric.code, /_0xn9\[0\]/)
})

test('negative: a non-rotation IIFE body is never simulated', () => {
  const source = `
var _0xj1 = ['a', 'b', 'c', 'd'];
(function (_0xa) { _0xa.push('z'); })(_0xj1);
log(_0xj1[4]);
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, false)
  assert.match(code, /\(function \(_0xa\)/)
  assert.deepEqual(runSnippet(code).logged, [['z']])
})

test('negative: a decoder called with a variable is not inlined', () => {
  const source = `
var _0xkk = ['a', 'b', 'c', 'd'];
function _0xdk(_0xi) { return _0xkk[_0xi]; }
var _0xj = 1;
log(_0xdk(_0xj), _0xkk[2]);
`
  const { code } = assertSemanticsPreserved(source)
  assert.match(code, /_0xdk\(_0xj\)/, 'the dynamic decoder call survives')
  assert.match(code, /'c'/, 'the constant array read is inlined')
  assert.deepEqual(runSnippet(code).logged, [['b', 'c']])
})

test('is idempotent: a second run reports no change', () => {
  const source = `
var _0xmm = ['alpha', 'beta', 'gamma', 'delta'];
(function (_0xa, _0xn) {
  while (_0xn--) { _0xa.push(_0xa.shift()); }
})(_0xmm, 1);
log(_0xmm[0], _0xmm[3]);
`
  const { ast } = parse(source)
  const first = runPass(stringArray, ast)
  assert.equal(first.changed, true)
  const second = runPass(stringArray, ast)
  assert.equal(second.changed, false)
  assert.deepEqual(runPass(stringArray, ast).notes, [])
})

test('negative: a rotation inside a conditional is never hoisted', () => {
  const source = `
var _0xq1 = ['a', 'b', 'c', 'd'];
function _0xgo() { return false; }
if (_0xgo()) (function (_0xa) { _0xa.reverse(); })(_0xq1);
log(_0xq1[0]);
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, false)
  assert.match(code, /if \(_0xgo\(\)\)/)
  assert.deepEqual(runSnippet(code).logged, [['a']])
})

test('applies a rotation when the decoder is declared before the IIFE but called after', () => {
  const source = `
var _0xr2 = ['a', 'b', 'c', 'd'];
function _0xrd(_0xi) { return _0xr2[_0xi + 1]; }
(function (_0xa) { _0xa.reverse(); })(_0xr2);
log(_0xrd(0), _0xr2[3]);
`
  const { code, changed } = assertSemanticsPreserved(source)
  assert.equal(changed, true)
  assert.deepEqual(runSnippet(code).logged, [['c', 'a']])
  assert.ok(!code.includes('_0xrd'), 'the decoder is inlined')
  assert.ok(!code.includes('_0xr2'), 'the array is deleted')
})
