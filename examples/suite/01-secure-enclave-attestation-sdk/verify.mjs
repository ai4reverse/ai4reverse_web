import assert from 'node:assert/strict'
import {
  AttestationError,
  ReplayCache,
  canonicalJson,
  createAttestor,
  createChallenge,
  createKeyRing,
  createPolicy,
  exportPublicKeyPem,
  generateEnclaveKeyPair,
  measureManifest,
  measurementRoot,
  sha256Hex,
  verifyAttestation,
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

const NOW = 1_700_000_000_000
const manifest = {
  'boot/loader.bin': 'loader-v1',
  'app/enclave.wasm': 'wasm-bytes',
  'app/policy.json': '{"allow":["read"]}',
}
const measurement = measureManifest(manifest)
const challenge = createChallenge({ ttlMs: 60_000, now: NOW })
const policy = createPolicy({
  name: 'payments-enclave',
  measurements: [measurement.root],
  enclaves: ['enclave-payments-1'],
  requiredClaims: { region: 'eu', build: 'release' },
  maxQuoteAgeMs: 30_000,
})
const keyPair = generateEnclaveKeyPair()
const attestor = createAttestor({
  enclaveId: 'enclave-payments-1',
  privateKey: keyPair.privateKey,
  keyId: keyPair.keyId,
  policy,
  claims: { region: 'eu', build: 'release' },
  ttlMs: 30_000,
  clock: () => NOW,
})
const quote = attestor.attest({ challenge, manifest })
const verifyOptions = { publicKey: keyPair.publicKey, challenge, policy, now: NOW }

await check('canonical json is order-independent and measurement is stable', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const repeated = measureManifest({ ...manifest })
  assert.deepEqual(repeated, measurement)
  assert.match(measurement.root, /^[0-9a-f]{64}$/)
  assert.equal(measurement.modules.length, 3)
  assert.equal(measurement.modules[0].path, 'app/enclave.wasm')
})

await check('a single changed byte changes the root measurement', () => {
  const changed = measureManifest({ ...manifest, 'boot/loader.bin': 'loader-v2' })
  assert.notEqual(changed.root, measurement.root)
  assert.equal(changed.modules.find((module) => module.path === 'boot/loader.bin').sha256, sha256Hex('loader-v2'))
  assert.throws(() => measureManifest({}), (error) => error.code === 'BAD_MANIFEST')
})

await check('challenge nonces are unique and carry expiry', () => {
  const other = createChallenge({ ttlMs: 5_000, now: NOW })
  assert.notEqual(other.nonce, challenge.nonce)
  assert.equal(other.expiresAt - other.issuedAt, 5_000)
  assert.match(other.nonce, /^[A-Za-z0-9_-]{40,}$/)
  assert.throws(() => createChallenge({ ttlMs: 0 }), (error) => error.code === 'BAD_TTL')
})

await check('valid quote verifies with every check green', () => {
  const result = verifyAttestation(quote, { ...verifyOptions, replayCache: new ReplayCache() })
  assert.equal(result.valid, true, result.reason)
  assert.equal(result.checks.length, 16)
  assert.ok(result.checks.every((entry) => entry.ok))
  assert.equal(result.measurement, measurement.root)
  assert.equal(result.enclaveId, 'enclave-payments-1')
  assert.equal(quote.reportData.length, 64)
  assert.equal(quote.policyHash, policy.hash)
})

await check('verification accepts PEM public keys and a key ring', () => {
  const pem = exportPublicKeyPem(keyPair.publicKey)
  assert.equal(verifyAttestation(quote, { ...verifyOptions, publicKey: pem }).valid, true)
  const ring = createKeyRing([{ keyId: keyPair.keyId, publicKey: pem }])
  assert.equal(verifyAttestation(quote, { ...verifyOptions, publicKey: undefined, keyRing: ring }).valid, true)
  assert.throws(() => createKeyRing([]), (error) => error.code === 'BAD_KEYRING')
})

await check('tampered module list breaks signature and root binding', () => {
  const tampered = structuredClone(quote)
  tampered.modules[0].sha256 = sha256Hex('evil')
  const result = verifyAttestation(tampered, verifyOptions)
  assert.equal(result.valid, false)
  assert.ok(result.checks.some((entry) => entry.name === 'signature' && !entry.ok))
  assert.ok(result.checks.some((entry) => entry.name === 'measurement.root' && !entry.ok))
  assert.match(result.reason, /signature|measurement/)
})

await check('tampered claims are rejected by digest and signature', () => {
  const tampered = structuredClone(quote)
  tampered.claims.region = 'us'
  const result = verifyAttestation(tampered, verifyOptions)
  assert.equal(result.valid, false)
  assert.ok(result.checks.some((entry) => entry.name === 'claims.digest' && !entry.ok))
  assert.ok(result.checks.some((entry) => entry.name === 'signature' && !entry.ok))
})

await check('nonce and challenge id must match the request', () => {
  const otherChallenge = createChallenge({ now: NOW })
  const result = verifyAttestation(quote, { ...verifyOptions, challenge: otherChallenge })
  assert.equal(result.valid, false)
  assert.ok(result.checks.some((entry) => entry.name === 'challenge.nonce' && !entry.ok))
  assert.ok(result.checks.some((entry) => entry.name === 'challenge.id' && !entry.ok))
  const absent = verifyAttestation(quote, { ...verifyOptions, challenge: undefined })
  assert.ok(absent.checks.some((entry) => entry.name === 'challenge.present' && !entry.ok))
})

await check('expired and stale quotes are rejected', () => {
  const expired = verifyAttestation(quote, { ...verifyOptions, now: NOW + 31_000 })
  assert.equal(expired.valid, false)
  assert.ok(expired.checks.some((entry) => entry.name === 'freshness.expiresAt' && !entry.ok))
  const stale = verifyAttestation(quote, { ...verifyOptions, maxQuoteAgeMs: 1_000, now: NOW + 2_000 })
  assert.equal(stale.valid, false)
  assert.ok(stale.checks.some((entry) => entry.name === 'freshness.age' && !entry.ok))
  const future = verifyAttestation(quote, { ...verifyOptions, now: NOW - 10_000 })
  assert.ok(future.checks.some((entry) => entry.name === 'freshness.issuedAt' && !entry.ok))
})

await check('replay cache rejects a second use of the same quote', () => {
  const replay = new ReplayCache({ capacity: 2 })
  const first = verifyAttestation(quote, { ...verifyOptions, replayCache: replay })
  assert.equal(first.valid, true)
  assert.equal(replay.size, 1)
  const second = verifyAttestation(quote, { ...verifyOptions, replayCache: replay })
  assert.equal(second.valid, false)
  assert.ok(second.checks.some((entry) => entry.name === 'replay.unseen' && !entry.ok))
  replay.clear()
  assert.equal(replay.size, 0)
  assert.equal(verifyAttestation(quote, { ...verifyOptions, replayCache: replay }).valid, true)
})

await check('policy rejects unlisted measurements, enclaves and claims', () => {
  const foreign = createPolicy({ name: 'foreign', measurements: [sha256Hex('other')], enclaves: ['other'], maxQuoteAgeMs: 30_000 })
  const result = verifyAttestation(quote, { ...verifyOptions, policy: foreign })
  assert.equal(result.valid, false)
  assert.ok(result.checks.some((entry) => entry.name === 'policy.hash' && !entry.ok))
  assert.ok(result.checks.some((entry) => entry.name === 'policy.measurement' && !entry.ok))
  assert.ok(result.checks.some((entry) => entry.name === 'policy.enclave' && !entry.ok))
  const claimsPolicy = createPolicy({
    name: 'payments-enclave',
    measurements: [measurement.root],
    enclaves: ['enclave-payments-1'],
    requiredClaims: { region: 'us', build: 'release' },
    maxQuoteAgeMs: 30_000,
  })
  assert.notEqual(claimsPolicy.hash, policy.hash)
  const claimsResult = verifyAttestation(quote, { ...verifyOptions, policy: claimsPolicy })
  assert.ok(claimsResult.checks.some((entry) => entry.name === 'policy.claims' && !entry.ok))
})

await check('key rotation enforces validity windows', () => {
  const old = createKeyRing([{ keyId: keyPair.keyId, publicKey: keyPair.publicKey, notAfter: NOW - 1 }])
  assert.throws(() => old.resolve(keyPair.keyId, NOW), (error) => error.code === 'KEY_NOT_FOUND')
  const overlapping = createKeyRing([
    { keyId: keyPair.keyId, publicKey: keyPair.publicKey, notBefore: NOW - 1_000, notAfter: NOW + 5_000 },
    { keyId: 'next-key', publicKey: keyPair.publicKey, notBefore: NOW },
  ])
  assert.equal(overlapping.resolve(keyPair.keyId, NOW), keyPair.publicKey)
  assert.equal(verifyAttestation(quote, { ...verifyOptions, publicKey: undefined, keyRing: overlapping }).valid, true)
  assert.throws(
    () => createKeyRing([{ keyId: 'a', publicKey: keyPair.publicKey }, { keyId: 'a', publicKey: keyPair.publicKey }]),
    (error) => error.code === 'BAD_KEYRING',
  )
})

await check('malformed quotes fail closed instead of throwing', () => {
  for (const bad of [null, {}, { version: 1 }, { ...quote, version: 9 }, { ...quote, modules: [] }]) {
    const result = verifyAttestation(bad, verifyOptions)
    assert.equal(result.valid, false)
    assert.equal(result.checks[0].name, 'structure')
  }
  assert.throws(
    () => createAttestor({ enclaveId: 'x', privateKey: 'not-a-key' }),
    (error) => error instanceof AttestationError && error.code === 'BAD_KEY',
  )
  assert.throws(() => measurementRoot([{ path: 'a', sha256: 'zz', size: 1 }]), (error) => error.code === 'BAD_MANIFEST')
})

console.log(`checks: ${passed}/${total}`)
