import { HandleBag } from '../util/disposable.js'
import { createSeededRandom } from '../util/random.js'

/**
 * Traceless invocation primitives.
 *
 * Three mechanisms make instrumentation and platform shims invisible to the
 * analysed code:
 *
 *  1. **Native functions.** Anything the platform provides is created with
 *     `newFunctionWithOptions`, so `name`, `length` and `Function.prototype.toString`
 *     (`function name() { [native code] }`) match a real browser, and no host
 *     frame ever appears in a guest stack trace.
 *  2. **Marker masking.** Source instrumentation inserts
 *     `/*#token*​/ ... /*#/token*​/` spans. `Function.prototype.toString` is
 *     replaced with a *native* host function that strips exactly those spans,
 *     restoring the original source byte-for-byte. Code that inspects its own
 *     source therefore sees untouched text.
 *  3. **Shim masking.** Guest-side shims (virtual `Date`, `Intl`, ...) are
 *     registered with their native-looking source text; `toString` returns
 *     `[native code]` for them, so a shim cannot be distinguished from a
 *     built-in by brand checks.
 */

/**
 * @param {object} ctx QuickJSContext
 * @param {object} [options]
 * @param {string} [options.nonce]
 * @param {object} [options.trace]
 * @param {object} [options.logger]
 * @param {boolean} [options.maskToString]
 */
export function createStealth(ctx, options = {}) {
  const { nonce = randomNonce(), trace, logger, maskToString = true } = options
  const markers = new Set()
  const shimSources = new Map()
  const stats = { masked: 0, shims: 0, markers: markers.size, errors: 0 }
  let originalToString = null
  let installed = false
  // Guest predicates that answer "is this the engine's own stack overflow?"
  // from intrinsic identity; built once, before the environment removes the
  // engine's `InternalError` from the global object.
  let intrinsicStackMatch = null
  let intrinsicStackReachable = null
  let stackProbeAttempted = false
  /**
   * Reason the engine's stack identity may no longer be trusted, or null.
   *
   * Set by an environment module that leaves the engine's `InternalError`
   * prototype reachable (`env/stack.js` reports it when it cannot replace the
   * constructor with a fresh prototype). While a guest can obtain that prototype
   * it can also *build* an object with it, so identity proves nothing.
   */
  let stackEvidenceRevoked = null

  const beginFor = (token) => `/*#${token}*/`
  const endFor = (token) => `/*#/${token}*/`

  /**
   * Build the stack-overflow probe from the engine's own `InternalError`.
   *
   * Why a guest predicate: `instanceof` is not available from the host, and the
   * dumped record (`ctx.dump`) is attacker-controlled data. The predicate closes
   * over the intrinsic `InternalError.prototype` *and* the `Object.getPrototypeOf`
   * it was created with, so a sample that later rewrites `InternalError.prototype`
   * or `Symbol.hasInstance` cannot redirect the check.
   *
   * It must run during `install()`: `env/globals.js` deletes the global for every
   * non-Firefox profile, after which the constructor is no longer reachable here.
   *
   * @returns {{match: object|null, reachable: object|null}}
   */
  function ensureStackProbe() {
    if (stackProbeAttempted) return { match: intrinsicStackMatch, reachable: intrinsicStackReachable }
    stackProbeAttempted = true
    const ctor = safeEval('typeof InternalError === "function" ? InternalError : undefined')
    if (!ctor) return { match: null, reachable: null }
    let probe = null
    try {
      probe = safeEval(STACK_PROBE_SOURCE)
      if (!probe) return { match: null, reachable: null }
      const built = ctx.callFunction(probe, ctx.undefined, [ctor])
      if (built.error) {
        built.error.dispose()
        return { match: null, reachable: null }
      }
      try {
        intrinsicStackMatch = safeProp(built.value, 'isIntrinsicStackError')
        intrinsicStackReachable = safeProp(built.value, 'isPrototypeReachable')
      } finally {
        built.value.dispose()
      }
    } finally {
      probe?.dispose?.()
      ctor.dispose()
    }
    return { match: intrinsicStackMatch, reachable: intrinsicStackReachable }
  }

  /** Evaluate internal probe source; never leaves an undisposed handle behind. */
  function safeEval(source) {
    const result = ctx.evalCode(source, 'ai4r-internal:stack-probe')
    if (result.error) {
      result.error.dispose()
      return null
    }
    return result.value
  }

  /** `getProp` that tolerates a missing property instead of throwing. */
  function safeProp(target, key) {
    try {
      return ctx.getProp(target, key)
    } catch {
      return null
    }
  }

  /**
   * Call one probe predicate and read its boolean verdict.
   * @param {object|null} predicate guest function handle
   * @param {object[]} [args] guest argument handles
   * @returns {boolean}
   */
  function callProbe(predicate, args = []) {
    if (!predicate) return false
    let result
    try {
      result = ctx.callFunction(predicate, ctx.undefined, args)
    } catch {
      // Probing is diagnostics: it must never turn a guest failure into a host
      // throw, and an unanswerable probe is reported as "not the engine error".
      return false
    }
    if (result.error) {
      result.error.dispose()
      return false
    }
    try {
      return ctx.dump(result.value) === true
    } finally {
      result.value.dispose()
    }
  }

  /** Escape a string for use inside a RegExp. */
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  function stripMarkers(text) {
    let output = text
    for (const token of markers) {
      const pattern = new RegExp(
        `${escape(beginFor(token))}[\\s\\S]*?${escape(endFor(token))}`,
        'g',
      )
      output = output.replace(pattern, '')
    }
    return output
  }

  const stealth = {
    nonce,
    markers,

    /** Add a marker token (one per instrumentation layer). */
    registerMarker(token) {
      if (!token) return null
      markers.add(String(token))
      stats.markers = markers.size
      return token
    },

    /** Source string that opens a marker span. */
    begin(token = nonce) {
      stealth.registerMarker(token)
      return beginFor(token)
    },

    /** Source string that closes a marker span. */
    end(token = nonce) {
      return endFor(token)
    },

    /**
     * Register a guest-created function's source so `toString` reports the
     * native text instead. Used for platform shims.
     * @param {string} source exact source text QuickJS will report
     * @param {string} [nativeText]
     */
    registerShim(source, nativeText) {
      if (!source) return
      const key = normalizeSource(source)
      const native = nativeText ?? nativeTextFor(shimNameOf(source) || 'anonymous')
      shimSources.set(key, native)
      stats.shims = shimSources.size
    },

    /** Mask arbitrary source text (markers stripped, shims mapped). */
    mask(text) {
      if (typeof text !== 'string') return text
      const stripped = stripMarkers(text)
      const shim = shimSources.get(normalizeSource(stripped))
      if (shim) return shim
      return normalizeNativeSource(stripped)
    },

    /**
     * Create a guest function from source and register it as a native shim.
     * The generated source must be a function expression.
     *
     * @param {{name: string, params?: string[], body: string, arity?: number}} definition
     * @returns {object} guest function handle
     */
    nativeFunction({ name, params = [], body, arity = params.length }) {
      const argList = params.join(', ')
      const source = `function ${name}(${argList}) {\n${body}\n}`
      const result = ctx.evalCode(`(${source})`, 'ai4r-internal:shim')
      if (result.error) {
        const dumped = ctx.dump(result.error)
        result.error.dispose()
        throw new Error(`native shim ${name} failed to compile: ${dumped?.message ?? dumped}`)
      }
      const handle = result.value
      stealth.registerShim(source, nativeTextFor(name, arity))
      stealth.setIdentity(handle, name, arity)
      return handle
    },

    /** Read a guest function's real source (bypassing the masker). */
    readSource(handle) {
      if (!originalToString) return ''
      const result = ctx.callFunction(originalToString, handle)
      if (result.error) {
        result.error.dispose()
        return ''
      }
      const text = ctx.getString(result.value)
      result.value.dispose()
      return text
    },

    /** Force name/length on a guest function without changing behaviour. */
    setIdentity(handle, name, length) {
      const bag = new HandleBag()
      try {
        const descriptor = bag.add(ctx.newObject())
        ctx.setProp(descriptor, 'value', bag.add(ctx.newString(name)))
        ctx.setProp(descriptor, 'writable', ctx.false)
        ctx.setProp(descriptor, 'enumerable', ctx.false)
        ctx.setProp(descriptor, 'configurable', ctx.true)
        const define = bag.add(
          ctx.unwrapResult(ctx.evalCode('(function(o,k,d){return Object.defineProperty(o,k,d)})')),
        )
        const callDefine = (key) => {
          const result = ctx.callFunction(define, ctx.undefined, [handle, bag.add(ctx.newString(key)), descriptor])
          if (result.error) result.error.dispose()
          else result.value.dispose()
        }
        callDefine('name')
        ctx.setProp(descriptor, 'value', bag.add(ctx.newNumber(length)))
        callDefine('length')
      } finally {
        bag.dispose()
      }
    },

    /**
     * Is this live guest error the engine's own stack overflow?
     *
     * Identity, not the dumped name: a sample can throw
     * `{ name: 'InternalError', message: 'Maximum call stack size exceeded' }`
     * or rename its own `Error`, and the old dump-based test classified both as
     * real engine exhaustion — abandoning a healthy runtime and writing a false
     * leak marker. This predicate is true only for an object whose prototype
     * chain contains the *captured* intrinsic `InternalError.prototype`, and it
     * refuses evidence while the guest can still reach that prototype
     * (`new InternalError(...)` is prototype-identical to the engine's own
     * throw, so reachability cancels the proof — see `revokeStackEvidence`).
     *
     * This is the only guest-derived classification channel; it is used for the
     * interpreter-level overflow a reduced `limits.stackBytes` produces, which
     * no host throw ever announces. Every other engine shape is certified
     * host-side (`isHostStackExhaustion`, `guardHostStackExhaustion`).
     *
     * The handle stays owned by the caller: nothing is consumed or disposed.
     *
     * @param {object} handle guest value handle of the thrown value
     * @returns {boolean}
     */
    isIntrinsicStackError(handle) {
      if (stackEvidenceRevoked) return false
      if (!handle || typeof handle.dispose !== 'function') return false
      const { match, reachable } = ensureStackProbe()
      if (!match) return false
      if (callProbe(reachable)) return false
      return callProbe(match, [handle])
    },

    /**
     * Withdraw guest-dump certification for the rest of the run.
     *
     * Called by an environment module that knows it left the engine's
     * `InternalError` prototype reachable from guest code: from then on a
     * `new InternalError(...)` (or `Object.create(InternalError.prototype)`) is
     * prototype-identical to the engine's own overflow, so a dump-shaped check
     * would let a sample force a stack quarantine (and a WASM recompile) per run.
     * The host-throw witness stays authoritative — it is not derived from guest
     * data at all.
     *
     * @param {string} [reason] why the evidence is unsound (diagnostics)
     */
    revokeStackEvidence(reason = 'guest-constructible') {
      if (stackEvidenceRevoked) return
      stackEvidenceRevoked = String(reason)
      trace?.emit('sandbox', 'emit', { event: 'stack.evidence.revoked', reason: stackEvidenceRevoked })
    },

    /**
     * Install `Function.prototype.toString` masking.
     * Must run before guest code and before any shim identity check.
     */
    install() {
      if (installed) return
      installed = true
      // Capture the engine's `InternalError` before `env/globals.js` deletes the
      // global binding; after that the intrinsic is only reachable from here.
      ensureStackProbe()
      originalToString = ctx.unwrapResult(ctx.evalCode('Function.prototype.toString'))
      const fnProto = ctx.unwrapResult(ctx.evalCode('Function.prototype'))
      const masker = ctx.newFunctionWithOptions({
        name: 'toString',
        length: 0,
        isConstructor: false,
        fn: function maskerFunction() {
          stats.masked += 1
          const target = this
          const result = ctx.callFunction(originalToString, target)
          if (result.error) return result.error
          try {
            const text = ctx.getString(result.value)
            return ctx.newString(stealth.mask(text))
          } finally {
            result.value.dispose()
          }
        },
      })
      ctx.setProp(fnProto, 'toString', masker)
      masker.dispose()
      fnProto.dispose()
      if (!maskToString) {
        // still installed: masking is what keeps instrumented code invisible
      }
      trace?.emit('sandbox', 'emit', { event: 'stealth.toString.installed', markers: markers.size })
    },

    /**
     * Evaluate a guest-side shim and register its source as native.
     * @param {string} source a complete expression/statement source
     * @param {string} [nativeName]
     */
    evalShim(source, nativeName) {
      const result = ctx.evalCode(String(source), 'ai4r-internal:shim')
      if (result.error) {
        const dumped = ctx.dump(result.error)
        result.error.dispose()
        throw new Error(`shim failed: ${dumped?.message ?? dumped}`)
      }
      stealth.registerShim(String(source), nativeName ? nativeTextFor(nativeName) : undefined)
      return result.value
    },

    /**
     * Sanitise a QuickJS stack trace so it looks like a browser stack from a
     * normal page: no `<eval>` frame marker, no host paths, no internal files.
     * @param {string} stack
     */
    sanitizeStack(stack) {
      if (typeof stack !== 'string') return stack
      return stack
        .replace(/at <eval> \(([^)]*)\)/g, 'at $1')
        .replace(/at <anonymous> \(([^)]*)\)/g, 'at $1')
        .replace(/^.*\bai4r-internal:[^\n]*$/gm, '')
        .replace(/^\s*at [^\n]*\(?ai4r-internal:[^\n]*\)?$/gm, '')
        .replace(/\(?\/(?:Users|home|private|var|tmp)\/[^\s():]+?([\w.-]+\.(?:js|mjs|cjs))(?::\d+:\d+)?\)?/g, '$1')
        .replace(/file:\/\/[^\s)]+/g, '')
        .replace(/node_modules\/[^\s():]+/g, '')
        .replace(/[ \t]+$/gm, '')
    },

    /** Sanitise a dumped guest error object. */
    sanitizeError(error) {
      if (!error || typeof error !== 'object') return error
      const clone = { ...error }
      if (typeof clone.stack === 'string') clone.stack = stealth.sanitizeStack(clone.stack)
      if (typeof clone.message === 'string') {
        clone.message = clone.message
          .replace(/\(?\/[^\s()]*node_modules\/[^\s()]*\)?/g, '')
          .replace(/file:\/\/[^\s)]+/g, '')
      }
      return clone
    },

    /** Remove residual platform markers from an arbitrary string. */
    sanitizeText(text) {
      return String(text)
        .replace(/ai4r-internal:[^\s)]*/g, '')
        .replace(/quickjs-emscripten/gi, '')
        .replace(/quickjs/gi, '')
    },

    stats() {
      return { ...stats, markers: markers.size }
    },

    dispose() {
      try {
        originalToString?.dispose()
      } catch {
        /* already gone */
      }
      originalToString = null
      for (const predicate of [intrinsicStackMatch, intrinsicStackReachable]) {
        try {
          predicate?.dispose()
        } catch {
          /* already gone */
        }
      }
      intrinsicStackMatch = null
      intrinsicStackReachable = null
      stackEvidenceRevoked = null
    },
  }

  return stealth
}

/**
 * Guest-side stack-overflow probe.
 *
 * `target` is the engine's `InternalError`, captured before any environment
 * module removes it. The returned predicates answer two questions from identity
 * alone, so no dumped (attacker-controlled) name or message takes part:
 *
 *  - `isIntrinsicStackError(value)`: is this object an instance of the engine's
 *    own error class? Walks the prototype chain against the captured
 *    `target.prototype` instead of using `instanceof`, so guest mutation of
 *    `Symbol.hasInstance` or `InternalError.prototype` cannot steer it.
 *  - `isPrototypeReachable()`: can the guest still reach `target.prototype`
 *    through the global object? QuickJS builds its own internal errors with
 *    that same prototype, so while it is in reach a guest-constructed
 *    `new InternalError(...)` is indistinguishable from a real overflow and the
 *    identity proof is void.
 *
 *    The question is about the *prototype*, not the constructor binding: a
 *    wrapper (or any other installer) can hide the intrinsic constructor while
 *    still exposing its prototype as `InternalError.prototype`, which is exactly
 *    the shape `env/stack.js` used to have — it wrapped the constructor but kept
 *    `Wrapped.prototype = Orig.prototype`, so `new InternalError(...)` produced a
 *    prototype-identical forgery. `env/stack.js` now gives the wrapper its own
 *    prototype (a faithful chain: `InternalError.prototype.__proto__` is
 *    `Error.prototype`), so the intrinsic prototype is unreachable and the
 *    identity proof holds.
 */
const STACK_PROBE_SOURCE = `(function (target) {
  var proto = target.prototype
  var getProto = Object.getPrototypeOf
  return {
    isIntrinsicStackError: function (value) {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
      try {
        var current = getProto(value)
        for (var depth = 0; current !== null && depth < 64; depth += 1) {
          if (current === proto) return true
          current = getProto(current)
        }
        return false
      } catch (error) {
        return false
      }
    },
    isPrototypeReachable: function () {
      try {
        var ctor = globalThis.InternalError
        if (ctor === undefined || ctor === null) return false
        return ctor.prototype === proto
      } catch (error) {
        return true
      }
    }
  }
})`

/** Deterministic marker token; a sandbox passes its own seeded nonce. */
function randomNonce() {
  return createSeededRandom('stealth-default').hex(10)
}

/** Whitespace-insensitive source fingerprint for shim registration. */
export function normalizeSource(source) {
  return String(source).replace(/\s+/g, ' ').trim()
}

/** Native-looking source for a named function, in V8's exact format. */
export function nativeTextFor(name, length = 0) {
  void length
  return name ? `function ${name}() { [native code] }` : 'function () { [native code] }'
}

/**
 * QuickJS formats native functions as
 *
 *     function name() {
 *         [native code]
 *     }
 *
 * while V8/Chrome/Firefox use the single-line form
 * `function name() { [native code] }`. A sample comparing native source text
 * exactly would otherwise detect QuickJS, so every native-looking string that
 * crosses the masker is normalised to the single-line form.
 * @param {string} text
 */
export function normalizeNativeSource(text) {
  const match = /^\s*function\s*([\w$]*)\s*\([^)]*\)\s*\{\s*\[native code\]\s*\}\s*$/.exec(text)
  if (!match) return text
  return nativeTextFor(match[1])
}

/** Extract the function name from a function-expression source string. */
export function shimNameOf(source) {
  const match = /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(source)
  return match ? match[1] : ''
}
