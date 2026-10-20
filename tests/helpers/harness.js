import { loadQuickJS, createRuntime } from '../../tools/engine/runtime.js'
import { normalizeLimits } from '../../tools/engine/limits.js'
import { createVirtualClock } from '../../tools/sandbox/clock.js'
import { createProfile } from '../../tools/sandbox/profile.js'
import { createHostBridge } from '../../tools/sandbox/bridge.js'
import { createStealth } from '../../tools/invocation/stealth.js'
import { createTraceRecorder } from '../../tools/instrumentation/trace.js'
import { installEnvironment } from '../../tools/sandbox/env/index.js'

/**
 * Test harness: a minimal but real sandbox context.
 *
 * Environment modules are unit-tested against this harness rather than the full
 * `TracelessSandbox`, so a broken instrumentation layer cannot mask an
 * environment bug (and vice versa). It uses the production bridge, stealth
 * masker and virtual clock — the same code paths as a real analysis run.
 *
 * @param {object} [options]
 * @param {string[]} [options.modules] env modules to install
 * @param {object} [options.profile] profile overrides
 * @param {object} [options.limits]
 * @param {number|string} [options.seed]
 */
export async function createHarness(options = {}) {
  const {
    modules = ['globals', 'console', 'timers', 'encoding', 'anti-fingerprint'],
    profile: profileOverrides = {},
    limits: limitOverrides = {},
    seed = 0x5eed,
  } = options

  const module = await loadQuickJS()
  const limits = normalizeLimits({ timeoutMs: 3000, ...limitOverrides })
  const profile = createProfile({ seed, ...profileOverrides })
  const clock = createVirtualClock({ epoch: profile.epoch, seed: String(seed) })
  const runtimeHandle = createRuntime({ module, limits, clock })
  const ctx = runtimeHandle.runtime.newContext()
  const trace = createTraceRecorder({ clock: () => clock.now() })
  const stealth = createStealth(ctx, { nonce: 'harness', trace })
  stealth.install()
  const bridge = createHostBridge({ ctx, runtime: runtimeHandle.runtime, profile, clock, trace, stealth })
  const env = await installEnvironment(bridge, { only: modules, strict: false })

  let disposed = false
  /** @type {{ok: boolean, leaked: boolean, skipped: boolean, error?: unknown}} */
  let disposal = { ok: true, leaked: false, skipped: false }
  const harness = {
    ctx,
    runtime: runtimeHandle.runtime,
    bridge,
    stealth,
    clock,
    profile,
    trace,
    env,
    /** Evaluate guest code and return a plain value or error. */
    run(code, filename = 'https://example.test/app.js') {
      const result = ctx.evalCode(String(code), filename, { type: 'global' })
      if (result.error) {
        const dumped = stealth.sanitizeError(ctx.dump(result.error))
        result.error.dispose()
        return { ok: false, error: dumped }
      }
      const value = ctx.dump(result.value)
      result.value.dispose()
      return { ok: true, value }
    },
    /** Drain pending promise jobs (needed for .then / digest tests). */
    jobs(max = 100) {
      for (let i = 0; i < max && runtimeHandle.runtime.hasPendingJob(); i += 1) {
        const result = runtimeHandle.runtime.executePendingJobs(10)
        if (result.error) {
          const dumped = ctx.dump(result.error)
          result.error.dispose()
          return { ok: false, error: dumped }
        }
        result.value.dispose?.()
      }
      return { ok: true }
    },
    /** Run due timers on the virtual clock. */
    timers(options = {}) {
      const advanced = clock.advanceToNextTimer(options.maxVirtualMs ?? 60_000)
      const result = clock.runDue(options)
      return { ...result, advancedMs: result.advancedMs + advanced }
    },
    /**
     * Tear the harness down and report how the runtime was released.
     *
     * The engine aborts (`Aborted(Assertion failed: list_empty(&rt->gc_obj_list))`)
     * when a handle is still alive at `JS_FreeRuntime`, which also quarantines
     * the WASM module for the rest of the process. That print is only visible in
     * the log, so the result is returned instead: `leaked` is true exactly when a
     * surface kept a duplicated handle past teardown, and a test that exercises
     * such a surface asserts on it rather than letting the abort scroll past.
     *
     * @returns {{ok: boolean, leaked: boolean, skipped: boolean, error?: unknown}}
     */
    dispose() {
      if (disposed) return disposal
      disposed = true
      bridge.disposeAll()
      stealth.dispose()
      try {
        ctx.dispose()
      } catch {
        /* keep harness failures in the assertions */
      }
      const runtimeDisposal = runtimeHandle.dispose()
      clock.dispose()
      disposal = {
        ok: runtimeDisposal?.ok === true,
        // An abandoned runtime (stack-limit path) is deliberately not freed, so
        // it must not be reported as a handle leak.
        leaked: runtimeDisposal?.ok === false && runtimeDisposal.skipped !== true,
        skipped: runtimeDisposal?.skipped === true,
        error: runtimeDisposal?.error,
      }
      return disposal
    },
  }
  return harness
}
