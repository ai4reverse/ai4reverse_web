import assert from 'node:assert/strict'
import { createIdentity, exportPublic, establishSession, encrypt, decrypt, sealFor, E2EEError } from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try { await fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

const alice = await createIdentity()
const bob = await createIdentity()
const aliceSession = await establishSession(alice, exportPublic(bob))
const bobSession = await establishSession(bob, exportPublic(alice))

await check('identities have distinct fingerprints', () => {
  assert.notEqual(alice.fingerprint, bob.fingerprint)
  assert.equal(alice.fingerprint.length, 22)
  assert.equal(exportPublic(alice).kty, 'EC')
})

await check('both sides derive the same session', () => {
  assert.equal(aliceSession.transcriptFingerprint, bobSession.transcriptFingerprint)
  assert.equal(aliceSession.peerFingerprint, bob.fingerprint)
})

await check('alice to bob roundtrip', async () => {
  const envelope = await encrypt(aliceSession, 'hello bob')
  assert.equal(await decrypt(bobSession, envelope), 'hello bob')
})

await check('bob to alice roundtrip with binary-safe text', async () => {
  const text = '你好 😀 – line\nbreak'
  const envelope = await encrypt(bobSession, text)
  assert.equal(await decrypt(aliceSession, envelope), text)
})

await check('tampered ciphertext is rejected', async () => {
  const envelope = await encrypt(aliceSession, 'secret')
  const bytes = Buffer.from(envelope.ct.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  bytes[0] ^= 0xff
  envelope.ct = bytes.toString('base64url')
  await assert.rejects(() => decrypt(bobSession, envelope), (error) => error.code === 'DECRYPT_FAILED')
})

await check('wrong session and custom AAD are rejected', async () => {
  const carol = await createIdentity()
  const wrongSession = await establishSession(carol, exportPublic(bob))
  const envelope = await encrypt(aliceSession, 'bound')
  await assert.rejects(() => decrypt(wrongSession, envelope), (error) => error.code === 'DECRYPT_FAILED')
  const aadEnvelope = await encrypt(aliceSession, 'tenant', { aad: 'tenant-a' })
  assert.equal(await decrypt(bobSession, aadEnvelope, { aad: 'tenant-a' }), 'tenant')
  await assert.rejects(() => decrypt(bobSession, aadEnvelope, { aad: 'tenant-b' }), (error) => error.code === 'DECRYPT_FAILED')
})

await check('fresh IV per message and convenience sealing', async () => {
  const first = await encrypt(aliceSession, 'same')
  const second = await encrypt(aliceSession, 'same')
  assert.notEqual(first.iv, second.iv)
  const envelope = await sealFor(alice, exportPublic(bob), 'sealed')
  assert.equal(await decrypt(bobSession, envelope), 'sealed')
})

console.log(`checks: ${passed}/${total}`)
