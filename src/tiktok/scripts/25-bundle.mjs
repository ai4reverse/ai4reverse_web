#!/usr/bin/env node
/**
 * Bundle the lifted program with the runtime primitives it still calls.
 *
 * `output/final.js` is a decompilation, not a bundle: it defines 351 functions
 * and calls a handful of primitives that only the interpreter used to provide.
 * This stage supplies the smallest runtime that makes those calls well defined,
 * concatenates it with the program, and appends the bootstrap invocation —
 * `Y(0, …)` in the original is `fn_0()` here.
 *
 * The runtime is deliberately tiny and named. Every entry below corresponds to
 * a construct the lift could not express in plain JavaScript:
 *
 *   `__upvalue`   read a register of an enclosing frame the nesting pass could
 *                 not resolve (multi-parent functions stay flat).
 *   `__native`    an instruction whose handler the translator refused. It throws
 *                 rather than returning a plausible value.
 *   `__state`     the frame object itself, for the handful of instructions whose
 *                 register index is only known at run time.
 *
 * The bundle is written to `output/runnable.js` and is meant to be executed
 * inside a browser-aligned sandbox, never with a bare `node`.
 *
 *   node scripts/25-bundle.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'output')

const program = fs.readFileSync(path.join(OUT, 'final.js'), 'utf8')

const runtime = `/* Runtime primitives for the lifted program — see scripts/25-bundle.mjs. */
var __state = { A: [], M: [], I: [], o: null, S: 14, u: 0 };
function __cellValue(slot) {
  return slot && typeof slot === 'object' && 'v' in slot ? slot.v : slot;
}
function __upvalue(frame, depth, index) {
  if (index === undefined) { index = depth; depth = 1; }
  var f = frame;
  for (var i = 0; i < depth && f; i++) f = f.o;
  return f ? __cellValue(f.A[index]) : void 0;
}
function __setUpvalue(frame, depth, index, value) {
  if (arguments.length === 3) { value = index; index = depth; depth = 1; }
  var f = frame;
  for (var i = 0; i < depth && f; i++) f = f.o;
  if (!f) throw new Error('__setUpvalue: frame chain exhausted at depth ' + depth);
  f.A[index] = f.A[index] && typeof f.A[index] === 'object' ? Object.assign(f.A[index], { v: value }) : value;
  return value;
}
function __native(op, operands) {
  throw new Error('unlifted opcode ' + op + ' (operands ' + String(operands) + ')');
}
`

const bootstrap = `
/* Entry: the original interpreter's Y(0, void 0, l, [], 0, 14). */
fn_0(void 0, []);
`

fs.writeFileSync(path.join(OUT, 'runnable.js'), `${runtime}\n${program}\n${bootstrap}`)
const bytes = fs.statSync(path.join(OUT, 'runnable.js')).size
console.log(`program bytes     ${program.length}`)
console.log(`runtime bytes     ${runtime.length}`)
console.log(`output            ${path.join(OUT, 'runnable.js')} (${bytes} bytes)`)
