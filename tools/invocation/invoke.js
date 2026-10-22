import { shortHash } from '../util/hash.js'
import { limitMessage } from '../engine/limits.js'
import { isHostStackExhaustion } from '../engine/runtime.js'

const MAX_JOB_BATCH = 100
const ENGINE_MEMORY_MESSAGE = /^(out of memory|allocation failed|string too long|array too long|memory limit)$/
/** Depth and expansion budget for marshalling a guest completion value into the host. */
const MARSHAL_MAX_DEPTH = 64
/**
 * Path budget, not a node ceiling: `ctx.dump()` expands one path per reference,
 * so a large *flat* array is cheap while a shared-reference graph is not. This
 * is high enough for ordinary bulk data (100k element visits) and only bounds
 * how much work a single marshalling pass may do.
 */
const MARSHAL_MAX_VISITS = 100_000
/**
 * Cap on identity probes used to recognise a shared reference. Strict equality
 * is host-side and cheap, but scanning every previously seen node is quadratic;
 * past this many probes the walk falls back to the visit budget.
 */
const MARSHAL_MAX_IDENTITY_PROBES = 100_000

/**
 * Traceless invocation.
 *
 * A sample must not be able to tell *how* it was invoked:
 *  - the script filename looks like a normal web resource (never `sandbox.js`,
 *    `eval.js` or a host path), because stacks and `document.currentScript.src`
 *    expose it;
 *  - invocation goes through a plain global-scope evaluation, so `this`,
 *    `var`-to-global semantics, `arguments` and strict-mode directives behave
 *    exactly as in a browser script tag;
 *  - entry-point calls go through the guest's own function object (no host
 *    wrapper frames);
 *  - every QuickJS handle created on the boundary is disposed, so a run leaves
 *    no residue that a later run could observe.
 */
export function createInvoker(options) {
  const {
    ctx,
    runtime,
    bridge,
    stealth,
    profile,
    clock,
    trace,
    logger,
    limits,
    hooks,
    instrumentation,
    stackSignals,
    limitReason = () => runtime.state?.reason,
  } = options

  let invocationCount = 0

  /**
   * Host stack-overflow counter for this run (0 when the caller has no witness).
   *
   * The number only ever increases, and only a host throw can increment it, so
   * comparing it around one branch attributes the signal to that branch without
   * reading any guest-controlled value. See `guardHostStackExhaustion` in
   * `tools/engine/runtime.js`.
   * @returns {number}
   */
  const hostStackCount = () => {
    try {
      return typeof stackSignals === 'function' ? Number(stackSignals()) || 0 : 0
    } catch {
      return 0
    }
  }

  function resolveFilename({ sourceUrl, filename, kind = 'script', source } = {}) {
    if (filename) return filename
    if (sourceUrl) {
      try {
        const url = new URL(sourceUrl)
        url.hash = ''
        return url.href
      } catch {
        return String(sourceUrl)
      }
    }
    const digest = shortHash(String(source ?? ''), 8)
    const prefix = profile.origin
    if (kind === 'module') return `${prefix}/assets/app.${digest}.mjs`
    if (kind === 'eval') return `${prefix}/blank.html`
    return `${prefix}/static/js/${digest}.min.js`
  }

  /**
   * Evaluate one source text.
   * @param {string} source
   * @param {object} [runOptions]
   * @param {string} [runOptions.sourceUrl]
   * @param {string} [runOptions.filename]
   * @param {'script'|'module'} [runOptions.type]
   * @param {'off'|'function'|'branch'|'statement'} [runOptions.level]
   * @param {string} [runOptions.entry] call this global function after evaluation
   * @param {unknown[]} [runOptions.args]
   */
  function invoke(source, runOptions = {}) {
    invocationCount += 1
    const text = String(source ?? '')
    if (Buffer.byteLength(text, 'utf8') > limits.maxSourceBytes) {
      const error = {
        name: 'RangeError',
        message: limitMessage('source-size', limits),
        code: 'SANDBOX_LIMIT',
      }
      trace?.emit('sandbox', 'error', { event: 'source.too-large', bytes: text.length })
      return { ok: false, error, limitsHit: ['source-size'] }
    }

    const mode = runOptions.type === 'module' ? 'module' : 'script'
    const filename = resolveFilename({
      sourceUrl: runOptions.sourceUrl,
      filename: runOptions.filename,
      kind: mode === 'module' ? 'module' : 'script',
      source: text,
    })

    const prepared = instrumentation
      ? instrumentation.prepare(text, {
          filename,
          level: runOptions.level,
          sourceType: mode,
        })
      : { code: text, plan: new Map(), facts: null, vm: null, stats: { insertions: 0 } }

    const startedAt = Date.now()
    const stackSignalsBefore = hostStackCount()
    let evalResult
    try {
      evalResult = ctx.evalCode(prepared.code, filename, { type: mode })
    } catch (error) {
      // QuickJS reports a *real* stack overflow by throwing a host RangeError out
      // of the WASM trampoline; no guest-authored value can reach this catch.
      // Anything else that escapes here is a platform failure and must surface.
      // A script that merely says `throw new Error('stack overflow')` arrives
      // below as a dumped guest error and is reported as an ordinary failure.
      if (!isHostStackExhaustion(error)) throw error
      return stackBreachOutcome({ filename, prepared, startedAt, mode })
    }
    const durationMs = Date.now() - startedAt

    if (evalResult.error) {
      // Two engine shapes, one classification:
      //  - a host `RangeError` out of the WASM call (caught above), and
      //  - the same overflow escaping a host callback, which the trampoline
      //    rethrows into the guest as an `Error` — shape-identical to
      //    `throw new RangeError('Maximum call stack size exceeded')`.
      // The second shape is certified by the host-side counter, which guest
      // code cannot write; the intrinsic-identity probe covers the interpreter
      // path (a reduced `stackBytes`), where no host throw exists.
      const hostEvidence = hostStackCount() > stackSignalsBefore
      // Identity, not the dump: a sample can throw
      // `{ name: 'InternalError', message: 'Maximum call stack size exceeded' }`
      // or rename its own `Error`; no dumped field may establish provenance.
      const guestEvidence = isIntrinsicEngineError(stealth, evalResult.error)
      const marshalled = marshalValue(ctx, evalResult.error)
      const raw = marshalled.ok ? marshalled.value : unrepresentableError(marshalled.reason)
      const dumped = stealth?.sanitizeError ? stealth.sanitizeError(raw) : raw
      // `marshalValue` reports promise handles' state; it never leaves one
      // un-disposed, and dumping does not dispose non-promise handles.
      disposeHandle(evalResult.error)
      const classified = classifyLimit(dumped, limitReason(), guestEvidence, hostEvidence)
      if (classified === 'stack') {
        // Same record, same trace event and the same (skipped) hooks as the
        // host-throw path above: the two engine shapes must not be tellable
        // apart in a run record. `dumped` only contributes the engine's own
        // name/message; its frame list depends on the recursion depth.
        return stackBreachOutcome({ filename, prepared, startedAt, mode, dumped })
      }
      if (instrumentation?.exceptions) {
        instrumentation.exceptions.reportUncaught(dumped, mode === 'module' ? 'module' : 'eval', { filename })
      }
      trace?.emit('code', 'error', { event: 'invoke.failed', filename, error: dumped, limitsHit: classified ? [classified] : [] })
      hooks?.emit('code:error', {
        source: text,
        filename,
        error: dumped,
        limitsHit: classified ? [classified] : [],
        prepared,
      })
      hooks?.emit('code:after', { source: text, filename, error: dumped, prepared, ok: false, limitsHit: classified ? [classified] : [] })
      return {
        ok: false,
        error: dumped,
        limitsHit: classified ? [classified] : [],
        stackExhaustion: false,
        timedOut: classified === 'timeout' || classified === 'virtual-time',
        filename,
        prepared,
        facts: prepared.facts,
        vm: prepared.vm,
        durationMs,
        virtualMs: Math.round(clock.elapsedMs),
      }
    }

    let valueHandle = evalResult.value
    let entryResult = null
    try {
      if (runOptions.entry) {
        entryResult = callEntry(runOptions.entry, runOptions.args ?? [], { filename })
        if (!entryResult.ok) {
          const stackExhaustion = Boolean(entryResult.stackExhaustion)
          return {
            ok: false,
            error: entryResult.error,
            limitsHit: entryResult.limitsHit ?? (stackExhaustion ? ['stack'] : []),
            stackExhaustion,
            timedOut: Boolean(entryResult.timedOut),
            filename,
            prepared,
            facts: prepared.facts,
            vm: prepared.vm,
            durationMs: Date.now() - startedAt,
            virtualMs: Math.round(clock.elapsedMs),
          }
        }
      }
      const raw = entryResult?.ok ? entryResult.handle : valueHandle
      const marshalled = marshalValue(ctx, raw)
      // Marshalling is guest-executed work: a Proxy trap (or a shared-reference
      // graph) can burn the host deadline *after* the script returned. The
      // interrupt handler reports the same watchdog breach as an in-script
      // timeout, so the success path must not return `ok: true` for it.
      const lateReason = limitReason()
      let lateLimit = classifyLimit(null, lateReason)
      if (!lateLimit && runtime?.interrupted === true) lateLimit = 'timeout'
      if (lateLimit) {
        const error = {
          name: 'Error',
          message: limitMessage(lateLimit, limits),
          code: 'SANDBOX_LIMIT',
        }
        trace?.emit('code', 'error', { event: 'invoke.failed', filename, error, limitsHit: [lateLimit] })
        hooks?.emit('code:error', { source: text, filename, error, limitsHit: [lateLimit], prepared })
        hooks?.emit('code:after', { source: text, filename, error, prepared, ok: false, limitsHit: [lateLimit] })
        return {
          ok: false,
          error,
          limitsHit: [lateLimit],
          stackExhaustion: false,
          timedOut: true,
          filename,
          prepared,
          facts: prepared.facts,
          vm: prepared.vm,
          durationMs: Date.now() - startedAt,
          virtualMs: Math.round(clock.elapsedMs),
        }
      }
      // Host marshalling is bounded (depth/entry budget) and its failures are
      // host evidence, never guest stack evidence: a completion value the WASM
      // serialiser cannot represent is reported as such.
      const summary = marshalled.ok
        ? summarizeResult(marshalled.value)
        : { type: 'unrepresentable', reason: marshalled.reason }
      // The evaluation itself can also burn the host stack without failing: a
      // guest `try { recurse() } catch {}` swallows the error the trampoline
      // converted. The host witness survives the catch, so the run is still
      // classified (and abandoned) the same way — one input, one record.
      const lateHostStack = hostStackCount() > stackSignalsBefore
      const lateStackError = lateHostStack ? stackBreachRecord(null) : null
      trace?.emit('code', 'after', {
        event: 'invoke.ok',
        filename,
        resultType: summary.type,
        preview: summary.preview,
        instrumented: prepared.stats?.insertions ?? 0,
        virtualMs: Math.round(clock.elapsedMs),
      })
      if (lateStackError) {
        // Same event as the failing shapes, so the trace does not depend on
        // whether the guest swallowed the converted overflow.
        trace?.emit('code', 'error', { event: 'invoke.stack-overflow', filename })
      }
      hooks?.emit('code:after', {
        source: text,
        filename,
        result: summary,
        prepared,
        ok: true,
        limitsHit: lateStackError ? ['stack'] : [],
      })
      return {
        ok: true,
        result: summary,
        value: summary.value,
        // Additive: the guest returned, but the engine's stack is gone.
        error: lateStackError,
        limitsHit: lateStackError ? ['stack'] : [],
        stackExhaustion: Boolean(lateStackError),
        filename,
        prepared,
        facts: prepared.facts,
        vm: prepared.vm,
        durationMs,
        virtualMs: Math.round(clock.elapsedMs),
      }
    } finally {
      // Entry-point call owns its returned handle; the eval result handle is
      // always ours to release.
      if (entryResult?.ok && entryResult.handle) {
        try {
          entryResult.handle.dispose()
        } catch {
          /* already released */
        }
      }
      try {
        valueHandle?.dispose?.()
      } catch {
        /* already released */
      }
    }
  }

  /**
   * The single record shape for an engine stack-overflow classification.
   *
   * Both engine shapes (host throw out of the WASM call, and the trampoline's
   * guest-error conversion of the same overflow inside a host callback) go
   * through here, so `error`, `limitsHit`, the exception report and the trace
   * event are identical and a run record cannot reveal which one happened.
   *
   * @param {{filename: string, prepared: object, startedAt: number, mode: string, dumped?: object|null}} args
   * @returns {object} invocation record
   */
  function stackBreachOutcome({ filename, prepared, startedAt, mode, dumped = null }) {
    // Explicit engine marker. `limitsHit`, the abandon decision and the
    // reported leak are all derived from it, so only the engine can push a run
    // onto the runtime-recompile path.
    const error = stackBreachRecord(dumped)
    instrumentation?.exceptions?.reportUncaught(error, mode === 'module' ? 'module' : 'eval', {
      filename,
      limitsHit: ['stack'],
    })
    trace?.emit('code', 'error', { event: 'invoke.stack-overflow', filename })
    return {
      ok: false,
      error,
      limitsHit: ['stack'],
      stackExhaustion: true,
      timedOut: false,
      filename,
      prepared,
      facts: prepared.facts,
      vm: prepared.vm,
      durationMs: Date.now() - startedAt,
      virtualMs: Math.round(clock.elapsedMs),
    }
  }

  /**
   * Call a global function after evaluation. Used for entry-point samples
   * (`window.start(...)`, `_0x1234()`), invoked from the host without wrappers.
   * @param {string} name
   * @param {unknown[]} args
   * @param {{filename?: string}} [meta]
   */
  function callEntry(name, args, meta = {}) {
    const entryHandle = safeProp(ctx, ctx.global, name)
    if (!entryHandle) {
      return {
        ok: false,
        error: { name: 'ReferenceError', message: `${name} is not defined`, code: 'ENTRY_NOT_FOUND' },
      }
    }
    if (ctx.typeof(entryHandle) !== 'function') {
      entryHandle.dispose()
      return {
        ok: false,
        error: { name: 'TypeError', message: `${name} is not a function`, code: 'ENTRY_NOT_CALLABLE' },
      }
    }
    const argHandles = []
    const signalsBefore = hostStackCount()
    try {
      for (const arg of args) argHandles.push(bridge.toGuest(arg))
      let result
      try {
        result = ctx.callFunction(entryHandle, ctx.global, argHandles)
      } catch (error) {
        // Same authoritative signal as in `invoke()`: a host throw out of the
        // trampoline. A guest that recurses inside the entry point cannot
        // produce it, so the entry call is classified only from here.
        if (!isHostStackExhaustion(error)) throw error
        const dumped = stackLimitError()
        instrumentation?.exceptions?.reportUncaught(dumped, 'call', { entry: name, limitsHit: ['stack'] })
        trace?.emit('code', 'error', { event: 'entry.stack-overflow', name })
        return { ok: false, error: dumped, stackExhaustion: true }
      }
      if (result.error) {
        // Same evidence as in `invoke()`: the host witness for the converted
        // shape, intrinsic identity for engine errors, and the actual interrupt
        // reason to distinguish a timeout from stack exhaustion.
        const hostEvidence = hostStackCount() > signalsBefore
        const guestEvidence = isIntrinsicEngineError(stealth, result.error)
        const marshalled = marshalValue(ctx, result.error)
        const raw = marshalled.ok ? marshalled.value : unrepresentableError(marshalled.reason)
        const dumped = stealth?.sanitizeError ? stealth.sanitizeError(raw) : raw
        disposeHandle(result.error)
        const classified = classifyLimit(dumped, limitReason(), guestEvidence, hostEvidence)
        const breach = classified === 'stack'
        const reported = breach ? stackBreachRecord(dumped) : dumped
        const limitsHit = classified ? [classified] : []
        instrumentation?.exceptions?.reportUncaught(reported, 'call', { entry: name, limitsHit })
        return {
          ok: false,
          error: reported,
          limitsHit,
          stackExhaustion: breach,
          timedOut: classified === 'timeout' || classified === 'virtual-time',
        }
      }
      trace?.emit('code', 'after', { event: 'entry.called', name, args: args.length })
      return { ok: true, handle: result.value }
    } finally {
      for (const handle of argHandles) {
        try {
          handle.dispose()
        } catch {
          /* ignore */
        }
      }
      entryHandle.dispose()
    }
  }

  /**
   * Drive the guest forward: microtasks, promise jobs, then virtual timers.
   * This is the sandbox's equivalent of a browser event loop turn.
   *
   * A stack-limit breach inside a *callback* is not a script failure: the entry
   * script already succeeded, yet the runtime's heap is as unrecoverable as
   * after a main-script overflow (handles stay on the GC list). Such a breach is
   * therefore recorded as a structured `settle.error` plus
   * `settle.stackExhaustion: true` instead of escaping as a host `RangeError` —
   * a host throw here would skip the quarantine path and make
   * `runtime.dispose()` abort the WASM engine.
   *
   * @param {{maxJobs?: number, maxTimerCallbacks?: number, maxVirtualMs?: number}} [options]
   */
  function settle(options = {}) {
    const maxJobs = options.maxJobs ?? limits.maxJobs
    const maxTimerCallbacks = options.maxTimerCallbacks ?? limits.maxTimerCallbacks
    const maxVirtualMs = options.maxVirtualMs ?? limits.maxVirtualMs
    let jobs = 0
    let timerCallbacks = 0
    let pendingRejections = 0
    let exhausted = false
    // The only marker `limitsHit`/abandon may be derived from. Guest-thrown
    // messages never set it, so `throw new Error('stack overflow')` inside a
    // callback stays a normal exception report.
    let stackExhaustion = false
    /** @type {{origin: string, name: string, message: string, stack: string}|null} */
    let stackError = null
    let resourceLimit = null

    /**
     * Record an engine stack signal once; later callback failures are noise.
     *
     * `value` is host evidence only: either the host exception thrown out of the
     * WASM trampoline, or the record the virtual clock returns for a timer
     * callback that did (`stackExhaustion: true`) — the clock inspects the host
     * throw itself, so no caller has to match a message. `guestEvidence` is the
     * shared classifier's verdict after probing the live intrinsic identity
     * and ruling out interrupts and allocation failures.
     *
     * @param {string} origin
     * @param {unknown} value
     * @param {boolean} [guestEvidence] classified intrinsic stack-error verdict
     * @returns {boolean} true when the value was the stack signal
     */
    const noteStack = (origin, value, guestEvidence = false) => {
      if (stackExhaustion) return false
      const fromClock = Boolean(value) && typeof value === 'object' && typeof value.timerId === 'number'
      const isStackSignal =
        guestEvidence === true || (fromClock ? value.stackExhaustion === true : isHostStackExhaustion(value))
      if (!isStackSignal) return false
      stackExhaustion = true
      stackError = { origin, ...stackLimitError() }
      trace?.emit('sandbox', 'error', { event: 'settle.stack-overflow', origin })
      return true
    }

    /**
     * Same classification for the *converted* shape of the same overflow.
     *
     * When the host stack gives out inside a callback, the WASM trampoline
     * rethrows the V8 `RangeError` into the guest and the guest shim reports it
     * as an ordinary uncaught exception — no host throw ever reaches this loop.
     * The host witness (`runtime.stackSignals()`) still did, so the branch that
     * was running when the counter moved owns the origin. Comparing the counter
     * around one branch keeps `settle.error.origin` a pure function of the
     * sample, not of which engine shape happened.
     *
     * @param {string} origin
     * @param {number} before counter value read before the branch ran
     * @returns {boolean} true when this branch saw the engine signal
     */
    const noteHostStack = (origin, before) => {
      if (stackExhaustion || hostStackCount() <= before) return false
      stackExhaustion = true
      stackError = { origin, ...stackLimitError() }
      trace?.emit('sandbox', 'error', { event: 'settle.stack-overflow', origin })
      return true
    }

    for (let guard = 0; guard < 100_000; guard += 1) {
      if (stackError) break
      resourceLimit = classifyLimit(null, limitReason())
      // A promise reaction may turn an interrupt into a rejection, so the
      // pending-job API can return success even though the runtime interrupted.
      if (resourceLimit) break
      if (runtime.hasPendingJob()) {
        if (jobs >= maxJobs) {
          exhausted = true
          break
        }
        const signalsBefore = hostStackCount()
        let result
        try {
          result = runtime.executePendingJobs(Math.min(MAX_JOB_BATCH, maxJobs - jobs))
        } catch (error) {
          // QuickJS surfaces job-queue stack exhaustion as a host RangeError
          // escaping the WASM trampoline rather than as a guest exception.
          if (!noteStack('promise-job', error)) throw error
          break
        }
        if (result.error) {
          const engineStack = isIntrinsicEngineError(stealth, result.error)
          const marshalled = marshalValue(ctx, result.error)
          const raw = marshalled.ok ? marshalled.value : unrepresentableError(marshalled.reason)
          const dumped = stealth?.sanitizeError ? stealth.sanitizeError(raw) : raw
          disposeHandle(result.error)
          if (noteHostStack('promise-job', signalsBefore)) break
          const classified = classifyLimit(dumped, limitReason(), engineStack)
          if (classified === 'stack' && noteStack('promise-job', null, true)) break
          instrumentation?.exceptions?.reportPromiseJob(dumped)
          pendingRejections += 1
          if (classified) {
            resourceLimit = classified
            break
          }
        } else if (noteHostStack('promise-job', signalsBefore)) {
          break
        } else {
          jobs += typeof result.value === 'number' ? result.value : 1
          result.value?.dispose?.()
        }
        continue
      }

      const dueIn = clock.nextDueIn()
      if (!Number.isFinite(dueIn)) break
      if (clock.elapsedMs + Math.max(dueIn, 0) > maxVirtualMs) {
        exhausted = true
        break
      }
      const remaining = Math.max(0, maxTimerCallbacks - timerCallbacks)
      if (remaining === 0) {
        exhausted = true
        break
      }
      const signalsBefore = hostStackCount()
      // One timer callback per settle turn: the job-queue branch at the top of
      // this loop then drains guest microtasks before the next callback, which
      // is the ordering real browsers guarantee between same-due timers.
      const run = clock.runDue({ maxCallbacks: 1, maxVirtualMs })
      timerCallbacks += run.executed
      for (const error of run.errors) {
        // A callback that exhausted the stack is classified, not retried: the
        // clock stops the batch at that throw and the runtime is unrecoverable.
        //
        // Guest errors never reach this loop: the timer shim catches them inside
        // the guest and reports them as uncaught exceptions, so the clock only
        // ever sees the host stack throw it marks itself — no handle to probe.
        if (noteStack('timer', error)) break
        instrumentation?.exceptions?.reportUncaught(
          { name: 'Error', message: error.message },
          'timer',
          { timerId: error.timerId },
        )
      }
      if (stackError) break
      if (run.stackExhaustion) break
      // The callback's overflow can also reach us as a guest report (see
      // `noteHostStack`); attribute it to this batch and stop before the next
      // callback runs on a runtime whose engine stack is gone.
      if (noteHostStack('timer', signalsBefore)) break
      if (run.executed === 0) break
    }

    if (exhausted) {
      trace?.emit('sandbox', 'error', { event: 'settle.exhausted', jobs, timerCallbacks, maxJobs, maxTimerCallbacks })
    }
    return {
      jobs,
      timerCallbacks,
      promiseErrors: pendingRejections,
      exhausted,
      pendingTimers: bridge.pendingTimers?.() ?? clock.pending(),
      virtualMs: Math.round(clock.elapsedMs),
      limitsHit: stackExhaustion ? ['stack'] : resourceLimit ? [resourceLimit] : [],
      timedOut: resourceLimit === 'timeout' || resourceLimit === 'virtual-time',
      // Explicit engine marker: the sandbox abandons the runtime from this, not
      // from `limitsHit`, so a guest cannot steer the disposal path.
      stackExhaustion,
      error: stackError,
    }
  }

  return {
    invoke,
    callEntry,
    settle,
    resolveFilename,
    stats() {
      return { invocations: invocationCount, virtualMs: Math.round(clock.elapsedMs) }
    },
  }
}

/**
 * Dispose a QuickJS handle, tolerating one `ctx.dump()` already released it.
 *
 * `dump()` disposes promise handles and `consume()` disposes the result handle
 * of a promise reaction, so a second `dispose()` throws `Lifetime not alive` —
 * a host error that must never become a run failure caused by guest input.
 *
 * @param {{dispose?: Function}|null|undefined} handle
 */
function disposeHandle(handle) {
  try {
    handle?.dispose?.()
  } catch {
    /* already released */
  }
}

/**
 * Dump a guest value without re-entering quickjs-emscripten's recursive promise
 * path.
 *
 * `ctx.dump()` disposes a promise handle and then calls `consume()` on its
 * result, which disposes that result again when it is itself a promise. Walking
 * the promise state here keeps every handle released exactly once. The caller
 * still owns `handle`.
 *
 * @param {object} ctx
 * @param {object} handle
 * @param {number} [depth]
 * @returns {unknown}
 */
function dumpGuestValue(ctx, handle, depth = 0) {
  if (depth > MARSHAL_MAX_DEPTH) return { type: 'unrepresentable', reason: 'depth' }
  // Minimal contexts (unit callers, fakes) expose only `dump()`. Without a
  // promise-state probe a handle can only be reported as an ordinary value.
  const state = typeof ctx.getPromiseState === 'function' ? ctx.getPromiseState(handle) : null
  if (!state || state.notAPromise) return ctx.dump(handle)
  if (state.type === 'pending') return { type: 'pending' }
  const key = state.type === 'fulfilled' ? 'value' : 'error'
  // `consume()` disposes the reaction handle exactly once, after this callback.
  // Disposing it here as well is what produced the double-free.
  const dumped = state[key].consume((child) => dumpGuestValue(ctx, child, depth + 1))
  return { type: state.type, [key]: dumped }
}

/**
 * Marshal a guest value with a depth/entry budget.
 *
 * Host marshalling is not guest execution: a host `RangeError` out of the WASM
 * serialiser must never be classified as a guest stack breach.
 *
 * @param {object} ctx
 * @param {object} handle
 * @returns {{ok: true, value: unknown}|{ok: false, reason: string}}
 */
function marshalValue(ctx, handle) {
  try {
    const breach = marshalBudgetBreach(ctx, handle)
    if (breach) return { ok: false, reason: breach }
    return { ok: true, value: dumpGuestValue(ctx, handle) }
  } catch (error) {
    if (!isHostStackExhaustion(error)) throw error
    return { ok: false, reason: 'host-stack' }
  }
}

/**
 * The error record used when a thrown value cannot be marshalled.
 * @param {string} reason
 * @returns {{name: string, message: string}}
 */
function unrepresentableError(reason) {
  return { name: 'Error', message: `unrepresentable error value (${reason})` }
}

/**
 * Walk a guest value graph under a depth and *expansion* budget.
 *
 * `ctx.dump()` costs one path per reference, so the interesting quantity is not
 * the number of distinct objects but how many times the graph is expanded. A
 * flat 1000-element array is linear and must stay representable; a
 * shared-reference DAG (`a = [a, a]`) contains few distinct objects but
 * exponentially many paths. Shared references are therefore detected by
 * identity (`ctx.eq`) and reported immediately, and only otherwise does the
 * total visit count act as the backstop. Promise states are part of the graph:
 * a settlement value/error is walked under the same budget instead of being
 * handed straight to `ctx.dump()`.
 *
 * Only containers are traversed and every handle created here is released, so
 * the walk itself cannot exhaust the host stack.
 *
 * @param {object} ctx
 * @param {object} root
 * @returns {'depth'|'entries'|null} the breached budget, or null when within it
 */
function marshalBudgetBreach(ctx, root) {
  const stack = [{ handle: root, depth: 0, owned: false, retained: false }]
  /** Handles kept alive for identity comparison, plus their ownership. */
  const retained = []
  let visits = 1
  let probes = 0
  let reason = null

  /**
   * @param {object} handle
   * @returns {boolean} true when an equal container was already expanded
   */
  const isShared = (handle) => {
    if (typeof ctx.eq !== 'function') return false
    for (const seen of retained) {
      if (probes >= MARSHAL_MAX_IDENTITY_PROBES) return false
      probes += 1
      let same = false
      try {
        same = ctx.eq(seen.handle, handle) === true
      } catch {
        return false
      }
      if (same) return true
    }
    return false
  }

  try {
    while (stack.length > 0 && !reason) {
      const node = stack.pop()
      try {
        if (ctx.typeof(node.handle) !== 'object') continue
        if (node.depth >= MARSHAL_MAX_DEPTH) {
          reason = 'depth'
          continue
        }
        // A promise's settlement state is inline in the dump; its own
        // properties are engine bookkeeping, so walk the result instead.
        const state = promiseState(ctx, node.handle)
        if (state) {
          if (state.type === 'pending') continue
          if (state.type !== 'fulfilled' && state.type !== 'rejected') continue
          visits += 1
          if (visits > MARSHAL_MAX_VISITS) {
            reason = 'entries'
            disposeHandle(state[state.type === 'fulfilled' ? 'value' : 'error'])
            continue
          }
          stack.push({
            handle: state[state.type === 'fulfilled' ? 'value' : 'error'],
            depth: node.depth + 1,
            owned: true,
            retained: false,
          })
          continue
        }
        if (isShared(node.handle)) {
          reason = 'entries'
          continue
        }
        // Keep one live handle per expanded container so later paths can be
        // compared against it. Retained handles outlive their stack entry.
        retained.push(node)
        node.retained = true
        let names
        try {
          names = ctx.getOwnPropertyNames(node.handle)
        } catch {
          continue
        }
        if (names.error) {
          disposeHandle(names.error)
          continue
        }
        try {
          for (const key of names.value) {
            if (visits >= MARSHAL_MAX_VISITS) {
              reason = 'entries'
              break
            }
            try {
              stack.push({
                handle: ctx.getProp(node.handle, key),
                depth: node.depth + 1,
                owned: true,
                retained: false,
              })
              visits += 1
            } catch {
              /* unreadable property */
            }
          }
        } finally {
          disposeHandle(names.value)
        }
      } finally {
        if (node.owned && !node.retained) disposeHandle(node.handle)
      }
    }
  } catch {
    return null
  } finally {
    for (const node of stack) {
      if (node.owned && !node.retained) disposeHandle(node.handle)
    }
    for (const node of retained) {
      if (node.owned) disposeHandle(node.handle)
    }
  }
  return reason
}

/**
 * Read a promise's settlement state without re-entering the dump path.
 *
 * Minimal contexts (unit callers, fakes) expose no promise probe; they keep the
 * old behaviour of treating every handle as an ordinary value. The returned
 * `value`/`error` handle for a settled promise is owned by the caller.
 *
 * @param {object} ctx
 * @param {object} handle
 * @returns {object|null} promise state, or null for non-promises / no probe
 */
function promiseState(ctx, handle) {
  if (typeof ctx.getPromiseState !== 'function') return null
  try {
    const state = ctx.getPromiseState(handle)
    if (!state || state.notAPromise === true) return null
    return state
  } catch {
    return null
  }
}


function safeProp(ctx, target, key) {
  try {
    const handle = ctx.getProp(target, key)
    return handle
  } catch {
    return null
  }
}

function classifyLimit(dumped, reason, intrinsicError = false, hostStack = false) {
  // A witnessed host stack breach requires quarantine even if the deadline
  // also elapsed. Interrupt state then takes precedence over intrinsic identity.
  if (hostStack) return 'stack'
  if (reason === 'timeout' || reason === 'virtual-time') return reason
  if (!intrinsicError) return null
  // Text only distinguishes intrinsic-shaped engine errors; ordinary guest
  // text is not evidence. A caught engine error can expose its prototype for
  // reuse, so this guard is not a host allocator-failure witness.
  if (ENGINE_MEMORY_MESSAGE.test(dumped?.message ?? '')) return 'memory'
  if (dumped?.message === 'stack overflow') return 'stack'
  return null
}

/**
 * Ask whether a live guest error carries the hidden engine InternalError
 * prototype. It is evidence for classification, not proof of a stack breach:
 * interrupts and allocation failures use the same intrinsic. Missing stealth
 * (unit callers) or a missing probe means "no".
 *
 * @param {object|undefined} stealth
 * @param {object} handle guest error handle, still owned by the caller
 * @returns {boolean}
 */
function isIntrinsicEngineError(stealth, handle) {
  if (typeof stealth?.isIntrinsicStackError !== 'function') return false
  try {
    return stealth.isIntrinsicStackError(handle) === true
  } catch {
    return false
  }
}

/**
 * The structured record for a stack-limit breach.
 *
 * A fresh object per call: consumers may extend it, and the tracing layer must
 * never see one run's mutation in the next.
 * @returns {{name: string, message: string, stack: string}}
 */
function stackLimitError() {
  return { name: 'RangeError', message: 'Maximum call stack size exceeded', stack: '' }
}

/**
 * Canonical report for a classified stack breach.
 *
 * The engine names the same condition two ways (a host `RangeError` with V8's
 * wording when the WASM stack goes, an `InternalError` with QuickJS' wording
 * when the interpreter check fires). Whatever the engine produced, the record
 * keeps its name and message but drops the stack: the frame list grows with the
 * recursion depth the sample reached before the limit hit, so it would make two
 * runs of the same input disagree.
 *
 * @param {{name?: unknown, message?: unknown}|null|undefined} dumped guest dump, when there is one
 * @returns {{name: string, message: string, stack: string}}
 */
function stackBreachRecord(dumped) {
  const name = typeof dumped?.name === 'string' && dumped.name ? dumped.name : 'RangeError'
  const message =
    typeof dumped?.message === 'string' && dumped.message ? dumped.message : 'Maximum call stack size exceeded'
  return { name, message, stack: '' }
}

function summarizeResult(dumped) {
  if (dumped === undefined) return { type: 'undefined' }
  if (dumped === null) return { type: 'null', value: null }
  const type = Array.isArray(dumped) ? 'array' : typeof dumped
  if (type === 'string') {
    return {
      type,
      value: dumped.length <= 4096 ? dumped : undefined,
      preview: dumped.length > 4096 ? `${dumped.slice(0, 4096)}…` : dumped,
      length: dumped.length,
    }
  }
  if (type === 'number' || type === 'boolean') return { type, value: dumped, preview: String(dumped) }
  if (type === 'array') {
    let preview
    try {
      preview = JSON.stringify(dumped).slice(0, 4096)
    } catch {
      preview = '[array]'
    }
    return { type, preview, length: dumped.length }
  }
  if (type === 'object') {
    let preview
    try {
      preview = JSON.stringify(dumped).slice(0, 4096)
    } catch {
      preview = '[object]'
    }
    return { type, preview, keys: Object.keys(dumped).slice(0, 50) }
  }
  return { type }
}

export { summarizeResult }
