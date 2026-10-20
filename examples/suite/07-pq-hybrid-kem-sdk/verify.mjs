import assert from 'node:assert/strict'
import {
  ALGORITHM,
  ETA,
  KemError,
  MODULUS,
  RANK,
  RING_N,
  createHybridKem,
  decapsulatePq,
  decodeCiphertext,
  decodePublicKey,
  decodeSecretKey,
  encodeCiphertext,
  encodePublicKey,
  encodeSecretKey,
  encapsulateHybrid,
  encapsulatePq,
  generatePqKeyPair,
  hybridFingerprint,
  polyMul,
  polyFromMessage,
  polyToMessage,
  publicKeySummary,
  sampleCbd,
  secretToHex,
  sha256,
  toBase64Url,
  fromBase64Url,
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

const seed = (value) => new Uint8Array(32).fill(value)

await check('ring arithmetic is negacyclic', () => {
  assert.equal(RING_N, 64)
  assert.equal(MODULUS, 3329)
  assert.equal(RANK, 2)
  assert.equal(ETA, 1)
  const one = new Uint16Array(RING_N)
  const x = new Uint16Array(RING_N)
  one[0] = 1
  x[1] = 1
  const left = new Uint16Array(RING_N)
  left[0] = 1
  left[1] = 1
  const right = new Uint16Array(RING_N)
  right[0] = MODULUS - 1
  right[1] = 1
  const product = polyMul(left, right)
  assert.equal(product[0], MODULUS - 1)
  assert.equal(product[1], 0)
  assert.equal(product[2], 1)
  assert.deepEqual(Array.from(polyMul(x, one)), Array.from(x))
  const message = Uint8Array.of(0x5a, 0, 0, 0, 0, 0, 0, 0)
  assert.deepEqual(Array.from(polyToMessage(polyFromMessage(message))), Array.from(message))
})

await check('central binomial sampling is deterministic and bounded', () => {
  const bytes = new Uint8Array(16)
  bytes[0] = 0x09
  const poly = sampleCbd(bytes)
  assert.equal(poly[0], 1)
  assert.equal(poly[1], MODULUS - 1)
  assert.equal(poly[2], 0)
  assert.deepEqual(Array.from(poly), Array.from(sampleCbd(bytes)))
  assert.ok(Array.from(poly).every((coefficient) => coefficient === 0 || coefficient === 1 || coefficient === MODULUS - 1))
})

const alice = generatePqKeyPair({ aSeed: seed(1), noiseSeed: seed(2) })
const bob = generatePqKeyPair({ aSeed: seed(3), noiseSeed: seed(4) })
const encapsulation = encapsulatePq(alice.publicKey, { seed: seed(5) })

await check('lattice key generation and encapsulation agree', () => {
  assert.equal(alice.publicKey.t.length, RANK)
  assert.equal(encodePublicKey(alice.publicKey).length, 1 + 32 + RANK * RING_N * 2)
  assert.equal(encodeSecretKey(alice.secretKey).length, 1 + RANK * RING_N * 2)
  assert.equal(encapsulation.encoded.length, 1 + RANK * RING_N * 2 + RING_N * 2 + 32)
  const recovered = decapsulatePq(alice.secretKey, encapsulation.encoded)
  assert.equal(secretToHex(recovered.sharedSecret), secretToHex(encapsulation.sharedSecret))
  assert.equal(recovered.sharedSecret.length, 32)
  const fromObject = decapsulatePq(alice.secretKey, encapsulation.ciphertext)
  assert.equal(secretToHex(fromObject.sharedSecret), secretToHex(encapsulation.sharedSecret))
})

await check('key pair generation is deterministic for fixed seeds', () => {
  const repeat = generatePqKeyPair({ aSeed: seed(1), noiseSeed: seed(2) })
  assert.deepEqual(Array.from(encodePublicKey(repeat.publicKey)), Array.from(encodePublicKey(alice.publicKey)))
  assert.equal(repeat.keyId, alice.keyId)
  const second = encapsulatePq(alice.publicKey, { seed: seed(5) })
  assert.deepEqual(Array.from(second.encoded), Array.from(encapsulation.encoded))
  assert.equal(secretToHex(second.sharedSecret), secretToHex(encapsulation.sharedSecret))
  const different = encapsulatePq(alice.publicKey, { seed: seed(6) })
  assert.notDeepEqual(Array.from(different.encoded), Array.from(encapsulation.encoded))
})

await check('ciphertext and key encodings roundtrip', () => {
  const publicKey = decodePublicKey(encodePublicKey(alice.publicKey))
  assert.equal(toBase64Url(encodePublicKey(publicKey)), toBase64Url(encodePublicKey(alice.publicKey)))
  const secretKey = decodeSecretKey(encodeSecretKey(alice.secretKey))
  assert.equal(secretToHex(decapsulatePq(secretKey, encapsulation.encoded).sharedSecret), secretToHex(encapsulation.sharedSecret))
  const ciphertext = decodeCiphertext(encodeCiphertext(encapsulation.ciphertext))
  assert.equal(secretToHex(decapsulatePq(alice.secretKey, ciphertext).sharedSecret), secretToHex(encapsulation.sharedSecret))
  const summary = publicKeySummary({ alg: ALGORITHM, classical: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }, pq: toBase64Url(encodePublicKey(alice.publicKey)) })
  assert.equal(summary.ring, RING_N)
  assert.equal(summary.rank, RANK)
  assert.equal(summary.modulus, MODULUS)
})

await check('tampered and foreign ciphertexts are rejected', () => {
  const forged = { ...encapsulation.ciphertext, u: encapsulation.ciphertext.u.map((poly) => new Uint16Array(poly)) }
  forged.u[0][0] = (forged.u[0][0] + 1200) % MODULUS
  assert.throws(() => decapsulatePq(alice.secretKey, forged), (error) => error instanceof KemError && error.code === 'BAD_CIPHERTEXT')
  const wrongV = { ...encapsulation.ciphertext, v: new Uint16Array(encapsulation.ciphertext.v) }
  wrongV.v[3] = (wrongV.v[3] + 1200) % MODULUS
  assert.throws(() => decapsulatePq(alice.secretKey, wrongV), (error) => error.code === 'BAD_CIPHERTEXT')
  assert.throws(() => decapsulatePq(bob.secretKey, encapsulation.encoded), (error) => error.code === 'BAD_CIPHERTEXT')
  assert.throws(() => decapsulatePq(alice.secretKey, encapsulation.encoded.subarray(0, 20)), (error) => error.code === 'BAD_CIPHERTEXT')
})

await check('malformed public and secret keys are rejected', () => {
  const bytes = encodePublicKey(alice.publicKey)
  const badCoefficient = new Uint8Array(bytes)
  badCoefficient[33] = 0xff
  badCoefficient[34] = 0xff
  assert.throws(() => decodePublicKey(badCoefficient), (error) => error instanceof KemError)
  assert.throws(() => decodePublicKey(bytes.subarray(0, 10)), (error) => error.code === 'BAD_PUBLIC_KEY')
  assert.throws(() => decodeSecretKey(new Uint8Array(5)), (error) => error.code === 'BAD_SECRET_KEY')
  assert.throws(() => decodeCiphertext(new Uint8Array(5)), (error) => error.code === 'BAD_CIPHERTEXT')
  assert.throws(() => seed(16) && generatePqKeyPair({ aSeed: seed(1), noiseSeed: new Uint8Array(31) }), (error) => error.code === 'BAD_SEED')
})

const recipient = await createHybridKem({ aSeed: seed(11), noiseSeed: seed(12) })
const sender = await createHybridKem({ aSeed: seed(13), noiseSeed: seed(14) })

await check('hybrid encapsulation agrees across both halves', async () => {
  const { sharedSecret, envelope } = await sender.encapsulate(recipient.publicKey, { context: 'session-1', pqSeed: seed(15) })
  assert.equal(sharedSecret.length, 32)
  assert.equal(envelope.alg, ALGORITHM)
  assert.equal(envelope.recipient, recipient.fingerprint)
  assert.equal(typeof envelope.epk.x, 'string')
  assert.equal(envelope.pq.length > 300, true)
  assert.equal(envelope.tag.length > 0, true)
  const recovered = await recipient.decapsulate(envelope, { context: 'session-1' })
  assert.equal(secretToHex(recovered), secretToHex(sharedSecret))
  const roundtrip = JSON.parse(JSON.stringify(recipient.publicKey))
  assert.equal(hybridFingerprint(roundtrip), recipient.fingerprint)
  const second = await encapsulateHybrid(sender.publicKey, { context: 'session-1', pqSeed: seed(16) })
  assert.equal(secretToHex(await sender.decapsulate(second.envelope, { context: 'session-1' })), secretToHex(second.sharedSecret))
})

await check('hybrid decapsulation binds recipient and context', async () => {
  const third = await createHybridKem({ aSeed: seed(21), noiseSeed: seed(22) })
  const { envelope } = await sender.encapsulate(recipient.publicKey, { context: 'channel-a', pqSeed: seed(23) })
  await assert.rejects(() => third.decapsulate(envelope, { context: 'channel-a' }), (error) => error.code === 'WRONG_RECIPIENT')
  await assert.rejects(() => recipient.decapsulate(envelope, { context: 'channel-b' }), (error) => error.code === 'CONTEXT_MISMATCH')
  const first = await sender.encapsulate(recipient.publicKey, { context: 'channel-a', pqSeed: seed(24) })
  const second = await sender.encapsulate(recipient.publicKey, { context: 'channel-b', pqSeed: seed(24) })
  assert.notEqual(secretToHex(first.sharedSecret), secretToHex(second.sharedSecret))
})

await check('hybrid envelope tampering is rejected', async () => {
  const { envelope, sharedSecret } = await sender.encapsulate(recipient.publicKey, { context: 'tamper', pqSeed: seed(31) })
  const pqBytes = fromBase64Url(envelope.pq)
  pqBytes[1] ^= 0x01
  const brokenPq = { ...envelope, pq: toBase64Url(pqBytes) }
  await assert.rejects(() => recipient.decapsulate(brokenPq, { context: 'tamper' }), (error) => error instanceof KemError)
  const brokenTag = { ...envelope, tag: toBase64Url(new Uint8Array(8)) }
  await assert.rejects(() => recipient.decapsulate(brokenTag, { context: 'tamper' }), (error) => error.code === 'HYBRID_TAMPERED')
  const brokenContext = { ...envelope, contextHash: toBase64Url(sha256('other')) }
  await assert.rejects(() => recipient.decapsulate(brokenContext, { context: 'tamper' }), (error) => error.code === 'CONTEXT_MISMATCH')
  assert.equal(secretToHex(await recipient.decapsulate(envelope, { context: 'tamper' })), secretToHex(sharedSecret))
})

await check('hybrid decapsulation requires the post-quantum half', async () => {
  const { envelope, sharedSecret } = await sender.encapsulate(recipient.publicKey, { context: 'pq-required', pqSeed: seed(41) })
  const pqOnly = { ...envelope }
  delete pqOnly.pq
  await assert.rejects(() => recipient.decapsulate(pqOnly, { context: 'pq-required' }), (error) => error instanceof KemError)
  const { envelope: otherEnvelope } = await sender.encapsulate(recipient.publicKey, { context: 'pq-required', pqSeed: seed(42) })
  assert.notEqual(otherEnvelope.pq, envelope.pq)
  assert.notEqual(secretToHex((await recipient.decapsulate(otherEnvelope, { context: 'pq-required' }))), '00'.repeat(32))
  assert.equal(sharedSecret.length, 32)
})

await check('classical half is P-256 ECDH and public keys stay compact', async () => {
  const summary = publicKeySummary(recipient.publicKey)
  assert.equal(summary.curve, 'P-256')
  assert.equal(summary.pqKeyId.length, 22)
  assert.equal(summary.fingerprint.length, 43)
  assert.equal(ALGORITHM.includes('P256-ECDH'), true)
  const exported = JSON.parse(JSON.stringify(recipient.publicKey))
  assert.equal(Object.hasOwn(exported.classical, 'd'), false, 'private ECDH scalar must not be exported')
  assert.equal(Object.hasOwn(exported, 's'), false, 'lattice secret must not be exported')
  assert.deepEqual(Object.keys(exported).sort(), ['alg', 'classical', 'pq', 'v'])
})

console.log(`checks: ${passed}/${total}`)
