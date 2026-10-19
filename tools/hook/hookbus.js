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
    if (recordPhases) return recordPhases.some((prefix) => phase.startsWith(prefix))
    // High-frequency AST/step phases are already represented by their own
    // trace events; re-recording them doubles log volume for no insight.
    return !phase.startsWith('ast:') && !phase.startsWith('jsvmp:')
  }

  /** @type {Map<string, HookRegistration[]>} */
  const registry = new Map()
  /** @type {Map<string, object>} */
  const context = new Map()
  let nextId = 1
  let dispatchCount = 0
  const errors = []

  const keyFor = (phase) => phase

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
      const runContext = { phase, bus, logger, trace, ...extraContext }
      const results = []
      for (const registration of matching(normalizePhase(phase))) {
        if (!registration.enabled) continue
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
      if (trace && shouldRecord(phase)) trace.emit('hook', phase.split(':')[1] ?? 'emit', { phase, hook: phase })
      return { phase, results }
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
      const runContext = { phase, bus, logger, trace, ...extraContext }
      const results = []
      let blocked = false
      let value
      let args
      let stopped = false

      for (const registration of matching(normalizePhase(phase))) {
        if (!registration.enabled) continue
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
      if (trace && shouldRecord(phase)) {
        trace.emit('hook', phase.split(':')[1] ?? 'emit', {
          phase,
          hooks: results.length,
          blocked,
          stopped,
        })
      }
      return { blocked, value, args, stopped, results, phase }
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
      for (const registration of matching(normalized)) {
        if (!registration.enabled) continue
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
        trace.emit('hook', 'transform', { phase: normalized, changed, hooks: steps.length })
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
        errors: errors.slice(-20),
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
      message: error?.message ?? String(error),
    }
    errors.push(entry)
    if (logger) logger.warn({ hook: entry }, 'hook failed; continuing')
  }

  return bus
}
