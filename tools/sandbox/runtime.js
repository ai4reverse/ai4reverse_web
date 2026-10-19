import { getQuickJS, newQuickJSWASMModule } from 'quickjs-emscripten'

/**
 * QuickJS module + runtime lifecycle.
 *
 * A single WASM module instance is reused (WASM compilation is expensive); each
 * analysis run gets a *fresh runtime and context* so no state survives between
 * samples. That is both the isolation guarantee and the tracelessness
 * guarantee: after a run the next sample starts from pristine intrinsics.
 *
 * Module quarantine: a guest that exhausts the QuickJS native stack leaves
 * objects on the runtime's GC list, so `runtime.dispose()` aborts with
 * `list_empty(&rt->gc_obj_list)`. The abort is engine-inherent (the WASM heap
 * cannot be repaired) and it poisons the *whole module*: every later
 * `newRuntime()` on it throws a message-less `QuickJSUnwrapError`. A failed
 * disposal therefore marks the module unhealthy and `loadQuickJS()` compiles a
 * fresh one, so one hostile recursion cannot disable analysis for the rest of
 * the process.
 */

let modulePromise = null
let loadedModule = null

/** @type {WeakSet<object>} modules whose WASM heap is known to be corrupted */
const unhealthyModules = new WeakSet()

/**
 * Quarantine a module whose heap can no longer be trusted.
 *
 * Internal (not part of `tools/index.js`): called from `createRuntime()` when
 * `runtime.dispose()` fails, and from tests that need to force the path.
 * @param {object} module QuickJS WASM module
 */
export function markModuleUnhealthy(module) {
  if (module && (typeof module === 'object' || typeof module === 'function')) {
    unhealthyModules.add(module)
  }
}

/**
 * @param {object|null} module
 * @returns {boolean}
 */
function isUnhealthy(module) {
  return Boolean(module) && unhealthyModules.has(module)
}

/**
 * The shared `getQuickJS()` singleton is memoised inside quickjs-emscripten and
 * cannot be discarded from here, so it is only reused while it is healthy.
 * @returns {Promise<object>}
 */
async function acquireModule() {
  const shared = await getQuickJS()
  // Once the singleton is quarantined a *new* WASM instance is the only way to
  // get a clean heap; `newQuickJSWASMModule()` compiles an isolated module.
  return isUnhealthy(shared) ? newQuickJSWASMModule() : shared
}

/**
 * Load (and memoise) a healthy QuickJS WASM module.
 * @returns {Promise<object>}
 */
export function loadQuickJS() {
  if (!modulePromise || isUnhealthy(loadedModule)) {
    const promise = acquireModule()
      .then((module) => {
        loadedModule = module
        return module
      })
      .catch((error) => {
        if (modulePromise === promise) {
          modulePromise = null
          loadedModule = null
        }
        throw error
      })
    modulePromise = promise
  }
  return modulePromise
}

/** Test helper: drop the memoised module (so the next load re-acquires one). */
export function resetQuickJS() {
  modulePromise = null
  loadedModule = null
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
    module,
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
        // so report it as a failed disposal instead of hiding it, and make sure
        // no later run reuses the corrupted module.
        markModuleUnhealthy(module)
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
