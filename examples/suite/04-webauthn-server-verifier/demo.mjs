import { sign } from 'node:crypto'
import {
  CredentialStore,
  authenticate,
  base64urlDecode,
  base64urlEncode,
  encodeCbor,
  generateEcKeyPair,
  parseCoseKey,
  sha256,
  verifyRegistration,
} from './src/index.js'

const RP_ID = 'demo.example.test'
const ORIGIN = 'https://demo.example.test'
const challenge = base64urlEncode(Buffer.from('demo-challenge-0123456789abcdef'))
const keyPair = generateEcKeyPair()
const u32 = (value) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}
const registrationData = Buffer.concat([
  sha256(RP_ID),
  Buffer.from([0x45]),
  u32(0),
  Buffer.alloc(16),
  Buffer.from([0, keyPair.credentialId.length]),
  Buffer.from(keyPair.credentialId),
  Buffer.from(keyPair.coseKey),
])
const attestationObject = encodeCbor({ fmt: 'none', attStmt: {}, authData: registrationData })
const registration = {
  id: base64urlEncode(keyPair.credentialId),
  response: {
    clientDataJSON: base64urlEncode(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN }))),
    attestationObject: base64urlEncode(attestationObject),
  },
}
const registered = verifyRegistration(registration, { challenge, origin: ORIGIN, rpId: RP_ID, userVerification: 'required', attestationTypes: ['none'] })
console.log('registered credential:', registered.credentialId.slice(0, 16) + '…', 'alg:', parseCoseKey(registered.credentialPublicKey).algorithm)

const store = new CredentialStore([{ id: registered.credentialId, publicKey: registered.credentialPublicKey, signCount: registered.signCount, userHandle: base64urlEncode(Buffer.from('demo-user')) }])
const authDataBytes = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), u32(1)])
const clientDataJSON = base64urlEncode(Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN })))
const signed = Buffer.concat([authDataBytes, sha256(base64urlDecode(clientDataJSON))])
const signature = sign('sha256', signed, { key: keyPair.privateKey, dsaEncoding: 'der' })
const assertion = {
  id: registered.credentialId,
  response: { clientDataJSON, authenticatorData: base64urlEncode(authDataBytes), signature: base64urlEncode(signature), userHandle: base64urlEncode(Buffer.from('demo-user')) },
}
const result = authenticate(store, assertion, { challenge, origin: ORIGIN, rpId: RP_ID, userVerification: 'required' })
console.log('assertion verified:', result.verified, 'counter:', result.previousSignCount, '->', result.newSignCount)
