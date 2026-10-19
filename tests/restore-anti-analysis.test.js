import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { parse } from '../tools/restore/parse.js'
import { generate } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as antiAnalysis from '../tools/restore/passes/anti-analysis.js'

/**
 * Run the pass over `source` and return the regenerated code plus the pass report.
 * @param {string} source
 * @returns {{code: string, changed: boolean, notes: string[]}}
 */
function transform(source) {
  const { ast } = parse(source)
  const result = runPass(antiAnalysis, ast, {})
  return { code: generate(ast).code, changed: result.changed, notes: result.notes }
}

/**
 * @param {string} source
 * @returns {string} the regenerated code, without running any pass
 */
function format(source) {
  return generate(parse(source).ast).code
}

/**
 * Execute a self-contained snippet in a fresh Node context and return the value
 * of its trailing `__out` expression.
 * @param {string} source
 * @returns {unknown}
 */
function runScript(source) {
  return vm.runInNewContext(`${source}\n__out;`, {}, { timeout: 2000 })
}

test('removes debugger statements without changing behaviour', () => {
  const source = `
function score(x) {
  debugger;
  var total = 0;
  for (var i = 0; i < x; i++) { total += i; debugger; }
  return total;
}
var __out = score(4);
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.ok(!/\bdebugger\b/.test(result.code), 'no debugger statement may survive')
  assert.equal(runScript(source), 6)
  assert.equal(runScript(result.code), runScript(source))
  assert.match(result.notes.join('\n'), /removed 2 debugger statement/)
})

test('removes empty spin loops but not loops with a body', () => {
  const source = `
function probe() {
  if (false) { while (true) {} }
  if (false) { for (;;) {} }
  var counter = 0;
  while (true) { counter++; if (counter > 2) break; }
  return counter;
}
var __out = probe();
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('while (true) {}'), 'the empty while spin must be gone')
  assert.ok(!/for \(;;\) \{\}/.test(result.code), 'the empty for spin must be gone')
  assert.ok(result.code.includes('counter++'), 'a loop with a body must survive')
  assert.equal(runScript(result.code), 3)
  assert.equal(runScript(result.code), runScript(source))
})

test('leaves labelled spins and empty-looking non-spins alone', () => {
  const source = `
outer: while (true) {}
function noop() { while (true) { break; } }
var __out = 'ok';
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.ok(result.code.includes('outer: while (true) {}'))
  assert.ok(result.code.includes('break;'))
})

test('is idempotent', () => {
  const source = 'function f() { debugger; while (true) {} return 1; } var __out = f();'
  const first = transform(source)
  assert.equal(first.changed, true)
  const second = transform(first.code)
  assert.equal(second.changed, false)
  assert.equal(second.code, first.code)
})

test('reports Date/performance timing checks', () => {
  const source = `
function timed(start) {
  if (Date.now() - start > 50) return 'slow';
  var elapsed = performance.now() - start;
  if (elapsed > 10) return 'slower';
  return 'fast';
}
var __out = timed(0);
`
  const result = transform(source)
  const notes = result.notes.join('\n')
  assert.equal(result.changed, false, 'detection must not rewrite code')
  assert.match(notes, /timing check/)
  assert.equal(runScript(result.code), runScript(source))
})

test('reports Function.prototype.toString brand checks', () => {
  const result = transform(`
if (Function.prototype.toString.call(probe) !== 'function probe() { [native code] }') { throw new Error('hooked'); }
`)
  assert.match(result.notes.join('\n'), /Function\.prototype\.toString brand check/)
})

test("reports constructor('return this')() and Function('return this')()", () => {
  const result = transform(`
var globalA = (function () {}).constructor('return this')();
var globalB = Function('return this')();
`)
  const notes = result.notes.join('\n')
  assert.match(notes, /dynamic global access/)
  assert.equal(result.changed, false)
})

test('reports sandbox and automation probes', () => {
  const result = transform(`
if (navigator.webdriver) { hit = 1; }
if (typeof window.callPhantom === 'function') { hit = 2; }
if (typeof _phantom !== 'undefined' || typeof domAutomation !== 'undefined') { hit = 3; }
if (typeof process !== 'undefined' && process.env) { hit = 4; }
if (typeof nightmare === 'object') { hit = 5; }
`)
  const notes = result.notes.join('\n')
  assert.match(notes, /sandbox\/environment probe/)
  assert.match(notes, /webdriver/)
  assert.match(notes, /callPhantom/)
  assert.match(notes, /domAutomation/)
})

test('reports Error().stack length checks', () => {
  const result = transform('if (new Error().stack.length > 200) { bail(); }')
  assert.match(result.notes.join('\n'), /Error\(\)\.stack length check/)
})

test("reports the string 'debugger'", () => {
  const result = transform("var trap = 'debugger'; run(trap);")
  assert.match(result.notes.join('\n'), /devtools trap/)
})

test('never rewrites detection sites', () => {
  const source = `
function probe() {
  var t0 = Date.now();
  if (Date.now() - t0 > 5) return 0;
  return Function.prototype.toString.call(probe).length;
}
var __out = typeof probe;
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.equal(result.code, format(source))
})

test('stays silent on benign code', () => {
  const source = `
function add(a, b) { return a + b; }
var list = [1, 2, 3].map(function (value) { return add(value, 1); });
var __out = list.join(',');
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.deepEqual(result.notes, [])
  assert.equal(runScript(result.code), '2,3,4')
})
