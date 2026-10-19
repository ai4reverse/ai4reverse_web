/**
 * Fingerprint collectors.
 *
 * The fingerprint is a *device-identity* claim, not a tracker: every field is
 * collected through the probe, tagged with a stability class, and canonicalised
 * deterministically. The device token is derived from the stable subset only,
 * so resizing a window or toggling a media preference does not change identity.
 *
 * Collectors degrade to `null`/`'unavailable'` instead of throwing. A missing
 * surface is itself useful: the guard can treat a browser without WebGL as
 * suspicious, while the fingerprint records the gap explicitly.
 */

import { brand } from '../guard/probe.js'
import { sm3 } from '../core/hash.js'
import { toHex, utf8ToBytes } from '../core/bytes.js'

/** @typedef {'hardware'|'software'|'session'} Stability */

export const STABILITY = Object.freeze({
  ua: 'software',
  uaBrands: 'software',
  platform: 'hardware',
  vendor: 'hardware',
  languages: 'software',
  language: 'software',
  timezone: 'hardware',
  timezoneOffset: 'hardware',
  screen: 'hardware',
  dpr: 'hardware',
  window: 'session',
  hardware: 'hardware',
  plugins: 'software',
  mimeTypes: 'software',
  canvas: 'hardware',
  webgl: 'hardware',
  fonts: 'software',
  audio: 'hardware',
  math: 'software',
  intl: 'software',
  codecs: 'software',
  css: 'software',
  storage: 'software',
  cookieEnabled: 'software',
  doNotTrack: 'software',
  webdriver: 'session',
  pdfViewerEnabled: 'software',
  colorGamut: 'software',
  reducedMotion: 'session',
  errors: 'software',
  navigatorBrand: 'software',
})

/** @param {() => any} read @param {any} fallback */
function safe(read, fallback) {
  try {
    const value = read()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** @param {unknown} value @returns {string} */
function digestOf(value) {
  const bytes = typeof value === 'string' ? utf8ToBytes(value) : utf8ToBytes(JSON.stringify(value))
  return toHex(sm3(bytes)).slice(0, 32)
}

/**
 * @param {ReturnType<typeof import('../guard/probe.js').createProbe>} probe
 * @returns {{fields: object, coverage: number, stability: Record<string, string>}}
 */
export function collectFingerprint(probe) {
  const nav = probe.navigator ?? {}
  const screen = probe.screen ?? {}
  const win = probe.window ?? {}
  const g = probe.globals
  const fields = {}
  let collected = 0
  let attempted = 0

  /** @param {string} key @param {() => any} collector @param {any} [fallback] */
  const collect = (key, collector, fallback = null) => {
    attempted += 1
    const value = safe(collector, fallback)
    fields[key] = value
    if (value !== null && value !== 'unavailable' && value !== undefined) collected += 1
  }

  collect('ua', () => String(nav.userAgent ?? ''), '')
  collect('uaBrands', () => {
    const data = nav.userAgentData
    if (!data) return null
    return {
      brands: safe(() => Array.from(data.brands, (entry) => `${entry.brand}/${entry.version}`).sort(), []),
      mobile: safe(() => data.mobile, null),
      platform: safe(() => data.platform, null),
    }
  })
  collect('platform', () => String(nav.platform ?? ''), '')
  collect('vendor', () => String(nav.vendor ?? ''), '')
  collect('languages', () => Array.from(nav.languages ?? [], String))
  collect('language', () => String(nav.language ?? ''), '')
  collect('timezone', () => safe(() => String(g.Intl.DateTimeFormat().resolvedOptions().timeZone), 'unavailable'))
  collect('timezoneOffset', () => safe(() => Number(new g.Date().getTimezoneOffset()), null))
  collect('screen', () => ({
    width: safe(() => Number(screen.width), 0),
    height: safe(() => Number(screen.height), 0),
    availWidth: safe(() => Number(screen.availWidth), 0),
    availHeight: safe(() => Number(screen.availHeight), 0),
    colorDepth: safe(() => Number(screen.colorDepth), 0),
    pixelDepth: safe(() => Number(screen.pixelDepth), 0),
    orientation: safe(() => String(screen.orientation?.type ?? ''), ''),
  }))
  collect('dpr', () => safe(() => Number(win.devicePixelRatio), 0))
  collect('window', () => ({
    innerWidth: safe(() => Number(win.innerWidth), 0),
    innerHeight: safe(() => Number(win.innerHeight), 0),
    outerWidth: safe(() => Number(win.outerWidth), 0),
    outerHeight: safe(() => Number(win.outerHeight), 0),
  }))
  collect('hardware', () => ({
    cores: safe(() => Number(nav.hardwareConcurrency), 0),
    memory: safe(() => (nav.deviceMemory === undefined ? null : Number(nav.deviceMemory)), null),
    touch: safe(() => Number(nav.maxTouchPoints), null),
  }))
  collect('plugins', () => safe(() => Array.from(nav.plugins ?? [], (plugin) => String(plugin.name)).sort(), []))
  collect('mimeTypes', () => safe(() => Number(nav.mimeTypes?.length ?? -1), -1))

  collect('canvas', () => canvasFingerprint(probe))
  collect('webgl', () => webglFingerprint(probe))
  collect('fonts', () => fontFingerprint(probe))
  collect('audio', () => audioFingerprint(probe))
  collect('math', () => mathFingerprint())
  collect('intl', () => ({
    zone: safe(() => String(g.Intl.DateTimeFormat().resolvedOptions().timeZone), 'unavailable'),
    locale: safe(() => String(g.Intl.DateTimeFormat().resolvedOptions().locale), 'unavailable'),
    de: safe(() => new g.Intl.NumberFormat('de-DE').format(1234567.891), 'unavailable'),
    en: safe(() => new g.Intl.NumberFormat('en-US').format(1234567.891), 'unavailable'),
    date: safe(() => new g.Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(new g.Date(0)), 'unavailable'),
  }))
  collect('codecs', () => {
    const video = safe(() => probe.document?.createElement('video'), null)
    const audio = safe(() => probe.document?.createElement('audio'), null)
    const probeType = (element, type) => safe(() => (element ? String(element.canPlayType(type)) : 'unavailable'), 'unavailable')
    return {
      h264: probeType(video, 'video/mp4; codecs="avc1.42E01E"'),
      hevc: probeType(video, 'video/mp4; codecs="hvc1.1.6.L93.B0"'),
      vp9: probeType(video, 'video/webm; codecs="vp9"'),
      av1: probeType(video, 'video/mp4; codecs="av01.0.05M.08"'),
      aac: probeType(audio, 'audio/mp4; codecs="mp4a.40.2"'),
      opus: probeType(audio, 'audio/ogg; codecs="opus"'),
    }
  })
  collect('css', () => {
    const CSS = g.CSS
    const matchMedia = g.matchMedia
    return {
      grid: safe(() => CSS.supports('display', 'grid'), 'unavailable'),
      flex: safe(() => CSS.supports('display', 'flex'), 'unavailable'),
      container: safe(() => CSS.supports('container-type', 'inline-size'), 'unavailable'),
      dark: safe(() => matchMedia.call(probe.scope, '(prefers-color-scheme: dark)').matches, 'unavailable'),
      hover: safe(() => matchMedia.call(probe.scope, '(hover: hover)').matches, 'unavailable'),
    }
  })
  collect('storage', () => ({
    local: Boolean(g.localStorage),
    session: Boolean(g.sessionStorage),
  }))
  collect('cookieEnabled', () => safe(() => Boolean(nav.cookieEnabled), null))
  collect('doNotTrack', () => safe(() => (nav.doNotTrack === undefined ? null : String(nav.doNotTrack)), null))
  collect('webdriver', () => safe(() => (nav.webdriver === undefined ? null : Boolean(nav.webdriver)), null))
  collect('pdfViewerEnabled', () => safe(() => (nav.pdfViewerEnabled === undefined ? null : Boolean(nav.pdfViewerEnabled)), null))
  collect('colorGamut', () => safe(() => {
    const match = g.matchMedia.call(probe.scope, '(color-gamut: p3)')
    return match.matches ? 'p3' : 'srgb'
  }, 'unavailable'))
  collect('reducedMotion', () => safe(() => g.matchMedia.call(probe.scope, '(prefers-reduced-motion: reduce)').matches, null))
  collect('errors', () => safe(() => {
    const stack = String(new g.Error('fingerprint').stack ?? '')
    return stack
      .split('\n')
      .slice(1, 4)
      .map((line) => line.replace(/[0-9]+/g, 'N').replace(/https?:\/\/[^\s)]+/g, 'URL'))
      .join('|')
  }, 'unavailable'))
  collect('navigatorBrand', () => brand(nav))

  return {
    fields,
    coverage: attempted === 0 ? 0 : Number((collected / attempted).toFixed(3)),
    stability: { ...STABILITY },
  }
}

/** @param {ReturnType<typeof import('../guard/probe.js').createProbe>} probe */
function canvasFingerprint(probe) {
  const doc = probe.document
  if (!doc) return 'unavailable'
  const canvas = safe(() => doc.createElement('canvas'), null)
  if (!canvas) return 'unavailable'
  canvas.width = 240
  canvas.height = 60
  const context = safe(() => canvas.getContext('2d'), null)
  if (!context) return 'unavailable'
  safe(() => {
    context.textBaseline = 'top'
    context.font = '14px "Arial"'
    context.fillStyle = '#f60'
    context.fillRect(0, 0, 240, 60)
    context.fillStyle = '#069'
    context.fillText('NSDK fingerprint \u{1f510} 0123456789', 4, 8)
    const gradient = context.createLinearGradient(0, 0, 240, 0)
    gradient.addColorStop(0, 'rgba(102,204,0,0.7)')
    gradient.addColorStop(1, 'rgba(255,0,255,0.4)')
    context.fillStyle = gradient
    context.fillRect(4, 30, 220, 20)
    context.beginPath()
    context.arc(200, 12, 8, 0, Math.PI * 2, true)
    context.fillStyle = '#0f0'
    context.fill()
  })
  const url = safe(() => String(canvas.toDataURL()), 'unavailable')
  const pixels = safe(() => context.getImageData(0, 0, 240, 60).data, null)
  let pixelHash = ''
  if (pixels) {
    const sample = []
    for (let index = 0; index < pixels.length; index += 97) sample.push(pixels[index])
    pixelHash = digestOf(sample)
  }
  return { image: digestOf(url), pixels: pixelHash, width: 240, height: 60 }
}

/** @param {ReturnType<typeof import('../guard/probe.js').createProbe>} probe */
function webglFingerprint(probe) {
  const doc = probe.document
  if (!doc) return 'unavailable'
  const canvas = safe(() => doc.createElement('canvas'), null)
  if (!canvas) return 'unavailable'
  const gl = safe(() => canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl'), null)
  if (!gl) return 'unavailable'
  const vendor = safe(() => String(gl.getParameter(gl.VENDOR)), '')
  const renderer = safe(() => String(gl.getParameter(gl.RENDERER)), '')
  const version = safe(() => String(gl.getParameter(gl.VERSION)), '')
  const parameters = {}
  for (const name of ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE', 'RED_BITS', 'GREEN_BITS', 'BLUE_BITS', 'ALPHA_BITS', 'DEPTH_BITS', 'STENCIL_BITS', 'SAMPLES']) {
    const constant = safe(() => gl[name], undefined)
    if (constant === undefined) continue
    parameters[name] = safe(() => {
      const value = gl.getParameter(constant)
      return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
    }, '')
  }
  const extensions = safe(() => Array.from(gl.getSupportedExtensions?.() ?? [], String).sort(), [])
  const extension = safe(() => gl.getExtension('WEBGL_debug_renderer_info'), null)
  const unmasked = extension
    ? {
        vendor: safe(() => String(gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)), ''),
        renderer: safe(() => String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)), ''),
      }
    : null
  return {
    vendor,
    renderer,
    version,
    unmasked,
    parameters,
    extensionsHash: digestOf(extensions),
    hash: digestOf({ vendor, renderer, version, parameters, unmasked }),
  }
}

/** @param {ReturnType<typeof import('../guard/probe.js').createProbe>} probe */
function fontFingerprint(probe) {
  const doc = probe.document
  if (!doc || !doc.body) return 'unavailable'
  const candidates = [
    'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana',
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'SimSun', 'Noto Sans CJK SC',
    'Roboto', 'Ubuntu', 'Helvetica Neue', 'Menlo', 'Consolas',
  ]
  const detected = []
  const widths = {}
  const measure = (family) => {
    const span = doc.createElement('span')
    span.style.fontFamily = `"${family}", monospace`
    span.style.fontSize = '24px'
    span.style.position = 'absolute'
    span.style.visibility = 'hidden'
    span.textContent = 'mmmmmmmmmwwwwwWWWQq@#0123456789'
    doc.body.appendChild(span)
    const width = safe(() => span.offsetWidth, 0)
    safe(() => doc.body.removeChild(span))
    return width
  }
  const baseline = measure('__nsdk_missing_font__')
  for (const family of candidates) {
    const width = measure(family)
    widths[family] = width
    if (width !== baseline) detected.push(family)
  }
  if (Object.values(widths).every((width) => width === 0)) return 'unavailable'
  return { detected, baseline, hash: digestOf(widths) }
}

/** @param {ReturnType<typeof import('../guard/probe.js').createProbe>} probe */
function audioFingerprint(probe) {
  const g = probe.globals
  const Ctor = [g.OfflineAudioContext, probe.get('webkitOfflineAudioContext')].find((value) => typeof value === 'function')
  if (!Ctor) return 'unavailable'
  const context = safe(() => new Ctor(1, 1, 44100), null)
  if (!context) return 'unavailable'
  const result = {
    sampleRate: safe(() => Number(context.sampleRate), 0),
    channels: safe(() => Number(context.destination?.channelCount), 0),
    baseLatency: safe(() => Number(context.baseLatency), 0),
  }
  safe(() => context.close?.())
  return { ...result, hash: digestOf(result) }
}

/** @returns {object} */
function mathFingerprint() {
  const labels = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'sqrt', 'sinh', 'cosh', 'pow']
  const values = {}
  for (const label of labels) {
    const value =
      label === 'pow'
        ? Math.pow(2.3, 7.1)
        : Math[label](label.startsWith('a') ? 0.5 : 1.1)
    values[label] = Number(value).toString()
  }
  return { values, hash: digestOf(values) }
}
