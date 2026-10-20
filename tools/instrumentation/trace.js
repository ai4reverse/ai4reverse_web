/**
 * Structured, deterministic trace recorder.
 *
 * The recorder is the single funnel for every observation produced by the
 * sandbox, the instrumentation layers and the hooks. Keeping one schema means
 * a report can be rebuilt from a log file alone, which is what makes the
 * platform auditable and reproducible.
 *
 * Events are plain JSON. They never contain quickjs handles, functions or
 * host objects, because those cannot be serialised and would bind the log to a
 * dead runtime.
 */

export const TRACE_KINDS = Object.freeze([
  'sandbox',
  'code',
  'api',
  'exception',
  'ast',
  'jsvmp',
  'dom',
  'net',
  'storage',
  'timer',
  'eval',
  'hook',
  'ioc',
  'restore',
])

/**
 * Every phase the platform emits. Kept complete on purpose: a strict recorder
 * rejects exactly the phases that do not exist, so an omission here would
 * turn a real event into a crash and a stale entry would bless a typo.
 */
export const TRACE_PHASES = Object.freeze([
  'emit',
  'before',
  'after',
  'invoke',
  'enter',
  'exit',
  'step',
  'transform',
  'skip',
  'error',
  'throw',
  'catch',
  'uncaught',
])

/**
 * @typedef {object} TraceEvent
 * @property {number} seq
 * @property {number} t virtual epoch ms
 * @property {number} wall host wall clock ms
 * @property {string} kind
 * @property {string} phase
 * @property {string} actor
 */

/**
 * @param {object} [options]
 * @param {number} [options.limit] max retained events (0 = unbounded)
 * @param {() => number} [options.clock] virtual clock in ms
 * @param {(event: TraceEvent) => void} [options.sink] pino sink
 * @param {string} [options.actor]
 */
export function createTraceRecorder(options = {}) {
  const {
    limit = 0,
    clock = () => Date.now(),
    sink = null,
    actor = 'instrumentation',
    strict = false,
  } = options

  /** @type {TraceEvent[]} */
  const events = []
  // Ring bookkeeping: `head` is the index of the oldest retained event, so the
  // logical window is `events[head..]`. Eviction advances `head` instead of
  // `shift()`ing every remaining event forward (O(window) per emit once the
  // buffer is full); the dead prefix is reclaimed in one memmove per `limit`
  // events, which keeps emit O(1) amortized.
  let head = 0
  const counts = new Map()
  const listeners = new Set()
  let seq = 0
  let dropped = 0

  const recorder = {
    get events() {
      // Only reads after the first eviction pay for a copy; before that the
      // live array is handed out exactly as before.
      return head === 0 ? events : events.slice(head)
    },
    get size() {
      return events.length - head
    },
    get dropped() {
      return dropped
    },
    get seq() {
      return seq
    },

    /**
     * @param {string} kind
     * @param {string} phase
     * @param {object} [payload]
     * @returns {TraceEvent|null}
     */
    emit(kind, phase, payload = {}) {
      // `kind` is a code-level constant from TRACE_KINDS, never guest data, so
      // an unknown kind is a programming error in every mode. It is validated
      // before anything is mutated: a rejected event must not advance the
      // sequence or pollute the counters.
      if (!TRACE_KINDS.includes(kind)) throw new Error(`unknown trace kind: ${kind}`)
      if (strict) {
        // Phases are stricter than kinds on purpose: non-strict callers (the
        // guest trace hook) may pass a descriptive phase string, while strict
        // mode must reject exactly the phases that do not exist.
        if (!TRACE_PHASES.includes(phase)) throw new Error(`unknown trace phase: ${phase}`)
      }
      seq += 1
      /** @type {TraceEvent} */
      // Payload first: a payload key named `kind`/`phase`/`seq` must never
      // clobber the event envelope.
      const safe = sanitizePayload(payload)
      const event = {
        ...safe,
        seq,
        t: clock(),
        wall: Date.now(),
        kind,
        phase,
        actor: safe.actor ?? actor,
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1)

      if (limit > 0 && events.length - head >= limit) {
        head += 1
        dropped += 1
      }
      events.push(event)
      if (head > 0 && head >= limit) {
        // One O(window) memmove per `limit` events instead of one O(window)
        // shift per event; `head > 0` implies `limit > 0`.
        events.copyWithin(0, head)
        events.length -= head
        head = 0
      }

      if (sink) {
        try {
          sink.write(event)
        } catch {
          /* a failing sink must never break analysis */
        }
      }
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          /* ditto */
        }
      }
      return event
    },

    /**
     * Recorder pre-bound to a kind (and optionally a phase).
     * @param {string} kind
     * @param {string} [phase]
     */
    child(kind, phase = 'emit') {
      return {
        emit: (nextPhase, payload) => recorder.emit(kind, nextPhase ?? phase, payload),
        child: (subKind, subPhase) => recorder.child(`${kind}.${subKind}`, subPhase ?? phase),
        get events() {
          return recorder.events
        },
        subscribe: recorder.subscribe,
        stats: recorder.stats,
      }
    },

    /** @param {(event: TraceEvent) => void} listener */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Return all events and clear the retained buffer (counters are kept). */
    drain() {
      const copy = events.slice(head)
      events.length = 0
      head = 0
      return copy
    },

    stats() {
      return {
        total: seq,
        retained: events.length - head,
        dropped,
        byKind: Object.fromEntries(counts),
      }
    },

    clear() {
      events.length = 0
      head = 0
      counts.clear()
      seq = 0
      dropped = 0
    },
  }

  return recorder
}

const MAX_STRING = 2048
const MAX_DEPTH = 5

/**
 * Make a payload safe for JSON logging: bound depth, string length and array
 * length; describe functions/handles by name instead of leaking them.
 * @param {unknown} payload
 * @param {number} [depth]
 */
/** Array payloads are previewed by their first MAX_ARRAY_PREVIEW elements. */
const MAX_ARRAY_PREVIEW = 100

export function sanitizePayload(payload, depth = 0) {
  if (payload === null || typeof payload !== 'object') {
    return payload === undefined ? {} : payload
  }
  if (depth >= MAX_DEPTH) return '[depth]'
  if (Array.isArray(payload)) {
    const out = payload.slice(0, MAX_ARRAY_PREVIEW).map((item) => sanitizeValue(item, depth + 1))
    if (payload.length > MAX_ARRAY_PREVIEW) out.push(`[+${payload.length - MAX_ARRAY_PREVIEW} more]`)
    return out
  }
  const out = {}
  for (const [key, value] of Object.entries(payload)) {
    out[key] = sanitizeValue(value, depth + 1)
  }
  return out
}

function sanitizeValue(value, depth) {
  if (value === null || value === undefined) return value ?? null
  const type = typeof value
  if (type === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value
  }
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return `${value}n`
  if (type === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (type === 'symbol') return value.toString()
  if (value?.disposed !== undefined && typeof value?.dispose === 'function') return '[Handle]'
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8).join('\n') }
  }
  if (depth >= MAX_DEPTH) return '[depth]'
  const sanitized = sanitizePayload(value, depth)
  if (Array.isArray(sanitized)) return sanitized
  const json = safeJson(sanitized)
  return json
}

function safeJson(value) {
  try {
    JSON.stringify(value)
    return value
  } catch {
    return '[unserialisable]'
  }
}
