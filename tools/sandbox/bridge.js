import { HandleBag } from '../util/disposable.js'

/**
 * Host bridge: the only sanctioned way for environment modules to touch
 * quickjs-emscripten handles.
 *
 * Design goals, in priority order:
 *  1. Correctness of handle lifetime. The WASM runtime aborts on dispose if a
 *     single handle leaks, so every temporary is owned by a per-call bag.
 *  2. Fidelity. Guest-visible functions are created with
 *     `newFunctionWithOptions`, which preserves `name`, `length` and makes
 *     `Function.prototype.toString` report `[native code]` exactly like a real
 *     platform function. Host functions never create guest stack frames.
 *  3. Ergonomics for environment modules: primitives in, primitives out.
 */

/** Marker used for conversion failures that must not escape to the guest. */
const CONVERSION_FAILED = Symbol('conversion-failed')

/**
 * @param {object} options
 * @param {object} options.ctx QuickJSContext
 * @param {object} [options.runtime]
 * @param {object} [options.sandbox]
 * @param {object} [options.profile]
 * @param {object} [options.clock]
 * @param {object} [options.trace]
 * @param {object} [options.logger]
 */
export function createHostBridge(options) {
  const { ctx, runtime, sandbox, profile, clock, trace, logger, stealth } = options
  const bags = []
  const disposers = []
  /** Handles created by this bridge; disposed once at teardown. */
  const owned = new Set()
  const stats = { calls: 0, errors: 0, conversions: 0 }

  const definePropertyFactory = take(
    ctx.evalCode('(function(o,k,d){return Object.defineProperty(o,k,d)})'),
    'defineProperty factory',
  )
  const accessorFactory = take(
    ctx.evalCode('(function(o,k,g,s,e,c){return Object.defineProperty(o,k,{get:g,set:s,enumerable:e,configurable:c})})'),
    'accessor factory',
  )

  function take(result, label) {
    if (result.error) {
      const message = dumpError(result.error)
      result.error.dispose()
      throw new Error(`bridge init failed for ${label}: ${message}`)
    }
    return result.value
  }

  function dumpError(handle) {
    try {
      return HANDLE_SAFE_DUMP(handle)
    } catch {
      return 'unknown error'
    }
  }

  function HANDLE_SAFE_DUMP(handle) {
    const dumped = ctx.dump(handle)
    if (dumped && typeof dumped === 'object') {
      return dumped.message ?? JSON.stringify(dumped)
    }
    return String(dumped)
  }

  /** Borrowed handle for a boolean; must never be disposed. */
  function boolHandle(value) {
    return value ? ctx.true : ctx.false
  }

  function currentBag() {
    return bags.length > 0 ? bags[bags.length - 1] : null
  }

  /** Track a temporary handle in the active call bag (or return it). */
  function track(handle) {
    const bag = currentBag()
    if (bag) bag.add(handle)
    return handle
  }

  /** Take ownership of a long-lived handle (disposed at teardown). */
  function own(handle) {
    if (handle && typeof handle.dispose === 'function') owned.add(handle)
    return handle
  }

  /**
   * Set a guest function's `length` without touching anything else.
   * @param {object} handle
   * @param {number} arity
   */
  function setFunctionLength(handle, arity) {
    const descriptor = ctx.newObject()
    try {
      const arityHandle = ctx.newNumber(arity)
      ctx.setProp(descriptor, 'value', arityHandle)
      arityHandle.dispose()
      ctx.setProp(descriptor, 'writable', ctx.false)
      ctx.setProp(descriptor, 'enumerable', ctx.false)
      ctx.setProp(descriptor, 'configurable', ctx.true)
      const key = ctx.newString('length')
      const result = ctx.callFunction(definePropertyFactory, ctx.undefined, [handle, key, descriptor])
      key.dispose()
      if (result.error) result.error.dispose()
      else result.value.dispose()
    } finally {
      descriptor.dispose()
    }
  }

  const bridge = {
    ctx,
    runtime,
    sandbox,
    profile,
    clock,
    trace,
    logger,
    stealth,
    global: ctx.global,
    stats,
    /** Handle that JavaScript should see as `undefined`. */
    get undefined() {
      return ctx.undefined
    },
    get null() {
      return ctx.null
    },

    /**
     * Create a guest function backed by host code.
     *
     * The implementation receives a single object
     * `{ args, thisHandle, bag, bridge }`. Returned handles are transferred to
     * the guest; primitives and plain objects are converted automatically.
     *
     * @param {string} name guest-visible function name
     * @param {number} length guest-visible arity
     * @param {(call: {args: object[], thisHandle: object, bag: HandleBag, bridge: object}) => unknown} impl
     * @param {{isConstructor?: boolean}} [opts]
     */
    fn(name, length, impl, opts = {}) {
      const arity = Number.isFinite(length) ? Math.max(0, Math.min(8, Math.trunc(length))) : 0
      const implementation = function guestFunction(...args) {
        const bag = new HandleBag()
          bags.push(bag)
          stats.calls += 1
          try {
            const result = impl({ args, thisHandle: this, bag, bridge })
            return normalizeReturn(result, bag)
          } catch (error) {
            stats.errors += 1
            throw toGuestError(error)
        } finally {
          bags.pop()
          bag.dispose()
        }
      }
      const handle = ctx.newFunctionWithOptions({
        name,
        length: arity,
        isConstructor: Boolean(opts.isConstructor),
        fn: shapeFunction(arity, implementation),
      })
      // quickjs-emscripten's C constructor reports `length: 0` for host
      // functions regardless of the option, so set the guest-visible arity
      // explicitly (property `length` is configurable per spec).
      setFunctionLength(handle, arity)
      return own(handle)
    },

    /**
     * Create a guest constructor that returns instances of itself.
     *
     * quickjs-emscripten's host constructors cannot reliably report `this` for
     * `new`, so the constructor is a guest function whose body is supplied by
     * the caller, with host functions injected as lexical bindings. The
     * resulting function (and its `prototype` methods the caller installs) are
     * adopted as native, so `TextEncoder.toString()` reports `[native code]`.
     *
     * @param {object} spec
     * @param {string} spec.name
     * @param {number} spec.arity
     * @param {Record<string, unknown>} [spec.bindings] host handles/values injected by name
     * @param {string} spec.body guest statements that assign to `self` and return it
     */
    nativeConstructor({ name, arity = 0, bindings = {}, body }) {
      const bindingNames = Object.keys(bindings)
      const source =
        `(function(${bindingNames.join(', ')}) {\n` +
        `function ${name}(${Array.from({ length: arity }, (_, i) => `a${i}`).join(', ')}) {\n` +
        `var self = Object.create(${name}.prototype);\n${body}\nreturn self;\n}\n` +
        `return ${name};\n})`
      const bindingHandles = bindingNames.map((key) => {
        const value = bindings[key]
        return isHandle(value) ? value : bridge.toGuest(value)
      })
      const factory = ctx.evalCode(source, 'ai4r-internal:shim')
      if (factory.error) {
        const dumped = bridge.fromGuest(factory.error)
        factory.error.dispose()
        throw new Error(`nativeConstructor ${name} failed to compile: ${dumped?.message ?? dumped}`)
      }
      const callResult = ctx.callFunction(factory.value, ctx.undefined, bindingHandles)
      factory.value.dispose()
      if (callResult.error) {
        const dumped = bridge.fromGuest(callResult.error)
        callResult.error.dispose()
        throw new Error(`nativeConstructor ${name} failed: ${dumped?.message ?? dumped}`)
      }
      const ctor = own(callResult.value)
      bridge.adopt(ctor, name)
      // The prototype object itself must also be adopted so that methods added
      // later can be adopted individually.
      const prototype = ctx.getProp(ctor, 'prototype')
      adoptPrototype(prototype, name)
      prototype.dispose()
      return ctor
    },

    /** Register a guest function's source as native-looking. */
    adopt(handle, nativeName) {
      if (!stealth || !handle) return handle
      try {
        const source = stealth.readSource(handle)
        if (source) stealth.registerShim(source, nativeTextForFor(nativeName ?? readName(ctx, handle)))
      } catch {
        /* adoption is best-effort */
      }
      return handle
    },

    /**
     * Install a data property with real descriptor flags.
     * @param {object} target
     * @param {string} key
     * @param {unknown} value handle or JS value
     * @param {{enumerable?: boolean, configurable?: boolean, writable?: boolean}} [flags]
     */
    install(target, key, value, flags = {}) {
      const { enumerable = true, configurable = true, writable = true } = flags
      const valueHandle = isHandle(value) ? value : bridge.toGuest(value)
      const descriptor = own(track(ctx.newObject()))
      ctx.setProp(descriptor, 'enumerable', boolHandle(enumerable))
      ctx.setProp(descriptor, 'configurable', boolHandle(configurable))
      ctx.setProp(descriptor, 'writable', boolHandle(writable))
      ctx.setProp(descriptor, 'value', valueHandle)
      const keyHandle = own(track(ctx.newString(key)))
      const result = ctx.callFunction(definePropertyFactory, ctx.undefined, [target, keyHandle, descriptor])
      if (result.error) {
        const message = dumpError(result.error)
        result.error.dispose()
        throw new Error(`install(${key}) failed: ${message}`)
      }
      result.value.dispose()
      return valueHandle
    },

    /**
     * Install an accessor property (getter/setter as host functions).
     * @param {object} target
     * @param {string} key
     * @param {{get?: Function, set?: Function, enumerable?: boolean, configurable?: boolean}} descriptor
     */
    accessor(target, key, descriptor) {
      const { get, set, enumerable = true, configurable = true } = descriptor
      const getHandle = get ? bridge.fn(get.name || `get ${key}`, get.length ?? 0, get) : ctx.undefined
      const setHandle = set ? bridge.fn(set.name || `set ${key}`, set.length ?? 0, set) : ctx.undefined
      if (get) track(getHandle)
      if (set) track(setHandle)
      const result = ctx.callFunction(accessorFactory, ctx.undefined, [
        target,
        own(track(ctx.newString(key))),
        getHandle,
        setHandle,
        boolHandle(enumerable),
        boolHandle(configurable),
      ])
      if (result.error) {
        const message = dumpError(result.error)
        result.error.dispose()
        throw new Error(`accessor(${key}) failed: ${message}`)
      }
      result.value.dispose()
    },

    /**
     * Deep-convert a JavaScript value to a guest value. Functions must be
     * created with `fn()`; they are rejected here so no host closure can leak.
     * @param {unknown} value
     */
    toGuest(value) {
      stats.conversions += 1
      if (isHandle(value)) return value
      if (value === undefined) return ctx.undefined
      if (value === null) return ctx.null
      const type = typeof value
      if (type === 'string') return own(track(ctx.newString(value)))
      if (type === 'number') return own(track(ctx.newNumber(value)))
      if (type === 'boolean') return boolHandle(value)
      if (type === 'bigint') return own(track(ctx.newBigInt(value)))
      if (type === 'function') {
        throw new Error('bridge.toGuest refuses to convert a host function; use bridge.fn()')
      }
      if (value instanceof Uint8Array) {
        return own(track(ctx.newArrayBuffer(value.slice().buffer)))
      }
      if (Array.isArray(value)) {
        const array = own(track(ctx.newArray()))
        for (let i = 0; i < value.length; i += 1) {
          ctx.setProp(array, i, bridge.toGuest(value[i]))
        }
        return array
      }
      if (type === 'object') {
        const object = own(track(ctx.newObject()))
        for (const [key, item] of Object.entries(value)) {
          if (item === undefined) continue
          ctx.setProp(object, key, bridge.toGuest(item))
        }
        return object
      }
      return ctx.undefined
    },

    /**
     * Convert a guest value to a plain JavaScript value. Functions and hosts
     * objects are described, never dereferenced.
     * @param {object} handle
     * @param {number} [depth]
     */
    fromGuest(handle, depth = 0) {
      if (!isHandle(handle)) return handle
      if (depth > 4) return '[depth]'
      const type = ctx.typeof(handle)
      if (type === 'undefined') return undefined
      if (type === 'number' || type === 'boolean' || type === 'string') {
        return ctx.dump(handle)
      }
      if (type === 'object') {
        // Dumping a Promise through quickjs-emscripten consumes it, which would
        // break `fetch(...).then(...)`. Inspect promise state instead, which is
        // non-destructive, and report it by description.
        try {
          const state = ctx.getPromiseState(handle)
          if (!state.notAPromise) {
            if (state.type === 'fulfilled') state.value?.dispose?.()
            if (state.type === 'rejected') state.error?.dispose?.()
            return { __type: 'promise', state: state.type }
          }
        } catch {
          /* not a promise */
        }
      }
      if (type === 'function') {
        return { __type: 'function' }
      }
      try {
        return ctx.dump(handle)
      } catch {
        return CONVERSION_FAILED
      }
    },

    /** Read a string argument. */
    str(args, index, fallback = '') {
      const handle = args[index]
      if (!isHandle(handle)) return fallback
      try {
        return ctx.typeof(handle) === 'string' ? ctx.getString(handle) : fallback
      } catch {
        return fallback
      }
    },

    /** Read a numeric argument. */
    num(args, index, fallback = NaN) {
      const handle = args[index]
      if (!isHandle(handle)) return fallback
      try {
        return ctx.typeof(handle) === 'number' ? ctx.dump(handle) : fallback
      } catch {
        return fallback
      }
    },

    /** Read an integer argument. */
    int(args, index, fallback = 0) {
      const value = bridge.num(args, index, fallback)
      return Number.isFinite(value) ? Math.trunc(value) : fallback
    },

    /** Read a boolean-ish argument. */
    bool(args, index, fallback = false) {
      const handle = args[index]
      if (!isHandle(handle)) return fallback
      try {
        return Boolean(ctx.dump(handle))
      } catch {
        return fallback
      }
    },

    /** Read an argument as a plain JavaScript value. */
    value(args, index) {
      const handle = args[index]
      if (!isHandle(handle)) return undefined
      const converted = bridge.fromGuest(handle)
      return converted === CONVERSION_FAILED ? undefined : converted
    },

    /** Convert a guest array handle to a JavaScript array of plain values. */
    list(handle, limit = 1000) {
      if (!isHandle(handle)) return []
      const out = []
      try {
        const lengthValue = ctx.getProp(handle, 'length')
        const length = Math.min(ctx.dump(lengthValue), limit)
        lengthValue.dispose()
        for (let i = 0; i < length; i += 1) {
          const item = ctx.getProp(handle, i)
          out.push(bridge.fromGuest(item))
          item.dispose()
        }
      } catch {
        return out
      }
      return out
    },

    /** Read a property as a plain value. */
    get(target, key) {
      const prop = ctx.getProp(target, key)
      const value = bridge.fromGuest(prop)
      prop.dispose()
      return value
    },

    /** Set a property from a plain JS value (temporary handled automatically). */
    set(target, key, value) {
      const handle = bridge.toGuest(value)
      ctx.setProp(target, key, handle)
      return handle
    },

    /** Create a plain guest object with the given properties. */
    obj(properties = {}, prototype = null) {
      const object = own(track(isHandle(prototype) ? ctx.newObject(prototype) : ctx.newObject()))
      for (const [key, value] of Object.entries(properties)) {
        if (value === undefined) continue
        ctx.setProp(object, key, bridge.toGuest(value))
      }
      return object
    },

    /** Create a guest array from plain values. */
    arr(values = []) {
      const array = own(track(ctx.newArray()))
      values.forEach((value, index) => ctx.setProp(array, index, bridge.toGuest(value)))
      return array
    },

    /** Call a guest function with plain JavaScript arguments. */
    call(fnHandle, thisHandle, jsArgs = []) {
      const argHandles = []
      try {
        for (const arg of jsArgs) argHandles.push(bridge.toGuest(arg))
        const result = ctx.callFunction(fnHandle, thisHandle ?? ctx.undefined, argHandles)
        if (result.error) {
          const error = bridge.fromGuest(result.error)
          result.error.dispose()
          return { ok: false, error }
        }
        return { ok: true, value: result.value, handle: result.value }
      } finally {
        for (const handle of argHandles) {
          if (isHandle(handle)) handle.dispose()
        }
      }
    },

    /** Evaluate a short snippet inside the guest and return a plain value. */
    evalInGuest(source, filename = '') {
      const result = ctx.evalCode(String(source), filename)
      if (result.error) {
        const error = bridge.fromGuest(result.error)
        result.error.dispose()
        return { ok: false, error }
      }
      const value = bridge.fromGuest(result.value)
      result.value.dispose()
      return { ok: true, value }
    },

    /**
     * Create a guest promise plus resolve/reject helpers that accept plain JS
     * values. The deferred promise is disposed with the sandbox.
     */
    deferred() {
      const deferred = ctx.newPromise()
      disposers.push(() => {
        try {
          deferred.dispose()
        } catch {
          /* already gone */
        }
      })
      own(deferred.handle)
      return {
        handle: deferred.handle,
        resolve(value) {
          deferred.resolve(bridge.toGuest(value))
        },
        reject(value) {
          const handle = bridge.toGuest(value)
          deferred.reject(handle)
        },
        dispose() {
          deferred.dispose()
        },
      }
    },

    /** Emit a trace event; never throws. */
    emit(kind, phase, payload) {
      if (!trace) return
      try {
        trace.emit(kind, phase, payload)
      } catch {
        /* tracing must not disturb the guest */
      }
    },

    /** Record an IOC discovered at runtime. */
    reportIOC(kind, value) {
      bridge.emit('ioc', 'emit', { iocKind: kind, value: String(value).slice(0, 2048) })
    },

    /** Register a teardown callback (dups, timers, deferred promises). */
    onDispose(fn) {
      disposers.push(fn)
      return fn
    },

    /** Dispose every registered resource. Called once by the sandbox. */
    disposeAll() {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try {
          fn()
        } catch (error) {
          logger?.warn?.({ err: error?.message }, 'bridge disposer failed')
        }
      }
      for (const handle of [definePropertyFactory, accessorFactory, ...owned]) {
        try {
          handle.dispose()
        } catch {
          /* already disposed or never owned */
        }
      }
      owned.clear()
    },
  }

  function normalizeReturn(result, bag) {
    if (result === undefined) return undefined
    if (isHandle(result)) {
      bag.keep(result)
      return result
    }
    const type = typeof result
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
      // `toGuest` registers the handle in the per-call bag; the trampoline reads
      // the value after this function returns, so ownership must transfer out of
      // the bag or the value is freed before the interpreter sees it.
      const converted = bridge.toGuest(result)
      bag.keep(converted)
      return converted
    }
    if (result === null) return ctx.null
    if (type === 'object') {
      const converted = bridge.toGuest(result)
      bag.keep(converted)
      return converted
    }
    return undefined
  }

  return bridge
}

function adoptPrototype(prototype, name) {
  // Methods are adopted individually by their owners; the prototype only needs
  // to exist with a correct constructor link, which the generated body creates.
  void prototype
  void name
}

/**
 * Give a host callback a specific `.length` (quickjs-emscripten reads it from
 * Function#length when creating the guest function).
 * @param {number} arity
 * @param {Function} impl
 */
function shapeFunction(arity, impl) {
  switch (arity) {
    case 0:
      return function () {
        return impl.apply(this, arguments)
      }
    case 1:
      return function (a) {
        void a
        return impl.apply(this, arguments)
      }
    case 2:
      return function (a, b) {
        void a
        void b
        return impl.apply(this, arguments)
      }
    case 3:
      return function (a, b, c) {
        void a
        void b
        void c
        return impl.apply(this, arguments)
      }
    case 4:
      return function (a, b, c, d) {
        void a
        void b
        void c
        void d
        return impl.apply(this, arguments)
      }
    case 5:
      return function (a, b, c, d, e) {
        void a
        void b
        void c
        void d
        void e
        return impl.apply(this, arguments)
      }
    case 6:
      return function (a, b, c, d, e, f) {
        void a
        void b
        void c
        void d
        void e
        void f
        return impl.apply(this, arguments)
      }
    default:
      return function (a, b, c, d, e, f, g) {
        void a
        void b
        void c
        void d
        void e
        void f
        void g
        return impl.apply(this, arguments)
      }
  }
}

function readName(ctx, handle) {
  try {
    const nameHandle = ctx.getProp(handle, 'name')
    const name = ctx.typeof(nameHandle) === 'string' ? ctx.getString(nameHandle) : 'anonymous'
    nameHandle.dispose()
    return name
  } catch {
    return 'anonymous'
  }
}

function nativeTextForFor(name) {
  return name ? `function ${name}() { [native code] }` : 'function () { [native code] }'
}

/** True when a value is a live (or at least handle-shaped) quickjs handle. */
export function isHandle(value) {
  return Boolean(value && typeof value === 'object' && typeof value.dispose === 'function' && 'value' in value)
}

/**
 * Convert an arbitrary thrown value into something safe to throw across the
 * WASM boundary. Host stack traces never reach the guest; only a message does.
 */
export function toGuestError(error) {
  if (error instanceof Error) {
    const safe = new Error(sanitizeHostMessage(error.message))
    safe.name = error.name === 'Error' ? 'Error' : error.name
    return safe
  }
  return new Error(sanitizeHostMessage(String(error)))
}

/** Remove host paths and internal module names from a message. */
export function sanitizeHostMessage(message) {
  return String(message)
    .replace(/\(?\/[^\s()]*node_modules\/[^\s()]*\)?/g, '')
    .replace(/\(?\/[^\s()]*(?:tools|src|tests)\/[^\s():]*\)?/g, '')
    .replace(/file:\/\/[^\s)]+/g, '')
    .replace(/at\s+[^\s]+\s+\([^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
