#!/usr/bin/env node
/**
 * Constraint-solving demo.
 *
 * Runs the static z3 analyzer over a small obfuscation-shaped sample, then
 * shows the lower-level validity/model APIs. No sample code is executed.
 */

import {
  analyzeConstraints,
  solveConstraints,
  provePredicate,
  proveEquivalent,
  simplifyExpression,
} from '../tools/constraint/index.js'

const source = `function stage(key) {
  // Opaque: (key & 1) is always 0 or 1.
  if ((key & 1) === 0 || (key & 1) === 1) {
    console.log('always taken');
  } else {
    console.log('dead arm');
  }

  // Dead under the integer model, reachable for NaN/fractional inputs.
  if (key > 10 && key < 5) {
    console.log('contradiction');
  }
}
if (false) { stage(1); }
`

const report = await analyzeConstraints(source)
console.log('opaque predicates:', report.opaquePredicates)
console.log('unreachable branches:', report.unreachableBranches)
console.log('simplifications:', report.simplifications.length)
console.log('assumptions:', report.assumptions)

const sat = await solveConstraints(['key * 7 + 3 === 24'])
console.log('model:', sat.status, sat.model)

console.log('bitwise tautology:', (await provePredicate('(x & 1) === 0 || (x & 1) === 1')).status)
console.log('integer identity:', (await provePredicate('x + 1 > x', { assumeIntegers: true })).status)
console.log('equivalent:', (await proveEquivalent('x + y', 'y + x', { assumeIntegers: true })).status)
console.log('normal form:', (await simplifyExpression('(x & 1) === 0 || (x & 1) === 1')).simplified)
