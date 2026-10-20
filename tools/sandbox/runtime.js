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
 *
 * The abort is best avoided rather than survived: the emscripten build prints
 * `Aborted(Assertion failed: ...)` to the host's stderr before the assertion
 * throws, which pollutes CI logs and any operator watching the process. A run
 * that already knows the stack limit was breached abandons the runtime instead
 * — see `abandon()`. A host throw out of a WASM call is the only unforgeable
 * evidence (`isHostStackExhaustion`); an interpreter-level `InternalError` is
 * classified from intrinsic identity in `tools/invocation/stealth.js`, never
 * from the dumped `name`/`message` a sample can copy.
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
    /**
     * How many times a *host* stack overflow was observed inside this run: out
     * of the WASM trampoline, or escaping a host callback it wraps. Guest code
     * cannot write this counter, so it — and only it — may certify the engine
     * paths that reach us as a guest value (see `guardHostStackExhaustion`).
     */
    stackSignals: 0,
    /** Which host boundary saw the signal last; diagnostics only, not a record. */
    stackOrigin: null,
  }

  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(limits.stackBytes)

  /**
   * Interrupt checks are the hottest host call in the run, and QuickJS calls
   * them from the interpreter loop — i.e. with the WASM stack as deep as the
   * guest recursion is. When the *host* stack gives out here, the V8
   * `RangeError` is the engine's own evidence; record it before the exception
   * unwinds (and before the WASM trampoline may turn it into a guest value).
   */
  const interrupt = () => {
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
  }

  runtime.setInterruptHandler(() => {
    try {
      return interrupt()
    } catch (error) {
      noteHostStackExhaustion(state, error, 'interrupt')
      throw error
    }
  })

  let disposed = false
  let abandoned = false
  return {
    runtime,
    state,
    limits,
    module,
    /**
     * Number of host stack-overflow signals observed in this run.
     *
     * A monotonically increasing count lets the caller attribute a signal to
     * the phase or callback it happened in without reading a host path, so the
     * record stays a pure function of the sample.
     * @returns {number}
     */
    stackSignals() {
      return state.stackSignals
    },
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
    /**
     * Give up on this runtime without calling `runtime.dispose()`.
     *
     * Only for the stack-exhaustion path: the guest left handles on the
     * runtime's GC list, so `dispose()` would abort the engine and print the
     * `list_empty(&rt->gc_obj_list)` assertion to stderr. The heap cannot be
     * repaired, so the module is quarantined here (the next `loadQuickJS()`
     * compiles a fresh one) and the runtime itself is deliberately leaked into
     * the abandoned module.
     *
     * @returns {{ok: false, skipped: true}}
     */
    abandon() {
      // Idempotent: a second call must not claim a cleaner outcome than the
      // first one.
      if (disposed) return { ok: false, skipped: true }
      disposed = true
      abandoned = true
      markModuleUnhealthy(module)
      // `debug`, not `error`: an abandoned runtime is an expected outcome of a
      // hostile sample, and the run record carries the truth (`disposal`).
      logger?.debug?.({ reason: 'stack-limit' }, 'runtime abandoned; WASM module quarantined')
      trace?.emit('sandbox', 'error', { event: 'runtime.dispose.skipped', reason: 'stack-limit' })
      return { ok: false, skipped: true }
    },
    dispose() {
      // An abandoned runtime was never released, so a later `dispose()` must not
      // claim a clean teardown.
      if (abandoned) return { ok: false, skipped: true }
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
 * The wording of a real engine stack overflow.
 *
 * At the default stack limit the WASM trampoline throws a *host* `RangeError`
 * (`Maximum call stack size exceeded`) out of
 * `evalCode`/`callFunction`/`executePendingJobs`. That host object is created
 * outside the guest heap, so a sample cannot fabricate it with
 * `throw new Error('stack overflow')` — which is why host throws, and only host
 * throws, may be read as proof that the stack is gone.
 *
 * The same overflow does not always arrive the same way: when the host stack
 * gives out *inside* a host callback, quickjs-emscripten catches the JS
 * exception and rethrows it into the guest as `ctx.newError(error)` — a guest
 * `Error` carrying the host name and message, shape-identical to a sample's own
 * forgery. `guardHostStackExhaustion` records that signal host-side before the
 * conversion, so both shapes classify as one (see `tools/invocation/invoke.js`).
 *
 * A reduced `limits.stackBytes` lets QuickJS' own interpreter check fire first,
 * which surfaces `InternalError: stack overflow` as a *guest* value with no host
 * throw at all. That value carries no provenance, so it is classified in
 * `tools/invocation/stealth.js` from intrinsic identity — against a prototype the
 * guest cannot reach — and never from this text.
 */
const ENGINE_STACK_MESSAGE = /maximum call stack size exceeded|stack overflow/i

/**
 * Does this string (or `{message}` record) carry the engine's stack wording?
 *
 * Matching a *message* is only meaningful for host evidence. Never call this
 * with a dumped guest error, whose message the sample controls.
 *
 * Internal: `isHostStackExhaustion` is the only sanctioned entry point, so no
 * caller can accidentally apply the wording test to guest data.
 *
 * @param {string|{message?: unknown}|null|undefined} value
 * @returns {boolean}
 */
function isEngineStackMessage(value) {
  const message = typeof value === 'string' ? value : String(value?.message ?? '')
  return ENGINE_STACK_MESSAGE.test(message)
}

/**
 * Is this host-thrown value the engine's stack-overflow signal?
 *
 * Only the host catch sites (`ctx.evalCode`, `ctx.callFunction`,
 * `ctx.executePendingJobs`) can observe it. A guest `throw` of the same name,
 * message — or both — comes back from the engine as a *value* instead, so it
 * can never reach this predicate as a host exception.
 *
 * @param {unknown} thrown value caught at a host call site
 * @returns {boolean}
 */
export function isHostStackExhaustion(thrown) {
  if (!thrown || typeof thrown !== 'object') return false
  const name = typeof thrown.name === 'string' ? thrown.name : ''
  // `Error` is accepted because emscripten wraps some aborts in a plain Error.
  if (name !== 'RangeError' && name !== 'Error') return false
  return isEngineStackMessage(thrown)
}

/**
 * Stricter predicate for the *callback boundary* (`isHostStackExhaustion` is
 * fine where a host throw escapes the WASM call, because no host code can put
 * guest text into it).
 *
 * At a host callback boundary the message can be guest-influenced: env shims
 * throw ``new RangeError(`Invalid key : ${key}`)``, so a sample that picks `key`
 * can bury the engine's wording inside a host error. Only an *exact* match is
 * beyond that reach, so there the phrase must be the whole message.
 *
 * @param {unknown} thrown host value caught at a callback boundary
 * @returns {boolean}
 */
function isCallbackStackExhaustion(thrown) {
  if (!thrown || typeof thrown !== 'object') return false
  if (thrown.name !== 'RangeError') return false
  const message = thrown.message
  if (typeof message !== 'string') return false
  // Exact comparison only. This runs with the host stack already exhausted, so
  // it must not compile a RegExp, build a template string or allocate at all —
  // V8 answers `new RegExp(/…/)` there with a *second* RangeError
  // ("Invalid regular expression: …: Maximum call stack size exceeded"), which
  // would replace the engine's own evidence with a fabricated one.
  return message === 'Maximum call stack size exceeded' || message === 'stack overflow'
}

/**
 * Record a host stack-overflow signal on the run.
 * @param {{stackSignals: number, stackOrigin: string|null}} state
 * @param {unknown} thrown
 * @param {string} origin boundary that saw it
 * @returns {boolean} true when `thrown` really was the signal
 */
function noteHostStackExhaustion(state, thrown, origin) {
  if (!isCallbackStackExhaustion(thrown)) return false
  state.stackSignals += 1
  state.stackOrigin = origin
  return true
}

/**
 * Wrap every host callback the guest can reach so that a stack overflow the WASM
 * trampoline is about to convert into a guest value is recorded host-side
 * first.
 *
 * Why a wrapper: `quickjs-emscripten` catches a JS exception escaping a host
 * function and rethrows it into the guest as `ctx.newError(error)` — a guest
 * `Error` carrying the host `name`/`message`. That value is shape-identical to
 * a sample's own forgery, so the engine's evidence would be lost. The counter
 * written here is not reachable from guest code, and the invoker classifies
 * from it (see `tools/invocation/invoke.js`). The exception is rethrown
 * unchanged, so the trampoline keeps its own behaviour.
 *
 * Must be called once per context, *before* any environment module installs a
 * host function.
 *
 * @param {object} ctx QuickJS context
 * @param {object} run runtime wrapper from `createRuntime`
 * @returns {() => void} restore hook
 */
export function guardHostStackExhaustion(ctx, run) {
  const state = run?.state
  const original = ctx?.newFunctionWithOptions
  if (!state || typeof original !== 'function') return () => {}
  const guarded = function guardedNewFunctionWithOptions(args) {
    const fn = args?.fn
    if (typeof fn !== 'function') return original.call(this, args)
    const wrapped = function guardedHostCallback(...callArgs) {
      try {
        return fn.apply(this, callArgs)
      } catch (error) {
        noteHostStackExhaustion(state, error, 'callback')
        throw error
      }
    }
    // quickjs-emscripten derives the guest-visible `name`/`length` from these.
    try {
      Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true })
      Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true })
    } catch {
      /* the explicit options below still define the guest-visible function */
    }
    return original.call(this, { ...args, fn: wrapped })
  }
  ctx.newFunctionWithOptions = guarded
  return () => {
    if (ctx.newFunctionWithOptions === guarded) ctx.newFunctionWithOptions = original
  }
}

