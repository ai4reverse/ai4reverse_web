/**
 * `location` and `history`.
 *
 * Navigation is captured, never performed: `assign`/`replace` record an IOC and
 * update the visible URL, exactly as a browser address bar would, then return.
 * A silent no-op would be detectable (the URL would not change) and would lose
 * the most valuable dynamic IOC in most loaders.
 */

export const meta = { id: 'location', order: 50, requires: ['globals'] }

export function install(bridge) {
  const { ctx, profile } = bridge
  let current = new URL(profile.href)

  // WebIDL shape: attributes/operations live on the prototype, so instances
  // keep zero own enumerable properties (and stay that way after navigation).
  const locationProto = bridge.obj()
  const location = bridge.obj({}, locationProto)
  const historyProto = bridge.obj()
  const history = bridge.obj({}, historyProto)
  const historyStack = [profile.href]
  let historyIndex = 0

  const parts = () => ({
    href: current.href,
    origin: current.origin,
    protocol: current.protocol,
    host: current.host,
    hostname: current.hostname,
    port: current.port,
    pathname: current.pathname,
    search: current.search,
    hash: current.hash,
  })

  const refresh = () => {
    for (const [key, value] of Object.entries(parts())) {
      bridge.install(locationProto, key, value, { enumerable: true, configurable: true, writable: false })
    }
    bridge.install(locationProto, 'ancestorOrigins', bridge.arr([]), {
      enumerable: true,
      configurable: true,
      writable: false,
    })
  }
  refresh()

  const navigate = (api, url, replace) => {
    if (!url) return
    let target
    try {
      target = new URL(String(url), current)
    } catch {
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      bridge.emit('api', 'before', { api: `location.${api}`, url: target.href, blocked: true, reason: 'scheme' })
      return
    }
    bridge.emit('api', 'before', { api: `location.${api}`, url: target.href, replace: Boolean(replace) })
    bridge.reportIOC('url', target.href)
    current = target
    if (replace && historyIndex < historyStack.length) {
      historyStack[historyIndex] = target.href
    } else {
      historyStack.push(target.href)
      historyIndex = historyStack.length - 1
    }
    refresh()
    bridge.install(historyProto, 'length', historyStack.length, { enumerable: true, configurable: true, writable: false })
  }

  bridge.install(locationProto, 'assign', bridge.fn('assign', 1, ({ args }) => {
    navigate('assign', bridge.str(args, 0), false)
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(locationProto, 'replace', bridge.fn('replace', 1, ({ args }) => {
    navigate('replace', bridge.str(args, 0), true)
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(locationProto, 'reload', bridge.fn('reload', 0, () => {
    bridge.emit('api', 'before', { api: 'location.reload', url: current.href })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(locationProto, 'toString', bridge.fn('toString', 0, () => ctx.newString(current.href)), {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  bridge.install(bridge.global, 'location', location, {
    enumerable: true,
    configurable: false,
    writable: false,
  })

  // history
  bridge.install(historyProto, 'length', 1, { enumerable: true, configurable: true, writable: false })
  bridge.install(historyProto, 'state', ctx.null, { enumerable: true, configurable: true, writable: false })
  bridge.install(historyProto, 'scrollRestoration', 'auto', { enumerable: true, configurable: true, writable: true })

  for (const [name, arity] of [['back', 0], ['forward', 0]]) {
    bridge.install(historyProto, name, bridge.fn(name, arity, () => {
      bridge.emit('api', 'before', { api: `history.${name}` })
      return ctx.undefined
    }), { enumerable: true, configurable: true, writable: true })
  }
  bridge.install(historyProto, 'go', bridge.fn('go', 1, ({ args }) => {
    bridge.emit('api', 'before', { api: 'history.go', delta: bridge.int(args, 0, 0) })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  for (const name of ['pushState', 'replaceState']) {
    bridge.install(historyProto, name, bridge.fn(name, 3, ({ args }) => {
      const state = bridge.value(args, 0)
      const url = bridge.str(args, 2, '')
      bridge.emit('api', 'before', { api: `history.${name}`, url })
      if (url) {
        try {
          current = new URL(url, current)
          refresh()
        } catch {
          /* invalid URL: browsers throw a SecurityError; keep the old URL */
        }
      }
      bridge.install(historyProto, 'state', state === undefined ? ctx.null : bridge.toGuest(state), {
        enumerable: true,
        configurable: true,
        writable: false,
      })
      return ctx.undefined
    }), { enumerable: true, configurable: true, writable: true })
  }

  bridge.install(bridge.global, 'history', history, {
    enumerable: true,
    configurable: true,
    writable: false,
  })

  // Keep document.URL/document.location consistent when the document module
  // installs later: it reads profile.href, so expose the live URL through the
  // bridge for that module.
  bridge.currentUrl = () => current.href
}
