/**
 * Custom ("魔改") ciphers.
 *
 * These are not standard algorithms with a different name: each factory
 * generates a *different* bijective primitive from a seed, so a static sample
 * of one session does not describe the next. The constructions stay inside
 * well-understood families (SPN, Feistel, ARX) because a novel structure with
 * no cryptanalysis is not defensible.
 *
 * Every factory returns `{ encryptBlock, decryptBlock, meta }`; the test suite
 * asserts `decryptBlock(encryptBlock(x)) === x` for random parameters and
 * measures avalanche so a "custom" cipher cannot silently degenerate into an
 * identity or a weak linear map.
 */

import { AES_SBOX, gmul, ginv } from './aes.js'
import { readU32BE, toHex, u32BE } from './bytes.js'
import { createPrng } from './prng.js'
import { sm4L, sm4Tau } from './sm4.js'

/** @param {number[]|Uint8Array} sbox @returns {Uint8Array} */
function invertSbox(sbox) {
  const inverse = new Uint8Array(256)
  for (let index = 0; index < 256; index += 1) inverse[sbox[index]] = index
  return inverse
}

/**
 * A random bijective 8-bit S-box: a chaotic affine walk composed with a
 * random permutation. Bijectivity is guaranteed by construction.
 * @param {ReturnType<typeof createPrng>} prng
 * @returns {Uint8Array}
 */
export function generateSbox(prng) {
  const permutation = Array.from({ length: 256 }, (_, index) => index)
  prng.shuffle(permutation)
  const box = new Uint8Array(256)
  for (let index = 0; index < 256; index += 1) box[index] = permutation[AES_SBOX[index] ^ (index & 0xff)] ?? 0
  // The composition above is not necessarily a permutation; force it by
  // mapping through the shuffle as the value side as well.
  const values = prng.shuffle(Array.from({ length: 256 }, (_, index) => index))
  for (let index = 0; index < 256; index += 1) box[index] = values[permutation[index]]
  return box
}

/**
 * 4x4 matrix inverse over GF(2^8) via Gauss-Jordan.
 * @param {number[][]} matrix
 * @returns {number[][]|null}
 */
export function invertMatrix4(matrix) {
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
    const inverse = ginv(augmented[column][column])
    for (let index = 0; index < size * 2; index += 1) augmented[column][index] = gmul(augmented[column][index], inverse)
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column]
      if (factor === 0) continue
      for (let index = 0; index < size * 2; index += 1) {
        augmented[row][index] ^= gmul(factor, augmented[column][index])
      }
    }
  }
  return augmented.map((row) => row.slice(size))
}

/**
 * Random invertible 4x4 matrix over GF(2^8) with a non-trivial branch number
 * (rejection sampling until every row and column is non-zero).
 * @param {ReturnType<typeof createPrng>} prng
 */
function randomInvertibleMatrix(prng) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => prng.int(256)))
    if (matrix.some((row) => row.every((value) => value === 0))) continue
    if (matrix.some((_, column) => matrix.every((row) => row[column] === 0))) continue
    const inverse = invertMatrix4(matrix)
    if (inverse) return { matrix, inverse }
  }
  throw new Error('unable to generate an invertible MixColumns matrix')
}

/**
 * A mutated AES-128: dynamic S-box, dynamic row shifts, dynamic invertible
 * MixColumns matrix and a keyed-sponge key schedule.
 *
 * @param {{seed?: string|Uint8Array, rounds?: number, key?: Uint8Array|number[]}} [options]
 */
export function createMutantAes(options = {}) {
  const prng = createPrng(options.seed ?? 'mutant-aes', 'mutant-aes')
  const rounds = options.rounds ?? 10 + prng.int(4)
  const sbox = generateSbox(prng)
  const inverseSbox = invertSbox(sbox)
  const shifts = [0, prng.int(4), prng.int(4), prng.int(4)]
  const { matrix, inverse } = randomInvertibleMatrix(prng)
  const key = options.key ? Uint8Array.from(options.key) : prng.bytes(16)

  /** @param {Uint8Array|number[]} input @param {boolean} invert */
  function mix(state, invertDirection) {
    const active = invertDirection ? inverse : matrix
    for (let column = 0; column < 4; column += 1) {
      const source = [state[column * 4], state[column * 4 + 1], state[column * 4 + 2], state[column * 4 + 3]]
      for (let row = 0; row < 4; row += 1) {
        let value = 0
        for (let index = 0; index < 4; index += 1) value ^= gmul(active[row][index], source[index])
        state[column * 4 + row] = value
      }
    }
  }

  function substitute(state, invertDirection) {
    const box = invertDirection ? inverseSbox : sbox
    for (let index = 0; index < 16; index += 1) state[index] = box[state[index]]
  }

  function shift(state, invertDirection) {
    const copy = state.slice()
    const sign = invertDirection ? -1 : 1
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const from = (((column + sign * shifts[row]) % 4) + 4) % 4
        state[row + 4 * column] = copy[row + 4 * from]
      }
    }
  }

  // Key schedule: a keyed sponge over key || round counter, independent of the
  // cipher's S-box so a broken S-box cannot leak the key schedule.
  const roundKeys = Array.from({ length: rounds + 1 }, (_, round) => {
    const words = new Uint32Array(4)
    let state = Array.from({ length: 8 }, (_, index) => readU32BE(key, (index % 4) * 4) ^ (round * 0x9e3779b9 + index))
    let counter = 0
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const fresh = spongeWords(state, 4)
      state = fresh
      counter += 1
    }
    for (let index = 0; index < 4; index += 1) words[index] = state[index] ^ key[(index * 4) % 16]
    return words
  })

  function addRoundKey(state, round) {
    const words = roundKeys[round]
    for (let column = 0; column < 4; column += 1) {
      const bytes = u32BE(words[column])
      for (let row = 0; row < 4; row += 1) state[column * 4 + row] ^= bytes[row]
    }
  }

  function crypt(input, direction) {
    const state = Array.from(input)
    if (direction > 0) {
      addRoundKey(state, 0)
      for (let round = 1; round <= rounds; round += 1) {
        substitute(state, false)
        shift(state, false)
        if (round !== rounds) mix(state, false)
        addRoundKey(state, round)
      }
    } else {
      addRoundKey(state, rounds)
      for (let round = rounds - 1; round >= 1; round -= 1) {
        shift(state, true)
        substitute(state, true)
        addRoundKey(state, round)
        mix(state, true)
      }
      shift(state, true)
      substitute(state, true)
      addRoundKey(state, 0)
    }
    return Uint8Array.from(state)
  }

  return {
    encryptBlock: (block) => crypt(block, 1),
    decryptBlock: (block) => crypt(block, -1),
    meta: {
      family: 'mutant-aes',
      rounds,
      shifts,
      matrix,
      blockSize: 16,
      keySize: 16,
      sboxFingerprint: toHex(sbox.subarray(0, 4)),
    },
  }
}

/**
 * A keyed ChaCha-like permutation used as the sponge for custom hashes and key
 * schedules. Six rounds are enough for key derivation (not for encryption).
 * @param {number[]} state eight 32-bit words
 * @param {number} words how many output words
 * @returns {number[]}
 */
function spongeWords(state, words) {
  const working = state.slice()
  const rot = (value, shift) => ((value << shift) | (value >>> (32 - shift))) >>> 0
  for (let round = 0; round < 6; round += 1) {
    working[0] = (working[0] + working[1]) >>> 0
    working[3] = rot(working[3] ^ working[0], 16)
    working[2] = (working[2] + working[3]) >>> 0
    working[1] = rot(working[1] ^ working[2], 12)
    working[0] = (working[0] + working[1]) >>> 0
    working[3] = rot(working[3] ^ working[0], 8)
    working[2] = (working[2] + working[3]) >>> 0
    working[1] = rot(working[1] ^ working[2], 7)
    working[4] = (working[4] + working[5]) >>> 0
    working[7] = rot(working[7] ^ working[4], 16)
    working[6] = (working[6] + working[7]) >>> 0
    working[5] = rot(working[5] ^ working[6], 12)
    working[4] = (working[4] + working[5]) >>> 0
    working[7] = rot(working[7] ^ working[4], 8)
    working[6] = (working[6] + working[7]) >>> 0
    working[5] = rot(working[5] ^ working[6], 7)
  }
  const out = []
  for (let index = 0; index < words; index += 1) out.push((working[index % 8] ^ state[index % 8]) >>> 0)
  return out
}

/**
 * A custom keyed sponge hash (32-byte output).
 * @param {Uint8Array|number[]} data
 * @param {Uint8Array|number[]} [key]
 * @returns {Uint8Array}
 */
export function spongeHash(data, key) {
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const keyBytes = key ? Uint8Array.from(key) : new Uint8Array(0)
  for (let index = 0; index < 8; index += 1) state[index] ^= readU32BE(pad32(keyBytes), index * 4)
  const block = new Uint8Array(64)
  for (let offset = 0; offset < data.length; offset += 64) {
    const take = Math.min(64, data.length - offset)
    block.fill(0)
    block.set(data.subarray(offset, offset + take), 0)
    block[63] ^= take & 0xff
    for (let index = 0; index < 16; index += 1) {
      const word = readU32BE(block, index * 4)
      if (index < 8) state[index] ^= word
      else state[index - 8] = (state[index - 8] + word) >>> 0
    }
    const fresh = spongeWords(state, 8)
    for (let index = 0; index < 8; index += 1) state[index] = fresh[index]
  }
  state[0] ^= 0x80000000
  const squeezed = spongeWords(state, 8)
  const out = new Uint8Array(32)
  for (let index = 0; index < 8; index += 1) out.set(u32BE(squeezed[index]), index * 4)
  return out
}

/** @param {Uint8Array|number[]} bytes @returns {Uint8Array} */
function pad32(bytes) {
  const out = new Uint8Array(32)
  out.set(Uint8Array.from(bytes).subarray(0, 32))
  return out
}

/**
 * A mutated SM4: generated S-box, mutated linear diffusion, mutated round
 * constants and key schedule. Same 32-round Lai-Massey-like structure, so
 * decryption is the same round function with reversed round keys.
 * @param {{seed?: string|Uint8Array, key?: Uint8Array|number[]}} [options]
 */
export function createMutantSm4(options = {}) {
  const prng = createPrng(options.seed ?? 'mutant-sm4', 'mutant-sm4')
  const sbox = generateSbox(prng)
  const rotations = [prng.int(16) + 1, prng.int(16) + 1, prng.int(16) + 1, prng.int(16) + 1]
  const rotl = (value, shift) => ((value << (shift & 31)) | (value >>> ((32 - shift) & 31))) >>> 0
  const linear = (value) => {
    let out = value
    for (const rotation of rotations) out ^= rotl(value, rotation)
    return out >>> 0
  }
  const tau = (value) =>
    ((sbox[(value >>> 24) & 0xff] << 24) |
      (sbox[(value >>> 16) & 0xff] << 16) |
      (sbox[(value >>> 8) & 0xff] << 8) |
      sbox[value & 0xff]) >>>
    0
  const round = (value) => linear(tau(value))
  const key = options.key ? Uint8Array.from(options.key) : prng.bytes(16)
  if (key.length !== 16) throw new RangeError('mutant SM4 key must be 16 bytes')
  const constants = Array.from({ length: 32 }, (_, index) =>
    (readU32BE(pad32(prng.bytes(32)), (index % 8) * 4) ^ (0x9e3779b9 + index * 0x85ebca6b)) >>> 0,
  )
  const fk = [0, 1, 2, 3].map((index) => readU32BE(pad32(key), index * 4) ^ constants[index])
  const roundKeys = new Uint32Array(32)
  const scheduled = fk.slice()
  for (let index = 0; index < 32; index += 1) {
    const mixed = (scheduled[(index + 1) % 4] ^ scheduled[(index + 2) % 4] ^ scheduled[(index + 3) % 4] ^ constants[(index + 4) % 32]) >>> 0
    const next = (scheduled[index % 4] ^ round(rotl(mixed, 7))) >>> 0
    scheduled[index % 4] = next
    roundKeys[index] = next
  }

  /** @param {Uint8Array} input @param {boolean} decrypt */
  function crypt(input, decrypt) {
    const x = new Uint32Array(36)
    for (let index = 0; index < 4; index += 1) x[index] = readU32BE(input, index * 4)
    for (let index = 0; index < 32; index += 1) {
      const roundKey = roundKeys[decrypt ? 31 - index : index]
      const mixed = (x[index + 1] ^ x[index + 2] ^ x[index + 3] ^ roundKey) >>> 0
      x[index + 4] = (x[index] ^ round(mixed)) >>> 0
    }
    const out = new Uint8Array(16)
    out.set(u32BE(x[35]), 0)
    out.set(u32BE(x[34]), 4)
    out.set(u32BE(x[33]), 8)
    out.set(u32BE(x[32]), 12)
    return out
  }

  return {
    encryptBlock: (block) => crypt(block, false),
    decryptBlock: (block) => crypt(block, true),
    meta: { family: 'mutant-sm4', rotations, blockSize: 16, keySize: 16, sboxFingerprint: toHex(sbox.subarray(0, 4)) },
  }
}

/**
 * RC6-like: 4-word ARX block cipher with data-dependent rotations and a
 * parameterised key schedule (mutated P/Q constants and rotation amounts).
 * @param {{seed?: string|Uint8Array, rounds?: number, key?: Uint8Array|number[]}} [options]
 */
export function createRc6Like(options = {}) {
  const prng = createPrng(options.seed ?? 'rc6-like', 'rc6-like')
  const rounds = options.rounds ?? 12 + prng.int(9)
  const keyWords = options.key ? Array.from(options.key) : Array.from(prng.bytes(4 * 4))
  const p = (0xb7e15163 ^ prng.word()) >>> 0
  const q = (0x9e3779b9 ^ prng.word()) >>> 0
  const rotateA = prng.int(15) + 1
  const rotateB = prng.int(15) + 1
  const multiplier = (prng.int(3) + 2) | 1
  const schedule = new Uint32Array(2 * rounds + 4)
  schedule[0] = p
  for (let index = 1; index < schedule.length; index += 1) schedule[index] = (schedule[index - 1] + q) >>> 0
  const mixKey = (input) => {
    let a = 0
    let b = 0
    for (let step = 0; step < 3 * schedule.length; step += 1) {
      a = schedule[step % schedule.length] = rotl32((schedule[step % schedule.length] + a + b) >>> 0, 3)
      const keyWord = keyWords[step % keyWords.length] & 0xff
      b = rotl32((keyWord + a + b) >>> 0, (a + b) & 31)
    }
  }
  const rotl32 = (value, shift) => ((value << (shift & 31)) | (value >>> ((32 - shift) & 31))) >>> 0
  const rotr32 = (value, shift) => ((value >>> (shift & 31)) | (value << ((32 - shift) & 31))) >>> 0
  if (keyWords.length !== 16) throw new RangeError('RC6-like key must be 16 bytes')
  mixKey(keyWords)

  function encryptBlock(block) {
    let a = readU32BE(block, 0)
    let b = readU32BE(block, 4)
    let c = readU32BE(block, 8)
    let d = readU32BE(block, 12)
    b = (b + schedule[0]) >>> 0
    d = (d + schedule[1]) >>> 0
    for (let round = 1; round <= rounds; round += 1) {
      const t = rotl32((b * (multiplier * b + 1)) >>> 0, rotateA)
      const u = rotl32((d * (multiplier * d + 1)) >>> 0, rotateB)
      a = (rotl32(a ^ t, u) + schedule[2 * round]) >>> 0
      c = (rotl32(c ^ u, t) + schedule[2 * round + 1]) >>> 0
      const nextA = b
      const nextB = c
      const nextC = d
      const nextD = a
      a = nextA
      b = nextB
      c = nextC
      d = nextD
    }
    a = (a + schedule[2 * rounds + 2]) >>> 0
    c = (c + schedule[2 * rounds + 3]) >>> 0
    const out = new Uint8Array(16)
    out.set(u32BE(a), 0)
    out.set(u32BE(b), 4)
    out.set(u32BE(c), 8)
    out.set(u32BE(d), 12)
    return out
  }

  function decryptBlock(block) {
    let a = (readU32BE(block, 0) - schedule[2 * rounds + 2]) >>> 0
    let b = readU32BE(block, 4)
    let c = (readU32BE(block, 8) - schedule[2 * rounds + 3]) >>> 0
    let d = readU32BE(block, 12)
    for (let round = rounds; round >= 1; round -= 1) {
      const aNew = d
      const cNew = b
      const bOld = a
      const dOld = c
      const t = rotl32((bOld * (multiplier * bOld + 1)) >>> 0, rotateA)
      const u = rotl32((dOld * (multiplier * dOld + 1)) >>> 0, rotateB)
      const aOld = (rotr32((aNew - schedule[2 * round]) >>> 0, u) ^ t) >>> 0
      const cOld = (rotr32((cNew - schedule[2 * round + 1]) >>> 0, t) ^ u) >>> 0
      a = aOld
      b = bOld
      c = cOld
      d = dOld
    }
    b = (b - schedule[0]) >>> 0
    d = (d - schedule[1]) >>> 0
    const out = new Uint8Array(16)
    out.set(u32BE(a), 0)
    out.set(u32BE(b), 4)
    out.set(u32BE(c), 8)
    out.set(u32BE(d), 12)
    return out
  }

  return {
    encryptBlock,
    decryptBlock,
    meta: { family: 'rc6-like', rounds, rotateA, rotateB, multiplier, blockSize: 16, keySize: 16 },
  }
}

/**
 * GOST/MAGMA-like Feistel network with generated 4-bit S-boxes.
 * @param {{seed?: string|Uint8Array, rounds?: number, key?: Uint8Array|number[]}} [options]
 */
export function createMagmaLike(options = {}) {
  const prng = createPrng(options.seed ?? 'magma-like', 'magma-like')
  const rounds = options.rounds ?? 32
  const key = options.key ? Uint8Array.from(options.key) : prng.bytes(32)
  if (key.length !== 32) throw new RangeError('MAGMA-like key must be 32 bytes')
  const keyWords = Array.from({ length: 8 }, (_, index) => readU32BE(key, index * 4))
  const boxes = Array.from({ length: 8 }, () => prng.shuffle(Array.from({ length: 16 }, (_, index) => index)))
  const rotate = (prng.int(7) + 8) & 31

  function roundFunction(value, keyWord) {
    const mixed = (value + keyWord) >>> 0
    let substituted = 0
    for (let index = 0; index < 8; index += 1) {
      const nibble = (mixed >>> (index * 4)) & 0x0f
      substituted |= boxes[index][nibble] << (index * 4)
    }
    return ((substituted << rotate) | (substituted >>> (32 - rotate))) >>> 0
  }

  const keySequence = [
    0, 1, 2, 3, 4, 5, 6, 7,
    0, 1, 2, 3, 4, 5, 6, 7,
    0, 1, 2, 3, 4, 5, 6, 7,
    7, 6, 5, 4, 3, 2, 1, 0,
  ]
  const decryptSequence = keySequence.slice().reverse()

  function crypt(block, sequence) {
    let left = readU32BE(block, 0)
    let right = readU32BE(block, 4)
    for (const index of sequence) {
      const next = (left ^ roundFunction(right, keyWords[index])) >>> 0
      left = right
      right = next
    }
    return Uint8Array.from([...u32BE(right), ...u32BE(left)])
  }

  return {
    encryptBlock: (block) => crypt(block, keySequence),
    decryptBlock: (block) => crypt(block, decryptSequence),
    meta: { family: 'magma-like', rounds, rotate, blockSize: 8, keySize: 32, boxes: boxes.map((box) => box.join('')) },
  }
}

/**
 * A keyed ARX stream generator. Not invertible by design (it is a keystream);
 * the hybrid layer XORs with it.
 * @param {{seed?: string|Uint8Array, key?: Uint8Array|number[]}} [options]
 */
export function createArxStream(options = {}) {
  const prng = createPrng(options.seed ?? 'arx-stream', 'arx-stream')
  const key = options.key ? Array.from(options.key) : Array.from(prng.bytes(32))
  const constants = [prng.word(), prng.word(), prng.word(), prng.word()]
  const rotations = [prng.int(20) + 5, prng.int(20) + 5, prng.int(20) + 5, prng.int(20) + 5]
  const rotl = (value, shift) => ((value << (shift & 31)) | (value >>> ((32 - shift) & 31))) >>> 0
  const state = new Uint32Array([
    (readU32BE(pad32(Uint8Array.from(key)), 0) ^ constants[0]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 4) ^ constants[1]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 8) ^ constants[2]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 12) ^ constants[3]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 16) ^ constants[0]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 20) ^ constants[1]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 24) ^ constants[2]) >>> 0,
    (readU32BE(pad32(Uint8Array.from(key)), 28) ^ constants[3]) >>> 0,
  ])

  function nextWord() {
    const result = (rotl((state[1] * 5) >>> 0, 7) * 9) >>> 0
    const t = (state[1] << 9) >>> 0
    state[2] ^= state[0]
    state[3] ^= state[1]
    state[1] ^= state[2]
    state[0] ^= state[3]
    state[2] ^= t
    state[3] = rotl(state[3], rotations[0])
    state[0] = rotl(state[0], rotations[1])
    state[1] = (state[1] + constants[2]) >>> 0
    state[2] = (state[2] + constants[3]) >>> 0
    state[3] = (state[3] + constants[0]) >>> 0
    state[0] = (state[0] + constants[1]) >>> 0
    for (let index = 0; index < 8; index += 1) state[index] = rotl(state[index], rotations[index % 4]) >>> 0
    return result
  }

  return {
    keystream(length) {
      const out = new Uint8Array(length)
      let offset = 0
      while (offset < length) {
        const word = nextWord()
        for (let index = 0; index < 4 && offset < length; index += 1) out[offset++] = (word >>> (index * 8)) & 0xff
      }
      return out
    },
    meta: { family: 'arx-stream', rotations, constants, stream: true },
  }
}

// Keep the reference S-box helpers linked so tree-shaking never drops the
// shared tables the mutants depend on.
void sm4L
void sm4Tau
