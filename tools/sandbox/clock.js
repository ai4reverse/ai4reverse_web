import { createSeededRandom } from '../util/random.js'
import { DEFAULT_LIMITS } from '../engine/limits.js'
import { isHostStackExhaustion } from '../engine/runtime.js'

/**
 * Virtual clock for the sandbox.
 *
 * Malware measures time: `Date.now()` deltas around busy loops, `performance.now()`
 * around feature probes, long `setTimeout` chains used as execution delays. A
 * sandbox that runs on the real clock leaks its own speed and makes analysis
 * non-reproducible. This clock is the only time source the guest sees.
 *
 * Resolution emulates a browser timer clamp and provides a small non-zero
 * quantum so instrumentation overhead never manifests as suspiciously fast or
 * suspiciously slow wall-clock deltas.
 */

/** @param {object} [options] */
const TIME_ORIGIN_OFFSET_MIN_MS = 100
/** Real browsers vary performance.timeOrigin per page load; the sandbox mimics that with a seeded offset in [MIN, MIN + RANGE). */
const TIME_ORIGIN_OFFSET_RANGE_MS = 2000

export function createVirtualClock(options = {}) {
  const {
    epoch = 1792394400000,
    resolutionMs = 0.1,
    maxTimerDelay = 2_147_483_647,
    seed = 'clock',
    logger = null,
  } = options
  // Concurrently scheduled timers. A guest flooding `setTimeout` from a loop
  // must not grow this Map (and host memory) without limit; validate the
  // caller-supplied value at this boundary instead of trusting it.
  const maxTimers =
    Number.isFinite(options.maxTimers) && options.maxTimers >= 1 ? Math.floor(options.maxTimers) : DEFAULT_LIMITS.maxTimers

  const rng = createSeededRandom(seed)
  const timeOriginOffset =
    TIME_ORIGIN_OFFSET_MIN_MS + Math.floor(rng.next() * TIME_ORIGIN_OFFSET_RANGE_MS)
  let elapsed = 0
  let timerSeq = 0
  let droppedTimers = 0
  /** @type {Map<number, {id:number, due:number, fn:Function, interval:number|null, args:unknown[]}>} */
  const timers = new Map()
  const errors = []

  const clock = {
    epoch,
    timeOrigin: epoch - timeOriginOffset,

    /** Wall-clock milliseconds as the guest sees them. */
    now() {
      return Math.floor(epoch + elapsed)
    },

    /** Sub-millisecond clock for performance.now(). */
    nowFloat() {
      return epoch + elapsed
    },

    /** performance.now() value. */
    performanceNow() {
      return timeOriginOffset + elapsed
    },

    get elapsedMs() {
      return elapsed
    },

    /** Advance virtual time. */
    advance(ms) {
      const delta = Number(ms)
      if (!Number.isFinite(delta) || delta <= 0) return clock.now()
      elapsed += delta
      return clock.now()
    },

    /**
     * Advance by one resolution quantum. Called by instrumentation so that a
     * traced run still reports plausible elapsed time.
     */
    tick(units = 1) {
      elapsed += resolutionMs * units
      return clock.now()
    },

    /**
     * Schedule a virtual timer.
     *
     * When `maxTimers` timers are already pending, the schedule is *refused*
     * rather than rejected with a throw: a flood loop must not kill the run
     * (availability of the analysis beats completeness). `0` is returned —
     never a real id, those start at 1 — and nothing is stored, so the caller
     must not keep per-timer state for it. Cancelling a timer frees its slot,
     so ordinary churn is unaffected; refusals are counted in `stats()`.
     *
     * @param {{fn: Function, delay?: number, interval?: boolean, args?: unknown[]}} timer
     * @returns {number} timer id, or `0` when the schedule was refused
     */
    schedule(timer) {
      if (timers.size >= maxTimers) {
        droppedTimers += 1
        return 0
      }
      timerSeq += 1
      const delay = clampDelay(timer.delay, maxTimerDelay)
      const entry = {
        id: timerSeq,
        due: elapsed + delay,
        fn: timer.fn,
        interval: timer.interval ? Math.max(delay, 4) : null,
        args: timer.args ?? [],
      }
      timers.set(entry.id, entry)
      return entry.id
    },

    cancel(id) {
      return timers.delete(Number(id))
    },

    pending() {
      return timers.size
    },

    /** Milliseconds until the next timer is due (Infinity when idle). */
    nextDueIn() {
      let min = Infinity
      for (const timer of timers.values()) min = Math.min(min, timer.due - elapsed)
      return min
    },

    /**
     * Run due timers, advancing virtual time to each due point.
     *
     * A callback that exhausts the engine stack is *terminal* for the batch:
     * the runtime's heap is unrecoverable (every further call throws again and
     * leaves more handles on the GC list), so the loop stops at the first host
     * stack throw instead of running up to `maxCallbacks` more callbacks. The
     * throw is recorded with an explicit engine marker so callers classify it
     * from evidence, never from the (guest-controlled) message text.
     *
     * @param {{maxCallbacks?: number, maxVirtualMs?: number}} [options]
     * @returns {{
     *   executed:number,
     *   advancedMs:number,
     *   errors:Array<{timerId:number, message:string, stackExhaustion:boolean}>,
     *   exhausted:boolean,
     *   stackExhaustion:boolean,
     * }}
     */
    runDue(options = {}) {
      const { maxCallbacks = 1000, maxVirtualMs = 60_000 } = options
      let executed = 0
      let advanced = 0
      let exhausted = false
      let stackExhaustion = false
      // Errors thrown during THIS batch only. The lifetime `errors` array stays
      // for stats; returning it made every settle iteration re-report all
      // earlier batches' errors (once per batch, growing unboundedly).
      const batchErrors = []

      while (executed < maxCallbacks) {
        let next = null
        for (const timer of timers.values()) {
          if (!next || timer.due < next.due) next = timer
        }
        if (!next) break
        // Advance virtual time to the earliest timer. `runDue` is the sandbox
        // event loop, so "run the next turn" implies moving the clock.
        const step = Math.max(0, next.due - elapsed)
        if (advanced + step > maxVirtualMs) {
          exhausted = true
          break
        }
        elapsed += step
        advanced += step
        executed += 1
        if (next.interval !== null) {
          next.due = elapsed + next.interval
        } else {
          timers.delete(next.id)
        }
        try {
          next.fn(...next.args)
        } catch (error) {
          // The engine's real stack overflow is a *host* throw out of the WASM
          // trampoline; a guest `throw new RangeError('…stack…')` is an ordinary
          // callback error and never reaches this predicate as host evidence.
          const isStackThrow = isHostStackExhaustion(error)
          const entry = {
            timerId: next.id,
            message: error?.message ?? String(error),
            stackExhaustion: isStackThrow,
          }
          errors.push(entry)
          batchErrors.push(entry)
          logger?.debug?.({ timerId: next.id, err: error?.message }, 'timer callback threw')
          if (isStackThrow) {
            stackExhaustion = true
            break
          }
        }
      }

      return { executed, advancedMs: advanced, errors: batchErrors, exhausted, stackExhaustion }
    },

    /** Advance to the next pending timer even if it is far in the future, then run it. */
    advanceToNextTimer(capMs = 60_000) {
      const due = clock.nextDueIn()
      if (!Number.isFinite(due)) return 0
      const step = Math.min(Math.max(0, due), capMs)
      elapsed += step
      return step
    },

    stats() {
      return {
        epoch,
        elapsedMs: Number(elapsed.toFixed(3)),
        pendingTimers: timers.size,
        timerErrors: errors.length,
        droppedTimers,
      }
    },

    dispose() {
      timers.clear()
    },
  }

  return clock
}

function clampDelay(value, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 4
  return Math.min(Math.trunc(parsed), max)
}
