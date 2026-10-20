/**
 * Shared kit for the environment modules that build guest-constructed classes.
 *
 * `URL`, `Blob`, `File`, `FormData`, the navigator augmentations and the
 * messenger/worker surfaces in `misc.js` all need the same machinery: a guest
 * WeakMap that associates host state with an instance without adding an own
 * property to it, a retained-handle set, guest-widget helpers and a seeded RNG.
 *
 * The kit is **per bridge, memoised**: every env module that installs on the
 * same context shares one state map, one retained set, one RNG stream and one
 * teardown hook. That is deliberate.
 *
 *  - Instance ids stay unique across modules, so `URL.createObjectURL(blob)`
 *    still recognises a `Blob` created by another module.
 *  - The RNG stream is consumed in install order, exactly as it was when this
 *    code lived in one module, so `blob:` URLs stay reproducible per seed.
 *  - Teardown runs once and in the same order as before the split.
 *
 * This file is support code, not an environment module: it has no `meta` and
 * must never be listed in `ENV_MODULE_IDS`.
 */

import { isHandle } from '../bridge.js'
import { createSeededRandom } from '../../util/random.js'

/** One kit per bridge; a bridge lives exactly one run. */
const KITS = new WeakMap()

/**
 * Get (or build) the environment kit for a bridge.
 * @param {object} bridge host bridge
 * @returns {object} the shared kit
 */
export function createKit(bridge) {
  let kit = KITS.get(bridge)
  if (!kit) {
    kit = buildKit(bridge)
    KITS.set(bridge, kit)
  }
  return kit
}

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
 * Build the kit. Call `createKit()` — never this — so one bridge has one kit.
 * @param {object} bridge
 */
function buildKit(bridge) {
  const { ctx, clock, profile } = bridge
  // The label stays "misc": the stream is consumed in install order, so a
  // different label would change every `blob:` URL this seed produces.
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
