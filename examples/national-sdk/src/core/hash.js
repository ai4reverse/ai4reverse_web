/**
 * Hash and MAC primitives: SHA-256, SM3, HMAC and an HKDF-style expander.
 *
 * SM3 is the primary hash of the SDK (a Chinese national standard, GB/T 32905)
 * because the device token, the request canonicalisation and the envelope tag
 * all need one hash that is available on both device and server without a
 * WebCrypto dependency. SHA-256 is kept because SM2 test vectors, JOSE-style
 * interop and several upstream systems speak it.
 */

import {
  concatBytes,
  fromHex,
  readU32BE,
  rotl32,
  toHex,
  u32BE,
  utf8ToBytes,
} from './bytes.js'

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/**
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array} 32-byte digest
 */
export function sha256(data) {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data)
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 9) >> 6) + 1) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const schedule = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = readU32BE(padded, offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15]
      const b = schedule[index - 2]
      const s0 = (rotl32(a, 25) ^ rotl32(a, 14) ^ (a >>> 3)) >>> 0
      const s1 = (rotl32(b, 15) ^ rotl32(b, 13) ^ (b >>> 10)) >>> 0
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotl32(e, 26) ^ rotl32(e, 21) ^ rotl32(e, 7)) >>> 0
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choose + K256[index] + schedule[index]) >>> 0
      const s0 = (rotl32(a, 30) ^ rotl32(a, 19) ^ rotl32(a, 10)) >>> 0
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  for (let index = 0; index < 8; index += 1) out.set(u32BE(hash[index]), index * 4)
  return out
}

const SM3_IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e]

/** @param {number} x @param {number} shift @returns {number} */
function sm3P0(x) {
  return (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0
}

/** @param {number} x @returns {number} */
function sm3P1(x) {
  return (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0
}

/**
 * @param {Uint32Array} state
 * @param {Uint8Array} block 64 bytes
 */
function sm3Compress(state, block) {
  const words = new Uint32Array(68)
  for (let index = 0; index < 16; index += 1) words[index] = readU32BE(block, index * 4)
  for (let index = 16; index < 68; index += 1) {
    const mixed = (words[index - 16] ^ words[index - 9] ^ rotl32(words[index - 3], 15)) >>> 0
    words[index] = (sm3P1(mixed) ^ rotl32(words[index - 13], 7) ^ words[index - 6]) >>> 0
  }
  const extended = new Uint32Array(64)
  for (let index = 0; index < 64; index += 1) extended[index] = (words[index] ^ words[index + 4]) >>> 0

  let [a, b, c, d, e, f, g, h] = state
  for (let index = 0; index < 64; index += 1) {
    const t = index < 16 ? 0x79cc4519 : 0x7a879d8a
    const a12 = rotl32(a, 12)
    const ss1 = rotl32((a12 + e + rotl32(t, index & 31)) >>> 0, 7)
    const ss2 = (ss1 ^ a12) >>> 0
    const tt1 = ((index < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c)) + d + ss2 + extended[index]) >>> 0
    const tt2 = ((index < 16 ? e ^ f ^ g : (e & f) | (~e & g)) + h + ss1 + words[index]) >>> 0
    d = c
    c = rotl32(b, 9)
    b = a
    a = tt1
    h = g
    g = rotl32(f, 19)
    f = e
    e = sm3P0(tt2)
  }
  state[0] = (state[0] ^ a) >>> 0
  state[1] = (state[1] ^ b) >>> 0
  state[2] = (state[2] ^ c) >>> 0
  state[3] = (state[3] ^ d) >>> 0
  state[4] = (state[4] ^ e) >>> 0
  state[5] = (state[5] ^ f) >>> 0
  state[6] = (state[6] ^ g) >>> 0
  state[7] = (state[7] ^ h) >>> 0
}

/**
 * SM3 (GB/T 32905-2016).
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array} 32-byte digest
 */
export function sm3(data) {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data)
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 9) >> 6) + 1) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const state = new Uint32Array(SM3_IV)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    sm3Compress(state, padded.subarray(offset, offset + 64))
  }
  const out = new Uint8Array(32)
  for (let index = 0; index < 8; index += 1) out.set(u32BE(state[index]), index * 4)
  return out
}

/** @param {string} text @returns {string} */
export function sm3Hex(text) {
  return toHex(sm3(typeof text === 'string' ? utf8ToBytes(text) : text))
}

/** @param {string} text @returns {string} */
export function sha256Hex(text) {
  return toHex(sha256(typeof text === 'string' ? utf8ToBytes(text) : text))
}

/**
 * Generic HMAC over a block-based hash.
 * @param {(data: Uint8Array) => Uint8Array} hash
 * @param {number} blockSize
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} message
 * @returns {Uint8Array}
 */
function hmac(hash, blockSize, key, message) {
  let normalised = key instanceof Uint8Array ? key : Uint8Array.from(key)
  if (normalised.length > blockSize) normalised = hash(normalised)
  const padded = new Uint8Array(blockSize)
  padded.set(normalised)
  const inner = new Uint8Array(blockSize)
  const outer = new Uint8Array(blockSize)
  for (let index = 0; index < blockSize; index += 1) {
    inner[index] = padded[index] ^ 0x36
    outer[index] = padded[index] ^ 0x5c
  }
  return hash(concatBytes(outer, hash(concatBytes(inner, message))))
}

/** @param {Uint8Array|number[]} key @param {Uint8Array|number[]} message @returns {Uint8Array} */
export function hmacSha256(key, message) {
  return hmac(sha256, 64, key, message)
}

/** @param {Uint8Array|number[]} key @param {Uint8Array|number[]} message @returns {Uint8Array} */
export function hmacSm3(key, message) {
  return hmac(sm3, 64, key, message)
}

/** @param {string} keyHex @param {string} messageHex @returns {string} */
export function hmacSm3Hex(keyHex, messageHex) {
  return toHex(hmacSm3(fromHex(keyHex), fromHex(messageHex)))
}

/**
 * HKDF-style expander built on HMAC-SM3.
 *
 * `extract` normalises the input keying material to 32 bytes; `expand`
 * produces `length` bytes of independent-looking output for a distinct `info`
 * label. Layer keys, tag keys and VM keys are all derived here, so one session
 * secret can key an unbounded number of purposes without reuse.
 *
 * @param {Uint8Array|number[]} ikm
 * @param {string} info
 * @param {number} length
 * @param {Uint8Array|number[]} [salt]
 * @returns {Uint8Array}
 */
export function kdfSm3(ikm, info, length, salt) {
  const inputKey = ikm instanceof Uint8Array ? ikm : Uint8Array.from(ikm)
  const actualSalt = salt && salt.length > 0 ? (salt instanceof Uint8Array ? salt : Uint8Array.from(salt)) : new Uint8Array(32)
  const prk = hmacSm3(actualSalt, inputKey)
  const infoBytes = utf8ToBytes(info)
  const blocks = Math.ceil(length / 32)
  const out = new Uint8Array(blocks * 32)
  let previous = new Uint8Array(0)
  for (let index = 0; index < blocks; index += 1) {
    const block = hmacSm3(prk, concatBytes(previous, infoBytes, Uint8Array.of(index + 1)))
    out.set(block, index * 32)
    previous = block
  }
  return out.subarray(0, length)
}

/** @param {string} ikmHex @param {string} info @param {number} length @returns {string} */
export function kdfSm3Hex(ikmHex, info, length) {
  return toHex(kdfSm3(fromHex(ikmHex), info, length))
}
