/**
 * Request signing.
 *
 * The signature is SM2 over
 *
 *     SM3(canonical || '|' || ts || '|' || nonce || '|' || deviceToken || '|' || risk)
 *
 * and a second, independent HMAC-SM3 binds the signature header set. The HMAC
 * key is a *static-static* ECDH secret between the device key and the server's
 * static key, so the server can verify it without the device sending any secret
 * and without a session handshake.
 *
 * Two defences are deliberately redundant:
 *
 *  1. The canonical string is computed both by the JS reference path and by the
 *     JSVMP program; a mismatch aborts signing (`NSDK_VM_INTEGRITY`). An attacker
 *     who patches one path but not the other cannot forge a request.
 *  2. The SM2 signature and the HMAC cover overlapping but not identical
 *     fields; a header rewrite that survives one check fails the other.
 */

import { concatBytes, fromHex, toHex, utf8ToBytes } from '../core/bytes.js'
import { gatherEntropy } from '../core/prng.js'
import { hmacSm3, kdfSm3, sm3, sm3Hex } from '../core/hash.js'
import { derivePrivateScalar, encodePoint, scalarMultiply, sm2SharedSecret, sm2Sign } from '../core/sm2.js'
import { sealEnvelope } from '../core/hybrid.js'
import { createCatalogue } from '../core/variants.js'
import { bodyBytes, canonicalRequest, signatureBase, splitUrl } from './canonical.js'
import { createHostApi } from '../vm/host.js'

export const NSDK_VERSION = '1'

/**
 * Derive the long-term device key from the implicit-key SPN. The private scalar
 * exists only as a function of the white-box keystream; it is never persisted.
 * @param {object} identity fingerprint identity (`stableHash` is the binding).
 * @param {{keystream: (iv: Uint8Array, length: number) => Uint8Array}} spn
 */
export function deriveDeviceKey(identity, spn) {
  const iv = kdfSm3(fromHex(identity.stableHash), 'nsdk/device-key/v1', 16)
  const seed = spn.keystream(iv, 32)
  const d = derivePrivateScalar(seed)
  const publicKey = scalarMultiply(d)
  const publicHex = toHex(encodePoint(publicKey))
  const keyId = toHex(sm3(utf8ToBytes(`nsdk/key/v1/${publicHex}`))).slice(0, 16)
  return { d, publicKey, publicHex, keyId }
}

/**
 * Static-static ECDH key for the header MAC.
 * @param {bigint} devicePrivate
 * @param {string|{x: bigint, y: bigint}} serverPublicKey
 * @param {string} keyId
 */
export function deriveMacKey(devicePrivate, serverPublicKey, keyId) {
  const shared = sm2SharedSecret(devicePrivate, serverPublicKey)
  return kdfSm3(shared, `nsdk/sign/v1/mac/${keyId}`, 32)
}

/**
 * @param {object} options
 * @param {object} options.identity device identity from `createDeviceIdentity`
 * @param {{keystream: Function}} options.spn
 * @param {string|{x: bigint, y: bigint}} options.serverPublicKey
 * @param {{token: string}|null} [options.guard]
 * @param {object} [options.vm] compiled VM instance
 * @param {() => number} [options.now]
 */
export function createSigner(options) {
  if (!options.identity) throw new TypeError('signer requires a device identity')
  if (!options.spn) throw new TypeError('signer requires the white-box SPN')
  if (!options.serverPublicKey) throw new TypeError('signer requires the server public key')
  const key = deriveDeviceKey(options.identity, options.spn)
  const macKey = deriveMacKey(key.d, options.serverPublicKey, key.keyId)
  const catalogue = createCatalogue({ seed: options.identity.stableHash })
  const now = options.now ?? (() => Date.now())
  const host = options.host ?? createHostApi()

  /**
   * @param {object} request
   * @param {object} [overrides]
   */
  function sign(request, overrides = {}) {
    const timestamp = overrides.timestamp ?? now()
    const nonce = overrides.nonce ?? toHex(gatherEntropy(16).bytes)
    if (nonce.length !== 32) throw new RangeError('nonce must be 16 bytes (32 hex chars)')
    const risk = overrides.risk ?? resolveRisk(options.guard)
    const fingerprint = options.identity.token
    const sessionKey = kdfSm3(concatBytes(fromHex(nonce), utf8ToBytes(fingerprint)), `nsdk/sign/v1/session/${key.keyId}`, 32)

    let transmittedBody = request.body
    let envelope = null

    const plainCanonical = canonicalRequest({ ...request, body: transmittedBody })

    // Phase 1 of the VM: canonical + plan, using the body hash as an argument.
    let vmResult = null
    if (options.vm) {
      vmResult = options.vm.run([{ h: host,
        method: String(request.method ?? 'GET').toUpperCase(),
        path: plainCanonical.path,
        query: canonicalQueryPairs(request),
        bodyHash: plainCanonical.bodyHash,
        headers: plainCanonical.headers,
        ts: String(timestamp),
        nonce,
        fp: fingerprint,
        risk,
        sessionKey: toHex(sessionKey),
      }])
      assertVmCanonical(vmResult, plainCanonical)
    }

    if (overrides.sealBody) {
      const ephemeralScalar = deriveEphemeral(options.spn, nonce, key.keyId)
      const envelopeNonce = gatherEntropy(16).bytes
      envelope = sealEnvelope(bodyBytes(request.body), {
        serverPublicKey: options.serverPublicKey,
        ephemeralScalar,
        nonce: envelopeNonce,
        kid: key.keyId,
        catalogue,
        fixedPlan: vmResult ? vmResult.layers : undefined,
      })
      transmittedBody = JSON.stringify({
        v: 1,
        enc: envelope.enc,
        envelope,
      })
      if (options.vm) {
        const sealedCanonical = canonicalRequest({ ...request, body: transmittedBody })
        const second = options.vm.run([{ h: host,
          method: String(request.method ?? 'GET').toUpperCase(),
          path: sealedCanonical.path,
          query: canonicalQueryPairs(request),
          bodyHash: sealedCanonical.bodyHash,
          headers: sealedCanonical.headers,
          ts: String(timestamp),
          nonce,
          fp: fingerprint,
          risk,
          sessionKey: toHex(sessionKey),
        }])
        if (second.layers.join(',') !== vmResult.layers.join(',')) {
          const error = new Error('VM layer plan changed between phases')
          error.code = 'NSDK_VM_INTEGRITY'
          throw error
        }
        assertVmCanonical(second, sealedCanonical)
        vmResult = second
      }
    }

    const canonical = canonicalRequest({ ...request, body: transmittedBody })
    const base = signatureBase({
      canonical: canonical.canonical,
      timestamp,
      nonce,
      fingerprint,
      risk,
    })
    // The signed material is the SM3 digest of the signature base. When the VM
    // is present it computed this digest inside protected code; the JS layer
    // recomputes it and aborts on disagreement, so a patched VM cannot change
    // what is signed.
    const expectedDigest = sm3Hex(base)
    if (vmResult && vmResult.sigBase !== expectedDigest) {
      const error = new Error('VM signature base disagrees with the reference encoder')
      error.code = 'NSDK_VM_INTEGRITY'
      throw error
    }
    const signedDigest = vmResult ? vmResult.sigBase : expectedDigest
    const signature = sm2Sign(utf8ToBytes(signedDigest), key.d, { publicKey: key.publicKey })
    const mac = hmacSm3(macKey, utf8ToBytes(`${signature.hex}|${timestamp}|${nonce}|${fingerprint}|${risk}|${canonical.canonical}`))

    const headers = {
      'x-nsdk-v': NSDK_VERSION,
      'x-nsdk-kid': key.keyId,
      'x-nsdk-ts': String(timestamp),
      'x-nsdk-nonce': nonce,
      'x-nsdk-fp': fingerprint,
      'x-nsdk-risk': risk,
      'x-nsdk-sig': signature.hex,
      'x-nsdk-mac': toHex(mac),
    }
    if (envelope) {
      headers['x-nsdk-body'] = 'sealed'
      headers['x-nsdk-env'] = 'v1'
    }
    if (vmResult) headers['x-nsdk-vm'] = vmResult.kid

    return {
      headers,
      body: transmittedBody,
      canonical: canonical.canonical,
      signatureBase: base,
      signedDigest,
      signature: signature.hex,
      mac: headers['x-nsdk-mac'],
      risk,
      timestamp,
      nonce,
      keyId: key.keyId,
      publicKey: key.publicHex,
      layers: vmResult ? vmResult.layers : envelope?.layers ?? null,
      envelope,
      vm: vmResult,
    }
  }

  return {
    keyId: key.keyId,
    publicKey: key.publicHex,
    sign,
    catalogue,
  }
}

/** @param {object|undefined} guard */
function resolveRisk(guard) {
  if (!guard) return 'u0.0'
  if (typeof guard === 'string') return guard
  if (typeof guard.token === 'function') return guard.token()
  if (typeof guard.token === 'string') return guard.token
  return guard.evaluate ? guard.evaluate().token : 'u0.0'
}

/**
 * Query pairs as the canonical encoder sees them (decoded, pre-encoding).
 * @param {object} request
 * @returns {Array<[string, string]>}
 */
export function canonicalQueryPairs(request) {
  if (request.query !== undefined) {
    if (Array.isArray(request.query)) {
      return request.query.map(([key, value]) => [String(key), String(value)])
    }
    return Object.keys(request.query).flatMap((key) => {
      const value = request.query[key]
      return Array.isArray(value) ? value.map((item) => [key, String(item)]) : [[key, String(value)]]
    })
  }
  return splitUrl(request.url ?? request.path ?? '/').query
}

/**
 * Ephemeral ECDH scalar derived from the white-box keystream, so no RNG failure
 * can repeat an ephemeral key (the nonce changes every request).
 * @param {{keystream: Function}} spn
 * @param {string} nonce
 * @param {string} keyId
 */
export function deriveEphemeral(spn, nonce, keyId) {
  const iv = kdfSm3(fromHex(nonce), `nsdk/eph/v1/${keyId}`, 16)
  return derivePrivateScalar(spn.keystream(iv, 32))
}

/**
 * @param {{canonical: string, sigBase: string, kid: string, layers: string[]}} vmResult
 * @param {{canonical: string}} reference
 */
function assertVmCanonical(vmResult, reference) {
  if (!vmResult || typeof vmResult.canonical !== 'string') {
    const error = new Error('VM produced no canonical request')
    error.code = 'NSDK_VM_INTEGRITY'
    throw error
  }
  if (vmResult.canonical !== reference.canonical) {
    const error = new Error('VM canonical request disagrees with the reference encoder')
    error.code = 'NSDK_VM_INTEGRITY'
    error.details = { vm: vmResult.canonical, reference: reference.canonical }
    throw error
  }
  if (!Array.isArray(vmResult.layers) || vmResult.layers.length < 3) {
    const error = new Error('VM layer plan is invalid')
    error.code = 'NSDK_VM_INTEGRITY'
    throw error
  }
}
