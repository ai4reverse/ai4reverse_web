/**
 * Small deterministic PRNG utilities.
 *
 * Every non-deterministic surface of the sandbox (Math.random, time jitter,
 * canvas noise, ids) is derived from a single seed so that repeat runs of the
 * same sample produce byte-identical observations. That determinism is a
 * requirement: an analyst must be able to reproduce a trace, and malware that
 * seeds behaviour from Math.random must not be able to observe host entropy.
 */

/** @param {number|string} seed */
export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0
  const text = String(seed ?? '')
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/**
 * mulberry32: fast, small state, good enough for behavioural determinism.
 * @param {number|string} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = hashSeed(seed)
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @typedef {object} SeededRandom
 * @property {() => number} next float in [0,1)
 * @property {(min:number, max:number) => number} int inclusive
 * @property {<T>(items: T[]) => T} pick
 * @property {(n:number) => string} hex
 * @property {() => string} uuid
 * @property {(bytes:number) => Uint8Array} bytes
 */

/**
 * @param {number|string} seed
 * @returns {SeededRandom}
 */
export function createSeededRandom(seed) {
  const next = mulberry32(seed)
  const random = {
    next,
    int(min, max) {
      if (max < min) [min, max] = [max, min]
      return min + Math.floor(next() * (max - min + 1))
    },
    pick(items) {
      if (!items || items.length === 0) return undefined
      return items[Math.floor(next() * items.length)]
    },
    hex(length) {
      let out = ''
      for (let i = 0; i < length; i += 1) out += Math.floor(next() * 16).toString(16)
      return out
    },
    uuid() {
      const hex = (n) => random.hex(n)
      const variant = (8 + Math.floor(next() * 4)).toString(16)
      return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
    },
    bytes(length) {
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i += 1) out[i] = Math.floor(next() * 256)
      return out
    },
  }
  return random
}

/**
 * Deterministic choice of one value out of a list for a given seed + label.
 * @template T
 * @param {T[]} items
 * @param {string|number} seed
 * @param {string} label
 * @returns {T}
 */
export function seededPick(items, seed, label) {
  if (!items || items.length === 0) return undefined
  const rng = createSeededRandom(`${seed}::${label}`)
  return items[Math.floor(rng.next() * items.length)]
}
