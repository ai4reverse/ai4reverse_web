/**
 * Declarations for the `ai4reverse-web/restore` subpath.
 *
 * One parse, one pass chain, one generate. `restore()` is the pipeline;
 * `restoreWithPass()` runs a single pass; `validateOutput()` is the re-parse
 * gate the pipeline uses before returning code.
 */

export {
  restore,
  restoreWithPass,
  parse,
  generate,
  listPasses,
  selectPasses,
  PASSES,
} from './ai4reverse.js'

export type {
  RestoreOptions,
  RestoreResult,
  RestorePass,
  RestorePassReport,
  RestoreStats,
  PassContext,
  PassListing,
  PassMeta,
  PassRunReport,
  ParseOptions,
  ParseResult,
  GenerateResult,
} from './ai4reverse.js'

/**
 * True when a pass is deferred to the final pipeline round.
 *
 * Deferral comes from `pass.meta.deferred`; the `rename` id is the fallback for
 * passes that do not declare the flag yet.
 */
export declare function isDeferredPass(pass: { meta?: { id?: string; deferred?: boolean } }): boolean

/**
 * True when `code` re-parses cleanly with the pipeline's own parser.
 *
 * `restore()` uses the detailed form internally: text that only parses after
 * babel's error recovery is rejected, because recovery means the generated
 * text still contains a syntax error.
 */
export declare function validateOutput(code: string, options?: import('./ai4reverse.js').ParseOptions): boolean
