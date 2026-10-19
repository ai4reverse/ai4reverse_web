/**
 * Test fixtures shared by `verify.mjs` and the platform test suite.
 *
 * Two synthetic environments are provided:
 *
 *  - `emptyScope()`   — nothing at all: the guard must be maximally hostile.
 *  - `createFakeBrowser()` — a Chromium-shaped environment built from plain
 *    objects. It deliberately cannot pass the `document.all` invariant: the
 *    `[[IsHTMLDDA]]` internal slot cannot be created in ECMAScript, so `typeof`
 *    always reports `'object'` for a real object and `'undefined'` only for the
 *    primitive `undefined`. That is the point of using it as a proof signal.
 */

import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { TracelessSandbox } from '../../../tools/sandbox/sandbox.js'

/** @returns {object} */
export function emptyScope() {
  return {}
}

/**
 * @param {object} [overrides]
 * @returns {object} a scope object suitable for `createProbe`
 */
export function createFakeBrowser(overrides = {}) {
  const storage = new Map()
  class Navigator {
    constructor() {
      this.userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      this.platform = 'Win32'
      this.vendor = 'Google Inc.'
      this.language = 'zh-CN'
      this.languages = ['zh-CN', 'zh', 'en']
      this.hardwareConcurrency = 8
      this.deviceMemory = 8
      this.maxTouchPoints = 0
      this.webdriver = false
      this.pdfViewerEnabled = true
      this.cookieEnabled = true
      this.doNotTrack = null
      this.plugins = [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }]
      this.mimeTypes = { length: 2 }
      this.permissions = { query: () => Promise.resolve({ state: 'prompt' }) }
      this.mediaDevices = {}
      this.userAgentData = {
        brands: [
          { brand: 'Chromium', version: '126' },
          { brand: 'Google Chrome', version: '126' },
        ],
        mobile: false,
        platform: 'Windows',
      }
    }
  }
  Object.defineProperty(Navigator.prototype, Symbol.toStringTag, { value: 'Navigator', configurable: true })
  class Window {}
  Object.defineProperty(Window.prototype, Symbol.toStringTag, { value: 'Window', configurable: true })

  class HTMLElement {}
  class Element extends HTMLElement {}
  class Node {}
  class Text {
    constructor(data) {
      this.data = String(data)
    }
  }
  class Event {
    constructor(type, init = {}) {
      this.type = String(type)
      this.bubbles = Boolean(init.bubbles)
      this.defaultPrevented = false
    }
  }
  class MouseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init)
      this.clientX = init.clientX ?? 0
      this.clientY = init.clientY ?? 0
    }
  }
  class CSSStyleDeclaration {
    constructor(entries = {}) {
      Object.assign(this, entries)
    }
    getPropertyValue(name) {
      return this[name] ?? ''
    }
  }
  Object.defineProperty(CSSStyleDeclaration.prototype, Symbol.toStringTag, {
    value: 'CSSStyleDeclaration',
    configurable: true,
  })
  class HTMLAllCollection {
    get length() {
      return 3
    }
    item(index) {
      return index >= 0 && index < 3 ? {} : null
    }
    namedItem() {
      return null
    }
  }
  Object.defineProperty(HTMLAllCollection.prototype, Symbol.toStringTag, {
    value: 'HTMLAllCollection',
    configurable: true,
  })

  const canvasContext = {
    fillStyle: '#000',
    textBaseline: 'top',
    font: '10px sans-serif',
    fillRect() {},
    fillText() {},
    beginPath() {},
    arc() {},
    fill() {},
    createLinearGradient() {
      return { addColorStop() {} }
    },
    getImageData(x, y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4)
      for (let index = 0; index < data.length; index += 1) data[index] = (index * 37) & 0xff
      return { data, width, height }
    },
  }

  const webglConstants = {
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
    MAX_RENDERBUFFER_SIZE: 0x84e8,
    MAX_VIEWPORT_DIMS: 0x0d3a,
    ALIASED_LINE_WIDTH_RANGE: 0x846e,
    ALIASED_POINT_SIZE_RANGE: 0x846d,
    RED_BITS: 0x0d52,
    GREEN_BITS: 0x0d53,
    BLUE_BITS: 0x0d54,
    ALPHA_BITS: 0x0d55,
    DEPTH_BITS: 0x0d56,
    STENCIL_BITS: 0x0d57,
    SAMPLES: 0x80a9,
  }
  const webglValues = {
    0x1f00: 'WebKit WebGL',
    0x1f01: 'WebKit WebGL',
    0x1f02: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    0x8b8c: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    0x0d33: 16384,
    0x851c: 16384,
    0x84e8: 16384,
    0x0d3a: new Int32Array([16384, 16384]),
    0x846e: new Float32Array([1, 1]),
    0x846d: new Float32Array([1, 1024]),
    0x0d52: 8,
    0x0d53: 8,
    0x0d54: 8,
    0x0d55: 8,
    0x0d56: 24,
    0x0d57: 8,
    0x80a9: 4,
  }
  const webgl = {
    ...webglConstants,
    getParameter: (name) => webglValues[name] ?? 0,
    getExtension: (name) =>
      name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 }
        : null,
    getSupportedExtensions: () => ['ANGLE_instanced_arrays', 'WEBGL_debug_renderer_info'],
  }

  const makeElement = (tag = 'div') => {
    const element = new Element()
    element.tagName = String(tag).toUpperCase()
    element.style = new CSSStyleDeclaration({ fontFamily: '', fontSize: '', position: '', visibility: '' })
    element.dataset = {}
    element.children = []
    element.appendChild = (child) => {
      element.children.push(child)
      return child
    }
    element.removeChild = (child) => {
      const index = element.children.indexOf(child)
      if (index >= 0) element.children.splice(index, 1)
      return child
    }
    if (tag === 'canvas') {
      element.width = 300
      element.height = 150
      element.getContext = (kind) => {
        if (kind === '2d') return canvasContext
        if (kind === 'webgl' || kind === 'experimental-webgl') return webgl
        return null
      }
      element.toDataURL = () => `data:image/png;base64,${'A'.repeat(256)}`
    }
    if (tag === 'video' || tag === 'audio') {
      element.canPlayType = (type) =>
        /mp4|avc1|mp4a/.test(type) ? 'probably' : /webm|vp9|opus/.test(type) ? 'maybe' : ''
    }
    Object.defineProperty(element, 'offsetWidth', {
      get() {
        const family = String(element.style.fontFamily)
        if (family.includes('monospace')) return 120
        if (family.includes('serif') && !family.includes('sans')) return 110
        if (family.includes('sans')) return 115
        if (family.includes('__nsdk_missing_font__')) return 0
        return 112
      },
    })
    Object.defineProperty(element, 'offsetHeight', { get: () => 20 })
    return element
  }

  const documentElement = makeElement('html')
  const body = makeElement('body')
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    cookie: '',
    documentElement,
    body,
    head: makeElement('head'),
    all: new HTMLAllCollection(),
    scripts: { length: 1, item: () => null },
    forms: { length: 0, item: () => null },
    images: { length: 0, item: () => null },
    links: { length: 0, item: () => null },
    anchors: { length: 0, item: () => null },
    styleSheets: { length: 1, item: () => null },
    createElement: makeElement,
    createTextNode: (data) => new Text(data),
    querySelectorAll: () => ({ length: 3, item: () => makeElement() }),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  Object.setPrototypeOf(document, Node.prototype)
  Object.defineProperty(document, Symbol.toStringTag, { value: 'HTMLDocument', configurable: true })

  const mediaQuery = (media) => ({
    media,
    matches: true,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  })

  const scope = {
    Object,
    Function,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    Promise,
    Symbol,
    Map,
    WeakMap,
    Set,
    Reflect,
    Proxy,
    JSON,
    Intl,
    Uint8Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    Navigator,
    Window,
    HTMLElement,
    Element,
    Node,
    Text,
    Event,
    MouseEvent,
    CSSStyleDeclaration,
    navigator: new Navigator(),
    document,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: { type: 'landscape-primary' },
    },
    location: { protocol: 'https:', hostname: 'app.example.test', href: 'https://app.example.test/' },
    history: { length: 2 },
    performance: globalThis.performance,
    crypto: globalThis.crypto,
    console: globalThis.console,
    chrome: { runtime: {}, csi: () => ({}), loadTimes: () => ({}) },
    Notification: { permission: 'default' },
    CSS: {
      supports: (property, value) => {
        const table = {
          display: ['grid', 'flex', 'block'],
          color: ['#000', 'red'],
          'container-type': ['inline-size'],
        }
        return Boolean(table[property]?.includes(value))
      },
    },
    matchMedia: mediaQuery,
    getComputedStyle: () => new CSSStyleDeclaration({ display: 'block', color: 'rgb(0, 0, 0)' }),
    requestAnimationFrame: (callback) => setTimeout(() => callback(16), 16),
    cancelAnimationFrame: () => {},
    queueMicrotask: globalThis.queueMicrotask,
    setTimeout: Object.defineProperty((callback, delay) => setTimeout(callback, delay), 'length', { value: 1 }),
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    removeEventListener: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    localStorage: {
      getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
      setItem: (key, value) => storage.set(String(key), String(value)),
      removeItem: (key) => storage.delete(String(key)),
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    outerHeight: 900,
    devicePixelRatio: 1,
    isSecureContext: true,
    screenX: 0,
    screenY: 0,
    ...overrides,
  }
  Object.setPrototypeOf(scope, Window.prototype)
  Object.defineProperty(scope, Symbol.toStringTag, { value: 'Window', configurable: true })
  return scope
}

/**
 * Run a bundle in a host `node:vm` context (fast smoke test).
 * @param {string} code
 * @param {object} [extraGlobals]
 */
export function runBundleInNodeVm(code, extraGlobals = {}) {
  const sandbox = {
    console: globalThis.console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: globalThis.performance,
    Promise,
    Proxy,
    Reflect,
    Symbol,
    Map,
    Set,
    WeakMap,
    ArrayBuffer,
    Uint8Array,
    Uint32Array,
    DataView,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    Date,
    Math,
    JSON,
    Intl,
    ...extraGlobals,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(code, context, { timeout: 60_000, filename: 'nsdk-bundle.js' })
  return context
}

/**
 * Run a built bundle in the platform's QuickJS sandbox and return the JSON
 * payload the guest logs in chunks. Code instrumentation is disabled: wrapping
 * every statement of a 700 KB obfuscated bundle is itself a denial of service.
 *
 * @param {{code: string, serverPublicKey: string, request: object, seed?: number}} options
 */
export async function runBundleInSandbox(options) {
  const chunkSize = 1500
  const request = JSON.stringify(options.request)
  const guest = `
;(function () {
  var sdk = NSDK.create(${JSON.stringify({ serverPublicKey: options.serverPublicKey })});
  var out = sdk.sign(${request}, { sealBody: true });
  var guard = sdk.guard();
  var docAll = null;
  for (var i = 0; i < guard.signals.length; i += 1) {
    if (guard.signals[i].id === 'dom-document-all') docAll = guard.signals[i];
  }
  var payload = JSON.stringify({
    meta: NSDK.meta,
    kid: sdk.keyId,
    publicKey: sdk.publicKey,
    token: sdk.token,
    headers: out.headers,
    body: out.body,
    layers: out.layers,
    guard: {
      level: guard.level,
      score: guard.score,
      token: guard.token,
      confidence: guard.confidence,
      evidence: guard.evidence.map(function (entry) { return entry.id; }),
      documentAll: docAll
    },
    selfTest: sdk.selfTest(),
    fingerprintCoverage: sdk.fingerprint().coverage,
    storage: sdk.storage,
    vm: sdk.vm
  });
  for (var offset = 0; offset < payload.length; offset += ${chunkSize}) {
    console.log(payload.slice(offset, offset + ${chunkSize}));
  }
})();
`
  const sandbox = await TracelessSandbox.create({
    seed: options.seed ?? 0x5eed,
    limits: { timeoutMs: 60_000, memoryBytes: 256 * 1024 * 1024 },
    logLevel: 'silent',
  })
  try {
    const run = await sandbox.run(options.code + guest, {
      filename: 'https://cdn.example.test/nsdk.js',
      instrumentation: { code: { level: 'off' } },
    })
    if (!run.ok) throw new Error(`sandbox run failed: ${run.error?.message ?? 'unknown'}`)
    const chunks = run.events
      .filter((event) => event.kind === 'api' && event.api === 'console.log')
      .map((event) => String(event.text))
    const payload = chunks.join('')
    if (!payload) throw new Error('sandbox run produced no payload')
    return { result: JSON.parse(payload), events: run.events, disposal: run.disposal }
  } finally {
    sandbox.dispose()
  }
}

/** @param {string} file @returns {Promise<string>} */
export async function readBundle(file) {
  return readFile(file, 'utf8')
}

/**
 * Minimal assertion helpers so `verify.mjs` can report every check without a
 * test framework.
 * @param {unknown} condition
 * @param {string} message
 */
export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** @param {unknown} actual @param {unknown} expected @param {string} message */
export function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
