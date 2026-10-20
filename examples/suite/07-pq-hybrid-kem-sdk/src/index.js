/**
 * Post-Quantum Hybrid KEM SDK.
 *
 * The classical half is ephemeral P-256 ECDH through WebCrypto (X25519 is not
 * available in every WebCrypto build). The post-quantum half is a deliberately
 * small, NTT-free module-LWE KEM over Z_q[x]/(x^64 + 1) with rank 2, q = 3329
 * and CBD(eta = 1) noise — schoolbook polynomial multiplication, Kyber-style
 * message encoding and a ciphertext check hash. Both shared secrets are merged
 * with HKDF-SHA-256 and bound to a transcript of the public keys, ciphertext
 * and application context, so breaking either half alone does not recover the
 * session key.
 *
 * The lattice KEM is an educational "toy ML-KEM" with 64 coefficient rings; it
 * is structurally faithful (LWE, compression, FO-style check) but NOT a
 * production ML-KEM/Kyber implementation. Use a reviewed library for real
 * post-quantum deployments.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

export const VERSION = '1.0.0'
export const RING_N = 64
export const MODULUS = 3329
export const RANK = 2
export const ETA = 1
export const CLASSICAL_CURVE = 'P-256'
export const ALGORITHM = 'P256-ECDH+MLKEM64-HKDF-SHA256'
const SHARED_DOMAIN = 'toy-mlkem-shared-v1'
const HKDF_INFO_PREFIX = 'hybrid-kem-v1:'
const encoder = new TextEncoder()

export class KemError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code)
    this.name = 'KemError'
    this.code = code
  }
}

/** @param {number} length */
export function randomBytes(length) {
  return new Uint8Array(nodeRandomBytes(length))
}

/** @param {...(Uint8Array|Buffer|string)} chunks */
export function sha256(...chunks) {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
  return new Uint8Array(hash.digest())
}

/** @param {...(Uint8Array|Buffer)} chunks @returns {Uint8Array} */
export function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/** @param {string} text */
export function fromBase64Url(text) {
  try {
    return new Uint8Array(Buffer.from(String(text), 'base64url'))
  } catch {
    throw new KemError('BAD_ENCODING', 'invalid base64url')
  }
}

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

/** @param {number} value */
function modQ(value) {
  const reduced = value % MODULUS
  return (reduced + MODULUS) % MODULUS
}

/** @returns {Uint16Array} */
function zeroPoly() {
  return new Uint16Array(RING_N)
}

/** @param {Uint16Array} left @param {Uint16Array} right */
export function polyAdd(left, right) {
  const output = zeroPoly()
  for (let index = 0; index < RING_N; index += 1) output[index] = modQ(left[index] + right[index])
  return output
}

/** @param {Uint16Array} left @param {Uint16Array} right */
export function polySub(left, right) {
  const output = zeroPoly()
  for (let index = 0; index < RING_N; index += 1) output[index] = modQ(left[index] - right[index])
  return output
}

/**
 * Schoolbook negacyclic multiplication in Z_q[x]/(x^64 + 1).
 * @param {Uint16Array} left
 * @param {Uint16Array} right
 * @returns {Uint16Array}
 */
export function polyMul(left, right) {
  const wide = new Int32Array(RING_N * 2)
  for (let i = 0; i < RING_N; i += 1) {
    if (left[i] === 0) continue
    for (let j = 0; j < RING_N; j += 1) wide[i + j] += left[i] * right[j]
  }
  const output = zeroPoly()
  for (let index = 0; index < RING_N; index += 1) {
    const folded = wide[index] - wide[index + RING_N]
    output[index] = modQ(folded)
  }
  return output
}

/** @param {Uint16Array[][]} matrix @param {Uint16Array[]} vector */
export function matrixVectorMul(matrix, vector) {
  const output = []
  for (let row = 0; row < matrix.length; row += 1) {
    let accumulator = zeroPoly()
    for (let column = 0; column < matrix[row].length; column += 1) {
      accumulator = polyAdd(accumulator, polyMul(matrix[row][column], vector[column]))
    }
    output.push(accumulator)
  }
  return output
}

/** @param {Uint16Array[][]} matrix @param {Uint16Array[]} vector */
export function transposeVectorMul(matrix, vector) {
  const output = []
  for (let column = 0; column < matrix.length; column += 1) {
    let accumulator = zeroPoly()
    for (let row = 0; row < matrix.length; row += 1) {
      accumulator = polyAdd(accumulator, polyMul(matrix[row][column], vector[row]))
    }
    output.push(accumulator)
  }
  return output
}

/** @param {Uint16Array[]} vector @param {Uint16Array[]} other */
export function innerProduct(vector, other) {
  let accumulator = zeroPoly()
  for (let index = 0; index < vector.length; index += 1) {
    accumulator = polyAdd(accumulator, polyMul(vector[index], other[index]))
  }
  return accumulator
}

/** @param {Uint8Array} seed @param {number} length @param {number} domain */
function xof(seed, length, domain) {
  const output = new Uint8Array(length)
  let offset = 0
  let counter = 0
  while (offset < length) {
    const header = Uint8Array.of(domain, (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff)
    const block = sha256(seed, header)
    const take = Math.min(32, length - offset)
    output.set(block.subarray(0, take), offset)
    offset += take
    counter += 1
  }
  return output
}

/** @param {Uint8Array} bytes */
function sampleUniformPoly(bytes) {
  if (bytes.length !== RING_N * 2) throw new KemError('BAD_XOF', 'uniform sampler needs 128 bytes')
  const poly = zeroPoly()
  for (let index = 0; index < RING_N; index += 1) {
    const value = bytes[index * 2] | (bytes[index * 2 + 1] << 8)
    poly[index] = value % MODULUS
  }
  return poly
}

/**
 * Centered binomial distribution with eta = 1 (coefficients in {-1, 0, 1}).
 * @param {Uint8Array} bytes
 * @param {number} [eta]
 */
export function sampleCbd(bytes, eta = ETA) {
  const needed = Math.ceil((RING_N * eta * 2) / 8)
  if (!(bytes instanceof Uint8Array) || bytes.length < needed) throw new KemError('BAD_NOISE', `CBD needs ${needed} bytes`)
  const bit = (position) => (bytes[position >> 3] >> (position & 7)) & 1
  const poly = zeroPoly()
  let cursor = 0
  for (let index = 0; index < RING_N; index += 1) {
    let positive = 0
    let negative = 0
    for (let count = 0; count < eta; count += 1) positive += bit(cursor++)
    for (let count = 0; count < eta; count += 1) negative += bit(cursor++)
    poly[index] = modQ(positive - negative)
  }
  return poly
}

/** @param {Uint8Array} seed */
export function matrixFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new KemError('BAD_SEED', 'matrix seed must be 32 bytes')
  const bytes = xof(seed, RANK * RANK * RING_N * 2, 0x01)
  const matrix = []
  let offset = 0
  for (let row = 0; row < RANK; row += 1) {
    const line = []
    for (let column = 0; column < RANK; column += 1) {
      line.push(sampleUniformPoly(bytes.subarray(offset, offset + RING_N * 2)))
      offset += RING_N * 2
    }
    matrix.push(line)
  }
  return matrix
}

/** @param {Uint16Array} poly @returns {Uint8Array} */
export function encodePoly(poly) {
  const bytes = new Uint8Array(RING_N * 2)
  for (let index = 0; index < RING_N; index += 1) {
    bytes[index * 2] = poly[index] & 0xff
    bytes[index * 2 + 1] = (poly[index] >>> 8) & 0xff
  }
  return bytes
}

/** @param {Uint8Array} bytes @returns {Uint16Array} */
export function decodePoly(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== RING_N * 2) throw new KemError('BAD_POLY', 'poly must be 128 bytes')
  const poly = zeroPoly()
  for (let index = 0; index < RING_N; index += 1) {
    const value = bytes[index * 2] | (bytes[index * 2 + 1] << 8)
    if (value >= MODULUS) throw new KemError('BAD_POLY', 'coefficient out of range')
    poly[index] = value
  }
  return poly
}

/** @param {Uint8Array} message 8-byte message */
export function polyFromMessage(message) {
  if (!(message instanceof Uint8Array) || message.length !== 8) throw new KemError('BAD_MESSAGE', 'message must be 8 bytes')
  const poly = zeroPoly()
  for (let index = 0; index < RING_N; index += 1) {
    const bit = (message[index >> 3] >> (index & 7)) & 1
    poly[index] = bit ? Math.floor(MODULUS / 2) : 0
  }
  return poly
}

/** @param {number} value @returns {0|1} */
export function compressCoefficient(value) {
  return Math.floor((2 * modQ(value) + Math.floor(MODULUS / 2)) / MODULUS) & 1
}

/** @param {Uint16Array} poly @returns {Uint8Array} */
export function polyToMessage(poly) {
  const message = new Uint8Array(8)
  for (let index = 0; index < RING_N; index += 1) {
    if (compressCoefficient(poly[index])) message[index >> 3] |= 1 << (index & 7)
  }
  return message
}

/**
 * @param {{seed: Uint8Array, t: Uint16Array[]}} publicKey
 * @returns {Uint8Array}
 */
export function encodePublicKey(publicKey) {
  if (!publicKey || !(publicKey.seed instanceof Uint8Array) || publicKey.seed.length !== 32) throw new KemError('BAD_PUBLIC_KEY', 'public key seed missing')
  if (!Array.isArray(publicKey.t) || publicKey.t.length !== RANK) throw new KemError('BAD_PUBLIC_KEY', 'public key vector missing')
  const header = Uint8Array.of(1)
  const t = concatBytes(...publicKey.t.map(encodePoly))
  return concatBytes(header, publicKey.seed, t)
}

/** @param {Uint8Array|string} input @returns {{seed: Uint8Array, t: Uint16Array[]}} */
export function decodePublicKey(input) {
  const bytes = typeof input === 'string' ? fromBase64Url(input) : input
  if (!(bytes instanceof Uint8Array) || bytes.length !== 1 + 32 + RANK * RING_N * 2) throw new KemError('BAD_PUBLIC_KEY', 'public key length mismatch')
  if (bytes[0] !== 1) throw new KemError('BAD_PUBLIC_KEY', 'unsupported public key version')
  const seed = bytes.subarray(1, 33)
  const t = []
  let offset = 33
  for (let index = 0; index < RANK; index += 1) {
    t.push(decodePoly(bytes.subarray(offset, offset + RING_N * 2)))
    offset += RING_N * 2
  }
  return { v: 1, seed: new Uint8Array(seed), t }
}

/** @param {{s: Uint16Array[]}} secretKey */
export function encodeSecretKey(secretKey) {
  if (!secretKey || !Array.isArray(secretKey.s) || secretKey.s.length !== RANK) throw new KemError('BAD_SECRET_KEY', 'secret key vector missing')
  return concatBytes(Uint8Array.of(1), ...secretKey.s.map(encodePoly))
}

/** @param {Uint8Array|string} input */
export function decodeSecretKey(input) {
  const bytes = typeof input === 'string' ? fromBase64Url(input) : input
  if (!(bytes instanceof Uint8Array) || bytes.length !== 1 + RANK * RING_N * 2) throw new KemError('BAD_SECRET_KEY', 'secret key length mismatch')
  if (bytes[0] !== 1) throw new KemError('BAD_SECRET_KEY', 'unsupported secret key version')
  const s = []
  let offset = 1
  for (let index = 0; index < RANK; index += 1) {
    s.push(decodePoly(bytes.subarray(offset, offset + RING_N * 2)))
    offset += RING_N * 2
  }
  return { v: 1, s }
}

/** @param {{u: Uint16Array[], v: Uint16Array, check: Uint8Array}} ciphertext */
export function encodeCiphertext(ciphertext) {
  if (!ciphertext || !Array.isArray(ciphertext.u) || ciphertext.u.length !== RANK) throw new KemError('BAD_CIPHERTEXT', 'ciphertext vector missing')
  if (!(ciphertext.check instanceof Uint8Array) || ciphertext.check.length !== 32) throw new KemError('BAD_CIPHERTEXT', 'ciphertext check missing')
  return concatBytes(Uint8Array.of(1), ...ciphertext.u.map(encodePoly), encodePoly(ciphertext.v), ciphertext.check)
}

/** @param {Uint8Array|string} input */
export function decodeCiphertext(input) {
  const bytes = typeof input === 'string' ? fromBase64Url(input) : input
  const expected = 1 + RANK * RING_N * 2 + RING_N * 2 + 32
  if (!(bytes instanceof Uint8Array) || bytes.length !== expected) throw new KemError('BAD_CIPHERTEXT', 'ciphertext length mismatch')
  if (bytes[0] !== 1) throw new KemError('BAD_CIPHERTEXT', 'unsupported ciphertext version')
  const u = []
  let offset = 1
  for (let index = 0; index < RANK; index += 1) {
    u.push(decodePoly(bytes.subarray(offset, offset + RING_N * 2)))
    offset += RING_N * 2
  }
  const v = decodePoly(bytes.subarray(offset, offset + RING_N * 2))
  offset += RING_N * 2
  return { version: 1, u, v, check: new Uint8Array(bytes.subarray(offset, offset + 32)) }
}

/** @param {Uint8Array} master @param {number} domain @param {number} count */
function noisePolys(master, domain, count) {
  const perPoly = Math.ceil((RING_N * ETA * 2) / 8)
  const bytes = xof(master, perPoly * count, domain)
  return Array.from({ length: count }, (_, index) => sampleCbd(bytes.subarray(index * perPoly, (index + 1) * perPoly)))
}

/** @param {Uint8Array} seed @param {string} label */
function requireSeed(seed, label) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new KemError('BAD_SEED', `${label} must be 32 bytes`)
  return seed
}

/**
 * @param {{aSeed?: Uint8Array, noiseSeed?: Uint8Array}} [options]
 * @returns {{publicKey: object, secretKey: object, keyId: string}}
 */
export function generatePqKeyPair(options = {}) {
  const aSeed = requireSeed(options.aSeed ?? randomBytes(32), 'aSeed')
  const noiseSeed = requireSeed(options.noiseSeed ?? randomBytes(32), 'noiseSeed')
  const matrix = matrixFromSeed(aSeed)
  const s = noisePolys(noiseSeed, 0x02, RANK)
  const e = noisePolys(noiseSeed, 0x03, RANK)
  const t = matrixVectorMul(matrix, s).map((poly, index) => polyAdd(poly, e[index]))
  const publicKey = { v: 1, seed: new Uint8Array(aSeed), t }
  const secretKey = { v: 1, s }
  const keyId = toBase64Url(sha256(encodePublicKey(publicKey)).subarray(0, 16))
  return { publicKey, secretKey, keyId }
}

/**
 * @param {object} publicKey
 * @param {{seed?: Uint8Array}} [options]
 * @returns {{sharedSecret: Uint8Array, ciphertext: object, encoded: Uint8Array}}
 */
export function encapsulatePq(publicKey, options = {}) {
  const decoded = publicKey?.v === 1 && Array.isArray(publicKey.t) ? publicKey : decodePublicKey(publicKey)
  const seed = requireSeed(options.seed ?? randomBytes(32), 'encapsulation seed')
  const matrix = matrixFromSeed(decoded.seed)
  const message = xof(seed, 8, 0x10)
  const r = noisePolys(seed, 0x11, RANK)
  const e1 = noisePolys(seed, 0x12, RANK)
  const e2 = noisePolys(seed, 0x13, 1)[0]
  const u = transposeVectorMul(matrix, r).map((poly, index) => polyAdd(poly, e1[index]))
  const v = polyAdd(polyAdd(innerProduct(decoded.t, r), e2), polyFromMessage(message))
  const ciphertext = { version: 1, u, v, check: sha256(message) }
  const encoded = encodeCiphertext(ciphertext)
  const sharedSecret = sha256(SHARED_DOMAIN, message, sha256(encoded))
  return { sharedSecret, ciphertext, encoded }
}

/**
 * @param {object} secretKey
 * @param {object|string|Uint8Array} ciphertext
 * @returns {{sharedSecret: Uint8Array, encoded: Uint8Array}}
 */
export function decapsulatePq(secretKey, ciphertext) {
  const decodedKey = secretKey.v === 1 && Array.isArray(secretKey.s) ? secretKey : decodeSecretKey(secretKey)
  const decoded = typeof ciphertext === 'object' && Array.isArray(ciphertext?.u) ? ciphertext : decodeCiphertext(ciphertext)
  const encoded = encodeCiphertext(decoded)
  const difference = polySub(decoded.v, innerProduct(decodedKey.s, decoded.u))
  const message = polyToMessage(difference)
  if (!equalBytes(sha256(message), decoded.check)) throw new KemError('BAD_CIPHERTEXT', 'ciphertext failed its check hash')
  const sharedSecret = sha256(SHARED_DOMAIN, message, sha256(encoded))
  return { sharedSecret, encoded }
}

/** @param {object} publicKey */
export function pqFingerprint(publicKey) {
  const decoded = publicKey?.v === 1 && Array.isArray(publicKey.t) ? publicKey : decodePublicKey(publicKey)
  return toBase64Url(sha256(encodePublicKey(decoded)).subarray(0, 16))
}

/** @param {CryptoKey} key */
async function exportPublicJwk(key) {
  const jwk = await crypto.subtle.exportKey('jwk', key)
  return { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }
}

/** @param {object} jwk */
function normalizePublicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== CLASSICAL_CURVE || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new KemError('BAD_PUBLIC_KEY', 'classical key must be a P-256 EC JWK')
  }
  return { kty: 'EC', crv: CLASSICAL_CURVE, x: jwk.x, y: jwk.y }
}

/** @param {object} jwk */
async function importPublicJwk(jwk) {
  return crypto.subtle.importKey('jwk', normalizePublicJwk(jwk), { name: 'ECDH', namedCurve: CLASSICAL_CURVE }, false, [])
}

/** @param {any} value @returns {string} */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {object} publicKey */
export function hybridFingerprint(publicKey) {
  if (!publicKey || publicKey.alg !== ALGORITHM) throw new KemError('BAD_PUBLIC_KEY', 'unsupported hybrid algorithm')
  const canonical = {
    alg: ALGORITHM,
    classical: normalizePublicJwk(publicKey.classical),
    pq: String(publicKey.pq),
  }
  decodePublicKey(publicKey.pq)
  return toBase64Url(sha256(canonicalJson(canonical)).subarray(0, 32))
}

/** @param {object} classic @param {Uint8Array} pq @param {Uint8Array} transcript @param {string} context */
async function combineSecrets(classic, pq, transcript, context) {
  const material = await crypto.subtle.importKey('raw', concatBytes(classic, pq), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: transcript, info: encoder.encode(HKDF_INFO_PREFIX + context) },
    material,
    256,
  )
  return new Uint8Array(bits)
}

/** @param {{epk: object, pq: string, recipient: string, contextHash: string}} envelope */
function transcriptFor(envelope) {
  return sha256(canonicalJson({ alg: ALGORITHM, epk: envelope.epk, pq: envelope.pq, recipient: envelope.recipient, contextHash: envelope.contextHash }))
}

/**
 * Create a hybrid KEM instance (classical ECDH key + PQ key pair).
 * @param {{aSeed?: Uint8Array, noiseSeed?: Uint8Array}} [options]
 */
export async function createHybridKem(options = {}) {
  const pq = generatePqKeyPair(options)
  const classical = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CLASSICAL_CURVE }, true, ['deriveBits'])
  const publicKey = {
    v: 1,
    alg: ALGORITHM,
    classical: await exportPublicJwk(classical.publicKey),
    pq: toBase64Url(encodePublicKey(pq.publicKey)),
  }
  const fingerprint = hybridFingerprint(publicKey)
  const instance = {
    v: 1,
    alg: ALGORITHM,
    publicKey,
    fingerprint,
    classicalPrivateKey: classical.privateKey,
    pqSecretKey: pq.secretKey,
  }
  instance.encapsulate = (recipient, encapsulateOptions) => encapsulateHybrid(recipient, encapsulateOptions)
  instance.decapsulate = (envelope, decapsulateOptions) => decapsulateHybrid(instance, envelope, decapsulateOptions)
  instance.exportPublicKey = () => JSON.parse(canonicalJson(publicKey))
  return instance
}

/**
 * @param {object} recipient hybrid public key JSON
 * @param {{context?: string, pqSeed?: Uint8Array}} [options]
 * @returns {Promise<{sharedSecret: Uint8Array, envelope: object}>}
 */
export async function encapsulateHybrid(recipient, options = {}) {
  const recipientFingerprint = hybridFingerprint(recipient)
  const context = options.context ?? ''
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CLASSICAL_CURVE }, true, ['deriveBits'])
  const peer = await importPublicJwk(recipient.classical)
  const classicSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ephemeral.privateKey, 256))
  const pq = encapsulatePq(decodePublicKey(recipient.pq), { seed: options.pqSeed })
  const epk = await exportPublicJwk(ephemeral.publicKey)
  const contextHash = toBase64Url(sha256(context))
  const transcriptEnvelope = { epk, pq: toBase64Url(pq.encoded), recipient: recipientFingerprint, contextHash }
  const transcript = transcriptFor(transcriptEnvelope)
  const sharedSecret = await combineSecrets(classicSecret, pq.sharedSecret, transcript, context)
  const tag = toBase64Url(sha256(sharedSecret, transcript).subarray(0, 8))
  return {
    sharedSecret,
    envelope: { v: 1, alg: ALGORITHM, ...transcriptEnvelope, tag },
  }
}

/**
 * @param {object} instance result of createHybridKem
 * @param {object} envelope
 * @param {{context?: string}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function decapsulateHybrid(instance, envelope, options = {}) {
  if (!envelope || envelope.alg !== ALGORITHM || envelope.v !== 1) throw new KemError('BAD_ENVELOPE', 'unsupported hybrid envelope')
  if (envelope.recipient !== instance.fingerprint) throw new KemError('WRONG_RECIPIENT', 'envelope is bound to a different recipient')
  const context = options.context ?? ''
  const contextHash = toBase64Url(sha256(context))
  if (envelope.contextHash !== contextHash) throw new KemError('CONTEXT_MISMATCH', 'envelope context does not match')
  if (typeof envelope.pq !== 'string' || typeof envelope.tag !== 'string') throw new KemError('BAD_ENVELOPE', 'envelope is incomplete')
  const epk = typeof envelope.epk === 'string' ? JSON.parse(envelope.epk) : envelope.epk
  const peer = await importPublicJwk(epk)
  const classicSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, instance.classicalPrivateKey, 256))
  const pq = decapsulatePq(instance.pqSecretKey, envelope.pq)
  const transcriptEnvelope = { epk: normalizePublicJwk(epk), pq: envelope.pq, recipient: instance.fingerprint, contextHash }
  const transcript = transcriptFor(transcriptEnvelope)
  const sharedSecret = await combineSecrets(classicSecret, pq.sharedSecret, transcript, context)
  const expectedTag = sha256(sharedSecret, transcript).subarray(0, 8)
  const receivedTag = fromBase64Url(envelope.tag)
  if (!equalBytes(receivedTag, expectedTag)) throw new KemError('HYBRID_TAMPERED', 'hybrid tag verification failed')
  return sharedSecret
}

/** @param {Uint8Array} secret @param {number} [length] */
export function secretToHex(secret, length = secret.length) {
  return Buffer.from(secret).toString('hex').slice(0, length * 2)
}

/** @param {object} publicKey */
export function publicKeySummary(publicKey) {
  const pq = decodePublicKey(publicKey.pq)
  return {
    alg: publicKey.alg,
    fingerprint: hybridFingerprint(publicKey),
    pqKeyId: pqFingerprint(pq),
    curve: publicKey.classical.crv,
    ring: RING_N,
    rank: RANK,
    modulus: MODULUS,
  }
}
