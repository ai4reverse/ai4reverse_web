/**
 * Algorithm catalogue.
 *
 * "Many suites" is not a marketing number here: the catalogue enumerates every
 * white-box parameterisation and every cipher layer the SDK can instantiate,
 * and the build/test pipeline exercises all of them. White-box suites are
 * *lazy*: the tables are generated on first use from the session seed, so a
 * bundle carries the generators, not twelve copies of 150 KB tables.
 *
 * Layers split into two classes:
 *
 *  - `server`: invertible by the verifier because its parameters are derived
 *    from the ECDH secret. These are the hybrid-envelope layers.
 *  - `device`: white-box layers whose key is implicit in tables. They are used
 *    for local sealing and key derivation, never for envelopes the server must
 *    open.
 */

import { aesCtr, aesDecryptBlock, aesEncryptBlock } from './aes.js'
import { chacha20Xor } from './chacha.js'
import {
  createArxStream,
  createMagmaLike,
  createMutantAes,
  createMutantSm4,
  createRc6Like,
} from './custom.js'
import { hmacSm3, kdfSm3 } from './hash.js'
import { concatBytes, fromHex, toHex, u32LE, u64LE, utf8ToBytes } from './bytes.js'
import { createPrng } from './prng.js'
import { sm4DecryptBlock, sm4EncryptBlock } from './sm4.js'
import { createWhiteboxAes } from './whitebox/aes-wb.js'
import { invertByteMap, randomBijection } from './whitebox/encodings.js'
import { createWhiteboxSm4 } from './whitebox/sm4-wb.js'
import { createWhiteboxSpn } from './whitebox/spn-wb.js'

/** White-box suite catalogue: twelve suites across three families. */
export const WHITEBOX_SUITES = Object.freeze([
  { id: 'wb-aes/a', family: 'whitebox-aes-128', salt: 'wa1' },
  { id: 'wb-aes/b', family: 'whitebox-aes-128', salt: 'wa2' },
  { id: 'wb-aes/c', family: 'whitebox-aes-128', salt: 'wa3' },
  { id: 'wb-aes/d', family: 'whitebox-aes-128', salt: 'wa4' },
  { id: 'wb-sm4/a', family: 'whitebox-sm4', salt: 'ws1' },
  { id: 'wb-sm4/b', family: 'whitebox-sm4', salt: 'ws2' },
  { id: 'wb-sm4/c', family: 'whitebox-sm4', salt: 'ws3' },
  { id: 'wb-sm4/d', family: 'whitebox-sm4', salt: 'ws4' },
  { id: 'wb-spn/a', family: 'whitebox-spn', salt: 'wp1' },
  { id: 'wb-spn/b', family: 'whitebox-spn', salt: 'wp2' },
  { id: 'wb-spn/c', family: 'whitebox-spn', salt: 'wp3' },
  { id: 'wb-spn/d', family: 'whitebox-spn', salt: 'wp4' },
])

/** Server-invertible hybrid layers. */
export const SERVER_LAYERS = Object.freeze([
  'sm4-cfb',
  'aes-cfb',
  'chacha20',
  'arx',
  'mutant-aes-cfb',
  'mutant-sm4-cfb',
  'rc6-cfb',
  'magma-cfb',
  'subst',
  'perm',
  'wb-aes-ctr',
  'wb-sm4-ctr',
])

/** Device-only white-box layers. */
export const DEVICE_LAYERS = Object.freeze(WHITEBOX_SUITES.map((suite) => suite.id))

/**
 * Instantiate one white-box suite. Tables are generated from `seed`.
 * @param {string} id
 * @param {string|Uint8Array} seed
 * @param {Uint8Array|number[]} [key]
 */
export function instantiateWhitebox(id, seed, key) {
  const suite = WHITEBOX_SUITES.find((entry) => entry.id === id)
  if (!suite) throw new RangeError(`unknown white-box suite ${id}`)
  const domain = `${seed}::${suite.salt}`
  if (suite.family === 'whitebox-aes-128') return createWhiteboxAes({ seed: domain, key })
  if (suite.family === 'whitebox-sm4') return createWhiteboxSm4({ seed: domain, key })
  return createWhiteboxSpn({ seed: domain, key })
}

/**
 * A catalogue instance for one session: owns lazily built white-box suites.
 * @param {{seed?: string|Uint8Array, key?: Uint8Array|number[]}} [options]
 */
export function createCatalogue(options = {}) {
  const seed = options.seed ?? 'catalogue'
  const cache = new Map()
  const key = options.key ? Uint8Array.from(options.key) : undefined
  return {
    suites: WHITEBOX_SUITES,
    serverLayers: SERVER_LAYERS,
    deviceLayers: DEVICE_LAYERS,
    get(id) {
      if (!WHITEBOX_SUITES.some((suite) => suite.id === id)) throw new RangeError(`unknown white-box suite ${id}`)
      if (!cache.has(id)) cache.set(id, instantiateWhitebox(id, seed, key))
      return cache.get(id)
    },
    prewarm(ids) {
      return (ids ?? ['wb-aes/a', 'wb-sm4/a', 'wb-spn/a']).map((id) => this.get(id).meta)
    },
    /** Choose a 3..5 layer plan for an envelope. */
    plan(layerPrng) {
      const count = 3 + layerPrng.int(3)
      const pool = layerPrng.shuffle(SERVER_LAYERS.slice())
      return pool.slice(0, count)
    },
  }
}

/**
 * CFB mode: length preserving and non-commutative, so chaining several layers
 * is not equivalent to a single XOR stream.
 * @param {(key: Uint8Array, block: Uint8Array) => Uint8Array} encryptBlock
 * @param {Uint8Array} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} data
 * @param {boolean} inverse
 * @returns {Uint8Array}
 */
function cfb(encryptBlock, key, iv, data, inverse, blockSize = 16) {
  const out = new Uint8Array(data.length)
  let previous = Uint8Array.from(iv)
  for (let offset = 0; offset < data.length; offset += blockSize) {
    const keystream = encryptBlock(key, previous)
    const take = Math.min(blockSize, data.length - offset)
    const chunk = new Uint8Array(blockSize)
    for (let index = 0; index < take; index += 1) {
      out[offset + index] = data[offset + index] ^ keystream[index]
      chunk[index] = inverse ? data[offset + index] : out[offset + index]
    }
    previous = chunk
  }
  return out
}

/**
 * Build the layer implementation. `aux` is key material derived from the
 * envelope secret; it parameterises the custom mutants and the keyed
 * substitution/permutation layers.
 * @param {string} id
 * @param {Uint8Array} aux
 */
function layerImplementation(id, aux) {
  const prng = createPrng(aux, `layer/${id}`)
  switch (id) {
    case 'sm4-cfb':
      return { blockSize: 16, apply: (data, key, iv) => cfb(sm4EncryptBlock, key.subarray(0, 16), iv, data, false), invert: (data, key, iv) => cfb(sm4EncryptBlock, key.subarray(0, 16), iv, data, true) }
    case 'aes-cfb':
      return { blockSize: 16, apply: (data, key, iv) => cfb(aesEncryptBlock, key.subarray(0, 16), iv, data, false), invert: (data, key, iv) => cfb(aesEncryptBlock, key.subarray(0, 16), iv, data, true) }
    case 'chacha20': {
      const nonce = deriveNonce(keyNonce(aux), 12)
      return {
        blockSize: 12,
        apply: (data, key) => chacha20Xor(key.subarray(0, 32), nonce, 1, data),
        invert: (data, key) => chacha20Xor(key.subarray(0, 32), nonce, 1, data),
      }
    }
    case 'arx': {
      const stream = createArxStream({ seed: aux, key: aux.subarray(0, 32) })
      return {
        blockSize: 16,
        apply: (data) => xorWith(stream, data),
        invert: (data) => xorWith(stream, data),
      }
    }
    case 'mutant-aes-cfb': {
      const cipher = createMutantAes({ seed: aux.subarray(0, 16), key: aux.subarray(0, 16) })
      return {
        blockSize: 16,
        apply: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 16), iv, data, false),
        invert: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 16), iv, data, true),
        meta: cipher.meta,
      }
    }
    case 'mutant-sm4-cfb': {
      const cipher = createMutantSm4({ seed: aux.subarray(0, 16), key: aux.subarray(0, 16) })
      return {
        blockSize: 16,
        apply: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 16), iv, data, false),
        invert: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 16), iv, data, true),
        meta: cipher.meta,
      }
    }
    case 'rc6-cfb': {
      const cipher = createRc6Like({ seed: aux.subarray(0, 16), key: aux.subarray(0, 16) })
      return {
        blockSize: 16,
        apply: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 16), iv, data, false),
        invert: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 16), iv, data, true),
        meta: cipher.meta,
      }
    }
    case 'magma-cfb': {
      const cipher = createMagmaLike({ seed: aux.subarray(0, 32), key: aux.subarray(0, 32) })
      return {
        blockSize: 8,
        apply: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 32), iv.subarray(0, 8), data, false, 8),
        invert: (data, key, iv) => cfb((_k, block) => cipher.encryptBlock(block), aux.subarray(0, 32), iv.subarray(0, 8), data, true, 8),
        meta: cipher.meta,
      }
    }
    case 'wb-aes-ctr': {
      // White-box layer whose key is the ECDH-derived aux. The server can
      // regenerate the same tables because it holds the shared secret; a
      // network/static attacker cannot, so the layer adds real depth before the
      // standard layers are reached.
      const instance = createWhiteboxAes({ seed: aux, key: aux.subarray(0, 16) })
      return {
        blockSize: 16,
        apply: (data, key, iv) => instance.encrypt(iv, data),
        invert: (data, key, iv) => instance.encrypt(iv, data),
        meta: instance.meta,
      }
    }
    case 'wb-sm4-ctr': {
      const instance = createWhiteboxSm4({ seed: aux, key: aux.subarray(0, 16) })
      return {
        blockSize: 16,
        apply: (data, key, iv) => instance.encrypt(iv, data),
        invert: (data, key, iv) => instance.encrypt(iv, data),
        meta: instance.meta,
      }
    }
    case 'subst': {
      const box = randomBijection(prng)
      const inverseBox = invertByteMap(box)
      const salt = aux[0]
      return {
        blockSize: 1,
        apply: (data) => Uint8Array.from(data, (value, index) => box[value ^ ((salt + index) & 0xff)]),
        invert: (data) => Uint8Array.from(data, (value, index) => inverseBox[value] ^ ((salt + index) & 0xff)),
      }
    }
    case 'perm': {
      return {
        blockSize: 16,
        apply: (data) => permute(data, aux, false),
        invert: (data) => permute(data, aux, true),
      }
    }
    default:
      throw new RangeError(`unknown layer ${id}`)
  }
}

/** @param {number[]} source @param {number} length @returns {Uint8Array} */
function deriveNonce(source, length) {
  return Uint8Array.from(source.subarray(0, length))
}

/** @param {Uint8Array} aux @returns {Uint8Array} */
function keyNonce(aux) {
  return kdfSm3(aux, 'nonce', 16)
}

/** @param {{keystream: (length: number) => Uint8Array}} stream @param {Uint8Array} data */
function xorWith(stream, data) {
  const keystream = stream.keystream(data.length)
  return Uint8Array.from(data, (value, index) => value ^ keystream[index])
}

/**
 * Per-chunk keyed permutation. Both sides derive the same permutation from the
 * aux secret and the chunk index.
 * @param {Uint8Array} data
 * @param {Uint8Array} aux
 * @param {boolean} inverse
 */
function permute(data, aux, inverse) {
  const out = new Uint8Array(data.length)
  for (let offset = 0; offset < data.length; offset += 16) {
    const take = Math.min(16, data.length - offset)
    const prng = createPrng(concatBytes(aux, u32LE(offset / 16)), 'perm')
    const order = prng.shuffle(Array.from({ length: take }, (_, index) => index))
    if (inverse) {
      for (let index = 0; index < take; index += 1) out[offset + order[index]] = data[offset + index]
    } else {
      for (let index = 0; index < take; index += 1) out[offset + index] = data[offset + order[index]]
    }
  }
  return out
}

/**
 * Create a layer instance with a fixed aux secret.
 * @param {string} id
 * @param {Uint8Array} aux
 */
export function createLayer(id, aux) {
  if (!SERVER_LAYERS.includes(id)) throw new RangeError(`layer ${id} is not server-invertible`)
  return { id, ...layerImplementation(id, aux) }
}

/**
 * Derive the layer key/iv/aux set for an envelope.
 * @param {Uint8Array} shared
 * @param {string} nonceHex
 * @param {number} index
 * @param {string} id
 */
export function deriveLayerMaterial(shared, nonceHex, index, id) {
  const info = `nsdk/hybrid/v1/${index}/${id}/${nonceHex}`
  return {
    key: kdfSm3(shared, `${info}/key`, 32),
    iv: kdfSm3(shared, `${info}/iv`, 16),
    aux: kdfSm3(shared, `${info}/aux`, 32),
  }
}

/**
 * Derive the encoding alphabet and tag key for an envelope.
 * @param {Uint8Array} shared
 * @param {string} nonceHex
 */
export function deriveEnvelopeSecrets(shared, nonceHex) {
  const alphabet = Array.from({ length: 62 }, (_, index) =>
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[index],
  )
  const prng = createPrng(kdfSm3(shared, `nsdk/hybrid/v1/alphabet/${nonceHex}`, 32), 'alphabet')
  const shuffled = prng.shuffle(alphabet).join('')
  return {
    alphabet: shuffled,
    tagKey: kdfSm3(shared, `nsdk/hybrid/v1/tag/${nonceHex}`, 32),
    planKey: kdfSm3(shared, `nsdk/hybrid/v1/plan/${nonceHex}`, 32),
    encoding: 'b62',
  }
}

/**
 * MAC used by the envelope and by local sealing.
 * @param {Uint8Array} key
 * @param {Uint8Array|string} message
 * @returns {string}
 */
export function macHex(key, message) {
  const bytes = typeof message === 'string' ? utf8ToBytes(message) : message
  return toHex(hmacSm3(key, bytes))
}

/** @param {string} hex @returns {Uint8Array} */
export function hexBytes(hex) {
  return fromHex(hex)
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesHex(bytes) {
  return toHex(bytes)
}

/** @param {number} value @returns {Uint8Array} */
export function counterBytes(value) {
  return u64LE(BigInt(value))
}

export { aesCtr, aesDecryptBlock }
