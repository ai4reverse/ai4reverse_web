/**
 * AES-128 / AES-256 reference implementation.
 *
 * The S-box is *generated* (GF(2^8) inversion plus the affine map) instead of
 * being pasted as a 256-byte literal: a transcription error in a white-box
 * project is a silent correctness bug, and a generated box is auditable in one
 * line. The white-box generator consumes these same S-box/AES round internals,
 * which is why they are exported.
 */

import { concatBytes, fromHex, readU32BE, toHex, u32BE } from './bytes.js'

/** @param {number} a @param {number} b @returns {number} GF(2^8) multiply */
export function gmul(a, b) {
  let product = 0
  let left = a & 0xff
  let right = b & 0xff
  for (let index = 0; index < 8; index += 1) {
    if (right & 1) product ^= left
    const high = left & 0x80
    left = (left << 1) & 0xff
    if (high) left ^= 0x1b
    right >>>= 1
  }
  return product & 0xff
}

/** @param {number} value @returns {number} multiplicative inverse in GF(2^8), 0 -> 0 */
export function ginv(value) {
  if (value === 0) return 0
  // value^254 == value^-1 in the multiplicative group.
  let result = 1
  let base = value & 0xff
  let exponent = 254
  while (exponent > 0) {
    if (exponent & 1) result = gmul(result, base)
    base = gmul(base, base)
    exponent >>>= 1
  }
  return result
}

/** @param {number} value @returns {number} */
function rotl8(value, shift) {
  return ((value << shift) | (value >>> (8 - shift))) & 0xff
}

/** AES S-box, generated from the field inverse and the affine transform. */
export const AES_SBOX = (() => {
  const box = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) {
    const inverse = ginv(value)
    box[value] = (inverse ^ rotl8(inverse, 1) ^ rotl8(inverse, 2) ^ rotl8(inverse, 3) ^ rotl8(inverse, 4) ^ 0x63) & 0xff
  }
  return box
})()

/** Inverse S-box. */
export const AES_INV_SBOX = (() => {
  const box = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) box[AES_SBOX[value]] = value
  return box
})()

/** AES key schedule supporting 128/192/256-bit keys. @param {Uint8Array|number[]} key @returns {{rounds: number, words: Uint32Array}} */
export function aesKeySchedule(key) {
  const length = key.length
  if (length !== 16 && length !== 24 && length !== 32) throw new RangeError('AES key must be 16, 24 or 32 bytes')
  const rounds = length / 4 + 6
  const total = 4 * (rounds + 1)
  const words = new Uint32Array(total)
  for (let index = 0; index < length / 4; index += 1) words[index] = readU32BE(key, index * 4)
  let rcon = 1
  for (let index = length / 4; index < total; index += 1) {
    let temp = words[index - 1]
    if (index % (length / 4) === 0) {
      temp = ((temp << 8) | (temp >>> 24)) >>> 0
      temp =
        ((AES_SBOX[(temp >>> 24) & 0xff] << 24) |
          (AES_SBOX[(temp >>> 16) & 0xff] << 16) |
          (AES_SBOX[(temp >>> 8) & 0xff] << 8) |
          AES_SBOX[temp & 0xff]) >>>
        0
      temp = (temp ^ (rcon << 24)) >>> 0
      rcon = gmul(rcon, 2)
    } else if (length === 32 && index % 8 === 4) {
      temp =
        ((AES_SBOX[(temp >>> 24) & 0xff] << 24) |
          (AES_SBOX[(temp >>> 16) & 0xff] << 16) |
          (AES_SBOX[(temp >>> 8) & 0xff] << 8) |
          AES_SBOX[temp & 0xff]) >>>
        0
    }
    words[index] = (words[index - length / 4] ^ temp) >>> 0
  }
  return { rounds, words }
}

/** @param {number[]} state 16 bytes, column-major */
function addRoundKey(state, words, round) {
  for (let column = 0; column < 4; column += 1) {
    const word = words[round * 4 + column]
    state[column * 4] ^= (word >>> 24) & 0xff
    state[column * 4 + 1] ^= (word >>> 16) & 0xff
    state[column * 4 + 2] ^= (word >>> 8) & 0xff
    state[column * 4 + 3] ^= word & 0xff
  }
}

/** @param {number[]} state */
function subBytes(state) {
  for (let index = 0; index < 16; index += 1) state[index] = AES_SBOX[state[index]]
}

/** @param {number[]} state */
function invSubBytes(state) {
  for (let index = 0; index < 16; index += 1) state[index] = AES_INV_SBOX[state[index]]
}

/** @param {number[]} state */
function shiftRows(state) {
  const copy = state.slice()
  for (let row = 1; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      state[row + 4 * column] = copy[row + 4 * ((column + row) % 4)]
    }
  }
}

/** @param {number[]} state */
function invShiftRows(state) {
  const copy = state.slice()
  for (let row = 1; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      state[row + 4 * ((column + row) % 4)] = copy[row + 4 * column]
    }
  }
}

/** @param {number[]} state */
function mixColumns(state) {
  for (let column = 0; column < 4; column += 1) {
    const a = state[column * 4]
    const b = state[column * 4 + 1]
    const c = state[column * 4 + 2]
    const d = state[column * 4 + 3]
    state[column * 4] = gmul(a, 2) ^ gmul(b, 3) ^ c ^ d
    state[column * 4 + 1] = a ^ gmul(b, 2) ^ gmul(c, 3) ^ d
    state[column * 4 + 2] = a ^ b ^ gmul(c, 2) ^ gmul(d, 3)
    state[column * 4 + 3] = gmul(a, 3) ^ b ^ c ^ gmul(d, 2)
  }
}

/** @param {number[]} state */
function invMixColumns(state) {
  for (let column = 0; column < 4; column += 1) {
    const a = state[column * 4]
    const b = state[column * 4 + 1]
    const c = state[column * 4 + 2]
    const d = state[column * 4 + 3]
    state[column * 4] = gmul(a, 14) ^ gmul(b, 11) ^ gmul(c, 13) ^ gmul(d, 9)
    state[column * 4 + 1] = gmul(a, 9) ^ gmul(b, 14) ^ gmul(c, 11) ^ gmul(d, 13)
    state[column * 4 + 2] = gmul(a, 13) ^ gmul(b, 9) ^ gmul(c, 14) ^ gmul(d, 11)
    state[column * 4 + 3] = gmul(a, 11) ^ gmul(b, 13) ^ gmul(c, 9) ^ gmul(d, 14)
  }
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} block 16 bytes
 * @returns {Uint8Array}
 */
export function aesEncryptBlock(key, block) {
  if (block.length !== 16) throw new RangeError('AES block must be 16 bytes')
  const { rounds, words } = aesKeySchedule(key)
  const state = Array.from(block)
  addRoundKey(state, words, 0)
  for (let round = 1; round < rounds; round += 1) {
    subBytes(state)
    shiftRows(state)
    mixColumns(state)
    addRoundKey(state, words, round)
  }
  subBytes(state)
  shiftRows(state)
  addRoundKey(state, words, rounds)
  return Uint8Array.from(state)
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} block 16 bytes
 * @returns {Uint8Array}
 */
export function aesDecryptBlock(key, block) {
  if (block.length !== 16) throw new RangeError('AES block must be 16 bytes')
  const { rounds, words } = aesKeySchedule(key)
  const state = Array.from(block)
  addRoundKey(state, words, rounds)
  for (let round = rounds - 1; round >= 1; round -= 1) {
    invShiftRows(state)
    invSubBytes(state)
    addRoundKey(state, words, round)
    invMixColumns(state)
  }
  invShiftRows(state)
  invSubBytes(state)
  addRoundKey(state, words, 0)
  return Uint8Array.from(state)
}

/**
 * @param {Uint8Array|number[]} data
 * @param {number} blockSize
 * @returns {Uint8Array}
 */
function padPkcs7(data, blockSize = 16) {
  const padding = blockSize - (data.length % blockSize)
  const out = new Uint8Array(data.length + padding)
  out.set(data)
  out.fill(padding, data.length)
  return out
}

/** @param {Uint8Array|number[]} data @returns {Uint8Array} */
function unpadPkcs7(data) {
  const padding = data[data.length - 1]
  if (padding < 1 || padding > 16) throw new RangeError('invalid PKCS#7 padding')
  return data.subarray(0, data.length - padding)
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} iv
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function aesCtr(key, iv, data) {
  const counter = Uint8Array.from(iv)
  if (counter.length !== 16) throw new RangeError('AES-CTR IV must be 16 bytes')
  const out = new Uint8Array(data.length)
  for (let offset = 0; offset < data.length; offset += 16) {
    const keystream = aesEncryptBlock(key, counter)
    for (let index = counter.length - 1; index >= 0; index -= 1) {
      counter[index] = (counter[index] + 1) & 0xff
      if (counter[index] !== 0) break
    }
    const take = Math.min(16, data.length - offset)
    for (let index = 0; index < take; index += 1) out[offset + index] = data[offset + index] ^ keystream[index]
  }
  return out
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} iv
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function aesCbcEncrypt(key, iv, data) {
  const padded = padPkcs7(data)
  const out = new Uint8Array(padded.length)
  let previous = Uint8Array.from(iv)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = new Uint8Array(16)
    for (let index = 0; index < 16; index += 1) block[index] = padded[offset + index] ^ previous[index]
    previous = aesEncryptBlock(key, block)
    out.set(previous, offset)
  }
  return out
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} iv
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function aesCbcDecrypt(key, iv, data) {
  if (data.length % 16 !== 0) throw new RangeError('AES-CBC ciphertext must be block aligned')
  const out = new Uint8Array(data.length)
  let previous = Uint8Array.from(iv)
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16)
    const plain = aesDecryptBlock(key, block)
    for (let index = 0; index < 16; index += 1) out[offset + index] = plain[index] ^ previous[index]
    previous = Uint8Array.from(block)
  }
  return unpadPkcs7(out)
}

/** @param {string} keyHex @param {string} dataHex @returns {string} */
export function aesEncryptBlockHex(keyHex, dataHex) {
  return toHex(aesEncryptBlock(fromHex(keyHex), fromHex(dataHex)))
}

void concatBytes
void u32BE
