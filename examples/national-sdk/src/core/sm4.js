/**
 * SM4 (GB/T 32907-2016) — block cipher, CTR and CBC modes.
 *
 * This is the *reference* SM4 used by the server verifier and by the SDK's
 * standard (non-white-box) layers. The device-side white-box variant lives in
 * `core/whitebox/sm4-wb.js` and must produce identical ciphertext; the test
 * suite asserts that equality for every suite.
 */

import { fromHex, readU32BE, rotl32, toHex, u32BE } from './bytes.js'

/** SM4 S-box (GB/T 32907, §6.2). */
const SBOX = new Uint8Array([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
])

const FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc]

/** @returns {Uint32Array} 32 round keys */
const CK = (() => {
  const words = new Uint32Array(32)
  for (let index = 0; index < 32; index += 1) {
    const bytes = [(4 * index) * 7, (4 * index + 1) * 7, (4 * index + 2) * 7, (4 * index + 3) * 7]
    words[index] = (((bytes[0] & 0xff) << 24) | ((bytes[1] & 0xff) << 16) | ((bytes[2] & 0xff) << 8) | (bytes[3] & 0xff)) >>> 0
  }
  return words
})()

/** @param {number} value @returns {number} */
function tau(value) {
  return (
    ((SBOX[(value >>> 24) & 0xff] << 24) |
      (SBOX[(value >>> 16) & 0xff] << 16) |
      (SBOX[(value >>> 8) & 0xff] << 8) |
      SBOX[value & 0xff]) >>>
    0
  )
}

/** @param {number} value @returns {number} */
export function sm4L(value) {
  return (value ^ rotl32(value, 2) ^ rotl32(value, 10) ^ rotl32(value, 18) ^ rotl32(value, 24)) >>> 0
}

/** @param {number} value @returns {number} */
function sm4LKey(value) {
  return (value ^ rotl32(value, 13) ^ rotl32(value, 23)) >>> 0
}

/** @param {number} value @returns {number} */
export function sm4Tau(value) {
  return tau(value)
}

/**
 * Internal round-key schedule. Exposed because the white-box generator needs
 * exactly the same round keys as the reference cipher.
 * @param {Uint8Array|number[]} key 16 bytes
 * @returns {Uint32Array}
 */
export function sm4KeySchedule(key) {
  if (key.length !== 16) throw new RangeError('SM4 key must be 16 bytes')
  const k = new Uint32Array(4)
  for (let index = 0; index < 4; index += 1) k[index] = (readU32BE(key, index * 4) ^ FK[index]) >>> 0
  const roundKeys = new Uint32Array(32)
  for (let index = 0; index < 32; index += 1) {
    const mixed = (k[(index + 1) % 4] ^ k[(index + 2) % 4] ^ k[(index + 3) % 4] ^ CK[index]) >>> 0
    const next = (k[index % 4] ^ sm4LKey(tau(mixed))) >>> 0
    k[index % 4] = next
    roundKeys[index] = next
  }
  return roundKeys
}

/**
 * Encrypt one block.
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} block 16 bytes
 * @returns {Uint8Array}
 */
export function sm4EncryptBlock(key, block) {
  if (block.length !== 16) throw new RangeError('SM4 block must be 16 bytes')
  const roundKeys = sm4KeySchedule(key)
  const x = new Uint32Array(36)
  for (let index = 0; index < 4; index += 1) x[index] = readU32BE(block, index * 4)
  for (let round = 0; round < 32; round += 1) {
    const mixed = (x[round + 1] ^ x[round + 2] ^ x[round + 3] ^ roundKeys[round]) >>> 0
    x[round + 4] = (x[round] ^ sm4L(tau(mixed))) >>> 0
  }
  const out = new Uint8Array(16)
  out.set(u32BE(x[35]), 0)
  out.set(u32BE(x[34]), 4)
  out.set(u32BE(x[33]), 8)
  out.set(u32BE(x[32]), 12)
  return out
}

/**
 * Decrypt one block.
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} block 16 bytes
 * @returns {Uint8Array}
 */
export function sm4DecryptBlock(key, block) {
  if (block.length !== 16) throw new RangeError('SM4 block must be 16 bytes')
  const roundKeys = sm4KeySchedule(key)
  const x = new Uint32Array(36)
  for (let index = 0; index < 4; index += 1) x[index] = readU32BE(block, index * 4)
  for (let round = 0; round < 32; round += 1) {
    const mixed = (x[round + 1] ^ x[round + 2] ^ x[round + 3] ^ roundKeys[31 - round]) >>> 0
    x[round + 4] = (x[round] ^ sm4L(tau(mixed))) >>> 0
  }
  const out = new Uint8Array(16)
  out.set(u32BE(x[35]), 0)
  out.set(u32BE(x[34]), 4)
  out.set(u32BE(x[33]), 8)
  out.set(u32BE(x[32]), 12)
  return out
}

/**
 * Increment a 16-byte big-endian counter in place.
 * @param {Uint8Array} counter
 */
function incrementCounter(counter) {
  for (let index = counter.length - 1; index >= 0; index -= 1) {
    counter[index] = (counter[index] + 1) & 0xff
    if (counter[index] !== 0) return
  }
}

/**
 * SM4 in CTR mode. Length preserving, seekable, and the mode the SDK uses for
 * hybrid layers because it composes cleanly with byte-permutation layers.
 * @param {Uint8Array|number[]} key 16 bytes
 * @param {Uint8Array|number[]} iv 16 bytes
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function sm4Ctr(key, iv, data) {
  const counter = Uint8Array.from(iv)
  if (counter.length !== 16) throw new RangeError('SM4-CTR IV must be 16 bytes')
  const out = new Uint8Array(data.length)
  const buffer = new Uint8Array(16)
  for (let offset = 0; offset < data.length; offset += 16) {
    buffer.set(sm4EncryptBlock(key, counter))
    incrementCounter(counter)
    const take = Math.min(16, data.length - offset)
    for (let index = 0; index < take; index += 1) out[offset + index] = data[offset + index] ^ buffer[index]
  }
  return out
}

/**
 * PKCS#7 pad / unpad helpers shared by the CBC modes.
 * @param {Uint8Array|number[]} data
 * @param {number} blockSize
 * @returns {Uint8Array}
 */
export function padPkcs7(data, blockSize = 16) {
  const length = data.length
  const padding = blockSize - (length % blockSize)
  const out = new Uint8Array(length + padding)
  out.set(data)
  out.fill(padding, length)
  return out
}

/** @param {Uint8Array|number[]} data @returns {Uint8Array} */
export function unpadPkcs7(data) {
  if (data.length === 0) throw new RangeError('cannot unpad an empty buffer')
  const padding = data[data.length - 1]
  if (padding < 1 || padding > 16 || padding > data.length) throw new RangeError('invalid PKCS#7 padding')
  for (let index = data.length - padding; index < data.length; index += 1) {
    if (data[index] !== padding) throw new RangeError('invalid PKCS#7 padding')
  }
  return data.subarray(0, data.length - padding)
}

/**
 * @param {Uint8Array|number[]} key
 * @param {Uint8Array|number[]} iv
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function sm4CbcEncrypt(key, iv, data) {
  const padded = padPkcs7(data)
  const out = new Uint8Array(padded.length)
  let previous = Uint8Array.from(iv)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = new Uint8Array(16)
    for (let index = 0; index < 16; index += 1) block[index] = padded[offset + index] ^ previous[index]
    previous = sm4EncryptBlock(key, block)
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
export function sm4CbcDecrypt(key, iv, data) {
  if (data.length % 16 !== 0) throw new RangeError('SM4-CBC ciphertext must be block aligned')
  const out = new Uint8Array(data.length)
  let previous = Uint8Array.from(iv)
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16)
    const plain = sm4DecryptBlock(key, block)
    for (let index = 0; index < 16; index += 1) out[offset + index] = plain[index] ^ previous[index]
    previous = Uint8Array.from(block)
  }
  return unpadPkcs7(out)
}

/** @param {string} keyHex @param {string} dataHex @returns {string} */
export function sm4EncryptBlockHex(keyHex, dataHex) {
  return toHex(sm4EncryptBlock(fromHex(keyHex), fromHex(dataHex)))
}

export const SM4_SBOX = SBOX
export const SM4_FK = FK
export const SM4_CK = CK
