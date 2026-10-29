#!/usr/bin/env node
/** Smoke-test the real constraint API before wiring it into the validator. */
import { proveEquivalent, createZ3Context, z3Version, parseExpression } from '../../../../../tools/constraint/index.js'

const ctx = await createZ3Context('probe')
console.log('z3 version', await z3Version(ctx.api ?? ctx))

for (const [left, right, opts] of [
  ['a + b', 'b + a', {}],
  ['a + b', 'a - b', {}],
  ['(a | b) >>> 0', '(b | a) >>> 0', { assumeInt32: true }],
  ['(a << b) & 0xffff', '(a << b) % 65536', { assumeInt32: true }],
  ['a * 2', 'a + a', {}],
  ['a > b', 'b < a', { assumeIntegers: true }],
  ['a >= b ? a : b', 'b > a ? b : a', { assumeIntegers: true }],
  ['a > b ? a : b', 'a < b ? b : a', { assumeIntegers: true }],
  ['a > b ? a : b', '(a > b) ? a : b', { assumeIntegers: true }],
]) {
  const r = await proveEquivalent(left, right, { timeoutMs: 4000, ...opts })
  console.log(JSON.stringify({ left, right, status: r.status, equivalent: r.equivalent, exact: r.exact, assumptions: r.assumptions, counterexample: r.counterexample, reason: r.reason, error: r.error }))
}
console.log('parse', parseExpression('a + b').type)
