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

  const beginFor = (token) => `/*#${token}*/`
  const endFor = (token) => `/*#/${token}*/`

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
     * Install `Function.prototype.toString` masking.
     * Must run before guest code and before any shim identity check.
     */
    install() {
      if (installed) return
      installed = true
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
    },
  }

  return stealth
}

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
