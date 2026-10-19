/**
 * Exception-level instrumentation.
 *
 * QuickJS gives us the uncaught exception at every host boundary
 * (`evalCode`, `callFunction`, promise jobs, timer callbacks) and the AST
 * instrumentation gives us every `catch` clause. Both funnels land here, where
 * the error is sanitised (no host paths, no `<eval>` markers), classified and
 * emitted as one structured event.
 */

export function createExceptionInstrumenter(options) {
  const { bridge, stealth, trace, hooks, logger, maxErrors = 500 } = options
  /** @type {object[]} */
  const uncaught = []
  /** @type {object[]} */
  const caught = []
  /** @type {object[]} */
  const promiseJobs = []
  /** @type {object[]} */
  const thrown = []
  let count = 0

  const sanitize = (error) => {
    if (!error) return { name: 'Error', message: 'unknown error' }
    const base = error instanceof Error ? error : error
    const dumped =
      typeof base === 'object' && base !== null
        ? {
            name: base.name ?? 'Error',
            message: String(base.message ?? ''),
            stack: base.stack,
          }
        : { name: 'Error', message: String(base) }
    return stealth?.sanitizeError ? stealth.sanitizeError(dumped) : dumped
  }

  const store = (bucket, entry) => {
    if (bucket.length < maxErrors) bucket.push(entry)
    count += 1
  }

  return {
    /**
     * An error escaped to the host boundary (or would have killed the sample).
     * @param {unknown} error dumped guest error
     * @param {string} origin 'eval'|'call'|'timer'|'microtask'|'promise-job'|'module'
     * @param {object} [meta]
     */
    reportUncaught(error, origin = 'eval', meta = {}) {
      const sanitized = sanitize(error)
      const entry = { ...sanitized, origin, ...meta, at: trace?.events?.length ?? 0 }
      store(uncaught, entry)
      trace?.emit('exception', 'uncaught', { origin, error: sanitized, ...meta })
      hooks?.emit('exception:uncaught', { error: sanitized, origin, ...meta })
      logger?.debug?.({ origin, name: sanitized.name, message: sanitized.message }, 'uncaught exception')
      return entry
    },

    /**
     * An error was caught by guest code (reported by the AST catch
     * instrumentation, which cannot alter control flow).
     * @param {unknown} error dumped guest error value
     * @param {object} [meta] instrumentation site
     */
    reportCaught(error, meta = {}) {
      const sanitized = sanitize(error)
      const entry = { ...sanitized, ...meta }
      store(caught, entry)
      trace?.emit('exception', 'catch', { error: sanitized, site: meta })
      hooks?.emit('exception:catch', { error: sanitized, site: meta })
      return entry
    },

    /**
     * A `throw` statement executed (reported before the stack unwinds).
     * Complements `reportCaught`, which fires only if the throw is caught.
     * @param {unknown} error
     * @param {object} [meta]
     */
    reportThrown(error, meta = {}) {
      const sanitized = sanitize(error)
      const entry = { ...sanitized, ...meta }
      store(thrown, entry)
      trace?.emit('exception', 'throw', { error: sanitized, site: meta })
      hooks?.emit('exception:throw', { error: sanitized, site: meta })
      return entry
    },

    /** An unhandled rejection surfaced by the promise job queue. */
    reportPromiseJob(error, meta = {}) {
      const sanitized = sanitize(error)
      const entry = { ...sanitized, ...meta }
      store(promiseJobs, entry)
      trace?.emit('exception', 'error', { origin: 'promise-job', error: sanitized, ...meta })
      hooks?.emit('exception:uncaught', { error: sanitized, origin: 'promise-job', ...meta })
      return entry
    },

    /** Thrown error from a hook or platform boundary. */
    reportBoundary(error, meta = {}) {
      const sanitized = sanitize(error)
      trace?.emit('exception', 'error', { origin: 'boundary', error: sanitized, ...meta })
      return sanitized
    },

    list() {
      return { uncaught: [...uncaught], caught: [...caught], thrown: [...thrown], promiseJobs: [...promiseJobs] }
    },

    stats() {
      return {
        total: count,
        uncaught: uncaught.length,
        caught: caught.length,
        thrown: thrown.length,
        promiseJobs: promiseJobs.length,
      }
    },

    sanitize,
  }
}
