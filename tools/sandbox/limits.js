/**
 * Execution limits. Every limit is enforced; none is decorative.
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** Host wall-clock deadline for a single invocation. */
  timeoutMs: 5000,
  /** Virtual milliseconds the guest may experience (drives timer loops). */
  maxVirtualMs: 60_000,
  /** Virtual ms added to the clock per interrupt check, making timing plausible. */
  interruptQuantumMs: 0.02,
  /** QuickJS heap limit. */
  memoryBytes: 64 * 1024 * 1024,
  /** QuickJS stack limit. */
  stackBytes: 1024 * 1024,
  /** Pending promise jobs drained per run. */
  maxJobs: 10_000,
  /** Timer callbacks executed per run. */
  maxTimerCallbacks: 1000,
  /** Retained trace events (0 = unbounded). */
  maxEvents: 20_000,
  /** Maximum number of source bytes analysed in one run. */
  maxSourceBytes: 8 * 1024 * 1024,
  /** Recursion guard for nested payload staging (eval inside eval). */
  maxStageDepth: 5,
})

const NUMERIC_BOUNDS = {
  timeoutMs: [50, 600_000],
  maxVirtualMs: [100, 86_400_000],
  interruptQuantumMs: [0.001, 10],
  memoryBytes: [1024 * 1024, 1024 * 1024 * 1024],
  stackBytes: [64 * 1024, 16 * 1024 * 1024],
  maxJobs: [1, 1_000_000],
  maxTimerCallbacks: [1, 100_000],
  maxEvents: [0, 1_000_000],
  maxSourceBytes: [1024, 128 * 1024 * 1024],
  maxStageDepth: [1, 32],
}

/**
 * @param {object} [input]
 * @returns {typeof DEFAULT_LIMITS}
 */
export function normalizeLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in DEFAULT_LIMITS)) continue
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) continue
    const [min, max] = NUMERIC_BOUNDS[key] ?? [-Infinity, Infinity]
    limits[key] = Math.min(Math.max(numeric, min), max)
  }
  return limits
}

/**
 * Human-readable description of a limit breach.
 * @param {'timeout'|'virtual-time'|'memory'|'stack'|'source-size'} kind
 * @param {object} limits
 */
export function limitMessage(kind, limits) {
  switch (kind) {
    case 'timeout':
      return `execution exceeded host timeout of ${limits.timeoutMs}ms`
    case 'virtual-time':
      return `execution exceeded virtual time budget of ${limits.maxVirtualMs}ms`
    case 'memory':
      return `execution exceeded memory limit of ${limits.memoryBytes} bytes`
    case 'stack':
      return `execution exceeded stack limit of ${limits.stackBytes} bytes`
    case 'source-size':
      return `sample exceeds maximum source size of ${limits.maxSourceBytes} bytes`
    default:
      return 'execution limit exceeded'
  }
}
