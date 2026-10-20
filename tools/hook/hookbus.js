/**
 * Hook bus with explicit, auditable phases.
 *
 * The "traceless" requirement is a property of the *engine*, not of individual
 * hooks: a hook is traceless when it (a) never adds a guest-visible binding,
 * (b) preserves function identity/name/length/toString, (c) preserves stack
 * shape, and (d) answers consistently with the rest of the emulated
 * environment. The bus records those guarantees per registration so a report
 * can state exactly which hooks were active and what footprint they declared.
 *
 * Phases are namespaced `domain:event`:
 *   code:before         rewrite source before compilation
 *   code:after          observe compiled/executed source + result
 *   code:error          observe compile/eval failure
 *   code:step           per-statement/loop instrumentation probe (very high volume)
 *   api:before          inspect/intercept a guest-visible API call
 *   api:after           observe a completed API call
 *   api:error           observe a throwing API call
 *   exception:throw     observe a throw site (AST-instrumented)
 *   exception:catch     observe a caught error
 *   exception:uncaught  observe an error escaping to the host boundary
 *   ast:enter / ast:exit / ast:node / ast:transform
 *   jsvmp:opcode / jsvmp:step / jsvmp:enter / jsvmp:exit
 *   lifecycle:init / lifecycle:run / lifecycle:dispose
 */

import { HookError } from '../util/errors.js'

export const HOOK_PHASES = Object.freeze([
  'code:before',
  'code:after',
  'code:error',
  'code:step',
  'api:before',
  'api:after',
  'api:error',
  'exception:throw',
  'exception:catch',
  'exception:uncaught',
  'ast:enter',
  'ast:exit',
  'ast:node',
  'ast:transform',
  'jsvmp:enter',
  'jsvmp:opcode',
  'jsvmp:step',
  'jsvmp:exit',
  'lifecycle:init',
  'lifecycle:run',
  'lifecycle:dispose',
])

const MUTATING_PHASES = new Set(['code:before', 'ast:transform', 'api:before', 'ast:node'])

/**
 * Hook phases that never produce their own `hook` trace event.
 *
 * `code:step` fires once per instrumented statement/loop iteration, so a tight
 * loop drowns the trace budget in no-op bookkeeping records. The information is
 * already carried by the `code` events the same probe emits; keeping the phase
 * dispatchable (hooks may still subscribe) but untraced keeps the evidence.
 */
const UNTRACED_PHASES = new Set(['code:step'])

/**
 * How many hook failures are retained for `stats()`. A sample with a broken
 * hook can fail once per guest statement; unbounded growth would make a long
 * analysis alloc-retained forever.
 */
const MAX_HOOK_ERRORS = 200

/**
 * Total characters of hook-failure messages retained for `stats()`.
 *
 * A count-only bound is not a memory bound: 200 entries carrying a megabyte
 * stack each retain ~200 MB, and the audit measured up to ~838 MB with real
 * large messages. 64 KiB keeps `stats()` useful while making the ring's
 * footprint independent of message size.
 */
const MAX_HOOK_ERROR_CHARS = 64 * 1024

/** Per-message cap; the head of a message carries the diagnosis, not the tail. */
const MAX_HOOK_ERROR_MESSAGE = 2 * 1024

/**
 * @typedef {object} HookRegistration
 * @property {string} id
 * @property {string} phase
 * @property {(payload: any, context: any) => any} handler
 * @property {number} priority
 * @property {boolean} once
 * @property {string} owner
 * @property {object} traceless  declared footprint
 */

/**
 * @param {object} [options]
 * @param {import('pino').Logger} [options.logger]
 * @param {{emit: Function}} [options.trace]
 * @param {boolean} [options.strict] throw on unknown phases
 * @param {boolean} [options.record] emit hook trace events
 */
export function createHookBus(options = {}) {
  const { logger, trace, strict = false, record = true, recordPhases = null } = options
  const shouldRecord = (phase) => {
    if (!record) return false
    // An explicit `recordPhases` allow-list wins: it is an opt-in request.
    if (recordPhases) return recordPhases.some((prefix) => phase.startsWith(prefix))
    // High-frequency AST/step phases are already represented by their own
    // trace events; re-recording them doubles log volume for no insight.
    if (UNTRACED_PHASES.has(phase)) return false
    return !phase.startsWith('ast:') && !phase.startsWith('jsvmp:')
  }

  /** @type {Map<string, HookRegistration[]>} */
  const registry = new Map()
  /** @type {Map<string, object>} */
  const context = new Map()
  let nextId = 1
  let dispatchCount = 0
  /**
   * Bounded ring of hook failures, capped by count *and* by total message
   * characters; `errorsTruncated` says entries were dropped.
   */
  const errors = []
  let errorChars = 0
  let errorsTruncated = false

  function normalizePhase(phase) {
    if (phase === '*') return phase
    if (typeof phase !== 'string' || !phase.includes(':')) {
      throw new HookError(`hook phase must look like "domain:event", got ${String(phase)}`)
    }
    if (strict && !HOOK_PHASES.includes(phase) && !phase.endsWith(':*')) {
      throw new HookError(`unknown hook phase: ${phase}`, { details: { known: HOOK_PHASES } })
    }
    return phase
  }

  function matching(phase) {
    const [domain] = phase.split(':')
    return [
      ...(registry.get(phase) ?? []),
      ...(registry.get(`${domain}:*`) ?? []),
      ...(registry.get('*') ?? []),
    ].sort((a, b) => b.priority - a.priority || a.seq - b.seq)
  }

  /**
   * Enabled registrations for `phase`, in dispatch order.
   * Callers use the length to skip the bookkeeping (trace event, dispatch
   * counter) when nothing is listening. `code:step` fires thousands of times
   * per run, so an unlistened phase must cost no more than one Map lookup.
   */
  function enabledFor(phase) {
    const candidates = matching(phase)
    if (candidates.length === 0) return candidates
    return candidates.filter((registration) => registration.enabled)
  }

  const bus = {
    /**
     * Register a hook.
     * @param {string} phase
     * @param {(payload: any, context: any) => any} handler
     * @param {object} [opts]
     * @param {number} [opts.priority] higher runs first
     * @param {string} [opts.id]
     * @param {boolean} [opts.once]
     * @param {string} [opts.owner]
     * @param {object} [opts.traceless] declared footprint guarantees
     * @returns {() => void} unsubscribe
     */
    on(phase, handler, opts = {}) {
      if (typeof handler !== 'function') throw new HookError('hook handler must be a function')
      const normalized = normalizePhase(phase)
      const registration = {
        id: opts.id ?? `${normalized}#${nextId++}`,
        phase: normalized,
        handler,
        priority: opts.priority ?? 0,
        once: Boolean(opts.once),
        owner: opts.owner ?? 'anonymous',
        seq: nextId++,
        traceless: {
          addsGlobals: false,
          preservesIdentity: true,
          preservesStack: true,
          consistentAnswers: true,
          ...(opts.traceless ?? {}),
        },
        enabled: true,
      }
      const list = registry.get(normalized) ?? []
      list.push(registration)
      registry.set(normalized, list)
      context.set(registration.id, opts.context ?? {})
      return () => bus.off(registration.id)
    },

    /** @param {string} id */
    off(id) {
      for (const [phase, list] of registry) {
        const index = list.findIndex((registration) => registration.id === id)
        if (index >= 0) {
          list.splice(index, 1)
          if (list.length === 0) registry.delete(phase)
          context.delete(id)
          return true
        }
      }
      return false
    },

    /** Remove every hook (optionally only those owned by `owner`). */
    clear(owner) {
      for (const [phase, list] of registry) {
        const kept = owner ? list.filter((registration) => registration.owner !== owner) : []
        if (kept.length > 0) registry.set(phase, kept)
        else registry.delete(phase)
      }
    },

    /** @param {string} id */
    setEnabled(id, enabled) {
      for (const list of registry.values()) {
        for (const registration of list) {
          if (registration.id === id) {
            registration.enabled = enabled
            return true
          }
        }
      }
      return false
    },

    has(phase) {
      return matching(phase).some((registration) => registration.enabled)
    },

    /**
     * Observer dispatch: return values are ignored; payload is passed by
     * reference and may be enriched by handlers.
     * @param {string} phase
     * @param {object} payload
     * @param {object} [extraContext]
     */
    emit(phase, payload = {}, extraContext = {}) {
      // Validate first: a strict bus must reject unknown phases even when no
      // hook is listening for them.
      const normalized = normalizePhase(phase)
      const registrations = enabledFor(normalized)
      if (registrations.length === 0) return { phase: normalized, results: [] }
      const runContext = { phase: normalized, bus, logger, trace, ...extraContext }
      const results = []
      for (const registration of registrations) {
        try {
          const result = registration.handler(payload, { ...runContext, hook: registration })
          results.push({ id: registration.id, result })
          if (registration.once) bus.off(registration.id)
          if (result && result.stop === true) break
        } catch (error) {
          recordHookError(registration, error)
        }
      }
      dispatchCount += 1
      if (trace && shouldRecord(normalized)) {
        // The trace phase is the transport, not the hook phase: hook phases
        // include lifecycle names (`init`, `run`, `dispose`) that are not trace
        // phases, so forwarding them made a strict recorder throw. The hook
        // phase travels in `hook` (the event envelope owns `phase`).
        trace.emit('hook', 'emit', { phase: normalized, hook: normalized })
      }
      return { phase: normalized, results }
    },

    /**
     * Interception dispatch for `api:before`.
     *
     * Handlers may return:
     *   `{ block: value }`  short-circuit, return `value` to the guest
     *   `{ args: [...] }`   replace call arguments
     *   `{ replace: value }`replace the whole result
     *   `false`             explicitly allow and stop further handlers
     *
     * @param {string} phase
     * @param {object} payload
     * @param {object} [extraContext]
     */
    dispatch(phase, payload = {}, extraContext = {}) {
      const normalized = normalizePhase(phase)
      const registrations = enabledFor(normalized)
      if (registrations.length === 0) {
        // Neutral decision: same shape as a dispatch nobody intercepted, so
        // callers that read `.blocked`/`.args` keep working.
        return { blocked: false, value: undefined, args: undefined, stopped: false, results: [], phase: normalized }
      }
      const runContext = { phase: normalized, bus, logger, trace, ...extraContext }
      const results = []
      let blocked = false
      let value
      let args
      let stopped = false

      for (const registration of registrations) {
        try {
          const result = registration.handler(payload, { ...runContext, hook: registration })
          results.push({ id: registration.id, result })
          if (registration.once) bus.off(registration.id)
          if (result === false) {
            stopped = true
            break
          }
          if (result && typeof result === 'object') {
            if ('block' in result) {
              blocked = true
              value = result.block
              stopped = true
              break
            }
            if ('args' in result && Array.isArray(result.args)) args = result.args
            if ('replace' in result) {
              blocked = true
              value = result.replace
              stopped = true
              break
            }
            if (result.stop === true) {
              stopped = true
              break
            }
          }
        } catch (error) {
          recordHookError(registration, error)
        }
      }

      dispatchCount += 1
      if (trace && shouldRecord(normalized)) {
        trace.emit('hook', 'emit', {
          phase: normalized,
          hook: normalized,
          hooks: results.length,
          blocked,
          stopped,
        })
      }
      return { blocked, value, args, stopped, results, phase: normalized }
    },

    /**
     * Transform pipeline for mutating phases (`code:before`, `ast:transform`).
     * Each handler receives `(value, context)` and returns the new value or
     * `undefined` to leave it unchanged.
     *
     * @template T
     * @param {string} phase
     * @param {T} initial
     * @param {object} [extraContext]
     * @returns {{value: T, changed: boolean, steps: object[]}}
     */
    pipeline(phase, initial, extraContext = {}) {
      const normalized = normalizePhase(phase)
      if (!MUTATING_PHASES.has(normalized) && !normalized.endsWith(':*')) {
        throw new HookError(`phase ${normalized} is not a transform phase`, {
          details: { mutating: [...MUTATING_PHASES] },
        })
      }
      const runContext = { phase: normalized, bus, logger, trace, ...extraContext }
      let value = initial
      let changed = false
      const steps = []
      const registrations = enabledFor(normalized)
      // Same rule as `emit`/`dispatch`: an unlistened transform is not evidence.
      if (registrations.length === 0) return { value, changed, steps }
      for (const registration of registrations) {
        try {
          const result = registration.handler(value, { ...runContext, hook: registration })
          if (registration.once) bus.off(registration.id)
          if (result !== undefined && result !== null) {
            if (result !== value) changed = true
            value = result
            steps.push({ id: registration.id, changed: true })
          } else {
            steps.push({ id: registration.id, changed: false })
          }
          if (result && result.stop === true) break
        } catch (error) {
          recordHookError(registration, error)
        }
      }
      dispatchCount += 1
      if (trace && shouldRecord(normalized)) {
        trace.emit('hook', 'transform', {
          phase: normalized,
          hook: normalized,
          changed,
          hooks: steps.length,
        })
      }
      return { value, changed, steps }
    },

    /** Introspection for reports. */
    describe() {
      const out = []
      for (const [phase, list] of registry) {
        for (const registration of list) {
          out.push({
            id: registration.id,
            phase,
            priority: registration.priority,
            owner: registration.owner,
            enabled: registration.enabled,
            traceless: registration.traceless,
          })
        }
      }
      return out
    },

    stats() {
      return {
        hooks: bus.describe().length,
        dispatches: dispatchCount,
        errors: errors.slice(),
        errorsTruncated,
        byPhase: Object.fromEntries(
          [...registry].map(([phase, list]) => [phase, list.length]),
        ),
      }
    },
  }

  function recordHookError(registration, error) {
    const entry = {
      hook: registration.id,
      phase: registration.phase,
      message: clipMessage(error?.message ?? String(error)),
    }
    errors.push(entry)
    errorChars += entry.message.length
    // Keep the newest failures; the ring is bounded by count *and* by total
    // message size, so neither many failures nor very large messages can grow
    // the sandbox's memory without limit.
    while (errors.length > MAX_HOOK_ERRORS || (errorChars > MAX_HOOK_ERROR_CHARS && errors.length > 1)) {
      const dropped = errors.shift()
      errorChars -= dropped.message.length
      errorsTruncated = true
    }
    if (logger) logger.warn({ hook: entry }, 'hook failed; continuing')
  }

  return bus
}

/**
 * Bound one failure message. The marker keeps the original length visible, so a
 * report can state that it was clipped instead of silently losing context.
 * @param {unknown} message
 */
function clipMessage(message) {
  const text = String(message)
  if (text.length <= MAX_HOOK_ERROR_MESSAGE) return text
  return `${text.slice(0, MAX_HOOK_ERROR_MESSAGE)}…[${text.length}]`
}
