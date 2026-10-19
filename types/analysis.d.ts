/**
 * Declarations for the `ai4reverse-web/analysis` subpath.
 *
 * The composed pipeline (`analyzeSample`), the stable report builder, verdict
 * scoring, IOC extraction, behaviour summaries and staged-payload extraction.
 */

export {
  analyzeSample,
  buildReport,
  renderMarkdown,
  scoreVerdict,
  summarizeBehavior,
  extractIOCs,
  extractFromEvents,
  createArtifactStore,
  extractStagedPayloads,
} from './ai4reverse.js'

export type {
  AnalyzeSampleOptions,
  AnalyzeSampleResult,
  AnalysisReport,
  Verdict,
  VerdictReason,
  IOCResult,
  IocEntry,
  IocOptions,
  ArtifactStore,
} from './ai4reverse.js'

/** How many scored artifacts the extractor keeps as evidence. */
export declare const ARTIFACT_KINDS: readonly string[]

/** Every heuristic weight used by `scoreVerdict`, in one table. */
export declare const VERDICT_WEIGHTS: Readonly<Record<string, number>>

/**
 * Merge IOC sets from the original source, the restored source and the dynamic
 * trace. Entries seen by more than one source carry a `sources` list.
 */
export declare function mergeIocs(
  staticIocs?: IOCResult,
  dynamicIocs?: IOCResult,
  restoredIocs?: IOCResult | null,
): IOCResult

/**
 * Actionable recommendations for one analysis bundle.
 * @returns an array of `{ id, priority, detail }`-shaped entries
 */
export declare function recommend(context: object): { id: string; priority: number; detail: string }[]

/** Kill-chain stages inferred from a behaviour summary. */
export declare function inferKillChain(summary: object): object
