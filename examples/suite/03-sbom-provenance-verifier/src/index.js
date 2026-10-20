/**
 * SBOM / Provenance Verifier SDK — reproducible software supply-chain evidence.
 *
 * The SDK builds a CycloneDX-shaped SBOM from file contents (asynchronous
 * SHA-256), derives a deterministic subject digest for the SBOM, wraps it in a
 * SLSA/in-toto provenance statement and signs the DSSE envelope with HMAC or
 * ECDSA P-256. Verification checks the DSSE signature, the builder allowlist,
 * the subject digest and every artifact hash, and reports missing, extra and
 * tampered files separately.
 *
 * Nothing in this module reads the filesystem or the network: callers pass file
 * contents in, which keeps the verifier pure, portable and easy to fuzz.
 */
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  webcrypto,
} from 'node:crypto'

export const VERSION = '1.0.0'
export const BOM_FORMAT = 'CycloneDX'
export const SPEC_VERSION = '1.5'
export const PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1'
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1'
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json'

const subtle = webcrypto.subtle

export class ProvenanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ProvenanceError'
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
  throw new ProvenanceError('BAD_INPUT', 'expected a string or byte array')
}

/**
 * Deterministic JSON encoding used for every digest and signature.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) throw new ProvenanceError('BAD_INPUT', 'undefined is not canonicalizable')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64url'))
  const record = /** @type {Record<string, unknown>} */ (value)
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

/**
 * Asynchronous SHA-256 over string or bytes (WebCrypto `subtle.digest`).
 * @param {string | Uint8Array} content
 * @returns {Promise<string>} lowercase hex
 */
export async function sha256Hex(content) {
  const bytes = toBytes(content)
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes))
  return Buffer.from(digest).toString('hex')
}

/**
 * @param {string | Uint8Array} content
 * @returns {Promise<{algorithm: 'SHA-256', digest: string, size: number}>}
 */
export async function hashContent(content) {
  const bytes = toBytes(content)
  return { algorithm: 'SHA-256', digest: await sha256Hex(bytes), size: bytes.length }
}

/** @param {string} value */
function assertHexDigest(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ProvenanceError('BAD_DIGEST', 'digest must be 64 lowercase hex characters')
  }
  return value
}

/**
 * @typedef {{path: string, content: string | Uint8Array, license?: string, version?: string}} FileInput
 */

/**
 * Normalize the two accepted file input shapes (array or path->content record).
 * @param {FileInput[] | Record<string, string | Uint8Array>} files
 * @param {'array' | 'record'} [shape]
 * @returns {{path: string, content: string | Uint8Array, license: string | null, version: string}[]}
 */
export function normalizeFiles(files, shape = 'array') {
  let entries
  if (Array.isArray(files)) entries = files
  else if (files && typeof files === 'object') entries = Object.entries(files).map(([path, content]) => ({ path, content }))
  else throw new ProvenanceError('BAD_FILES', 'files must be an array or a path->content object')
  const seen = new Set()
  return entries.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) throw new ProvenanceError('BAD_FILES', 'every file needs a non-empty path')
    if (seen.has(entry.path)) throw new ProvenanceError('DUPLICATE_PATH', `duplicate file path ${entry.path}`)
    seen.add(entry.path)
    if (typeof entry.content !== 'string' && !(entry.content instanceof Uint8Array)) {
      throw new ProvenanceError('BAD_FILES', `file ${entry.path} needs string or byte content`)
    }
    return {
      path: entry.path,
      content: entry.content,
      license: typeof entry.license === 'string' ? entry.license : null,
      version: typeof entry.version === 'string' ? entry.version : '0.0.0',
    }
  })
}

/**
 * Build a deterministic CycloneDX-like SBOM. Component order is sorted by path,
 * timestamps and serial numbers are metadata only and never enter the subject
 * digest, so rebuilding identical inputs yields an identical digest.
 * @param {{
 *   name: string,
 *   version: string,
 *   files: FileInput[] | Record<string, string | Uint8Array>,
 *   supplier?: string,
 *   now?: number,
 * }} options
 */
export async function buildSbom(options) {
  if (!options || typeof options.name !== 'string' || options.name.length === 0) throw new ProvenanceError('BAD_SBOM', 'name is required')
  if (typeof options.version !== 'string' || options.version.length === 0) throw new ProvenanceError('BAD_SBOM', 'version is required')
  const files = normalizeFiles(options.files).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  if (files.length === 0) throw new ProvenanceError('BAD_SBOM', 'SBOM needs at least one file')
  const components = []
  for (const file of files) {
    const hash = await hashContent(file.content)
    components.push({
      type: 'file',
      'bom-ref': `file:${file.path}`,
      name: file.path,
      version: file.version,
      hashes: [{ alg: 'SHA-256', content: hash.digest }],
      properties: [
        { name: 'size', value: String(hash.size) },
        ...(file.license ? [{ name: 'license', value: file.license }] : []),
      ],
    })
  }
  const rootRef = `${options.name}@${options.version}`
  const root = { type: 'application', 'bom-ref': rootRef, name: options.name, version: options.version }
  const metadata = {
    timestamp: new Date(options.now ?? Date.now()).toISOString(),
    tools: [{ vendor: 'ai4reverse', name: 'sbom-provenance-verifier', version: VERSION }],
    component: root,
    ...(options.supplier ? { supplier: { name: options.supplier } } : {}),
  }
  return {
    bomFormat: BOM_FORMAT,
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata,
    components,
    dependencies: [{ ref: rootRef, dependsOn: components.map((component) => component['bom-ref']) }],
  }
}

/**
 * Deterministic SBOM projection. Excludes serial number, timestamp, tools and
 * dependency graph (all derivable) so hashing is reproducible across rebuilds.
 * @param {any} bom
 */
function sbomProjection(bom) {
  if (!bom || bom.bomFormat !== BOM_FORMAT || !Array.isArray(bom.components)) {
    throw new ProvenanceError('BAD_SBOM', 'not a CycloneDX-shaped SBOM')
  }
  const component = bom.metadata?.component
  if (!component || typeof component.name !== 'string' || typeof component.version !== 'string') {
    throw new ProvenanceError('BAD_SBOM', 'SBOM metadata.component is required')
  }
  const components = bom.components
    .map((entry) => {
      if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.hashes)) throw new ProvenanceError('BAD_SBOM', 'component needs name and hashes')
      return {
        type: entry.type,
        name: entry.name,
        version: entry.version,
        hashes: [...entry.hashes].sort((left, right) => (left.alg < right.alg ? -1 : left.alg > right.alg ? 1 : 0)),
        properties: [...(entry.properties ?? [])].sort((left, right) => (left.name < right.name ? -1 : 1)),
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return {
    bomFormat: bom.bomFormat,
    specVersion: bom.specVersion,
    component: { type: component.type, name: component.name, version: component.version },
    components,
  }
}

/**
 * Digest of the SBOM's reproducibility-relevant projection.
 * @param {any} bom
 * @returns {Promise<string>}
 */
export async function sbomDigest(bom) {
  return sha256Hex(canonicalJson(sbomProjection(bom)))
}

/**
 * @param {any} bom
 * @returns {Record<string, {digest: string, size: number}>}
 */
function componentIndex(bom) {
  if (!bom || !Array.isArray(bom.components)) throw new ProvenanceError('BAD_SBOM', 'SBOM components are required')
  const index = new Map()
  for (const component of bom.components) {
    const hash = component?.hashes?.find((entry) => entry.alg === 'SHA-256')
    if (!component?.name || !hash || !/^[0-9a-f]{64}$/.test(hash.content ?? '')) {
      throw new ProvenanceError('BAD_SBOM', `component ${component?.name ?? '<unknown>'} needs a SHA-256 hash`)
    }
    index.set(component.name, {
      digest: hash.content,
      size: Number(component.properties?.find((property) => property.name === 'size')?.value ?? -1),
    })
  }
  return index
}

/**
 * Re-hash supplied artifacts and classify drift against the SBOM.
 * @param {any} bom
 * @param {FileInput[] | Record<string, string | Uint8Array>} files
 */
export async function verifyArtifacts(bom, files) {
  const expected = componentIndex(bom)
  const provided = normalizeFiles(files)
  const providedPaths = new Set(provided.map((file) => file.path))
  const missing = [...expected.keys()].filter((path) => !providedPaths.has(path)).sort()
  const extra = provided.map((file) => file.path).filter((path) => !expected.has(path)).sort()
  /** @type {{path: string, expected: string, actual: string}[]} */
  const tampered = []
  for (const file of provided) {
    const target = expected.get(file.path)
    if (!target) continue
    const hash = await hashContent(file.content)
    if (hash.digest !== target.digest || (target.size >= 0 && hash.size !== target.size)) {
      tampered.push({ path: file.path, expected: target.digest, actual: hash.digest })
    }
  }
  tampered.sort((left, right) => (left.path < right.path ? -1 : 1))
  return {
    ok: missing.length === 0 && extra.length === 0 && tampered.length === 0,
    checked: expected.size,
    missing,
    extra,
    tampered,
  }
}

/**
 * Structural comparison of two SBOMs by component path and SHA-256 digest.
 * @param {any} expected
 * @param {any} actual
 */
export function diffSbom(expected, actual) {
  const left = componentIndex(expected)
  const right = componentIndex(actual)
  const missing = [...left.keys()].filter((path) => !right.has(path)).sort()
  const extra = [...right.keys()].filter((path) => !left.has(path)).sort()
  /** @type {{path: string, expected: string, actual: string}[]} */
  const tampered = []
  for (const [path, entry] of left) {
    const other = right.get(path)
    if (other && other.digest !== entry.digest) tampered.push({ path, expected: entry.digest, actual: other.digest })
  }
  tampered.sort((a, b) => (a.path < b.path ? -1 : 1))
  return {
    ok: missing.length === 0 && extra.length === 0 && tampered.length === 0,
    missing,
    extra,
    tampered,
  }
}

/** @param {string | Uint8Array} payload */
function base64urlEncode(payload) {
  return toBytes(payload).toString('base64url')
}

/** @param {string} text */
function base64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new ProvenanceError('BAD_BASE64URL', 'payload must be unpadded base64url')
  return Buffer.from(text, 'base64url')
}

/**
 * DSSE Pre-Authentication Encoding: signs the payload type and length so a
 * signature cannot be replayed across a different envelope type.
 * @param {string} payloadType
 * @param {Uint8Array} payload
 */
export function preAuthenticationEncoding(payloadType, payload) {
  if (typeof payloadType !== 'string' || payloadType.length === 0) throw new ProvenanceError('BAD_ENVELOPE', 'payloadType is required')
  const typeBytes = Buffer.from(payloadType, 'utf8')
  const payloadBytes = Buffer.from(payload)
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, 'utf8'),
    typeBytes,
    Buffer.from(` ${payloadBytes.length} `, 'utf8'),
    payloadBytes,
  ])
}

/**
 * @typedef {'hmac' | 'ecdsa'} KeyType
 * @typedef {{type: 'hmac', keyId: string, secret: string | Uint8Array} | {type: 'ecdsa', keyId: string, privateKey: import('node:crypto').KeyObject | string}} SigningKey
 */

/**
 * Generate an ECDSA P-256 builder signing key.
 * @param {string} [keyId]
 */
export function generateSigningKeyPair(keyId = 'builder-key-1') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { type: /** @type {const} */ ('ecdsa'), keyId, privateKey, publicKey }
}

/**
 * @param {SigningKey} key
 * @param {Uint8Array} bytes
 * @returns {{keyid: string, alg: 'HS256' | 'ES256', sig: string}}
 */
export function signBytes(key, bytes) {
  if (!key || typeof key.keyId !== 'string' || key.keyId.length === 0) throw new ProvenanceError('BAD_KEY', 'signing key needs a keyId')
  if (key.type === 'hmac') {
    const secret = toBytes(key.secret)
    if (secret.length < 16) throw new ProvenanceError('BAD_KEY', 'HMAC secret must be at least 16 bytes')
    const sig = createHmac('sha256', secret).update(bytes).digest('base64url')
    return { keyid: key.keyId, alg: 'HS256', sig }
  }
  if (key.type === 'ecdsa') {
    const privateKey = typeof key.privateKey === 'string' ? createPrivateKey(key.privateKey) : key.privateKey
    const sig = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }).toString('base64url')
    return { keyid: key.keyId, alg: 'ES256', sig }
  }
  throw new ProvenanceError('BAD_KEY', 'key type must be hmac or ecdsa')
}

/**
 * Create a signed SLSA-style provenance envelope over an SBOM.
 * @param {{
 *   bom: any,
 *   key: SigningKey,
 *   builder: {id: string, version?: string},
 *   buildType?: string,
 *   invocation?: Record<string, unknown>,
 *   materials?: ({name: string, digest?: string, content?: string | Uint8Array, uri?: string})[],
 *   predicateType?: string,
 *   now?: number,
 * }} options
 */
export async function createProvenance(options) {
  const { bom, key, builder } = options ?? {}
  if (!builder || typeof builder.id !== 'string' || builder.id.length === 0) throw new ProvenanceError('BAD_BUILDER', 'builder.id is required')
  const digest = await sbomDigest(bom)
  const component = bom.metadata.component
  /** @type {{name: string, digest: {sha256: string}, uri?: string}[]} */
  const resolvedDependencies = []
  for (const material of options.materials ?? []) {
    if (!material || typeof material.name !== 'string' || material.name.length === 0) throw new ProvenanceError('BAD_MATERIAL', 'material.name is required')
    const materialDigest = material.content !== undefined ? await sha256Hex(material.content) : assertHexDigest(material.digest)
    resolvedDependencies.push({
      name: material.name,
      digest: { sha256: materialDigest },
      ...(material.uri ? { uri: material.uri } : {}),
    })
  }
  const statement = {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${component.name}@${component.version}`, digest: { sha256: digest } }],
    predicateType: options.predicateType ?? PROVENANCE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: options.buildType ?? 'https://slsa.dev/container-based-build/v0.2',
        externalParameters: { sbomDigest: digest, version: component.version, ...(options.invocation ?? {}) },
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: builder.id, version: builder.version ?? 'unknown' },
        metadata: { finishedOn: new Date(options.now ?? Date.now()).toISOString() },
      },
    },
  }
  const payload = Buffer.from(canonicalJson(statement), 'utf8')
  const signature = signBytes(key, preAuthenticationEncoding(DSSE_PAYLOAD_TYPE, payload))
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: base64urlEncode(payload),
    signatures: [signature],
  }
}

/**
 * Decode and parse the statement carried by a DSSE envelope.
 * @param {{payloadType?: string, payload?: string}} envelope
 */
export function decodeStatement(envelope) {
  if (!envelope || envelope.payloadType !== DSSE_PAYLOAD_TYPE || typeof envelope.payload !== 'string') {
    throw new ProvenanceError('BAD_ENVELOPE', 'not a DSSE provenance envelope')
  }
  let statement
  try {
    statement = JSON.parse(base64urlDecode(envelope.payload).toString('utf8'))
  } catch (error) {
    if (error instanceof ProvenanceError) throw error
    throw new ProvenanceError('BAD_ENVELOPE', 'payload is not valid JSON')
  }
  if (!statement || statement._type !== STATEMENT_TYPE || !Array.isArray(statement.subject) || !statement.predicate) {
    throw new ProvenanceError('BAD_STATEMENT', 'statement is missing _type, subject or predicate')
  }
  return statement
}

/**
 * @param {{payloadType?: string, payload?: string, signatures?: unknown[]}} envelope
 */
function validateEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== 'object') return 'envelope must be an object'
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE) return `payloadType must be ${DSSE_PAYLOAD_TYPE}`
  if (typeof envelope.payload !== 'string') return 'payload must be a base64url string'
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) return 'at least one signature is required'
  for (const signature of envelope.signatures) {
    if (!signature || typeof signature.keyid !== 'string' || !['HS256', 'ES256'].includes(signature.alg) || typeof signature.sig !== 'string') {
      return 'every signature needs keyid, alg (HS256|ES256) and sig'
    }
  }
  return null
}

/** @param {string} pattern @param {string} value */
function globMatch(pattern, value) {
  if (pattern === '*') return true
  const source = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(value)
}

/**
 * @typedef {{keyId: string, type: KeyType, secret?: string | Uint8Array, publicKey?: import('node:crypto').KeyObject | string}} VerifyKey
 * @typedef {{name: string, ok: boolean, detail: string}} Check
 */

/** @param {VerifyKey} key @param {string} alg @param {Uint8Array} bytes @param {string} sig */
function verifySignature(key, alg, bytes, sig) {
  const signature = base64urlDecode(sig)
  if (key.type === 'hmac') {
    if (alg !== 'HS256') return false
    const secret = toBytes(key.secret ?? '')
    if (secret.length < 16) return false
    const expected = createHmac('sha256', secret).update(bytes).digest()
    return signature.length === expected.length && timingSafeEqual(signature, expected)
  }
  if (key.type === 'ecdsa') {
    if (alg !== 'ES256') return false
    try {
      const publicKey = typeof key.publicKey === 'string' ? createPublicKey(key.publicKey) : key.publicKey
      return verify('sha256', bytes, { key: publicKey, dsaEncoding: 'der' }, signature)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Verify a provenance envelope. Envelope-level checks always run; builder,
 * subject and predicate-type checks run when their options are supplied.
 * @param {any} envelope
 * @param {{
 *   keys: VerifyKey[],
 *   trustedBuilders?: (string | {id: string, version?: string})[],
 *   bom?: any,
 *   predicateTypes?: string[],
 *   threshold?: number,
 * }} options
 * @returns {Promise<{valid: boolean, reason: string | null, checks: Check[], statement: any | null, builder: {id: string, version: string} | null, subjectDigest: string | null}>}
 */
export async function verifyProvenance(envelope, options) {
  /** @type {Check[]} */
  const checks = []
  const record = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: ok ? detail || 'ok' : detail })
  const finish = (statement = null) => {
    const failed = checks.find((entry) => !entry.ok)
    return {
      valid: !failed,
      reason: failed ? `${failed.name}: ${failed.detail}` : null,
      checks,
      statement,
      builder: statement?.predicate?.runDetails?.builder ?? null,
      subjectDigest: statement?.subject?.[0]?.digest?.sha256 ?? null,
    }
  }
  const shapeError = validateEnvelopeShape(envelope)
  if (!record('envelope.shape', shapeError === null, shapeError ?? '')) return finish()
  if (!Array.isArray(options?.keys) || options.keys.length === 0) {
    record('envelope.keys', false, 'at least one verification key is required')
    return finish()
  }
  let statement
  try {
    statement = decodeStatement(envelope)
    record('payload.json', true, 'DSSE payload decoded')
  } catch (error) {
    record('payload.json', false, /** @type {Error} */ (error).message)
    return finish()
  }
  const payloadBytes = base64urlDecode(envelope.payload)
  const pae = preAuthenticationEncoding(envelope.payloadType, payloadBytes)
  const trustedSignatures = envelope.signatures.filter((signature) => options.keys.some((key) => key.keyId === signature.keyid))
  record('signature.keys', trustedSignatures.length > 0, 'at least one signature must reference a trusted key')
  let validSignatures = 0
  for (const signature of envelope.signatures) {
    const key = options.keys.find((candidate) => candidate.keyId === signature.keyid)
    if (!key) continue
    if (verifySignature(key, signature.alg, pae, signature.sig)) validSignatures += 1
  }
  const threshold = options.threshold ?? 1
  record('signature', validSignatures >= threshold, `${validSignatures}/${envelope.signatures.length} signatures valid, threshold ${threshold}`)
  const builder = statement.predicate?.runDetails?.builder
  record('statement.builder', Boolean(builder && typeof builder.id === 'string' && builder.id.length > 0), 'statement must name a builder')
  const allowedTypes = options.predicateTypes ?? [PROVENANCE_TYPE]
  record('predicate.type', allowedTypes.includes(statement.predicateType), `predicateType must be one of ${allowedTypes.join(', ')}`)
  if (options.trustedBuilders) {
    const allowed = options.trustedBuilders.some((entry) => {
      if (typeof entry === 'string') return Boolean(builder) && globMatch(entry, builder.id)
      return Boolean(builder) && globMatch(entry.id, builder.id) && (!entry.version || entry.version === builder.version)
    })
    record('builder.allowlist', allowed, 'builder must match the trusted builder allowlist')
  }
  if (options.bom) {
    const expectedDigest = await sbomDigest(options.bom)
    const subject = statement.subject[0]
    record('subject.digest', subject?.digest?.sha256 === expectedDigest, 'subject digest must match the SBOM projection digest')
    record('subject.name', subject?.name === `${options.bom.metadata.component.name}@${options.bom.metadata.component.version}`, 'subject name must match the SBOM component')
  }
  return finish(statement)
}

/**
 * @param {any} envelope
 * @returns {string} canonical JSON safe for deterministic transport
 */
export function exportProvenance(envelope) {
  decodeStatement(envelope)
  return canonicalJson(envelope)
}

/**
 * Import and structurally validate a provenance envelope.
 * @param {string} text
 */
export function importProvenance(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProvenanceError('BAD_ENVELOPE', 'provenance is not valid JSON')
  }
  const shapeError = validateEnvelopeShape(parsed)
  if (shapeError) throw new ProvenanceError('BAD_ENVELOPE', shapeError)
  decodeStatement(parsed)
  return parsed
}

/**
 * @param {any} bom
 */
export function exportSbom(bom) {
  sbomProjection(bom)
  return JSON.stringify(bom, null, 2)
}

/**
 * @param {string} text
 */
export function importSbom(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProvenanceError('BAD_SBOM', 'SBOM is not valid JSON')
  }
  sbomProjection(parsed)
  return parsed
}
