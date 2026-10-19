import { isHandle } from '../bridge.js'
import { createKit } from './platform-kit.js'

/**
 * The remaining modern platform objects that no other module owns:
 * `AbortController`/`AbortSignal`, `Notification`, `Worker`/`SharedWorker`,
 * `ServiceWorkerContainer`, messaging (`postMessage`, `MessageChannel`,
 * `BroadcastChannel`), the storage stubs (`indexedDB`, `caches`),
 * `structuredClone`, WebRTC and speech synthesis.
 *
 * `URL`/`URLSearchParams` live in `url.js`, `Blob`/`File`/`FormData` in
 * `blob.js` and the navigator capabilities in `navigator.js`: one module per
 * surface, so selecting a subset never drops a declared one. Those modules and
 * this one share the per-bridge kit in `platform-kit.js`.
 *
 * Instance state is never stored as an own property of a guest instance: an
 * extra enumerable or symbol key on `new Worker(...)` is itself a shim tell.
 * Each instance is instead associated with a numeric id in a private guest
 * `WeakMap`, and the state lives on the host keyed by that id.
 */

export const meta = { id: 'misc', order: 100, requires: ['globals', 'navigator'] }

/**
 * Install the remaining platform surface. Each section owns one browser class
 * or namespace; they share the per-bridge kit with `url.js` and `blob.js`.
 * @param {object} bridge host bridge
 */
export function install(bridge) {
  const kit = createKit(bridge)
  installAbort(bridge, kit)
  installNotifications(bridge, kit)
  installWorkers(bridge, kit)
  installServiceWorker(bridge, kit)
  installMessaging(bridge, kit)
  installStorageStubs(bridge, kit)
  installStructuredClone(bridge, kit)
  installRtc(bridge, kit)
  installSpeech(bridge, kit)
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
