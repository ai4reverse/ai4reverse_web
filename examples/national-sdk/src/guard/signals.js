/**
 * Signal catalogue — zero trust, defence in depth.
 *
 * Every signal is an *independent* observation with an explicit layer and
 * weight. No signal is trusted on its own: the policy combines them, requires
 * corroboration for anything less than a proof, and reports coverage so a
 * quiet environment (many `unknown`s) cannot masquerade as a clean one.
 *
 * Layers:
 *   L1 engine      — ECMAScript invariants and native branding
 *   L2 dom         — DOM/HTML invariants (including document.all)
 *   L3 rendering   — canvas/WebGL/fonts/media queries
 *   L4 entropy     — clocks, timers, PRNG and crypto surfaces
 *   L5 consistency — user agent vs platform vs locale vs timezone vs geometry
 *   L6 automation  — webdriver, headless markers, branding gaps
 *
 * A `proof` signal is one whose failure cannot occur in a real browser (for
 * example `typeof document.all`). Proofs are reported separately and are not
 * averaged away.
 */

import { probeDocumentAll } from './document-all.js'
import { brand, read } from './probe.js'

const NATIVE = '[native code]'

/** @param {string} detail @param {unknown} [value] */
const pass = (detail, value) => ({ status: 'pass', detail, value })
/** @param {string} detail @param {unknown} [value] */
const fail = (detail, value) => ({ status: 'fail', detail, value })
/** @param {string} detail */
const unknown = (detail) => ({ status: 'unknown', detail })

/**
 * @param {() => {status: string, detail: string}} fn
 */
function guarded(fn) {
  try {
    return fn()
  } catch (error) {
    return unknown(`threw: ${error && error.message ? error.message : String(error)}`)
  }
}

/** @param {string} ua */
export function parseUserAgent(ua) {
  const text = String(ua ?? '')
  return {
    text,
    windows: /Windows NT/i.test(text),
    macos: /Macintosh|Mac OS X/i.test(text) && !/iPhone|iPad|iPod/i.test(text),
    ios: /iPhone|iPad|iPod/i.test(text),
    android: /Android/i.test(text),
    chromeos: /CrOS/i.test(text),
    linux: /Linux/i.test(text) && !/Android/i.test(text) && !/CrOS/i.test(text),
    chromium: /Chromium\//i.test(text),
    edge: /Edg\//i.test(text),
    opera: /OPR\//i.test(text),
    chrome: /Chrome\//i.test(text) && !/Chromium\//i.test(text) && !/Edg\//i.test(text) && !/OPR\//i.test(text),
    firefox: /Firefox\//i.test(text),
    safari: /Safari\//i.test(text) && !/Chrome\//i.test(text) && !/Chromium\//i.test(text),
    headless: /Headless|PhantomJS|SlimerJS|Electron/i.test(text),
  }
}

/**
 * @param {{windows: boolean, macos: boolean, ios: boolean, android: boolean, chromeos: boolean, linux: boolean, chrome: boolean, chromium: boolean, edge: boolean, firefox: boolean, safari: boolean}} ua
 * @returns {'chromium'|'firefox'|'safari'|'unknown'}
 */
function engineFamily(ua) {
  if (ua.chrome || ua.chromium || ua.edge) return 'chromium'
  if (ua.firefox) return 'firefox'
  if (ua.safari) return 'safari'
  return 'unknown'
}

/** Expected UTC offsets (minutes, as `getTimezoneOffset` reports them). */
const ZONE_OFFSETS = {
  'Asia/Shanghai': [-480],
  'Asia/Chongqing': [-480],
  'Asia/Hong_Kong': [-480],
  'Asia/Taipei': [-480],
  'Asia/Singapore': [-480],
  'Asia/Tokyo': [-540],
  'Asia/Seoul': [-540],
  'Asia/Kolkata': [-330],
  'Asia/Calcutta': [-330],
  'Asia/Dubai': [-240],
  'Asia/Bangkok': [-420],
  'Europe/London': [0, -60],
  'Europe/Dublin': [0, -60],
  'Europe/Lisbon': [0, -60],
  'Europe/Berlin': [-60, -120],
  'Europe/Paris': [-60, -120],
  'Europe/Madrid': [-60, -120],
  'Europe/Rome': [-60, -120],
  'Europe/Amsterdam': [-60, -120],
  'Europe/Moscow': [-180],
  'America/New_York': [300, 240],
  'America/Chicago': [360, 300],
  'America/Denver': [420, 360],
  'America/Phoenix': [420],
  'America/Los_Angeles': [480, 420],
  'America/Vancouver': [480, 420],
  'America/Sao_Paulo': [180],
  'America/Mexico_City': [360, 300],
  'Australia/Sydney': [-600, -660],
  'Australia/Melbourne': [-600, -660],
  UTC: [0],
  'Etc/UTC': [0],
  'Etc/GMT': [0],
}

/**
 * @param {ReturnType<typeof import('./probe.js').createProbe>} probe
 * @returns {Array<object>}
 */
export function buildSignals(probe) {
  const g = probe.globals
  const nav = probe.navigator ?? {}
  const win = probe.window ?? {}
  const ua = read(() => String(nav.userAgent ?? ''), '')
  const parsed = parseUserAgent(ua)
  const family = engineFamily(parsed)

  /** @type {Array<{id: string, layer: string, weight: number, critical?: boolean, proof?: boolean, description: string, run: Function}>} */
  const signals = []
  const add = (id, layer, weight, description, run, options = {}) => {
    signals.push({ id, layer, weight, description, run, ...options })
  }

  // ---------------------------------------------------------------- L1 engine
  add('engine-native-branding', 'L1-engine', 12, 'builtin functions still stringify as native code', () =>
    guarded(() => {
      const toString = read(() => Function.prototype.toString, null)
      if (!toString) return fail('Function.prototype.toString missing')
      const samples = [
        ['Array.prototype.push', read(() => Array.prototype.push, null)],
        ['Object.keys', read(() => Object.keys, null)],
        ['String.prototype.replace', read(() => String.prototype.replace, null)],
        ['JSON.stringify', read(() => JSON.stringify, null)],
        ['addEventListener', read(() => probe.get('addEventListener'), null)],
      ]
      const broken = []
      for (const [name, fn] of samples) {
        if (typeof fn !== 'function') {
          broken.push(`${name}:not-a-function`)
          continue
        }
        const source = read(() => toString.call(fn), '')
        if (!source.includes(NATIVE)) broken.push(`${name}:not-native`)
      }
      return broken.length === 0 ? pass('all sampled builtins are native') : fail(broken.join(', '))
    }),
    { critical: true },
  )

  add('engine-primitive-invariants', 'L1-engine', 10, 'ECMAScript primitive and coercion invariants', () =>
    guarded(() => {
      const checks = {
        'empty-array-string': read(() => [] + [], null) === '',
        'object-brand': read(() => Object.prototype.toString.call({}), null) === '[object Object]',
        'null-brand': read(() => Object.prototype.toString.call(null), null) === '[object Null]',
        'float-precision': read(() => 0.1 + 0.2, 0) !== 0.3,
        'max-empty': read(() => Math.max(), 0) === -Infinity,
        'infinity': read(() => 1 / 0, 0) === Infinity,
        'json-undefined': read(() => JSON.stringify({ a: undefined }), '') === '{}',
        'string-index': read(() => 'abc'[1], '') === 'b',
        'arguments-length': read(() => (function () { return arguments.length })(1, 2), 0) === 2,
        'array-length': read(() => [1, 2, 3].length, 0) === 3,
        'nan-number': Number.isNaN(Number('3px')),
      }
      const broken = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
      return broken.length === 0 ? pass('all invariants hold') : fail(`broken: ${broken.join(', ')}`)
    }),
  )

  add('engine-function-arity', 'L1-engine', 6, 'native function arity table', () =>
    guarded(() => {
      const expected = [
        ['Array.prototype.push', read(() => Array.prototype.push, null), 1],
        ['Array.prototype.slice', read(() => Array.prototype.slice, null), 2],
        ['Object.keys', read(() => Object.keys, null), 1],
        ['Object.defineProperty', read(() => Object.defineProperty, null), 3],
        ['String.prototype.replace', read(() => String.prototype.replace, null), 2],
        ['Function.prototype.apply', read(() => Function.prototype.apply, null), 2],
        ['Function.prototype.call', read(() => Function.prototype.call, null), 1],
      ]
      const broken = []
      for (const [name, fn, length] of expected) {
        if (typeof fn !== 'function') {
          broken.push(`${name}:missing`)
          continue
        }
        if (fn.length !== length) broken.push(`${name}:${fn.length}!=${length}`)
      }
      return broken.length === 0 ? pass('arity table matches') : fail(broken.join(', '))
    }),
  )

  add('engine-navigator-brand', 'L1-engine', 6, 'navigator carries the Navigator brand', () =>
    guarded(() => {
      const tag = brand(nav)
      return tag === '[object Navigator]' ? pass(tag) : fail(`brand is ${tag}`)
    }),
  )

  add('engine-window-brand', 'L1-engine', 6, 'window carries the Window brand', () =>
    guarded(() => {
      const tag = brand(win)
      const instance = read(() => win instanceof g.Window, false)
      return tag === '[object Window]' && instance ? pass(`${tag}, instanceof Window`) : fail(`brand ${tag}, instanceof=${instance}`)
    }),
  )

  add('engine-error-stack', 'L1-engine', 6, 'error stacks look like a browser engine', () =>
    guarded(() => {
      const stack = read(() => new Error('probe').stack, '')
      if (typeof stack !== 'string' || stack.length < 10) return fail('no usable stack')
      if (/quickjs|node:internal|at \/Users\/|file:\/\//i.test(stack)) return fail(`engine marker in stack: ${stack.split('\n')[1] ?? ''}`)
      return /at\s|@/.test(stack) ? pass('stack contains frames') : fail('stack has no frames')
    }),
  )

  add('engine-descriptor-surface', 'L1-engine', 4, 'window property descriptors are real accessors', () =>
    guarded(() => {
      const descriptor = probe.describe(win, 'innerWidth') ?? probe.describe(win, 'document')
      if (!descriptor) return fail('no descriptor for innerWidth/document')
      return pass('descriptor present')
    }),
  )

  // ------------------------------------------------------------------- L2 DOM
  add('dom-document-all', 'L2-dom', 18, 'document.all HTMLAllCollection/IsHTMLDDA invariants', () =>
    guarded(() => {
      const result = probeDocumentAll(probe)
      return result.status === 'pass' ? pass(result.detail, result.checks) : fail(result.detail, result.checks)
    }),
    { critical: true, proof: true },
  )

  add('dom-collections', 'L2-dom', 6, 'HTMLCollection surfaces are coherent', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return fail('no document')
      const missing = []
      for (const name of ['scripts', 'forms', 'images', 'links', 'anchors', 'styleSheets']) {
        const collection = read(() => doc[name], undefined)
        if (collection === undefined) missing.push(`${name}:missing`)
        else if (typeof read(() => collection.length, 'x') !== 'number') missing.push(`${name}:no-length`)
      }
      const list = read(() => doc.querySelectorAll('*'), undefined)
      if (!list || typeof list.length !== 'number') missing.push('querySelectorAll:invalid')
      return missing.length === 0 ? pass('collections and NodeList present') : fail(missing.join(', '))
    }),
  )

  add('dom-node-prototypes', 'L2-dom', 5, 'document/body/element prototype chain', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return fail('no document')
      const checks = {
        document: read(() => g.Node && g.Node.prototype.isPrototypeOf(doc), false),
        body: read(() => g.HTMLElement && g.HTMLElement.prototype.isPrototypeOf(doc.body), false),
        element: read(() => {
          const element = doc.createElement('div')
          return g.Element && g.Element.prototype.isPrototypeOf(element) && element.tagName === 'DIV'
        }, false),
        text: read(() => {
          const node = doc.createTextNode('x')
          return g.Text && g.Text.prototype.isPrototypeOf(node) && node.data === 'x'
        }, false),
      }
      const broken = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
      return broken.length === 0 ? pass('prototype chain coherent') : fail(`broken: ${broken.join(', ')}`)
    }),
  )

  add('dom-event-constructors', 'L2-dom', 5, 'event constructors behave', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return fail('no document')
      const event = read(() => new (probe.get('Event'))('x'), null)
      if (!event || event.type !== 'x' || event.bubbles !== false) return fail('Event constructor mismatch')
      const mouse = read(() => new (probe.get('MouseEvent'))('click', { clientX: 7 }), null)
      if (!mouse || mouse.type !== 'click' || mouse.clientX !== 7) return fail('MouseEvent constructor mismatch')
      return pass('Event/MouseEvent coherent')
    }),
  )

  add('dom-computed-style', 'L2-dom', 5, 'getComputedStyle returns a CSSStyleDeclaration', () =>
    guarded(() => {
      const getter = probe.globals.getComputedStyle
      const doc = probe.document
      if (typeof getter !== 'function' || !doc) return fail('getComputedStyle missing')
      const style = read(() => getter.call(probe.scope, doc.documentElement), null)
      if (!style) return fail('null style')
      const value = read(() => style.getPropertyValue('display'), '')
      const brandTag = brand(style)
      return brandTag === '[object CSSStyleDeclaration]' && typeof value === 'string'
        ? pass(`${brandTag}, display=${value}`)
        : fail(`brand ${brandTag}, display=${value}`)
    }),
  )

  add('dom-document-state', 'L2-dom', 4, 'readyState/visibility/cookie surfaces', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return fail('no document')
      const ready = read(() => doc.readyState, '')
      const visibility = read(() => doc.visibilityState, '')
      const cookie = read(() => typeof doc.cookie, 'missing')
      const hidden = read(() => typeof doc.hidden, 'missing')
      const problems = []
      if (!['loading', 'interactive', 'complete'].includes(ready)) problems.push(`readyState=${ready}`)
      if (!['visible', 'hidden', 'prerender'].includes(visibility)) problems.push(`visibilityState=${visibility}`)
      if (cookie !== 'string') problems.push(`cookie=${cookie}`)
      if (hidden !== 'boolean') problems.push(`hidden=${hidden}`)
      return problems.length === 0 ? pass('document state coherent') : fail(problems.join(', '))
    }),
  )

  add('dom-location-history', 'L2-dom', 3, 'location/history surfaces', () =>
    guarded(() => {
      const protocol = read(() => String(probe.location.protocol), '')
      const length = read(() => probe.globals.history?.length, -1)
      const problems = []
      if (!['http:', 'https:', 'file:', 'blob:', 'about:', 'chrome-extension:'].includes(protocol)) problems.push(`protocol=${protocol}`)
      if (!(typeof length === 'number' && length >= 1)) problems.push(`history.length=${length}`)
      return problems.length === 0 ? pass('location/history coherent') : fail(problems.join(', '))
    }),
  )

  // ------------------------------------------------------------- L3 rendering
  add('render-canvas-2d', 'L3-rendering', 7, '2D canvas context and PNG encoding', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return fail('no document')
      const canvas = read(() => doc.createElement('canvas'), null)
      if (!canvas) return fail('cannot create canvas')
      canvas.width = 32
      canvas.height = 16
      const context = read(() => canvas.getContext('2d'), null)
      if (!context) return fail('no 2d context')
      read(() => {
        context.fillStyle = '#123456'
        context.fillRect(0, 0, 32, 16)
        context.fillStyle = '#abcdef'
        context.fillRect(3, 4, 7, 5)
      })
      const url = read(() => canvas.toDataURL(), '')
      const pixels = read(() => context.getImageData(0, 0, 32, 16).data, null)
      const problems = []
      if (!url.startsWith('data:image/png')) problems.push('toDataURL is not PNG')
      if (!pixels) problems.push('getImageData unavailable')
      return problems.length === 0 ? pass(`png ${url.length} bytes, pixels ${pixels.length}`) : fail(problems.join(', '))
    }),
  )

  add('render-canvas-entropy', 'L3-rendering', 3, 'canvas pixels are not a constant fill', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return unknown('no document')
      const canvas = read(() => doc.createElement('canvas'), null)
      const context = read(() => canvas?.getContext('2d'), null)
      if (!context) return unknown('no 2d context')
      canvas.width = 8
      canvas.height = 8
      read(() => {
        context.fillStyle = 'red'
        context.fillRect(0, 0, 8, 8)
        context.fillStyle = 'blue'
        context.fillRect(1, 1, 2, 2)
      })
      const data = read(() => context.getImageData(0, 0, 8, 8).data, null)
      if (!data) return unknown('no pixels')
      const unique = new Set()
      for (let index = 0; index < data.length; index += 1) unique.add(data[index])
      return unique.size > 1 ? pass(`${unique.size} distinct channel values`) : fail('canvas is a uniform fill')
    }),
  )

  add('render-webgl', 'L3-rendering', 7, 'WebGL context and vendor/renderer strings', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc) return fail('no document')
      const canvas = read(() => doc.createElement('canvas'), null)
      if (!canvas) return fail('cannot create canvas')
      const gl = read(() => canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl'), null)
      if (!gl) return fail('no WebGL context')
      const vendor = read(() => String(gl.getParameter(gl.VENDOR)), '')
      const renderer = read(() => String(gl.getParameter(gl.RENDERER)), '')
      const version = read(() => String(gl.getParameter(gl.VERSION)), '')
      if (!vendor || !renderer || !version) return fail(`vendor=${vendor || '∅'} renderer=${renderer || '∅'} version=${version || '∅'}`)
      const extension = read(() => gl.getExtension('WEBGL_debug_renderer_info'), null)
      const unmasked = extension ? read(() => String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)), '') : ''
      return pass(`vendor=${vendor}, renderer=${renderer}${unmasked ? `, unmasked=${unmasked}` : ''}`)
    }),
  )

  add('render-media-queries', 'L3-rendering', 5, 'matchMedia resolves core queries', () =>
    guarded(() => {
      const matchMedia = probe.globals.matchMedia
      if (typeof matchMedia !== 'function') return fail('matchMedia missing')
      const zero = read(() => matchMedia.call(probe.scope, '(min-width: 0px)'), null)
      const screenQuery = read(() => matchMedia.call(probe.scope, 'screen'), null)
      if (!zero || !screenQuery) return fail('matchMedia returned nothing')
      const problems = []
      if (zero.matches !== true) problems.push('(min-width: 0px) is false')
      if (screenQuery.matches !== true) problems.push('screen is false')
      if (typeof zero.media !== 'string' || zero.media.length === 0) problems.push('no media string')
      return problems.length === 0 ? pass('media queries resolve') : fail(problems.join(', '))
    }),
  )

  add('render-css-support', 'L3-rendering', 4, 'CSS.supports answers core features', () =>
    guarded(() => {
      const CSS = g.CSS
      if (!CSS || typeof CSS.supports !== 'function') return fail('CSS.supports missing')
      const grid = read(() => CSS.supports('display', 'grid'), null)
      const color = read(() => CSS.supports('color', '#000'), null)
      const nonsense = read(() => CSS.supports('display', 'definitely-not-a-display'), true)
      const problems = []
      if (grid !== true) problems.push('grid unsupported')
      if (color !== true) problems.push('color unsupported')
      if (nonsense !== false) problems.push('invalid value accepted')
      return problems.length === 0 ? pass('display:grid and color supported') : fail(problems.join(', '))
    }),
  )

  add('render-font-metrics', 'L3-rendering', 4, 'text measurement distinguishes font families', () =>
    guarded(() => {
      const doc = probe.document
      if (!doc || !doc.body) return unknown('no body')
      const measure = (family) => {
        const span = doc.createElement('span')
        span.style.fontFamily = family
        span.style.fontSize = '32px'
        span.style.position = 'absolute'
        span.textContent = 'mmmmmmmmmmlli WwQq'
        doc.body.appendChild(span)
        const width = read(() => span.offsetWidth, 0)
        read(() => doc.body.removeChild(span))
        return width
      }
      const monospace = measure('monospace')
      const serif = measure('serif')
      const sans = measure('sans-serif')
      if (!monospace && !serif && !sans) return unknown('layout engine reports zero widths')
      return monospace !== serif || serif !== sans ? pass(`metrics ${monospace}/${serif}/${sans}`) : fail(`identical widths ${monospace}/${serif}/${sans}`)
    }),
  )

  add('render-audio', 'L3-rendering', 5, 'Web Audio sample-rate surface', () =>
    guarded(() => {
      const workers = [g.AudioContext, probe.get('webkitAudioContext'), g.OfflineAudioContext, probe.get('webkitOfflineAudioContext')]
      const Ctor = workers.find((candidate) => typeof candidate === 'function')
      if (!Ctor) return fail('no Web Audio constructor')
      const context = read(() => new Ctor(1, 1, 44100), null)
      const sampleRate = read(() => context.sampleRate, 0)
      read(() => context.close?.())
      return sampleRate === 44100 ? pass('sampleRate 44100') : fail(`sampleRate=${sampleRate}`)
    }),
  )

  add('render-device-pixel-ratio', 'L3-rendering', 3, 'devicePixelRatio is plausible', () =>
    guarded(() => {
      const ratio = read(() => Number(win.devicePixelRatio), 0)
      return Number.isFinite(ratio) && ratio > 0 && ratio <= 8 ? pass(`dpr=${ratio}`) : fail(`dpr=${ratio}`)
    }),
  )

  // --------------------------------------------------------------- L4 entropy
  add('entropy-crypto', 'L4-entropy', 6, 'crypto.getRandomValues produces changing bytes', () =>
    guarded(() => {
      const cryptoObject = g.crypto
      if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') return fail('crypto.getRandomValues missing')
      const first = new Uint8Array(32)
      const second = new Uint8Array(32)
      cryptoObject.getRandomValues(first)
      cryptoObject.getRandomValues(second)
      if (first.every((value) => value === 0) || second.every((value) => value === 0)) return fail('all-zero entropy')
      return first.some((value, index) => value !== second[index]) ? pass('two draws differ') : fail('two draws are identical')
    }),
  )

  add('entropy-subtle', 'L4-entropy', 4, 'crypto.subtle exists in a secure context', () =>
    guarded(() => {
      const secure = read(() => win.isSecureContext, true)
      const subtle = read(() => g.crypto?.subtle, null)
      if (!secure) return unknown('not a secure context')
      if (!subtle || typeof subtle.digest !== 'function') return fail('crypto.subtle.digest missing')
      return pass('subtle.digest present')
    }),
  )

  add('entropy-math-random', 'L4-entropy', 3, 'Math.random is not constant', () =>
    guarded(() => {
      const values = Array.from({ length: 6 }, () => read(() => Math.random(), 0.5))
      return new Set(values).size > 1 ? pass('draws vary') : fail('Math.random is constant')
    }),
  )

  add('entropy-performance-clock', 'L4-entropy', 6, 'performance.now/timeOrigin are coherent', () =>
    guarded(() => {
      const performance = g.performance
      if (!performance || typeof performance.now !== 'function') return fail('performance.now missing')
      const first = performance.now()
      let spin = 0
      for (let index = 0; index < 20000; index += 1) spin += index % 7
      const second = performance.now()
      const origin = read(() => Number(performance.timeOrigin), NaN)
      const wall = read(() => Number(g.Date.now()), NaN)
      const problems = []
      if (!(second >= first)) problems.push(`not monotonic (${first} -> ${second})`)
      if (second === first && spin >= 0) problems.push('clock did not advance during a busy loop')
      if (!Number.isFinite(origin)) problems.push('no timeOrigin')
      else if (Number.isFinite(wall) && Math.abs(wall - origin) > 86_400_000 * 2) problems.push('timeOrigin far from wall clock')
      return problems.length === 0 ? pass(`advanced ${(second - first).toFixed(2)}ms`) : fail(problems.join(', '))
    }),
  )

  add('entropy-date-invariants', 'L4-entropy', 5, 'Date epoch and timezone offset invariants', () =>
    guarded(() => {
      const DateCtor = g.Date
      if (typeof DateCtor !== 'function') return fail('Date missing')
      const problems = []
      if (new DateCtor(0).getUTCFullYear() !== 1970) problems.push('epoch year wrong')
      if (!Number.isNaN(DateCtor.parse('invalid-date'))) problems.push('invalid date parsed')
      if (DateCtor.parse('1970-01-01T00:00:00.000Z') !== 0) problems.push('ISO parse mismatch')
      const offset = new DateCtor().getTimezoneOffset()
      if (!Number.isFinite(offset) || offset % 15 !== 0 || offset < -840 || offset > 840) problems.push(`offset=${offset}`)
      if (read(() => String(new DateCtor(NaN)), '') !== 'Invalid Date') problems.push('NaN date string')
      return problems.length === 0 ? pass(`offset=${offset}`) : fail(problems.join(', '))
    }),
  )

  add('entropy-intl-number', 'L4-entropy', 4, 'Intl.NumberFormat uses locale rules', () =>
    guarded(() => {
      const Intl = g.Intl
      if (!Intl || typeof Intl.NumberFormat !== 'function') return fail('Intl.NumberFormat missing')
      const german = read(() => new Intl.NumberFormat('de-DE').format(1234.5), '')
      const english = read(() => new Intl.NumberFormat('en-US').format(1234.5), '')
      const problems = []
      if (!german.includes('.') || !german.includes(',')) problems.push(`de-DE=${german}`)
      if (!english.includes(',') || !english.includes('.')) problems.push(`en-US=${english}`)
      if (german === english) problems.push('locales produce identical output')
      return problems.length === 0 ? pass(`de-DE=${german}`) : fail(problems.join(', '))
    }),
  )

  add('entropy-timer-surface', 'L4-entropy', 3, 'timer and microtask APIs exist', () =>
    guarded(() => {
      const problems = []
      if (typeof probe.globals.setTimeout !== 'function') problems.push('setTimeout missing')
      if (typeof probe.globals.setTimeout === 'function' && probe.globals.setTimeout.length !== 1) problems.push(`setTimeout.length=${probe.globals.setTimeout.length}`)
      if (typeof probe.globals.requestAnimationFrame !== 'function') problems.push('requestAnimationFrame missing')
      if (typeof probe.globals.queueMicrotask !== 'function') problems.push('queueMicrotask missing')
      return problems.length === 0 ? pass('timer surfaces present') : fail(problems.join(', '))
    }),
  )

  // ------------------------------------------------------------ L5 consistency
  add('consistency-user-agent-platform', 'L5-consistency', 8, 'UA operating system matches navigator.platform', () =>
    guarded(() => {
      const platform = read(() => String(nav.platform ?? ''), '')
      if (!ua) return fail('no user agent')
      if (!platform) return fail('no navigator.platform')
      const problems = []
      if (parsed.windows && !/^Win/i.test(platform)) problems.push(`Windows UA with platform ${platform}`)
      if (parsed.macos && !/^Mac/i.test(platform)) problems.push(`macOS UA with platform ${platform}`)
      if (parsed.linux && !/^Linux/i.test(platform)) problems.push(`Linux UA with platform ${platform}`)
      if (parsed.chromeos && !/^Linux/i.test(platform)) problems.push(`ChromeOS UA with platform ${platform}`)
      if (parsed.android && !/Linux|Android/i.test(platform)) problems.push(`Android UA with platform ${platform}`)
      if (parsed.ios && !/iPhone|iPad|iPod|MacIntel/i.test(platform)) problems.push(`iOS UA with platform ${platform}`)
      if (!parsed.windows && !parsed.macos && !parsed.linux && !parsed.chromeos && !parsed.android && !parsed.ios) {
        return unknown(`unrecognised UA: ${ua.slice(0, 40)}`)
      }
      return problems.length === 0 ? pass(`platform=${platform}`) : fail(problems.join(', '))
    }),
  )

  add('consistency-browser-branding', 'L5-consistency', 7, 'browser-specific surfaces agree with the UA family', () =>
    guarded(() => {
      const chrome = probe.globals.chrome
      const hasChrome = chrome !== undefined && chrome !== null
      const data = read(() => nav.userAgentData, null)
      const vendor = read(() => String(nav.vendor ?? ''), '')
      const capture = read(() => typeof g.Error.captureStackTrace, 'missing')
      const problems = []
      if (family === 'chromium') {
        if (!hasChrome) problems.push('Chromium UA without window.chrome')
        if (!data || !Array.isArray(data.brands)) problems.push('Chromium UA without userAgentData.brands')
        if (!vendor.includes('Google')) problems.push(`vendor=${vendor}`)
        if (capture !== 'function') problems.push('V8 engine without Error.captureStackTrace')
      } else if (family === 'firefox') {
        if (hasChrome) problems.push('Firefox UA with window.chrome')
        if (data) problems.push('Firefox UA with userAgentData')
        if (capture !== 'undefined' && capture !== 'missing') problems.push('SpiderMonkey with Error.captureStackTrace')
      } else if (family === 'safari') {
        if (hasChrome) problems.push('Safari UA with window.chrome')
        if (capture !== 'undefined' && capture !== 'missing') problems.push('JSC with Error.captureStackTrace')
      } else {
        return unknown('unknown browser family')
      }
      return problems.length === 0 ? pass(`${family} surfaces coherent`) : fail(problems.join(', '))
    }),
  )

  add('consistency-locale', 'L5-consistency', 5, 'language list is coherent with navigator.language', () =>
    guarded(() => {
      const language = read(() => String(nav.language ?? ''), '')
      const languages = read(() => nav.languages, null)
      if (!language) return fail('no navigator.language')
      if (!languages || typeof languages.length !== 'number' || languages.length === 0) return fail('no navigator.languages')
      const problems = []
      if (!/^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(language)) problems.push(`language=${language}`)
      if (!Array.from(languages).includes(language) && !Array.from(languages).some((entry) => String(entry).startsWith(language.split('-')[0]))) {
        problems.push(`languages=${Array.from(languages).join(',')} missing ${language}`)
      }
      return problems.length === 0 ? pass(`${language} / ${Array.from(languages).join(',')}`) : fail(problems.join(', '))
    }),
  )

  add('consistency-timezone', 'L5-consistency', 7, 'Intl timezone agrees with the Date offset', () =>
    guarded(() => {
      const Intl = g.Intl
      if (!Intl || typeof Intl.DateTimeFormat !== 'function') return fail('Intl.DateTimeFormat missing')
      const zone = read(() => String(Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''), '')
      if (!zone) return fail('no resolved timezone')
      const expected = ZONE_OFFSETS[zone]
      const actual = read(() => new g.Date().getTimezoneOffset(), NaN)
      if (!expected) return unknown(`unknown zone ${zone}, offset ${actual}`)
      if (!Number.isFinite(actual)) return fail('no numeric timezone offset')
      const matches = expected.some((candidate) => Math.abs(candidate - actual) <= 90)
      return matches ? pass(`${zone} offset ${actual}`) : fail(`${zone} expects ${expected.join('/')}, got ${actual}`)
    }),
  )

  add('consistency-screen-geometry', 'L5-consistency', 6, 'screen and window geometry are ordered', () =>
    guarded(() => {
      const screen = probe.screen ?? {}
      const width = read(() => Number(screen.width), 0)
      const height = read(() => Number(screen.height), 0)
      const availWidth = read(() => Number(screen.availWidth), 0)
      const availHeight = read(() => Number(screen.availHeight), 0)
      const innerWidth = read(() => Number(win.innerWidth), 0)
      const innerHeight = read(() => Number(win.innerHeight), 0)
      const outerWidth = read(() => Number(win.outerWidth), 0)
      const outerHeight = read(() => Number(win.outerHeight), 0)
      const problems = []
      if (!(width >= 640 && height >= 480)) problems.push(`screen ${width}x${height}`)
      if (availWidth > width || availHeight > height) problems.push('avail exceeds screen')
      if (innerWidth <= 0 || innerHeight <= 0) problems.push(`inner ${innerWidth}x${innerHeight}`)
      if (innerWidth > width + 64) problems.push(`innerWidth ${innerWidth} > screen ${width}`)
      if (outerWidth > 0 && outerWidth < innerWidth) problems.push('outerWidth < innerWidth')
      if (outerHeight > 0 && outerHeight < innerHeight) problems.push('outerHeight < innerHeight')
      return problems.length === 0 ? pass(`${width}x${height} / inner ${innerWidth}x${innerHeight}`) : fail(problems.join(', '))
    }),
  )

  add('consistency-hardware', 'L5-consistency', 6, 'hardwareConcurrency/deviceMemory/maxTouchPoints are plausible', () =>
    guarded(() => {
      const cores = read(() => Number(nav.hardwareConcurrency), 0)
      const memory = read(() => nav.deviceMemory, undefined)
      const touch = read(() => Number(nav.maxTouchPoints), -1)
      const problems = []
      if (!(cores >= 1 && cores <= 256)) problems.push(`hardwareConcurrency=${cores}`)
      if (memory !== undefined && !(Number(memory) >= 0.25 && Number(memory) <= 1024)) problems.push(`deviceMemory=${memory}`)
      if (family === 'chromium' && memory === undefined) problems.push('deviceMemory missing')
      if (!(touch >= 0 && touch <= 64)) problems.push(`maxTouchPoints=${touch}`)
      if ((parsed.android || parsed.ios) && touch < 1) problems.push('mobile UA without touch points')
      if (parsed.windows && family === 'chromium' && memory === undefined) problems.push('desktop Chrome without deviceMemory')
      if (family === 'safari' && touch < 0) problems.push('Safari without maxTouchPoints')
      return problems.length === 0 ? pass(`cores=${cores}, memory=${memory}, touch=${touch}`) : fail(problems.join(', '))
    }),
  )

  add('consistency-storage', 'L5-consistency', 5, 'localStorage/sessionStorage are usable', () =>
    guarded(() => {
      const storage = probe.globals.localStorage
      if (!storage) return fail('localStorage missing')
      const key = '__nsdk_probe__'
      try {
        storage.setItem(key, '1')
        const value = storage.getItem(key)
        storage.removeItem(key)
        if (value !== '1') return fail('localStorage round trip failed')
      } catch (error) {
        return unknown(`storage threw: ${error && error.name ? error.name : error}`)
      }
      const session = probe.globals.sessionStorage
      if (!session) return fail('sessionStorage missing')
      return pass('storage round trip ok')
    }),
  )

  add('consistency-permissions', 'L5-consistency', 4, 'permissions and mediaDevices surfaces exist', () =>
    guarded(() => {
      const permissions = read(() => nav.permissions, null)
      const mediaDevices = read(() => nav.mediaDevices, null)
      const problems = []
      if (family === 'chromium' || family === 'firefox') {
        if (!permissions || typeof permissions.query !== 'function') problems.push('navigator.permissions.query missing')
        if (!mediaDevices) problems.push('navigator.mediaDevices missing')
      }
      return problems.length === 0 ? pass('permissions surfaces present') : fail(problems.join(', '))
    }),
  )

  // ------------------------------------------------------------ L6 automation
  add('automation-webdriver', 'L6-automation', 25, 'navigator.webdriver is not set', () =>
    guarded(() => {
      const value = read(() => nav.webdriver, undefined)
      if (value === true) return fail('navigator.webdriver === true')
      return pass(`webdriver=${value === undefined ? 'undefined' : value}`)
    }),
    { critical: true },
  )

  add('automation-headless-ua', 'L6-automation', 20, 'user agent does not advertise headless tooling', () =>
    guarded(() => {
      if (!ua) return fail('no user agent')
      return parsed.headless ? fail(`headless marker in UA: ${ua}`) : pass('no headless marker')
    }),
    { critical: true },
  )

  add('automation-window-chrome', 'L6-automation', 6, 'window chrome exists (non-zero outer size, browser UI gap)', () =>
    guarded(() => {
      const outerWidth = read(() => Number(win.outerWidth), 0)
      const outerHeight = read(() => Number(win.outerHeight), 0)
      const innerHeight = read(() => Number(win.innerHeight), 0)
      if (outerWidth <= 0 || outerHeight <= 0) return fail(`outer ${outerWidth}x${outerHeight}`)
      const gap = outerHeight - innerHeight
      if (parsed.mobile) return gap >= 0 ? pass(`gap ${gap}`) : fail('mobile negative chrome gap')
      return gap >= 40 ? pass(`chrome gap ${gap}px`) : fail(`chrome gap ${gap}px`)
    }),
  )

  add('automation-plugin-surface', 'L6-automation', 5, 'plugin/mimeType arrays look like a desktop browser', () =>
    guarded(() => {
      const plugins = read(() => nav.plugins, null)
      if (!plugins || typeof plugins.length !== 'number') return fail('navigator.plugins missing')
      if (parsed.mobile) return pass('mobile may expose no plugins')
      if (family === 'chromium' && plugins.length === 0) return fail('desktop Chromium with zero plugins')
      return pass(`plugins=${plugins.length}`)
    }),
  )

  add('automation-permission-state', 'L6-automation', 3, 'Notification.permission is a real value', () =>
    guarded(() => {
      const Notification = g.Notification
      if (!Notification) return unknown('Notification missing')
      const permission = read(() => Notification.permission, '')
      return ['default', 'granted', 'denied'].includes(permission) ? pass(`permission=${permission}`) : fail(`permission=${permission}`)
    }),
  )

  add('automation-screen-depth', 'L6-automation', 4, 'screen colour depth is a real display', () =>
    guarded(() => {
      const depth = read(() => Number(probe.screen?.colorDepth), 0)
      const pixel = read(() => Number(probe.screen?.pixelDepth), 0)
      return depth >= 24 && pixel >= 24 ? pass(`depth=${depth}/${pixel}`) : fail(`colorDepth=${depth}, pixelDepth=${pixel}`)
    }),
  )

  add('automation-pdf-viewer', 'L6-automation', 3, 'Chrome exposes pdfViewerEnabled', () =>
    guarded(() => {
      if (family !== 'chromium') return unknown('not Chromium')
      const flag = read(() => nav.pdfViewerEnabled, undefined)
      return typeof flag === 'boolean' ? pass(`pdfViewerEnabled=${flag}`) : fail(`pdfViewerEnabled=${flag}`)
    }),
  )

  add('automation-is-secure-context', 'L6-automation', 3, 'isSecureContext agrees with the origin scheme', () =>
    guarded(() => {
      const protocol = read(() => String(probe.location.protocol), '')
      const secure = read(() => win.isSecureContext, undefined)
      if (typeof secure !== 'boolean') return fail('isSecureContext is not boolean')
      if (protocol === 'https:' && secure !== true) return fail('https origin without secure context')
      if (protocol === 'http:' && secure === true && !/^localhost|^127\./.test(read(() => String(probe.location.hostname), ''))) {
        return fail('insecure origin marked secure')
      }
      return pass(`protocol=${protocol}, secure=${secure}`)
    }),
  )

  return signals
}
