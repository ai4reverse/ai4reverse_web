/**
 * License Verifier SDK — ES256 JWS licenses with expiry, audience and product
 * binding. Uses WebCrypto only; keys are JWK so they can be stored server-side
 * or shipped as public verification keys.
 */
export const VERSION = '1.0.0'
export class LicenseError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'LicenseError'
    this.code = code
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function base64urlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  }
}

async function importPrivate(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function importPublic(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

/**
 * @param {{privateJwk: object}} keys
 * @param {{subject: string, audience?: string, product?: string, scope?: string[], ttlSeconds?: number, now?: number, licenseId?: string}} claims
 */
export async function issueLicense(keys, claims) {
  const key = await importPrivate(keys.privateJwk)
  const now = claims.now ?? Date.now()
  const payload = {
    iss: claims.issuer ?? 'example-license-authority',
    sub: claims.subject,
    aud: claims.audience ?? 'example-app',
    product: claims.product ?? 'example-product',
    scope: claims.scope ?? [],
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + (claims.ttlSeconds ?? 86_400) * 1000) / 1000),
    jti: claims.licenseId ?? crypto.randomUUID(),
  }
  const header = { alg: 'ES256', typ: 'JWT' }
  const encodedHeader = base64urlEncode(encoder.encode(JSON.stringify(header)))
  const encodedPayload = base64urlEncode(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput))
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`
}

/**
 * @param {string} token
 * @param {object} publicJwk
 * @param {{now?: number, audience?: string, product?: string, clockSkewSeconds?: number}} [options]
 */
export async function verifyLicense(token, publicJwk, options = {}) {
  if (typeof token !== 'string') throw new LicenseError('MALFORMED', 'token must be a string')
  const parts = token.split('.')
  if (parts.length !== 3) throw new LicenseError('MALFORMED', 'expected three JWS segments')
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  let header, payload
  try {
    header = JSON.parse(decoder.decode(base64urlDecode(encodedHeader)))
    payload = JSON.parse(decoder.decode(base64urlDecode(encodedPayload)))
  } catch {
    throw new LicenseError('MALFORMED', 'header or payload is not JSON')
  }
  if (header.alg !== 'ES256') throw new LicenseError('BAD_ALGORITHM', 'only ES256 is accepted')
  let valid = false
  try {
    const key = await importPublic(publicJwk)
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64urlDecode(encodedSignature),
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    )
  } catch (error) {
    throw new LicenseError('BAD_KEY', 'public key is invalid')
  }
  if (!valid) throw new LicenseError('BAD_SIGNATURE', 'signature verification failed')
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  const skew = options.clockSkewSeconds ?? 0
  if (typeof payload.exp !== 'number' || now > payload.exp + skew) throw new LicenseError('EXPIRED', 'license expired')
  if (typeof payload.nbf === 'number' && now < payload.nbf - skew) throw new LicenseError('NOT_YET_VALID', 'license not yet valid')
  if (options.audience && payload.aud !== options.audience) throw new LicenseError('BAD_AUDIENCE', 'audience mismatch')
  if (options.product && payload.product !== options.product) throw new LicenseError('BAD_PRODUCT', 'product mismatch')
  return { valid: true, payload, header }
}

export function decodeLicense(token) {
  const parts = String(token).split('.')
  if (parts.length !== 3) throw new LicenseError('MALFORMED', 'expected three JWS segments')
  return {
    header: JSON.parse(decoder.decode(base64urlDecode(parts[0]))),
    payload: JSON.parse(decoder.decode(base64urlDecode(parts[1]))),
    signature: parts[2],
  }
}
