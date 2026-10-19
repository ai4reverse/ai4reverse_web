/**
 * Barrel for the utility subpath (`ai4reverse-web/util`).
 *
 * These helpers are shared by every layer: typed errors, hashing, seeded
 * randomness, timezone data and disposal order. They are re-exported because
 * consumers that write their own passes or sinks need the same primitives.
 */
export { AnalyzerError, SandboxError, ParseError, HookError } from './errors.js'
export { sha256, shortHash, stableStringify, hashObject } from './hash.js'
export { hashSeed, mulberry32, createSeededRandom, seededPick } from './random.js'
export { timezoneOffsetMinutesAt, instantFromLocalFields } from './timezone.js'
export { withHandles, HandleBag, disposeAll } from './disposable.js'
