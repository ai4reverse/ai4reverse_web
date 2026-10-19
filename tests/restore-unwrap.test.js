import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generate } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as jsfuck from '../tools/restore/passes/jsfuck.js'
import * as stringArray from '../tools/restore/passes/string-array.js'
import * as proxyUnwrap from '../tools/restore/passes/proxy-unwrap.js'
import * as deadCode from '../tools/restore/passes/dead-code.js'

/**
 * Run one pass on a snippet.
 *
 * @param {object} pass
 * @param {string} source
 * @returns {{code: string, changed: boolean, notes: string[], changes: object[]}}
 */
function transform(pass, source) {
  const { ast } = parse(source)
  const result = runPass(pass, ast)
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
 * @param {object} pass
 * @param {string} source
 * @returns {{code: string, changed: boolean, notes: string[], changes: object[]}}
 */
function assertSemanticsPreserved(pass, source) {
  const result = transform(pass, source)
  const before = runSnippet(source)
  const after = runSnippet(result.code)
  assert.deepEqual(after.logged, before.logged, `logged values differ for:\n${result.code}`)
  assert.equal(after.error, before.error, `error behaviour differs for:\n${result.code}`)
  return result
}

test('pass metadata matches the documented pipeline order', () => {
  assert.equal(jsfuck.meta.order, 55)
  assert.equal(proxyUnwrap.meta.order, 60)
  assert.equal(deadCode.meta.order, 65)
  for (const pass of [jsfuck, proxyUnwrap, deadCode]) {
    assert.equal(pass.meta.idempotent, true)
    assert.equal(typeof pass.run, 'function')
  }
})

test('jsfuck: folds boolean and string atoms', () => {
  const source = `log(![] + [], (![] + [])[+[]], +!+[], !![]);`
  const { code, changed, changes } = assertSemanticsPreserved(jsfuck, source)
  assert.equal(changed, true)
  assert.ok(changes.every((change) => change.rule === 'jsfuck' && change.pass === 'jsfuck'))
  assert.match(code, /'false'/)
  assert.match(code, /'f'/)
  assert.match(code, /log\('false', 'f', 1, true\)/)
})

test('jsfuck: folds member access on evaluated atoms', () => {
  const source = `log([][[]], ({}+[])[+[]], +[], 'abc'[1]);`
  const { code } = assertSemanticsPreserved(jsfuck, source)
  assert.match(code, /undefined/)
  assert.match(code, /'\['/)
  assert.match(code, /'b'/)
  assert.deepEqual(runSnippet(code).logged, [[undefined, '[', 0, 'b']])
})

test('jsfuck negative: function-valued members are never folded', () => {
  const source = `log(typeof []['filter'], typeof ''['constructor'], typeof []['constructor']);`
  const { code, changed } = assertSemanticsPreserved(jsfuck, source)
  assert.equal(changed, false)
  assert.match(code, /'filter'/)
  assert.deepEqual(runSnippet(code).logged, [['function', 'function', 'function']])
})

test('jsfuck negative: calls and unknown identifiers are left alone', () => {
  const source = `function f() { return 'x'; } log(f(), typeof []['at']);`
  const { code, changed } = assertSemanticsPreserved(jsfuck, source)
  assert.equal(changed, false)
  assert.match(code, /f\(\)/)
  assert.match(code, /'at'/)
})

test('proxy-unwrap: unwraps identity proxies, arrows, comma heads and void 0', () => {
  const source = `
var _0xobj = { b: 7 };
log((function (_0xa) { return _0xa; })(_0xobj) === _0xobj,
    (function (_0xa) { return _0xa.b; })(_0xobj),
    (_0x => _0x)(3),
    ('literal head', 42),
    void 0);
`
  const { code, changed } = assertSemanticsPreserved(proxyUnwrap, source)
  assert.equal(changed, true)
  assert.ok(!code.includes('function'), 'identity wrappers are gone')
  assert.ok(!code.includes('void'), 'void 0 becomes undefined')
  assert.match(code, /undefined/)
  assert.deepEqual(runSnippet(code).logged, [[true, 7, 3, 42, undefined]])
})

test('proxy-unwrap: rewrites single-element array calls and expression IIFEs', () => {
  const source = `
log([function (_0xx) { return _0xx * 2; }][0](21), (function () { return 40 + 2; })());
`
  const { code, changed } = assertSemanticsPreserved(proxyUnwrap, source)
  assert.equal(changed, true)
  assert.deepEqual(runSnippet(code).logged, [[42, 42]])
  assert.match(code, /40 \+ 2/)
})

test('proxy-unwrap negative: bodies with declarations are kept intact', () => {
  const source = `
var _0xobj = { b: 7 };
log((function (_0xa) { var _0xcopy = _0xa; return _0xcopy; })(_0xobj).b);
`
  const { code, changed } = assertSemanticsPreserved(proxyUnwrap, source)
  assert.equal(changed, false)
  assert.match(code, /_0xcopy/)
})

test('proxy-unwrap negative: this, arguments and scoped IIFEs survive', () => {
  const source = `
log(
    (function () { return typeof this; })(),
    (function () { return arguments.length; })(),
    (function (_0xa) { return _0xa; })(1, 2)
  );
`
  const { code } = assertSemanticsPreserved(proxyUnwrap, source)
  assert.match(code, /typeof this/)
  assert.match(code, /arguments\.length/)
  assert.match(code, /\(1, 2\)/, 'extra arguments are never dropped')
})

test('dead-code: keeps only the reachable branch', () => {
  const source = `
if (false) { log('dead'); } else { log('else'); }
if (!1) log('never'); else log('kept');
if (1) { log('then'); } else { log('other'); }
`
  const { code, changed, changes } = assertSemanticsPreserved(deadCode, source)
  assert.equal(changed, true)
  assert.ok(changes.some((change) => change.rule === 'constant-branch' && change.pass === 'dead-code'))
  assert.ok(!code.includes('dead'))
  assert.ok(!code.includes('never'))
  assert.match(code, /log\('else'\)/)
  assert.match(code, /log\('kept'\)/)
  assert.match(code, /log\('then'\)/)
})

test('dead-code: drops while(false) and unreachable statements after return', () => {
  const source = `
function _0xf() {
  while (false) { log('loop'); }
  return 'value';
  log('after-return');
}
log(_0xf());
`
  const { code } = assertSemanticsPreserved(deadCode, source)
  assert.ok(!code.includes('loop'))
  assert.ok(!code.includes('after-return'))
  assert.match(code, /return 'value'/)
  assert.deepEqual(runSnippet(code).logged, [['value']])
})

test('dead-code: removes empty statements', () => {
  const source = `log('a');;  ; log('b');`
  const { code, changed } = assertSemanticsPreserved(deadCode, source)
  assert.equal(changed, true)
  assert.ok(!code.includes(';  ;'))
  assert.doesNotMatch(code, /;\s*;/)
  assert.deepEqual(runSnippet(code).logged, [['a'], ['b']])
})

test('dead-code negative: side-effecting tests are never evaluated', () => {
  const source = `
var _0xcalls = 0;
function _0xside() { _0xcalls += 1; return false; }
if (_0xside()) { log('branch'); }
log(_0xcalls);
`
  const { code, changed } = assertSemanticsPreserved(deadCode, source)
  assert.equal(changed, false)
  assert.match(code, /_0xside\(\)/)
  assert.deepEqual(runSnippet(code).logged, [[1]])
})

test('dead-code negative: branches declaring hoisted bindings are kept', () => {
  const source = `
if (false) { var _0xhoisted = 1; }
if (false) { function _0xinner() { return 2; } }
log(typeof _0xhoisted, typeof _0xinner);
`
  const { code, changed } = assertSemanticsPreserved(deadCode, source)
  assert.equal(changed, false)
  assert.match(code, /_0xhoisted = 1/)
  assert.match(code, /function _0xinner/)
})

test('dead-code: directives survive branch and statement removal', () => {
  const source = `
function _0xstrict() {
  'use strict';
  if (false) { log('dead'); }
  return this;
}
log(typeof _0xstrict());
`
  const { code } = assertSemanticsPreserved(deadCode, source)
  assert.match(code, /'use strict'/)
  assert.ok(!code.includes('dead'))
  assert.deepEqual(runSnippet(code).logged, [['undefined']])
})

test('pipeline: the four passes compose in documented order without changing behaviour', () => {
  const source = `
var _0x9f = ['log', 'safe', 'evil', 'value', 'result'];
(function (_0xa, _0xn) {
  var _0xr = function (_0xk) { while (--_0xk) { _0xa['push'](_0xa['shift']()); } };
  _0xr(++_0xn);
})(_0x9f, 2);
function _0xdec(_0xi) { return _0x9f[_0xi]; }
var _0xcfg = { mode: 'safe' };
(function (_0xc) { return _0xc; })(_0xcfg);
if (false) { log(_0xdec(2)); } else { log(_0xdec(1)); }
log(![] + [], _0xdec(0), (function (_0xr) { return _0xr.mode; })(_0xcfg), ('x', 42));
`
  const { ast } = parse(source)
  for (const pass of [stringArray, jsfuck, proxyUnwrap, deadCode]) {
    const result = runPass(pass, ast)
    assert.equal(result.error, undefined, `${pass.meta.id} threw: ${result.error?.message ?? ''}`)
    assert.equal(result.changed, true, `${pass.meta.id} should contribute`)
  }
  const { code } = generate(ast)
  const before = runSnippet(source)
  const after = runSnippet(code)
  assert.deepEqual(after.logged, before.logged)
  assert.deepEqual(after.logged, [['value'], ['false', 'evil', 'safe', 42]])
  assert.ok(!code.includes('_0x9f'), 'the string array is gone')
  assert.ok(!code.includes('_0xdec'), 'the decoder is gone')
  assert.ok(!code.includes('while'), 'the rotation IIFE is gone')
})

test('proxy-unwrap negative: member expressions never move into call position', () => {
  const source = `
var _0xobj = {
  n: 5,
  read: function () { return this === _0xobj ? 'bound' : 'unbound'; }
};
log([_0xobj.read][0](), (function () { return _0xobj.read; })()(), ('x', _0xobj.read)());
`
  const { code, changed } = assertSemanticsPreserved(proxyUnwrap, source)
  assert.equal(changed, false)
  assert.deepEqual(runSnippet(code).logged, [['unbound', 'unbound', 'unbound']])
})

test('jsfuck negative: shadowed NaN and undefined names are never materialised', () => {
  const source = `
function _0xshadow(NaN, undefined) {
  return [+'x', undefined, ![] + []];
}
log(_0xshadow('nan-param', 'undefined-param'));
`
  const { code } = assertSemanticsPreserved(jsfuck, source)
  assert.match(code, /'false'/, 'shadow-free string folds still happen')
  assert.match(code, /\+'x'/, 'the shadowed NaN result is left as an expression')
  assert.deepEqual(runSnippet(code).logged, [[[NaN, 'undefined-param', 'false']]])
})
