/**
 * Secure Update Verifier SDK.
 *
 * Signed update manifests with ECDSA P-256 (WebCrypto), semver anti-rollback,
 * product/channel binding, key revocation and expiry, a SHA-256 Merkle tree over
 * file descriptors, and chunk-level proofs. Verification is fail-closed: every
 * rejection carries a stable machine-readable code so an updater can decide
 * whether to retry, quarantine, or alert.
 */
import { createHash } from 'node:crypto'

export const VERSION = '1.0.0'
export const ALGORITHM = 'ES256'
const encoder = new TextEncoder()
const HEX_64 = /^[0-9a-f]{64}$/
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export class UpdateError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code)
    this.name = 'UpdateError'
    this.code = code
  }
}

/** @param {string|Uint8Array} value @returns {Uint8Array} */
function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return encoder.encode(value)
  throw new UpdateError('BAD_INPUT', 'expected a string or Uint8Array')
}

/** @param {...(Uint8Array|Buffer|string)} chunks */
export function sha256Hex(...chunks) {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
  return hash.digest('hex')
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
    throw new UpdateError('BAD_SIGNATURE', 'signature is not valid base64url')
  }
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

/** @param {string} left @param {string} right */
export function hashPair(left, right) {
  if (!HEX_64.test(left) || !HEX_64.test(right)) throw new UpdateError('BAD_HASH', 'merkle leaves must be sha256 hex')
  return sha256Hex(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/**
 * Build a binary SHA-256 Merkle tree; an odd node is promoted by duplicating it.
 * @param {string[]} hashes
 * @returns {{levels: string[][], root: string}}
 */
export function buildMerkleTree(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) throw new UpdateError('BAD_MERKLE', 'merkle tree needs at least one leaf')
  if (!hashes.every((hash) => typeof hash === 'string' && HEX_64.test(hash))) throw new UpdateError('BAD_HASH', 'merkle leaves must be sha256 hex')
  const levels = [hashes.slice()]
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1]
    const next = []
    for (let index = 0; index < current.length; index += 2) {
      next.push(hashPair(current[index], current[index + 1] ?? current[index]))
    }
    levels.push(next)
  }
  return { levels, root: levels[levels.length - 1][0] }
}

/** @param {string[]} hashes */
export function merkleRoot(hashes) {
  return buildMerkleTree(hashes).root
}

/**
 * @param {string[]} hashes
 * @param {number} index
 * @returns {{root: string, index: number, total: number, leaf: string, path: Array<{hash: string, side: 'left'|'right'}>}}
 */
export function merkleProof(hashes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) throw new UpdateError('BAD_PROOF', 'leaf index out of range')
  const { levels, root } = buildMerkleTree(hashes)
  const path = []
  let position = index
  for (let depth = 0; depth < levels.length - 1; depth += 1) {
    const level = levels[depth]
    const sibling = position % 2 === 0 ? position + 1 : position - 1
    path.push({ hash: level[sibling] ?? level[position], side: position % 2 === 0 ? 'right' : 'left' })
    position = Math.floor(position / 2)
  }
  return { root, index, total: hashes.length, leaf: hashes[index], path }
}

/**
 * @param {string} leaf sha256 hex
 * @param {Array<{hash: string, side: 'left'|'right'}>} path
 * @param {string} root
 * @returns {boolean}
 */
export function verifyMerkleProof(leaf, path, root) {
  if (typeof leaf !== 'string' || !HEX_64.test(leaf)) return false
  if (typeof root !== 'string' || !HEX_64.test(root) || !Array.isArray(path)) return false
  let current = leaf
  for (const node of path) {
    if (!node || !HEX_64.test(node.hash) || (node.side !== 'left' && node.side !== 'right')) return false
    current = node.side === 'right' ? hashPair(current, node.hash) : hashPair(node.hash, current)
  }
  return current === root
}

/**
 * Bind a file descriptor (path, size, content hash) into one Merkle leaf.
 * @param {{path: string, size: number, sha256: string}} file
 */
export function hashFileDescriptor(file) {
  if (!file || typeof file.path !== 'string' || !Number.isInteger(file.size) || !HEX_64.test(file.sha256)) {
    throw new UpdateError('BAD_MANIFEST', 'file descriptor is incomplete')
  }
  return sha256Hex(`file\u0000${file.path}\u0000${file.size}\u0000${file.sha256}`)
}

/** @param {Uint8Array[]} chunks */
export function chunkHashes(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new UpdateError('BAD_CHUNKS', 'at least one chunk is required')
  return chunks.map((chunk) => sha256Hex(toBytes(chunk)))
}

/** @param {Array<Uint8Array|string>} chunks @param {number} index */
export function createChunkProof(chunks, index) {
  return merkleProof(chunkHashes(chunks), index)
}

/**
 * @param {Uint8Array|string} chunk
 * @param {{index: number, path: Array, root: string}} proof
 * @param {{root?: string, index?: number}} [options]
 */
export function verifyChunkProof(chunk, proof, options = {}) {
  if (!proof || !Array.isArray(proof.path)) throw new UpdateError('BAD_PROOF', 'chunk proof is missing')
  if (options.index !== undefined && proof.index !== options.index) return false
  const root = options.root ?? proof.root
  if (typeof root !== 'string' || !HEX_64.test(root)) throw new UpdateError('BAD_PROOF', 'chunk proof has no root')
  return verifyMerkleProof(sha256Hex(toBytes(chunk)), proof.path, root)
}

/**
 * @param {{path: string, size: number, sha256: string, chunks?: {size: number, count: number, root: string}}} file
 * @param {Array<Uint8Array|string>} chunks
 */
export function verifyFileChunks(file, chunks) {
  if (!file?.chunks) throw new UpdateError('NO_CHUNK_ROOT', 'file has no chunk root')
  if (!Array.isArray(chunks) || chunks.length !== file.chunks.count) throw new UpdateError('CHUNK_COUNT_MISMATCH', 'chunk count mismatch')
  const bytes = chunks.map(toBytes)
  let total = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index].length > file.chunks.size) throw new UpdateError('CHUNK_SIZE_MISMATCH', `chunk ${index} exceeds the declared chunk size`)
    if (bytes[index].length === 0) throw new UpdateError('CHUNK_SIZE_MISMATCH', `chunk ${index} is empty`)
    total += bytes[index].length
  }
  if (total !== file.size) throw new UpdateError('CHUNK_SIZE_MISMATCH', 'chunks do not cover the declared file size')
  const root = merkleRoot(chunkHashes(bytes))
  if (root !== file.chunks.root) throw new UpdateError('CHUNK_ROOT_MISMATCH', 'chunk root does not match the manifest')
  return { valid: true, count: bytes.length, root }
}

/** @param {string} value @returns {boolean} */
function isSafePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

/**
 * @param {string} value
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]}}
 */
export function parseVersion(value) {
  const match = typeof value === 'string' ? SEMVER.exec(value) : null
  if (!match) throw new UpdateError('BAD_VERSION', `invalid semantic version: ${value}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1|0|1}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftToken = a.prerelease[index]
    const rightToken = b.prerelease[index]
    if (leftToken === undefined) return -1
    if (rightToken === undefined) return 1
    if (leftToken === rightToken) continue
    const leftNumeric = /^\d+$/.test(leftToken)
    const rightNumeric = /^\d+$/.test(rightToken)
    if (leftNumeric && rightNumeric) return Number(leftToken) < Number(rightToken) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftToken < rightToken ? -1 : 1
  }
  return 0
}

/** @param {object} manifest */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new UpdateError('BAD_MANIFEST', 'manifest must be an object')
  if (manifest.v !== 1) throw new UpdateError('BAD_MANIFEST', 'unsupported manifest version')
  for (const field of ['product', 'channel', 'keyId', 'issuer']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) throw new UpdateError('BAD_MANIFEST', `manifest.${field} is required`)
  }
  parseVersion(manifest.version)
  parseVersion(manifest.minVersion)
  if (!Number.isFinite(manifest.issuedAt) || !Number.isFinite(manifest.expiresAt)) throw new UpdateError('BAD_MANIFEST', 'manifest timestamps are required')
  if (manifest.expiresAt <= manifest.issuedAt) throw new UpdateError('BAD_MANIFEST', 'manifest expiry must be after issuance')
  if (!HEX_64.test(manifest.merkleRoot)) throw new UpdateError('BAD_MANIFEST', 'manifest.merkleRoot must be sha256 hex')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new UpdateError('BAD_MANIFEST', 'manifest.files must not be empty')
  const paths = new Set()
  for (const file of manifest.files) {
    if (!file || !isSafePath(file.path)) throw new UpdateError('BAD_MANIFEST', `unsafe file path: ${file?.path}`)
    if (paths.has(file.path)) throw new UpdateError('BAD_MANIFEST', `duplicate file path: ${file.path}`)
    paths.add(file.path)
    if (!Number.isInteger(file.size) || file.size < 0) throw new UpdateError('BAD_MANIFEST', `invalid size for ${file.path}`)
    if (!HEX_64.test(file.sha256)) throw new UpdateError('BAD_MANIFEST', `invalid sha256 for ${file.path}`)
    if (file.chunks !== undefined) {
      if (!file.chunks || !Number.isInteger(file.chunks.size) || file.chunks.size <= 0 || !Number.isInteger(file.chunks.count) || file.chunks.count <= 0 || !HEX_64.test(file.chunks.root)) {
        throw new UpdateError('BAD_MANIFEST', `invalid chunk descriptor for ${file.path}`)
      }
    }
  }
  const recomputed = merkleRoot(manifest.files.map(hashFileDescriptor))
  if (recomputed !== manifest.merkleRoot) throw new UpdateError('MERKLE_MISMATCH', 'file descriptors do not match merkleRoot')
  return manifest
}

/** @param {object} file */
function chunkEntry(file) {
  const bytes = toBytes(file.data)
  const chunkSize = file.chunkSize ?? file.chunks?.size ?? 1024
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new UpdateError('BAD_CHUNKS', 'chunkSize must be a positive integer')
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  const hashes = chunkHashes(chunks)
  return { size: chunkSize, count: hashes.length, root: merkleRoot(hashes) }
}

/**
 * @param {{product: string, channel: string, version: string, minVersion?: string, files: Array, issuer?: string, keyId: string, now?: number, ttlSeconds?: number}} options
 */
export function buildManifest(options) {
  const now = options.now ?? Date.now()
  const files = options.files.map((file) => {
    const bytes = file.data === undefined ? undefined : toBytes(file.data)
    const sha256 = bytes ? sha256Hex(bytes) : file.sha256
    const size = bytes ? bytes.length : file.size
    if (typeof sha256 !== 'string' || !HEX_64.test(sha256) || !Number.isInteger(size)) throw new UpdateError('BAD_MANIFEST', `file ${file.path} needs data or sha256+size`)
    const entry = { path: file.path, size, sha256 }
    if (file.data !== undefined && (file.chunkSize !== undefined || file.chunks !== undefined)) entry.chunks = chunkEntry(file)
    return entry
  })
  const manifest = {
    v: 1,
    product: options.product,
    channel: options.channel,
    version: options.version,
    minVersion: options.minVersion ?? '0.0.0',
    issuer: options.issuer ?? 'example-update-service',
    keyId: options.keyId,
    issuedAt: now,
    expiresAt: now + (options.ttlSeconds ?? 86_400) * 1000,
    files,
  }
  manifest.merkleRoot = merkleRoot(files.map(hashFileDescriptor))
  return manifest
}

export async function generateUpdateKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const keyId = `update-key-${sha256Hex(canonicalJson(publicJwk)).slice(0, 16)}`
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, privateJwk, publicJwk, keyId }
}

/**
 * @param {{privateKey?: CryptoKey, privateJwk?: object}} keys
 * @param {object} manifest
 * @returns {Promise<{v: number, alg: string, keyId: string, manifest: object, signature: string}>}
 */
export async function signManifest(keys, manifest) {
  validateManifest(manifest)
  const key = keys.privateKey ?? (await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonicalJson(manifest)))
  return { v: 1, alg: ALGORITHM, keyId: manifest.keyId, manifest, signature: toBase64Url(new Uint8Array(signature)) }
}

/** @param {object} jwk */
async function importVerifyKey(jwk) {
  try {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  } catch {
    throw new UpdateError('BAD_KEY', 'trusted key is not a valid P-256 public JWK')
  }
}

/** @param {object} envelope @param {object} key */
async function verifySignature(envelope, key) {
  const publicKey = key.publicKey ?? (await importVerifyKey(key.publicJwk))
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromBase64Url(envelope.signature),
      encoder.encode(canonicalJson(envelope.manifest)),
    )
  } catch {
    throw new UpdateError('BAD_SIGNATURE', 'signature could not be verified')
  }
  if (!valid) throw new UpdateError('BAD_SIGNATURE', 'manifest signature is invalid')
}

/** @param {object} manifest @param {Record<string, Uint8Array|string>} artifacts */
function verifyArtifacts(manifest, artifacts) {
  const verified = []
  for (const file of manifest.files) {
    const artifact = artifacts[file.path]
    if (artifact === undefined) throw new UpdateError('MISSING_ARTIFACT', `missing artifact: ${file.path}`)
    const bytes = toBytes(artifact)
    if (bytes.length !== file.size) throw new UpdateError('SIZE_MISMATCH', `artifact size mismatch: ${file.path}`)
    if (sha256Hex(bytes) !== file.sha256) throw new UpdateError('HASH_MISMATCH', `artifact hash mismatch: ${file.path}`)
    verified.push(file.path)
  }
  return verified
}

/**
 * @param {object} envelope
 * @param {{
 *   now?: number, product?: string, channel?: string,
 *   trustedKeys?: Array<{keyId: string, publicJwk?: object, publicKey?: CryptoKey, notBefore?: number, notAfter?: number}>,
 *   revokedKeyIds?: string[], clockSkewMs?: number,
 *   state?: {version?: string, product?: string, channel?: string},
 *   artifacts?: Record<string, Uint8Array|string>
 * }} [options]
 */
export async function verifyManifest(envelope, options = {}) {
  if (!envelope || envelope.alg !== ALGORITHM || envelope.v !== 1) throw new UpdateError('BAD_ENVELOPE', 'unsupported update envelope')
  const manifest = envelope.manifest
  if (!manifest || typeof manifest !== 'object' || typeof manifest.keyId !== 'string') throw new UpdateError('BAD_MANIFEST', 'manifest is missing')
  if (envelope.keyId !== manifest.keyId) throw new UpdateError('KEY_ID_MISMATCH', 'envelope and manifest key ids differ')
  const trustedKeys = options.trustedKeys ?? []
  const key = trustedKeys.find((candidate) => candidate.keyId === manifest.keyId)
  if (!key) throw new UpdateError('UNKNOWN_KEY', `no trusted key for ${manifest.keyId}`)
  const revoked = new Set(options.revokedKeyIds ?? [])
  if (revoked.has(manifest.keyId)) throw new UpdateError('REVOKED_KEY', `key ${manifest.keyId} is revoked`)
  const now = options.now ?? Date.now()
  if (Number.isFinite(key.notBefore) && now < key.notBefore) throw new UpdateError('KEY_NOT_YET_VALID', 'signing key is not valid yet')
  if (Number.isFinite(key.notAfter) && now > key.notAfter) throw new UpdateError('EXPIRED_KEY', 'signing key has expired')
  await verifySignature(envelope, key)
  validateManifest(manifest)
  const skew = options.clockSkewMs ?? 0
  if (now > manifest.expiresAt + skew) throw new UpdateError('EXPIRED', 'manifest has expired')
  if (manifest.issuedAt > now + skew) throw new UpdateError('NOT_YET_VALID', 'manifest is not valid yet')
  if (options.product !== undefined && manifest.product !== options.product) throw new UpdateError('BAD_PRODUCT', 'manifest product mismatch')
  if (options.channel !== undefined && manifest.channel !== options.channel) throw new UpdateError('BAD_CHANNEL', 'manifest channel mismatch')
  const state = options.state
  if (state?.product !== undefined && state.product !== manifest.product) throw new UpdateError('STATE_MISMATCH', 'installed product differs')
  if (state?.channel !== undefined && state.channel !== manifest.channel) throw new UpdateError('STATE_MISMATCH', 'installed channel differs')
  if (compareVersions(manifest.version, manifest.minVersion) < 0) throw new UpdateError('ROLLBACK_REJECTED', 'manifest version is below its signed minimum')
  if (state?.version !== undefined && compareVersions(manifest.version, state.version) <= 0) {
    throw new UpdateError('ROLLBACK_REJECTED', `version ${manifest.version} is not newer than installed ${state.version}`)
  }
  const verifiedArtifacts = options.artifacts ? verifyArtifacts(manifest, options.artifacts) : []
  return {
    valid: true,
    manifest,
    keyId: manifest.keyId,
    root: manifest.merkleRoot,
    fileCount: manifest.files.length,
    verifiedArtifacts,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
  }
}

/**
 * Stateful verifier with pinned trust roots and anti-rollback state.
 */
export class SecureUpdateVerifier {
  constructor(options = {}) {
    this.trustedKeys = options.trustedKeys ?? []
    this.revokedKeyIds = new Set(options.revokedKeyIds ?? [])
    this.product = options.product
    this.channel = options.channel
    this.clockSkewMs = options.clockSkewMs ?? 0
    this.now = options.now
    this.state = options.state ?? null
  }

  verify(envelope, options = {}) {
    return verifyManifest(envelope, {
      trustedKeys: this.trustedKeys,
      revokedKeyIds: [...this.revokedKeyIds],
      product: this.product,
      channel: this.channel,
      clockSkewMs: this.clockSkewMs,
      now: this.now,
      state: this.state ?? undefined,
      ...options,
    })
  }

  /** @param {object} manifest @param {string} path @param {Array} chunks */
  verifyChunks(manifest, path, chunks) {
    const file = manifest.files.find((candidate) => candidate.path === path)
    if (!file) throw new UpdateError('UNKNOWN_FILE', `manifest has no file ${path}`)
    return verifyFileChunks(file, chunks)
  }

  /** @param {object} manifest @param {string} path @param {Uint8Array|string} chunk @param {number} index @param {object} proof */
  verifyChunk(manifest, path, chunk, index, proof) {
    const file = manifest.files.find((candidate) => candidate.path === path)
    if (!file) throw new UpdateError('UNKNOWN_FILE', `manifest has no file ${path}`)
    if (!file.chunks) throw new UpdateError('NO_CHUNK_ROOT', `file ${path} has no chunk root`)
    return verifyChunkProof(chunk, proof, { root: file.chunks.root, index })
  }

  /** @param {{manifest?: object, version?: string}} result */
  commit(result) {
    const manifest = result.manifest ?? result
    this.state = { version: manifest.version, product: manifest.product, channel: manifest.channel, updatedAt: this.now ?? Date.now() }
    return { ...this.state }
  }
}

/** @param {object} manifest */
export function manifestDigest(manifest) {
  return sha256Hex(canonicalJson(manifest))
}

/** @param {Uint8Array|string} data */
export function artifactDigest(data) {
  return sha256Hex(toBytes(data))
}
