/**
 * ChaCha20 and HChaCha20.
 *
 * ChaCha20 is the fastest portable primitive in the catalogue: pure 32-bit
 * arithmetic, no tables, no S-box, so it is also the least fingerprintable one.
 * The SDK uses it as a stream layer and, through HChaCha20, as a subkey
 * deriver for the per-layer key ladder.
 */

import { readU32LE, rotl32, toHex, u32LE, utf8ToBytes } from './bytes.js'

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]

/** @param {number[]} state @param {number} a @param {number} b @param {number} c @param {number} d */
function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0
  state[d] = rotl32(state[d] ^ state[a], 16)
  state[c] = (state[c] + state[d]) >>> 0
  state[b] = rotl32(state[b] ^ state[c], 12)
  state[a] = (state[a] + state[b]) >>> 0
  state[d] = rotl32(state[d] ^ state[a], 8)
  state[c] = (state[c] + state[d]) >>> 0
  state[b] = rotl32(state[b] ^ state[c], 7)
}

/** @param {number[]} state */
function rounds(state) {
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
}

/**
 * @param {Uint8Array|number[]} key 32 bytes
 * @param {Uint8Array|number[]} nonce 12 bytes
 * @param {number} counter initial block counter
 * @returns {number[]} 16-word state
 */
function initialState(key, nonce, counter) {
  if (key.length !== 32) throw new RangeError('ChaCha20 key must be 32 bytes')
  if (nonce.length !== 12) throw new RangeError('ChaCha20 nonce must be 12 bytes')
  const state = new Array(16)
  for (let index = 0; index < 4; index += 1) state[index] = SIGMA[index]
  for (let index = 0; index < 8; index += 1) state[index + 4] = readU32LE(key, index * 4)
  state[12] = counter >>> 0
  for (let index = 0; index < 3; index += 1) state[index + 13] = readU32LE(nonce, index * 4)
  return state
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} nonce
 * @param {number} counter
 * @returns {Uint8Array} 64-byte keystream block
 */
export function chacha20Block(key, nonce, counter) {
  const initial = initialState(key, nonce, counter)
  const working = initial.slice()
  rounds(working)
  const out = new Uint8Array(64)
  for (let index = 0; index < 16; index += 1) out.set(u32LE((working[index] + initial[index]) >>> 0), index * 4)
  return out
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} nonce 12 bytes
 * @param {number} counter
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function chacha20Xor(key, nonce, counter, data) {
  const out = new Uint8Array(data.length)
  let blockIndex = counter >>> 0
  for (let offset = 0; offset < data.length; offset += 64) {
    const keystream = chacha20Block(key, nonce, blockIndex)
    const take = Math.min(64, data.length - offset)
    for (let index = 0; index < take; index += 1) out[offset + index] = data[offset + index] ^ keystream[index]
    blockIndex = (blockIndex + 1) >>> 0
  }
  return out
}

/**
 * HChaCha20: key derivation without the final feed-forward.
 * @param {Uint8Array|number[]} key 32 bytes
 * @param {Uint8Array|number[]} nonce 16 bytes
 * @returns {Uint8Array} 32-byte subkey
 */
export function hchacha20(key, nonce) {
  if (key.length !== 32) throw new RangeError('HChaCha20 key must be 32 bytes')
  if (nonce.length !== 16) throw new RangeError('HChaCha20 nonce must be 16 bytes')
  const state = new Array(16)
  for (let index = 0; index < 4; index += 1) state[index] = SIGMA[index]
  for (let index = 0; index < 8; index += 1) state[index + 4] = readU32LE(key, index * 4)
  for (let index = 0; index < 4; index += 1) state[index + 12] = readU32LE(nonce, index * 4)
  rounds(state)
  const out = new Uint8Array(32)
  const words = [state[0], state[1], state[2], state[3], state[12], state[13], state[14], state[15]]
  for (let index = 0; index < 8; index += 1) out.set(u32LE(words[index]), index * 4)
  return out
}

/** @param {string} keyHex @param {string} nonceHex @param {number} counter @param {string} dataHex @returns {string} */
export function chacha20XorHex(keyHex, nonceHex, counter, dataHex) {
  const key = Uint8Array.from({ length: 32 }, (_, index) => parseInt(keyHex.slice(index * 2, index * 2 + 2), 16))
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => parseInt(nonceHex.slice(index * 2, index * 2 + 2), 16))
  const data = Uint8Array.from({ length: dataHex.length / 2 }, (_, index) => parseInt(dataHex.slice(index * 2, index * 2 + 2), 16))
  return toHex(chacha20Xor(key, nonce, counter, data))
}

/** @param {string} text @returns {Uint8Array} */
export function chachaKeyFromText(text) {
  return utf8ToBytes(text).subarray(0, 32)
}
