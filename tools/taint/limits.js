/** Resource and retained-evidence budgets for the Circle-IR adapter. */
export const TAINT_LIMITS = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  timeoutMs: 5000,
  memoryMb: 256,
  maxSources: 200,
  maxSinks: 200,
  maxSanitizers: 100,
  maxFlows: 100,
  maxPathLength: 40,
  maxTextLength: 240,
})

const MAX_LIMITS = Object.freeze({
  maxSourceBytes: 8 * 1024 * 1024,
  timeoutMs: 120_000,
  memoryMb: 4096,
  maxSources: 2000,
  maxSinks: 2000,
  maxSanitizers: 1000,
  maxFlows: 1000,
  maxPathLength: 200,
  maxTextLength: 4096,
})

/** Reject misspelled, non-integer or unbounded limits before starting a worker. */
export function normalizeTaintLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('taint limits must be an object')
  }
  const limits = { ...TAINT_LIMITS }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(TAINT_LIMITS, key)) throw new TypeError(`unknown taint limit: ${key}`)
    const minimum = key === 'memoryMb' ? 32 : key === 'maxPathLength' ? 2 : 1
    if (!Number.isSafeInteger(value) || value < minimum || value > MAX_LIMITS[key]) {
      throw new RangeError(`taint limit ${key} must be an integer from ${minimum} to ${MAX_LIMITS[key]}`)
    }
    limits[key] = value
  }
  return limits
}
