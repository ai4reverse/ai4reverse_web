/**
 * Declarations for the `ai4reverse-web/util` subpath.
 *
 * The primitives every layer shares: typed errors, hashing, seeded randomness,
 * timezone maths and handle disposal.
 */

export type { AnalyzerErrorOptions, SeededRandom } from './ai4reverse.js'

/**
 * Base class of every typed platform error.
 *
 * `code` is a stable string (`SANDBOX_ERROR`, `PARSE_ERROR`, `HOOK_ERROR`, ...)
 * so a caller can branch without matching messages.
 */
export declare class AnalyzerError extends Error {
  code: string
  details: object
  constructor(message: string, options?: import('./ai4reverse.js').AnalyzerErrorOptions)
}

export declare class SandboxError extends AnalyzerError {}

export declare class ParseError extends AnalyzerError {}

export declare class HookError extends AnalyzerError {}

export declare class TrustError extends AnalyzerError {}

/**
 * LIFO bag of QuickJS handles.
 *
 * `add()` registers a handle for disposal, `keep()` removes it from the bag when
 * ownership has been transferred (for example by `ctx.setProp`, which consumes
 * the value handle).
 */
export declare class HandleBag {
  readonly size: number
  add<H>(handle: H): H
  keep<H>(handle: H): H
  dispose(): void
}

/** Run `fn` with a fresh bag and dispose everything it registered. */
export declare function withHandles<T>(fn: (bag: HandleBag) => T): T

/** Dispose every value that has a `dispose()` method, ignoring failures. */
export declare function disposeAll(...values: unknown[]): void

export declare function sha256(data: string | Uint8Array): string

export declare function shortHash(data: unknown, length?: number): string

export declare function stableStringify(value: unknown): string

export declare function hashObject(value: unknown): string

/** Deterministic 32-bit seed for any scalar. */
export declare function hashSeed(seed: number | string): number

/** Uniform PRNG in `[0, 1)` for a numeric seed. */
export declare function mulberry32(seed: number | string): () => number

export declare function createSeededRandom(seed: number | string): import('./ai4reverse.js').SeededRandom

/** Deterministic, order-stable pick from `items`. */
export declare function seededPick<T>(items: T[], seed: string | number, label: string): T

/** `Date#getTimezoneOffset()`-style minutes for one instant, or `NaN`. */
export declare function timezoneOffsetMinutesAt(timeZone: string, instant: number): number

/** Epoch milliseconds for local wall-clock fields in `timeZone`. */
export declare function instantFromLocalFields(timeZone: string, fields: number[]): number
