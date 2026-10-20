/**
 * Secure Enclave Attestation SDK — remote attestation for confidential workloads.
 *
 * An enclave measures its module manifest (SHA-256 per module plus a Merkle-free
 * root digest), binds a server-issued nonce and an attestation policy into a
 * compact quote, and signs the quote with an ECDSA P-256 key. The relying party
 * verifies the quote offline: signature, measurement integrity, nonce binding,
 * freshness, single-use replay and policy conformance.
 *
 * Every clock is injectable so verification stays deterministic in tests and
 * reproducible in CI. No network access is required by this module.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'

export const VERSION = '1.0.0'
export const QUOTE_VERSION = 1
export const DEFAULT_QUOTE_TTL_MS = 60_000
export const DEFAULT_REPLAY_TTL_MS = 300_000

/** Policy/quote verification failures carry a stable machine-readable code. */
export class AttestationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'AttestationError'
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
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new AttestationError('BAD_INPUT', 'expected a string or byte array')
}

/**
 * SHA-256 helper used for module measurements, report data and policy hashes.
 * @param {string | Uint8Array} value
 * @returns {string} lowercase hex digest
 */
export function sha256Hex(value) {
  return createHash('sha256').update(toBytes(value)).digest('hex')
}

/**
 * Deterministic JSON serialization (recursively sorted object keys). Quotes and
 * policies are signed over this encoding so two hosts cannot disagree on bytes.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) throw new AttestationError('BAD_INPUT', 'canonicalJson cannot encode undefined')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new AttestationError('BAD_INPUT', 'canonicalJson cannot encode non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64url'))
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * Generate an enclave signing key pair. The key id is derived from the SPKI
 * encoding of the public key so both sides compute the same identifier.
 * @param {{keyId?: string}} [options]
 * @returns {{privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, keyId: string}}
 */
export function generateEnclaveKeyPair(options = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const keyId = options.keyId ?? `key_${sha256Hex(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 24)}`
  return { privateKey, publicKey, keyId }
}

/**
 * @param {import('node:crypto').KeyObject | string} key
 * @returns {string} PEM encoded SubjectPublicKeyInfo
 */
export function exportPublicKeyPem(key) {
  const keyObject = typeof key === 'string' ? createPublicKey(key) : key
  if (keyObject.type !== 'public') throw new AttestationError('BAD_KEY', 'expected a public key')
  return keyObject.export({ type: 'spki', format: 'pem' }).toString()
}

/**
 * Normalize PEM/KeyObject input into a verifier key.
 * @param {import('node:crypto').KeyObject | string} key
 */
function asPublicKey(key) {
  try {
    return typeof key === 'string' ? createPublicKey(key) : key
  } catch {
    throw new AttestationError('BAD_KEY', 'unable to import public key')
  }
}

/**
 * Normalize the signing key (PEM or KeyObject).
 * @param {import('node:crypto').KeyObject | string} key
 */
function asPrivateKey(key) {
  try {
    return typeof key === 'string' ? createPrivateKey(key) : key
  } catch {
    throw new AttestationError('BAD_KEY', 'unable to import private key')
  }
}

/** @param {string} path */
const comparePath = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * @typedef {{path: string, sha256: string, size: number}} ModuleMeasurement
 */

/**
 * Measure a manifest of modules. The manifest maps a module path to its content
 * (string or bytes); each entry is hashed independently and the sorted set is
 * folded into a single root digest.
 * @param {Record<string, string | Uint8Array>} manifest
 * @returns {{algorithm: 'SHA-256', root: string, modules: ModuleMeasurement[]}}
 */
export function measureManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new AttestationError('BAD_MANIFEST', 'manifest must be an object mapping path to content')
  }
  const modules = Object.entries(manifest).map(([path, content]) => {
    const bytes = toBytes(content)
    if (!path) throw new AttestationError('BAD_MANIFEST', 'module path is required')
    return { path, sha256: sha256Hex(bytes), size: bytes.length }
  })
  if (modules.length === 0) throw new AttestationError('BAD_MANIFEST', 'manifest must contain at least one module')
  modules.sort((left, right) => comparePath(left.path, right.path))
  return { algorithm: 'SHA-256', root: measurementRoot(modules), modules }
}

/**
 * Recompute the root digest from module records. Verification uses this to
 * detect quotes whose advertised root disagrees with their own module list.
 * @param {ModuleMeasurement[]} modules
 * @returns {string}
 */
export function measurementRoot(modules) {
  if (!Array.isArray(modules) || modules.length === 0) throw new AttestationError('BAD_MANIFEST', 'modules must be a non-empty array')
  const normalized = modules
    .map((module) => {
      if (!module || typeof module.path !== 'string' || !/^[0-9a-f]{64}$/.test(module.sha256 ?? '') || !Number.isInteger(module.size)) {
        throw new AttestationError('BAD_MANIFEST', 'each module needs path, sha256 hex and integer size')
      }
      return { path: module.path, sha256: module.sha256, size: module.size }
    })
    .sort((left, right) => comparePath(left.path, right.path))
  return sha256Hex(canonicalJson({ algorithm: 'SHA-256', modules: normalized }))
}

/**
 * Create a single-use freshness challenge for an attestation request.
 * @param {{ttlMs?: number, now?: number, policyHash?: string}} [options]
 */
export function createChallenge(options = {}) {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? 120_000
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new AttestationError('BAD_TTL', 'ttlMs must be positive')
  const nonce = randomBytes(32).toString('base64url')
  return {
    version: 1,
    id: `chal_${sha256Hex(`${now}:${nonce}`).slice(0, 24)}`,
    nonce,
    issuedAt: now,
    expiresAt: now + ttlMs,
    policyHash: options.policyHash ?? null,
  }
}

/**
 * Build a hashable attestation policy. An empty measurement list means the
 * policy binds only the enclave identity and claims (useful during rollout).
 * @param {{
 *   name?: string,
 *   version?: number,
 *   measurements?: string[],
 *   enclaves?: string[],
 *   requiredClaims?: Record<string, unknown>,
 *   maxQuoteAgeMs?: number,
 * }} options
 */
export function createPolicy(options = {}) {
  const requiredClaims = Object.fromEntries(
    Object.entries(options.requiredClaims ?? {}).sort(([left], [right]) => comparePath(left, right)),
  )
  const body = {
    kind: 'enclave-attestation-policy',
    name: options.name ?? 'default',
    version: options.version ?? 1,
    measurements: [...new Set(options.measurements ?? [])].sort(comparePath),
    enclaves: [...new Set(options.enclaves ?? [])].sort(comparePath),
    requiredClaims,
    maxQuoteAgeMs: options.maxQuoteAgeMs ?? DEFAULT_QUOTE_TTL_MS,
  }
  return { ...body, hash: policyHash(body) }
}

/**
 * @param {Omit<ReturnType<typeof createPolicy>, 'hash'>} body
 * @returns {string}
 */
export function policyHash(body) {
  const { hash: _ignored, ...rest } = /** @type {any} */ (body)
  return sha256Hex(canonicalJson(rest))
}

/**
 * @param {Record<string, unknown>} claims
 * @returns {string}
 */
function claimsHash(claims) {
  return sha256Hex(canonicalJson(claims))
}

/**
 * Report data binds nonce, measurement, policy and claims into one digest that
 * is covered twice: inside the signed payload and as a recomputed check.
 * @param {{nonce: string, measurement: string, policyHash: string | null, claimsHash: string}} body
 */
function reportDataFor(body) {
  return sha256Hex(`${body.nonce}.${body.measurement}.${body.policyHash ?? ''}.${body.claimsHash}`)
}

/**
 * @typedef {ReturnType<typeof createPolicy>} AttestationPolicy
 * @typedef {{
 *   version: number,
 *   enclaveId: string,
 *   keyId: string,
 *   algorithm: 'ES256',
 *   measurement: string,
 *   modules: ModuleMeasurement[],
 *   claims: Record<string, unknown>,
 *   claimsHash: string,
 *   policyHash: string | null,
 *   nonce: string,
 *   challengeId: string,
 *   issuedAt: number,
 *   expiresAt: number,
 *   reportData: string,
 *   signature: string,
 * }} Quote
 */

/**
 * Create an enclave-side attestor. The returned `attest` function is the only
 * code that touches the private key.
 * @param {{
 *   enclaveId: string,
 *   privateKey: import('node:crypto').KeyObject | string,
 *   keyId?: string,
 *   policy?: AttestationPolicy,
 *   claims?: Record<string, unknown>,
 *   ttlMs?: number,
 *   clock?: () => number,
 * }} options
 */
export function createAttestor(options) {
  if (!options?.enclaveId) throw new AttestationError('BAD_ENCLAVE', 'enclaveId is required')
  if (!options.privateKey) throw new AttestationError('BAD_KEY', 'privateKey is required')
  const privateKey = asPrivateKey(options.privateKey)
  const publicKey = createPublicKey(privateKey)
  const keyId = options.keyId ?? `key_${sha256Hex(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 24)}`
  const policy = options.policy ?? null
  const claims = options.claims ?? {}
  const ttlMs = options.ttlMs ?? DEFAULT_QUOTE_TTL_MS
  const clock = options.clock ?? (() => Date.now())

  /**
   * Produce a signed quote for a challenge and module manifest.
   * @param {{challenge: ReturnType<typeof createChallenge>, manifest: Record<string, string | Uint8Array>}} request
   * @returns {Quote}
   */
  function attest(request) {
    const { challenge, manifest } = request ?? {}
    if (!challenge || typeof challenge.nonce !== 'string' || challenge.nonce.length < 16) {
      throw new AttestationError('BAD_CHALLENGE', 'a challenge with a 128-bit nonce is required')
    }
    const now = clock()
    if (Number.isFinite(challenge.expiresAt) && now > challenge.expiresAt) {
      throw new AttestationError('CHALLENGE_EXPIRED', 'challenge expired before attestation')
    }
    const measurement = measureManifest(manifest)
    const expiresAt = Math.min(now + ttlMs, Number.isFinite(challenge.expiresAt) ? challenge.expiresAt : now + ttlMs)
    const body = {
      version: QUOTE_VERSION,
      enclaveId: options.enclaveId,
      keyId,
      algorithm: /** @type {const} */ ('ES256'),
      measurement: measurement.root,
      modules: measurement.modules,
      claims,
      claimsHash: claimsHash(claims),
      policyHash: policy?.hash ?? null,
      nonce: challenge.nonce,
      challengeId: challenge.id ?? '',
      issuedAt: now,
      expiresAt,
    }
    const reportData = reportDataFor(body)
    const payload = { ...body, reportData }
    const signature = sign('sha256', Buffer.from(canonicalJson(payload), 'utf8'), {
      key: privateKey,
      dsaEncoding: 'der',
    }).toString('base64url')
    return { ...payload, signature }
  }

  return {
    enclaveId: options.enclaveId,
    keyId,
    policyHash: policy?.hash ?? null,
    attest,
  }
}

/**
 * @typedef {{keyId: string, publicKey: import('node:crypto').KeyObject | string, notBefore?: number, notAfter?: number}} KeyRingEntry
 */

/**
 * Build a rotation-aware key ring. Resolution is time-bounded so a retired key
 * can keep verifying quotes that were issued inside its validity window while
 * new quotes are forced onto the successor key.
 * @param {KeyRingEntry[]} entries
 */
export function createKeyRing(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new AttestationError('BAD_KEYRING', 'key ring needs at least one key')
  const keys = entries.map((entry) => {
    if (!entry?.keyId) throw new AttestationError('BAD_KEYRING', 'every key ring entry needs a keyId')
    return {
      keyId: entry.keyId,
      publicKey: asPublicKey(entry.publicKey),
      notBefore: entry.notBefore ?? Number.NEGATIVE_INFINITY,
      notAfter: entry.notAfter ?? Number.POSITIVE_INFINITY,
    }
  })
  if (new Set(keys.map((entry) => entry.keyId)).size !== keys.length) {
    throw new AttestationError('BAD_KEYRING', 'duplicate keyId in key ring')
  }
  return {
    keyIds: keys.map((entry) => entry.keyId),
    /**
     * @param {string} keyId
     * @param {number} at
     */
    resolve(keyId, at = Date.now()) {
      const matches = keys.filter(
        (entry) => entry.keyId === keyId && entry.notBefore <= at && at <= entry.notAfter,
      )
      if (matches.length === 0) throw new AttestationError('KEY_NOT_FOUND', `no active key for ${keyId} at ${at}`)
      return matches[0].publicKey
    },
  }
}

/**
 * Bounded single-use cache keyed by (challengeId, nonce). Entries expire with
 * the quote lifetime so the cache cannot grow without bound.
 */
export class ReplayCache {
  /** @type {Map<string, number>} */
  #entries = new Map()
  #capacity
  #ttlMs

  /** @param {{capacity?: number, ttlMs?: number}} [options] */
  constructor(options = {}) {
    this.#capacity = options.capacity ?? 512
    this.#ttlMs = options.ttlMs ?? DEFAULT_REPLAY_TTL_MS
    if (this.#capacity < 1) throw new AttestationError('BAD_CACHE', 'capacity must be >= 1')
  }

  /**
   * @param {Pick<Quote, 'challengeId' | 'nonce'>} quote
   * @returns {string}
   */
  static keyOf(quote) {
    return `${quote.challengeId ?? ''}:${quote.nonce ?? ''}`
  }

  /** @param {number} [now] */
  prune(now = Date.now()) {
    for (const [key, expiry] of this.#entries) if (expiry <= now) this.#entries.delete(key)
    return this.#entries.size
  }

  /**
   * @param {Pick<Quote, 'challengeId' | 'nonce'>} quote
   * @param {number} [now]
   */
  has(quote, now = Date.now()) {
    const key = ReplayCache.keyOf(quote)
    const expiry = this.#entries.get(key)
    if (expiry === undefined) return false
    if (expiry <= now) {
      this.#entries.delete(key)
      return false
    }
    return true
  }

  /**
   * Record a verified quote. Only called after every other check passed so an
   * attacker cannot poison the cache with unsigned nonces.
   * @param {Pick<Quote, 'challengeId' | 'nonce'>} quote
   * @param {number} [now]
   */
  remember(quote, now = Date.now()) {
    this.prune(now)
    while (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next().value
      this.#entries.delete(oldest)
    }
    this.#entries.set(ReplayCache.keyOf(quote), now + this.#ttlMs)
  }

  get size() {
    return this.#entries.size
  }

  clear() {
    this.#entries.clear()
  }
}

/**
 * @typedef {{name: string, ok: boolean, detail: string}} Check
 * @typedef {{
 *   valid: boolean,
 *   reason: string | null,
 *   checks: Check[],
 *   measurement: string | null,
 *   enclaveId: string | null,
 *   claims: Record<string, unknown>,
 * }} VerificationResult
 */

/**
 * Verify an enclave quote against a challenge, a public key (or key ring) and an
 * optional policy. Returns a full evidence trail instead of throwing so callers
 * can log why attestation failed without leaking key material.
 * @param {Quote} quote
 * @param {{
 *   publicKey?: import('node:crypto').KeyObject | string,
 *   keyRing?: ReturnType<typeof createKeyRing>,
 *   challenge?: ReturnType<typeof createChallenge>,
 *   policy?: AttestationPolicy,
 *   replayCache?: ReplayCache,
 *   now?: number,
 *   clockSkewMs?: number,
 *   maxQuoteAgeMs?: number,
 * }} [options]
 * @returns {VerificationResult}
 */
export function verifyAttestation(quote, options = {}) {
  /** @type {Check[]} */
  const checks = []
  const now = options.now ?? Date.now()
  const skew = options.clockSkewMs ?? 5_000
  const record = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail: ok ? detail || 'ok' : detail || 'failed' })
    return Boolean(ok)
  }
  const finish = () => {
    const failed = checks.find((check) => !check.ok)
    if (!failed && options.replayCache) options.replayCache.remember(quote, now)
    const result = {
      valid: !failed,
      reason: failed ? `${failed.name}: ${failed.detail}` : null,
      checks,
      measurement: validString(quote?.measurement) ? quote.measurement : null,
      enclaveId: validString(quote?.enclaveId) ? quote.enclaveId : null,
      claims: quote && typeof quote.claims === 'object' && quote.claims ? quote.claims : {},
    }
    return result
  }

  if (!quote || typeof quote !== 'object') {
    record('structure', false, 'quote must be an object')
    return finish()
  }
  const structural =
    quote.version === QUOTE_VERSION &&
    quote.algorithm === 'ES256' &&
    validString(quote.enclaveId) &&
    validString(quote.keyId) &&
    validString(quote.nonce) &&
    validString(quote.measurement) &&
    Array.isArray(quote.modules) &&
    quote.modules.length > 0
  if (!record('structure', structural, structural ? '' : 'quote is missing required fields or has an unsupported version')) {
    return finish()
  }

  const recomputedClaims = claimsHash(quote.claims ?? {})
  record('claims.digest', recomputedClaims === quote.claimsHash, 'claims hash must match the claims object')
  const recomputedReport = reportDataFor({
    nonce: quote.nonce,
    measurement: quote.measurement,
    policyHash: quote.policyHash ?? null,
    claimsHash: recomputedClaims,
  })
  record('reportData.binding', recomputedReport === quote.reportData, 'report data must bind nonce, measurement, policy and claims')

  let root = ''
  try {
    root = measurementRoot(quote.modules)
    record('measurement.root', root === quote.measurement, 'advertised root must equal the digest of the module list')
  } catch (error) {
    record('measurement.root', false, /** @type {Error} */ (error).message)
  }

  try {
    const { signature, ...payload } = quote
    const publicKey = options.publicKey
      ? asPublicKey(options.publicKey)
      : options.keyRing
        ? options.keyRing.resolve(quote.keyId, now)
        : null
    if (!publicKey) throw new AttestationError('NO_KEY', 'publicKey or keyRing is required')
    const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8')
    const signatureBytes = Buffer.from(String(signature ?? ''), 'base64url')
    const ok = signatureBytes.length > 0 && verify('sha256', payloadBytes, { key: publicKey, dsaEncoding: 'der' }, signatureBytes)
    record('signature', ok, 'ECDSA P-256 signature over the canonical quote payload')
  } catch (error) {
    record('signature', false, /** @type {Error} */ (error).message)
  }

  const challenge = options.challenge
  if (!challenge || typeof challenge.nonce !== 'string') {
    record('challenge.present', false, 'a server challenge is required to bind the quote to a session')
  } else {
    record('challenge.nonce', quote.nonce === challenge.nonce, 'quote nonce must equal the challenge nonce')
    record('challenge.id', !challenge.id || quote.challengeId === challenge.id, 'quote must reference the challenge id')
    record('challenge.expiry', !Number.isFinite(challenge.expiresAt) || now <= challenge.expiresAt, 'challenge must not be expired')
  }

  record('freshness.issuedAt', Number.isFinite(quote.issuedAt) && quote.issuedAt <= now + skew, 'issuedAt must not be in the future beyond the clock skew')
  record('freshness.expiresAt', Number.isFinite(quote.expiresAt) && now <= quote.expiresAt, 'quote must not be expired')
  const maxAge = options.maxQuoteAgeMs ?? options.policy?.maxQuoteAgeMs ?? DEFAULT_QUOTE_TTL_MS
  record('freshness.age', Number.isFinite(quote.issuedAt) && now - quote.issuedAt <= maxAge, `quote age must be <= ${maxAge}ms`)

  const replay = options.replayCache
  if (replay) record('replay.unseen', !replay.has(quote, now), 'quote nonce must not have been consumed before')

  const policy = options.policy
  if (policy) {
    record('policy.hash', policy.hash === quote.policyHash, 'quote must be bound to the expected policy hash')
    record(
      'policy.measurement',
      policy.measurements.length === 0 || policy.measurements.includes(root || quote.measurement),
      'measurement must be allowlisted by the policy',
    )
    record(
      'policy.enclave',
      policy.enclaves.length === 0 || policy.enclaves.includes(quote.enclaveId),
      'enclave identity must be allowlisted by the policy',
    )
    const claimFailures = Object.entries(policy.requiredClaims).filter(
      ([key, expected]) => canonicalJson(quote.claims?.[key]) !== canonicalJson(expected),
    )
    record(
      'policy.claims',
      claimFailures.length === 0,
      claimFailures.length === 0 ? '' : `claim mismatch: ${claimFailures.map(([key]) => key).join(', ')}`,
    )
  }

  return finish()
}

/** @param {unknown} value */
function validString(value) {
  return typeof value === 'string' && value.length > 0
}
