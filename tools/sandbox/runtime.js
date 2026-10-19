import { getQuickJS } from 'quickjs-emscripten'

/**
 * QuickJS module + runtime lifecycle.
 *
 * A single WASM module instance is reused (WASM compilation is expensive); each
 * analysis run gets a *fresh runtime and context* so no state survives between
 * samples. That is both the isolation guarantee and the tracelessness
 * guarantee: after a run the next sample starts from pristine intrinsics.
 */

let modulePromise = null

/**
 * Load (and memoise) the QuickJS WASM module.
 * @returns {Promise<object>}
 */
export function loadQuickJS() {
  if (!modulePromise) {
    modulePromise = getQuickJS().catch((error) => {
      modulePromise = null
      throw error
    })
  }
  return modulePromise
}

/** Test helper: drop the memoised module. */
export function resetQuickJS() {
  modulePromise = null
}

/**
 * @param {object} options
 * @param {object} options.module QuickJS WASM module
 * @param {object} options.limits normalized limits
 * @param {object} options.clock virtual clock
 * @param {object} [options.logger]
 * @param {object} [options.trace]
 */
export function createRuntime(options) {
  const { module, limits, clock, logger, trace } = options
  const runtime = module.newRuntime()
  const state = {
    poisoned: false,
    reason: null,
    interrupts: 0,
    startedAt: Date.now(),
    memoryBreach: false,
  }

  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(limits.stackBytes)

  runtime.setInterruptHandler(() => {
    state.interrupts += 1
    // Guest-visible time advances deterministically from traced statements
    // (clock.tick() in the instrumentation channel), never from host speed.
    if (state.poisoned) return true
    if (clock.elapsedMs > limits.maxVirtualMs) {
      state.reason = 'virtual-time'
      return true
    }
    if (Date.now() - state.startedAt > limits.timeoutMs) {
      state.reason = 'timeout'
      return true
    }
    return false
  })

  let disposed = false
  return {
    runtime,
    state,
    limits,
    /** Stop guest execution at the next interrupt check. */
    poison(reason = 'aborted') {
      state.poisoned = true
      state.reason = state.reason ?? reason
    },
    get interrupted() {
      return state.reason !== null
    },
    stats() {
      return {
        interrupts: state.interrupts,
        reason: state.reason,
        hostMs: Date.now() - state.startedAt,
        virtualMs: Math.round(clock.elapsedMs),
      }
    },
    dispose() {
      if (disposed) return { ok: true }
      disposed = true
      try {
        runtime.dispose()
        return { ok: true }
      } catch (error) {
        // A leaked handle aborts the whole WASM module. This is a platform bug,
        // so report it as a failed disposal instead of hiding it.
        logger?.error?.({ err: error?.message }, 'runtime dispose aborted (handle leak)')
        trace?.emit('sandbox', 'error', { event: 'runtime.dispose.failed', message: error?.message })
        return { ok: false, error }
      }
    },
  }
}

/**
 * Classify a guest error as a limit breach when applicable.
 * @param {object|null} dumpedError
 * @param {object} runtimeState
 */
export function classifyLimit(dumpedError, runtimeState) {
  if (runtimeState.reason) {
    if (runtimeState.reason === 'timeout') return 'timeout'
    if (runtimeState.reason === 'virtual-time') return 'virtual-time'
  }
  const message = String(dumpedError?.message ?? '')
  if (/interrupted/i.test(message)) return 'timeout'
  if (/out of memory/i.test(message)) return 'memory'
  if (/stack overflow|too deep|Maximum call stack/i.test(message)) return 'stack'
  return null
}
