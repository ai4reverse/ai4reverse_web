import assert from 'node:assert/strict'
import {
  base64urlEncode, base64urlDecode, createRegistrationOptions, createAuthenticationOptions,
  parseClientData, verifyRegistrationResponse, verifyAssertion, serializeCredential, deserializeCredential, PasskeyError,
} from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try { await fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()

await check('base64url roundtrip', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(48))
  assert.deepEqual(Array.from(base64urlDecode(base64urlEncode(bytes))), Array.from(bytes))
  assert.doesNotMatch(base64urlEncode(bytes), /[+/=]/)
})

await check('registration options shape', () => {
  const options = createRegistrationOptions({ rpId: 'example.test', rpName: 'Example', userId: 'user-1', userName: 'alice@example.test' })
  assert.equal(options.publicKey.rp.id, 'example.test')
  assert.ok(options.publicKey.challenge.length > 20)
  assert.equal(Buffer.from(base64urlDecode(options.publicKey.user.id)).toString(), 'user-1')
  assert.equal(options.publicKey.pubKeyCredParams.length, 2)
})

await check('authentication options shape', () => {
  const options = createAuthenticationOptions({ rpId: 'example.test', allowCredentials: [{ id: 'abc' }] })
  assert.equal(options.publicKey.rpId, 'example.test')
  assert.equal(options.publicKey.allowCredentials[0].id, 'abc')
})

await check('clientData parsing', () => {
  const data = { type: 'webauthn.create', challenge: 'abc', origin: 'https://example.test' }
  const parsed = parseClientData({ clientDataJSON: base64urlEncode(encoder.encode(JSON.stringify(data))) })
  assert.equal(parsed.data.challenge, 'abc')
  assert.throws(() => parseClientData({ clientDataJSON: base64urlEncode(encoder.encode('not-json')) }), (error) => error.code === 'BAD_CLIENT_DATA')
})

// Build deterministic authenticator data for rpId example.test.
const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('example.test')))
const credentialId = crypto.getRandomValues(new Uint8Array(16))
const authData = new Uint8Array(55 + credentialId.length + 3)
authData.set(rpIdHash, 0)
authData[32] = 0x45 // UP + UV + AT
new DataView(authData.buffer).setUint32(33, 7)
authData.set(crypto.getRandomValues(new Uint8Array(16)), 37) // AAGUID
new DataView(authData.buffer).setUint16(53, credentialId.length)
authData.set(credentialId, 55)
authData.set([0xa1, 0x01, 0x02], 55 + credentialId.length)
const attestationObject = new Uint8Array([0xa3, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65, ...authData])

const challenge = 'challenge-123'
const clientDataJSON = base64urlEncode(encoder.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: 'https://example.test' })))

await check('registration verification', async () => {
  const result = await verifyRegistrationResponse(
    { response: { clientDataJSON, attestationObject } },
    { challenge, origin: 'https://example.test', rpId: 'example.test' },
  )
  assert.equal(result.verified, true)
  assert.equal(result.credentialId, base64urlEncode(credentialId))
  assert.equal(result.signCount, 7)
})

await check('registration rejects bad challenge/origin/type', async () => {
  await assert.rejects(
    () => verifyRegistrationResponse({ response: { clientDataJSON, attestationObject } }, { challenge: 'wrong', rpId: 'example.test' }),
    (error) => error.code === 'BAD_CHALLENGE',
  )
  await assert.rejects(
    () => verifyRegistrationResponse({ response: { clientDataJSON, attestationObject } }, { challenge, origin: 'https://evil.test', rpId: 'example.test' }),
    (error) => error.code === 'BAD_ORIGIN',
  )
})

await check('assertion verification and signature hook', async () => {
  const assertionData = base64urlEncode(encoder.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://example.test' })))
  const result = await verifyAssertion(
    { response: { clientDataJSON: assertionData, authenticatorData: authData, id: base64urlEncode(credentialId), signature: 'sig' } },
    { challenge, origin: 'https://example.test', credentialId: base64urlEncode(credentialId), verifySignature: () => true },
  )
  assert.equal(result.verified, true)
  await assert.rejects(
    () => verifyAssertion(
      { response: { clientDataJSON: assertionData, authenticatorData: authData, id: base64urlEncode(credentialId) } },
      { challenge, origin: 'https://example.test', credentialId: base64urlEncode(credentialId), verifySignature: () => false },
    ),
    (error) => error.code === 'BAD_SIGNATURE',
  )
})

await check('credential serialization roundtrip', () => {
  const credential = { id: 'cred-1', rawId: credentialId, publicKey: 'pk', signCount: 3 }
  const restored = deserializeCredential(serializeCredential(credential))
  assert.equal(restored.id, 'cred-1')
  assert.equal(restored.signCount, 3)
  assert.throws(() => deserializeCredential('{"id":""}'), (error) => error instanceof PasskeyError)
})

console.log(`checks: ${passed}/${total}`)
