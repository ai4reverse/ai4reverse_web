/**
 * Hybrid envelope: SM2 ECDH + a random multi-layer symmetric pipeline.
 *
 * Why hybrid: a long-lived device key must not encrypt bulk data directly, and
 * a symmetric key must not be shipped to the server. Per request the device
 * generates an ephemeral SM2 key pair, derives a shared secret with the
 * server's static key, and expands it into per-layer keys. The layer plan
 * (which ciphers, in which order) is itself derived from the shared secret, so
 * it varies per request without being a free parameter an attacker can pin.
 *
 * Layers include standard ciphers (SM4/AES/ChaCha20), *mutated* ciphers whose
 * parameters are derived from the same secret, and keyed substitution and
 * permutation layers. CFB/substitution/permutation are not XOR streams, so
 * chaining them is not equivalent to a single stream cipher.
 *
 * The white-box primitives are deliberately *not* used as envelope layers:
 * the server could not invert them. They protect the device's long-term key
 * material and local state instead (see `sealLocal`).
 */

import {
  base64Decode,
  base64Encode,
  bytesEqual,
  bytesToUtf8,
  concatBytes,
  fromHex,
  toHex,
  utf8ToBytes,
} from './bytes.js'
import { hmacSm3, kdfSm3 } from './hash.js'
import { createPrng } from './prng.js'
import { encodePoint, decodePoint, scalarMultiply, sm2SharedSecret } from './sm2.js'
import {
  createCatalogue,
  createLayer,
  deriveEnvelopeSecrets,
  deriveLayerMaterial,
  SERVER_LAYERS,
} from './variants.js'

export const ENVELOPE_VERSION = 1

/**
 * Header canonicalisation: an explicit, unambiguous field order. Never
 * `JSON.stringify` an object whose key order could change between peers.
 * @param {object} envelope
 * @returns {string}
 */
export function canonicalHeader(envelope) {
  return [
    `nsdk${envelope.v}`,
    envelope.kid ?? '',
    envelope.eph,
    envelope.nonce,
    (envelope.layers ?? []).join(','),
    envelope.enc,
  ].join('|')
}

/**
 * @param {string} tagHex
 * @param {string} expected
 * @returns {boolean}
 */
function tagMatches(tagHex, expected) {
  try {
    return bytesEqual(fromHex(tagHex), fromHex(expected))
  } catch {
    return false
  }
}

/**
 * Seal a payload for a server.
 *
 * @param {Uint8Array|string} payload
 * @param {object} options
 * @param {string|{x: bigint, y: bigint}} options.serverPublicKey
 * @param {bigint} options.ephemeralScalar
 * @param {Uint8Array|number[]} options.nonce 16 bytes
 * @param {string} [options.kid] device key id
 * @param {ReturnType<typeof createCatalogue>} [options.catalogue]
 * @param {boolean} [options.fixedPlan] force a specific plan (tests/KATs)
 * @returns {object} envelope
 */
export function sealEnvelope(payload, options) {
  const bytes = typeof payload === 'string' ? utf8ToBytes(payload) : Uint8Array.from(payload)
  const nonce = Uint8Array.from(options.nonce)
  if (nonce.length !== 16) throw new RangeError('envelope nonce must be 16 bytes')
  const serverPoint = typeof options.serverPublicKey === 'string' ? decodePoint(options.serverPublicKey) : options.serverPublicKey
  const ephPoint = scalarMultiply(options.ephemeralScalar)
  if (!ephPoint) throw new RangeError('invalid ephemeral scalar')
  const shared = sm2SharedSecret(options.ephemeralScalar, serverPoint)
  const nonceHex = toHex(nonce)
  const secrets = deriveEnvelopeSecrets(shared, nonceHex)
  const catalogue = options.catalogue ?? createCatalogue({ seed: nonceHex })
  const plan = options.fixedPlan ?? catalogue.plan(createPrng(secrets.planKey, 'plan'))
  if (plan.length < 1 || plan.length > 8) throw new RangeError('layer plan must contain 1..8 layers')
  if (new Set(plan).size !== plan.length) throw new RangeError('layer plan contains duplicate layers')
  if (plan.some((id) => !SERVER_LAYERS.includes(id))) throw new RangeError('invalid layer plan')

  let ciphertext = bytes
  for (let index = 0; index < plan.length; index += 1) {
    const material = deriveLayerMaterial(shared, nonceHex, index, plan[index])
    const layer = createLayer(plan[index], material.aux)
    ciphertext = layer.apply(ciphertext, material.key, material.iv)
  }

  const encoded = radix(ciphertext, secrets.alphabet)
  const header = {
    v: ENVELOPE_VERSION,
    kid: options.kid ?? '',
    eph: toHex(encodePoint(ephPoint)),
    nonce: nonceHex,
    layers: plan,
    enc: secrets.encoding,
  }
  const tag = toHex(hmacSm3(secrets.tagKey, utf8ToBytes(`${canonicalHeader(header)}|${encoded}`)))
  return { ...header, ct: encoded, tag }
}

/**
 * Open an envelope with the server's static private key.
 * @param {object} envelope
 * @param {bigint} serverPrivateScalar
 * @returns {Uint8Array} plaintext
 */
export function openEnvelope(envelope, serverPrivateScalar) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION) throw new Error('unsupported envelope version')
  if (!Array.isArray(envelope.layers) || envelope.layers.length < 1) throw new Error('envelope has no layers')
  if (envelope.layers.some((id) => !SERVER_LAYERS.includes(id))) throw new Error('envelope uses an unknown layer')
  const shared = sm2SharedSecret(serverPrivateScalar, decodePoint(envelope.eph))
  const secrets = deriveEnvelopeSecrets(shared, envelope.nonce)
  const expected = toHex(hmacSm3(secrets.tagKey, utf8ToBytes(`${canonicalHeader(envelope)}|${envelope.ct}`)))
  if (!tagMatches(envelope.tag, expected)) {
    const error = new Error('envelope authentication failed')
    error.code = 'NSDK_TAMPER'
    throw error
  }
  let ciphertext = unradix(envelope.ct, secrets.alphabet)
  for (let index = envelope.layers.length - 1; index >= 0; index -= 1) {
    const id = envelope.layers[index]
    const material = deriveLayerMaterial(shared, envelope.nonce, index, id)
    const layer = createLayer(id, material.aux)
    ciphertext = layer.invert(ciphertext, material.key, material.iv)
  }
  return ciphertext
}

/** @param {Uint8Array|number[]} bytes @param {string} alphabet @returns {string} */
function radix(bytes, alphabet) {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  if (value === 0n) return alphabet[0].repeat(bytes.length)
  let out = ''
  while (value > 0n) {
    const digit = Number(value % BigInt(alphabet.length))
    out = alphabet[digit] + out
    value /= BigInt(alphabet.length)
  }
  // Preserve leading zero bytes: a leading zero byte contributes nothing to the
  // big integer, so encode the count separately by prefixing zero digits.
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1
  return alphabet[0].repeat(zeros) + out
}

/** @param {string} text @param {string} alphabet @returns {Uint8Array} */
function unradix(text, alphabet) {
  const base = BigInt(alphabet.length)
  let value = 0n
  for (const character of text) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error('invalid envelope encoding')
    value = value * base + BigInt(digit)
  }
  const bytes = []
  while (value > 0n) {
    bytes.push(Number(value & 0xffn))
    value >>= 8n
  }
  if (bytes.length === 0) return new Uint8Array(0)
  bytes.reverse()
  // Each leading alphabet[0] digit represents one leading zero byte.
  let zeros = 0
  while (zeros < text.length && text[zeros] === alphabet[0]) zeros += 1
  return concatBytes(new Uint8Array(zeros), Uint8Array.from(bytes))
}

/**
 * Compact transport form: `nsdk1.<base64url(json)>`.
 * @param {object} envelope
 * @returns {string}
 */
export function envelopeToString(envelope) {
  const json = JSON.stringify(envelope)
  return `nsdk1.${base64Encode(utf8ToBytes(json)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/** @param {string} text @returns {object} */
export function parseEnvelopeString(text) {
  const value = String(text)
  if (!value.startsWith('nsdk1.')) throw new Error('not an nsdk envelope')
  const payload = value.slice(6).replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(bytesToUtf8(base64Decode(payload)))
}

/**
 * Seal device-local state with the implicit-key SPN. The server cannot open
 * this by design; it never leaves the device.
 * @param {Uint8Array|string} payload
 * @param {{spn: {keystream: (iv: Uint8Array, length: number) => Uint8Array}, kid?: string, nonce: Uint8Array}} options
 * @returns {object}
 */
export function sealLocal(payload, options) {
  const bytes = typeof payload === 'string' ? utf8ToBytes(payload) : Uint8Array.from(payload)
  const nonce = Uint8Array.from(options.nonce)
  if (nonce.length !== 16) throw new RangeError('local nonce must be 16 bytes')
  const pad = options.spn.keystream(nonce, bytes.length)
  const ciphertext = Uint8Array.from(bytes, (value, index) => value ^ pad[index])
  const macKey = options.spn.keystream(mixNonce(nonce, 1), 32)
  const header = { v: 1, kid: options.kid ?? '', nonce: toHex(nonce), enc: 'b62' }
  const encoded = radix(ciphertext, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
  const tag = toHex(hmacSm3(macKey, utf8ToBytes(`local|${localHeader(header)}|${encoded}`)))
  return { ...header, ct: encoded, tag }
}

/**
 * @param {object} envelope
 * @param {{spn: {keystream: (iv: Uint8Array, length: number) => Uint8Array}}} options
 * @returns {Uint8Array}
 */
export function openLocal(envelope, options) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const nonce = fromHex(envelope.nonce)
  const ciphertext = unradix(envelope.ct, alphabet)
  const macKey = options.spn.keystream(mixNonce(nonce, 1), 32)
  const expected = toHex(hmacSm3(macKey, utf8ToBytes(`local|${localHeader(envelope)}|${envelope.ct}`)))
  if (!tagMatches(envelope.tag, expected)) {
    const error = new Error('local state authentication failed')
    error.code = 'NSDK_TAMPER'
    throw error
  }
  const pad = options.spn.keystream(nonce, ciphertext.length)
  return Uint8Array.from(ciphertext, (value, index) => value ^ pad[index])
}

/** @param {object} header @returns {string} */
function localHeader(header) {
  return `nsdk-local${header.v}|${header.kid ?? ''}|${header.nonce}|${header.enc}`
}

/** @param {Uint8Array} nonce @param {number} tag @returns {Uint8Array} */
function mixNonce(nonce, tag) {
  const out = Uint8Array.from(nonce)
  out[0] ^= tag
  out[15] ^= 0xa5
  return out
}

/**
 * Derive the VM key from the white-box SPN: the bytecode key exists only as a
 * keystream, never as a stored constant.
 * @param {{keystream: (iv: Uint8Array, length: number) => Uint8Array}} spn
 * @param {string} label
 * @param {number} [length]
 * @returns {Uint8Array}
 */
export function deriveVmKey(spn, label, length = 32) {
  const seedBytes = utf8ToBytes(`nsdk/vm/v1/${label}`)
  const iv = kdfSm3(seedBytes, 'vm-iv', 16)
  return spn.keystream(iv, length)
}
