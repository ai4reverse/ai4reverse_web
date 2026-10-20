/**
 * Device Fingerprint SDK — stable, privacy-aware device identity.
 *
 * Components are collected through injectable probes (browser defaults are used
 * when available), normalised, hashed and combined with weights. The resulting
 * ID is stable across sessions for the same device and tolerant to volatile
 * components (viewport, battery), which are down-weighted rather than dropped.
 */
export const VERSION = '1.0.0'

export const DEFAULT_WEIGHTS = Object.freeze({
  platform: 3,
  userAgent: 3,
  hardwareConcurrency: 2,
  deviceMemory: 2,
  timezone: 2,
  languages: 1,
  screen: 1,
  pixelRatio: 1,
  webgl: 2,
  fonts: 2,
  touch: 1,
  viewport: 0.5,
})

export function defaultProbes() {
  const nav = typeof navigator === 'object' ? navigator : {}
  const screenValue = typeof screen === 'object' ? screen : {}
  return {
    platform: () => nav.platform || 'unknown',
    userAgent: () => nav.userAgent || 'unknown',
    hardwareConcurrency: () => nav.hardwareConcurrency || 0,
    deviceMemory: () => nav.deviceMemory || 0,
    timezone: () => (typeof Date === 'function' ? new Date().getTimezoneOffset() : 0),
    languages: () => (nav.languages || [nav.language || '']).join(','),
    screen: () => `${screenValue.width || 0}x${screenValue.height || 0}x${screenValue.colorDepth || 0}`,
    pixelRatio: () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1),
    webgl: () => 'unavailable',
    fonts: () => 'default',
    touch: () => nav.maxTouchPoints || 0,
    viewport: () => `${globalThis.innerWidth || 0}x${globalThis.innerHeight || 0}`,
  }
}

function normalize(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim().toLowerCase()
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * @param {Record<string, () => unknown>} [probes]
 * @param {{weights?: Record<string, number>, salt?: string}} [options]
 */
export function createFingerprint(probes = defaultProbes(), options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) }
  const salt = options.salt ?? 'device-fingerprint-v1'
  const components = {}
  const hashes = {}
  let quality = 0
  let weightTotal = 0

  for (const [key, probe] of Object.entries(probes)) {
    let value
    try {
      value = normalize(probe())
    } catch {
      value = ''
    }
    components[key] = value
    hashes[key] = value ? fnv1a(`${salt}|${key}|${value}`) : ''
    const weight = weights[key] ?? 1
    weightTotal += weight
    if (value && value !== 'unknown' && value !== 'unavailable' && value !== 'default') quality += weight
  }

  // Volatile components (weight < 1) contribute to similarity/quality but not
  // to the stable identity, so a viewport resize does not rotate the device id.
  const material = Object.keys(hashes)
    .filter((key) => (weights[key] ?? 1) >= 1)
    .sort()
    .map((key) => `${key}:${hashes[key]}`)
    .join('|')
  return {
    version: VERSION,
    id: fnv1a(`${salt}|${material}`),
    components,
    hashes,
    quality: weightTotal > 0 ? Number((quality / weightTotal).toFixed(3)) : 0,
  }
}

/** Weighted similarity in [0,1]; volatile components contribute less. */
export function similarity(a, b, weights = DEFAULT_WEIGHTS) {
  if (!a?.hashes || !b?.hashes) return 0
  let score = 0
  let total = 0
  for (const key of new Set([...Object.keys(a.hashes), ...Object.keys(b.hashes)])) {
    const weight = weights[key] ?? 1
    total += weight
    if (a.hashes[key] && a.hashes[key] === b.hashes[key]) score += weight
  }
  return total === 0 ? 0 : Number((score / total).toFixed(3))
}

export function isSameDevice(a, b, threshold = 0.9) {
  return similarity(a, b) >= threshold
}

export function toJSON(fingerprint) {
  return JSON.stringify({
    version: fingerprint.version,
    id: fingerprint.id,
    quality: fingerprint.quality,
    hashes: fingerprint.hashes,
  })
}

export function fromJSON(text) {
  const parsed = JSON.parse(text)
  if (!parsed.id || !parsed.hashes) throw new Error('invalid fingerprint JSON')
  return parsed
}
