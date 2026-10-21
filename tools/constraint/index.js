/**
 * Constraint-solving analysis (`ai4reverse-web/constraint`).
 *
 * A z3-backed component for the questions restoration cannot answer
 * syntactically: is this predicate constant, is this branch reachable, what
 * input satisfies these conditions, and what is the normal form of this MBA
 * expression?
 *
 * The translator is deliberately sound-first. `analyzeConstraints()` only
 * proves properties of the exact fragment unless the caller opts into the
 * integer model with `assumeIntegers: true`; the model and its assumptions are
 * always reported next to the finding.
 */

export {
  analyzeConstraints,
  collectPathConditions,
  FINDING_LIMIT,
} from './analyze.js'
export {
  solveConstraints,
  solvePredicate,
  provePredicate,
  proveEquivalent,
  simplifyExpression,
  parseExpression,
} from './solve.js'
export {
  createTranslator,
  translateExpression,
  expressionText,
  constantInt,
} from './translate.js'
export { createZ3Context, loadZ3, isDecision, z3Version } from './z3.js'
export { CONSTRAINT_LIMITS, normalizeConstraintLimits } from './limits.js'
export { ConstraintError, ConstraintSyntaxError, ConstraintUnsupportedError } from './errors.js'
export { renderConstraintReport } from './render.js'
