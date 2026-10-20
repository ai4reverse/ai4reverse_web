import assert from 'node:assert/strict'
import {
  ALGORITHM,
  SecureUpdateVerifier,
  artifactDigest,
  buildManifest,
  canonicalJson,
  compareVersions,
  createChunkProof,
  generateUpdateKeys,
  manifestDigest,
  merkleProof,
  merkleRoot,
  parseVersion,
  sha256Hex,
  signManifest,
  toBase64Url,
  validateManifest,
  verifyChunkProof,
  verifyFileChunks,
  verifyManifest,
  verifyMerkleProof,
} from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}

const encoder = new TextEncoder()
function splitChunks(text, size) {
  const bytes = encoder.encode(text)
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.slice(offset, Math.min(offset + size, bytes.length)))
  return chunks
}

const now = 1_800_000_000_000
const keys = await generateUpdateKeys()
const appData = 'console.log("acme update 2.4.1")\n'.repeat(50)
const configData = '{"featureFlag":true,"channel":"stable"}'
const manifest = buildManifest({
  product: 'acme-client',
  channel: 'stable',
  version: '2.4.1',
  minVersion: '2.0.0',
  keyId: keys.keyId,
  now,
  ttlSeconds: 3600,
  files: [
    { path: 'app.js', data: appData, chunkSize: 256 },
    { path: 'config.json', data: configData },
  ],
})
const envelope = await signManifest(keys, manifest)
const trustedKeys = [{ keyId: keys.keyId, publicJwk: keys.publicJwk }]
const baseOptions = { now: now + 1000, product: 'acme-client', channel: 'stable', trustedKeys }
const artifacts = { 'app.js': appData, 'config.json': configData }

await check('merkle trees prove every leaf and reject tampering', () => {
  const leaves = ['alpha', 'beta', 'gamma', 'delta'].map((value) => sha256Hex(value))
  const root = merkleRoot(leaves)
  assert.equal(root.length, 64)
  for (let index = 0; index < leaves.length; index += 1) {
    const proof = merkleProof(leaves, index)
    assert.equal(proof.root, root)
    assert.equal(proof.total, 4)
    assert.equal(verifyMerkleProof(proof.leaf, proof.path, root), true)
    assert.equal(verifyMerkleProof(sha256Hex('forged'), proof.path, root), false)
    const flipped = proof.path.map((node, position) => (position === 0 ? { ...node, side: node.side === 'left' ? 'right' : 'left' } : node))
    assert.equal(verifyMerkleProof(proof.leaf, flipped, root), false)
  }
  const odd = leaves.slice(0, 3)
  for (let index = 0; index < odd.length; index += 1) {
    const proof = merkleProof(odd, index)
    assert.equal(verifyMerkleProof(proof.leaf, proof.path, proof.root), true)
  }
  assert.throws(() => merkleProof(leaves, 4), (error) => error.code === 'BAD_PROOF')
  assert.throws(() => merkleRoot([]), (error) => error.code === 'BAD_MERKLE')
})

await check('a signed manifest verifies with artifacts', async () => {
  const result = await verifyManifest(envelope, { ...baseOptions, artifacts })
  assert.equal(result.valid, true)
  assert.equal(result.keyId, keys.keyId)
  assert.equal(result.fileCount, 2)
  assert.equal(result.root, manifest.merkleRoot)
  assert.deepEqual(result.verifiedArtifacts, ['app.js', 'config.json'])
  assert.equal(result.manifest.version, '2.4.1')
  assert.equal(manifest.files[0].chunks.count, Math.ceil(encoder.encode(appData).length / 256))
  assert.equal(artifactDigest(appData), manifest.files[0].sha256)
  assert.equal(manifestDigest(manifest).length, 64)
})

await check('tampered manifests and signatures are rejected', async () => {
  const forged = structuredClone(envelope)
  forged.manifest.version = '9.9.9'
  await assert.rejects(() => verifyManifest(forged, baseOptions), (error) => error.code === 'BAD_SIGNATURE')
  const badSignature = { ...envelope, signature: toBase64Url(new Uint8Array(64)) }
  await assert.rejects(() => verifyManifest(badSignature, baseOptions), (error) => error.code === 'BAD_SIGNATURE')
  const mismatchedId = { ...envelope, keyId: 'other-key' }
  await assert.rejects(() => verifyManifest(mismatchedId, baseOptions), (error) => error.code === 'KEY_ID_MISMATCH')
  const other = await generateUpdateKeys()
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, trustedKeys: [{ keyId: keys.keyId, publicJwk: other.publicJwk }] }),
    (error) => error.code === 'BAD_SIGNATURE',
  )
})

await check('expiry, clock skew and not-before windows are enforced', async () => {
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, now: manifest.expiresAt + 1 }), (error) => error.code === 'EXPIRED')
  const skewed = await verifyManifest(envelope, { ...baseOptions, now: manifest.expiresAt + 30_000, clockSkewMs: 60_000 })
  assert.equal(skewed.valid, true)
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, now: now - 10_000 }), (error) => error.code === 'NOT_YET_VALID')
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, artifacts: undefined, now: now + 3_600_001 }), (error) => error.code === 'EXPIRED')
})

await check('version anti-rollback uses signed floor and installed state', async () => {
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, state: { version: '2.4.1', product: 'acme-client', channel: 'stable' } }),
    (error) => error.code === 'ROLLBACK_REJECTED',
  )
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, state: { version: '2.5.0', product: 'acme-client', channel: 'stable' } }),
    (error) => error.code === 'ROLLBACK_REJECTED',
  )
  const floorManifest = buildManifest({ ...manifest, version: '1.9.0', minVersion: '2.0.0', now })
  const floorEnvelope = await signManifest(keys, floorManifest)
  await assert.rejects(() => verifyManifest(floorEnvelope, baseOptions), (error) => error.code === 'ROLLBACK_REJECTED')
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, state: { version: '1.0.0', product: 'other-client' } }),
    (error) => error.code === 'STATE_MISMATCH',
  )
  assert.equal(compareVersions('2.4.1', '2.4.0'), 1)
  assert.equal(compareVersions('2.4.1', '2.4.1'), 0)
  assert.equal(compareVersions('2.0.0-rc.2', '2.0.0-rc.10'), -1)
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0'), -1)
  assert.equal(parseVersion('2.4.1').minor, 4)
  assert.throws(() => parseVersion('2.4'), (error) => error.code === 'BAD_VERSION')
})

await check('product and channel binding rejects cross-channel updates', async () => {
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, product: 'other-client' }), (error) => error.code === 'BAD_PRODUCT')
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, channel: 'canary' }), (error) => error.code === 'BAD_CHANNEL')
  assert.equal((await verifyManifest(envelope, baseOptions)).manifest.channel, 'stable')
})

await check('key revocation, expiry and trust-root handling', async () => {
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, revokedKeyIds: [keys.keyId] }), (error) => error.code === 'REVOKED_KEY')
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, trustedKeys: [] }), (error) => error.code === 'UNKNOWN_KEY')
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, trustedKeys: [{ keyId: keys.keyId, publicJwk: keys.publicJwk, notAfter: now - 1 }] }),
    (error) => error.code === 'EXPIRED_KEY',
  )
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, trustedKeys: [{ keyId: keys.keyId, publicJwk: keys.publicJwk, notBefore: now + 10_000 }] }),
    (error) => error.code === 'KEY_NOT_YET_VALID',
  )
  const rotated = await generateUpdateKeys()
  const rotatedTrust = { ...baseOptions, trustedKeys: [{ keyId: rotated.keyId, publicJwk: rotated.publicJwk }, ...trustedKeys] }
  assert.equal((await verifyManifest(envelope, rotatedTrust)).valid, true)
})

await check('artifact bytes must match the signed descriptors', async () => {
  await assert.rejects(
    () => verifyManifest(envelope, { ...baseOptions, artifacts: { ...artifacts, 'app.js': 'tampered' } }),
    (error) => error.code === 'HASH_MISMATCH' || error.code === 'SIZE_MISMATCH',
  )
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, artifacts: { 'app.js': appData } }), (error) => error.code === 'MISSING_ARTIFACT')
  const short = appData.slice(0, 10)
  await assert.rejects(() => verifyManifest(envelope, { ...baseOptions, artifacts: { ...artifacts, 'app.js': short } }), (error) => error.code === 'SIZE_MISMATCH')
})

await check('chunk roots and per-chunk proofs are verified', () => {
  const chunks = splitChunks(appData, 256)
  const proof = createChunkProof(chunks, 2)
  assert.equal(proof.total, chunks.length)
  assert.equal(verifyChunkProof(chunks[2], proof), true)
  assert.equal(verifyChunkProof(chunks[2], proof, { index: 2 }), true)
  assert.equal(verifyChunkProof(chunks[2], proof, { index: 3 }), false)
  assert.equal(verifyChunkProof(chunks[3], proof), false)
  const report = verifyFileChunks(manifest.files[0], chunks)
  assert.equal(report.valid, true)
  assert.equal(report.count, chunks.length)
  assert.equal(report.root, manifest.files[0].chunks.root)
  assert.throws(() => verifyFileChunks(manifest.files[0], chunks.slice(0, -1)), (error) => error.code === 'CHUNK_COUNT_MISMATCH')
  const emptyLast = chunks.slice(0, -1).concat([new Uint8Array(0)])
  assert.throws(() => verifyFileChunks(manifest.files[0], emptyLast), (error) => error.code === 'CHUNK_SIZE_MISMATCH')
  const tamperedRoot = { ...manifest.files[0], chunks: { ...manifest.files[0].chunks, root: sha256Hex('other') } }
  assert.throws(() => verifyFileChunks(tamperedRoot, chunks), (error) => error.code === 'CHUNK_ROOT_MISMATCH')
  assert.throws(() => verifyFileChunks(manifest.files[1], [configData]), (error) => error.code === 'NO_CHUNK_ROOT')
})

await check('signed but internally inconsistent manifests fail closed', async () => {
  const tampered = structuredClone(manifest)
  tampered.files[0].sha256 = sha256Hex('forged artifact')
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoder.encode(canonicalJson(tampered)))
  const signed = { v: 1, alg: ALGORITHM, keyId: keys.keyId, manifest: tampered, signature: toBase64Url(new Uint8Array(signature)) }
  await assert.rejects(() => verifyManifest(signed, baseOptions), (error) => error.code === 'MERKLE_MISMATCH')
  assert.throws(() => validateManifest({ ...manifest, version: '2.4' }), (error) => error.code === 'BAD_VERSION')
  assert.throws(() => validateManifest({ ...manifest, files: [] }), (error) => error.code === 'BAD_MANIFEST')
  assert.throws(() => validateManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }), (error) => error.code === 'BAD_MANIFEST')
  assert.throws(() => validateManifest({ ...manifest, files: [{ ...manifest.files[0], path: '../escape.js' }] }), (error) => error.code === 'BAD_MANIFEST')
  assert.throws(() => validateManifest({ ...manifest, files: [{ ...manifest.files[0], path: '/etc/passwd' }] }), (error) => error.code === 'BAD_MANIFEST')
})

await check('stateful verifier commits versions and rejects downgrades', async () => {
  const verifier = new SecureUpdateVerifier({ trustedKeys, product: 'acme-client', channel: 'stable', now: now + 1000 })
  const result = await verifier.verify(envelope, { artifacts })
  assert.equal(result.valid, true)
  const committed = verifier.commit(result)
  assert.equal(committed.version, '2.4.1')
  assert.equal(committed.product, 'acme-client')
  const olderManifest = buildManifest({ ...manifest, version: '2.4.0', now })
  const olderEnvelope = await signManifest(keys, olderManifest)
  await assert.rejects(() => verifier.verify(olderEnvelope), (error) => error.code === 'ROLLBACK_REJECTED')
  await assert.rejects(() => verifier.verify(envelope), (error) => error.code === 'ROLLBACK_REJECTED')
  assert.equal(verifier.verifyChunks(manifest, 'app.js', splitChunks(appData, 256)).valid, true)
  const proof = createChunkProof(splitChunks(appData, 256), 1)
  assert.equal(verifier.verifyChunk(manifest, 'app.js', splitChunks(appData, 256)[1], 1, proof), true)
  assert.equal(verifier.verifyChunk(manifest, 'app.js', splitChunks(appData, 256)[1], 9, proof), false)
  await assert.rejects(() => verifier.verify(envelope, { state: { version: '1.0.0', product: 'other' } }), (error) => error.code === 'STATE_MISMATCH')
})

console.log(`checks: ${passed}/${total}`)
