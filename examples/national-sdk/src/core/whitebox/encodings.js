/**
 * White-box internal encodings.
 *
 * Every white-box table is indexed by, and produces, values in an encoded
 * domain: an invertible affine map over GF(2) applied to each byte. Two tables
 * can be XORed together only when their output encodings are linear (constant
 * term 0), which is why internal encodings generated here are purely linear;
 * arbitrary bijections are used only at the input/output boundary.
 *
 * `randomLinearEnc` builds the matrix by starting from the identity and adding
 * random rows (a sequence of invertible elementary row operations), so the
 * result is invertible by construction rather than by rejection sampling.
 */

/** @param {ReturnType<typeof import('../prng.js').createPrng>} prng @param {number} [size] @returns {Uint8Array} */
export function randomInvertibleMatrix(prng, size = 8) {
  const rows = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) rows[index] = 1 << index
  for (let step = 0; step < size * 6; step += 1) {
    const source = prng.int(size)
    const target = prng.int(size)
    if (source === target) continue
    rows[target] ^= rows[source]
  }
  // A final transposition keeps the matrix from being triangular.
  for (let index = size - 1; index > 0; index -= 1) {
    const swap = prng.int(index + 1)
    const value = rows[index]
    rows[index] = rows[swap]
    rows[swap] = value
  }
  return rows
}

/**
 * Apply an 8x8 bit matrix (eight row masks) to a byte.
 * @param {Uint8Array|number[]} matrix
 * @param {number} value
 * @returns {number}
 */
export function applyMatrix(matrix, value) {
  let out = 0
  for (let bit = 0; bit < 8; bit += 1) {
    let mask = matrix[bit] & value
    // Parity of the masked bits.
    mask ^= mask >> 4
    mask ^= mask >> 2
    mask ^= mask >> 1
    out |= (mask & 1) << bit
  }
  return out
}

/**
 * Precompute a 256-byte map for a linear (or affine) encoding.
 * @param {Uint8Array|number[]} matrix
 * @param {number} [constant]
 * @returns {Uint8Array}
 */
export function buildByteMap(matrix, constant = 0) {
  const map = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) map[value] = applyMatrix(matrix, value) ^ (constant & 0xff)
  return map
}

/**
 * Invert a 256-byte bijection.
 * @param {Uint8Array|number[]} map
 * @returns {Uint8Array}
 */
export function invertByteMap(map) {
  const inverse = new Uint8Array(256)
  const seen = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) {
    const image = map[value]
    if (seen[image]) throw new Error('map is not injective')
    seen[image] = 1
    inverse[image] = value
  }
  return inverse
}

/**
 * A linear internal encoding: the map, its inverse and the matrix that
 * generated it (kept for documentation of the generated suite).
 * @param {ReturnType<typeof import('../prng.js').createPrng>} prng
 * @returns {{matrix: Uint8Array, map: Uint8Array, inverse: Uint8Array}}
 */
export function randomLinearEnc(prng) {
  const matrix = randomInvertibleMatrix(prng)
  const map = buildByteMap(matrix)
  return { matrix, map, inverse: invertByteMap(map) }
}

/**
 * A random byte permutation, used as an external (input/output) encoding where
 * the tables are not XOR-combined with anything.
 * @param {ReturnType<typeof import('../prng.js').createPrng>} prng
 * @returns {Uint8Array}
 */
export function randomBijection(prng) {
  const values = Array.from({ length: 256 }, (_, index) => index)
  return Uint8Array.from(prng.shuffle(values))
}

/**
 * Build a per-position decode table that also XORs a key byte (used to embed
 * round keys into white-box SM4 input tables).
 * @param {Uint8Array|number[]} inverseMap
 * @param {number} keyByte
 * @returns {Uint8Array}
 */
export function decodeWithKey(inverseMap, keyByte) {
  const table = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) table[value] = inverseMap[value] ^ (keyByte & 0xff)
  return table
}

/**
 * Encode a 32-bit word (four bytes) with four independent byte encodings.
 * @param {Uint8Array[]} maps
 * @param {Uint8Array|number[]} word
 * @returns {Uint8Array}
 */
export function encodeWord(maps, word) {
  return Uint8Array.from([maps[0][word[0]], maps[1][word[1]], maps[2][word[2]], maps[3][word[3]]])
}

/**
 * @param {Uint8Array[]} inverseMaps
 * @param {Uint8Array|number[]} encoded
 * @returns {Uint8Array}
 */
export function decodeWord(inverseMaps, encoded) {
  return Uint8Array.from([
    inverseMaps[0][encoded[0]],
    inverseMaps[1][encoded[1]],
    inverseMaps[2][encoded[2]],
    inverseMaps[3][encoded[3]],
  ])
}
