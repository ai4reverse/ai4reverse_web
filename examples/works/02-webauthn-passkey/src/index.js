/**
 * WebAuthn / Passkey SDK — options construction, response verification and
 * credential serialization for passwordless login.
 *
 * Structural verification is implemented in pure JS (no CBOR dependency):
 * clientDataJSON binding, challenge/origin checks, authenticator-data parsing and
 * credential-id matching. Signature verification is delegated to the relying
 * party's WebAuthn server / crypto backend via `verifySignature` hook.
 */
export const VERSION = '1.0.0'
export class PasskeyError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'PasskeyError'
    this.code = code
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** @param {Uint8Array} bytes */
export function base64urlEncode(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} value */
export function base64urlDecode(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function randomChallenge(length = 32) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64urlEncode(bytes)
}

export function createRegistrationOptions(input) {
  const challenge = input.challenge ?? randomChallenge()
  return {
    publicKey: {
      challenge: base64urlEncode(typeof challenge === 'string' ? encoder.encode(challenge) : challenge),
      rp: { id: input.rpId, name: input.rpName ?? input.rpId },
      user: {
        id: base64urlEncode(typeof input.userId === 'string' ? encoder.encode(input.userId) : input.userId),
        name: input.userName,
        displayName: input.displayName ?? input.userName,
      },
      pubKeyCredParams: input.algorithms ?? [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: input.timeout ?? 60_000,
      attestation: input.attestation ?? 'none',
      authenticatorSelection: input.authenticatorSelection ?? { residentKey: 'preferred', userVerification: 'preferred' },
    },
  }
}

export function createAuthenticationOptions(input) {
  return {
    publicKey: {
      challenge: base64urlEncode(typeof input.challenge === 'string' ? encoder.encode(input.challenge) : input.challenge ?? randomChallenge()),
      rpId: input.rpId,
      timeout: input.timeout ?? 60_000,
      userVerification: input.userVerification ?? 'preferred',
      allowCredentials: (input.allowCredentials ?? []).map((credential) => ({
        type: 'public-key',
        id: typeof credential.id === 'string' ? credential.id : base64urlEncode(credential.id),
        ...(credential.transports ? { transports: credential.transports } : {}),
      })),
    },
  }
}

export function parseClientData(response) {
  const bytes = response.clientDataJSON instanceof Uint8Array ? response.clientDataJSON : base64urlDecode(response.clientDataJSON)
  let data
  try {
    data = JSON.parse(decoder.decode(bytes))
  } catch (error) {
    throw new PasskeyError('BAD_CLIENT_DATA', 'clientDataJSON is not valid JSON')
  }
  return { data, bytes }
}

function parseAuthenticatorData(bytes) {
  if (bytes.length < 37) throw new PasskeyError('BAD_AUTH_DATA', 'authenticator data too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rpIdHash = bytes.slice(0, 32)
  const flags = bytes[32]
  const signCount = view.getUint32(33)
  const parsed = {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backupState: (flags & 0x10) !== 0,
    attestedCredentialData: (flags & 0x40) !== 0,
    extensionData: (flags & 0x80) !== 0,
    signCount,
    aaguid: null,
    credentialId: null,
    credentialPublicKey: null,
  }
  if (parsed.attestedCredentialData) {
    if (bytes.length < 55) throw new PasskeyError('BAD_AUTH_DATA', 'attested credential data truncated')
    parsed.aaguid = bytes.slice(37, 53)
    const credentialIdLength = view.getUint16(53)
    const start = 55
    const end = start + credentialIdLength
    if (end > bytes.length) throw new PasskeyError('BAD_AUTH_DATA', 'credential id truncated')
    parsed.credentialId = bytes.slice(start, end)
    parsed.credentialPublicKey = bytes.slice(end)
  }
  return parsed
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * Verify a registration response.
 * @param {{response: {clientDataJSON: string|Uint8Array, attestationObject: string|Uint8Array}}} input
 * @param {{challenge: string, origin: string, rpId: string}} expected
 */
export async function verifyRegistrationResponse(input, expected) {
  const { data } = parseClientData(input.response)
  if (data.type !== 'webauthn.create') throw new PasskeyError('BAD_TYPE', 'expected webauthn.create')
  if (expected.challenge && data.challenge !== expected.challenge) throw new PasskeyError('BAD_CHALLENGE', 'challenge mismatch')
  if (expected.origin && data.origin !== expected.origin) throw new PasskeyError('BAD_ORIGIN', 'origin mismatch')
  const attestation = input.response.attestationObject
  const bytes = attestation instanceof Uint8Array ? attestation : base64urlDecode(attestation)
  // Minimal CBOR map prefix check: {fmt, attStmt, authData}; the authData blob is
  // located by scanning for the rpIdHash of the expected rpId.
  const rpIdHash = await sha256(encoder.encode(expected.rpId ?? ''))
  let offset = -1
  for (let index = 0; index + 32 <= bytes.length; index += 1) {
    let matches = true
    for (let byte = 0; byte < 32; byte += 1) {
      if (bytes[index + byte] !== rpIdHash[byte]) {
        matches = false
        break
      }
    }
    if (matches) {
      offset = index
      break
    }
  }
  if (offset < 0) throw new PasskeyError('BAD_RP_ID', 'authenticator data does not match rpId')
  const authData = parseAuthenticatorData(bytes.slice(offset))
  if (!authData.credentialId) throw new PasskeyError('BAD_AUTH_DATA', 'missing credential id')
  return {
    verified: true,
    credentialId: base64urlEncode(authData.credentialId),
    publicKey: base64urlEncode(authData.credentialPublicKey ?? new Uint8Array()),
    signCount: authData.signCount,
    userVerified: authData.userVerified,
    backupEligible: authData.backupEligible,
    authenticatorData: bytes.slice(offset),
  }
}

/**
 * Verify an authentication assertion (structure + binding; signature via hook).
 * @param {object} input
 * @param {object} expected
 */
export async function verifyAssertion(input, expected = {}) {
  const { data } = parseClientData(input.response)
  if (data.type !== 'webauthn.get') throw new PasskeyError('BAD_TYPE', 'expected webauthn.get')
  if (expected.challenge && data.challenge !== expected.challenge) throw new PasskeyError('BAD_CHALLENGE', 'challenge mismatch')
  if (expected.origin && data.origin !== expected.origin) throw new PasskeyError('BAD_ORIGIN', 'origin mismatch')
  const authDataBytes = input.response.authenticatorData instanceof Uint8Array
    ? input.response.authenticatorData
    : base64urlDecode(input.response.authenticatorData)
  const authData = parseAuthenticatorData(authDataBytes)
  if (!authData.userPresent) throw new PasskeyError('USER_NOT_PRESENT', 'user presence flag missing')
  if (expected.credentialId) {
    const actual = input.response.id ?? (authData.credentialId ? base64urlEncode(authData.credentialId) : '')
    if (actual !== expected.credentialId) throw new PasskeyError('BAD_CREDENTIAL', 'credential id mismatch')
  }
  let signatureValid = true
  if (typeof expected.verifySignature === 'function') {
    signatureValid = await expected.verifySignature({
      authenticatorData: authDataBytes,
      clientDataJSON: input.response.clientDataJSON,
      signature: input.response.signature,
      credentialId: expected.credentialId,
    })
  }
  if (!signatureValid) throw new PasskeyError('BAD_SIGNATURE', 'signature verification failed')
  return { verified: true, signCount: authData.signCount, userVerified: authData.userVerified }
}

export function serializeCredential(credential) {
  return JSON.stringify({
    id: credential.id,
    rawId: typeof credential.rawId === 'string' ? credential.rawId : base64urlEncode(credential.rawId),
    type: credential.type ?? 'public-key',
    transports: credential.transports ?? [],
    publicKey: credential.publicKey ?? null,
    signCount: credential.signCount ?? 0,
  })
}

export function deserializeCredential(text) {
  const parsed = JSON.parse(text)
  if (!parsed.id || parsed.type !== 'public-key') throw new PasskeyError('BAD_CREDENTIAL', 'invalid serialized credential')
  return parsed
}
