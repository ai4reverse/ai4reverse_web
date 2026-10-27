/**
 * `URL`, `URLSearchParams` and the legacy window aliases that belong to them.
 *
 * QuickJS ships no URL parser, yet loaders build C2 URLs with it and hand
 * payloads to `URL.createObjectURL`. Node's parser does the real work so
 * percent-encoding, IPv6 and plus-as-space match a real browser; the guest sees
 * a browser-shaped class with a live `searchParams`, native-looking methods and
 * no own properties on instances.
 *
 * The window-level `external` object and the Blink-only `webkitURL` alias are
 * installed here because they are URL peers that a profile claims by existing.
 */
import { isHandle } from '../bridge.js'
import { createKit } from './platform-kit.js'

export const meta = { id: 'url', order: 88, requires: ['globals'] }

/**
 * Largest entry list a guest-supplied `URLSearchParams` initializer may
 * describe. The length is guest data walked inside one host callback, where the
 * QuickJS interrupt handler cannot fire; the cap is host-side and constant.
 */
const MAX_PARAM_ENTRIES = 8192

/**
 * Install the URL surface.
 * @param {object} bridge host bridge
 */
export function install(bridge) {
  const kit = createKit(bridge)
  const URLSearchParamsCtor = installUrlSearchParams(bridge, kit)
  const URLctor = installUrl(bridge, kit, URLSearchParamsCtor)
  installLegacySurface(bridge, URLctor)
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
        if (length > MAX_PARAM_ENTRIES) {
          throw new RangeError(`The URLSearchParams initializer is limited to ${MAX_PARAM_ENTRIES} entries`)
        }
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
      if (result.error) return { error: result.error }
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
