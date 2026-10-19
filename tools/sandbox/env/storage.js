/**
 * Web Storage.
 *
 * Values are real strings, keys enumerate in insertion order, and every access
 * is traced (malware frequently stores decrypted stage-2 payloads or C2 config
 * in localStorage). `localStorage instanceof Storage` must hold, so instances
 * are real `Storage.prototype` objects carrying a private symbol-keyed state id;
 * the symbol is filtered from enumeration by anti-fingerprint.
 */

export const meta = { id: 'storage', order: 55, requires: ['globals'] }

export function install(bridge) {
  const { ctx, profile } = bridge
  const idSymbol = ctx.newSymbolFor('ai4r.storage.instance')
  /** @type {Map<number, {kind: string, map: Map<string, string>}>} */
  const states = new Map()
  const QUOTA_BYTES = 5 * 1024 * 1024
  let totalBytes = 0
  let nextId = 0

  const stateOf = (thisHandle) => {
    if (!thisHandle) return null
    try {
      const prop = ctx.getProp(thisHandle, idSymbol)
      if (ctx.typeof(prop) !== 'number') {
        prop.dispose()
        return null
      }
      const id = ctx.getNumber(prop)
      prop.dispose()
      return states.get(id) ?? null
    } catch {
      return null
    }
  }

  const proto = bridge.obj()

  const method = (name, arity, impl) => {
    const handle = bridge.fn(name, arity, (call) => impl(call, stateOf(call.thisHandle)))
    bridge.install(proto, name, handle, { enumerable: true, configurable: true, writable: true })
  }

  method('getItem', 1, ({ args }, state) => {
    if (!state) return ctx.null
    const key = bridge.str(args, 0, '')
    const value = state.map.has(key) ? state.map.get(key) : null
    bridge.emit('storage', 'enter', {
      api: `${state.kind}.getItem`,
      key,
      found: value !== null,
      value: value?.slice(0, 4096),
    })
    return value === null ? ctx.null : ctx.newString(value)
  })

  method('setItem', 2, ({ args }, state) => {
    if (!state) throw Object.assign(new Error('Illegal invocation'), { name: 'TypeError' })
    const key = bridge.str(args, 0, '')
    const raw = bridge.value(args, 1)
    const value = String(raw)
    const previous = state.map.get(key)
    const delta = value.length - (previous?.length ?? 0)
    if (totalBytes + delta > QUOTA_BYTES) {
      const error = new Error(
        `Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`,
      )
      error.name = 'QuotaExceededError'
      throw error
    }
    totalBytes += delta
    state.map.set(key, value)
    bridge.emit('storage', 'enter', {
      api: `${state.kind}.setItem`,
      key,
      length: value.length,
      value: value.slice(0, 4096),
    })
    return ctx.undefined
  })

  method('removeItem', 1, ({ args }, state) => {
    if (!state) return ctx.undefined
    const key = bridge.str(args, 0, '')
    totalBytes -= state.map.get(key)?.length ?? 0
    state.map.delete(key)
    bridge.emit('storage', 'enter', { api: `${state.kind}.removeItem`, key })
    return ctx.undefined
  })

  method('clear', 0, (call, state) => {
    if (!state) return ctx.undefined
    for (const value of state.map.values()) totalBytes -= value.length
    state.map.clear()
    bridge.emit('storage', 'enter', { api: `${state.kind}.clear` })
    return ctx.undefined
  })

  method('key', 1, ({ args }, state) => {
    if (!state) return ctx.null
    const index = bridge.int(args, 0, -1)
    const keys = [...state.map.keys()]
    return index >= 0 && index < keys.length ? ctx.newString(keys[index]) : ctx.null
  })

  bridge.accessor(proto, 'length', {
    get: Object.defineProperty(
      function ({ thisHandle }) {
        const state = stateOf(thisHandle)
        return ctx.newNumber(state ? state.map.size : 0)
      },
      'name',
      { value: 'get length' },
    ),
    enumerable: true,
    configurable: true,
  })

  // Browsers throw on `new Storage()`: Storage is an interface, not a factory.
  const Storage = bridge.fn(
    'Storage',
    0,
    () => {
      const error = new Error('Illegal constructor')
      error.name = 'TypeError'
      throw error
    },
    { isConstructor: true },
  )
  bridge.install(Storage, 'prototype', proto, { enumerable: false, configurable: false, writable: false })
  bridge.install(proto, 'constructor', Storage, { enumerable: false, configurable: true, writable: true })
  bridge.install(ctx.global, 'Storage', Storage, { enumerable: false, configurable: true, writable: true })

  const createStorage = (kind) => {
    const id = (nextId += 1)
    const state = { kind, map: new Map() }
    states.set(id, state)
    const storage = bridge.obj({}, proto)
    const idHandle = ctx.newNumber(id)
    ctx.setProp(storage, idSymbol, idHandle)
    idHandle.dispose()
    bridge.install(ctx.global, kind, storage, { enumerable: true, configurable: true, writable: false })
    return storage
  }

  createStorage('localStorage')
  createStorage('sessionStorage')

  // StorageManager (navigator.storage) is a modern fingerprinting surface.
  const storageManager = bridge.obj()
  bridge.install(storageManager, 'estimate', bridge.fn('estimate', 0, () => {
    const deferred = bridge.deferred()
    deferred.resolve(bridge.obj({ usage: totalBytes, quota: profile.storage.quota }))
    return deferred.handle
  }), { enumerable: true, configurable: true, writable: true })
  for (const name of ['persisted', 'persist']) {
    bridge.install(storageManager, name, bridge.fn(name, 0, () => {
      const deferred = bridge.deferred()
      deferred.resolve(false)
      return deferred.handle
    }), { enumerable: true, configurable: true, writable: true })
  }
  bridge.storageManager = storageManager
  bridge.onDispose(() => {
    states.clear()
    try {
      idSymbol.dispose()
    } catch {
      /* already gone */
    }
  })
}
