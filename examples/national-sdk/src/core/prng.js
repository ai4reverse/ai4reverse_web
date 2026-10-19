/**
 * Seeded PRNG ("DRBG").
 *
 * Every artifact the SDK produces — white-box encodings, table orderings,
 * layer plans, opcode permutations, nonces — is derived from one of these
 * generators. Two properties matter:
 *
 * 1. **Reproducibility.** A build seed must reproduce the same tables and the
 *    same obfuscation, otherwise the build pipeline cannot be verified.
 * 2. **Statistical quality.** The same generator also drives *session* entropy
 *    (fresh encodings per page load) and therefore must not show structure that
 *    a lattice or S-box analysis could exploit. The construction is a ChaCha20
 *    block generator, which is a standard CSPRNG design.
 */

import { u32LE, readU32LE, utf8ToBytes, toHex } from './bytes.js'

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]

/** @param {number} value @param {number} shift @returns {number} */
function rotl(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

/** @param {number[]} state @param {number} a @param {number} b @param {number} c @param {number} d */
function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0
  state[d] = rotl(state[d] ^ state[a], 16)
  state[c] = (state[c] + state[d]) >>> 0
  state[b] = rotl(state[b] ^ state[c], 12)
  state[a] = (state[a] + state[b]) >>> 0
  state[d] = rotl(state[d] ^ state[a], 8)
  state[c] = (state[c] + state[d]) >>> 0
  state[b] = rotl(state[b] ^ state[c], 7)
}

/**
 * @param {number[]} input sixteen 32-bit words
 * @returns {Uint8Array} 64 keystream bytes
 */
function chachaBlock(input) {
  const state = input.slice()
  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12)
    quarterRound(state, 1, 5, 9, 13)
    quarterRound(state, 2, 6, 10, 14)
    quarterRound(state, 3, 7, 11, 15)
    quarterRound(state, 0, 5, 10, 15)
    quarterRound(state, 1, 6, 11, 12)
    quarterRound(state, 2, 7, 8, 13)
    quarterRound(state, 3, 4, 9, 14)
  }
  const out = new Uint8Array(64)
  for (let index = 0; index < 16; index += 1) {
    out.set(u32LE((state[index] + input[index]) >>> 0), index * 4)
  }
  return out
}

/**
 * Derive a 32-byte key from arbitrary seed material. The domain string keeps
 * the generators of unrelated subsystems from sharing a stream.
 * @param {string|Uint8Array} seed
 * @param {string} [domain]
 * @returns {number[]} eight 32-bit key words
 */
function keyWords(seed, domain = 'nsdk') {
  const seedBytes = typeof seed === 'string' ? utf8ToBytes(`${domain}::${seed}`) : seed
  const words = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let cursor = 0
  // Absorb the seed material into the state with a simple sponge step; the
  // output is then run through two ChaCha blocks so key words are well mixed.
  for (const byte of seedBytes) {
    words[cursor % 8 + 4] = (words[cursor % 8 + 4] ^ (byte << ((cursor % 4) * 8))) >>> 0
    cursor += 1
    if (cursor % 16 === 0) {
      const mixed = chachaBlock(words)
      for (let index = 0; index < 16; index += 1) words[index] = readU32LE(mixed, index * 4)
    }
  }
  const first = chachaBlock(words)
  const second = chachaBlock(Array.from({ length: 16 }, (_, index) => readU32LE(first, index * 4)))
  return Array.from({ length: 8 }, (_, index) => readU32LE(second, index * 4))
}

/**
 * A deterministic byte generator.
 * @param {string|Uint8Array} seed
 * @param {string} [domain]
 * @returns {{
 *   bytes(length: number): Uint8Array,
 *   word(): number,
 *   int(maxExclusive: number): number,
 *   hex(length: number): string,
 *   shuffle<T>(items: T[]): T[],
 *   pick<T>(items: T[]): T,
 *   fork(label: string): ReturnType<typeof createPrng>,
 *   reseed(label: string): void
 * }}
 */
export function createPrng(seed, domain = 'nsdk') {
  const key = keyWords(seed, domain)
  let counter = 0
  let buffer = new Uint8Array(0)
  let offset = 0

  function refill() {
    const state = new Array(16)
    for (let index = 0; index < 4; index += 1) state[index] = SIGMA[index]
    for (let index = 0; index < 8; index += 1) state[index + 4] = key[index]
    state[12] = counter & 0xffffffff
    state[13] = (counter / 0x100000000) & 0xffffffff
    state[14] = 0x9e3779b9
    state[15] = 0x85ebca6b
    counter += 1
    buffer = chachaBlock(state)
    offset = 0
  }

  const prng = {
    bytes(length) {
      const out = new Uint8Array(length)
      let written = 0
      while (written < length) {
        if (offset >= buffer.length) refill()
        const take = Math.min(length - written, buffer.length - offset)
        out.set(buffer.subarray(offset, offset + take), written)
        offset += take
        written += take
      }
      return out
    },
    word() {
      if (offset + 4 > buffer.length) refill()
      const value = readU32LE(buffer, offset)
      offset += 4
      return value
    },
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError('maxExclusive must be positive')
      // Rejection sampling keeps the distribution uniform.
      const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
      for (;;) {
        const value = prng.word()
        if (value < limit) return value % maxExclusive
      }
    },
    hex(length) {
      return toHex(prng.bytes(length))
    },
    shuffle(items) {
      const out = items.slice()
      for (let index = out.length - 1; index > 0; index -= 1) {
        const swap = prng.int(index + 1)
        const value = out[index]
        out[index] = out[swap]
        out[swap] = value
      }
      return out
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('cannot pick from an empty list')
      return items[prng.int(items.length)]
    },
    fork(label) {
      return createPrng(prng.bytes(32), `${domain}/${label}`)
    },
    reseed(label) {
      const fresh = keyWords(prng.bytes(32), `${domain}/${label}`)
      for (let index = 0; index < 8; index += 1) key[index] = fresh[index]
      counter = 0
      buffer = new Uint8Array(0)
      offset = 0
    },
  }
  return prng
}

/**
 * Host entropy. In a browser this is the real CSPRNG; in a JS analysis sandbox
 * `crypto.getRandomValues` is seeded by the harness (by design), and when no
 * CSPRNG exists at all we fall back to `Math.random`. The SDK records which
 * entropy source it used so a server can treat a weak source as a risk signal
 * instead of silently trusting it.
 *
 * @param {number} length
 * @param {object} [scope]
 * @returns {{bytes: Uint8Array, source: 'crypto'|'math'}}
 */
export function gatherEntropy(length, scope) {
  const host = scope ?? (typeof globalThis !== 'undefined' ? globalThis : {})
  const target = new Uint8Array(length)
  const cryptoObject = host.crypto
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    try {
      cryptoObject.getRandomValues(target)
      return { bytes: target, source: 'crypto' }
    } catch {
      /* fall through to Math.random */
    }
  }
  const random = typeof host.Math?.random === 'function' ? host.Math.random : Math.random
  for (let index = 0; index < length; index += 1) target[index] = Math.floor(random() * 256) & 0xff
  return { bytes: target, source: 'math' }
}
