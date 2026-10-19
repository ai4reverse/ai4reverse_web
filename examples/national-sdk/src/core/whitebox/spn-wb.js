/**
 * Dynamic implicit white-box SPN.
 *
 * Unlike the AES/SM4 white-boxes, this primitive has *no round keys at all*:
 * the sixteen 8-bit S-boxes are derived from the secret key through
 * HMAC-SM3, so the key exists only as a table permutation. There is no key
 * schedule to recover, and two instances built from different keys share no
 * table. This is the "dynamic implicit" primitive the SDK uses for:
 *
 *  - sealing locally persisted state (install secret, drift baseline),
 *  - deriving the session key ladder and the VM key,
 *  - a keyed PRF where the key must not be readable from the instance object.
 *
 * Parameters (round count, diffusion matrix, round constants, column rotation
 * schedule) are generated per suite seed, so a build produces a different
 * cipher shape without changing the security claim. The construction is a
 * keyed SPN; it is documented as a proprietary primitive and is not claimed to
 * be cryptanalysed, which is why it never replaces SM4 for server-invertible
 * hybrid layers.
 */

import { fromHex, toHex, utf8ToBytes } from '../bytes.js'
import { gmul, ginv } from '../aes.js'
import { hmacSm3, sm3 } from '../hash.js'
import { createPrng } from '../prng.js'
import { invertByteMap, randomBijection } from './encodings.js'

/**
 * Random invertible 4x4 matrix over GF(2^8).
 * @param {ReturnType<typeof createPrng>} prng
 * @returns {{matrix: number[][], inverse: number[][]}}
 */
function randomMatrix(prng) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => prng.int(256)))
    if (matrix.some((row) => row.every((value) => value === 0))) continue
    const inverse = invert4(matrix)
    if (inverse) return { matrix, inverse }
  }
  throw new Error('unable to generate an invertible diffusion matrix')
}

/**
 * @param {number[][]} matrix
 * @returns {number[][]|null}
 */
export function invert4(matrix) {
  const size = 4
  const augmented = matrix.map((row, index) => [...row, ...[0, 1, 2, 3].map((column) => (column === index ? 1 : 0))])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    while (pivot < size && augmented[pivot][column] === 0) pivot += 1
    if (pivot === size) return null
    if (pivot !== column) {
      const swap = augmented[pivot]
      augmented[pivot] = augmented[column]
      augmented[column] = swap
    }
    const inversePivot = ginv(augmented[column][column])
    for (let index = 0; index < size * 2; index += 1) augmented[column][index] = gmul(augmented[column][index], inversePivot)
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column]
      if (factor === 0) continue
      for (let index = 0; index < size * 2; index += 1) augmented[row][index] ^= gmul(factor, augmented[column][index])
    }
  }
  return augmented.map((row) => row.slice(size))
}

/**
 * @param {{seed?: string|Uint8Array, key?: Uint8Array|number[] , rounds?: number}} [options]
 */
export function createWhiteboxSpn(options = {}) {
  const prng = createPrng(options.seed ?? 'wb-spn', 'wb-spn')
  const rounds = options.rounds ?? 14
  const key = options.key ? Uint8Array.from(options.key) : prng.bytes(32)

  const boxes = []
  const inverseBoxes = []
  for (let position = 0; position < 16; position += 1) {
    const digest = hmacSm3(key, utf8ToBytes(`nsdk/spn/sbox/${position}`))
    const box = randomBijection(createPrng(digest, 'spn-box'))
    boxes.push(box)
    inverseBoxes.push(invertByteMap(box))
  }
  // The key's only representation from here on is the tables.
  key.fill(0)

  const { matrix, inverse } = randomMatrix(prng)
  const constants = new Uint8Array(rounds * 16)
  for (let index = 0; index < constants.length; index += 1) constants[index] = prng.int(256)
  const rotations = Array.from({ length: rounds }, (_, index) => index % 16)

  /** @param {Uint8Array} state */
  function mix(state) {
    for (let column = 0; column < 4; column += 1) {
      const source = [state[column * 4], state[column * 4 + 1], state[column * 4 + 2], state[column * 4 + 3]]
      for (let row = 0; row < 4; row += 1) {
        let value = 0
        for (let index = 0; index < 4; index += 1) value ^= gmul(matrix[row][index], source[index])
        state[column * 4 + row] = value
      }
    }
  }

  /** @param {Uint8Array} state */
  function invMix(state) {
    for (let column = 0; column < 4; column += 1) {
      const source = [state[column * 4], state[column * 4 + 1], state[column * 4 + 2], state[column * 4 + 3]]
      for (let row = 0; row < 4; row += 1) {
        let value = 0
        for (let index = 0; index < 4; index += 1) value ^= gmul(inverse[row][index], source[index])
        state[column * 4 + row] = value
      }
    }
  }

  /**
   * @param {Uint8Array} state
   * @param {number} shift
   */
  function rotate(state, shift) {
    if (shift === 0) return
    const copy = state.slice()
    for (let index = 0; index < 16; index += 1) state[(index + shift) % 16] = copy[index]
  }

  /**
   * @param {Uint8Array} state
   * @param {number} shift
   */
  function unrotate(state, shift) {
    if (shift === 0) return
    const copy = state.slice()
    for (let index = 0; index < 16; index += 1) state[index] = copy[(index + shift) % 16]
  }

  /** @param {Uint8Array|number[]} block */
  function encryptBlock(block) {
    if (block.length !== 16) throw new RangeError('white-box SPN block must be 16 bytes')
    const state = Uint8Array.from(block)
    for (let round = 0; round < rounds; round += 1) {
      for (let index = 0; index < 16; index += 1) state[index] = boxes[index][state[index]] ^ constants[round * 16 + index]
      if (round !== rounds - 1) {
        mix(state)
        rotate(state, rotations[round])
      }
    }
    return state
  }

  /** @param {Uint8Array|number[]} block */
  function decryptBlock(block) {
    if (block.length !== 16) throw new RangeError('white-box SPN block must be 16 bytes')
    const state = Uint8Array.from(block)
    for (let round = rounds - 1; round >= 0; round -= 1) {
      if (round !== rounds - 1) {
        unrotate(state, rotations[round])
        invMix(state)
      }
      for (let index = 0; index < 16; index += 1) state[index] = inverseBoxes[index][state[index] ^ constants[round * 16 + index]]
    }
    return state
  }

  /** @param {Uint8Array|number[]} iv @param {number} length */
  function keystream(iv, length) {
    const counter = Uint8Array.from(iv)
    const out = new Uint8Array(length)
    for (let offset = 0; offset < length; offset += 16) {
      const block = encryptBlock(counter)
      for (let index = counter.length - 1; index >= 0; index -= 1) {
        counter[index] = (counter[index] + 1) & 0xff
        if (counter[index] !== 0) break
      }
      const take = Math.min(16, length - offset)
      out.set(block.subarray(0, take), offset)
    }
    return out
  }

  /** @param {Uint8Array|number[]} iv @param {Uint8Array|number[]} data */
  function ctr(iv, data) {
    const stream = keystream(iv, data.length)
    const out = new Uint8Array(data.length)
    for (let index = 0; index < data.length; index += 1) out[index] = data[index] ^ stream[index]
    return out
  }

  const fingerprintSource = new Uint8Array(16 * 16)
  for (let index = 0; index < 16; index += 1) fingerprintSource.set(boxes[index].subarray(0, 16), index * 16)

  return {
    encryptBlock,
    decryptBlock,
    encrypt: (iv, data) => ctr(iv, data),
    decrypt: (iv, data) => ctr(iv, data),
    keystream,
    meta: {
      family: 'whitebox-spn',
      rounds,
      matrix,
      blockSize: 16,
      implicitKey: true,
      keyedSboxes: 16,
      suiteId: toHex(sm3(fingerprintSource)).slice(0, 24),
    },
  }
}

/** @param {string} hexKey @returns {Uint8Array} */
export function spnKeyFromHex(hexKey) {
  return fromHex(hexKey)
}
