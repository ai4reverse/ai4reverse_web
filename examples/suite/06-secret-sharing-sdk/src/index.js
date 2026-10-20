/**
 * Secret Sharing SDK — threshold secret sharing over GF(256).
 *
 * A secret is split byte-by-byte with Shamir's scheme: every byte becomes the
 * constant term of an independent random polynomial of degree `threshold - 1`
 * over the Rijndael field GF(2^8). Any `threshold` distinct shares reconstruct
 * the secret; fewer reveal nothing about it. The envelope binds the secret with
 * a SHA-256 commitment and every share carries a truncated checksum, so broken
 * shares are rejected before interpolation and mismatched share sets are
 * detected after it.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

export const VERSION = '1.0.0'
export const MAX_SHARES = 255
const FORMAT = 'sss1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class SharingError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code)
    this.name = 'SharingError'
    this.code = code
  }
}

/** @param {number} length */
export function randomBytes(length) {
  return new Uint8Array(nodeRandomBytes(length))
}

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/** @param {string} text */
export function fromBase64Url(text) {
  try {
    return new Uint8Array(Buffer.from(text, 'base64url'))
  } catch {
    throw new SharingError('BAD_ENCODING', 'invalid base64url')
  }
}

/**
 * Multiply two field elements modulo the AES polynomial x^8 + x^4 + x^3 + x + 1.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function gfMul(a, b) {
  let left = a & 0xff
  let right = b & 0xff
  let product = 0
  for (let bit = 0; bit < 8; bit += 1) {
    if (right & 1) product ^= left
    const carry = left & 0x80
    left = (left << 1) & 0xff
    if (carry) left ^= 0x1b
    right >>= 1
  }
  return product & 0xff
}

/** @param {number} value @param {number} exponent @returns {number} */
export function gfPow(value, exponent) {
  let result = 1
  let base = value & 0xff
  let power = exponent
  while (power > 0) {
    if (power & 1) result = gfMul(result, base)
    base = gfMul(base, base)
    power >>= 1
  }
  return result
}

/** Multiplicative inverse via Fermat: a^254 = a^-1 for a != 0. @param {number} value @returns {number} */
export function gfInv(value) {
  if ((value & 0xff) === 0) throw new SharingError('DIVISION_BY_ZERO', 'zero has no inverse in GF(256)')
  return gfPow(value, 254)
}

/** @param {number} a @param {number} b @returns {number} */
export function gfDiv(a, b) {
  return gfMul(a, gfInv(b))
}

/** @param {Uint8Array|string} source */
function asBytes(source) {
  if (source instanceof Uint8Array) return new Uint8Array(source)
  if (typeof source === 'string') return encoder.encode(source)
  throw new SharingError('BAD_SECRET', 'secret must be a Uint8Array or string')
}

/** @param {Uint8Array} bytes */
export function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}

/** @param {Uint8Array|string} secret */
export function commitmentOf(secret) {
  const digest = sha256(asBytes(secret))
  return toBase64Url(digest)
}

/** @param {Uint8Array} bytes @returns {string} */
function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

/** @param {Uint8Array} bytes @param {Uint8Array} expected */
function equalBytes(bytes, expected) {
  return bytes.length === expected.length && timingSafeEqual(Buffer.from(bytes), Buffer.from(expected))
}

/**
 * Truncated checksum binding a share's index to its payload.
 * @param {{index: number, threshold: number, y: Uint8Array}} share
 * @returns {string}
 */
export function shareFingerprint(share) {
  const header = Uint8Array.of(share.index & 0xff, share.threshold & 0xff, share.y.length & 0xff)
  const digest = sha256(concat(header, share.y))
  return toBase64Url(digest.subarray(0, 6))
}

/** @param {...Uint8Array} chunks @returns {Uint8Array} */
function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/**
 * Evaluate the per-byte polynomial with Horner's rule.
 * @param {number[]} coefficients
 * @param {number} x
 * @returns {number}
 */
function evaluate(coefficients, x) {
  let value = 0
  for (let degree = coefficients.length - 1; degree >= 0; degree -= 1) {
    value = gfMul(value, x) ^ coefficients[degree]
  }
  return value
}

/**
 * Split a secret into `shares` shares with reconstruction threshold `threshold`.
 * @param {Uint8Array|string} secret
 * @param {{threshold: number, shares: number, random?: (length: number) => Uint8Array, commitment?: string}} options
 * @returns {{threshold: number, count: number, commitment: string, shares: Array<{index: number, threshold: number, y: Uint8Array, fingerprint: string}>}}
 */
export function splitSecret(secret, options) {
  const bytes = asBytes(secret)
  if (bytes.length === 0) throw new SharingError('BAD_SECRET', 'secret must not be empty')
  const threshold = Number(options?.threshold)
  const count = Number(options?.shares)
  if (!Number.isInteger(threshold) || threshold < 2) throw new SharingError('BAD_THRESHOLD', 'threshold must be an integer >= 2')
  if (!Number.isInteger(count) || count < threshold || count > MAX_SHARES) {
    throw new SharingError('BAD_SHARE_COUNT', `shares must be between threshold and ${MAX_SHARES}`)
  }
  const random = options.random ?? randomBytes
  const coefficients = []
  for (let byte = 0; byte < bytes.length; byte += 1) {
    const row = new Array(threshold)
    row[0] = bytes[byte]
    const noise = random(threshold - 1)
    if (!(noise instanceof Uint8Array) || noise.length !== threshold - 1) {
      throw new SharingError('BAD_RANDOM', 'random source returned the wrong number of bytes')
    }
    for (let degree = 1; degree < threshold; degree += 1) row[degree] = noise[degree - 1]
    coefficients.push(row)
  }
  const commitment = options.commitment ?? commitmentOf(bytes)
  if (commitment !== commitmentOf(bytes)) throw new SharingError('BAD_COMMITMENT', 'commitment does not match the secret')
  const shares = []
  for (let index = 1; index <= count; index += 1) {
    const y = new Uint8Array(bytes.length)
    for (let byte = 0; byte < bytes.length; byte += 1) y[byte] = evaluate(coefficients[byte], index)
    const share = { index, threshold, y }
    shares.push({ ...share, fingerprint: shareFingerprint(share) })
  }
  return { threshold, count, commitment, shares }
}

/**
 * @param {Uint8Array|string} secret
 * @param {{threshold: number, shares: number, random?: Function}} [options]
 * @returns {string}
 */
export function splitSecretToString(secret, options) {
  return serializeShares(splitSecret(secret, options))
}

/**
 * @param {Array<{index: number, threshold?: number, y: Uint8Array, fingerprint?: string}>} shares
 * @returns {{threshold: number, xs: number[], ys: number[][]}}
 */
function normalizeShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) throw new SharingError('BAD_SHARES', 'share list is empty')
  const threshold = shares[0]?.threshold
  if (!Number.isInteger(threshold) || threshold < 2) throw new SharingError('BAD_THRESHOLD', 'shares do not carry a valid threshold')
  const xs = []
  const ys = []
  const seen = new Set()
  for (const share of shares) {
    const index = Number(share?.index)
    if (!Number.isInteger(index) || index < 1 || index > MAX_SHARES) throw new SharingError('BAD_SHARE_INDEX', 'share index out of range')
    if (seen.has(index)) throw new SharingError('DUPLICATE_SHARE', `duplicate share index ${index}`)
    if (share.threshold !== threshold) throw new SharingError('MIXED_THRESHOLDS', 'shares use different thresholds')
    if (!(share.y instanceof Uint8Array) || share.y.length === 0) throw new SharingError('BAD_SHARE', 'share payload must be a non-empty Uint8Array')
    if (ys.length > 0 && share.y.length !== ys[0].length) throw new SharingError('SHARE_LENGTH_MISMATCH', 'shares encode different secret lengths')
    if (share.fingerprint !== undefined && share.fingerprint !== shareFingerprint(share)) {
      throw new SharingError('BAD_SHARE_CHECKSUM', `share ${index} failed its checksum`)
    }
    seen.add(index)
    xs.push(index)
    ys.push(share.y)
  }
  return { threshold, xs, ys }
}

/**
 * Reconstruct the secret with Lagrange interpolation at x = 0.
 * @param {Array<{index: number, threshold?: number, y: Uint8Array}>} shares
 * @param {{commitment?: string}} [options]
 * @returns {Uint8Array}
 */
export function combineShares(shares, options = {}) {
  const { threshold, xs, ys } = normalizeShares(shares)
  if (xs.length < threshold) {
    throw new SharingError('INSUFFICIENT_SHARES', `need ${threshold} shares, received ${xs.length}`)
  }
  const length = ys[0].length
  const secret = new Uint8Array(length)
  for (let byte = 0; byte < length; byte += 1) {
    let value = 0
    for (let i = 0; i < threshold; i += 1) {
      let numerator = 1
      let denominator = 1
      for (let j = 0; j < threshold; j += 1) {
        if (i === j) continue
        numerator = gfMul(numerator, xs[j])
        denominator = gfMul(denominator, xs[j] ^ xs[i])
      }
      value ^= gfMul(ys[i][byte], gfDiv(numerator, denominator))
    }
    secret[byte] = value
  }
  if (options.commitment !== undefined) {
    const expected = asCommitmentBytes(options.commitment)
    if (!equalBytes(sha256(secret), expected)) {
      throw new SharingError('COMMITMENT_MISMATCH', 'shares do not reconstruct the committed secret')
    }
  }
  return secret
}

/** @param {string} text @returns {Uint8Array} */
function asCommitmentBytes(text) {
  const bytes = fromBase64Url(String(text))
  if (bytes.length !== 32) throw new SharingError('BAD_COMMITMENT', 'commitment must be a SHA-256 digest')
  return bytes
}

/**
 * @param {Array} shares
 * @param {string} commitment
 * @returns {boolean}
 */
export function verifyShares(shares, commitment) {
  try {
    combineShares(shares, { commitment })
    return true
  } catch {
    return false
  }
}

/**
 * Identify shares that are not part of any consistent reconstruction. Intended
 * for small shareholder sets (n <= 12); the search is exponential by design.
 * @param {Array} shares
 * @param {string} commitment
 * @returns {{valid: boolean, invalid: number[], tested: number}}
 */
export function findInvalidShares(shares, commitment) {
  const { threshold, xs } = normalizeShares(shares)
  if (xs.length > 12) throw new SharingError('NOT_DIAGNOSABLE', 'share diagnostics support at most 12 shares')
  if (xs.length < threshold) throw new SharingError('INSUFFICIENT_SHARES', 'not enough shares to diagnose')
  const trusted = new Set()
  let tested = 0
  const choose = (start, picked) => {
    if (picked.length === threshold) {
      tested += 1
      const subset = picked.map((position) => shares[position])
      if (verifyShares(subset, commitment)) for (const position of picked) trusted.add(position)
      return
    }
    for (let cursor = start; cursor <= shares.length - (threshold - picked.length); cursor += 1) {
      choose(cursor + 1, [...picked, cursor])
    }
  }
  choose(0, [])
  const invalid = shares.map((_, position) => position).filter((position) => !trusted.has(position))
  return { valid: invalid.length === 0, invalid, tested }
}

/**
 * @param {{threshold: number, count?: number, commitment: string, shares: Array}} envelope
 * @returns {string}
 */
export function serializeShares(envelope) {
  if (!envelope || !Array.isArray(envelope.shares) || envelope.shares.length === 0) {
    throw new SharingError('BAD_ENVELOPE', 'envelope must contain shares')
  }
  const { threshold, shares } = envelope
  const count = envelope.count ?? shares.length
  if (shares.length !== count) throw new SharingError('BAD_ENVELOPE', 'share count does not match the envelope')
  asCommitmentBytes(envelope.commitment)
  const encoded = shares
    .map((share) => {
      if (!Number.isInteger(share.index) || share.index < 1 || share.index > MAX_SHARES) {
        throw new SharingError('BAD_SHARE_INDEX', 'share index out of range')
      }
      if (!(share.y instanceof Uint8Array) || share.y.length === 0) throw new SharingError('BAD_SHARE', 'empty share payload')
      return `${share.index}:${toBase64Url(share.y)}:${share.fingerprint ?? shareFingerprint({ ...share, threshold })}`
    })
    .join(',')
  return `${FORMAT}.${threshold}.${count}.${envelope.commitment}.${encoded}`
}

/**
 * @param {string} text
 * @returns {{threshold: number, count: number, commitment: string, shares: Array<{index: number, threshold: number, y: Uint8Array, fingerprint: string}>}}
 */
export function parseShares(text) {
  if (typeof text !== 'string' || text.length === 0) throw new SharingError('BAD_ENVELOPE', 'serialized shares must be a non-empty string')
  const parts = text.split('.')
  if (parts.length !== 5) throw new SharingError('BAD_ENVELOPE', 'serialized envelope must have 5 sections')
  const [format, thresholdText, countText, commitment, payload] = parts
  if (format !== FORMAT) throw new SharingError('BAD_FORMAT', `expected ${FORMAT}`)
  const threshold = Number(thresholdText)
  const count = Number(countText)
  if (!Number.isInteger(threshold) || threshold < 2) throw new SharingError('BAD_THRESHOLD', 'invalid threshold')
  if (!Number.isInteger(count) || count < threshold || count > MAX_SHARES) throw new SharingError('BAD_SHARE_COUNT', 'invalid share count')
  asCommitmentBytes(commitment)
  const entries = payload.split(',')
  if (entries.length !== count) throw new SharingError('BAD_SHARE_COUNT', 'serialized share count mismatch')
  const shares = entries.map((entry) => {
    const fields = entry.split(':')
    if (fields.length !== 3) throw new SharingError('BAD_ENVELOPE', 'malformed share entry')
    const index = Number(fields[0])
    const y = fromBase64Url(fields[1])
    const fingerprint = fields[2]
    if (!Number.isInteger(index) || index < 1 || index > MAX_SHARES) throw new SharingError('BAD_SHARE_INDEX', 'share index out of range')
    if (y.length === 0) throw new SharingError('BAD_SHARE', 'empty share payload')
    const share = { index, threshold, y, fingerprint }
    if (fingerprint !== shareFingerprint(share)) throw new SharingError('BAD_SHARE_CHECKSUM', `share ${index} failed its checksum`)
    return share
  })
  const indexes = new Set(shares.map((share) => share.index))
  if (indexes.size !== shares.length) throw new SharingError('DUPLICATE_SHARE', 'serialized shares contain duplicate indexes')
  return { threshold, count, commitment, shares }
}

/**
 * Reconstruct from a serialized envelope and enforce the commitment.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function combineFromString(text) {
  const envelope = parseShares(text)
  return combineShares(envelope.shares, { commitment: envelope.commitment })
}

/** @param {Uint8Array|string} secret */
export function secretToText(secret) {
  return decoder.decode(asBytes(secret))
}

/** @param {Uint8Array} bytes @returns {string} */
export function secretToHex(secret) {
  return hex(asBytes(secret))
}
