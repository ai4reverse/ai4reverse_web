import { Worker } from 'node:worker_threads'
import { validateTaintConfig } from './config.js'
import { normalizeTaintLimits } from './limits.js'
import { normalizeTaintReport } from './report.js'

export function normalizeTaintOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('taint options must be an object')
  const allowed = ['filename', 'language', 'limits', 'config', 'useDefaultConfig', 'speculativeParamSources']
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new TypeError(`unknown taint option: ${key}`)
  }
  const filename = options.filename === undefined ? 'sample.js' : options.filename
  if (typeof filename !== 'string' || !filename.length || filename.length > 4096) throw new TypeError('taint filename must be a non-empty string of at most 4096 characters')
  const language = options.language === undefined
    ? (/\.tsx$/i.test(filename) ? 'tsx' : /\.(?:ts|mts|cts)$/i.test(filename) ? 'typescript' : 'javascript')
    : options.language
  if (!['javascript', 'typescript', 'tsx'].includes(language)) throw new TypeError('taint language must be javascript, typescript or tsx')
  for (const key of ['useDefaultConfig', 'speculativeParamSources']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(`taint ${key} must be boolean`)
  }
  const config = options.config === undefined ? {} : options.config
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    // A prototype-inherited pattern set would be dropped by structuredClone
    // after passing validation, so reject it instead of analyzing less than
    // the caller asked for.
    const prototype = Object.getPrototypeOf(config)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('taint config must be a plain object')
    }
  }
  let cloned
  try {
    cloned = structuredClone(config)
  } catch (error) {
    throw new TypeError(`taint config must be structured-cloneable: ${error.message}`)
  }
  // Validate the clone that will actually be sent to the worker, so an
  // accessor cannot return a different value to validation and execution.
  validateTaintConfig(cloned)
  return {
    filename,
    language,
    config: cloned,
    useDefaultConfig: options.useDefaultConfig !== false,
    speculativeParamSources: options.speculativeParamSources === true,
    limits: normalizeTaintLimits(options.limits),
  }
}

/**
 * Circle-IR 4.17.0 replaces every line longer than this many UTF-16 code units
 * with an empty line before parsing, without reporting it in `parse_status`.
 * The adapter must detect that loss itself or a minified one-line sample would
 * report a clean, complete scan with zero evidence.
 */
export const TAINT_MAX_LINE_LENGTH = 10_000

/** Count lines Circle-IR would silently drop. Mirrors its LF-only scan. */
export function countOverlongLines(source, max = TAINT_MAX_LINE_LENGTH) {
  let count = 0
  let start = 0
  for (let i = 0; i <= source.length; i += 1) {
    if (i !== source.length && source.charCodeAt(i) !== 10) continue
    if (i - start > max) count += 1
    start = i + 1
  }
  return count
}

/**
 * Map a Worker failure onto the public failure code and truncation reasons.
 * Exported so the OOM/exit mapping is testable without provoking a real OOM.
 * @param {unknown} error
 * @returns {{ code: string, message: string, truncatedBy: string[] }}
 */
export function classifyWorkerFailure(error) {
  const outOfMemory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
  return {
    code: outOfMemory ? 'TAINT_MEMORY' : 'TAINT_ENGINE',
    message: String(error?.message ?? error ?? 'Circle-IR worker failed'),
    truncatedBy: outOfMemory ? ['memory'] : [],
  }
}

/**
 * A Worker that exits before posting a report is an explicit failure; it must
 * never be presented as a successful scan with zero flows.
 * @param {number} code
 * @returns {{ code: string, message: string, truncatedBy: string[] }}
 */
export function workerExitFailure(code) {
  return {
    code: 'TAINT_WORKER_EXIT',
    message: `Circle-IR worker exited without a report (exit ${code})`,
    truncatedBy: [],
  }
}

/**
 * Static Circle-IR taint analysis of one JavaScript/TypeScript source string.
 * Never evaluates the sample or resolves its imports. Engine failures and
 * budgets yield an explicit failed/partial report; invalid options throw.
 * @param {string} source
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function analyzeTaint(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('analyzeTaint requires a source string')
  const settings = normalizeTaintOptions(options)
  const startedAt = Date.now()
  const base = { ...settings, enabled: true }
  const failure = (code, message, truncatedBy = []) => normalizeTaintReport({
    ...base,
    error: { code, message },
    truncatedBy,
    elapsedMs: Date.now() - startedAt,
  })
  // Never analyze a prefix of a program and present it as a complete scan.
  if (Buffer.byteLength(source) > settings.limits.maxSourceBytes) {
    return failure('TAINT_SOURCE_LIMIT', 'Source exceeds the taint analysis byte limit; no analysis was performed', ['source-size'])
  }
  const overlong = countOverlongLines(source)
  if (overlong > 0) {
    return failure(
      'TAINT_SOURCE_LAYOUT',
      `Circle-IR blanks lines longer than ${TAINT_MAX_LINE_LENGTH} characters; ${overlong} line(s) exceed the limit and no analysis was performed`,
      ['overlong-line'],
    )
  }
  // A separate isolate is required: Circle-IR is synchronous after parser
  // initialization, so Promise.race cannot interrupt a pathological sample.
  return new Promise((resolve) => {
    let worker
    let timer
    let finished = false
    const finish = (report) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      // Join termination before resolving, including error/timeout paths.
      Promise.resolve(worker?.terminate()).catch(() => {}).then(() => resolve(report))
    }
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { source, options: settings },
        // Do not inherit --input-type, test flags, preload hooks or loaders.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: settings.limits.memoryMb },
        stdout: true,
        stderr: true,
      })
      // Third-party diagnostics must not corrupt CLI JSON or expose unbounded
      // buffers. The structured result is the only supported output channel.
      worker.stdout.resume()
      worker.stderr.resume()
      timer = setTimeout(() => finish(failure('TAINT_TIMEOUT', 'Circle-IR analysis exceeded its wall-clock budget', ['timeout'])), settings.limits.timeoutMs)
      worker.once('message', (message) => {
        if (message?.report) finish(normalizeTaintReport({ ...message.report, elapsedMs: Date.now() - startedAt }))
        else finish(failure(message?.error?.code ?? 'TAINT_ENGINE', message?.error?.message ?? 'Circle-IR returned no report'))
      })
      worker.once('error', (error) => {
        const mapped = classifyWorkerFailure(error)
        finish(failure(mapped.code, mapped.message, mapped.truncatedBy))
      })
      worker.once('exit', (code) => {
        if (finished) return
        const mapped = workerExitFailure(code)
        finish(failure(mapped.code, mapped.message, mapped.truncatedBy))
      })
    } catch (error) {
      finish(failure('TAINT_ENGINE', error.message))
    }
  })
}
