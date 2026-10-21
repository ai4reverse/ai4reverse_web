/**
 * Declarations for the `ai4reverse-web/constraint` subpath.
 *
 * A z3-backed constraint-solving component: AST → z3 translation, sat/model
 * queries, validity proofs, equivalence checks, and the composed static
 * analyzer used by `analyzeSample()`.
 *
 * Soundness is part of the contract: `analyzeConstraints()` proves only the
 * exact fragment unless `assumeIntegers` is set, and every result reports the
 * assumptions it used. `unknown`/`unsupported` are normal outcomes, never a
 * silent `false`.
 */

export {
  analyzeConstraints,
  solveConstraints,
  provePredicate,
  proveEquivalent,
  simplifyExpression,
  renderConstraintReport,
  CONSTRAINT_LIMITS,
} from './ai4reverse.js'

export type {
  ConstraintLimits,
  ConstraintAnalysisOptions,
  ConstraintStats,
  ConstraintFinding,
  ConstraintUnreachableBranch,
  ConstraintSimplification,
  ConstraintReport,
  ConstraintSolveOptions,
  ConstraintSolveResult,
  ConstraintProofResult,
  ConstraintEquivalenceResult,
  ConstraintSimplificationResult,
} from './ai4reverse.js'

/** Longest finding list the static analyzer keeps per category. */
export declare const FINDING_LIMIT: number

export interface PathCondition {
  text: string
  /** `true` for the positive form, `false` for the negated form. */
  truth: boolean
  line: number | null
  column: number | null
}

export interface PathConditionBranch {
  line: number | null
  column: number | null
  text: string
  consequent: PathCondition[]
  alternate: PathCondition[]
  hasAlternate: boolean
}

export interface PathConditionResult {
  ok: boolean
  parse: { ok: boolean; sourceType: string | null; errors: { message: string }[] }
  branches: PathConditionBranch[]
  truncated: boolean
  notes: string[]
  error: { message: string } | null
}

/**
 * Extract syntactic path conditions for every `if` arm. Feed a branch's texts
 * to `solveConstraints()` to ask whether the arm is reachable.
 */
export declare function collectPathConditions(
  source: string,
  options?: {
    filename?: string
    sourceType?: 'script' | 'module' | 'unambiguous'
    limits?: Partial<import('./ai4reverse.js').ConstraintLimits>
  },
): PathConditionResult

/** Parse one JS expression source into a Babel expression node. */
export declare function parseExpression(source: string, options?: { filename?: string }): object

/** Convenience wrapper: solve one condition and return its model. */
export declare function solvePredicate(
  condition: string | object,
  options?: import('./ai4reverse.js').ConstraintSolveOptions,
): Promise<import('./ai4reverse.js').ConstraintSolveResult>

/** One translated JS term plus the soundness flags the analyzer uses. */
export interface Translation {
  expr: object
  sort: 'int' | 'bv32' | 'bool' | 'string' | 'type' | 'undefined' | 'null'
  /** True when the term captures JS semantics for every input. */
  exact: boolean
  nanSafe: boolean
  integral: boolean
  /** False when evaluating the source expression can have side effects. */
  pure: boolean
  /** Number of uninterpreted leaves in the term. */
  uninterpreted: number
  variables: Set<string>
  reason: string | null
}

export interface SafeTranslation extends Omit<Translation, 'variables'> {
  supported: boolean
  reason: string | null
  variables: string[]
}

export interface Translator {
  api: object
  context: object
  symbols: Map<string, { expr: object; bvExpr?: object; label: string }>
  translate(node: object, options?: { scope?: object | null; expected?: string }): Translation
  translateSafe(node: object, options?: { scope?: object | null; expected?: string }): SafeTranslation
  translateCondition(node: object, options?: { scope?: object | null }): Translation
  translateConditionSafe(node: object, options?: { scope?: object | null }): SafeTranslation
  asIntValue(value: Translation): Translation
  asBoolValue(value: Translation): Translation
  /** Give subsequent translations fresh identifier symbols (mutation barrier). */
  resetSymbols(): void
}

/** Create a translator bound to one z3 context. */
export declare function createTranslator(
  api: object,
  context: object,
  options?: {
    maxDepth?: number
    maxNodes?: number
    assumeIntegers?: boolean
    assumeInt32?: boolean
  },
): Translator

/** Translate one expression node; unsupported leaves are uninterpreted, not thrown. */
export declare function translateExpression(
  api: object,
  context: object,
  node: object,
  options?: {
    scope?: object | null
    expected?: string
    maxDepth?: number
    maxNodes?: number
    assumeIntegers?: boolean
    assumeInt32?: boolean
  },
): SafeTranslation

/** Deterministic, bounded source text for an expression node. */
export declare function expressionText(node: object, limit?: number): string

/** Constant integer value of a literal/unary/binary subtree, or `null`. */
export declare function constantInt(node: object): number | null

/** Create a private z3 context from the lazily loaded module. */
export declare function createZ3Context(name?: string): Promise<{ api: object; context: object; name: string }>

/** Load the z3 high-level API once per process. */
export declare function loadZ3(): Promise<object>

/** True for `sat`/`unsat`; `unknown` is not a decision. */
export declare function isDecision(status: unknown): boolean

/** Best-effort z3 version string (`z3-5.3.1`), or `null`. */
export declare function z3Version(api: object): string | null

/** Merge caller limits over the defaults, ignoring invalid values. */
export declare function normalizeConstraintLimits(
  input?: Partial<import('./ai4reverse.js').ConstraintLimits>,
): import('./ai4reverse.js').ConstraintLimits

/** Typed errors thrown by the component (syntax/unsupported/load failures). */
export declare class ConstraintError extends Error {
  code: string
  details: object
}
export declare class ConstraintSyntaxError extends ConstraintError {}
export declare class ConstraintUnsupportedError extends ConstraintError {}
