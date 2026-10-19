/**
 * Reference server verifier.
 *
 * This is the counterpart to `signRequest`. It is deliberately independent of
 * the device code: it rebuilds the canonical request with the same reference
 * encoder, verifies SM2, verifies the header HMAC, enforces the timestamp
 * window and a nonce replay cache, and decrypts a sealed body with its static
 * private key.
 *
 * The verifier treats the device's risk token as *untrusted input*: it is
 * parsed and reported, never trusted, and a hostile token can be configured to
 * fail the request (`rejectHostile: true`) without pretending the token is
 * cryptographic evidence.
 */

import { bytesEqual, fromHex, toHex, utf8ToBytes } from '../src/core/bytes.js'
import { hmacSm3, sm3 } from '../src/core/hash.js'
import { openEnvelope } from '../src/core/hybrid.js'
import { sm2Verify } from '../src/core/sm2.js'
import { parseRiskToken } from '../src/guard/policy.js'
import { canonicalRequest, signatureBase } from '../src/signing/canonical.js'
import { deriveMacKey } from '../src/signing/sign.js'

export const REQUIRED_HEADERS = Object.freeze([
  'x-nsdk-v',
  'x-nsdk-kid',
  'x-nsdk-ts',
  'x-nsdk-nonce',
  'x-nsdk-fp',
  'x-nsdk-risk',
  'x-nsdk-sig',
  'x-nsdk-mac',
])

/**
 * @param {{ttlMs?: number, max?: number, now?: () => number}} [options]
 */
export function createReplayCache(options = {}) {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000
  const max = options.max ?? 50_000
  const now = options.now ?? (() => Date.now())
  const entries = new Map()
  function prune() {
    const cutoff = now() - ttlMs
    for (const [nonce, timestamp] of entries) {
      if (timestamp < cutoff) entries.delete(nonce)
      else break
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      entries.delete(oldest)
    }
  }
  return {
    /** @returns {boolean} false when the nonce was already seen */
    use(nonce, timestamp = now()) {
      prune()
      if (entries.has(nonce)) return false
      entries.set(nonce, timestamp)
      return true
    },
    has(nonce) {
      return entries.has(nonce)
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

/** @param {object|Array<[string,string]>} headers @returns {Record<string,string>} */
export function headerMap(headers) {
  const map = {}
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) map[String(name).toLowerCase()] = String(value)
  } else if (headers && typeof headers === 'object') {
    for (const name of Object.keys(headers)) map[name.toLowerCase()] = String(headers[name])
  }
  return map
}

/**
 * @param {object} options
 * @param {bigint} options.serverPrivateScalar
 * @param {Record<string,string>} [options.devices] keyId -> device public key (hex)
 * @param {() => number} [options.now]
 * @param {number} [options.windowMs]
 * @param {ReturnType<typeof createReplayCache>} [options.replay]
 * @param {boolean} [options.rejectHostile]
 * @param {boolean} [options.requireRiskHeader]
 */
export function createVerifier(options) {
  const serverPrivateScalar = options.serverPrivateScalar
  const devices = new Map(Object.entries(options.devices ?? {}))
  const now = options.now ?? (() => Date.now())
  const windowMs = options.windowMs ?? 5 * 60 * 1000
  const replay = options.replay ?? createReplayCache({ ttlMs: windowMs * 2, now })

  /** @param {string} keyId @param {string} publicHex */
  function register(keyId, publicHex) {
    devices.set(keyId, publicHex)
  }

  /**
   * @param {object} request
   * @param {object} [verifyOptions]
   * @returns {object}
   */
  function verify(request, verifyOptions = {}) {
    const reasons = []
    const headers = headerMap(request.headers)
    for (const name of REQUIRED_HEADERS) {
      if (!headers[name]) reasons.push(`missing-header:${name}`)
    }
    if (headers['x-nsdk-v'] !== '1') reasons.push(`unsupported-version:${headers['x-nsdk-v'] ?? ''}`)

    const timestamp = Number(headers['x-nsdk-ts'])
    if (!Number.isInteger(timestamp) || timestamp <= 0) reasons.push('invalid-timestamp')
    else {
      const skew = now() - timestamp
      if (skew > windowMs) reasons.push(`timestamp-too-old:${skew}ms`)
      if (skew < -60_000) reasons.push(`timestamp-in-future:${-skew}ms`)
    }

    const nonce = headers['x-nsdk-nonce'] ?? ''
    if (!/^[0-9a-f]{32}$/.test(nonce)) reasons.push('invalid-nonce')

    const keyId = headers['x-nsdk-kid'] ?? ''
    const devicePublic = devices.get(keyId)
    if (!devicePublic) reasons.push(`unknown-device-key:${keyId}`)

    const fingerprint = headers['x-nsdk-fp'] ?? ''
    if (!/^[0-9A-Za-z]{16,64}$/.test(fingerprint)) reasons.push('invalid-device-token')

    const riskToken = headers['x-nsdk-risk'] ?? ''
    const risk = parseRiskToken(riskToken)
    if (options.requireRiskHeader !== false && !risk) reasons.push('invalid-risk-token')
    if (options.rejectHostile && risk && risk.level === 'hostile') reasons.push('hostile-risk')

    // Nonce is only consumed after the cheap structural checks, so a flood of
    // malformed requests cannot fill the replay cache.
    if (/^[0-9a-f]{32}$/.test(nonce) && reasons.length === 0) {
      if (!replay.use(nonce, timestamp)) reasons.push('replay-detected')
    }

    // Transmitted body: either plain or a sealed envelope wrapper.
    let plaintextBody = null
    let envelope = null
    const transmitted = typeof request.body === 'string' ? request.body : request.body instanceof Uint8Array ? request.body : request.body === undefined ? '' : JSON.stringify(request.body)
    if (headers['x-nsdk-body'] === 'sealed') {
      try {
        const wrapper = typeof transmitted === 'string' ? JSON.parse(transmitted) : transmitted
        envelope = wrapper.envelope
        if (!envelope || envelope.kid !== keyId) reasons.push('envelope-kid-mismatch')
        else plaintextBody = openEnvelope(envelope, serverPrivateScalar)
      } catch (error) {
        reasons.push(`envelope-error:${error.code ?? error.message}`)
      }
    }

    const canonical = canonicalRequest({
      method: request.method,
      url: request.url,
      path: request.path,
      query: request.query,
      headers: request.headers,
      body: request.body,
      signedHeaders: verifyOptions.signedHeaders,
    })
    const base = signatureBase({
      canonical: canonical.canonical,
      timestamp: headers['x-nsdk-ts'] ?? '',
      nonce,
      fingerprint,
      risk: riskToken,
    })

    const signedDigest = toHex(sm3(utf8ToBytes(base)))

    if (devicePublic) {
      const signatureOk = safeBoolean(() => sm2Verify(utf8ToBytes(signedDigest), headers['x-nsdk-sig'] ?? '', devicePublic))
      if (!signatureOk) reasons.push('signature-invalid')
      try {
        const macKey = deriveMacKey(serverPrivateScalar, devicePublic, keyId)
        const expected = toHex(hmacSm3(macKey, utf8ToBytes(`${headers['x-nsdk-sig']}|${headers['x-nsdk-ts']}|${nonce}|${fingerprint}|${riskToken}|${canonical.canonical}`)))
        if (!bytesEqual(fromHex(headers['x-nsdk-mac'] ?? ''), fromHex(expected))) reasons.push('mac-invalid')
      } catch {
        reasons.push('mac-invalid')
      }
    }

    return {
      ok: reasons.length === 0,
      reasons,
      risk,
      device: { keyId, fingerprint },
      canonical: canonical.canonical,
      signatureBase: base,
      signedDigest,
      plaintextBody,
      envelope,
      layers: envelope?.layers ?? null,
      replaySize: replay.size,
    }
  }

  return { verify, register, devices, replay }
}

/** @param {() => boolean} fn @returns {boolean} */
function safeBoolean(fn) {
  try {
    return Boolean(fn())
  } catch {
    return false
  }
}
