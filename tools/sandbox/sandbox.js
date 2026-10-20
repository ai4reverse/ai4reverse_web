/**
 * Guest execution is serialized process-wide.
 *
 * Every sandbox shares one QuickJS WASM module (`runtime.js` memoises it) and a
 * module executes one guest at a time: guest code runs synchronously, so while
 * one run spins every other run is parked at an `await` in its run preamble.
 * That suspension is what used to corrupt the other run. The host-time budget
 * (`limits.timeoutMs`) is measured with `Date.now()` from *runtime creation*, so
 * a run that resumes after a neighbour monopolised the thread for 400 ms finds
 * its budget already expired, interrupts itself on its first guest statement,
 * and the aborted evaluation leaves guest objects on that runtime's GC list.
 * Its `runtime.dispose()` then aborts the WASM engine
 * (`Aborted(Assertion failed: list_empty(&rt->gc_obj_list))`) and quarantines
 * the module for every later run — while the run that caused the delay (the
 * timeout) disposes cleanly, which is what made the leak look unrelated to
 * concurrency.
 *
 * The queue below is a mutex built from a promise chain (no new dependency).
 * `run()` appends its whole body — acquisition, invocation, settle, disposal —
 * and the next body starts only after the previous one has settled. Concurrent
 * callers are queued, never rejected, and every queued run still gets its own
 * fresh runtime and context, so per-run isolation and determinism are
 * unchanged: a run now behaves exactly like the sequential equivalent.
 */

import { loadQuickJS, createRuntime, isHostStackExhaustion, guardHostStackExhaustion } from '../engine/runtime.js'
import { normalizeLimits, DEFAULT_LIMITS } from '../engine/limits.js'
import { createProfile, consistencyReport } from './profile.js'
import { createVirtualClock } from './clock.js'
import { createHostBridge } from './bridge.js'
import { createStealth } from '../invocation/stealth.js'
import { createTraceRecorder } from '../instrumentation/trace.js'
import { createInstrumentation, analyzeSource } from '../instrumentation/index.js'
import { createHookBus, createDefaultHooks, registerHooks } from '../hook/index.js'
import { installEnvironment } from './env/index.js'
import { captureIntegrity, diffIntegrity } from './integrity.js'
import { createInvoker } from '../invocation/invoke.js'
import { createLogger } from '../logging/logger.js'
import { SandboxError } from '../util/errors.js'
import { shortHash } from '../util/hash.js'

/** Tail of the guest-run queue. Always a promise that settles, never rejects. */
let runQueueTail = Promise.resolve()

/**
 * Run `task` once no other run holds the shared WASM module.
 *
 * The tail is replaced by a promise that can never reject, so one failing run
 * cannot stop the queue from draining.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withGuestRunLock(task) {
  const started = runQueueTail.then(task)
  runQueueTail = started.then(
    () => undefined,
    () => undefined,
  )
  return started
}

/**
 * Traceless sandbox: the analysis platform base.
 *
 * Every `run()` gets:
 *  - a fresh QuickJS runtime *and* context (no state survives between samples);
 *  - a seeded, internally consistent browser profile;
 *  - a virtual clock as the only time source;
 *  - native-looking host functions and a masked `Function.prototype.toString`;
 *  - a trace channel reachable only through a run-unique registered symbol;
 *  - integrity snapshots before/after to prove nothing leaked in or out;
 *  - full handle disposal, verified by the WASM runtime's leak assertion;
 *  - the exception is a real stack-limit breach (the engine threw its host
 *    stack `RangeError` in the main script *or* in a timer/promise callback),
 *    where the runtime cannot be released at all: it is abandoned, the WASM
 *    module is quarantined and the next run recompiles it (reported as
 *    `disposal.skipped`). That decision is driven by the invoker's explicit
 *    `stackExhaustion` marker, never by matching a guest error message — a
 *    sample that merely throws `Error('stack overflow')` must leave the runtime
 *    healthy.
 *
 * Concurrency contract:
 *  - one guest run at a time per *process*, not per sandbox: `run()` calls are
 *    queued on the shared WASM module (see `withGuestRunLock` above) and the
 *    API stays async — concurrent callers wait, they are never rejected;
 *  - the queue covers the full run body, including module (re-)acquisition, so
 *    a run queued behind a quarantined module picks up a healthy one;
 *  - it only serializes guest execution: static analysis (`analyze()`, the
 *    restore pipeline) never touches the module and is not serialized;
 *  - real (wall-clock) parallelism requires separate worker processes, one
 *    WASM module each — a pool inside one process is a queue, not a fan-out;
 *  - nested runs are *not* supported: a `run()` started from inside a hook, an
 *    env callback or guest code waits for the run that is holding the queue,
 *    i.e. for itself. Do not call `run()` from a callback of a running run.
 */
export class TracelessSandbox {
  /**
   * @param {object} [options]
   * @param {number|string} [options.seed]
   * @param {object} [options.profile] profile overrides
   * @param {object} [options.limits]
   * @param {object} [options.logger]
   * @param {string} [options.logLevel]
   * @param {object} [options.instrumentation] instrumentation config
   * @param {Array} [options.hooks] extra hook registrations
   * @param {object} [options.env] {strict, only, exclude}
   * @param {object} [options.ioc] IOC extractor (for the code:after hook)
   * @param {boolean} [options.defaultHooks]
   */
  constructor(options = {}) {
    this.options = options
    this.seed = options.seed ?? 0x5eed
    this.profile = createProfile({ seed: this.seed, ...(options.profile ?? {}) })
    this.limits = normalizeLimits({ ...DEFAULT_LIMITS, ...(options.limits ?? {}) })
    this.logger = options.logger ?? createLogger({ level: options.logLevel ?? 'warn' })
    this.instrumentationOptions = {
      code: { level: 'statement', ...(options.instrumentation?.code ?? {}) },
      api: options.instrumentation?.api ?? true,
      jsvmp: options.instrumentation?.jsvmp ?? true,
      ast: options.instrumentation?.ast ?? true,
    }
    this.envOptions = { strict: false, ...(options.env ?? {}) }
    this.extraHooks = options.hooks ?? []
    this.ioc = options.ioc ?? null
    this.defaultHooks = options.defaultHooks !== false
    this.module = null
    this.runSeq = 0
    this.lastRun = null
    this.disposed = false
    this.runHistory = []
  }

  /** Await the WASM module once so timings are stable after warm-up. */
  async init() {
    if (!this.module) this.module = await loadQuickJS()
    return this
  }

  static async create(options = {}) {
    const sandbox = new TracelessSandbox(options)
    await sandbox.init()
    return sandbox
  }

  /** Profile summary suitable for a report. */
  profileSummary() {
    const profile = this.profile
    return {
      seed: profile.seed,
      os: profile.os,
      osName: profile.osName,
      browser: profile.browser,
      browserName: profile.browserName,
      browserVersion: profile.browserVersion,
      engine: profile.engine,
      platform: profile.platform,
      userAgent: profile.userAgent,
      language: profile.language,
      languages: profile.languages,
      timezone: profile.timezone,
      timezoneOffsetMinutes: profile.timezoneOffsetMinutes,
      screen: { ...profile.screen },
      window: { ...profile.window },
      hardwareConcurrency: profile.hardwareConcurrency,
      deviceMemory: profile.deviceMemory,
      webdriver: profile.webdriver,
      webgl: { ...profile.webgl },
      fonts: profile.fonts.length,
      consistency: consistencyReport(profile),
    }
  }

  /**
   * Execute one sample in a fresh, isolated context.
   *
   * Concurrent calls are queued, one run at a time per process, because all
   * sandboxes share a single WASM module (see the class JSDoc). The returned
   * promise resolves with the same record the sequential call would produce.
   *
   * @param {string} source
   * @param {object} [runOptions]
   * @returns {Promise<object>} run record
   */
  async run(source, runOptions = {}) {
    if (this.disposed) throw new SandboxError('sandbox has been disposed')
    return withGuestRunLock(() => this.#runExclusive(source, runOptions))
  }

  /**
   * The run body. Callers must hold the guest-run queue (`run()` is the only
   * supported entry point); it is one indirection so the lock covers *every*
   * stage — module acquisition, invocation, settlement and disposal.
   *
   * @param {string} source
   * @param {object} runOptions
   * @returns {Promise<object>} run record
   */
  async #runExclusive(source, runOptions) {
    if (this.disposed) throw new SandboxError('sandbox has been disposed')
    if (!this.module) await this.init()
    if (typeof source !== 'string' || source.length === 0) {
      throw new SandboxError('source must be a non-empty string')
    }

    this.runSeq += 1
    const runId = `run-${this.runSeq}-${shortHash(`${this.seed}:${this.runSeq}:${source}`, 8)}`
    const clock = createVirtualClock({
      epoch: this.profile.epoch,
      seed: runId,
      maxTimers: this.limits.maxTimers,
      resolutionMs: this.limits.interruptQuantumMs,
      logger: this.logger,
    })
    const trace = createTraceRecorder({
      limit: this.limits.maxEvents,
      clock: () => clock.now(),
      actor: 'sandbox',
    })
    const hooks = createHookBus({ logger: this.logger, trace })
    const hookStats = { registered: 0, defaultHooks: this.defaultHooks }

    const defaultSet = this.defaultHooks
      ? createDefaultHooks({ trace, ioc: this.ioc, mocks: runOptions.mocks ?? [] })
      : { registrations: [], api: null }
    registerHooks(hooks, defaultSet.registrations)
    registerHooks(hooks, this.extraHooks)
    registerHooks(hooks, runOptions.hooks ?? [])
    hookStats.registered = hooks.describe().length

    // Every resource acquired for this run lives here so the `finally` block can
    // dispose whatever actually exists, in reverse order, even when the
    // acquisition itself throws half-way through (see D2).
    let runtimeHandle = null
    let ctx = null
    let stealth = null
    let bridge = null
    let environment = null
    let instrumentation = null
    let invoker = null
    let record = null
    let failure = null
    let releaseStackGuard = null
    const disposalErrors = []
    let leaked = false
    // Set when the runtime is abandoned instead of disposed (stack breach).
    let skippedRuntime = false
    // Set only from an engine stack signal (the invoker's `stackExhaustion`
    // marker): it, not a guest message, decides abandonment.
    let stackBreach = false
    let phase = 'init'

    try {
      // Acquisition is inside the guarded region: a failure here must still
      // dispose the runtime/context it created before it threw.
      //
      // The module is re-acquired every run because a failed disposal
      // quarantines it (`runtime.js`); `loadQuickJS()` returns the memoised
      // module while it is healthy and compiles a fresh WASM instance after a
      // stack-exhaustion abort.
      this.module = await loadQuickJS()
      runtimeHandle = createRuntime({
        module: this.module,
        limits: this.limits,
        clock,
        logger: this.logger,
        trace,
      })
      ctx = runtimeHandle.runtime.newContext()
      // Host-side evidence for the stack path that reaches the invoker as a
      // guest value: a host stack overflow escaping a host callback is turned
      // into a guest `Error` by the WASM trampoline, so the engine signal must
      // be recorded before that conversion (see `guardHostStackExhaustion`).
      releaseStackGuard = guardHostStackExhaustion(ctx, runtimeHandle)
      stealth = createStealth(ctx, {
        nonce: shortHash(`${runId}:stealth`, 10),
        trace,
        logger: this.logger,
      })
      stealth.install()

      bridge = createHostBridge({
        ctx,
        runtime: runtimeHandle.runtime,
        sandbox: this,
        profile: this.profile,
        clock,
        trace,
        logger: this.logger,
        stealth,
      })
      phase = 'run'

      hooks.emit('lifecycle:init', { runId, profile: this.profileSummary() })
      environment = await installEnvironment(bridge, {
        strict: runOptions.env?.strict ?? this.envOptions.strict,
        only: runOptions.env?.only ?? this.envOptions.only ?? null,
        exclude: runOptions.env?.exclude ?? this.envOptions.exclude ?? [],
        logger: this.logger,
      })

      applyNetworkPolicy(bridge, runOptions.network ?? this.options.network)

      const config = {
        ...this.instrumentationOptions,
        ...(runOptions.instrumentation ?? {}),
        code: { ...this.instrumentationOptions.code, ...(runOptions.instrumentation?.code ?? {}) },
      }
      instrumentation = createInstrumentation({
        ctx,
        bridge,
        stealth,
        trace,
        hooks,
        profile: this.profile,
        clock,
        logger: this.logger,
        config,
        environment,
      })
      instrumentation.install({ wrapApis: config.api !== false })

      const integrityBefore = captureIntegrity(ctx, { stealth, trace })

      invoker = createInvoker({
        ctx,
        runtime: runtimeHandle.runtime,
        bridge,
        stealth,
        profile: this.profile,
        clock,
        trace,
        logger: this.logger,
        limits: this.limits,
        hooks,
        instrumentation,
        // Host stack-overflow witness (see `guardHostStackExhaustion`).
        stackSignals: () => runtimeHandle.stackSignals(),
        limitReason: () => runtimeHandle.state.reason,
      })

      const invocation = invoker.invoke(source, {
        sourceUrl: runOptions.sourceUrl,
        filename: runOptions.filename,
        type: runOptions.type,
        level: runOptions.level ?? config.code.level,
        entry: runOptions.entry,
        args: runOptions.args,
      })

      let settle = null
      if (invocation.ok && !runtimeHandle.interrupted) {
        settle = invoker.settle({ ...(runOptions.settle ?? {}) })
      } else if (runtimeHandle.interrupted) {
        settle = { skipped: true, reason: runtimeHandle.state.reason }
      }

      // `record.limitsHit` is the union of both phases: a stack breach inside a
      // timer or promise callback leaves the *script* successful while the
      // runtime is just as unrecoverable as after a main-script overflow.
      const limitsHit = mergeLimits(invocation.limitsHit, settle?.limitsHit)
      // Abandonment is derived from the explicit engine marker only. A guest
      // error that happens to say "stack overflow" is a normal failure: the
      // runtime stays healthy and disposal must report `{ok: true, errors: []}`.
      stackBreach = Boolean(invocation.stackExhaustion || settle?.stackExhaustion)

      const integrityAfter = captureIntegrity(ctx, { stealth, trace })
      const integrity = diffIntegrity(integrityBefore, integrityAfter)

      hooks.emit('lifecycle:run', { runId, ok: invocation.ok, limitsHit })

      record = {
        runId,
        ok: invocation.ok,
        result: invocation.result ?? null,
        error: invocation.error ?? null,
        limitsHit,
        // Additive, explicit engine marker (see `disposal.skipped`).
        stackExhaustion: stackBreach,
        timedOut: Boolean(invocation.timedOut || settle?.timedOut),
        filename: invocation.filename,
        durationMs: invocation.durationMs ?? 0,
        virtualMs: settle?.virtualMs ?? Math.round(clock.elapsedMs),
        settle,
        facts: invocation.facts ?? null,
        vm: invocation.vm ?? null,
        instrumentation: {
          stats: invocation.prepared?.stats ?? null,
          describe: instrumentation.describe(),
        },
        environment,
        integrity: {
          intact: integrity.intact,
          drift: integrity.drift,
          intrinsicDrift: integrity.intrinsicDrift,
          addedGlobals: integrity.addedGlobals,
          removedGlobals: integrity.removedGlobals,
          beforeHash: integrity.beforeHash,
          afterHash: integrity.afterHash,
        },
        hooks: {
          registered: hookStats.registered,
          defaultHooks: hookStats.defaultHooks,
          fired: defaultSet.api?.fired ?? [],
          describe: hooks.describe(),
          errors: hooks.stats().errors,
        },
        runtime: runtimeHandle.stats(),
        clock: clock.stats(),
        stealth: stealth.stats(),
        profile: this.profileSummary(),
        events: runOptions.keepTrace === false ? null : trace.events.slice(),
        traceStats: trace.stats(),
      }
      return record
    } catch (error) {
      const sanitized = stealth
        ? stealth.sanitizeError({ name: error?.name, message: error?.message, stack: error?.stack })
        : { name: error?.name ?? 'Error', message: describeError(error), stack: error?.stack ?? '' }
      trace.emit('sandbox', 'error', { event: 'sandbox.run.failed', phase, error: sanitized })
      // A host stack `RangeError` can also escape from a host call site the
      // invoker does not wrap (an env module callback, for example). It is the
      // same engine signal, so record it and let the finally block abandon the
      // runtime instead of trying a dispose that would abort the WASM engine.
      stackBreach =
        stackBreach || isHostStackExhaustion(error) || (runtimeHandle ? runtimeHandle.stackSignals() > 0 : false)
      // Reporting a failure must never mask it: the snapshot is best-effort.
      let profileSnapshot = null
      try {
        profileSnapshot = this.profileSummary()
      } catch {
        profileSnapshot = null
      }
      failure = {
        runId,
        ok: false,
        error: sanitized,
        // A stack breach detected during settle survives into the failure record:
        // the finally block keys the quarantine off it, and the analyst must
        // still learn why the runtime could not be released.
        limitsHit: stackBreach ? ['stack'] : [],
        stackExhaustion: stackBreach,
        durationMs: 0,
        virtualMs: Math.round(clock.elapsedMs),
        events: runOptions.keepTrace === false ? null : trace.events.slice(),
        traceStats: trace.stats(),
        profile: profileSnapshot,
        environment,
        instrumentation: instrumentation ? { describe: instrumentation.describe() } : null,
        hooks: { registered: hookStats.registered, describe: hooks.describe() },
        integrity: { intact: false, drift: [{ kind: 'not-captured', detail: 'run failed before integrity check' }] },
        runtime: runtimeHandle ? runtimeHandle.stats() : null,
      }
      this.lastRun = failure
      // Every escaping failure is a typed error: an empty message (the shape a
      // poisoned WASM module throws) must never reach an analyst.
      const code = phase === 'init' ? 'SANDBOX_INIT' : 'SANDBOX_RUN'
      const message =
        error instanceof SandboxError && describeError(error)
          ? describeError(error)
          : `${phase === 'init' ? 'sandbox init failed' : 'sandbox run failed'}: ${describeError(error) || 'unknown error'}`
      throw new SandboxError(message, {
        code,
        cause: error,
        details: { runId, phase, environment: environment?.missing },
      })
    } finally {
      hooks.emit('lifecycle:dispose', { runId })
      // A stack-limit breach leaves handles on the runtime's GC list, so
      // `runtime.dispose()` would abort the WASM engine and print
      // `Aborted(Assertion failed: list_empty(&rt->gc_obj_list))` to stderr (see
      // `runtime.js`). Abandon the runtime and quarantine the module instead;
      // the run record still states the leak (`disposal.skipped`). The breach
      // is known from the engine marker only (`stackExhaustion`), set by the
      // invoker when the host threw the stack `RangeError` — in the main script
      // or in the event loop; both leave the same unrecoverable heap.
      const abandonRuntime = stackBreach || Boolean(record?.stackExhaustion) || Boolean(failure?.stackExhaustion)
      // Reverse acquisition order; every step is independent, so one failing
      // disposal never skips the next one.
      for (const [label, fn] of [
        ['stack-guard', () => releaseStackGuard?.()],
        ['instrumentation', () => instrumentation?.dispose()],
        ['bridge', () => bridge?.disposeAll()],
        ['stealth', () => stealth?.dispose()],
        ['context', () => ctx?.dispose()],
        ['runtime', () => {
          if (abandonRuntime && runtimeHandle) {
            runtimeHandle.abandon()
            skippedRuntime = true
            return
          }
          const result = runtimeHandle?.dispose()
          if (result && result.ok === false) {
            // `runtime.dispose()` returning not-ok means the WASM heap is
            // corrupted (handle leak / stack exhaustion): the module has been
            // quarantined and the guaranteed clean teardown did not hold.
            leaked = true
            throw result.error ?? new Error('runtime disposal failed (handle leak)')
          }
        }],
        ['clock', () => clock.dispose()],
      ]) {
        try {
          fn()
        } catch (error) {
          if (label === 'runtime') leaked = true
          disposalErrors.push({ stage: label, message: describeError(error) })
          this.logger?.error?.({ stage: label, err: describeError(error) }, 'sandbox disposal failed')
        }
      }
      // Failure shape is additive: successful disposals keep the existing
      // `{ ok: true, errors: [] }` contract, while a failed one also states
      // whether the WASM heap was corrupted (`leaked`) and at which stage.
      const disposal = { ok: disposalErrors.length === 0 && !skippedRuntime, errors: disposalErrors }
      if (skippedRuntime) {
        // Outran the stack limit, so the runtime can never be released; the
        // module was quarantined and the next run recompiles it.
        disposal.leaked = true
        disposal.stage = 'runtime'
        disposal.skipped = true
      } else if (!disposal.ok) {
        disposal.leaked = leaked
        disposal.stage = disposalErrors[0]?.stage ?? null
      }
      for (const target of [record, failure]) {
        if (target) target.disposal = disposal
      }
      if (record) {
        this.lastRun = record
        this.runHistory.push({
          runId,
          ok: record.ok,
          at: Date.now(),
          events: record.traceStats?.total ?? 0,
          limitsHit: record.limitsHit,
        })
        if (this.runHistory.length > 50) this.runHistory.shift()
      }
    }
  }

  /**
   * Static analysis only (no execution).
   * @param {string} source
   * @param {object} [options]
   */
  analyze(source, options = {}) {
    return analyzeSource(source, {
      filename: options.filename,
      maxStrings: options.maxStrings,
      ...options,
    })
  }

  dispose() {
    this.disposed = true
    this.module = null
  }
}

/**
 * Union of two limit lists, in first-seen order.
 * @param {string[]|undefined|null} left
 * @param {string[]|undefined|null} right
 * @returns {string[]}
 */
function mergeLimits(left, right) {
  const merged = []
  for (const value of [...(left ?? []), ...(right ?? [])]) {
    if (typeof value === 'string' && !merged.includes(value)) merged.push(value)
  }
  return merged
}

/**
 * Non-empty textual description of anything that can be thrown.
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  if (message) return message
  const name = typeof error.name === 'string' ? error.name.trim() : ''
  if (name) return name
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * Apply a network policy/routing configuration to the env network service.
 * Configuration is declarative so an orchestrator can pass it per run:
 * `{ policy: 'deny'|'empty'|'echo', routes: [{match, response}], handlers: [fn] }`
 * @param {object} bridge
 * @param {object|undefined} config
 */
export function applyNetworkPolicy(bridge, config) {
  if (!config || !bridge?.network) return null
  const service = bridge.network
  try {
    if (typeof config.policy === 'string') service.setPolicy?.(config.policy)
    if (Array.isArray(config.routes)) service.setRoutes?.(config.routes)
    for (const handler of config.handlers ?? []) service.registerHandler?.(handler)
    return service.stats?.() ?? null
  } catch {
    return null
  }
}

export { createProfile, consistencyReport }
