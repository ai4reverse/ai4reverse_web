/**
 * White-box SM4 with implicit round keys and per-word internal encodings.
 *
 * The round function `X4 = X0 ^ L(tau(X1 ^ X2 ^ X3 ^ rk))` cannot be
 * table-ised per input byte before the XOR, because `tau` is non-linear. The
 * implementation therefore:
 *
 *  1. decodes the three encoded input words with 256-byte tables, folding the
 *     current round-key bytes into the first word's decode table (so no round
 *     key is ever stored as data),
 *  2. XORs the decoded bytes to obtain `A`, applies `tau` through 256-entry
 *     tables and `L` as four linear shares — the four shares are XORed in the
 *     encoded domain, which is valid because every internal encoding is linear,
 *  3. XORs `X0` re-encoded into the next round's domain, producing the encoded
 *     word `X4`.
 *
 * This is the "implicit" part of the white-box: the only key-dependent data in
 * the instance are the tables, and the tables are one-way in the sense that
 * recovering `rk` from them requires breaking a bijection, not reading a
 * property.
 *
 * Decryption uses CTR, so only the forward tables exist.
 */

import { sm3 } from '../hash.js'
import { createPrng } from '../prng.js'
import { SM4_SBOX, sm4L, sm4KeySchedule } from '../sm4.js'
import { toHex } from '../bytes.js'
import { randomLinearEnc } from './encodings.js'

/** @param {number} value @param {number} shift @returns {number} */
function rotl(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

/**
 * @param {{seed?: string|Uint8Array, key?: Uint8Array|number[]}} [options]
 */
export function createWhiteboxSm4(options = {}) {
  const prng = createPrng(options.seed ?? 'wb-sm4', 'wb-sm4')
  const key = options.key ? Uint8Array.from(options.key) : prng.bytes(16)
  if (key.length !== 16) throw new RangeError('white-box SM4 requires a 16-byte key')
  const roundKeys = sm4KeySchedule(key)
  key.fill(0)
  const roundKeyBytes = Array.from({ length: 32 }, (_, index) => {
    const word = roundKeys[index]
    return [(word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff]
  })
  roundKeys.fill(0)

  /** @type {{matrix: Uint8Array, map: Uint8Array, inverse: Uint8Array}[][]} */
  const encodings = Array.from({ length: 36 }, () =>
    Array.from({ length: 4 }, () => randomLinearEnc(prng)),
  )

  /** @type {{decoders: Uint8Array[][], shares: Uint8Array[], reencode: Uint8Array[]}[]} */
  const rounds = []
  for (let round = 0; round < 32; round += 1) {
    const decoders = []
    for (let offset = 0; offset < 3; offset += 1) {
      const wordIndex = round + 1 + offset
      const tables = []
      for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        const table = new Uint8Array(256)
        const inverse = encodings[wordIndex][byteIndex].inverse
        const keyByte = offset === 0 ? roundKeyBytes[round][byteIndex] : 0
        for (let value = 0; value < 256; value += 1) table[value] = inverse[value] ^ keyByte
        tables.push(table)
      }
      decoders.push(tables)
    }

    // Four linear shares of L(tau(A)), encoded into the next word's domain.
    const shares = []
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      const table = new Uint8Array(4 * 256)
      const shift = 24 - byteIndex * 8
      for (let value = 0; value < 256; value += 1) {
        const contribution = sm4L(rotl(SM4_SBOX[value], shift))
        table[0 * 256 + value] = encodings[round + 4][0].map[(contribution >>> 24) & 0xff]
        table[1 * 256 + value] = encodings[round + 4][1].map[(contribution >>> 16) & 0xff]
        table[2 * 256 + value] = encodings[round + 4][2].map[(contribution >>> 8) & 0xff]
        table[3 * 256 + value] = encodings[round + 4][3].map[contribution & 0xff]
      }
      shares.push(table)
    }

    // X0 encoded in the current round's domain, re-encoded into the next one.
    const reencode = []
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      const table = new Uint8Array(256)
      const inverse = encodings[round][byteIndex].inverse
      const map = encodings[round + 4][byteIndex].map
      for (let value = 0; value < 256; value += 1) table[value] = map[inverse[value]]
      reencode.push(table)
    }
    rounds.push({ decoders, shares, reencode })
  }

  const outputDecoders = [32, 33, 34, 35].map((wordIndex) =>
    Array.from({ length: 4 }, (_, byteIndex) => encodings[wordIndex][byteIndex].inverse),
  )

  /** @param {Uint8Array|number[]} block */
  function encryptBlock(block) {
    if (block.length !== 16) throw new RangeError('white-box SM4 block must be 16 bytes')
    const words = [0, 1, 2, 3].map((index) => {
      const encoded = new Uint8Array(4)
      for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        encoded[byteIndex] = encodings[index][byteIndex].map[block[index * 4 + byteIndex]]
      }
      return encoded
    })
    for (let round = 0; round < 32; round += 1) {
      const layer = rounds[round]
      const acc = new Uint8Array(4)
      for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        const a =
          layer.decoders[0][byteIndex][words[1][byteIndex]] ^
          layer.decoders[1][byteIndex][words[2][byteIndex]] ^
          layer.decoders[2][byteIndex][words[3][byteIndex]]
        const table = layer.shares[byteIndex]
        for (let target = 0; target < 4; target += 1) acc[target] ^= table[target * 256 + a]
      }
      for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) acc[byteIndex] ^= layer.reencode[byteIndex][words[0][byteIndex]]
      words[0] = words[1]
      words[1] = words[2]
      words[2] = words[3]
      words[3] = acc
    }
    const out = new Uint8Array(16)
    for (let wordIndex = 0; wordIndex < 4; wordIndex += 1) {
      const encoded = words[wordIndex]
      for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        // Output order is X35 || X34 || X33 || X32.
        out[(3 - wordIndex) * 4 + byteIndex] = outputDecoders[wordIndex][byteIndex][encoded[byteIndex]]
      }
    }
    return out
  }

  /**
   * @param {Uint8Array|number[]} iv
   * @param {Uint8Array|number[]} data
   * @returns {Uint8Array}
   */
  function ctr(iv, data) {
    const counter = Uint8Array.from(iv)
    if (counter.length !== 16) throw new RangeError('white-box SM4 CTR IV must be 16 bytes')
    const out = new Uint8Array(data.length)
    for (let offset = 0; offset < data.length; offset += 16) {
      const keystream = encryptBlock(counter)
      for (let index = counter.length - 1; index >= 0; index -= 1) {
        counter[index] = (counter[index] + 1) & 0xff
        if (counter[index] !== 0) break
      }
      const take = Math.min(16, data.length - offset)
      for (let index = 0; index < take; index += 1) out[offset + index] = data[offset + index] ^ keystream[index]
    }
    return out
  }

  const parts = []
  for (const layer of rounds) {
    for (const table of layer.decoders[0]) parts.push(table.subarray(0, 8))
    for (const table of layer.shares) parts.push(table.subarray(0, 8))
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const source = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    source.set(part, cursor)
    cursor += part.length
  }

  return {
    encryptBlock,
    encrypt: (iv, data) => ctr(iv, data),
    decrypt: (iv, data) => ctr(iv, data),
    meta: {
      family: 'whitebox-sm4',
      cipher: 'sm4',
      mode: 'ctr',
      rounds: 32,
      tables: 32,
      suiteId: toHex(sm3(source)).slice(0, 24),
      implicitKey: true,
    },
  }
}
