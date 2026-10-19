/**
 * Detection probe.
 *
 * The guard never reads a global directly: it asks the probe for a surface and
 * receives `undefined` when the surface (or the read itself) fails. That keeps
 * every signal total — a detector cannot throw because the environment is
 * hostile — and makes the whole subsystem unit-testable against synthetic
 * environments without touching real globals.
 *
 * `scope` is `globalThis` in production and a plain object in tests.
 */

/** @param {unknown} value @returns {string} */
export function brand(value) {
  try {
    return Object.prototype.toString.call(value)
  } catch {
    return '[object Unknown]'
  }
}

/**
 * @param {object} [scope]
 */
export function createProbe(scope) {
  const root = scope ?? (typeof globalThis !== 'undefined' ? globalThis : {})
  /** @param {string} name */
  function get(name) {
    try {
      return root[name]
    } catch {
      return undefined
    }
  }
  /** @param {string} name */
  function has(name) {
    try {
      return name in root && root[name] !== undefined
    } catch {
      return false
    }
  }
  const document = get('document')
  const navigator = get('navigator') ?? {}
  const screen = get('screen') ?? {}
  const location = get('location') ?? {}
  const performance = get('performance') ?? {}

  /** @param {Function} fn @param {unknown} fallback */
  function safe(fn, fallback) {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  /** @param {unknown} object @param {string} key */
  function describe(object, key) {
    if (object === undefined || object === null) return undefined
    try {
      return Object.getOwnPropertyDescriptor(object, key)
    } catch {
      return undefined
    }
  }

  return {
    scope: root,
    get,
    has,
    safe,
    describe,
    brand,
    document,
    navigator,
    screen,
    location,
    performance,
    window: get('window') ?? root,
    // Frequently used surfaces, resolved once so a getter cannot change value
    // between two signals and produce a false inconsistency.
    globals: {
      Object: get('Object'),
      Function: get('Function'),
      Array: get('Array'),
      String: get('String'),
      Number: get('Number'),
      Math: get('Math'),
      Date: get('Date'),
      RegExp: get('RegExp'),
      Error: get('Error'),
      Promise: get('Promise'),
      Symbol: get('Symbol'),
      Map: get('Map'),
      WeakMap: get('WeakMap'),
      Set: get('Set'),
      Reflect: get('Reflect'),
      Proxy: get('Proxy'),
      JSON: get('JSON'),
      Intl: get('Intl'),
      CSS: get('CSS'),
      crypto: get('crypto'),
      performance: get('performance'),
      console: get('console'),
      Navigator: get('Navigator'),
      Window: get('Window'),
      HTMLElement: get('HTMLElement'),
      Node: get('Node'),
      Element: get('Element'),
      Text: get('Text'),
      Event: get('Event'),
      MouseEvent: get('MouseEvent'),
      KeyboardEvent: get('KeyboardEvent'),
      CSSStyleDeclaration: get('CSSStyleDeclaration'),
      HTMLCanvasElement: get('HTMLCanvasElement'),
      WebGLRenderingContext: get('WebGLRenderingContext'),
      AudioContext: get('AudioContext'),
      OfflineAudioContext: get('OfflineAudioContext'),
      Notification: get('Notification'),
      history: get('history'),
      localStorage: get('localStorage'),
      sessionStorage: get('sessionStorage'),
      matchMedia: get('matchMedia'),
      getComputedStyle: get('getComputedStyle'),
      requestAnimationFrame: get('requestAnimationFrame'),
      queueMicrotask: get('queueMicrotask'),
      chrome: get('chrome'),
      setTimeout: get('setTimeout'),
      addEventListener: get('addEventListener'),
    },
  }
}

/**
 * Read a nested property without throwing.
 * @param {() => any} read
 * @param {any} [fallback]
 */
export function read(read, fallback) {
  try {
    const value = read()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}
