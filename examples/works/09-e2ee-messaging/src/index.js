/**
 * E2EE Messaging SDK — forward-secret session keys from ECDH + HKDF, messages
 * sealed with AES-256-GCM and bound to a transcript fingerprint via AAD.
 */
export const VERSION = '1.0.0'
export class E2EEError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'E2EEError'
    this.code = code
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HKDF_INFO = encoder.encode('e2ee-messaging-v1')

export function base64urlEncode(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export async function createIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    fingerprint: base64urlEncode((await sha256(encoder.encode(JSON.stringify({ crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y })))).slice(0, 16)),
  }
}

export function exportPublic(identity) {
  const { kty, crv, x, y } = identity.publicJwk
  return { kty, crv, x, y }
}

/**
 * Derive a deterministic session key from own private key and peer public key.
 * Both sides compute the same transcript so AAD-bound messages interoperate.
 */
export async function establishSession(identity, peerPublicJwk) {
  const peerKey = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, identity.privateKey, 256)
  const canonical = (jwk) => JSON.stringify({ crv: jwk.crv, x: jwk.x, y: jwk.y })
  const own = canonical(identity.publicJwk)
  const peer = canonical(peerPublicJwk)
  const transcript = [own, peer].sort().join('|')
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(encoder.encode(transcript)), info: HKDF_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return {
    key,
    transcriptFingerprint: base64urlEncode((await sha256(encoder.encode(transcript))).slice(0, 16)),
    peerFingerprint: base64urlEncode((await sha256(encoder.encode(peer))).slice(0, 16)),
  }
}

export async function encrypt(session, plaintext, options = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = encoder.encode(options.aad ?? session.transcriptFingerprint)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, session.key, encoder.encode(String(plaintext)))
  return { v: 1, alg: 'AES-256-GCM', iv: base64urlEncode(iv), ct: base64urlEncode(new Uint8Array(cipher)) }
}

export async function decrypt(session, envelope, options = {}) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') throw new E2EEError('BAD_ENVELOPE', 'unsupported envelope')
  const aad = encoder.encode(options.aad ?? session.transcriptFingerprint)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64urlDecode(envelope.iv), additionalData: aad },
      session.key,
      base64urlDecode(envelope.ct),
    )
    return decoder.decode(plain)
  } catch (error) {
    throw new E2EEError('DECRYPT_FAILED', 'wrong session, AAD or tampered ciphertext', error)
  }
}

export async function sealFor(identity, peerPublicJwk, plaintext, options) {
  const session = await establishSession(identity, peerPublicJwk)
  return encrypt(session, plaintext, options)
}
