import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generate } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as jsfuck from '../tools/restore/passes/jsfuck.js'
import * as stringArray from '../tools/restore/passes/string-array.js'
import * as proxyUnwrap from '../tools/restore/passes/proxy-unwrap.js'
import * as deadCode from '../tools/restore/passes/dead-code.js'
import * as evalUnwrap from '../tools/restore/passes/eval-unwrap.js'

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

// ---- eval / Function unwrapping ------------------------------------------
//
// The pass rewrites only literal forms and is deliberately conservative: every
// refusal below is a strictness or scope change that would alter behaviour, so
// each negative case asserts both the note and the untouched source.

test('eval-unwrap: splices literal eval statements and drops empty evals', () => {
  const source = `eval('var a = 1; log(a)'); eval(''); log('after');`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('eval('), 'the eval calls are gone')
  assert.match(result.code, /var a = 1/)
  assert.match(result.code, /log\(a\)/)
  assert.deepEqual(runSnippet(result.code).logged, [[1], ['after']])
  assert.ok(result.changes.some((change) => change.rule === 'eval' && change.pass === 'eval-unwrap'))
})

test('eval-unwrap: decodes template literal bodies without expressions', () => {
  const source = `log('start'); eval(\`log('tpl')\`);`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('eval('))
  assert.deepEqual(runSnippet(result.code).logged, [['start'], ['tpl']])
})

test('eval-unwrap: leaves value-position eval and non-literal arguments alone', () => {
  const source = `
var payload = 'log(1)';
var alias = eval;
log(typeof alias, typeof eval(payload), foo(eval('log(2)')));
function foo(value) { return typeof value; }
`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, false)
  assert.match(result.code, /eval\(payload\)/)
  assert.match(result.code, /eval\('log\(2\)'\)/)
  assert.match(result.code, /var alias = eval/)
  // The value of the call is observable, so both evals still execute here.
  assert.deepEqual(runSnippet(result.code).logged, [[1], [2], ['function', 'number', 'number']])
})

test('eval-unwrap: refuses shadowed eval bindings', () => {
  const source = `function f(eval) { eval('log(1)'); } f(function (text) { log(text); });`
  const result = transform(evalUnwrap, source)
  assert.equal(result.changed, false)
  assert.ok(result.notes.some((note) => note.includes('shadows eval')))
  assert.match(result.code, /eval\('log\(1\)'\)/)
})

test('eval-unwrap: refuses eval bodies with a directive prologue', () => {
  const source = `function f() { log('enter'); eval('"use strict"; var strictValue = 1'); return typeof strictValue; } log(f());`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, false)
  assert.ok(result.notes.some((note) => note.includes('starts with a directive')))
})

test('eval-unwrap: refuses eval bodies that declare functions', () => {
  const source = `function f() { log('enter'); eval('function inner() { return 1 }'); return typeof inner; } log(f());`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, false)
  assert.ok(result.notes.some((note) => note.includes('declares a function')))
})

test('eval-unwrap: refuses eval bodies that do not parse', () => {
  const source = `function f() { log('enter'); try { eval('return 1'); } catch (error) { return 'threw'; } return 'fell'; } log(f());`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, false)
  assert.ok(result.notes.some((note) => note.includes('does not parse cleanly')))
})

test('eval-unwrap: records a repeated refusal note only once', () => {
  const source = `function f(eval) { eval('log(1)'); eval('log(1)'); } f(function () {});`
  const result = transform(evalUnwrap, source)
  const shadowNotes = result.notes.filter((note) => note.includes('shadows eval'))
  assert.equal(shadowNotes.length, 1, JSON.stringify(result.notes))
})

test('eval-unwrap: Function constructor becomes a function expression', () => {
  const source = `var add = new Function('a', 'b', 'return a + b'); log(add(1, 2), add.length, Function('return 42')());`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('new Function'))
  assert.match(result.code, /function \(a, b\)/)
  assert.deepEqual(runSnippet(result.code).logged, [[3, 2, 42]])
  assert.ok(result.changes.some((change) => change.rule === 'function-constructor'))
})

test('eval-unwrap: a rewritten constructor keeps reading its global scope', () => {
  const source = `var reader = Function('return typeof Math.max'); log(reader());`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.deepEqual(runSnippet(result.code).logged, [['function']])
})

test('eval-unwrap: Function constructor refusals keep the call intact', () => {
  const cases = [
    { source: `log('pre'); var nothing = new Function(); log(typeof nothing);`, note: null },
    { source: `var param = 'a'; log('pre'); var f = new Function(param, 'return 1'); log(typeof f);`, note: null },
    {
      source: `function g(Function) { return new Function('return 1'); } log(typeof g);`,
      note: 'shadows Function',
    },
    { source: `log('pre'); var f = new Function('a-b', 'return 1'); log(typeof f);`, note: 'parameters are not plain identifiers' },
    { source: `'use strict'; log('pre'); var f = new Function('return typeof this'); log(f());`, note: 'in strict code' },
    {
      source: `log('pre'); var f = new Function('async function inner() { return await 1 }'); log(typeof f);`,
      note: 'uses await/super/new.target',
    },
    {
      source: `log('pre'); var f = new Function('class A { m() { return super.toString(); } }'); log(typeof f);`,
      note: 'uses await/super/new.target',
    },
    {
      source: `function outer() { var local = 1; return new Function('return local'); } log(typeof outer);`,
      note: "reads local 'local'",
    },
    { source: `log('pre'); var f = new Function('return ('); log(typeof f);`, note: 'parse failed' },
  ]
  for (const { source, note } of cases) {
    const result = transform(evalUnwrap, source)
    assert.equal(result.changed, false, `unexpected rewrite for: ${source}\n${result.code}`)
    assert.match(result.code, /Function\(/)
    if (note) assert.ok(result.notes.some((entry) => entry.includes(note)), `${note} missing from ${JSON.stringify(result.notes)}`)
  }
})

test('eval-unwrap: a body that only reads globals still folds inside a closure', () => {
  const source = `
function outer() {
  var local = 41;
  var read = new Function('return typeof Math.max');
  return local - 1 + ':' + read();
}
log(outer());
`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('new Function'))
  assert.deepEqual(runSnippet(result.code).logged, [['40:function']])
})

test('eval-unwrap: a body reading an enclosing local is refused', () => {
  const source = `
function outer() {
  var local = 41;
  var read = new Function('return typeof local');
  return read();
}
log(outer());
`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, false)
  assert.ok(result.notes.some((note) => note.includes("reads local 'local'")))
  assert.deepEqual(runSnippet(result.code).logged, [['undefined']])
})

test('eval-unwrap: decodes printable atob literals', () => {
  const source = `log(atob('aGk='), atob(\`aGk=\`));`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('atob('))
  assert.deepEqual(runSnippet(result.code).logged, [['hi', 'hi']])
  assert.equal(result.changes.filter((change) => change.rule === 'atob').length, 2)
})

test('eval-unwrap: folds atob through every global alias', () => {
  const source = `log(window.atob('aGk='), self.atob('aGk='), globalThis.atob('aGk='));`
  const result = transform(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('atob('), result.code)
  assert.match(result.code, /'hi', 'hi', 'hi'/)
  assert.equal(result.changes.filter((change) => change.rule === 'atob').length, 3)
})

test('eval-unwrap: atob refusals are noted and left untouched', () => {
  const cases = [
    { source: `log('pre'); log(atob('aGk'));`, note: 'not plain base64' },
    { source: `log('pre'); log(atob('aGk*'));`, note: 'not plain base64' },
    { source: `log('pre'); log(atob('YO=='));`, note: 'not canonical base64' },
    { source: `log('pre'); log(atob('AA=='));`, note: 'decodes to non-printable bytes' },
    { source: `log('pre'); log(window['atob']('aGk='));`, note: null },
    { source: `log('pre'); log(atob('aGk=', 'extra'));`, note: null },
    { source: `log('pre'); function f(atob) { return atob('aGk='); } log(f(function (s) { return s; }));`, note: null },
    {
      source: `log('pre'); var scope = { atob: function (s) { return s; } }; var out; with (scope) { out = atob('aGk='); } log(out);`,
      note: null,
    },
    {
      source: `function f() { atob('aGk='); return 'prologue'; } log(f());`,
      note: null,
    },
    { source: `log('pre'); log(other.atob('aGk='));`, note: null },
  ]
  for (const { source, note } of cases) {
    const result = transform(evalUnwrap, source)
    assert.equal(result.changed, false, `unexpected rewrite for: ${source}\n${result.code}`)
    assert.match(result.code, /atob/)
    if (note) assert.ok(result.notes.some((entry) => entry.includes(note)), `${note} missing from ${JSON.stringify(result.notes)}`)
  }
})

test('eval-unwrap: folds printable String.fromCharCode call arguments', () => {
  const source = `log(String.fromCharCode(104, 105), String.fromCharCode(10));`
  const result = assertSemanticsPreserved(evalUnwrap, source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('fromCharCode'))
  assert.deepEqual(runSnippet(result.code).logged, [['hi', '\n']])
  assert.ok(result.changes.some((change) => change.rule === 'fromCharCode'))
})

test('eval-unwrap: fromCharCode refusals are noted and left untouched', () => {
  const cases = [
    { source: `log('pre'); log(String.fromCharCode(-1));`, note: 'non-printable units' },
    { source: `log('pre'); log(String.fromCharCode(104, dynamic));`, note: null },
    { source: `log('pre'); log(String.fromCharCode());`, note: null },
    { source: `log('pre'); log(String['fromCharCode'](104));`, note: null },
    { source: `log('pre'); log(helper.fromCharCode(104));`, note: null },
    { source: `function f(String) { return String.fromCharCode(104); } log(f(function () { return 'x'; }));`, note: null },
    {
      source: `function f() { String.fromCharCode(117, 115, 101); return 'prologue'; } log(f());`,
      note: null,
    },
  ]
  for (const { source, note } of cases) {
    const result = transform(evalUnwrap, source)
    assert.equal(result.changed, false, `unexpected rewrite for: ${source}\n${result.code}`)
    assert.match(result.code, /fromCharCode/)
    if (note) assert.ok(result.notes.some((entry) => entry.includes(note)), `${note} missing from ${JSON.stringify(result.notes)}`)
  }
})

test('eval-unwrap: is idempotent and declares the pipeline contract', () => {
  assert.equal(evalUnwrap.meta.id, 'eval-unwrap')
  assert.equal(evalUnwrap.meta.order, 80)
  assert.equal(evalUnwrap.meta.idempotent, true)
  const source = `eval('log("once")'); var f = new Function('a', 'return a * 2'); log(f(21), atob('aGk='), String.fromCharCode(33));`
  const first = transform(evalUnwrap, source)
  const second = transform(evalUnwrap, first.code)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false, second.code)
})
