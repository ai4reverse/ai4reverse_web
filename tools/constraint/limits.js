/**
 * Budgets for the constraint-solving component.
 *
 * z3 is a decision procedure, not a source of infinite patience: a hostile
 * sample can encode a hard problem in one branch condition. Every entry point
 * is therefore bounded in three independent dimensions — candidates, wall
 * clock, and expression size — and reports which bound it hit.
 */

/** Defaults used by `analyzeConstraints`, `solveConstraints` and the CLI. */
export const CONSTRAINT_LIMITS = Object.freeze({
  /** Maximum branch/predicate candidates translated per source. */
  maxPredicates: 200,
  /** Maximum `if`/loop branches whose reachability is checked. */
  maxBranches: 200,
  /** Maximum enclosing path conditions attached to one branch. */
  maxPathConditions: 12,
  /** Maximum logical nesting accepted for one expression. */
  maxDepth: 96,
  /** Maximum AST nodes visited while translating one expression. */
  maxNodes: 4096,
  /** Deterministic per-query z3 resource limit (rlimit units). */
  solverRlimit: 2_000_000,
  /** Per-query solver timeout in milliseconds (host safety net). */
  timeoutMs: 500,
  /** Total solver wall-clock budget for one `analyzeConstraints` call. */
  budgetMs: 5000,
  /** Longest source slice quoted in a finding. */
  maxTextLength: 240,
  /** Maximum findings retained per category. */
  maxFindings: 100,
  /** Maximum variables named in one finding. */
  maxVariables: 12,
})

/**
 * Merge caller options over {@link CONSTRAINT_LIMITS}, rejecting values that
 * would disable a bound (a zero or negative timeout is a usage error, never
 * "unlimited").
 *
 * @param {object} [input]
 * @returns {typeof CONSTRAINT_LIMITS}
 */
export function normalizeConstraintLimits(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const result = { ...CONSTRAINT_LIMITS }
  for (const key of Object.keys(CONSTRAINT_LIMITS)) {
    if (source[key] === undefined) continue
    const value = Number(source[key])
    if (!Number.isFinite(value) || value <= 0) continue
    result[key] = key === 'timeoutMs' || key === 'budgetMs' ? Math.max(1, Math.round(value)) : Math.floor(value)
  }
  return result
}
