/**
 * WASM Crypto SDK — key separation and authenticated streams backed by a
 * hand-assembled WebAssembly module.
 *
 * The module is generated from `wasm-module.js` (deterministic bytes, no
 * toolchain), hashed for allowlisting, instantiated once and self-tested before
 * any key material is used. The JavaScript wrapper then builds:
 *
 *   - a length-framed PRF over an 8-lane ARX permutation (WASM `permute`)
 *   - an HKDF-like extract/expand KDF with per-purpose `info` labels
 *   - key separation into independent `enc`, `mac` and `index` subkeys
 *   - an authenticated stream cipher (ARX keystream XOR + 256-bit MAC) where the
 *     XOR itself runs inside WASM linear memory
 *
 * This is a self-contained construction for key-separation and envelope
 * integrity work. It is not a replacement for AES-GCM/ChaCha20-Poly1305; pair it
 * with a standard AEAD for regulated production data.
 */
import { createHash, randomBytes } from 'node:crypto'
import { buildCryptoModule, MODULE_BASE64 } from './wasm-module.js'

export { buildCryptoModule, MODULE_BASE64 }
export const VERSION = '1.0.0'
export const ALGORITHM = 'WASM-XOR-MAC-256'
export const ROUNDS = 8
export const STATE_PTR = 0
export const BLOCK_PTR = 32
export const KEYSTREAM_PTR = 1024
export const DATA_PTR = 8192
export const CHUNK_SIZE = 4096

const IV = Object.freeze([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
const LABEL_STREAM = new TextEncoder().encode('ai4r.stream.v1')
const LABEL_TAG = new TextEncoder().encode('ai4r.tag.v1')
const LABEL_KID = new TextEncoder().encode('ai4r.kid.v1')
const LABEL_SUBKEY_SALT = new TextEncoder().encode('ai4r.subkey.salt.v1')
const MODULE_BYTES = buildCryptoModule()
export const MODULE_SHA256 = createHash('sha256').update(MODULE_BYTES).digest('hex')
export const MODULE_SIZE = MODULE_BYTES.length

export class WasmCryptoError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'WasmCryptoError'
    this.code = code
  }
}

/**
 * @param {string | Uint8Array} value
 * @returns {Buffer}
 */
function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new WasmCryptoError('BAD_INPUT', 'expected a string or byte array')
}

/** @param {...Uint8Array} arrays */
function concat(...arrays) {
  return Buffer.concat(arrays.map((array) => Buffer.from(array)))
}

/** @param {number} value */
function uint32be(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0)
  return buffer
}

/** @param {Uint8Array} bytes */
function base64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/** @param {string} text */
function base64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new WasmCryptoError('BAD_ENVELOPE', 'invalid base64url field')
  return Buffer.from(text, 'base64url')
}

/** @param {number} value @param {number} shift */
export function rotl32(value, shift) {
  const amount = shift & 31
  return ((value << amount) | (value >>> (32 - amount))) >>> 0
}

/** JavaScript reference for the WASM `mix` export. */
export function mixReference(left, right) {
  return (rotl32((left ^ right) >>> 0, 13) + rotl32(left >>> 0, 7)) >>> 0
}

/**
 * JavaScript reference for the WASM `permute` export, used by self-tests.
 * @param {number[]} lanes eight u32 values
 * @param {number} rounds
 */
export function permuteReference(lanes, rounds) {
  if (!Array.isArray(lanes) || lanes.length !== 8) throw new WasmCryptoError('BAD_STATE', 'permute needs exactly 8 lanes')
  const state = lanes.map((lane) => lane >>> 0)
  for (let round = 0; round < rounds; round += 1) {
    for (let lane = 0; lane < 8; lane += 1) {
      const a = state[lane]
      const b = state[(lane + 1) & 7]
      const c = state[(lane + 3) & 7]
      state[lane] = ((((rotl32((a ^ b) >>> 0, 13) + rotl32(c, 7)) >>> 0) ^ a) >>> 0)
    }
    state[0] = (state[0] ^ (Math.imul(0x9e3779b9, round + 1) >>> 0)) >>> 0
  }
  return state
}

/** Best-effort constant-time comparison for MAC tags. */
export function constantTimeEqual(left, right) {
  const a = toBytes(left)
  const b = toBytes(right)
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

/**
 * @typedef {{bytes: Uint8Array, digest: string, exports: Record<string, any>, memory: Uint8Array, selfTest: ReturnType<typeof runSelfTest>}} WasmApi
 */

/** @param {WasmApi} api @param {Uint8Array} bytes */
function hashWithApi(api, bytes) {
  const memory = api.memory
  const state = new DataView(memory.buffer, STATE_PTR, 32)
  const block = new DataView(memory.buffer, BLOCK_PTR, 32)
  for (let index = 0; index < 8; index += 1) state.setUint32(index * 4, IV[index], true)
  const absorb = (chunk) => {
    memory.set(chunk, BLOCK_PTR)
    for (let index = 0; index < 8; index += 1) {
      state.setUint32(index * 4, (state.getUint32(index * 4, true) ^ block.getUint32(index * 4, true)) >>> 0, true)
    }
    api.exports.permute(STATE_PTR, ROUNDS)
  }
  let offset = 0
  while (offset + 32 <= bytes.length) {
    absorb(bytes.subarray(offset, offset + 32))
    offset += 32
  }
  const tail = new Uint8Array(32)
  const remaining = bytes.length - offset
  tail.set(bytes.subarray(offset))
  tail[remaining] = 0x80
  absorb(tail)
  const lengthBlock = new Uint8Array(32)
  new DataView(lengthBlock.buffer).setBigUint64(0, BigInt(bytes.length), true)
  absorb(lengthBlock)
  return new Uint8Array(memory.slice(STATE_PTR, STATE_PTR + 32))
}

/** @param {WasmApi} api @param {Uint8Array} left @param {Uint8Array} right */
function xorInWasm(api, left, right) {
  if (left.length !== right.length) throw new WasmCryptoError('BAD_INPUT', 'xor operands must have equal length')
  const output = new Uint8Array(left.length)
  let offset = 0
  while (offset < left.length) {
    const size = Math.min(CHUNK_SIZE, left.length - offset)
    api.memory.set(left.subarray(offset, offset + size), DATA_PTR)
    api.memory.set(right.subarray(offset, offset + size), KEYSTREAM_PTR)
    api.exports.xorBuf(DATA_PTR, KEYSTREAM_PTR, size)
    output.set(api.memory.subarray(DATA_PTR, DATA_PTR + size), offset)
    offset += size
  }
  return output
}

/** @param {WasmApi} api @param {Uint8Array} key @param {Uint8Array} message */
function prfWithApi(api, key, message) {
  return hashWithApi(api, concat(uint32be(key.length), key, message))
}

/** @param {WasmApi} api @param {Uint8Array} key @param {Uint8Array} nonce @param {number} length */
function keystreamWithApi(api, key, nonce, length) {
  const blocks = Math.ceil(length / 32)
  const output = new Uint8Array(blocks * 32)
  for (let index = 0; index < blocks; index += 1) {
    output.set(prfWithApi(api, key, concat(nonce, uint32be(index), LABEL_STREAM)), index * 32)
  }
  return output.subarray(0, length)
}

/**
 * @param {WasmApi} api
 * @param {{ikm: string | Uint8Array, salt?: string | Uint8Array, info?: string | Uint8Array, length?: number}} options
 */
function deriveWithApi(api, options) {
  const ikm = toBytes(options?.ikm ?? '')
  if (ikm.length === 0) throw new WasmCryptoError('BAD_KEY', 'ikm is required')
  const length = options?.length ?? 32
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) throw new WasmCryptoError('BAD_LENGTH', 'length must be between 1 and 8160 bytes')
  const salt = options?.salt === undefined ? new Uint8Array(32) : toBytes(options.salt)
  const info = options?.info === undefined ? new Uint8Array(0) : toBytes(options.info)
  const prk = prfWithApi(api, salt.length === 0 ? new Uint8Array(32) : salt, ikm)
  const chunks = []
  let previous = new Uint8Array(0)
  let counter = 1
  let produced = 0
  while (produced < length) {
    previous = prfWithApi(api, prk, concat(previous, info, Uint8Array.of(counter)))
    chunks.push(previous)
    produced += previous.length
    counter += 1
    if (counter > 255) throw new WasmCryptoError('BAD_LENGTH', 'derived key exceeds HKDF block limit')
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, length)
}

/** @param {WasmApi} api @param {Uint8Array} master @param {string[]} labels */
function subkeysWithApi(api, master, labels = ['enc', 'mac']) {
  const salt = hashWithApi(api, LABEL_SUBKEY_SALT)
  const output = {}
  for (const label of labels) {
    output[label] = deriveWithApi(api, { ikm: master, salt, info: new TextEncoder().encode(label), length: 32 })
  }
  return output
}

/** @param {WasmApi} api @param {Uint8Array} master */
function keyIdWithApi(api, master) {
  return base64urlEncode(prfWithApi(api, master, LABEL_KID).subarray(0, 8))
}

/**
 * @param {WasmApi} api
 * @returns {{ok: boolean, vectors: {xor: string, xorBuf: string, rotl: string, mix: string, permute: string, hashAbc: string}}}
 */
function runSelfTest(api) {
  const memory = api.memory
  const sample = Uint8Array.from({ length: 16 }, (_, index) => (index * 7) & 0xff)
  memory.set(sample, KEYSTREAM_PTR)
  api.exports.xor(KEYSTREAM_PTR, sample.length, 0x5a)
  const xored = Array.from(memory.slice(KEYSTREAM_PTR, KEYSTREAM_PTR + sample.length))
  const xorOk = sample.every((byte, index) => xored[index] === (byte ^ 0x5a))
  const rotl = api.exports.rotl(0x12345678, 8) >>> 0
  const rotlOk = rotl === 0x34567812
  const mix = api.exports.mix(0x11111111, 0x22222222) >>> 0
  const mixOk = mix === mixReference(0x11111111, 0x22222222)
  const permuteView = new DataView(memory.buffer, KEYSTREAM_PTR, 32)
  IV.forEach((lane, index) => permuteView.setUint32(index * 4, lane, true))
  api.exports.permute(KEYSTREAM_PTR, 4)
  const permuted = Array.from({ length: 8 }, (_, index) => permuteView.getUint32(index * 4, true))
  const expectedPermute = permuteReference(IV, 4)
  const permuteOk = permuted.every((lane, index) => lane === expectedPermute[index])
  const left = Uint8Array.from([1, 2, 3, 4])
  const right = Uint8Array.from([0x10, 0x20, 0x30, 0x40])
  memory.set(left, DATA_PTR)
  memory.set(right, KEYSTREAM_PTR)
  api.exports.xorBuf(DATA_PTR, KEYSTREAM_PTR, 4)
  const xorBuf = Array.from(memory.slice(DATA_PTR, DATA_PTR + 4))
  const xorBufOk = xorBuf.every((byte, index) => byte === (left[index] ^ right[index]))
  const hashAbc = Buffer.from(hashWithApi(api, Buffer.from('abc'))).toString('hex')
  return {
    ok: xorOk && rotlOk && mixOk && permuteOk && xorBufOk && hashAbc.length === 64,
    vectors: {
      xor: Buffer.from(xored).toString('hex'),
      xorBuf: Buffer.from(xorBuf).toString('hex'),
      rotl: rotl.toString(16).padStart(8, '0'),
      mix: mix.toString(16).padStart(8, '0'),
      permute: permuted.map((lane) => lane.toString(16).padStart(8, '0')).join(''),
      hashAbc,
    },
  }
}

/** @type {Promise<WasmApi> | null} */
let pending = null

/**
 * Compile, instantiate and self-test the WASM module exactly once.
 * @returns {Promise<WasmApi>}
 */
export function loadWasmCrypto() {
  if (pending) return pending
  pending = (async () => {
    let instance
    try {
      ;({ instance } = await WebAssembly.instantiate(MODULE_BYTES))
    } catch (error) {
      throw new WasmCryptoError('WASM_COMPILE', `WASM module failed to compile: ${/** @type {Error} */ (error).message}`)
    }
    const exports = instance.exports
    for (const name of ['xor', 'rotl', 'mix', 'permute', 'xorBuf']) {
      if (typeof exports[name] !== 'function') throw new WasmCryptoError('WASM_EXPORTS', `WASM module is missing export ${name}`)
    }
    if (!(exports.memory instanceof WebAssembly.Memory)) throw new WasmCryptoError('WASM_EXPORTS', 'WASM module is missing memory')
    const api = {
      bytes: MODULE_BYTES,
      digest: MODULE_SHA256,
      exports,
      memory: new Uint8Array(exports.memory.buffer),
      selfTest: /** @type {any} */ (null),
    }
    const selfTest = runSelfTest(api)
    api.selfTest = selfTest
    if (!selfTest.ok) throw new WasmCryptoError('SELFTEST_FAILED', 'WASM self-test vectors do not match the JavaScript reference')
    return Object.freeze(api)
  })()
  pending.catch(() => {
    pending = null
  })
  return pending
}

/**
 * Loaded, self-tested crypto facade. Methods are synchronous once the module is
 * ready; `WasmCrypto.create()` is the async entry point.
 */
export class WasmCrypto {
  /** @type {WasmApi} */
  #api

  /** @param {WasmApi} api */
  constructor(api) {
    if (!api?.selfTest?.ok) throw new WasmCryptoError('NOT_READY', 'pass a self-tested API from loadWasmCrypto()')
    this.#api = api
  }

  static async create() {
    return new WasmCrypto(await loadWasmCrypto())
  }

  get moduleDigest() {
    return this.#api.digest
  }

  get moduleSize() {
    return this.#api.bytes.length
  }

  get moduleBase64() {
    return Buffer.from(this.#api.bytes).toString('base64')
  }

  selfTest() {
    return this.#api.selfTest
  }

  /** @param {string | Uint8Array} input */
  hash(input) {
    return hashWithApi(this.#api, toBytes(input))
  }

  /**
   * Length-framed PRF: SHA-like compression over `len(key) || key || message`.
   * @param {string | Uint8Array} key
   * @param {string | Uint8Array} message
   */
  prf(key, message) {
    return prfWithApi(this.#api, toBytes(key), toBytes(message))
  }

  /**
   * HKDF-like extract/expand.
   * @param {{ikm: string | Uint8Array, salt?: string | Uint8Array, info?: string | Uint8Array, length?: number}} options
   */
  deriveKey(options) {
    return deriveWithApi(this.#api, options)
  }

  /**
   * Split one master secret into purpose-bound subkeys.
   * @param {string | Uint8Array} master
   * @param {string[]} [labels]
   */
  deriveSubkeys(master, labels = ['enc', 'mac', 'index']) {
    const bytes = toBytes(master)
    if (bytes.length < 16) throw new WasmCryptoError('BAD_KEY', 'master key must be at least 16 bytes')
    return subkeysWithApi(this.#api, bytes, labels)
  }

  /**
   * Seal bytes with the authenticated WASM stream construction.
   * @param {string | Uint8Array} master
   * @param {string | Uint8Array} plaintext
   * @param {{aad?: string | Uint8Array, nonce?: string | Uint8Array}} [options]
   */
  seal(master, plaintext, options = {}) {
    const masterBytes = toBytes(master)
    if (masterBytes.length < 16) throw new WasmCryptoError('BAD_KEY', 'master key must be at least 16 bytes')
    const bytes = toBytes(plaintext)
    const nonce = options.nonce === undefined ? randomBytes(16) : toBytes(options.nonce)
    if (nonce.length < 8) throw new WasmCryptoError('BAD_NONCE', 'nonce must be at least 8 bytes')
    const aad = options.aad === undefined ? new Uint8Array(0) : toBytes(options.aad)
    const { enc, mac } = subkeysWithApi(this.#api, masterBytes, ['enc', 'mac'])
    const ciphertext = xorInWasm(this.#api, bytes, keystreamWithApi(this.#api, enc, nonce, bytes.length))
    const tag = prfWithApi(this.#api, mac, concat(nonce, aad, ciphertext, LABEL_TAG))
    return {
      v: 1,
      alg: ALGORITHM,
      kid: keyIdWithApi(this.#api, masterBytes),
      nonce: base64urlEncode(nonce),
      aad: aad.length > 0 ? base64urlEncode(aad) : null,
      ct: base64urlEncode(ciphertext),
      tag: base64urlEncode(tag),
    }
  }

  /**
   * Open an envelope. The MAC is checked before any plaintext is produced.
   * @param {string | Uint8Array} master
   * @param {ReturnType<WasmCrypto['seal']>} envelope
   * @param {{aad?: string | Uint8Array, text?: boolean}} [options]
   */
  open(master, envelope, options = {}) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== ALGORITHM || typeof envelope.ct !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.nonce !== 'string') {
      throw new WasmCryptoError('BAD_ENVELOPE', 'unsupported or malformed envelope')
    }
    const masterBytes = toBytes(master)
    if (masterBytes.length < 16) throw new WasmCryptoError('BAD_KEY', 'master key must be at least 16 bytes')
    const nonce = base64urlDecode(envelope.nonce)
    const ciphertext = base64urlDecode(envelope.ct)
    const tag = base64urlDecode(envelope.tag)
    const aad = options.aad !== undefined ? toBytes(options.aad) : envelope.aad ? base64urlDecode(envelope.aad) : new Uint8Array(0)
    const { enc, mac } = subkeysWithApi(this.#api, masterBytes, ['enc', 'mac'])
    if (envelope.kid !== keyIdWithApi(this.#api, masterBytes)) throw new WasmCryptoError('AUTH_FAILED', 'envelope is bound to a different key')
    const expectedTag = prfWithApi(this.#api, mac, concat(nonce, aad, ciphertext, LABEL_TAG))
    if (!constantTimeEqual(tag, expectedTag)) throw new WasmCryptoError('AUTH_FAILED', 'authentication tag mismatch (wrong key, AAD or tampered ciphertext)')
    const plaintext = xorInWasm(this.#api, ciphertext, keystreamWithApi(this.#api, enc, nonce, ciphertext.length))
    return options.text ? Buffer.from(plaintext).toString('utf8') : plaintext
  }
}

/**
 * @returns {Promise<WasmCrypto>}
 */
export async function createWasmCrypto() {
  return WasmCrypto.create()
}
