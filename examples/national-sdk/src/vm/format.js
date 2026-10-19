/**
 * Bytecode container format.
 *
 * The container is an encrypted, authenticated JSON payload:
 *
 *   1. the program is serialised with *build-time* opcode numbers (a random
 *      permutation of handler ids),
 *   2. the JSON is XORed with an HMAC-SM3 keystream derived from a 32-byte key,
 *   3. the base64url ciphertext travels with the permutation and a checksum.
 *
 * Nothing in the container is plaintext: no mnemonics, no string constants, no
 * readable control flow. The key is not a cryptographic secret against a live
 * debugger — it is generated inside a white-box SPN and only exists as a
 * keystream — but it defeats static extraction, which is the threat model
 * documented in `docs/THREAT-MODEL.md`.
 */

import { base64Decode, base64Encode, fromHex, toHex, utf8ToBytes, bytesToUtf8 } from '../core/bytes.js'
import { kdfSm3, sm3 } from '../core/hash.js'
import { ISA, OPCODE_ID } from './isa.js'

export const VM_FORMAT_VERSION = 1

/**
 * @param {Uint8Array|number[]} key
 * @param {string} label
 * @param {number} length
 * @returns {Uint8Array}
 */
function keystream(key, label, length) {
  return kdfSm3(Uint8Array.from(key), `nsdk/vm/format/v1/${label}`, length)
}

/**
 * Encode bytes as unpadded base64url.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function encodeTransport(bytes) {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} text @returns {Uint8Array} */
function decodeTransport(text) {
  return base64Decode(String(text).replace(/-/g, '+').replace(/_/g, '/'))
}

/**
 * @param {{instructions: Array<Array<string|number>>, consts: unknown[], locals: string[]}} program
 * @param {Uint8Array|number[]} key
 * @param {{perm?: number[]}} [options]
 * @returns {object} blob
 */
export function buildBlob(program, key, options = {}) {
  const perm = options.perm ?? shuffleHandlerIds(key)
  const buildCode = new Map()
  perm.forEach((handlerId, code) => buildCode.set(ISA[handlerId], code))
  const encodedInstructions = program.instructions.map(([op, ...args]) => {
    const code = buildCode.get(op)
    if (code === undefined) throw new Error(`unknown opcode ${op}`)
    return [code, ...args.map((value) => Number(value))]
  })
  const consts = program.consts.map((value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return { __number: String(value) }
    if (typeof value === 'bigint') return { __bigint: value.toString() }
    return value
  })
  const payload = {
    v: VM_FORMAT_VERSION,
    locals: program.locals,
    consts,
    code: encodedInstructions,
    steps: encodedInstructions.length,
  }
  const json = JSON.stringify(payload)
  const plaintext = utf8ToBytes(json)
  const sum = toHex(sm3(plaintext))
  const stream = keystream(key, 'code', plaintext.length)
  const ciphertext = Uint8Array.from(plaintext, (value, index) => value ^ stream[index])
  return {
    v: VM_FORMAT_VERSION,
    perm: perm.slice(),
    code: encodeTransport(ciphertext),
    sum,
    bytes: plaintext.length,
  }
}

/**
 * @param {object} blob
 * @param {Uint8Array|number[]} key
 * @returns {{consts: unknown[], locals: string[], code: Array<Array<number>>, perm: number[], instructions: number}}
 */
export function decodeBlob(blob, key) {
  if (!blob || blob.v !== VM_FORMAT_VERSION) throw new Error('unsupported VM blob version')
  const ciphertext = decodeTransport(blob.code)
  const stream = keystream(key, 'code', ciphertext.length)
  const plaintext = Uint8Array.from(ciphertext, (value, index) => value ^ stream[index])
  if (toHex(sm3(plaintext)) !== blob.sum) {
    const error = new Error('VM blob checksum mismatch')
    error.code = 'NSDK_VM_TAMPER'
    throw error
  }
  const payload = JSON.parse(bytesToUtf8(plaintext))
  if (payload.v !== VM_FORMAT_VERSION) throw new Error('unsupported VM payload version')
  const perm = blob.perm
  if (!Array.isArray(perm) || perm.length !== ISA.length) throw new Error('invalid opcode permutation')
  const handlerSeen = new Set(perm)
  if (handlerSeen.size !== ISA.length || perm.some((id) => !Number.isInteger(id) || id < 0 || id >= ISA.length)) {
    throw new Error('opcode permutation is not a permutation')
  }
  const consts = payload.consts.map((value) => {
    if (value && typeof value === 'object' && value.__number) return Number(value.__number)
    if (value && typeof value === 'object' && value.__bigint) return BigInt(value.__bigint)
    return value
  })
  const code = payload.code.map(([buildCode, ...args]) => {
    if (!Number.isInteger(buildCode) || buildCode < 0 || buildCode >= ISA.length) {
      throw new Error('instruction opcode out of range')
    }
    return [buildCode, ...args.map(Number)]
  })
  return { consts, locals: payload.locals, code, perm, instructions: code.length }
}

/**
 * Deterministic build-time permutation from the key, so a build seed reproduces
 * exactly the same container.
 * @param {Uint8Array|number[]} key
 * @returns {number[]}
 */
export function shuffleHandlerIds(key) {
  const ids = Array.from({ length: ISA.length }, (_, index) => index)
  const stream = keystream(key, 'perm', ISA.length * 4)
  let cursor = 0
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const value = (stream[cursor] << 24) | (stream[cursor + 1] << 16) | (stream[cursor + 2] << 8) | stream[cursor + 3]
    cursor = (cursor + 4) % stream.length
    const swap = Math.abs(value) % (index + 1)
    const tmp = ids[index]
    ids[index] = ids[swap]
    ids[swap] = tmp
  }
  return ids
}

/** @param {string} hexKey @returns {Uint8Array} */
export function keyFromHex(hexKey) {
  return fromHex(hexKey)
}

/**
 * Disassemble for tests and reports (never shipped in a protected bundle).
 * @param {ReturnType<typeof decodeBlob>} program
 * @returns {string[]}
 */
export function disassemble(program) {
  return program.code.map(([buildCode, ...args], pc) => {
    const handler = program.perm[buildCode]
    const name = ISA[handler]
    return `${String(pc).padStart(4, '0')} ${String(handler).padStart(2, '0')} ${name} ${args.join(' ')}`.trimEnd()
  })
}

void OPCODE_ID
void toHex
