/**
 * White-box AES-128 with implicit key and dynamic internal encodings.
 *
 * Structure: the initial AddRoundKey followed by nine key-instantiated T-box
 * rounds and a final round, exactly the AES-128 shape. Every table is indexed
 * by a random linear byte encoding of the previous round's state and produces
 * the next round's encoding. The AES key never appears in the object: it is
 * absorbed into the initial tables and into per-round output XOR masks (which
 * are themselves encoded constants). Two instances generated from different
 * seeds expose completely different tables for the same key.
 *
 * Each round-1..9 column is computed as `XOR of four encoded 32-bit
 * contributions`; because internal encodings are linear, that XOR equals the
 * encoding of the XOR, which is why the round key can be added as an encoded
 * mask.
 *
 * Decryption is not provided as a white-box operation: the SDK uses the block
 * function in CTR mode, so both directions are the same forward table walk.
 * That is a deliberate reduction of the attack surface (no inverse tables, no
 * key schedule reversal) and keeps the "implicit key" property.
 */

import { AES_SBOX, aesKeySchedule, gmul } from '../aes.js'
import { sm3 } from '../hash.js'
import { createPrng } from '../prng.js'
import { toHex } from '../bytes.js'
import { randomLinearEnc } from './encodings.js'

const MIX = [
  [2, 3, 1, 1],
  [1, 2, 3, 1],
  [1, 1, 2, 3],
  [3, 1, 1, 2],
]

/** @param {Uint8Array|number[]} key @returns {Uint8Array[]} */
function roundKeyBytes(key) {
  const schedule = aesKeySchedule(key)
  const out = []
  for (let round = 0; round <= schedule.rounds; round += 1) {
    const bytes = new Uint8Array(16)
    for (let column = 0; column < 4; column += 1) {
      const word = schedule.words[round * 4 + column]
      bytes[column * 4] = (word >>> 24) & 0xff
      bytes[column * 4 + 1] = (word >>> 16) & 0xff
      bytes[column * 4 + 2] = (word >>> 8) & 0xff
      bytes[column * 4 + 3] = word & 0xff
    }
    out.push(bytes)
  }
  // Do not keep the expanded key reachable from the caller.
  schedule.words.fill(0)
  return out
}

/**
 * @param {{seed?: string|Uint8Array, key?: Uint8Array|number[]}} [options]
 */
export function createWhiteboxAes(options = {}) {
  const prng = createPrng(options.seed ?? 'wb-aes', 'wb-aes')
  const key = options.key ? Uint8Array.from(options.key) : prng.bytes(16)
  if (key.length !== 16) throw new RangeError('white-box AES requires a 16-byte key')
  const masks = roundKeyBytes(key)
  key.fill(0)

  // Boundary encodings: encodings[round][position], round 0..9.
  const encodings = []
  for (let round = 0; round <= 9; round += 1) {
    encodings.push(Array.from({ length: 16 }, () => randomLinearEnc(prng)))
  }
  const inverse = encodings.map((round) => round.map((entry) => entry.inverse))

  // Initial AddRoundKey(0), encoded into round 0's domain.
  const round0 = []
  for (let position = 0; position < 16; position += 1) {
    const table = new Uint8Array(256)
    for (let value = 0; value < 256; value += 1) table[value] = encodings[0][position].map[value ^ masks[0][position]]
    round0.push(table)
  }

  // Rounds 1..9: SubBytes/ShiftRows/MixColumns T-boxes plus encoded key masks.
  /** @type {{tables: Uint8Array[], masks: Uint8Array}[]} */
  const middle = []
  for (let round = 1; round <= 9; round += 1) {
    const tables = []
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        const table = new Uint8Array(4 * 256)
        const source = ((column + row) % 4) * 4 + row
        const decode = inverse[round - 1][source]
        for (let value = 0; value < 256; value += 1) {
          const substituted = AES_SBOX[decode[value]]
          for (let target = 0; target < 4; target += 1) {
            const contribution = gmul(MIX[target][row], substituted)
            table[target * 256 + value] = encodings[round][column * 4 + target].map[contribution]
          }
        }
        tables.push(table)
      }
    }
    const encodedMask = new Uint8Array(16)
    for (let position = 0; position < 16; position += 1) {
      encodedMask[position] = encodings[round][position].map[masks[round][position]]
    }
    middle.push({ tables, masks: encodedMask })
  }

  // Final round: SubBytes/ShiftRows/AddRoundKey(10), plaintext output.
  /** @type {Uint8Array[]} */
  const finalRound = []
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      const table = new Uint8Array(256)
      const source = ((column + row) % 4) * 4 + row
      const decode = inverse[9][source]
      const keyByte = masks[10][column * 4 + row]
      for (let value = 0; value < 256; value += 1) table[value] = AES_SBOX[decode[value]] ^ keyByte
      finalRound.push(table)
    }
  }

  /** @param {Uint8Array|number[]} block */
  function encryptBlock(block) {
    if (block.length !== 16) throw new RangeError('white-box AES block must be 16 bytes')
    let state = Uint8Array.from(block)
    const initial = new Uint8Array(16)
    for (let position = 0; position < 16; position += 1) initial[position] = round0[position][state[position]]
    state = initial
    for (let round = 0; round < middle.length; round += 1) {
      const layer = middle[round]
      const nextState = new Uint8Array(16)
      for (let column = 0; column < 4; column += 1) {
        const acc = new Uint8Array(layer.masks.subarray(column * 4, column * 4 + 4))
        for (let row = 0; row < 4; row += 1) {
          const table = layer.tables[column * 4 + row]
          const source = ((column + row) % 4) * 4 + row
          const value = state[source]
          for (let target = 0; target < 4; target += 1) acc[target] ^= table[target * 256 + value]
        }
        nextState.set(acc, column * 4)
      }
      state = nextState
    }
    const out = new Uint8Array(16)
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        const source = ((column + row) % 4) * 4 + row
        out[column * 4 + row] = finalRound[column * 4 + row][state[source]]
      }
    }
    return out
  }

  /**
   * CTR mode over the forward white-box block function.
   * @param {Uint8Array|number[]} iv
   * @param {Uint8Array|number[]} data
   * @returns {Uint8Array}
   */
  function ctr(iv, data) {
    const counter = Uint8Array.from(iv)
    if (counter.length !== 16) throw new RangeError('white-box AES CTR IV must be 16 bytes')
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

  const fingerprintParts = []
  for (const table of round0) fingerprintParts.push(table.subarray(0, 16))
  for (const layer of middle) {
    for (const table of layer.tables) fingerprintParts.push(table.subarray(0, 16))
    fingerprintParts.push(layer.masks)
  }
  for (const table of finalRound) fingerprintParts.push(table.subarray(0, 16))
  const fingerprintSource = concatAll(fingerprintParts)

  return {
    encryptBlock,
    encrypt: (iv, data) => ctr(iv, data),
    decrypt: (iv, data) => ctr(iv, data),
    meta: {
      family: 'whitebox-aes-128',
      cipher: 'aes-128',
      mode: 'ctr',
      rounds: 10,
      tableBytes: 16 * 256 + 9 * 16 * 4 * 256 + 16 * 256,
      suiteId: toHex(sm3(fingerprintSource)).slice(0, 24),
      implicitKey: true,
    },
  }
}

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
function concatAll(parts) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
