/**
 * Global object surface: `window`, `self`, `top`, `parent`, `frames` and the
 * Window prototype chain.
 *
 * Real browsers expose `window` as a `Window` instance whose prototype is
 * `Window.prototype`; samples do check `window.constructor.name`,
 * `Object.prototype.toString.call(window)` and `window instanceof Window`.
 * QuickJS's global object is a plain object, so we graft a `Window` prototype
 * onto it in the guest. The shim is registered as native source, therefore
 * `Window.toString()` and `Window.prototype.constructor` look like built-ins.
 */

export const meta = { id: 'globals', order: 10, requires: [] }

export function install(bridge) {
  const { ctx, profile, stealth } = bridge
  const global = bridge.global
  const hidden = { enumerable: false, configurable: true, writable: false }
  const accessorFlags = { enumerable: true, configurable: true }

  // `window` and its aliases. In a browser these are non-configurable own
  // accessors of the global object.
  for (const key of ['window', 'self', 'top', 'parent', 'frames']) {
    bridge.install(global, key, global, hidden)
  }

  bridge.install(global, 'globalThis', global, hidden)

  // Window state.
  bridge.install(global, 'name', '', { enumerable: true, configurable: true, writable: true })
  bridge.install(global, 'closed', false, hidden)
  bridge.install(global, 'opener', null, hidden)
  bridge.install(global, 'frameElement', null, hidden)
  bridge.install(global, 'length', 0, hidden)
  bridge.install(global, 'isSecureContext', true, hidden)
  bridge.install(global, 'crossOriginIsolated', false, hidden)
  bridge.install(global, 'origin', profile.origin, hidden)
  bridge.install(global, 'event', undefined, hidden)
  bridge.install(global, 'clientInformation', undefined, hidden)

  // Viewport / geometry. These must agree with `screen` and `devicePixelRatio`.
  for (const [key, value] of Object.entries({
    devicePixelRatio: profile.screen.devicePixelRatio,
    innerWidth: profile.window.innerWidth,
    innerHeight: profile.window.innerHeight,
    outerWidth: profile.window.outerWidth,
    outerHeight: profile.window.outerHeight,
    screenX: profile.window.screenX,
    screenY: profile.window.screenY,
    screenLeft: profile.window.screenX,
    screenTop: profile.window.screenY,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
  })) {
    bridge.install(global, key, value, { enumerable: true, configurable: true, writable: false })
  }

  // Window methods that have no interesting behaviour but whose absence is a
  // VM tell.
  const noop = (name, length = 0) => bridge.fn(name, length, () => ctx.undefined)
  for (const name of ['focus', 'blur', 'close', 'stop', 'print']) {
    bridge.install(global, name, noop(name), { enumerable: true, configurable: true, writable: true })
  }

  bridge.install(
    global,
    'alert',
    bridge.fn('alert', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'window.alert', message: bridge.str(args, 0) })
      clockTick(bridge)
      return ctx.undefined
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'confirm',
    bridge.fn('confirm', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'window.confirm', message: bridge.str(args, 0) })
      clockTick(bridge)
      return ctx.false
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'prompt',
    bridge.fn('prompt', 2, ({ args }) => {
      bridge.emit('api', 'before', { api: 'window.prompt', message: bridge.str(args, 0) })
      clockTick(bridge)
      return ctx.null
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'open',
    bridge.fn('open', 3, ({ args }) => {
      const url = bridge.str(args, 0)
      bridge.emit('api', 'before', { api: 'window.open', url })
      if (url) bridge.reportIOC('url', url)
      clockTick(bridge)
      return ctx.null
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  for (const [name, arity] of [
    ['scrollTo', 2],
    ['scrollBy', 2],
    ['moveTo', 2],
    ['resizeTo', 2],
    ['postMessage', 2],
  ]) {
    bridge.install(global, name, noop(name, arity), { enumerable: true, configurable: true, writable: true })
  }

  bridge.install(
    global,
    'matchMedia',
    bridge.fn('matchMedia', 1, ({ args }) => {
      const media = bridge.str(args, 0)
      bridge.emit('api', 'before', { api: 'window.matchMedia', media })
      const list = bridge.obj({
        matches: evaluateMediaQuery(media, profile),
        media,
        onchange: null,
      })
      bridge.install(list, 'addListener', bridge.fn('addListener', 1, () => ctx.undefined), hidden)
      bridge.install(list, 'removeListener', bridge.fn('removeListener', 1, () => ctx.undefined), hidden)
      bridge.install(list, 'addEventListener', bridge.fn('addEventListener', 2, () => ctx.undefined), hidden)
      bridge.install(list, 'removeEventListener', bridge.fn('removeEventListener', 2, () => ctx.undefined), hidden)
      bridge.install(list, 'dispatchEvent', bridge.fn('dispatchEvent', 1, () => ctx.true), hidden)
      return list
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'getSelection',
    bridge.fn('getSelection', 0, () => {
      const selection = bridge.obj({
        anchorNode: null,
        anchorOffset: 0,
        focusNode: null,
        focusOffset: 0,
        isCollapsed: true,
        rangeCount: 0,
        type: 'None',
      })
      bridge.install(selection, 'toString', bridge.fn('toString', 0, () => bridge.str([], 0, '')), hidden)
      bridge.install(selection, 'removeAllRanges', bridge.fn('removeAllRanges', 0, () => ctx.undefined), hidden)
      return selection
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  // Window prototype chain, so `window instanceof Window` and
  // `Object.prototype.toString.call(window) === '[object Window]'` hold.
  if (stealth) {
    const Window = stealth.evalShim(
      `(function(){
        function Window() {}
        var proto = Window.prototype;
        Object.defineProperty(proto, Symbol.toStringTag, { value: 'Window', configurable: true });
        Object.setPrototypeOf(globalThis, proto);
        return Window;
      })()`,
      'Window',
    )
    bridge.install(global, 'Window', Window, { enumerable: false, configurable: true, writable: true })
    Window.dispose()
    // QuickJS tags its global object as `[object global]`; browsers report
    // `[object Window]`. An own Symbol.toStringTag on the global object yields
    // the browser string without touching Object.prototype.toString.
    const tag = ctx.evalCode(
      "Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window', configurable: true })",
      'ai4r-internal:window-tag',
    )
    if (tag.error) tag.error.dispose()
    else tag.value.dispose()
  }
}

function clockTick(bridge) {
  bridge.clock?.tick?.(1)
}

/**
 * Minimal but honest media-query evaluation for the queries samples actually
 * ask: width/height bounds, orientation, prefers-color-scheme and
 * prefers-reduced-motion. Comma-separated alternatives match if any matches.
 * @param {string} query
 * @param {object} profile
 */
function evaluateMediaQuery(query, profile) {
  const alternatives = String(query ?? '').split(',')
  for (const alternative of alternatives) {
    if (matchesSingleQuery(alternative.trim(), profile)) return true
  }
  return false
}

function matchesSingleQuery(query, profile) {
  if (!query) return false
  const width = profile.window.innerWidth
  const height = profile.window.innerHeight
  const rules = query.matchAll(/\(([^)]+)\)/g)
  let sawRule = false
  for (const match of rules) {
    sawRule = true
    const rule = match[1].trim().toLowerCase()
    const numeric = /^(min|max)-(width|height)\s*:\s*(-?[\d.]+)px$/.exec(rule)
    if (numeric) {
      const value = Number(numeric[3])
      const actual = numeric[2] === 'width' ? width : height
      if (numeric[1] === 'min' && actual < value) return false
      if (numeric[1] === 'max' && actual > value) return false
      continue
    }
    const orientation = /^orientation\s*:\s*(portrait|landscape)$/.exec(rule)
    if (orientation) {
      const actual = height >= width ? 'portrait' : 'landscape'
      if (orientation[1] !== actual) return false
      continue
    }
    const scheme = /^prefers-color-scheme\s*:\s*(dark|light)$/.exec(rule)
    if (scheme) {
      if (scheme[1] !== 'light') return false
      continue
    }
    const motion = /^prefers-reduced-motion\s*:\s*(no-preference|reduce)$/.exec(rule)
    if (motion) {
      if (motion[1] !== 'no-preference') return false
      continue
    }
    return false
  }
  return sawRule ? true : false
}
