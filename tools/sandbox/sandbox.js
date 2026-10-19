import { loadQuickJS, createRuntime } from './runtime.js'
import { normalizeLimits, DEFAULT_LIMITS } from './limits.js'
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
 *  - the exception is the stack-limit path, where the runtime cannot be
 *    released at all: it is abandoned, the WASM module is quarantined and the
 *    next run recompiles it (reported as `disposal.skipped`).
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
   * @param {string} source
   * @param {object} [runOptions]
   * @returns {Promise<object>} run record
   */
  async run(source, runOptions = {}) {
    if (this.disposed) throw new SandboxError('sandbox has been disposed')
    if (!this.module) await this.init()
    if (typeof source !== 'string' || source.length === 0) {
      throw new SandboxError('source must be a non-empty string')
    }

    this.runSeq += 1
    const runId = `run-${this.runSeq}-${shortHash(`${this.seed}:${this.runSeq}:${source}`, 8)}`
    const clock = createVirtualClock({ epoch: this.profile.epoch, seed: runId, logger: this.logger })
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
    const disposalErrors = []
    let leaked = false
    // Set when the runtime is abandoned instead of disposed (stack breach).
    let skippedRuntime = false
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

      const integrityAfter = captureIntegrity(ctx, { stealth, trace })
      const integrity = diffIntegrity(integrityBefore, integrityAfter)

      hooks.emit('lifecycle:run', { runId, ok: invocation.ok, limitsHit: invocation.limitsHit })

      record = {
        runId,
        ok: invocation.ok,
        result: invocation.result ?? null,
        error: invocation.error ?? null,
        limitsHit: invocation.limitsHit ?? [],
        timedOut: Boolean(invocation.timedOut),
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
        limitsHit: [],
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
      // the run record still states the leak (`disposal.skipped`).
      const stackBreach = Boolean(record?.limitsHit?.includes('stack'))
      // Reverse acquisition order; every step is independent, so one failing
      // disposal never skips the next one.
      for (const [label, fn] of [
        ['instrumentation', () => instrumentation?.dispose()],
        ['bridge', () => bridge?.disposeAll()],
        ['stealth', () => stealth?.dispose()],
        ['context', () => ctx?.dispose()],
        ['runtime', () => {
          if (stackBreach && runtimeHandle) {
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
