import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import {
  CredentialStore,
  WebAuthnError,
  authenticate,
  base64urlDecode,
  base64urlEncode,
  coseToPublicKey,
  decodeCbor,
  encodeCbor,
  generateEcKeyPair,
  parseAuthenticatorData,
  parseClientDataJSON,
  parseCoseKey,
  sha256,
  validateClientData,
  verifyAssertion,
  verifyRegistration,
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

const RP_ID = 'example.test'
const ORIGIN = 'https://example.test'
const challenge = base64urlEncode(Buffer.from('webauthn-challenge-0123456789abcdef'))
const keyPair = generateEcKeyPair()
const credentialId = keyPair.credentialId
const userHandle = base64urlEncode(Buffer.from('user-1'))

const u16 = (value) => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value)
  return buffer
}
const u32 = (value) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}
const authData = ({ flags = 0x45, signCount = 0, withCredential = true, extensions = null } = {}) => {
  const parts = [sha256(RP_ID), Buffer.from([flags]), u32(signCount)]
  if (withCredential) parts.push(Buffer.alloc(16), u16(credentialId.length), Buffer.from(credentialId), Buffer.from(keyPair.coseKey))
  if (extensions) parts.push(Buffer.from(encodeCbor(extensions)))
  return Buffer.concat(parts)
}
const clientData = (type, overrides = {}) =>
  base64urlEncode(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, ...overrides })))
const registrationFor = ({ fmt = 'none', flags = 0x45, signCount = 0, clientDataJSON = clientData('webauthn.create'), credential = credentialId } = {}) => {
  const attestationObject = encodeCbor({ fmt, attStmt: {}, authData: authData({ flags, signCount, withCredential: true }) })
  return { id: base64urlEncode(credential), response: { clientDataJSON, attestationObject: base64urlEncode(attestationObject) } }
}
const assertionFor = ({ signCount = 1, flags = 0x05, type = 'webauthn.get', dsaEncoding = 'der', credential = credentialId, origin = ORIGIN, challengeValue = challenge } = {}) => {
  const bytes = authData({ flags, signCount, withCredential: false })
  const json = base64urlEncode(Buffer.from(JSON.stringify({ type, challenge: challengeValue, origin })))
  const clientHash = sha256(base64urlDecode(json))
  const signature = sign('sha256', Buffer.concat([bytes, clientHash]), { key: keyPair.privateKey, dsaEncoding })
  return { id: base64urlEncode(credential), response: { clientDataJSON: json, authenticatorData: base64urlEncode(bytes), signature: base64urlEncode(signature) } }
}
const credentialRecord = {
  id: base64urlEncode(credentialId),
  publicKey: keyPair.coseKey,
  signCount: 0,
  userHandle,
  aaguid: base64urlEncode(Buffer.alloc(16)),
  transports: ['internal', 'hybrid'],
}
const expectedRegistration = { challenge, origin: ORIGIN, rpId: RP_ID, userVerification: 'required', attestationTypes: ['none'] }
const expectedAssertion = { challenge, origin: ORIGIN, rpId: RP_ID, userVerification: 'required' }

await check('base64url codec is strict and canonical', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(48))
  assert.deepEqual(Array.from(base64urlDecode(base64urlEncode(bytes))), Array.from(bytes))
  assert.equal(base64urlDecode('YQ==').toString(), 'a')
  assert.throws(() => base64urlDecode('ab$c'), (error) => error.code === 'BAD_BASE64URL')
  assert.throws(() => base64urlDecode('a'), (error) => error.code === 'BAD_BASE64URL')
  assert.throws(() => base64urlDecode(42), (error) => error.code === 'BAD_BASE64URL')
})

await check('CBOR decoder handles maps, arrays, byte strings and integers', () => {
  const value = new Map([
    ['fmt', 'none'],
    ['count', 65_536],
    ['negative', -7],
    ['bytes', Buffer.from([1, 2, 3])],
    ['list', [true, null, 'text']],
  ])
  const encoded = encodeCbor(value)
  const decoded = decodeCbor(encoded)
  assert.equal(decoded.offset, encoded.length)
  assert.deepEqual(decoded.value, value)
  assert.throws(() => decodeCbor(Buffer.from([0xa1, 0x01])), (error) => error.code === 'BAD_CBOR')
  assert.throws(() => decodeCbor(Buffer.from([0x1c])), (error) => error.code === 'BAD_CBOR')
  assert.deepEqual(decodeCbor(encodeCbor(new Map([[1, 2]]))).value.get(1), 2)
})

await check('COSE EC2 key parses and converts to a P-256 public key', () => {
  const cose = parseCoseKey(keyPair.coseKey)
  assert.equal(cose.kty, 2)
  assert.equal(cose.alg, -7)
  assert.equal(cose.crv, 1)
  assert.equal(base64urlDecode(cose.x).length, 32)
  assert.equal(base64urlDecode(cose.y).length, 32)
  const publicKey = coseToPublicKey(cose)
  assert.equal(publicKey.asymmetricKeyType, 'ec')
  assert.equal(publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1')
  const rsaLike = encodeCbor(new Map([[1, 3], [3, -257], [-1, Buffer.alloc(32)]]))
  assert.throws(() => parseCoseKey(rsaLike), (error) => error.code === 'UNSUPPORTED_KEY')
  assert.throws(() => parseCoseKey(Buffer.concat([keyPair.coseKey, Buffer.from([0])])), (error) => error.code === 'BAD_COSE')
})

await check('authenticatorData exposes flags, counter, credential and extensions', () => {
  const parsed = parseAuthenticatorData(authData({ flags: 0x45, signCount: 7 }))
  assert.equal(parsed.flags.up, true)
  assert.equal(parsed.flags.uv, true)
  assert.equal(parsed.flags.at, true)
  assert.equal(parsed.signCount, 7)
  assert.deepEqual(parsed.credential.id, Buffer.from(credentialId))
  assert.equal(parsed.credential.cose.alg, -7)
  assert.equal(parsed.aaguid.length, 16)
  const withExtensions = parseAuthenticatorData(authData({ flags: 0x85, withCredential: false, extensions: new Map([['credProtect', 1]]) }))
  assert.equal(withExtensions.flags.ed, true)
  assert.equal(withExtensions.extensions.get('credProtect'), 1)
  assert.throws(() => parseAuthenticatorData(Buffer.alloc(10)), (error) => error.code === 'BAD_AUTH_DATA')
})

await check('clientDataJSON validation binds type, challenge and origin', () => {
  const parsed = parseClientDataJSON(clientData('webauthn.get'))
  assert.equal(parsed.type, 'webauthn.get')
  assert.equal(validateClientData(parsed, { type: 'webauthn.get', challenge, origin: ORIGIN }), true)
  assert.throws(() => parseClientDataJSON(base64urlEncode(Buffer.from('not-json'))), (error) => error.code === 'BAD_CLIENT_DATA')
  assert.throws(() => validateClientData(parsed, { type: 'webauthn.create', challenge, origin: ORIGIN }), (error) => error.code === 'BAD_TYPE')
  assert.throws(() => validateClientData(parsed, { challenge, origin: 'https://evil.test' }), (error) => error.code === 'BAD_ORIGIN')
  assert.throws(() => validateClientData(parsed, { challenge: base64urlEncode(Buffer.from('other')), origin: ORIGIN }), (error) => error.code === 'BAD_CHALLENGE')
  assert.throws(() => validateClientData({ ...parsed, crossOrigin: true }, { challenge, origin: ORIGIN }), (error) => error.code === 'BAD_CROSS_ORIGIN')
  assert.throws(() => parseClientDataJSON(clientData('webauthn.get', { origin: 'http://example.test' }), { origin: 'http://example.test' }), (error) => error.code === 'BAD_ORIGIN')
})

await check('valid registration verifies and returns a storable credential', () => {
  const result = verifyRegistration(registrationFor(), expectedRegistration)
  assert.equal(result.verified, true)
  assert.equal(result.fmt, 'none')
  assert.equal(result.credentialId, base64urlEncode(credentialId))
  assert.equal(result.signCount, 0)
  assert.equal(result.userVerified, true)
  assert.equal(result.aaguid, base64urlEncode(Buffer.alloc(16)))
  assert.equal(parseCoseKey(result.credentialPublicKey).alg, -7)
  assert.equal(result.clientData.type, 'webauthn.create')
})

await check('registration rejects challenge, origin, rpId, type and flag violations', () => {
  assert.throws(() => verifyRegistration(registrationFor(), { ...expectedRegistration, challenge: base64urlEncode(Buffer.from('wrong')) }), (error) => error.code === 'BAD_CHALLENGE')
  assert.throws(() => verifyRegistration(registrationFor({ clientDataJSON: clientData('webauthn.create', { origin: 'https://evil.test' }) }), expectedRegistration), (error) => error.code === 'BAD_ORIGIN')
  assert.throws(() => verifyRegistration(registrationFor(), { ...expectedRegistration, rpId: 'other.test' }), (error) => error.code === 'BAD_RP_ID')
  assert.throws(() => verifyRegistration(registrationFor({ clientDataJSON: clientData('webauthn.get') }), expectedRegistration), (error) => error.code === 'BAD_TYPE')
  assert.throws(() => verifyRegistration(registrationFor({ flags: 0x44 }), expectedRegistration), (error) => error.code === 'USER_NOT_PRESENT')
  assert.throws(() => verifyRegistration(registrationFor({ flags: 0x41 }), expectedRegistration), (error) => error.code === 'USER_NOT_VERIFIED')
  assert.throws(() => verifyRegistration(registrationFor({ fmt: 'packed' }), expectedRegistration), (error) => error.code === 'UNSUPPORTED_ATTESTATION')
})

await check('valid assertion verifies the ECDSA signature over authData || clientDataHash', () => {
  const result = verifyAssertion(assertionFor({ signCount: 1 }), credentialRecord, expectedAssertion)
  assert.equal(result.verified, true)
  assert.equal(result.newSignCount, 1)
  assert.equal(result.previousSignCount, 0)
  assert.equal(result.credentialId, credentialRecord.id)
  assert.equal(result.userHandle, userHandle)
  assert.equal(result.flags.uv, true)
})

await check('raw P-1363 signatures and DER signatures both verify', () => {
  const raw = assertionFor({ signCount: 1, dsaEncoding: 'ieee-p1363' })
  assert.equal(base64urlDecode(raw.response.signature).length, 64)
  assert.equal(verifyAssertion(raw, credentialRecord, expectedAssertion).verified, true)
  const der = assertionFor({ signCount: 1, dsaEncoding: 'der' })
  assert.notEqual(base64urlDecode(der.response.signature).length, 64)
  assert.equal(verifyAssertion(der, credentialRecord, expectedAssertion).verified, true)
})

await check('bad signatures, wrong rpId and counter regressions are rejected', () => {
  const tampered = assertionFor({ signCount: 1 })
  tampered.response.authenticatorData = base64urlEncode(authData({ flags: 0x05, signCount: 1, withCredential: false }))
  tampered.response.signature = base64urlEncode(Buffer.alloc(70, 7))
  assert.throws(() => verifyAssertion(tampered, credentialRecord, expectedAssertion), (error) => error.code === 'BAD_SIGNATURE')
  assert.throws(() => verifyAssertion(assertionFor({ signCount: 1 }), credentialRecord, { ...expectedAssertion, rpId: 'other.test' }), (error) => error.code === 'BAD_RP_ID')
  assert.throws(
    () => verifyAssertion(assertionFor({ signCount: 1 }), { ...credentialRecord, signCount: 5 }, expectedAssertion),
    (error) => error.code === 'SIGN_COUNT_REGRESSION',
  )
  const zeroCounter = verifyAssertion(assertionFor({ signCount: 0 }), { ...credentialRecord, signCount: 0 }, expectedAssertion)
  assert.equal(zeroCounter.verified, true)
})

await check('credential store persists counters and serializes safely', () => {
  const store = new CredentialStore([credentialRecord])
  assert.equal(store.size, 1)
  assert.equal(store.has(credentialRecord.id), true)
  assert.equal(store.listForUser(userHandle).length, 1)
  const stored = store.get(credentialRecord.id)
  stored.signCount = 99
  assert.equal(store.get(credentialRecord.id).signCount, 0)
  assert.throws(() => store.updateCounter(credentialRecord.id, -1), (error) => error.code === 'BAD_COUNTER')
  const restored = CredentialStore.fromJSON(JSON.stringify(store.toJSON()))
  assert.ok(restored.get(credentialRecord.id).publicKey instanceof Uint8Array)
  assert.equal(restored.get(credentialRecord.id).transports.length, 2)
  assert.throws(() => CredentialStore.fromJSON('{"version":2}'), (error) => error.code === 'BAD_STORE')
})

await check('authenticate verifies, updates the counter and blocks replay', () => {
  const store = new CredentialStore([credentialRecord])
  const result = authenticate(store, assertionFor({ signCount: 1 }), expectedAssertion)
  assert.equal(result.verified, true)
  assert.equal(store.get(credentialRecord.id).signCount, 1)
  assert.throws(() => authenticate(store, assertionFor({ signCount: 1 }), expectedAssertion), (error) => error.code === 'SIGN_COUNT_REGRESSION')
  assert.throws(() => authenticate(store, assertionFor({ signCount: 2 }), { ...expectedAssertion, rpId: 'other.test' }), (error) => error.code === 'BAD_RP_ID')
  assert.equal(store.get(credentialRecord.id).signCount, 1)
  const unknown = assertionFor({ signCount: 2, credential: Buffer.alloc(16, 3) })
  assert.throws(() => authenticate(store, unknown, expectedAssertion), (error) => error.code === 'UNKNOWN_CREDENTIAL')
})

await check('malformed responses fail with coded errors', () => {
  assert.throws(() => verifyRegistration({}, expectedRegistration), (error) => error.code === 'BAD_RESPONSE')
  assert.throws(() => verifyAssertion({ response: {} }, credentialRecord, expectedAssertion), (error) => error.code === 'BAD_RESPONSE')
  const broken = registrationFor()
  broken.response.attestationObject = base64urlEncode(Buffer.from([0xff, 0x00]))
  assert.throws(() => verifyRegistration(broken, expectedRegistration), (error) => error instanceof WebAuthnError)
  assert.throws(() => verifyRegistration(registrationFor(), { ...expectedRegistration, rpId: '' }), (error) => error.code === 'BAD_RP_ID')
  const mismatched = assertionFor({ signCount: 1, credential: Buffer.alloc(16, 9) })
  assert.throws(() => verifyAssertion(mismatched, credentialRecord, expectedAssertion), (error) => error.code === 'CREDENTIAL_MISMATCH')
})

console.log(`checks: ${passed}/${total}`)
