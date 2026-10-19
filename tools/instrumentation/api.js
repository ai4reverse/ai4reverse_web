/**
 * API-level traceless instrumentation.
 *
 * Platform APIs are *host* functions, so wrapping them with another host
 * function preserves everything a brand check can observe: `name`, `length`,
 * `Function.prototype.toString()` (`[native code]`), and the absence of extra
 * stack frames. The wrapper dispatches `api:before` hooks, which may inspect,
 * rewrite arguments, or return a synthetic result (a traceless mock) without the
 * guest ever seeing a `Proxy`, a trap, or an added wrapper frame.
 *
 * Guest-defined functions are never wrapped here: replacing them would change
 * `toString()` output and is therefore detectable. Guest-level interception is
 * the AST instrumentation layer's job.
 */

/**
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} options.bridge
 * @param {object} [options.trace]
 * @param {object} [options.hooks]
 * @param {object} [options.logger]
 */
export function createApiInstrumenter(options) {
  const { ctx, bridge, trace, hooks, logger } = options
  const wrapped = []
  const owned = []
  const stats = { targets: 0, calls: 0, mocked: 0, failed: 0 }

  const defineAccessor = ctx.evalCode(
    '(function(o,k,g,s,e,c){Object.defineProperty(o,k,{get:g,set:s,enumerable:e,configurable:c})})',
    'ai4r-internal:accessor',
  )
  if (defineAccessor.error) {
    defineAccessor.error.dispose()
    throw new Error('api instrumentation: accessor factory unavailable')
  }
  const accessorFactory = defineAccessor.value

  const ownerFactoryResult = ctx.evalCode(
    '(function (target, key) { var current = target; while (current) { var descriptor = Object.getOwnPropertyDescriptor(current, key); if (descriptor) return current; current = Object.getPrototypeOf(current); } return null; })',
    'ai4r-internal:owner',
  )
  if (ownerFactoryResult.error) {
    ownerFactoryResult.error.dispose()
    throw new Error('api instrumentation: owner lookup unavailable')
  }
  const ownerFactory = ownerFactoryResult.value
  const findOwner = (targetHandle, key) => {
    const keyHandle = ctx.newString(key)
    const result = ctx.callFunction(ownerFactory, ctx.undefined, [targetHandle, keyHandle])
    keyHandle.dispose()
    if (result.error) {
      result.error.dispose()
      return null
    }
    if (ctx.dump(result.value) === null) {
      result.value.dispose()
      return null
    }
    return result.value
  }

  const resolve = (expression) => {
    const result = ctx.evalCode(expression, 'ai4r-internal:resolve')
    if (result.error) {
      const dumped = bridge.fromGuest(result.error)
      result.error.dispose()
      return { ok: false, error: dumped }
    }
    return { ok: true, handle: result.value }
  }

  // Only primitives are read eagerly: dumping arbitrary objects would run guest
  // getters/toJSON a second time (an observable anti-hook probe).
  const plainArgs = (args) =>
    args.map((_, index) => {
      const handle = args[index]
      if (!handle) return undefined
      try {
        const type = ctx.typeof(handle)
        if (type === 'string' || type === 'number' || type === 'boolean') return bridge.value(args, index)
        if (type === 'undefined') return undefined
        return `[${type}]`
      } catch {
        return undefined
      }
    })

  const rethrow = (error) => {
    const rethrown = new Error(error?.message ?? 'api call failed')
    rethrown.name = error?.name ?? 'Error'
    throw rethrown
  }

  /**
   * Wrap a method. Returns true when the API existed and was wrapped.
   * @param {object} targetHandle
   * @param {string} key
   * @param {{label: string, arity?: number}} spec
   */
  function wrapMethod(targetHandle, key, spec) {
    const owner = findOwner(targetHandle, key)
    if (!owner) return false
    const original = ctx.getProp(owner, key)
    if (ctx.typeof(original) !== 'function') {
      original.dispose()
      owner.dispose()
      return false
    }
    const arity = spec.arity ?? 0
    const label = spec.label ?? key
    const wrapper = bridge.fn(key, arity, ({ args, thisHandle }) => {
      stats.calls += 1
      const argsPlain = plainArgs(args)
      trace?.emit('api', 'invoke', { api: label, args: truncate(argsPlain), instrumented: true })
      const decision = hooks?.dispatch('api:before', { api: label, args: argsPlain }) ?? {}
      if (decision.blocked) {
        stats.mocked += 1
        trace?.emit('api', 'skip', { api: label, mock: true, args: truncate(argsPlain) })
        return bridge.toGuest(decision.value)
      }
      let callArgs = args
      const temporaries = []
      if (decision.args) {
        callArgs = decision.args.map((value) => {
          const handle = bridge.toGuest(value)
          temporaries.push(handle)
          return handle
        })
      }
      let result
      try {
        result = ctx.callFunction(original, thisHandle ?? ctx.undefined, callArgs)
      } finally {
        for (const handle of temporaries) {
          try {
            handle.dispose()
          } catch {
            /* already gone */
          }
        }
      }
      if (result.error) {
        const error = bridge.fromGuest(result.error)
        result.error.dispose()
        stats.failed += 1
        trace?.emit('api', 'error', { api: label, error })
        hooks?.emit('api:error', { api: label, error, args: truncate(argsPlain) })
        rethrow(error)
      }
      trace?.emit('api', 'after', { api: label, result: truncate(bridge.value([result.value], 0)) })
      hooks?.emit('api:after', { api: label, result: bridge.fromGuest(result.value), args: truncate(argsPlain) })
      return result.value
    })
    // Wrap on the prototype that owns the property (WebIDL shape): instances
    // keep zero own enumerable properties.
    bridge.install(owner, key, wrapper, { enumerable: true, configurable: true, writable: true })
    owner.dispose()
    wrapped.push({ label, arity, kind: 'method' })
    stats.targets += 1
    owned.push(original, wrapper)
    trace?.emit('api', 'emit', { event: 'api.wrapped', api: label, arity, kind: 'method' })
    return true
  }

  /**
   * Wrap an accessor property (e.g. `document.cookie`).
   * @param {object} targetHandle
   * @param {string} key
   * @param {{label: string}} spec
   */
  function wrapAccessor(targetHandle, key, spec) {
    const label = spec.label ?? key
    const owner = findOwner(targetHandle, key)
    if (!owner) return false
    const descriptorFactory = ctx.evalCode(
      '(function(o,k){var d=Object.getOwnPropertyDescriptor(o,k);return d?{get:d.get,set:d.set,enumerable:d.enumerable,configurable:d.configurable}:null})',
      'ai4r-internal:descriptor',
    )
    if (descriptorFactory.error) {
      descriptorFactory.error.dispose()
      return false
    }
    const descriptorKey = ctx.newString(key)
    const descriptorResult = ctx.callFunction(descriptorFactory.value, ctx.undefined, [
      owner,
      descriptorKey,
    ])
    descriptorKey.dispose()
    descriptorFactory.value.dispose()
    if (descriptorResult.error) {
      descriptorResult.error.dispose()
      return false
    }
    if (ctx.dump(descriptorResult.value) === null) {
      descriptorResult.value.dispose()
      return false
    }
    const descriptor = descriptorResult.value
    const getter = ctx.getProp(descriptor, 'get')
    const setter = ctx.getProp(descriptor, 'set')
    const enumerable = ctx.getProp(descriptor, 'enumerable')
    const enumerableValue = Boolean(ctx.dump(enumerable))
    enumerable.dispose()
    descriptor.dispose()

    const getIsFunction = ctx.typeof(getter) === 'function'
    const setIsFunction = ctx.typeof(setter) === 'function'

    const newGetter = getIsFunction
      ? bridge.fn(`get ${key}`, 0, ({ thisHandle }) => {
          stats.calls += 1
          const decision = hooks?.dispatch('api:before', { api: `${label}:get` }) ?? {}
          if (decision.blocked) {
            stats.mocked += 1
            return bridge.toGuest(decision.value)
          }
          const call = ctx.callFunction(getter, thisHandle ?? ctx.undefined, [])
          if (call.error) {
            const error = bridge.fromGuest(call.error)
            call.error.dispose()
            stats.failed += 1
            rethrow(error)
          }
          const summary = bridge.fromGuest(call.value)
          trace?.emit('api', 'after', { api: `${label}:get`, result: truncate(summary) })
          hooks?.emit('api:after', { api: `${label}:get`, result: summary })
          return call.value
        })
      : null

    const newSetter = setIsFunction
      ? bridge.fn(`set ${key}`, 1, ({ args, thisHandle }) => {
          stats.calls += 1
          trace?.emit('api', 'invoke', { api: `${label}:set`, args: truncate(plainArgs(args)), instrumented: true })
          const decision = hooks?.dispatch('api:before', { api: `${label}:set`, args: plainArgs(args) }) ?? {}
          if (decision.blocked) {
            stats.mocked += 1
            return ctx.undefined
          }
          const call = ctx.callFunction(setter, thisHandle ?? ctx.undefined, args)
          if (call.error) {
            const error = bridge.fromGuest(call.error)
            call.error.dispose()
            stats.failed += 1
            rethrow(error)
          }
          call.value?.dispose?.()
          trace?.emit('api', 'before', { api: `${label}:set`, value: truncate(bridge.value(args, 0)) })
          return ctx.undefined
        })
      : null

    const keyHandle = ctx.newString(key)
    const install = ctx.callFunction(accessorFactory, ctx.undefined, [
      owner,
      keyHandle,
      newGetter ?? ctx.undefined,
      newSetter ?? ctx.undefined,
      enumerableValue ? ctx.true : ctx.false,
      ctx.true,
    ])
    keyHandle.dispose()
    owner.dispose()
    if (install.error) {
      install.error.dispose()
      return false
    }
    install.value.dispose()
    wrapped.push({ label, arity: 0, kind: 'accessor' })
    stats.targets += 1
    owned.push(getter, setter)
    if (newGetter) owned.push(newGetter)
    if (newSetter) owned.push(newSetter)
    trace?.emit('api', 'emit', { event: 'api.wrapped', api: label, kind: 'accessor' })
    return true
  }

  const DEFAULT_TARGETS = [
    {
      expression: 'globalThis',
      keys: [['fetch', 1], ['open', 3], ['postMessage', 2], ['alert', 1], ['confirm', 1], ['prompt', 2]],
      label: 'window',
    },
    {
      expression: 'globalThis.XMLHttpRequest && globalThis.XMLHttpRequest.prototype',
      keys: [['open', 5], ['send', 1], ['setRequestHeader', 2], ['getResponseHeader', 1], ['getAllResponseHeaders', 0]],
      label: 'XMLHttpRequest',
    },
    {
      expression: 'globalThis.WebSocket && globalThis.WebSocket.prototype',
      keys: [['send', 1], ['close', 2]],
      label: 'WebSocket',
    },
    {
      expression: 'globalThis.Storage && globalThis.Storage.prototype',
      keys: [['setItem', 2], ['getItem', 1], ['removeItem', 1], ['clear', 0]],
      label: 'Storage',
    },
    {
      expression: 'globalThis.Worker && globalThis.Worker.prototype',
      keys: [['postMessage', 2], ['terminate', 0]],
      label: 'Worker',
    },
    {
      expression: 'globalThis.Crypto && globalThis.Crypto.prototype',
      keys: [['getRandomValues', 1], ['randomUUID', 0]],
      label: 'Crypto',
    },
    {
      // SubtleCrypto lives on the crypto *instance*, not Crypto.prototype.
      expression: 'globalThis.crypto && globalThis.crypto.subtle',
      keys: [['digest', 2], ['encrypt', 3], ['decrypt', 3], ['sign', 3], ['verify', 4], ['generateKey', 3], ['importKey', 5], ['exportKey', 2]],
      label: 'crypto.subtle',
    },
    {
      expression: 'globalThis.navigator && globalThis.navigator.clipboard',
      keys: [['readText', 0], ['writeText', 1], ['read', 0], ['write', 1]],
      label: 'navigator.clipboard',
    },
    {
      expression: 'globalThis.navigator && globalThis.navigator.mediaDevices',
      keys: [['getUserMedia', 1], ['getDisplayMedia', 1], ['enumerateDevices', 0]],
      label: 'navigator.mediaDevices',
    },
    {
      expression: 'globalThis.navigator',
      keys: [['sendBeacon', 2]],
      label: 'navigator',
    },
    {
      expression: 'globalThis.navigator && globalThis.navigator.permissions',
      keys: [['query', 1]],
      label: 'navigator.permissions',
    },
    {
      expression: 'globalThis.navigator && globalThis.navigator.serviceWorker',
      keys: [['register', 2], ['getRegistrations', 0]],
      label: 'navigator.serviceWorker',
    },
    {
      expression: 'globalThis.Notification',
      keys: [['requestPermission', 1]],
      label: 'Notification',
    },
    {
      expression: 'globalThis.history',
      keys: [['pushState', 3], ['replaceState', 3], ['back', 0], ['forward', 0], ['go', 1]],
      label: 'history',
    },
    {
      expression: 'globalThis.location',
      keys: [['assign', 1], ['replace', 1], ['reload', 0]],
      label: 'location',
    },
    {
      expression: 'globalThis.document',
      keys: [['write', 1], ['writeln', 1], ['createElement', 1]],
      label: 'document',
    },
    {
      expression: 'globalThis.WebAssembly',
      keys: [['compile', 1], ['instantiate', 1], ['validate', 1]],
      label: 'WebAssembly',
    },
  ]

  return {
    install(extraTargets = []) {
      for (const target of [...DEFAULT_TARGETS, ...extraTargets]) {
        const resolved = resolve(target.expression)
        if (!resolved.ok) continue
        const targetHandle = resolved.handle
        for (const entry of target.keys ?? []) {
          const [key, arity] = Array.isArray(entry) ? entry : [entry, 0]
          try {
            wrapMethod(targetHandle, key, { label: `${target.label}.${key}`, arity })
          } catch (error) {
            logger?.debug?.({ api: `${target.label}.${key}`, err: error.message }, 'api wrap failed')
          }
        }
        owned.push(targetHandle)
      }

      const documentResolved = resolve('globalThis.document')
      if (documentResolved.ok) {
        try {
          wrapAccessor(documentResolved.handle, 'cookie', { label: 'document.cookie' })
        } catch (error) {
          logger?.debug?.({ err: error.message }, 'cookie wrap failed')
        }
        owned.push(documentResolved.handle)
      }

      // localStorage/sessionStorage are plain objects, not Storage instances.
      for (const name of ['localStorage', 'sessionStorage']) {
        const resolved = resolve(`globalThis.${name}`)
        if (!resolved.ok) continue
        for (const [key, arity] of [['setItem', 2], ['getItem', 1], ['removeItem', 1], ['clear', 0]]) {
          try {
            wrapMethod(resolved.handle, key, { label: `${name}.${key}`, arity })
          } catch (error) {
            logger?.debug?.({ api: `${name}.${key}`, err: error.message }, 'api wrap failed')
          }
        }
        owned.push(resolved.handle)
      }
      return this.describe()
    },

    wrapMethod,
    wrapAccessor,

    describe() {
      return { wrapped: [...wrapped], stats: { ...stats } }
    },

    stats() {
      return { ...stats, wrapped: wrapped.length }
    },

    dispose() {
      for (const handle of owned.splice(0)) {
        try {
          handle.dispose()
        } catch {
          /* already gone */
        }
      }
      try {
        accessorFactory.dispose()
        ownerFactory.dispose()
      } catch {
        /* already gone */
      }
    },
  }
}

function truncate(value, max = 512) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value)
      return text.length > max ? `${text.slice(0, max)}…` : value
    } catch {
      return '[object]'
    }
  }
  return value
}
