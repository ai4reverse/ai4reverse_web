import { isHandle } from '../bridge.js'
import { createSeededRandom } from '../../util/random.js'

/**
 * Modern web platform objects.
 *
 * QuickJS ships no `URL`, `URLSearchParams`, `Blob`, `File`, `FormData`,
 * `AbortController`, `Worker` or messaging surface, yet malicious loaders build
 * C2 requests, beacon payloads and stage-2 blobs with exactly these APIs. The
 * host objects (Node's `URL`, `URLSearchParams`, `Blob`, `FormData`,
 * `AbortController`) do the real parsing and byte handling; the guest sees
 * browser-shaped classes whose prototypes carry native-looking methods, whose
 * `instanceof` relationships hold, and whose async results settle on the
 * virtual clock.
 *
 * Instance state is never stored as an own property of a guest instance: an
 * extra enumerable or symbol key on `new URL(...)` is itself a shim tell. Each
 * instance is instead associated with a numeric id in a private guest
 * `WeakMap`, and the state lives on the host keyed by that id.
 */

export const meta = { id: 'misc', order: 100, requires: ['globals'] }

/**
 * Install the modern platform surface. Each section owns one browser class or
 * namespace; they share a single instance-state registry and helper kit.
 * @param {object} bridge host bridge
 */
export function install(bridge) {
  const kit = createKit(bridge)
  const URLSearchParamsCtor = installUrlSearchParams(bridge, kit)
  const URLctor = installUrl(bridge, kit, URLSearchParamsCtor)
  const BlobCtor = installBlob(bridge, kit)
  installFile(bridge, kit, BlobCtor)
  installFormData(bridge, kit)
  installAbort(bridge, kit)
  installNavigator(bridge, kit)
  installNotifications(bridge, kit)
  installWorkers(bridge, kit)
  installServiceWorker(bridge, kit)
  installMessaging(bridge, kit)
  installStorageStubs(bridge, kit)
  installStructuredClone(bridge, kit)
  installRtc(bridge, kit)
  installSpeech(bridge, kit)
  installLegacySurface(bridge, URLctor)
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * Associate host state with guest instances.
 *
 * The `WeakMap` lives in the guest but is only reachable from this module, so
 * property reflection on an instance reveals nothing. Ids are plain numbers;
 * the host map keeps the state. Entries are released with the sandbox.
 *
 * @param {object} bridge
 */
function createInstanceState(bridge) {
  const { ctx } = bridge
  const states = new Map()
  const weakMap = ctx.unwrapResult(ctx.evalCode('new WeakMap()'))
  bridge.onDispose(() => {
    try {
      weakMap.dispose()
    } catch {
      /* already disposed */
    }
  })
  let nextId = 0

  return {
    /**
     * @param {object} guest guest object handle
     * @param {object} state host state
     */
    set(guest, state) {
      nextId += 1
      states.set(nextId, state)
      const id = ctx.newNumber(nextId)
      const result = ctx.callMethod(weakMap, 'set', [guest, id])
      id.dispose()
      if (result.error) {
        result.error.dispose()
        throw new TypeError('Illegal invocation')
      }
      result.value.dispose()
      return state
    },
    /**
     * @param {object} guest guest object handle
     * @returns {object|undefined}
     */
    get(guest) {
      if (!guest) return undefined
      const result = ctx.callMethod(weakMap, 'get', [guest])
      if (result.error) {
        result.error.dispose()
        return undefined
      }
      const id = ctx.typeof(result.value) === 'number' ? ctx.getNumber(result.value) : undefined
      result.value.dispose()
      return id === undefined ? undefined : states.get(id)
    },
    /**
     * State lookup with the browser's brand check: calling a prototype method
     * on an unrelated receiver throws `TypeError: Illegal invocation`.
     * @param {object} guest guest object handle
     */
    require(guest) {
      const state = this.get(guest)
      if (!state) throw new TypeError('Illegal invocation')
      return state
    },
  }
}

/**
 * Helpers shared by every object in this module.
 * @param {object} bridge
 */
function createKit(bridge) {
  const { ctx, clock, profile } = bridge
  const rng = createSeededRandom(`${profile.seed}::misc`)
  const states = createInstanceState(bridge)
  /** Handles that must live until teardown (private constructors, state holders). */
  const retained = new Set()
  bridge.onDispose(() => {
    for (const handle of retained) {
      try {
        handle.dispose()
      } catch {
        /* already disposed */
      }
    }
    retained.clear()
  })

  /** Keep a handle alive for the whole run. */
  const retain = (handle) => {
    if (handle) retained.add(handle)
    return handle
  }

  /** Name a host function so it is guest-visible as `name`. */
  const named = (name, fn) => {
    Object.defineProperty(fn, 'name', { value: name, configurable: true })
    return fn
  }

  /** Getter implementation with the browser's `get x` brand and arity 0. */
  const getter = (key, impl) => named(`get ${key}`, (...call) => impl(call[0]))

  /** Setter implementation with the browser's `set x` brand and arity 1. */
  const setter = (key, impl) => named(`set ${key}`, (call) => impl(call))

  const defineGetter = (target, key, impl) => bridge.accessor(target, key, { get: getter(key, impl) })

  const defineAccessor = (target, key, read, write) =>
    bridge.accessor(target, key, {
      get: getter(key, read),
      set: write ? setter(key, write) : undefined,
    })

  const noop = (name, arity = 0) => bridge.fn(name, arity, () => ctx.undefined)

  /** Guest `String(value)` without exposing a host coercion path. */
  const stringify = ctx.unwrapResult(ctx.evalCode('String'))
  /** Guest strict equality, used to compare listeners by identity. */
  const identical = ctx.unwrapResult(ctx.evalCode('(function(a, b) { return a === b; })'))
  /** Define a well-known symbol property on a prototype. */
  const symbolSetter = ctx.unwrapResult(
    ctx.evalCode(
      '(function(proto, key, value) { Object.defineProperty(proto, key, { value: value, writable: true, enumerable: false, configurable: true }); return value; })',
    ),
  )
  /** Link one prototype under another (File extends Blob). */
  const chainSetter = ctx.unwrapResult(
    ctx.evalCode('(function(child, parent) { Object.setPrototypeOf(child.prototype, parent.prototype); return child; })'),
  )
  const symbolTag = ctx.unwrapResult(ctx.evalCode('Symbol.toStringTag'))
  const symbolIterator = ctx.unwrapResult(ctx.evalCode('Symbol.iterator'))
  for (const handle of [stringify, identical, symbolSetter, chainSetter, symbolTag, symbolIterator]) retain(handle)

  const toText = (handle) => {
    if (!isHandle(handle)) return ''
    if (ctx.typeof(handle) === 'string') return ctx.getString(handle)
    const result = ctx.callFunction(stringify, ctx.undefined, [handle])
    if (result.error) {
      result.error.dispose()
      return ''
    }
    const text = ctx.getString(result.value)
    result.value.dispose()
    return text
  }

  const argumentText = (args, index, fallback = '') => (isHandle(args[index]) ? toText(args[index]) : fallback)

  const sameListener = (left, right) => {
    if (!left || !right) return false
    const result = ctx.callFunction(identical, ctx.undefined, [left, right])
    if (result.error) {
      result.error.dispose()
      return false
    }
    const equal = ctx.dump(result.value)
    result.value.dispose()
    return equal === true
  }

  /** Trace-friendly preview of a guest value; never returns a handle. */
  const preview = (handle) => {
    try {
      const value = bridge.fromGuest(handle)
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return String(text ?? '').slice(0, 512)
    } catch {
      return ''
    }
  }

  /**
   * Guest value for a plain host value. The caller owns the returned handle.
   * Used for message payloads that must outlive the current call.
   */
  const valueFromPlain = (value) => {
    if (value === undefined) return ctx.undefined
    if (value === null) return ctx.null
    if (typeof value === 'string') return ctx.newString(value)
    if (typeof value === 'number') return ctx.newNumber(value)
    if (typeof value === 'boolean') return value ? ctx.true : ctx.false
    if (Array.isArray(value)) {
      const array = ctx.newArray()
      value.forEach((item, index) => {
        const handle = valueFromPlain(item)
        ctx.setProp(array, index, handle)
        handle.dispose()
      })
      return array
    }
    const object = ctx.newObject()
    for (const [key, item] of Object.entries(value ?? {})) {
      if (item === undefined) continue
      const handle = valueFromPlain(item)
      ctx.setProp(object, key, handle)
      handle.dispose()
    }
    return object
  }

  /** Guest object from plain properties, kept until teardown. */
  const pinObject = (properties) => {
    const object = ctx.newObject()
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined) continue
      ctx.setProp(object, key, isHandle(value) ? value : bridge.toGuest(value))
    }
    return retain(object)
  }

  /** Guest array, kept until teardown; items may be plain values or handles. */
  const pinArray = (values) => {
    const array = ctx.newArray()
    values.forEach((value, index) => {
      if (value === undefined) return
      ctx.setProp(array, index, isHandle(value) ? value : bridge.toGuest(value))
    })
    return retain(array)
  }

  /** Guest string handle, kept until teardown. */
  const pinString = (text) => retain(ctx.newString(String(text)))

  /** Guest number handle, kept until teardown. */
  const pinNumber = (value) => retain(ctx.newNumber(value))

  const makeError = ctx.unwrapResult(
    ctx.evalCode('(function(name, message) { var error = new Error(message); error.name = name; return error; })'),
  )
  retain(makeError)

  /** Guest error object with a browser error name, kept until teardown. */
  const pinError = (name, message) => {
    const nameHandle = ctx.newString(name)
    const messageHandle = ctx.newString(message)
    const result = ctx.callFunction(makeError, ctx.undefined, [nameHandle, messageHandle])
    nameHandle.dispose()
    messageHandle.dispose()
    if (result.error) {
      result.error.dispose()
      return pinError('Error', message)
    }
    return retain(result.value)
  }

  /**
   * Resolve a guest promise on the virtual clock, the way a browser settles a
   * queued task. `value` must be a retained handle or a static handle.
   */
  const fulfilled = (value, delay = 0) => {
    const deferred = bridge.deferred()
    clock.schedule({ delay, fn: () => deferred.resolve(value) })
    return deferred.handle
  }

  const rejected = (value, delay = 0) => {
    const deferred = bridge.deferred()
    clock.schedule({ delay, fn: () => deferred.reject(value) })
    return deferred.handle
  }

  /** Native guest array iterator over plain values. */
  const valueIterator = (values) => {
    const array = ctx.newArray()
    values.forEach((value, index) => {
      const handle = isHandle(value) ? value : bridge.toGuest(value)
      ctx.setProp(array, index, handle)
    })
    const result = ctx.callMethod(array, 'values')
    array.dispose()
    if (result.error) {
      result.error.dispose()
      throw new TypeError('Iterator unavailable')
    }
    return result.value
  }

  /** Native guest array iterator over `[key, value]` pairs. */
  const pairIterator = (pairs) => {
    const outer = ctx.newArray()
    pairs.forEach(([key, value], index) => {
      const inner = ctx.newArray()
      ctx.setProp(inner, 0, isHandle(key) ? key : bridge.toGuest(key))
      ctx.setProp(inner, 1, isHandle(value) ? value : bridge.toGuest(value))
      ctx.setProp(outer, index, inner)
      inner.dispose()
    })
    const result = ctx.callMethod(outer, 'values')
    outer.dispose()
    if (result.error) {
      result.error.dispose()
      throw new TypeError('Iterator unavailable')
    }
    return result.value
  }

  /** Invoke guest listeners with a browser-shaped event, reporting failures. */
  const dispatch = (listeners, eventHandle, thisHandle) => {
    for (const listener of listeners) {
      const result = ctx.callFunction(listener, thisHandle ?? ctx.undefined, [eventHandle])
      if (result.error) {
        const dumped = bridge.fromGuest(result.error)
        result.error.dispose()
        bridge.emit('exception', 'uncaught', { origin: 'event', error: dumped })
      } else {
        result.value.dispose()
      }
    }
  }

  const defineSymbol = (proto, key, value) => {
    const result = ctx.callFunction(symbolSetter, ctx.undefined, [proto, key, value])
    if (result.error) {
      result.error.dispose()
      return
    }
    result.value.dispose()
  }

  /** Install a `Symbol.toStringTag` on a constructor's prototype. */
  const setToStringTag = (ctor, tag) => {
    const proto = ctx.getProp(ctor, 'prototype')
    const value = ctx.newString(tag)
    defineSymbol(proto, symbolTag, value)
    value.dispose()
    proto.dispose()
  }

  /** Register `fnHandle` as the prototype's `Symbol.iterator`. */
  const setIterator = (ctor, fnHandle) => {
    const proto = ctx.getProp(ctor, 'prototype')
    defineSymbol(proto, symbolIterator, fnHandle)
    proto.dispose()
  }

  /** Make `child` inherit from `parent` (prototype chain, not copy). */
  const extend = (child, parent) => {
    const result = ctx.callFunction(chainSetter, ctx.undefined, [child, parent])
    if (result.error) {
      result.error.dispose()
      return
    }
    result.value.dispose()
  }

  /** No-op EventTarget methods for objects that never dispatch. */
  const installEventTarget = (target, list) => {
    for (const name of list) {
      bridge.install(target, name, noop(name, 2), { enumerable: true, configurable: true, writable: true })
    }
  }

  /** DataCloneError-shaped failure for `structuredClone`. */
  const fatalClone = (message) => {
    const error = new Error(message)
    error.name = 'DataCloneError'
    return error
  }

  return {
    rng,
    states,
    retain,
    defineGetter,
    defineAccessor,
    toText,
    argumentText,
    sameListener,
    preview,
    valueFromPlain,
    pinObject,
    pinArray,
    pinString,
    pinError,
    fulfilled,
    rejected,
    valueIterator,
    pairIterator,
    dispatch,
    setToStringTag,
    setIterator,
    extend,
    installEventTarget,
    fatalClone,
  }
}

// ---------------------------------------------------------------------------
// URLSearchParams
// ---------------------------------------------------------------------------

/**
 * `URLSearchParams` backed by Node's implementation, so percent-encoding,
 * `+`-as-space and duplicate keys match a real browser exactly.
 * @param {object} bridge
 * @param {object} kit
 */
function installUrlSearchParams(bridge, kit) {
  const { ctx } = bridge
  const { states, toText, argumentText, valueIterator, pairIterator } = kit

  /**
   * Build the host parameter list from the guest constructor argument.
   * @param {object} source guest handle
   */
  const hostParams = (source) => {
    const type = ctx.typeof(source)
    if (type === 'undefined' || type === 'null') return new URLSearchParams()
    if (type === 'string') return new URLSearchParams(ctx.getString(source))
    if (type === 'object') {
      const lengthValue = ctx.getProp(source, 'length')
      const length = ctx.typeof(lengthValue) === 'number' ? ctx.getNumber(lengthValue) : -1
      lengthValue.dispose()
      if (length >= 0) {
        const params = new URLSearchParams()
        for (let i = 0; i < length; i += 1) {
          const item = ctx.getProp(source, i)
          if (ctx.typeof(item) === 'object') {
            const key = ctx.getProp(item, 0)
            const value = ctx.getProp(item, 1)
            params.append(toText(key), toText(value))
            key.dispose()
            value.dispose()
          } else {
            const text = toText(item)
            const separator = text.indexOf('=')
            params.append(
              separator < 0 ? text : text.slice(0, separator),
              separator < 0 ? '' : text.slice(separator + 1),
            )
          }
          item.dispose()
        }
        return params
      }
      // A record initializer (`new URLSearchParams({ q: '1' })`) is supported by
      // current browsers and used to build beacon query strings.
      if (!kit.states.get(source)) {
        const record = bridge.fromGuest(source)
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          const params = new URLSearchParams()
          for (const [key, value] of Object.entries(record)) params.append(key, String(value))
          return params
        }
      }
    }
    return new URLSearchParams(toText(source))
  }

  const initialize = bridge.fn('initialize', 2, ({ args }) => {
    states.set(args[0], { params: hostParams(args[1]) })
    return ctx.undefined
  })

  const URLSearchParamsCtor = bridge.nativeConstructor({
    name: 'URLSearchParams',
    arity: 0,
    bindings: { initialize },
    body: 'initialize(self, arguments[0]);',
  })
  kit.setToStringTag(URLSearchParamsCtor, 'URLSearchParams')
  const proto = ctx.getProp(URLSearchParamsCtor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })

  kit.defineGetter(proto, 'size', ({ thisHandle }) => ctx.newNumber(states.require(thisHandle).params.size))

  method('append', bridge.fn('append', 2, ({ args, thisHandle }) => {
    const name = argumentText(args, 0)
    const value = argumentText(args, 1)
    states.require(thisHandle).params.append(name, value)
    bridge.emit('api', 'before', { api: 'URLSearchParams.append', name, value: value.slice(0, 512) })
    return ctx.undefined
  }))

  method('set', bridge.fn('set', 2, ({ args, thisHandle }) => {
    const name = argumentText(args, 0)
    const value = argumentText(args, 1)
    states.require(thisHandle).params.set(name, value)
    bridge.emit('api', 'before', { api: 'URLSearchParams.set', name, value: value.slice(0, 512) })
    return ctx.undefined
  }))

  method('delete', bridge.fn('delete', 1, ({ args, thisHandle }) => {
    const name = argumentText(args, 0)
    const value = args.length > 1 ? argumentText(args, 1) : undefined
    states.require(thisHandle).params.delete(name, value)
    return ctx.undefined
  }))

  method('get', bridge.fn('get', 1, ({ args, thisHandle }) => {
    const value = states.require(thisHandle).params.get(argumentText(args, 0))
    return value === null ? ctx.null : ctx.newString(value)
  }))

  method('getAll', bridge.fn('getAll', 1, ({ args, thisHandle }) =>
    bridge.arr(states.require(thisHandle).params.getAll(argumentText(args, 0))),
  ))

  method('has', bridge.fn('has', 1, ({ args, thisHandle }) => {
    const value = args.length > 1 ? argumentText(args, 1) : undefined
    return states.require(thisHandle).params.has(argumentText(args, 0), value) ? ctx.true : ctx.false
  }))

  method('sort', bridge.fn('sort', 0, ({ thisHandle }) => {
    states.require(thisHandle).params.sort()
    return ctx.undefined
  }))

  method('toString', bridge.fn('toString', 0, ({ thisHandle }) =>
    ctx.newString(states.require(thisHandle).params.toString()),
  ))

  const entriesFn = bridge.fn('entries', 0, ({ thisHandle }) =>
    pairIterator([...states.require(thisHandle).params.entries()]),
  )
  method('entries', entriesFn)
  method('keys', bridge.fn('keys', 0, ({ thisHandle }) => valueIterator([...states.require(thisHandle).params.keys()])))
  method('values', bridge.fn('values', 0, ({ thisHandle }) =>
    valueIterator([...states.require(thisHandle).params.values()]),
  ))
  kit.setIterator(URLSearchParamsCtor, entriesFn)

  method('forEach', bridge.fn('forEach', 1, ({ args, thisHandle }) => {
    const callback = args[0]
    if (!callback || ctx.typeof(callback) !== 'function') {
      throw new TypeError("Failed to execute 'forEach' on 'URLSearchParams': parameter 1 is not of type 'Function'.")
    }
    const thisArg = args.length > 1 ? args[1] : ctx.undefined
    for (const [name, value] of states.require(thisHandle).params.entries()) {
      const valueHandle = ctx.newString(value)
      const nameHandle = ctx.newString(name)
      const result = ctx.callFunction(callback, thisArg, [valueHandle, nameHandle, thisHandle])
      valueHandle.dispose()
      nameHandle.dispose()
      if (result.error) {
        const dumped = bridge.fromGuest(result.error)
        result.error.dispose()
        throw Object.assign(new Error(dumped?.message ?? 'callback failed'), { name: dumped?.name ?? 'Error' })
      }
      result.value.dispose()
    }
    return ctx.undefined
  }))
  proto.dispose()

  bridge.install(bridge.global, 'URLSearchParams', URLSearchParamsCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return URLSearchParamsCtor
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * `URL` backed by Node's parser: `new URL(url[, base])`, live `searchParams`,
 * `canParse`, and the `createObjectURL`/`revokeObjectURL` pair loaders use to
 * hand a payload blob to a download.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} URLSearchParamsCtor
 */
function installUrl(bridge, kit, URLSearchParamsCtor) {
  const { ctx, profile } = bridge
  const { states, retain, rng, toText, argumentText } = kit
  /** @type {Set<string>} */
  const objectUrls = new Set()

  const initialize = bridge.fn('initialize', 3, ({ args }) => {
    const [self, input, base] = args
    if (ctx.typeof(input) === 'undefined') return ctx.false
    const baseText = ctx.typeof(base) === 'undefined' ? undefined : toText(base)
    let parsed
    try {
      parsed = baseText === undefined ? new URL(toText(input)) : new URL(toText(input), baseText)
    } catch {
      bridge.emit('api', 'error', { api: 'URL', input: toText(input).slice(0, 512), base: baseText })
      return ctx.false
    }
    const paramsResult = ctx.callFunction(URLSearchParamsCtor, ctx.undefined, [])
    if (paramsResult.error) {
      paramsResult.error.dispose()
      return ctx.false
    }
    const params = retain(paramsResult.value)
    states.set(params, { params: parsed.searchParams })
    states.set(self, { url: parsed, params })
    bridge.emit('api', 'before', { api: 'URL', href: parsed.href.slice(0, 2048) })
    return ctx.true
  })

  const URLctor = bridge.nativeConstructor({
    name: 'URL',
    arity: 1,
    bindings: { initialize },
    body: "if (initialize(self, arguments[0], arguments[1]) !== true) throw new TypeError('Invalid URL');",
  })
  kit.setToStringTag(URLctor, 'URL')

  const proto = ctx.getProp(URLctor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })
  for (const key of [
    'href',
    'protocol',
    'username',
    'password',
    'host',
    'hostname',
    'port',
    'pathname',
    'search',
    'hash',
  ]) {
    kit.defineAccessor(
      proto,
      key,
      ({ thisHandle }) => ctx.newString(states.require(thisHandle).url[key]),
      ({ args, thisHandle }) => {
        try {
          states.require(thisHandle).url[key] = argumentText(args, 0)
        } catch {
          const error = new Error('Invalid URL')
          error.name = 'TypeError'
          throw error
        }
        return ctx.undefined
      },
    )
  }
  kit.defineGetter(proto, 'origin', ({ thisHandle }) => ctx.newString(states.require(thisHandle).url.origin))
  kit.defineGetter(proto, 'searchParams', ({ thisHandle }) => states.require(thisHandle).params.dup())

  method('toString', bridge.fn('toString', 0, ({ thisHandle }) => ctx.newString(states.require(thisHandle).url.href)))
  method('toJSON', bridge.fn('toJSON', 0, ({ thisHandle }) => ctx.newString(states.require(thisHandle).url.href)))
  proto.dispose()

  const staticMethod = (name, fn) =>
    bridge.install(URLctor, name, fn, { enumerable: true, configurable: true, writable: true })

  staticMethod('canParse', bridge.fn('canParse', 1, ({ args }) => {
    if (!isHandle(args[0]) || ctx.typeof(args[0]) === 'undefined') return ctx.false
    const input = toText(args[0])
    const base = isHandle(args[1]) && ctx.typeof(args[1]) !== 'undefined' ? toText(args[1]) : undefined
    try {
      if (base === undefined) new URL(input)
      else new URL(input, base)
      return ctx.true
    } catch {
      return ctx.false
    }
  }))

  staticMethod('createObjectURL', bridge.fn('createObjectURL', 1, ({ args }) => {
    const url = `blob:${profile.origin}/${rng.uuid()}`
    objectUrls.add(url)
    bridge.emit('api', 'before', { api: 'URL.createObjectURL', url, kind: states.get(args[0]) ? 'blob' : 'other' })
    return ctx.newString(url)
  }))

  staticMethod('revokeObjectURL', bridge.fn('revokeObjectURL', 1, ({ args }) => {
    const url = argumentText(args, 0)
    objectUrls.delete(url)
    bridge.emit('api', 'before', { api: 'URL.revokeObjectURL', url: url.slice(0, 512) })
    return ctx.undefined
  }))

  bridge.install(bridge.global, 'URL', URLctor, { enumerable: true, configurable: true, writable: true })
  return URLctor
}

// ---------------------------------------------------------------------------
// Blob / File
// ---------------------------------------------------------------------------

/**
 * Copy an ArrayBuffer-backed guest value to host bytes, or `null`.
 * @param {object} ctx
 * @param {object} handle
 */
function tryArrayBuffer(ctx, handle) {
  try {
    const buffer = ctx.getArrayBuffer(handle)
    if (!buffer?.value) {
      buffer?.dispose?.()
      return null
    }
    const copy = buffer.value.slice()
    buffer.dispose()
    return copy
  } catch {
    return null
  }
}

/**
 * Read Blob constructor parts into one byte array. Strings count as UTF-8,
 * buffers and views contribute their bytes, and Blob/File parts contribute
 * their stored bytes.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} source guest handle
 */
function readBlobBytes(bridge, kit, source) {
  const { ctx } = bridge

  const bytesOf = (handle) => {
    const type = ctx.typeof(handle)
    if (type === 'string') return new Uint8Array(Buffer.from(ctx.getString(handle), 'utf8'))
    if (type !== 'object') return new Uint8Array(0)
    const state = kit.states.get(handle)
    if (state?.bytes) return state.bytes
    const direct = tryArrayBuffer(ctx, handle)
    if (direct) return direct
    const inner = ctx.getProp(handle, 'buffer')
    let bytes = null
    if (ctx.typeof(inner) === 'object') bytes = tryArrayBuffer(ctx, inner)
    inner.dispose()
    return bytes ?? new Uint8Array(0)
  }

  const type = ctx.typeof(source)
  if (type === 'undefined' || type === 'null') return new Uint8Array(0)
  const lengthValue = ctx.getProp(source, 'length')
  const length = ctx.typeof(lengthValue) === 'number' ? ctx.getNumber(lengthValue) : -1
  lengthValue.dispose()
  if (length < 0) return bytesOf(source)
  const chunks = []
  for (let i = 0; i < length; i += 1) {
    const part = ctx.getProp(source, i)
    chunks.push(bytesOf(part))
    part.dispose()
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * `Blob`: real bytes and MIME handling, synchronous byte access for the host,
 * promises that settle on the virtual clock.
 * @param {object} bridge
 * @param {object} kit
 */
function installBlob(bridge, kit) {
  const { ctx } = bridge
  const { states, retain, fulfilled } = kit

  const initialize = bridge.fn('initialize', 3, ({ args }) => {
    const bytes = readBlobBytes(bridge, kit, args[1])
    const options = bridge.fromGuest(args[2])
    const type = options && typeof options === 'object' && typeof options.type === 'string' ? options.type : ''
    const blob = new Blob([bytes], { type })
    states.set(args[0], { blob, bytes, type: blob.type })
    return ctx.undefined
  })

  const BlobCtor = bridge.nativeConstructor({
    name: 'Blob',
    arity: 0,
    bindings: { initialize },
    body: 'initialize(self, arguments[0], arguments[1]);',
  })
  kit.setToStringTag(BlobCtor, 'Blob')

  const proto = ctx.getProp(BlobCtor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })
  kit.defineGetter(proto, 'size', ({ thisHandle }) => ctx.newNumber(states.require(thisHandle).blob.size))
  kit.defineGetter(proto, 'type', ({ thisHandle }) => ctx.newString(states.require(thisHandle).type))

  method('text', bridge.fn('text', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    bridge.emit('api', 'before', { api: 'Blob.text', size: state.bytes.byteLength })
    return fulfilled(retain(ctx.newString(Buffer.from(state.bytes).toString('utf8'))))
  }))

  method('arrayBuffer', bridge.fn('arrayBuffer', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    bridge.emit('api', 'before', { api: 'Blob.arrayBuffer', size: state.bytes.byteLength })
    const copy = state.bytes.slice()
    return fulfilled(retain(ctx.newArrayBuffer(copy.buffer)))
  }))

  method('slice', bridge.fn('slice', 3, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    const length = state.bytes.byteLength
    const start = relativeIndex(bridge, args, 0, length, 0)
    const end = relativeIndex(bridge, args, 1, length, length)
    const bytes = state.bytes.slice(start, Math.max(start, end))
    const type = isHandle(args[2]) && ctx.typeof(args[2]) !== 'undefined' ? kit.argumentText(args, 2) : ''
    return createBlob(bridge, kit, BlobCtor, bytes, type)
  }))
  proto.dispose()

  bridge.install(bridge.global, 'Blob', BlobCtor, { enumerable: true, configurable: true, writable: true })
  return BlobCtor
}

/**
 * Create a guest Blob from host bytes.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} BlobCtor
 * @param {Uint8Array} bytes
 * @param {string} type
 */
function createBlob(bridge, kit, BlobCtor, bytes, type) {
  const { ctx } = bridge
  const copy = bytes.slice()
  const part = ctx.newArrayBuffer(copy.buffer)
  const parts = ctx.newArray()
  ctx.setProp(parts, 0, part)
  const options = ctx.newObject()
  const typeHandle = ctx.newString(type)
  ctx.setProp(options, 'type', typeHandle)
  const result = ctx.callFunction(BlobCtor, ctx.undefined, [parts, options])
  part.dispose()
  parts.dispose()
  options.dispose()
  typeHandle.dispose()
  if (result.error) {
    result.error.dispose()
    throw new TypeError('Failed to construct Blob')
  }
  return result.value
}

/**
 * Resolve a Blob slice index against the byte length, including negative
 * offsets from the end.
 * @param {object} bridge
 * @param {object[]} args
 * @param {number} index
 * @param {number} length
 * @param {number} fallback
 */
function relativeIndex(bridge, args, index, length, fallback) {
  const value = bridge.num(args, index, Number.NaN)
  if (!Number.isFinite(value)) return fallback
  const index0 = Math.trunc(value)
  if (index0 < 0) return Math.max(length + index0, 0)
  return Math.min(index0, length)
}

/**
 * `File`: a Blob with a name and modification time, inheriting Blob's methods.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} BlobCtor
 */
function installFile(bridge, kit, BlobCtor) {
  const { ctx, clock } = bridge
  const { states } = kit

  const initialize = bridge.fn('initialize', 4, ({ args }) => {
    const [self, parts, name, optionsHandle] = args
    const bytes = readBlobBytes(bridge, kit, parts)
    const options = bridge.fromGuest(optionsHandle) ?? {}
    const type = typeof options.type === 'string' ? options.type : ''
    const lastModified = Number.isFinite(options.lastModified) ? options.lastModified : clock.now()
    const blob = new Blob([bytes], { type })
    states.set(self, {
      blob,
      bytes,
      type: blob.type,
      name: ctx.typeof(name) === 'undefined' ? 'undefined' : kit.toText(name),
      lastModified,
      webkitRelativePath: '',
    })
    return ctx.undefined
  })

  const FileCtor = bridge.nativeConstructor({
    name: 'File',
    arity: 2,
    bindings: { initialize },
    body: 'initialize(self, arguments[0], arguments[1], arguments[2]);',
  })
  kit.setToStringTag(FileCtor, 'File')
  kit.extend(FileCtor, BlobCtor)

  const proto = ctx.getProp(FileCtor, 'prototype')
  kit.defineGetter(proto, 'name', ({ thisHandle }) => ctx.newString(states.require(thisHandle).name))
  kit.defineGetter(proto, 'lastModified', ({ thisHandle }) => ctx.newNumber(states.require(thisHandle).lastModified))
  kit.defineGetter(proto, 'webkitRelativePath', ({ thisHandle }) =>
    ctx.newString(states.require(thisHandle).webkitRelativePath),
  )
  proto.dispose()

  bridge.install(bridge.global, 'File', FileCtor, { enumerable: true, configurable: true, writable: true })
  return FileCtor
}

// ---------------------------------------------------------------------------
// FormData
// ---------------------------------------------------------------------------

/**
 * `FormData` with its own ordered entry list so blob/file entries are returned
 * as the exact guest objects that were appended.
 * @param {object} bridge
 * @param {object} kit
 */
function installFormData(bridge, kit) {
  const { ctx } = bridge
  const { states, retain, valueIterator, pairIterator } = kit

  const initialize = bridge.fn('initialize', 1, ({ args }) => {
    states.set(args[0], { entries: [] })
    return ctx.undefined
  })

  const FormDataCtor = bridge.nativeConstructor({
    name: 'FormData',
    arity: 0,
    bindings: { initialize },
    body: 'initialize(self);',
  })
  kit.setToStringTag(FormDataCtor, 'FormData')

  /** Entry from a guest value: blob-backed or string. */
  const entryOf = (handle) => {
    if (!isHandle(handle)) return { text: '' }
    if (ctx.typeof(handle) === 'object' && states.get(handle)?.bytes) {
      return { blob: retain(handle.dup()) }
    }
    return { text: kit.toText(handle) }
  }

  const append = (args, thisHandle, replace) => {
    const name = kit.argumentText(args, 0)
    const entry = entryOf(args[1])
    const entries = states.require(thisHandle).entries
    const record = { name, ...entry }
    if (replace) {
      const index = entries.findIndex((item) => item.name === name)
      if (index >= 0) {
        entries[index] = record
        emitEntry(replace, record)
        return
      }
    }
    entries.push(record)
    emitEntry(replace, record)
  }

  const emitEntry = (replace, record) => {
    bridge.emit('api', 'before', {
      api: `FormData.${replace ? 'set' : 'append'}`,
      name: record.name,
      kind: record.blob ? 'blob' : 'string',
      size: record.text ? record.text.length : undefined,
    })
  }

  const proto = ctx.getProp(FormDataCtor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })

  method('append', bridge.fn('append', 2, ({ args, thisHandle }) => {
    append(args, thisHandle, false)
    return ctx.undefined
  }))
  method('set', bridge.fn('set', 2, ({ args, thisHandle }) => {
    append(args, thisHandle, true)
    return ctx.undefined
  }))

  const entryValue = (entry) => (entry.blob ? entry.blob.dup() : ctx.newString(entry.text))
  const iteratorValue = (entry) => entry.blob ?? entry.text

  method('get', bridge.fn('get', 1, ({ args, thisHandle }) => {
    const entry = states.require(thisHandle).entries.find((item) => item.name === kit.argumentText(args, 0))
    return entry ? entryValue(entry) : ctx.null
  }))

  method('getAll', bridge.fn('getAll', 1, ({ args, thisHandle }) => {
    const name = kit.argumentText(args, 0)
    const entries = states.require(thisHandle).entries.filter((item) => item.name === name)
    const array = ctx.newArray()
    entries.forEach((entry, index) => {
      const handle = entryValue(entry)
      ctx.setProp(array, index, handle)
      handle.dispose()
    })
    return array
  }))

  method('has', bridge.fn('has', 1, ({ args, thisHandle }) =>
    states.require(thisHandle).entries.some((item) => item.name === kit.argumentText(args, 0)) ? ctx.true : ctx.false,
  ))

  method('delete', bridge.fn('delete', 1, ({ args, thisHandle }) => {
    const name = kit.argumentText(args, 0)
    const state = states.require(thisHandle)
    state.entries = state.entries.filter((item) => item.name !== name)
    return ctx.undefined
  }))

  const entriesFn = bridge.fn('entries', 0, ({ thisHandle }) =>
    pairIterator(states.require(thisHandle).entries.map((entry) => [entry.name, iteratorValue(entry)])),
  )
  method('entries', entriesFn)
  method('keys', bridge.fn('keys', 0, ({ thisHandle }) =>
    valueIterator(states.require(thisHandle).entries.map((entry) => entry.name)),
  ))
  method('values', bridge.fn('values', 0, ({ thisHandle }) =>
    valueIterator(states.require(thisHandle).entries.map((entry) => iteratorValue(entry))),
  ))
  kit.setIterator(FormDataCtor, entriesFn)

  method('forEach', bridge.fn('forEach', 1, ({ args, thisHandle }) => {
    const callback = args[0]
    if (!callback || ctx.typeof(callback) !== 'function') {
      throw new TypeError("Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.")
    }
    const thisArg = args.length > 1 ? args[1] : ctx.undefined
    for (const entry of states.require(thisHandle).entries) {
      const valueHandle = entryValue(entry)
      const nameHandle = ctx.newString(entry.name)
      const result = ctx.callFunction(callback, thisArg, [valueHandle, nameHandle, thisHandle])
      valueHandle.dispose()
      nameHandle.dispose()
      if (result.error) {
        const dumped = bridge.fromGuest(result.error)
        result.error.dispose()
        throw Object.assign(new Error(dumped?.message ?? 'callback failed'), { name: dumped?.name ?? 'Error' })
      }
      result.value.dispose()
    }
    return ctx.undefined
  }))
  proto.dispose()

  bridge.install(bridge.global, 'FormData', FormDataCtor, { enumerable: true, configurable: true, writable: true })
  return FormDataCtor
}

// ---------------------------------------------------------------------------
// AbortController / AbortSignal
// ---------------------------------------------------------------------------

/**
 * Abort signals with real listener dispatch and virtual-clock timeouts.
 * Loaders use `AbortSignal.timeout` to bound their own beacon retries.
 * @param {object} bridge
 * @param {object} kit
 */
function installAbort(bridge, kit) {
  const { ctx, clock } = bridge
  const { states, retain, pinError } = kit

  const initializeSignal = bridge.fn('initialize', 1, ({ args }) => {
    states.set(args[0], {
      aborted: false,
      reason: null,
      onabort: null,
      listeners: [],
      guest: retain(args[0].dup()),
    })
    return ctx.undefined
  })

  const AbortSignalCtor = bridge.nativeConstructor({
    name: 'AbortSignal',
    arity: 0,
    bindings: { initialize: initializeSignal },
    body: 'initialize(self);',
  })
  kit.setToStringTag(AbortSignalCtor, 'AbortSignal')

  /** Mark a signal aborted and dispatch to its handlers. */
  const abortSignal = (state, reasonHandle) => {
    if (state.aborted) return
    state.aborted = true
    const explicit = reasonHandle && ctx.typeof(reasonHandle) !== 'undefined'
    state.reason = explicit ? retain(reasonHandle.dup()) : pinError('AbortError', 'signal is aborted without reason')
    const event = ctx.newObject()
    const typeHandle = ctx.newString('abort')
    ctx.setProp(event, 'type', typeHandle)
    typeHandle.dispose()
    ctx.setProp(event, 'target', state.guest)
    if (state.onabort) kit.dispatch([state.onabort], event, state.guest)
    kit.dispatch(state.listeners, event, state.guest)
    event.dispose()
    bridge.emit('api', 'before', { api: 'AbortSignal.abort', reason: explicit ? 'explicit' : 'AbortError' })
  }

  const signalProto = ctx.getProp(AbortSignalCtor, 'prototype')
  const method = (target, name, fn) => bridge.install(target, name, fn, { enumerable: true, configurable: true, writable: true })

  kit.defineGetter(signalProto, 'aborted', ({ thisHandle }) =>
    states.require(thisHandle).aborted ? ctx.true : ctx.false,
  )
  kit.defineGetter(signalProto, 'reason', ({ thisHandle }) => {
    const state = states.require(thisHandle)
    return state.reason ? state.reason.dup() : ctx.undefined
  })
  kit.defineAccessor(
    signalProto,
    'onabort',
    ({ thisHandle }) => {
      const state = states.require(thisHandle)
      return state.onabort ? state.onabort.dup() : ctx.null
    },
    ({ args, thisHandle }) => {
      const state = states.require(thisHandle)
      state.onabort = args[0] && ctx.typeof(args[0]) === 'function' ? retain(args[0].dup()) : null
      return ctx.undefined
    },
  )
  method(signalProto, 'addEventListener', bridge.fn('addEventListener', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    if (args[1] && ctx.typeof(args[1]) === 'function') state.listeners.push(retain(args[1].dup()))
    return ctx.undefined
  }))
  method(signalProto, 'removeEventListener', bridge.fn('removeEventListener', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    state.listeners = state.listeners.filter((listener) => !kit.sameListener(listener, args[1]))
    return ctx.undefined
  }))
  method(signalProto, 'throwIfAborted', bridge.fn('throwIfAborted', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    if (!state.aborted) return ctx.undefined
    const dumped = state.reason ? bridge.fromGuest(state.reason) : undefined
    const error = new Error(typeof dumped?.message === 'string' ? dumped.message : 'The operation was aborted.')
    error.name = typeof dumped?.name === 'string' ? dumped.name : 'AbortError'
    throw error
  }))
  signalProto.dispose()

  const newSignal = () => {
    const result = ctx.callFunction(AbortSignalCtor, ctx.undefined, [])
    if (result.error) {
      result.error.dispose()
      throw new TypeError('Failed to construct AbortSignal')
    }
    return retain(result.value)
  }

  method(AbortSignalCtor, 'timeout', bridge.fn('timeout', 1, ({ args }) => {
    const delay = Math.max(0, bridge.num(args, 0, 0) || 0)
    const signal = newSignal()
    clock.schedule({
      delay,
      fn: () => abortSignal(states.require(signal), pinError('TimeoutError', 'signal timed out')),
    })
    bridge.emit('api', 'before', { api: 'AbortSignal.timeout', delay })
    return signal.dup()
  }))
  method(AbortSignalCtor, 'abort', bridge.fn('abort', 1, ({ args }) => {
    const signal = newSignal()
    abortSignal(states.require(signal), args[0])
    return signal.dup()
  }))

  const initializeController = bridge.fn('initialize', 1, ({ args }) => {
    states.set(args[0], { signal: newSignal() })
    return ctx.undefined
  })
  const AbortControllerCtor = bridge.nativeConstructor({
    name: 'AbortController',
    arity: 0,
    bindings: { initialize: initializeController },
    body: 'initialize(self);',
  })
  kit.setToStringTag(AbortControllerCtor, 'AbortController')

  const controllerProto = ctx.getProp(AbortControllerCtor, 'prototype')
  kit.defineGetter(controllerProto, 'signal', ({ thisHandle }) => states.require(thisHandle).signal.dup())
  method(controllerProto, 'abort', bridge.fn('abort', 1, ({ args, thisHandle }) => {
    const controller = states.require(thisHandle)
    abortSignal(states.require(controller.signal), args[0])
    return ctx.undefined
  }))
  controllerProto.dispose()

  bridge.install(bridge.global, 'AbortSignal', AbortSignalCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(bridge.global, 'AbortController', AbortControllerCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// navigator augmentations
// ---------------------------------------------------------------------------

/**
 * Permission, battery, device, clipboard, geolocation, beacon and storage
 * surfaces on the already-installed `navigator`. Every answer is derived from
 * the profile so a permission cross-check cannot expose the sandbox.
 * @param {object} bridge
 * @param {object} kit
 */
function installNavigator(bridge, kit) {
  const { ctx, clock, profile } = bridge
  const { retain, pinObject, pinArray, pinError, pinString, fulfilled, rejected, installEventTarget } = kit

  const navigatorHandle = ctx.getProp(bridge.global, 'navigator')
  if (ctx.typeof(navigatorHandle) !== 'object') {
    navigatorHandle.dispose()
    return
  }
  const property = (name, value) =>
    bridge.install(navigatorHandle, name, value, { enumerable: true, configurable: true, writable: false })
  const method = (name, fn) =>
    bridge.install(navigatorHandle, name, fn, { enumerable: true, configurable: true, writable: true })

  const chromeLike = profile.browser !== 'firefox'
  const permissions = bridge.obj()
  property('permissions', permissions)
  bridge.install(permissions, 'query', bridge.fn('query', 1, ({ args }) => {
    const descriptor = bridge.value(args, 0) ?? {}
    const name = typeof descriptor.name === 'string' ? descriptor.name : String(descriptor.name ?? '')
    // PermissionState has no 'default'; Chrome maps the notification default
    // to 'prompt'.
    const configured = profile.permissions[name] ?? 'prompt'
    const state = configured === 'default' ? 'prompt' : configured
    const status = pinObject({ state, name, onchange: null })
    installEventTarget(status, ['addEventListener', 'removeEventListener', 'dispatchEvent'])
    bridge.emit('api', 'before', { api: 'navigator.permissions.query', name, state })
    return fulfilled(status)
  }), { enumerable: true, configurable: true, writable: true })
  installEventTarget(permissions, ['addEventListener', 'removeEventListener', 'dispatchEvent'])

  if (chromeLike) {
  const connection = bridge.obj({
    effectiveType: profile.connection.effectiveType,
    rtt: profile.connection.rtt,
    downlink: profile.connection.downlink,
    saveData: profile.connection.saveData,
    onchange: null,
  })
  if (profile.connection.type !== undefined) {
    bridge.install(connection, 'type', profile.connection.type, {
      enumerable: true,
      configurable: true,
      writable: false,
    })
  }
  installEventTarget(connection, ['addEventListener', 'removeEventListener'])
  property('connection', connection)

  method('getBattery', bridge.fn('getBattery', 0, () => {
    const battery = pinObject({
      charging: profile.battery.charging,
      level: profile.battery.level,
      chargingTime: profile.battery.chargingTime,
      dischargingTime: profile.battery.dischargingTime,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
    })
    installEventTarget(battery, ['addEventListener', 'removeEventListener'])
    bridge.emit('api', 'before', { api: 'navigator.getBattery', level: profile.battery.level })
    return fulfilled(battery)
  }))
  }

  const promiseOf = (value) => {
    const deferred = bridge.deferred()
    deferred.resolve(value)
    return deferred.handle
  }
  property('credentials', pinObject({
    get: bridge.fn('get', 1, () => promiseOf(ctx.null)),
    store: bridge.fn('store', 1, () => promiseOf(ctx.undefined)),
    create: bridge.fn('create', 1, () => promiseOf(ctx.null)),
    preventSilentAccess: bridge.fn('preventSilentAccess', 0, () => promiseOf(ctx.undefined)),
  }))
  property('getGamepads', bridge.fn('getGamepads', 0, () => pinArray([null, null, null, null])))
  property('mediaSession', pinObject({
    metadata: null,
    playbackState: 'none',
    setActionHandler: bridge.fn('setActionHandler', 2, () => ctx.undefined),
    setPositionState: bridge.fn('setPositionState', 1, () => ctx.undefined),
  }))
  if (chromeLike) {
    property('locks', pinObject({ request: bridge.fn('request', 2, () => promiseOf(ctx.null)) }))
    property('wakeLock', pinObject({ request: bridge.fn('request', 1, () => promiseOf(ctx.null)) }))
  }

  const mediaDevices = bridge.obj()
  property('mediaDevices', mediaDevices)
  bridge.install(mediaDevices, 'enumerateDevices', bridge.fn('enumerateDevices', 0, () => {
    bridge.emit('api', 'before', {
      api: 'navigator.mediaDevices.enumerateDevices',
      count: profile.mediaDevices.length,
    })
    return fulfilled(pinArray(profile.mediaDevices))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(mediaDevices, 'getUserMedia', bridge.fn('getUserMedia', 1, ({ args }) => {
    bridge.emit('api', 'before', {
      api: 'navigator.mediaDevices.getUserMedia',
      constraints: bridge.fromGuest(args[0]),
    })
    return rejected(pinError('NotAllowedError', 'Permission denied'))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(mediaDevices, 'getDisplayMedia', bridge.fn('getDisplayMedia', 1, () => {
    bridge.emit('api', 'before', { api: 'navigator.mediaDevices.getDisplayMedia' })
    return rejected(pinError('NotAllowedError', 'Permission denied'))
  }), { enumerable: true, configurable: true, writable: true })
  installEventTarget(mediaDevices, ['addEventListener', 'removeEventListener'])

  const clipboard = bridge.obj()
  property('clipboard', clipboard)
  bridge.install(clipboard, 'readText', bridge.fn('readText', 0, () => {
    bridge.emit('api', 'before', { api: 'navigator.clipboard.readText' })
    return fulfilled(pinString(''))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(clipboard, 'writeText', bridge.fn('writeText', 1, ({ args }) => {
    const text = kit.argumentText(args, 0)
    bridge.emit('api', 'before', { api: 'navigator.clipboard.writeText', length: text.length })
    bridge.reportIOC('clipboard', text)
    return fulfilled(ctx.undefined)
  }), { enumerable: true, configurable: true, writable: true })

  const geolocation = bridge.obj()
  property('geolocation', geolocation)
  bridge.install(geolocation, 'getCurrentPosition', bridge.fn('getCurrentPosition', 1, ({ args }) => {
    const errorCallback = args[1] && ctx.typeof(args[1]) === 'function' ? retain(args[1].dup()) : null
    bridge.emit('api', 'before', { api: 'navigator.geolocation.getCurrentPosition' })
    clock.schedule({
      delay: 0,
      fn: () => {
        if (!errorCallback) return
        const error = pinObject({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 })
        const result = ctx.callFunction(errorCallback, ctx.undefined, [error])
        if (result.error) result.error.dispose()
        else result.value.dispose()
      },
    })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(geolocation, 'watchPosition', bridge.fn('watchPosition', 1, () => {
    bridge.emit('api', 'before', { api: 'navigator.geolocation.watchPosition' })
    return ctx.newNumber(1)
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(geolocation, 'clearWatch', bridge.fn('clearWatch', 1, ({ args }) => {
    bridge.emit('api', 'before', { api: 'navigator.geolocation.clearWatch', id: bridge.int(args, 0, 0) })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  method('sendBeacon', bridge.fn('sendBeacon', 2, ({ args }) => {
    const url = kit.argumentText(args, 0)
    const payload = kit.preview(args[1])
    bridge.emit('api', 'before', { api: 'navigator.sendBeacon', url: url.slice(0, 2048), size: payload.length })
    bridge.reportIOC('url', url)
    return ctx.true
  }))

  property('userActivation', bridge.obj({ isActive: true, hasBeenActive: true }))
  if (bridge.storageManager) property('storage', bridge.storageManager)

  navigatorHandle.dispose()
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * `Notification` constructor and static permission, consistent with
 * `navigator.permissions.query({name: 'notifications'})`.
 * @param {object} bridge
 * @param {object} kit
 */
function installNotifications(bridge, kit) {
  const { ctx, profile } = bridge
  const { states, pinString, fulfilled } = kit

  const initialize = bridge.fn('initialize', 3, ({ args }) => {
    const options = bridge.fromGuest(args[2]) ?? {}
    states.set(args[0], {
      title: kit.toText(args[1]),
      body: typeof options.body === 'string' ? options.body : '',
      onclick: null,
      closed: false,
    })
    bridge.emit('api', 'before', { api: 'Notification', title: kit.toText(args[1]).slice(0, 256) })
    return ctx.undefined
  })

  const NotificationCtor = bridge.nativeConstructor({
    name: 'Notification',
    arity: 1,
    bindings: { initialize },
    body: 'initialize(self, arguments[0], arguments[1]);',
  })
  kit.setToStringTag(NotificationCtor, 'Notification')

  const proto = ctx.getProp(NotificationCtor, 'prototype')
  kit.defineAccessor(
    proto,
    'onclick',
    ({ thisHandle }) => states.require(thisHandle).onclick?.dup() ?? ctx.null,
    ({ args, thisHandle }) => {
      states.require(thisHandle).onclick = args[0] && ctx.typeof(args[0]) === 'function' ? kit.retain(args[0].dup()) : null
      return ctx.undefined
    },
  )
  bridge.install(proto, 'close', bridge.fn('close', 0, ({ thisHandle }) => {
    states.require(thisHandle).closed = true
    bridge.emit('api', 'before', { api: 'Notification.close' })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })
  proto.dispose()

  kit.defineGetter(NotificationCtor, 'permission', () => ctx.newString(profile.notificationPermission))
  bridge.install(NotificationCtor, 'requestPermission', bridge.fn('requestPermission', 0, () => {
    bridge.emit('api', 'before', { api: 'Notification.requestPermission' })
    return fulfilled(pinString('default'))
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(bridge.global, 'Notification', NotificationCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// Worker / SharedWorker
// ---------------------------------------------------------------------------

/**
 * `Worker` and `SharedWorker`. No host thread is started: messages, listener
 * registration and termination are recorded, which is what an analyst needs
 * from a stage-1 loader.
 * @param {object} bridge
 * @param {object} kit
 */
function installWorkers(bridge, kit) {
  const { ctx } = bridge
  const { states, retain } = kit

  const initializeWorker = bridge.fn('initialize', 2, ({ args }) => {
    const state = { url: kit.toText(args[1]), listeners: [], onmessage: null, onerror: null, terminated: false }
    states.set(args[0], state)
    bridge.emit('api', 'before', { api: 'Worker', url: state.url.slice(0, 2048) })
    return ctx.undefined
  })

  const WorkerCtor = bridge.nativeConstructor({
    name: 'Worker',
    arity: 1,
    bindings: { initialize: initializeWorker },
    body: 'initialize(self, arguments[0], arguments[1]);',
  })
  kit.setToStringTag(WorkerCtor, 'Worker')

  const proto = ctx.getProp(WorkerCtor, 'prototype')
  const method = (target, name, fn) => bridge.install(target, name, fn, { enumerable: true, configurable: true, writable: true })
  method(proto, 'postMessage', bridge.fn('postMessage', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    bridge.emit('api', 'before', {
      api: 'Worker.postMessage',
      url: state.url.slice(0, 512),
      payload: kit.preview(args[0]).slice(0, 1024),
      terminated: state.terminated,
    })
    return ctx.undefined
  }))
  method(proto, 'terminate', bridge.fn('terminate', 0, ({ thisHandle }) => {
    states.require(thisHandle).terminated = true
    bridge.emit('api', 'before', { api: 'Worker.terminate' })
    return ctx.undefined
  }))
  kit.defineAccessor(
    proto,
    'onmessage',
    ({ thisHandle }) => states.require(thisHandle).onmessage?.dup() ?? ctx.null,
    ({ args, thisHandle }) => {
      states.require(thisHandle).onmessage = args[0] && ctx.typeof(args[0]) === 'function' ? retain(args[0].dup()) : null
      return ctx.undefined
    },
  )
  method(proto, 'addEventListener', bridge.fn('addEventListener', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    if (args[1] && ctx.typeof(args[1]) === 'function') {
      state.listeners.push({ type: kit.toText(args[0]) || 'message', handle: retain(args[1].dup()) })
    }
    return ctx.undefined
  }))
  method(proto, 'removeEventListener', bridge.fn('removeEventListener', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    state.listeners = state.listeners.filter(
      (entry) => entry.type !== kit.toText(args[0]) || !kit.sameListener(entry.handle, args[1]),
    )
    return ctx.undefined
  }))
  proto.dispose()

  const SharedWorkerCtor = bridge.nativeConstructor({
    name: 'SharedWorker',
    arity: 1,
    bindings: { initialize: initializeWorker },
    body: 'initialize(self, arguments[0], arguments[1]);',
  })
  kit.setToStringTag(SharedWorkerCtor, 'SharedWorker')
  const sharedProto = ctx.getProp(SharedWorkerCtor, 'prototype')
  method(sharedProto, 'postMessage', bridge.fn('postMessage', 1, ({ args }) => {
    bridge.emit('api', 'before', { api: 'SharedWorker.postMessage', payload: kit.preview(args[0]).slice(0, 1024) })
    return ctx.undefined
  }))
  sharedProto.dispose()

  bridge.install(bridge.global, 'Worker', WorkerCtor, { enumerable: true, configurable: true, writable: true })
  bridge.install(bridge.global, 'SharedWorker', SharedWorkerCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// ServiceWorker container
// ---------------------------------------------------------------------------

/**
 * `navigator.serviceWorker` and the registration a loader gets back.
 *
 * Registering is a real capability of every Chromium build; a loader that
 * stages a payload through a service worker must not crash on the call. The
 * registration is a plausible activated one, and `ready` settles on the virtual
 * clock so an `await` completes deterministically.
 * @param {object} bridge
 * @param {object} kit
 */
function installServiceWorker(bridge, kit) {
  const { ctx, profile } = bridge
  const { pinObject, pinArray, fulfilled, installEventTarget } = kit
  if (!profile.serviceWorkerSupported) return

  const navigatorHandle = ctx.getProp(bridge.global, 'navigator')
  if (ctx.typeof(navigatorHandle) !== 'object') {
    navigatorHandle.dispose()
    return
  }

  /** Scope defaults to the script's directory, as in the Service Worker spec. */
  const scopeOf = (scriptURL) => {
    try {
      return new URL('.', new URL(scriptURL || './sw.js', profile.origin)).href
    } catch {
      return `${profile.origin}/`
    }
  }

  const registration = (scriptURL, scope) => {
    const active = pinObject({
      state: 'activated',
      scriptURL: scriptURL || `${profile.origin}/sw.js`,
      scope,
    })
    const record = pinObject({
      scope,
      active,
      installing: null,
      waiting: null,
      updateViaCache: 'imports',
    })
    installEventTarget(record, ['addEventListener', 'removeEventListener'])
    bridge.install(record, 'update', bridge.fn('update', 0, () => fulfilled(ctx.undefined)), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    bridge.install(record, 'unregister', bridge.fn('unregister', 0, () => fulfilled(ctx.true)), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    return record
  }

  const container = bridge.obj({ controller: null })
  bridge.install(container, 'register', bridge.fn('register', 1, ({ args }) => {
    const scriptURL = kit.argumentText(args, 0)
    const scope = scopeOf(scriptURL)
    bridge.emit('api', 'before', { api: 'serviceWorker.register', scriptURL: scriptURL.slice(0, 2048), scope })
    return fulfilled(registration(scriptURL, scope))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(container, 'ready', fulfilled(registration('', `${profile.origin}/`)), {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  bridge.install(container, 'getRegistrations', bridge.fn('getRegistrations', 0, () => fulfilled(pinArray([]))), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  installEventTarget(container, ['addEventListener', 'removeEventListener'])

  bridge.install(navigatorHandle, 'serviceWorker', container, {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  navigatorHandle.dispose()
}

// ---------------------------------------------------------------------------
// MessageChannel / BroadcastChannel
// ---------------------------------------------------------------------------

/**
 * Message ports and broadcast channels. Delivery happens on the virtual clock
 * with a synthetic `MessageEvent`, so postMessage-then-listen code completes
 * under `harness.timers()`.
 * @param {object} bridge
 * @param {object} kit
 */
function installMessaging(bridge, kit) {
  const { ctx, clock, profile } = bridge
  const { states, retain } = kit

  /** Deliver a message event to a port/channel state. */
  const deliver = (target, dataHandle, originHandle) => {
    if (target.closed) return
    const event = ctx.newObject()
    const typeHandle = ctx.newString('message')
    ctx.setProp(event, 'type', typeHandle)
    typeHandle.dispose()
    ctx.setProp(event, 'data', dataHandle)
    if (originHandle) ctx.setProp(event, 'origin', originHandle)
    if (target.onmessage) kit.dispatch([target.onmessage], event, target.guest)
    kit.dispatch(
      target.listeners.filter((entry) => entry.type === 'message').map((entry) => entry.handle),
      event,
      target.guest,
    )
    event.dispose()
  }

  /** Deliver a plain payload to one target on the virtual clock. */
  const scheduleDelivery = (target, payload, origin) => {
    clock.schedule({
      delay: 0,
      fn: () => {
        const data = kit.valueFromPlain(payload)
        const originHandle = origin === undefined ? null : ctx.newString(origin)
        deliver(target, data, originHandle)
        data.dispose()
        originHandle?.dispose()
      },
    })
  }

  // ---- MessageChannel ----------------------------------------------------
  const initializePort = bridge.fn('initialize', 1, ({ args }) => {
    states.set(args[0], {
      listeners: [],
      onmessage: null,
      peer: null,
      closed: false,
      guest: retain(args[0].dup()),
    })
    return ctx.undefined
  })
  const MessagePortCtor = bridge.nativeConstructor({
    name: 'MessagePort',
    arity: 0,
    bindings: { initialize: initializePort },
    body: 'initialize(self);',
  })
  kit.setToStringTag(MessagePortCtor, 'MessagePort')

  const portProto = ctx.getProp(MessagePortCtor, 'prototype')
  const portMethod = (name, fn) =>
    bridge.install(portProto, name, fn, { enumerable: true, configurable: true, writable: true })
  portMethod('postMessage', bridge.fn('postMessage', 1, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    const payload = bridge.fromGuest(args[0])
    bridge.emit('api', 'before', { api: 'MessagePort.postMessage', payload: kit.preview(args[0]).slice(0, 1024) })
    if (state.peer) scheduleDelivery(state.peer, payload)
    return ctx.undefined
  }))
  portMethod('start', bridge.fn('start', 0, () => ctx.undefined))
  portMethod('close', bridge.fn('close', 0, ({ thisHandle }) => {
    states.require(thisHandle).closed = true
    return ctx.undefined
  }))
  kit.defineAccessor(
    portProto,
    'onmessage',
    ({ thisHandle }) => states.require(thisHandle).onmessage?.dup() ?? ctx.null,
    ({ args, thisHandle }) => {
      states.require(thisHandle).onmessage = args[0] && ctx.typeof(args[0]) === 'function' ? retain(args[0].dup()) : null
      return ctx.undefined
    },
  )
  portMethod('addEventListener', bridge.fn('addEventListener', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    if (args[1] && ctx.typeof(args[1]) === 'function') {
      state.listeners.push({ type: kit.toText(args[0]), handle: retain(args[1].dup()) })
    }
    return ctx.undefined
  }))
  portProto.dispose()

  const initializeChannel = bridge.fn('initialize', 1, ({ args }) => {
    const first = ctx.callFunction(MessagePortCtor, ctx.undefined, [])
    const second = ctx.callFunction(MessagePortCtor, ctx.undefined, [])
    if (first.error || second.error) {
      first.error?.dispose()
      second.error?.dispose()
      first.value?.dispose()
      second.value?.dispose()
      throw new TypeError('Failed to construct MessageChannel')
    }
    const port1 = retain(first.value)
    const port2 = retain(second.value)
    states.require(port1).peer = states.require(port2)
    states.require(port2).peer = states.require(port1)
    ctx.setProp(args[0], 'port1', port1)
    ctx.setProp(args[0], 'port2', port2)
    states.set(args[0], { port1, port2 })
    return ctx.undefined
  })
  const MessageChannelCtor = bridge.nativeConstructor({
    name: 'MessageChannel',
    arity: 0,
    bindings: { initialize: initializeChannel },
    body: 'initialize(self);',
  })
  kit.setToStringTag(MessageChannelCtor, 'MessageChannel')

  // ---- BroadcastChannel --------------------------------------------------
  /** @type {Map<string, Set<object>>} */
  const channels = new Map()

  const initializeBroadcast = bridge.fn('initialize', 2, ({ args }) => {
    const state = {
      name: kit.toText(args[1]),
      listeners: [],
      onmessage: null,
      closed: false,
      guest: retain(args[0].dup()),
    }
    states.set(args[0], state)
    if (!channels.has(state.name)) channels.set(state.name, new Set())
    channels.get(state.name).add(state)
    bridge.emit('api', 'before', { api: 'BroadcastChannel', name: state.name })
    return ctx.undefined
  })
  const BroadcastChannelCtor = bridge.nativeConstructor({
    name: 'BroadcastChannel',
    arity: 1,
    bindings: { initialize: initializeBroadcast },
    body: 'initialize(self, arguments[0]);',
  })
  kit.setToStringTag(BroadcastChannelCtor, 'BroadcastChannel')

  const broadcastProto = ctx.getProp(BroadcastChannelCtor, 'prototype')
  const broadcastMethod = (name, fn) =>
    bridge.install(broadcastProto, name, fn, { enumerable: true, configurable: true, writable: true })
  kit.defineGetter(broadcastProto, 'name', ({ thisHandle }) => ctx.newString(states.require(thisHandle).name))
  broadcastMethod('postMessage', bridge.fn('postMessage', 1, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    const payload = bridge.fromGuest(args[0])
    bridge.emit('api', 'before', {
      api: 'BroadcastChannel.postMessage',
      name: state.name,
      payload: kit.preview(args[0]).slice(0, 1024),
    })
    for (const peer of channels.get(state.name) ?? []) {
      if (peer !== state) scheduleDelivery(peer, payload, profile.origin)
    }
    return ctx.undefined
  }))
  broadcastMethod('close', bridge.fn('close', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    state.closed = true
    channels.get(state.name)?.delete(state)
    bridge.emit('api', 'before', { api: 'BroadcastChannel.close', name: state.name })
    return ctx.undefined
  }))
  kit.defineAccessor(
    broadcastProto,
    'onmessage',
    ({ thisHandle }) => states.require(thisHandle).onmessage?.dup() ?? ctx.null,
    ({ args, thisHandle }) => {
      states.require(thisHandle).onmessage = args[0] && ctx.typeof(args[0]) === 'function' ? retain(args[0].dup()) : null
      return ctx.undefined
    },
  )
  broadcastMethod('addEventListener', bridge.fn('addEventListener', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    if (args[1] && ctx.typeof(args[1]) === 'function') {
      state.listeners.push({ type: kit.toText(args[0]), handle: retain(args[1].dup()) })
    }
    return ctx.undefined
  }))
  broadcastProto.dispose()

  bridge.install(bridge.global, 'MessageChannel', MessageChannelCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(bridge.global, 'BroadcastChannel', BroadcastChannelCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// CacheStorage / IndexedDB stubs
// ---------------------------------------------------------------------------

/**
 * `caches` and `indexedDB`. Neither performs host I/O; both behave like a
 * browser that refuses the operation, which is itself informative: samples
 * branch on a `NotSupportedError`.
 * @param {object} bridge
 * @param {object} kit
 */
function installStorageStubs(bridge, kit) {
  const { ctx, clock } = bridge
  const { retain, pinObject, pinArray, pinError, fulfilled } = kit

  /** @type {Map<string, object>} */
  const caches = new Map()

  const createCache = (name) => {
    const cache = pinObject({ name })
    const method = (key, fn) =>
      bridge.install(cache, key, fn, { enumerable: true, configurable: true, writable: true })
    method('match', bridge.fn('match', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'Cache.match', cache: name, request: kit.argumentText(args, 0) })
      return fulfilled(ctx.undefined)
    }))
    method('matchAll', bridge.fn('matchAll', 1, () => {
      bridge.emit('api', 'before', { api: 'Cache.matchAll', cache: name })
      return fulfilled(pinArray([]))
    }))
    method('add', bridge.fn('add', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'Cache.add', cache: name, request: kit.argumentText(args, 0) })
      return fulfilled(ctx.undefined)
    }))
    method('addAll', bridge.fn('addAll', 1, () => fulfilled(ctx.undefined)))
    method('put', bridge.fn('put', 2, () => fulfilled(ctx.undefined)))
    method('delete', bridge.fn('delete', 1, () => fulfilled(ctx.true)))
    method('keys', bridge.fn('keys', 0, () => fulfilled(pinArray([]))))
    return cache
  }

  const cacheStorage = bridge.obj()
  const method = (name, fn) =>
    bridge.install(cacheStorage, name, fn, { enumerable: true, configurable: true, writable: true })
  method('open', bridge.fn('open', 1, ({ args }) => {
    const name = kit.argumentText(args, 0) || 'default'
    if (!caches.has(name)) caches.set(name, createCache(name))
    bridge.emit('api', 'before', { api: 'CacheStorage.open', name })
    return fulfilled(caches.get(name).dup())
  }))
  method('has', bridge.fn('has', 1, ({ args }) =>
    caches.has(kit.argumentText(args, 0)) ? ctx.true : ctx.false,
  ))
  method('keys', bridge.fn('keys', 0, () => fulfilled(pinArray([...caches.keys()]))))
  method('delete', bridge.fn('delete', 1, ({ args }) =>
    fulfilled(caches.delete(kit.argumentText(args, 0)) ? ctx.true : ctx.false),
  ))
  bridge.install(bridge.global, 'caches', cacheStorage, { enumerable: true, configurable: true, writable: true })

  // ---- indexedDB ---------------------------------------------------------
  const indexedDB = bridge.obj()
  const openRequest = (api, name) => {
    const request = retain(ctx.newObject())
    const setKeyValue = (key, value) => {
      const handle = typeof value === 'string' ? ctx.newString(value) : value
      ctx.setProp(request, key, handle)
      if (typeof value === 'string') handle.dispose()
    }
    setKeyValue('error', ctx.null)
    setKeyValue('onerror', ctx.null)
    setKeyValue('onsuccess', ctx.null)
    setKeyValue('onupgradeneeded', ctx.null)
    setKeyValue('onblocked', ctx.null)
    setKeyValue('readyState', 'pending')
    const error = pinError('NotSupportedError', `Failed to execute '${api}' on 'IDBFactory': storage is disabled.`)
    clock.schedule({
      delay: 0,
      fn: () => {
        setKeyValue('error', error)
        setKeyValue('readyState', 'done')
        bridge.emit('storage', 'error', { api: `indexedDB.${api}`, name, error: 'NotSupportedError' })
        const handler = ctx.getProp(request, 'onerror')
        if (ctx.typeof(handler) === 'function') {
          const event = pinObject({ type: 'error', target: request })
          const result = ctx.callFunction(handler, request, [event])
          if (result.error) result.error.dispose()
          else result.value.dispose()
        }
        handler.dispose()
      },
    })
    bridge.emit('storage', 'enter', { api: `indexedDB.${api}`, name })
    return request.dup()
  }
  bridge.install(indexedDB, 'open', bridge.fn('open', 2, ({ args }) => openRequest('open', kit.argumentText(args, 0))), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(indexedDB, 'deleteDatabase', bridge.fn('deleteDatabase', 1, ({ args }) =>
    openRequest('deleteDatabase', kit.argumentText(args, 0)),
  ), { enumerable: true, configurable: true, writable: true })
  bridge.install(indexedDB, 'cmp', bridge.fn('cmp', 2, ({ args }) => {
    const left = kit.preview(args[0])
    const right = kit.preview(args[1])
    return ctx.newNumber(left === right ? 0 : left < right ? -1 : 1)
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(bridge.global, 'indexedDB', indexedDB, { enumerable: true, configurable: true, writable: true })
}

// ---------------------------------------------------------------------------
// structuredClone
// ---------------------------------------------------------------------------

/**
 * `structuredClone` over JSON-safe values. Malware uses it to compare or
 * de-duplicate C2 configurations; the host implementation gives exact deep-copy
 * semantics without running guest code.
 * @param {object} bridge
 * @param {object} kit
 */
function installStructuredClone(bridge, kit) {
  const { ctx } = bridge

  bridge.install(bridge.global, 'structuredClone', bridge.fn('structuredClone', 1, ({ args }) => {
    if (isHandle(args[0]) && ctx.typeof(args[0]) === 'function') throw kit.fatalClone('could not be cloned: function')
    let clone
    try {
      clone = structuredClone(bridge.fromGuest(args[0]))
    } catch {
      throw kit.fatalClone('could not be cloned.')
    }
    if (clone === undefined) return ctx.undefined
    if (clone === null) return ctx.null
    if (typeof clone === 'string') return ctx.newString(clone)
    if (typeof clone === 'number') return ctx.newNumber(clone)
    if (typeof clone === 'boolean') return clone ? ctx.true : ctx.false
    return Array.isArray(clone) ? bridge.arr(clone) : bridge.obj(clone)
  }), { enumerable: true, configurable: true, writable: true })
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------

/**
 * `RTCPeerConnection`, data channels and `RTCSessionDescription`. No socket is
 * opened; SDP is a fixed, syntactically valid offer so loaders that gate on
 * `createOffer()` completion proceed.
 * @param {object} bridge
 * @param {object} kit
 */
function installRtc(bridge, kit) {
  const { ctx, profile } = bridge
  const { states, retain, pinObject, fulfilled } = kit
  if (!profile.rtcSupported) return

  const dataChannel = (label) => {
    const channel = ctx.newObject()
    const state = { sent: [] }
    for (const [key, value] of [
      ['label', label],
      ['readyState', 'connecting'],
    ]) {
      const handle = ctx.newString(value)
      ctx.setProp(channel, key, handle)
      handle.dispose()
    }
    ctx.setProp(channel, 'onmessage', ctx.null)
    ctx.setProp(channel, 'onopen', ctx.null)
    ctx.setProp(channel, 'onclose', ctx.null)
    bridge.install(channel, 'send', bridge.fn('send', 1, ({ args }) => {
      state.sent.push(kit.preview(args[0]))
      bridge.emit('api', 'before', {
        api: 'RTCDataChannel.send',
        label,
        payload: kit.preview(args[0]).slice(0, 1024),
      })
      return ctx.undefined
    }), { enumerable: true, configurable: true, writable: true })
    bridge.install(channel, 'close', bridge.fn('close', 0, () => ctx.undefined), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    bridge.install(channel, 'addEventListener', bridge.fn('addEventListener', 2, () => ctx.undefined), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    return channel
  }

  const initialize = bridge.fn('initialize', 2, ({ args }) => {
    states.set(args[0], { connectionState: 'new', localDescription: null, channels: [] })
    return ctx.undefined
  })
  const RTCPeerConnectionCtor = bridge.nativeConstructor({
    name: 'RTCPeerConnection',
    arity: 0,
    bindings: { initialize },
    body: 'initialize(self, arguments[0], arguments[1]);',
  })
  kit.setToStringTag(RTCPeerConnectionCtor, 'RTCPeerConnection')

  const proto = ctx.getProp(RTCPeerConnectionCtor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })
  kit.defineGetter(proto, 'connectionState', ({ thisHandle }) =>
    ctx.newString(states.require(thisHandle).connectionState),
  )
  kit.defineGetter(proto, 'localDescription', ({ thisHandle }) => {
    const state = states.require(thisHandle)
    return state.localDescription ? state.localDescription.dup() : ctx.null
  })
  kit.defineGetter(proto, 'signalingState', () => ctx.newString('stable'))
  method('createDataChannel', bridge.fn('createDataChannel', 2, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    const label = kit.argumentText(args, 0) || 'data'
    const channel = dataChannel(label)
    state.channels.push(retain(channel.dup()))
    bridge.emit('api', 'before', { api: 'RTCPeerConnection.createDataChannel', label })
    return channel
  }))
  method('createOffer', bridge.fn('createOffer', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    const offer = pinObject({
      type: 'offer',
      sdp:
        `v=0\r\no=- ${profile.epoch} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n` +
        `a=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n` +
        `c=IN IP4 0.0.0.0\r\na=ice-ufrag:${profile.canvas.seed}\r\na=ice-pwd:${profile.audio.fingerprintNoise}\r\n` +
        'a=mid:0\r\na=sctp-port:5000\r\n',
    })
    state.localDescription = offer
    bridge.emit('api', 'before', { api: 'RTCPeerConnection.createOffer' })
    return fulfilled(offer.dup())
  }))
  method('createAnswer', bridge.fn('createAnswer', 0, () => {
    bridge.emit('api', 'before', { api: 'RTCPeerConnection.createAnswer' })
    return fulfilled(pinObject({ type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }))
  }))
  method('setLocalDescription', bridge.fn('setLocalDescription', 1, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    if (args[0] && ctx.typeof(args[0]) === 'object') state.localDescription = retain(args[0].dup())
    bridge.emit('api', 'before', { api: 'RTCPeerConnection.setLocalDescription' })
    return fulfilled(ctx.undefined)
  }))
  method('setRemoteDescription', bridge.fn('setRemoteDescription', 1, () => fulfilled(ctx.undefined)))
  method('addIceCandidate', bridge.fn('addIceCandidate', 1, () => fulfilled(ctx.undefined)))
  method('close', bridge.fn('close', 0, ({ thisHandle }) => {
    states.require(thisHandle).connectionState = 'closed'
    return ctx.undefined
  }))
  method('addEventListener', bridge.fn('addEventListener', 2, () => ctx.undefined))
  proto.dispose()

  const initializeDescription = bridge.fn('initialize', 2, ({ args }) => {
    const options = bridge.fromGuest(args[0]) ?? {}
    states.set(args[1], {
      type: typeof options.type === 'string' ? options.type : 'offer',
      sdp: typeof options.sdp === 'string' ? options.sdp : '',
    })
    return ctx.undefined
  })
  const RTCSessionDescriptionCtor = bridge.nativeConstructor({
    name: 'RTCSessionDescription',
    arity: 0,
    bindings: { initialize: initializeDescription },
    body: 'initialize(arguments[0], self);',
  })
  kit.setToStringTag(RTCSessionDescriptionCtor, 'RTCSessionDescription')
  const descriptionProto = ctx.getProp(RTCSessionDescriptionCtor, 'prototype')
  kit.defineGetter(descriptionProto, 'type', ({ thisHandle }) => ctx.newString(states.require(thisHandle).type))
  kit.defineGetter(descriptionProto, 'sdp', ({ thisHandle }) => ctx.newString(states.require(thisHandle).sdp))
  bridge.install(descriptionProto, 'toJSON', bridge.fn('toJSON', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    return bridge.obj({ type: state.type, sdp: state.sdp })
  }), { enumerable: true, configurable: true, writable: true })
  descriptionProto.dispose()

  bridge.install(bridge.global, 'RTCPeerConnection', RTCPeerConnectionCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(bridge.global, 'RTCSessionDescription', RTCSessionDescriptionCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// speechSynthesis
// ---------------------------------------------------------------------------

/**
 * `speechSynthesis` and `SpeechSynthesisUtterance`. Samples sometimes gate on
 * speech support to distinguish a real desktop browser from a VM.
 * @param {object} bridge
 * @param {object} kit
 */
function installSpeech(bridge, kit) {
  const { ctx, profile } = bridge
  const { states } = kit
  if (!profile.speechSupported) return

  const speech = bridge.obj({ pending: false, speaking: false, paused: false, onvoiceschanged: null })
  const method = (name, fn) => bridge.install(speech, name, fn, { enumerable: true, configurable: true, writable: true })
  method('speak', bridge.fn('speak', 1, ({ args }) => {
    bridge.emit('api', 'before', { api: 'speechSynthesis.speak', text: kit.preview(args[0]).slice(0, 512) })
    return ctx.undefined
  }))
  method('cancel', bridge.fn('cancel', 0, () => ctx.undefined))
  method('pause', bridge.fn('pause', 0, () => ctx.undefined))
  method('resume', bridge.fn('resume', 0, () => ctx.undefined))
  method('getVoices', bridge.fn('getVoices', 0, () => ctx.newArray()))
  bridge.install(bridge.global, 'speechSynthesis', speech, {
    enumerable: true,
    configurable: true,
    writable: false,
  })

  const initializeUtterance = bridge.fn('initialize', 2, ({ args }) => {
    states.set(args[1], {
      text: !isHandle(args[0]) || ctx.typeof(args[0]) === 'undefined' ? '' : kit.toText(args[0]),
      lang: profile.language,
      voice: null,
      volume: 1,
      rate: 1,
      pitch: 1,
    })
    return ctx.undefined
  })
  const UtteranceCtor = bridge.nativeConstructor({
    name: 'SpeechSynthesisUtterance',
    arity: 0,
    bindings: { initialize: initializeUtterance },
    body: 'initialize(arguments[0], self);',
  })
  kit.setToStringTag(UtteranceCtor, 'SpeechSynthesisUtterance')
  const proto = ctx.getProp(UtteranceCtor, 'prototype')
  const accessor = (key, read, write) => kit.defineAccessor(proto, key, read, write)
  for (const key of ['text', 'lang']) {
    accessor(
      key,
      ({ thisHandle }) => ctx.newString(states.require(thisHandle)[key]),
      ({ args, thisHandle }) => {
        states.require(thisHandle)[key] = kit.toText(args[0])
        return ctx.undefined
      },
    )
  }
  for (const key of ['volume', 'rate', 'pitch']) {
    accessor(
      key,
      ({ thisHandle }) => ctx.newNumber(states.require(thisHandle)[key]),
      ({ args, thisHandle }) => {
        states.require(thisHandle)[key] = bridge.num(args, 0, 1) || 1
        return ctx.undefined
      },
    )
  }
  for (const key of ['onend', 'onerror', 'onstart']) {
    bridge.install(proto, key, ctx.null, { enumerable: true, configurable: true, writable: true })
  }
  proto.dispose()
  bridge.install(bridge.global, 'SpeechSynthesisUtterance', UtteranceCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// Legacy window surface
// ---------------------------------------------------------------------------

/**
 * `window.external` and `window.webkitURL`. These are the legacy peers a
 * profile claims by existing; `msSaveBlob` stays absent because only a claimed
 * Trident profile has it.
 * @param {object} bridge
 * @param {object} URLctor
 */
function installLegacySurface(bridge, URLctor) {
  const { ctx, profile } = bridge

  const external = bridge.obj()
  bridge.install(external, 'AddSearchProvider', bridge.fn('AddSearchProvider', 1, () => ctx.undefined), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(
    external,
    'IsSearchProviderInstalled',
    bridge.fn('IsSearchProviderInstalled', 1, () => ctx.newNumber(0)),
    { enumerable: true, configurable: true, writable: true },
  )
  bridge.install(bridge.global, 'external', external, { enumerable: true, configurable: true, writable: false })
  // `webkitURL` is a Blink alias; Firefox never had it.
  if (profile.chrome) {
    bridge.install(bridge.global, 'webkitURL', URLctor, { enumerable: true, configurable: true, writable: true })
  }
}
