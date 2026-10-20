import { SandboxError } from '../util/errors.js'

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
  /** Timers concurrently scheduled (setTimeout/setInterval/rAF/idle/…). */
  maxTimers: 10_000,
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
  maxTimers: [1, 100_000],
  maxEvents: [0, 1_000_000],
  maxSourceBytes: [1024, 128 * 1024 * 1024],
  maxStageDepth: [1, 32],
}

/**
 * Coerce one limit value and clamp it into its documented range.
 *
 * `undefined`/`null` mean "not provided" and fall through to the default; a
 * numeric string is accepted because CLI/JSON callers forward text. Anything
 * else is a usage error, reported by the caller.
 *
 * @param {unknown} value
 * @returns {number|undefined} finite number, or undefined when unusable
 */
function toLimitNumber(value) {
  if (value === undefined || value === null) return undefined
  // A numeric string is accepted (CLI/JSON callers forward text); any other
  // type is a mistake the caller must hear about.
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(numeric) ? numeric : undefined
}

/**
 * Normalize caller-supplied limits, rejecting typos instead of ignoring them.
 *
 * A mistyped key (`maxEvent`) or a malformed value (`timeoutMs: 'abc'`) used to
 * be dropped silently, so the report showed the default as if the caller had
 * asked for it (audit F5 / D7 "unknown options are usage errors"). The default
 * contract is **strict**: such a call throws a `SandboxError` naming the
 * accepted keys. `strict: false` keeps the old lenient behaviour for callers
 * that forward foreign option bags, and reports each ignored entry through the
 * optional `logger`.
 *
 * @param {object} [input]
 * @param {object} [options]
 * @param {boolean} [options.strict] throw on unknown keys / malformed values (default true)
 * @param {{warn?: Function}} [options.logger] receives one warning per ignored entry
 * @returns {typeof DEFAULT_LIMITS}
 */
export function normalizeLimits(input = {}, options = {}) {
  const { strict = true, logger = null } = options
  const limits = { ...DEFAULT_LIMITS }
  /** @type {string[]} */
  const unknownKeys = []
  /** @type {string[]} */
  const invalidValues = []
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, key)) {
      unknownKeys.push(key)
      continue
    }
    const numeric = toLimitNumber(value)
    if (numeric === undefined) {
      if (value !== undefined && value !== null) invalidValues.push(key)
      continue
    }
    const [min, max] = NUMERIC_BOUNDS[key] ?? [-Infinity, Infinity]
    limits[key] = Math.min(Math.max(numeric, min), max)
  }

  const ignored = [
    ...unknownKeys.map((key) => `unknown limit '${key}'`),
    ...invalidValues.map((key) => `limit '${key}' needs a finite number`),
  ]
  if (ignored.length > 0) {
    const accepted = Object.keys(DEFAULT_LIMITS)
    const message = `${ignored.join('; ')}; accepted limits are ${accepted.join(', ')}`
    if (strict) {
      throw new SandboxError(message, {
        code: 'SANDBOX_LIMITS',
        details: { unknownKeys, invalidValues, accepted },
      })
    }
    for (const reason of ignored) logger?.warn?.({ reason }, 'ignored limit option')
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
