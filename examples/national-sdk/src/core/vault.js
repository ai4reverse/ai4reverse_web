/**
 * Device vault: local state sealed by a randomly chosen white-box suite.
 *
 * Every save picks one of the twelve suites and a fresh table salt, then
 * generates that suite's tables. Consequence: the on-disk envelope names the
 * suite and salt, but the tables do not: they are regenerated on load from the
 * implicit build key. Two saves of the same state use different algorithms and
 * different encodings, which is the "dynamic" part of the white-box claim in
 * actual runtime use (not only in the test catalogue).
 *
 * Format:
 *   { v: 1, suite: "wb-aes/b", salt: "<8-byte hex>", nonce: "<16-byte hex>",
 *     enc: "b62", ct: "<base62>", tag: "<hex>" }
 *
 * Header (authenticated): `nsdkv1|suite|salt|nonce|enc`.
 */

import { base64Decode, base64Encode, bytesToUtf8, fromHex, radixDecode, radixEncode, toHex, utf8ToBytes } from './bytes.js'
import { hmacSm3, kdfSm3 } from './hash.js'
import { gatherEntropy } from './prng.js'
import { WHITEBOX_SUITES, instantiateWhitebox } from './variants.js'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** @param {object} header @returns {string} */
function canonical(header) {
  return `nsdkv1|${header.suite}|${header.salt}|${header.nonce}|${header.enc}`
}

/**
 * @param {{buildSalt: string, spnKeyHex: string, suites?: string[], suiteKeyBytes?: number}} options
 */
export function createVault(options) {
  if (!options.buildSalt || !options.spnKeyHex) throw new TypeError('vault requires buildSalt and spnKeyHex')
  const host = typeof globalThis !== 'undefined' ? globalThis : {}
  const buildSalt = options.buildSalt
  const spnKeyHex = options.spnKeyHex
  const suites = options.suites ?? WHITEBOX_SUITES.map((suite) => suite.id)

  /** @param {string} suiteId @param {string} saltHex */
  function instanceFor(suiteId, saltHex) {
    const vaultKey = kdfSm3(fromHex(spnKeyHex), `nsdk/vault/v1/${suiteId}/${saltHex}`, 32)
    const suite = WHITEBOX_SUITES.find((entry) => entry.id === suiteId)
    if (!suite) throw new RangeError(`unknown vault suite ${suiteId}`)
    const key = suite.family === 'whitebox-spn' ? vaultKey : vaultKey.subarray(0, 16)
    return {
      instance: instantiateWhitebox(suiteId, `${buildSalt}::vault/${saltHex}`, key),
      tagKey: kdfSm3(vaultKey, 'tag', 32),
    }
  }

  /**
   * @param {Uint8Array|string} payload
   * @param {{suiteId?: string, nonce?: Uint8Array, salt?: Uint8Array}} [sealOptions]
   */
  function seal(payload, sealOptions = {}) {
    const bytes = typeof payload === 'string' ? utf8ToBytes(payload) : Uint8Array.from(payload)
    const suiteId = sealOptions.suiteId ?? suites[gatherEntropy(1, host).bytes[0] % suites.length]
    const salt = sealOptions.salt ?? gatherEntropy(8, host).bytes
    const nonce = sealOptions.nonce ?? gatherEntropy(16, host).bytes
    if (salt.length !== 8) throw new RangeError('vault salt must be 8 bytes')
    if (nonce.length !== 16) throw new RangeError('vault nonce must be 16 bytes')
    const { instance, tagKey } = instanceFor(suiteId, toHex(salt))
    const ciphertext = instance.encrypt(nonce, bytes)
    const header = { v: 1, suite: suiteId, salt: toHex(salt), nonce: toHex(nonce), enc: 'b62' }
    const encoded = radixEncode(ciphertext, ALPHABET)
    const tag = toHex(hmacSm3(tagKey, utf8ToBytes(`${canonical(header)}|${encoded}`)))
    return { ...header, ct: encoded, tag }
  }

  /** @param {object} envelope @returns {Uint8Array} */
  function open(envelope) {
    if (!envelope || envelope.v !== 1) throw new Error('unsupported vault envelope')
    const { instance, tagKey } = instanceFor(String(envelope.suite), String(envelope.salt))
    const expected = toHex(hmacSm3(tagKey, utf8ToBytes(`${canonical(envelope)}|${envelope.ct}`)))
    if (expected.length !== String(envelope.tag).length) throw new Error('vault authentication failed')
    // Constant-time-ish comparison without importing the whole helper set.
    let difference = 0
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected.charCodeAt(index) ^ String(envelope.tag).charCodeAt(index)
    }
    if (difference !== 0) {
      const error = new Error('vault authentication failed')
      error.code = 'NSDK_TAMPER'
      throw error
    }
    const ciphertext = radixDecode(String(envelope.ct), ALPHABET)
    return instance.decrypt(fromHex(envelope.nonce), ciphertext)
  }

  return {
    seal,
    open,
    suites: suites.slice(),
    /** Decode a text payload (convenience). */
    openText(envelope) {
      return bytesToUtf8(open(envelope))
    },
    /** Compact transport form for tests. */
    toTransport(envelope) {
      return `nsdkv1.${base64Encode(utf8ToBytes(JSON.stringify(envelope))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
    },
    fromTransport(text) {
      const value = String(text)
      if (!value.startsWith('nsdkv1.')) throw new Error('not a vault envelope')
      return JSON.parse(bytesToUtf8(base64Decode(value.slice(7).replace(/-/g, '+').replace(/_/g, '/'))))
    },
  }
}
