/**
 * SM2 (GB/T 32918) — key derivation, signatures and ECDH.
 *
 * Implemented over `BigInt` with Jacobian coordinates so a signing operation
 * costs one field inversion instead of one per point addition. The curve is the
 * standard `sm2p256v1`; `Z` and the default user identifier follow GB/T
 * 32918.2-2016, which is what makes signatures interoperable with national
 * PKI stacks.
 *
 * Signature encoding is raw `r || s` (64 bytes, hex) internally; DER is
 * provided for interop with tooling that speaks ASN.1.
 */

import { concatBytes, fromHex, toHex, utf8ToBytes } from './bytes.js'
import { sm3 } from './hash.js'

/** Field prime. */
export const SM2_P = 0xfffffffeffffffffffffffffffffffffffffffff00000000ffffffffffffffffn
/** Curve coefficient a = p - 3. */
export const SM2_A = 0xfffffffeffffffffffffffffffffffffffffffff00000000fffffffffffffffcn
/** Curve coefficient b. */
export const SM2_B = 0x28e9fa9e9d9f5e344d5a9e4bcf6509a7f39789f515ab8f92ddbcbd414d940e93n
/** Group order. */
export const SM2_N = 0xfffffffeffffffffffffffffffffffff7203df6b21c6052b53bbf40939d54123n
/** Generator. */
export const SM2_G = Object.freeze({
  x: 0x32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7n,
  y: 0xbc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0n,
})
/** Default user identifier from GB/T 32918.2. */
export const SM2_DEFAULT_ID = '1234567812345678'

const INFINITY = Object.freeze({ x: 0n, y: 1n, z: 0n })

/** @param {bigint} value @param {bigint} modulus @returns {bigint} */
export function mod(value, modulus) {
  const result = value % modulus
  return result >= 0n ? result : result + modulus
}

/**
 * Modular exponentiation.
 * @param {bigint} base
 * @param {bigint} exponent
 * @param {bigint} modulus
 * @returns {bigint}
 */
export function modPow(base, exponent, modulus) {
  let result = 1n
  let factor = mod(base, modulus)
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

/**
 * Extended Euclidean inverse.
 * @param {bigint} value
 * @param {bigint} modulus
 * @returns {bigint}
 */
export function modInverse(value, modulus) {
  let old_r = mod(value, modulus)
  let r = modulus
  let old_s = 1n
  let s = 0n
  while (r !== 0n) {
    const quotient = old_r / r
    const nextR = old_r - quotient * r
    old_r = r
    r = nextR
    const nextS = old_s - quotient * s
    old_s = s
    s = nextS
  }
  if (old_r !== 1n) throw new RangeError('value is not invertible modulo the group order')
  return mod(old_s, modulus)
}

/**
 * @param {bigint} value
 * @param {number} [bytes]
 * @returns {string}
 */
export function bigToHex(value, bytes = 32) {
  let hex = value.toString(16)
  if (hex.length > bytes * 2) hex = hex.slice(-bytes * 2)
  return hex.padStart(bytes * 2, '0')
}

/**
 * @param {string} hex
 * @returns {bigint}
 */
export function hexToBig(hex) {
  const clean = String(hex).replace(/^0x/i, '')
  if (clean.length === 0) return 0n
  return BigInt(`0x${clean}`)
}

/** @param {Uint8Array|number[]} bytes @returns {bigint} */
export function bytesToBig(bytes) {
  let value = 0n
  for (let index = 0; index < bytes.length; index += 1) value = (value << 8n) | BigInt(bytes[index] & 0xff)
  return value
}

/** @param {bigint} value @param {number} length @returns {Uint8Array} */
export function bigToBytes(value, length = 32) {
  return fromHex(bigToHex(value, length))
}

/** @param {{x: bigint, y: bigint}} point @returns {boolean} */
export function isOnCurve(point) {
  const left = mod(point.y * point.y, SM2_P)
  const right = mod(point.x * point.x * point.x + SM2_A * point.x + SM2_B, SM2_P)
  return left === right
}

/** @param {{x: bigint, y: bigint}} point */
function toJacobian(point) {
  return { x: point.x, y: point.y, z: 1n }
}

/** @param {{x: bigint, y: bigint, z: bigint}} point @returns {{x: bigint, y: bigint}|null} */
function toAffine(point) {
  if (point.z === 0n) return null
  const zInv = modInverse(point.z, SM2_P)
  const zInv2 = (zInv * zInv) % SM2_P
  const x = (point.x * zInv2) % SM2_P
  const y = (point.y * zInv2 * zInv) % SM2_P
  return { x, y }
}

/** @param {{x: bigint, y: bigint, z: bigint}} point @returns {{x: bigint, y: bigint, z: bigint}} */
function doublePoint(point) {
  if (point.z === 0n) return INFINITY
  const xx = (point.x * point.x) % SM2_P
  const yy = (point.y * point.y) % SM2_P
  const yyyy = (yy * yy) % SM2_P
  const zz = (point.z * point.z) % SM2_P
  const s = mod(2n * (((point.x + yy) * (point.x + yy)) % SM2_P - xx - yyyy), SM2_P)
  const m = mod(3n * xx + SM2_A * ((zz * zz) % SM2_P), SM2_P)
  const t = mod(m * m - 2n * s, SM2_P)
  const x3 = t
  const y3 = mod(m * (s - t) - 8n * yyyy, SM2_P)
  const z3 = mod((point.y + point.z) * (point.y + point.z) - yy - zz, SM2_P)
  return { x: x3, y: y3, z: z3 }
}

/**
 * @param {{x: bigint, y: bigint, z: bigint}} left
 * @param {{x: bigint, y: bigint, z: bigint}} right
 */
function addPoints(left, right) {
  if (left.z === 0n) return right
  if (right.z === 0n) return left
  const z1z1 = (left.z * left.z) % SM2_P
  const z2z2 = (right.z * right.z) % SM2_P
  const u1 = (left.x * z2z2) % SM2_P
  const u2 = (right.x * z1z1) % SM2_P
  const s1 = (((left.y * right.z) % SM2_P) * z2z2) % SM2_P
  const s2 = (((right.y * left.z) % SM2_P) * z1z1) % SM2_P
  const h = mod(u2 - u1, SM2_P)
  const r = mod(2n * (s2 - s1), SM2_P)
  if (h === 0n) {
    if (r === 0n) return doublePoint(left)
    return INFINITY
  }
  const i = (2n * h) * (2n * h) % SM2_P
  const j = (h * i) % SM2_P
  const v = (u1 * i) % SM2_P
  const x3 = mod(r * r - j - 2n * v, SM2_P)
  const y3 = mod(r * (v - x3) - 2n * s1 * j, SM2_P)
  const z3 = mod(((left.z + right.z) * (left.z + right.z) - z1z1 - z2z2) * h, SM2_P)
  return { x: x3, y: y3, z: z3 }
}

/**
 * @param {bigint} scalar
 * @param {{x: bigint, y: bigint}} point
 * @returns {{x: bigint, y: bigint}|null}
 */
export function scalarMultiply(scalar, point = SM2_G) {
  let k = mod(scalar, SM2_N)
  if (k === 0n) return null
  let result = INFINITY
  let base = toJacobian(point)
  while (k > 0n) {
    if (k & 1n) result = addPoints(result, base)
    base = doublePoint(base)
    k >>= 1n
  }
  return toAffine(result)
}

/**
 * @param {{x: bigint, y: bigint}} point
 * @param {boolean} [compressed]
 * @returns {Uint8Array} 65 bytes (0x04 || X || Y) or 33 bytes (0x02/0x03 || X)
 */
export function encodePoint(point, compressed = false) {
  if (compressed) {
    const prefix = (point.y & 1n) === 1n ? 0x03 : 0x02
    return concatBytes(Uint8Array.of(prefix), bigToBytes(point.x))
  }
  return concatBytes(Uint8Array.of(0x04), bigToBytes(point.x), bigToBytes(point.y))
}

/**
 * @param {Uint8Array|string} encoded hex string or bytes
 * @returns {{x: bigint, y: bigint}}
 */
export function decodePoint(encoded) {
  const bytes = typeof encoded === 'string' ? fromHex(encoded) : encoded
  if (bytes.length === 65 && bytes[0] === 0x04) {
    const point = { x: bytesToBig(bytes.subarray(1, 33)), y: bytesToBig(bytes.subarray(33, 65)) }
    if (!isOnCurve(point)) throw new RangeError('point is not on the SM2 curve')
    return point
  }
  if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) {
    const x = bytesToBig(bytes.subarray(1, 33))
    const alpha = mod(x * x * x + SM2_A * x + SM2_B, SM2_P)
    let y = modPow(alpha, (SM2_P + 1n) / 4n, SM2_P)
    if (mod(y * y, SM2_P) !== alpha) throw new RangeError('invalid compressed SM2 point')
    if ((y & 1n) !== BigInt(bytes[0] & 1)) y = mod(SM2_P - y, SM2_P)
    return { x, y }
  }
  throw new RangeError('invalid SM2 point encoding')
}

/**
 * Derive a private scalar from arbitrary seed material (deterministic device
 * key provisioning).
 * @param {Uint8Array|string} seed
 * @returns {bigint}
 */
export function derivePrivateScalar(seed) {
  const material = typeof seed === 'string' ? utf8ToBytes(seed) : seed
  for (let counter = 0; counter < 256; counter += 1) {
    const digest = sm3(concatBytes(material, Uint8Array.of(counter)))
    const candidate = mod(bytesToBig(digest), SM2_N - 1n) + 1n
    if (candidate !== 0n) return candidate
  }
  throw new Error('unable to derive an SM2 scalar')
}

/**
 * @param {bigint} [scalar] optional explicit private scalar
 * @returns {{d: bigint, publicKey: {x: bigint, y: bigint}, publicHex: string}}
 */
export function generateKeyPair(scalar) {
  const d = scalar ?? derivePrivateScalar(randomBytesForNonce())
  if (d <= 0n || d >= SM2_N) throw new RangeError('SM2 private scalar out of range')
  const publicKey = scalarMultiply(d)
  return { d, publicKey, publicHex: toHex(encodePoint(publicKey)) }
}

/**
 * The SM2 `Z` digest for a user identifier and public key.
 * @param {{x: bigint, y: bigint}} publicKey
 * @param {string} [identity]
 * @returns {Uint8Array}
 */
export function sm2Z(publicKey, identity = SM2_DEFAULT_ID) {
  const idBytes = utf8ToBytes(identity)
  const bitLength = idBytes.length * 8
  const entl = Uint8Array.of((bitLength >>> 8) & 0xff, bitLength & 0xff)
  return sm3(
    concatBytes(
      entl,
      idBytes,
      bigToBytes(SM2_A),
      bigToBytes(SM2_B),
      bigToBytes(SM2_G.x),
      bigToBytes(SM2_G.y),
      bigToBytes(publicKey.x),
      bigToBytes(publicKey.y),
    ),
  )
}

/**
 * `e = SM3(Z || M)` as a big integer.
 * @param {Uint8Array|number[]} message
 * @param {{x: bigint, y: bigint}} publicKey
 * @param {string} [identity]
 * @returns {{e: bigint, digest: Uint8Array}}
 */
export function sm2MessageDigest(message, publicKey, identity = SM2_DEFAULT_ID) {
  const digest = sm3(concatBytes(sm2Z(publicKey, identity), message))
  return { e: bytesToBig(digest), digest }
}

/**
 * @param {bigint} scalar
 * @returns {bigint}
 */
function randomScalar(scalar) {
  return mod(scalar, SM2_N - 1n) + 1n
}

/**
 * Sign a message.
 *
 * `options.k` exists so known-answer tests and deterministic test vectors can
 * pin the nonce; production callers must not pass it.
 *
 * @param {Uint8Array|number[]} message
 * @param {bigint} privateScalar
 * @param {{k?: bigint, identity?: string, publicKey?: {x: bigint, y: bigint}}} [options]
 * @returns {{r: bigint, s: bigint, hex: string}}
 */
export function sm2Sign(message, privateScalar, options = {}) {
  const publicKey = options.publicKey ?? scalarMultiply(privateScalar)
  const { e } = sm2MessageDigest(message, publicKey, options.identity ?? SM2_DEFAULT_ID)
  const d = privateScalar
  if (options.k !== undefined && (options.k <= 0n || options.k >= SM2_N)) {
    throw new RangeError('SM2 nonce k out of range')
  }
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const k = options.k ?? randomScalar(bytesToBig(randomBytesForNonce()))
    const point = scalarMultiply(k)
    const r = mod(e + point.x, SM2_N)
    if (r === 0n || r + k === SM2_N) continue
    const s = mod(modInverse(1n + d, SM2_N) * mod(k - r * d, SM2_N), SM2_N)
    if (s === 0n) continue
    return { r, s, hex: bigToHex(r) + bigToHex(s) }
  }
  throw new Error('SM2 signing failed to produce a valid nonce')
}

/**
 * Nonce entropy. Kept local so signing does not depend on WebCrypto.
 * @returns {Uint8Array}
 */
function randomBytesForNonce() {
  const host = typeof globalThis !== 'undefined' ? globalThis : {}
  const out = new Uint8Array(32)
  if (host.crypto && typeof host.crypto.getRandomValues === 'function') {
    try {
      host.crypto.getRandomValues(out)
      return out
    } catch {
      /* fall through */
    }
  }
  for (let index = 0; index < out.length; index += 1) out[index] = (Math.random() * 256) & 0xff
  return out
}

/**
 * Verify a raw `r || s` signature.
 * @param {Uint8Array|number[]} message
 * @param {{r: bigint, s: bigint}|string} signature raw hex or parsed pair
 * @param {{x: bigint, y: bigint}|string} publicKey point or hex
 * @param {{identity?: string}} [options]
 * @returns {boolean}
 */
export function sm2Verify(message, signature, publicKey, options = {}) {
  let r
  let s
  if (typeof signature === 'string') {
    const bytes = fromHex(signature)
    if (bytes.length !== 64) return false
    r = bytesToBig(bytes.subarray(0, 32))
    s = bytesToBig(bytes.subarray(32, 64))
  } else {
    r = signature.r
    s = signature.s
  }
  if (r <= 0n || r >= SM2_N || s <= 0n || s >= SM2_N) return false
  const point = typeof publicKey === 'string' ? decodePoint(publicKey) : publicKey
  const { e } = sm2MessageDigest(message, point, options.identity ?? SM2_DEFAULT_ID)
  const t = mod(r + s, SM2_N)
  if (t === 0n) return false
  const sG = scalarMultiply(s)
  const tP = scalarMultiply(t, point)
  if (!sG || !tP) return false
  const sum = toAffine(addPoints(toJacobian(sG), toJacobian(tP)))
  if (!sum) return false
  return mod(e + sum.x, SM2_N) === r
}

/**
 * ECDH: `d * peerPublic`, serialised as `x || y` (64 bytes).
 * @param {bigint} privateScalar
 * @param {{x: bigint, y: bigint}|string} peerPublicKey
 * @returns {Uint8Array}
 */
export function sm2SharedSecret(privateScalar, peerPublicKey) {
  const point = typeof peerPublicKey === 'string' ? decodePoint(peerPublicKey) : peerPublicKey
  const shared = scalarMultiply(privateScalar, point)
  if (!shared) throw new RangeError('invalid SM2 shared secret point')
  return concatBytes(bigToBytes(shared.x), bigToBytes(shared.y))
}

/**
 * Minimal DER `SEQUENCE { INTEGER r, INTEGER s }` encoder.
 * @param {{r: bigint, s: bigint}} signature
 * @returns {Uint8Array}
 */
export function encodeDerSignature(signature) {
  const encodeInteger = (value) => {
    let bytes = bigToBytes(value)
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1
    bytes = bytes.subarray(start)
    if (bytes[0] & 0x80) bytes = concatBytes(Uint8Array.of(0), bytes)
    return concatBytes(Uint8Array.of(0x02, bytes.length), bytes)
  }
  const body = concatBytes(encodeInteger(signature.r), encodeInteger(signature.s))
  if (body.length >= 0x80) {
    return concatBytes(Uint8Array.of(0x30, 0x81, body.length), body)
  }
  return concatBytes(Uint8Array.of(0x30, body.length), body)
}

/**
 * @param {Uint8Array|number[]} der
 * @returns {{r: bigint, s: bigint}}
 */
export function decodeDerSignature(der) {
  const bytes = der instanceof Uint8Array ? der : Uint8Array.from(der)
  let offset = 0
  if (bytes[offset++] !== 0x30) throw new RangeError('DER: expected SEQUENCE')
  let length = bytes[offset++]
  if (length & 0x80) {
    const count = length & 0x7f
    length = 0
    for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[offset++]
  }
  const readInteger = () => {
    if (bytes[offset++] !== 0x02) throw new RangeError('DER: expected INTEGER')
    const size = bytes[offset++]
    const value = bytesToBig(bytes.subarray(offset, offset + size))
    offset += size
    return value
  }
  const r = readInteger()
  const s = readInteger()
  return { r, s }
}
