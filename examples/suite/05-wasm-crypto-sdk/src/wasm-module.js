/**
 * Deterministic WebAssembly module builder for the WASM crypto SDK.
 *
 * The module is emitted as raw bytes (no toolchain, no network) so its exact
 * binary can be reproduced, hashed and audited. It exports one page of linear
 * memory and four 32-bit primitives:
 *
 *   xor(ptr, len, key)        in-place byte XOR, constant-work loop
 *   rotl(x, n)                32-bit rotate left
 *   mix(a, b)                 rotl(a ^ b, 13) + rotl(a, 7)
 *   xorBuf(dst, src, len)     byte-wise dst ^= src over linear memory
 *   permute(ptr, rounds)      8-lane ARX permutation over 32 bytes
 *
 * The permutation reads eight little-endian u32 lanes, updates lane i from lanes
 * i, i+1 and i+3, then XORs a round constant into lane 0. All arithmetic wraps
 * modulo 2^32 exactly like the JavaScript reference used in self-tests.
 */

/** @typedef {{xor: number, rotl: number, mix: number, xorBuf: number, permute: number}} ModuleIndices */

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]

/** Unsigned LEB128. @param {number} value */
function uleb(value) {
  const output = []
  let remaining = value >>> 0
  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) byte |= 0x80
    output.push(byte)
  } while (remaining !== 0)
  return output
}

/** Signed LEB128. @param {number} value */
function sleb(value) {
  const output = []
  let remaining = value | 0
  for (;;) {
    const byte = remaining & 0x7f
    const signBit = byte & 0x40
    remaining >>= 7
    if ((remaining === 0 && signBit === 0) || (remaining === -1 && signBit !== 0)) {
      output.push(byte)
      return output
    }
    output.push(byte | 0x80)
  }
}

/** @param {number[][]} items */
function vec(items) {
  return [...uleb(items.length), ...items.flat()]
}

/** @param {number} id @param {number[]} payload */
function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload]
}

const O = {
  block: 0x02,
  loop: 0x03,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  localGet: 0x20,
  localSet: 0x21,
  i32Const: 0x41,
  i32Load: 0x28,
  i32Store: 0x36,
  i32Load8u: 0x2d,
  i32Store8: 0x3a,
  i32Add: 0x6a,
  i32Mul: 0x6c,
  i32And: 0x71,
  i32Xor: 0x73,
  i32Shl: 0x74,
  i32Rotl: 0x77,
  i32GeU: 0x4f,
}

const get = (index) => [O.localGet, index]
const set = (index) => [O.localSet, index]
const constant = (value) => [O.i32Const, ...sleb(value)]
const add = [O.i32Add]
const xor = [O.i32Xor]
const mul = [O.i32Mul]
const shl = [O.i32Shl]
const rotl = [O.i32Rotl]
const and = [O.i32And]
const geU = [O.i32GeU]
const br = (depth) => [O.br, depth]
const brIf = (depth) => [O.brIf, depth]
const load = [O.i32Load, 0x02, 0x00]
const store = [O.i32Store, 0x02, 0x00]
const load8u = [O.i32Load8u, 0x00, 0x00]
const store8 = [O.i32Store8, 0x00, 0x00]
const block = [O.block, 0x40]
const loop = [O.loop, 0x40]
const end = [O.end]

/** xor(ptr, len, key): for (i = 0; i < len; i++) ptr[i] ^= key */
function xorBody() {
  return [
    ...constant(0),
    ...set(3),
    ...block,
    ...loop,
    ...get(3),
    ...get(1),
    ...geU,
    ...brIf(1),
    ...get(0),
    ...get(3),
    ...add,
    ...get(0),
    ...get(3),
    ...add,
    ...load8u,
    ...get(2),
    ...xor,
    ...store8,
    ...get(3),
    ...constant(1),
    ...add,
    ...set(3),
    ...br(0),
    ...end,
    ...end,
  ]
}

/** rotl(x, n): x rotated left by n */
function rotlBody() {
  return [...get(0), ...get(1), ...rotl]
}

/** mix(a, b): rotl(a ^ b, 13) + rotl(a, 7) */
function mixBody() {
  return [...get(0), ...get(1), ...xor, ...constant(13), ...rotl, ...get(0), ...constant(7), ...rotl, ...add]
}

/** xorBuf(dst, src, len): for (i = 0; i < len; i++) dst[i] ^= src[i] */
function xorBufBody() {
  return [
    ...constant(0),
    ...set(3),
    ...block,
    ...loop,
    ...get(3),
    ...get(2),
    ...geU,
    ...brIf(1),
    ...get(0),
    ...get(3),
    ...add,
    ...get(0),
    ...get(3),
    ...add,
    ...load8u,
    ...get(1),
    ...get(3),
    ...add,
    ...load8u,
    ...xor,
    ...store8,
    ...get(3),
    ...constant(1),
    ...add,
    ...set(3),
    ...br(0),
    ...end,
    ...end,
  ]
}

/**
 * permute(ptr, rounds): ARX permutation over eight u32 lanes.
 * Locals: 2=round, 3=lane, 4=lane offset, 5=a, 6=b, 7=c, 8=b offset,
 * 9=c offset, 10=value.
 */
function permuteBody() {
  const roundStart = [...constant(0), ...set(2), ...block, ...loop, ...get(2), ...get(1), ...geU, ...brIf(1)]
  const laneStart = [...constant(0), ...set(3), ...block, ...loop, ...get(3), ...constant(8), ...geU, ...brIf(1)]
  const laneOffset = [...get(0), ...get(3), ...constant(2), ...shl, ...add, ...set(4)]
  const laneA = [...get(4), ...load, ...set(5)]
  const laneBOffset = [...get(0), ...get(3), ...constant(1), ...add, ...constant(7), ...and, ...constant(2), ...shl, ...add, ...set(8)]
  const laneB = [...get(8), ...load, ...set(6)]
  const laneCOffset = [...get(0), ...get(3), ...constant(3), ...add, ...constant(7), ...and, ...constant(2), ...shl, ...add, ...set(9)]
  const laneC = [...get(9), ...load, ...set(7)]
  const value = [...get(5), ...get(6), ...xor, ...constant(13), ...rotl, ...get(7), ...constant(7), ...rotl, ...add, ...get(5), ...xor, ...set(10)]
  const laneStore = [...get(4), ...get(10), ...store]
  const laneAdvance = [...get(3), ...constant(1), ...add, ...set(3), ...br(0), ...end, ...end]
  const roundConstant = [...get(0), ...get(0), ...load, ...constant(0x9e3779b9), ...get(2), ...constant(1), ...add, ...mul, ...xor, ...store]
  const roundAdvance = [...get(2), ...constant(1), ...add, ...set(2), ...br(0), ...end, ...end]
  return [
    ...roundStart,
    ...laneStart,
    ...laneOffset,
    ...laneA,
    ...laneBOffset,
    ...laneB,
    ...laneCOffset,
    ...laneC,
    ...value,
    ...laneStore,
    ...laneAdvance,
    ...roundConstant,
    ...roundAdvance,
  ]
}

/** @param {number[][]} localGroups groups as [count, type] @param {number[]} instructions */
function codeBody(localGroups, instructions) {
  const body = [...uleb(localGroups.length), ...localGroups.flat(), ...instructions, O.end]
  return [...uleb(body.length), ...body]
}

/**
 * Build the WASM module bytes. Deterministic: identical output on every host.
 * @returns {Uint8Array}
 */
export function buildCryptoModule() {
  const types = [
    [0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00],
    [0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f],
    [0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00],
    [0x60, 0x02, 0x7f, 0x7f, 0x00],
  ]
  const functions = [[0], [1], [1], [3], [2]]
  const memory = [[0x00, 0x01]]
  const exportEntry = (name, kind, index) => {
    const bytes = Array.from(new TextEncoder().encode(name))
    return [...uleb(bytes.length), ...bytes, kind, index]
  }
  const exports = [
    exportEntry('memory', 0x02, 0),
    exportEntry('xor', 0x00, 0),
    exportEntry('rotl', 0x00, 1),
    exportEntry('mix', 0x00, 2),
    exportEntry('permute', 0x00, 3),
    exportEntry('xorBuf', 0x00, 4),
  ]
  const codes = [
    codeBody([[0x01, 0x7f]], xorBody()),
    codeBody([], rotlBody()),
    codeBody([], mixBody()),
    codeBody([[0x09, 0x7f]], permuteBody()),
    codeBody([[0x01, 0x7f]], xorBufBody()),
  ]
  return new Uint8Array([
    ...MAGIC,
    ...section(1, vec(types)),
    ...section(3, vec(functions)),
    ...section(5, vec(memory)),
    ...section(7, vec(exports)),
    ...section(10, vec(codes)),
  ])
}

export const MODULE_BASE64 = Buffer.from(buildCryptoModule()).toString('base64')
