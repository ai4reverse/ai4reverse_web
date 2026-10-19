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
 *  - full handle disposal, verified by the WASM runtime's leak assertion.
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

    const runtimeHandle = createRuntime({
      module: this.module,
      limits: this.limits,
      clock,
      logger: this.logger,
      trace,
    })
    const ctx = runtimeHandle.runtime.newContext()
    const stealth = createStealth(ctx, {
      nonce: shortHash(`${runId}:stealth`, 10),
      trace,
      logger: this.logger,
    })
    stealth.install()

    const bridge = createHostBridge({
      ctx,
      runtime: runtimeHandle.runtime,
      sandbox: this,
      profile: this.profile,
      clock,
      trace,
      logger: this.logger,
      stealth,
    })

    let environment = null
    let instrumentation = null
    let invoker = null
    let record = null
    let disposalErrors = []

    try {
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
      const sanitized = stealth.sanitizeError({ name: error?.name, message: error?.message, stack: error?.stack })
      trace.emit('sandbox', 'error', { event: 'sandbox.run.failed', error: sanitized })
      const failure = {
        runId,
        ok: false,
        error: sanitized,
        limitsHit: [],
        durationMs: 0,
        virtualMs: Math.round(clock.elapsedMs),
        events: runOptions.keepTrace === false ? null : trace.events.slice(),
        traceStats: trace.stats(),
        profile: this.profileSummary(),
        environment,
        instrumentation: instrumentation ? { describe: instrumentation.describe() } : null,
        hooks: { registered: hookStats.registered, describe: hooks.describe() },
        integrity: { intact: false, drift: [{ kind: 'not-captured', detail: 'run failed before integrity check' }] },
        runtime: runtimeHandle.stats(),
      }
      this.lastRun = failure
      if (error instanceof SandboxError) throw error
      throw new SandboxError(`sandbox run failed: ${error?.message ?? error}`, {
        cause: error,
        details: { runId, environment: environment?.missing },
      })
    } finally {
      hooks.emit('lifecycle:dispose', { runId })
      for (const [label, fn] of [
        ['instrumentation', () => instrumentation?.dispose()],
        ['bridge', () => bridge.disposeAll()],
        ['stealth', () => stealth.dispose()],
        ['context', () => ctx.dispose()],
        ['runtime', () => {
          const result = runtimeHandle.dispose()
          if (result && result.ok === false) throw result.error ?? new Error('runtime disposal failed (handle leak)')
        }],
        ['clock', () => clock.dispose()],
      ]) {
        try {
          fn()
        } catch (error) {
          disposalErrors.push({ stage: label, message: error?.message ?? String(error) })
          this.logger?.error?.({ stage: label, err: error?.message }, 'sandbox disposal failed')
        }
      }
      if (record) {
        record.disposal = { ok: disposalErrors.length === 0, errors: disposalErrors }
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
