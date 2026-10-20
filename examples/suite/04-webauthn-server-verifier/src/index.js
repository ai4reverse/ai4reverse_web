/**
 * WebAuthn Server Verifier SDK — registration and assertion verification for
 * Node.js relying parties, with no external dependencies.
 *
 * Includes the low-level pieces a production RP actually needs:
 *   - strict base64url codec
 *   - a minimal CBOR decoder (maps as `Map`, byte/text strings, arrays, tags,
 *     floats, indefinite lengths) plus a small encoder for COSE keys
 *   - COSE EC2/P-256 key parsing and JWK conversion
 *   - authenticatorData parsing (flags, signCount, attested credential data)
 *   - clientDataJSON validation (type, challenge, origin, token binding)
 *   - ECDSA assertion signature verification over authData || SHA-256(clientData)
 *   - a credential store with signCount regression detection
 *
 * Maps decoded from CBOR are returned as `Map` instances so integer COSE labels
 * (`-2`, `-3`, ...) are never coerced to strings. Use `mapToObject()` if a plain
 * object is convenient for string-keyed maps such as attestationObject.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify as cryptoVerify } from 'node:crypto'

export const VERSION = '1.0.0'
export const COSE_ALG_ES256 = -7
export const COSE_KTY_EC2 = 2
export const COSE_CRV_P256 = 1
export const FLAG_UP = 0x01
export const FLAG_UV = 0x04
export const FLAG_BE = 0x08
export const FLAG_BS = 0x10
export const FLAG_AT = 0x40
export const FLAG_ED = 0x80

export class WebAuthnError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'WebAuthnError'
    this.code = code
  }
}

/**
 * @param {string | Uint8Array} value
 * @returns {Buffer}
 */
function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new WebAuthnError('BAD_INPUT', 'expected a string or byte array')
}

/**
 * @param {string | Uint8Array} value
 * @returns {Buffer}
 */
export function sha256(value) {
  return createHash('sha256').update(toBytes(value)).digest()
}

/**
 * Encoded bytes without padding, safe for URLs and JSON.
 * @param {string | Uint8Array} bytes
 * @returns {string}
 */
export function base64urlEncode(bytes) {
  return toBytes(bytes).toString('base64url')
}

/**
 * Strict unpadded base64url decoder. Padding is tolerated on input, but the
 * alphabet and the canonical round-trip are enforced so two encodings of the
 * same challenge cannot both pass validation.
 * @param {string} text
 * @returns {Buffer}
 */
export function base64urlDecode(text) {
  if (typeof text !== 'string') throw new WebAuthnError('BAD_BASE64URL', 'expected a base64url string')
  const stripped = text.replace(/=+$/u, '')
  if (!/^[A-Za-z0-9_-]*$/u.test(stripped)) throw new WebAuthnError('BAD_BASE64URL', 'invalid base64url alphabet')
  if (stripped.length % 4 === 1) throw new WebAuthnError('BAD_BASE64URL', 'invalid base64url length')
  const bytes = Buffer.from(stripped, 'base64url')
  if (bytes.toString('base64url') !== stripped) throw new WebAuthnError('BAD_BASE64URL', 'non-canonical base64url encoding')
  return bytes
}

/**
 * @param {Map<unknown, unknown>} map
 * @returns {Record<string, unknown>}
 */
export function mapToObject(map) {
  if (!(map instanceof Map)) throw new WebAuthnError('BAD_CBOR', 'expected a CBOR map')
  const output = {}
  for (const [key, value] of map) {
    if (typeof key !== 'string') throw new WebAuthnError('BAD_CBOR', 'map key is not a string')
    output[key] = value
  }
  return output
}

/** @param {number} bits */
function decodeFloat16(bits) {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

/**
 * Minimal CBOR decoder (RFC 8949 subset sufficient for WebAuthn).
 * @param {string | Uint8Array} input
 * @param {number} [start]
 * @returns {{value: unknown, offset: number}}
 */
export function decodeCbor(input, start = 0) {
  const bytes = toBytes(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = start
  if (!Number.isInteger(start) || start < 0 || start > bytes.length) throw new WebAuthnError('BAD_CBOR', 'invalid start offset')

  const need = (size) => {
    if (offset + size > bytes.length) throw new WebAuthnError('BAD_CBOR', 'truncated CBOR input')
  }
  const readLength = (info) => {
    if (info < 24) return info
    if (info === 24) {
      need(1)
      return bytes[offset++]
    }
    if (info === 25) {
      need(2)
      const value = view.getUint16(offset)
      offset += 2
      return value
    }
    if (info === 26) {
      need(4)
      const value = view.getUint32(offset)
      offset += 4
      return value
    }
    if (info === 27) {
      need(8)
      const value = Number(view.getBigUint64(offset))
      offset += 8
      if (!Number.isSafeInteger(value)) throw new WebAuthnError('BAD_CBOR', 'length exceeds safe integer range')
      return value
    }
    if (info === 31) return -1
    throw new WebAuthnError('BAD_CBOR', `reserved additional information ${info}`)
  }
  const readIndefinite = (kind) => {
    const chunks = []
    for (;;) {
      need(1)
      if (bytes[offset] === 0xff) {
        offset += 1
        break
      }
      const { value } = decodeItem()
      if (kind === 'bytes' ? !(value instanceof Uint8Array) : typeof value !== 'string') {
        throw new WebAuthnError('BAD_CBOR', 'indefinite string chunks have the wrong type')
      }
      chunks.push(value)
    }
    return kind === 'bytes' ? Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) : chunks.join('')
  }
  const readUtf8 = (length) => {
    need(length)
    const slice = bytes.subarray(offset, offset + length)
    offset += length
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice)
    } catch {
      throw new WebAuthnError('BAD_CBOR', 'invalid UTF-8 string')
    }
  }

  const decodeItem = () => {
    need(1)
    const initial = bytes[offset++]
    const major = initial >> 5
    const info = initial & 31
    if (major === 7) {
      if (info === 20) return { value: false }
      if (info === 21) return { value: true }
      if (info === 22) return { value: null }
      if (info === 23) return { value: undefined }
      if (info === 25) {
        need(2)
        const value = decodeFloat16(view.getUint16(offset))
        offset += 2
        return { value }
      }
      if (info === 26) {
        need(4)
        const value = view.getFloat32(offset)
        offset += 4
        return { value }
      }
      if (info === 27) {
        need(8)
        const value = view.getFloat64(offset)
        offset += 8
        return { value }
      }
      throw new WebAuthnError('BAD_CBOR', `unsupported simple value ${info}`)
    }
    const length = readLength(info)
    if (major === 0) return { value: length }
    if (major === 1) return { value: -1 - length }
    if (major === 2) return { value: length < 0 ? readIndefinite('bytes') : (need(length), (offset += length, Buffer.from(bytes.subarray(offset - length, offset)))) }
    if (major === 3) return { value: length < 0 ? readIndefinite('text') : readUtf8(length) }
    if (major === 4) {
      const array = []
      if (length < 0) {
        for (;;) {
          need(1)
          if (bytes[offset] === 0xff) {
            offset += 1
            break
          }
          array.push(decodeItem().value)
        }
      } else {
        for (let index = 0; index < length; index += 1) array.push(decodeItem().value)
      }
      return { value: array }
    }
    if (major === 5) {
      const map = new Map()
      if (length < 0) {
        for (;;) {
          need(1)
          if (bytes[offset] === 0xff) {
            offset += 1
            break
          }
          const key = decodeItem().value
          map.set(key, decodeItem().value)
        }
      } else {
        for (let index = 0; index < length; index += 1) {
          const key = decodeItem().value
          map.set(key, decodeItem().value)
        }
      }
      return { value: map }
    }
    if (major === 6) return decodeItem()
    throw new WebAuthnError('BAD_CBOR', `unsupported major type ${major}`)
  }

  const { value } = decodeItem()
  return { value, offset }
}

/**
 * Minimal CBOR encoder for integer, string, byte-string, array, map, boolean and
 * null values. Used to build COSE keys and test fixtures; floats are rejected.
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function encodeCbor(value) {
  const chunks = []
  const header = (major, length) => {
    if (!Number.isInteger(length) || length < 0) throw new WebAuthnError('BAD_CBOR', 'length must be a non-negative integer')
    if (length < 24) chunks.push(Buffer.from([(major << 5) | length]))
    else if (length < 0x100) chunks.push(Buffer.from([(major << 5) | 24, length]))
    else if (length < 0x10000) {
      const buffer = Buffer.alloc(3)
      buffer[0] = (major << 5) | 25
      buffer.writeUInt16BE(length, 1)
      chunks.push(buffer)
    } else {
      const buffer = Buffer.alloc(5)
      buffer[0] = (major << 5) | 26
      buffer.writeUInt32BE(length, 1)
      chunks.push(buffer)
    }
  }
  const encodeValue = (item) => {
    if (item === null) return chunks.push(Buffer.from([0xf6]))
    if (item === undefined) return chunks.push(Buffer.from([0xf7]))
    if (item === false) return chunks.push(Buffer.from([0xf4]))
    if (item === true) return chunks.push(Buffer.from([0xf5]))
    if (typeof item === 'number') {
      if (!Number.isInteger(item)) throw new WebAuthnError('BAD_CBOR', 'only integers can be encoded')
      if (item >= 0) {
        header(0, item)
      } else {
        header(1, -1 - item)
      }
      return
    }
    if (typeof item === 'string') {
      const bytes = Buffer.from(item, 'utf8')
      header(3, bytes.length)
      chunks.push(bytes)
      return
    }
    if (item instanceof Uint8Array) {
      header(2, item.byteLength)
      chunks.push(Buffer.from(item.buffer, item.byteOffset, item.byteLength))
      return
    }
    if (Array.isArray(item)) {
      header(4, item.length)
      for (const entry of item) encodeValue(entry)
      return
    }
    if (item instanceof Map) {
      header(5, item.size)
      for (const [key, entry] of item) {
        encodeValue(key)
        encodeValue(entry)
      }
      return
    }
    if (typeof item === 'object') {
      const entries = Object.entries(item)
      header(5, entries.length)
      for (const [key, entry] of entries) {
        encodeValue(key)
        encodeValue(entry)
      }
      return
    }
    throw new WebAuthnError('BAD_CBOR', `cannot encode ${typeof item}`)
  }
  encodeValue(value)
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Parse a COSE EC2/P-256 key (the only algorithm this verifier accepts).
 * @param {string | Uint8Array} input
 */
export function parseCoseKey(input) {
  const bytes = toBytes(input)
  const { value, offset } = decodeCbor(bytes)
  if (offset !== bytes.length) throw new WebAuthnError('BAD_COSE', 'trailing bytes after COSE key')
  if (!(value instanceof Map)) throw new WebAuthnError('BAD_COSE', 'COSE key must be a map')
  const kty = value.get(1)
  const alg = value.get(3)
  const crv = value.get(-1)
  const x = value.get(-2)
  const y = value.get(-3)
  if (kty !== COSE_KTY_EC2) throw new WebAuthnError('UNSUPPORTED_KEY', `unsupported COSE kty ${kty}`)
  if (crv !== COSE_CRV_P256) throw new WebAuthnError('UNSUPPORTED_KEY', `unsupported COSE curve ${crv}`)
  if (alg !== COSE_ALG_ES256) throw new WebAuthnError('UNSUPPORTED_ALG', `unsupported COSE alg ${alg}`)
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
    throw new WebAuthnError('BAD_COSE', 'P-256 coordinates must be 32-byte strings')
  }
  return { kty: COSE_KTY_EC2, alg: COSE_ALG_ES256, crv: COSE_CRV_P256, x: base64urlEncode(x), y: base64urlEncode(y), curve: 'P-256', algorithm: 'ES256' }
}

/**
 * @param {import('node:crypto').KeyObject | string} publicKey
 * @returns {Uint8Array}
 */
export function encodeCoseEc2Key(publicKey) {
  const keyObject = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey
  const jwk = keyObject.export({ format: 'jwk' })
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new WebAuthnError('UNSUPPORTED_KEY', 'expected a P-256 EC public key')
  return encodeCbor(
    new Map([
      [1, COSE_KTY_EC2],
      [3, COSE_ALG_ES256],
      [-1, COSE_CRV_P256],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  )
}

/**
 * Generate a P-256 credential key pair plus a ready-to-store COSE key.
 * @returns {{privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, coseKey: Uint8Array, credentialId: Uint8Array}}
 */
export function generateEcKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, publicKey, coseKey: encodeCoseEc2Key(publicKey), credentialId: randomBytes(16) }
}

/**
 * @param {string | Uint8Array | {x: string, y: string}} cose
 */
export function coseToPublicKey(cose) {
  const parsed = typeof cose === 'object' && !(cose instanceof Uint8Array) && cose.x && cose.y ? cose : parseCoseKey(cose)
  try {
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: parsed.x, y: parsed.y }, format: 'jwk' })
  } catch {
    throw new WebAuthnError('BAD_COSE', 'COSE coordinates are not a valid P-256 point')
  }
}

/**
 * @typedef {{up: boolean, uv: boolean, be: boolean, bs: boolean, at: boolean, ed: boolean}} AuthFlags
 */

/**
 * Parse authenticator data, including attested credential data when AT is set.
 * @param {string | Uint8Array} input
 */
export function parseAuthenticatorData(input) {
  const bytes = toBytes(input)
  if (bytes.length < 37) throw new WebAuthnError('BAD_AUTH_DATA', 'authenticatorData must be at least 37 bytes')
  const rpIdHash = Buffer.from(bytes.subarray(0, 32))
  const rawFlags = bytes[32]
  /** @type {AuthFlags} */
  const flags = {
    up: Boolean(rawFlags & FLAG_UP),
    uv: Boolean(rawFlags & FLAG_UV),
    be: Boolean(rawFlags & FLAG_BE),
    bs: Boolean(rawFlags & FLAG_BS),
    at: Boolean(rawFlags & FLAG_AT),
    ed: Boolean(rawFlags & FLAG_ED),
  }
  const signCount = bytes.readUInt32BE(33)
  /** @type {null | {id: Buffer, publicKeyBytes: Buffer, cose: ReturnType<typeof parseCoseKey>, aaguid: Buffer}} */
  let credential = null
  let offset = 37
  let aaguid = null
  if (flags.at) {
    if (bytes.length < offset + 18) throw new WebAuthnError('BAD_AUTH_DATA', 'truncated attested credential data')
    aaguid = Buffer.from(bytes.subarray(offset, offset + 16))
    offset += 16
    const credentialIdLength = bytes.readUInt16BE(offset)
    offset += 2
    if (credentialIdLength === 0 || bytes.length < offset + credentialIdLength) {
      throw new WebAuthnError('BAD_AUTH_DATA', 'invalid credential id length')
    }
    const id = Buffer.from(bytes.subarray(offset, offset + credentialIdLength))
    offset += credentialIdLength
    const decoded = decodeCbor(bytes.subarray(offset))
    const publicKeyBytes = Buffer.from(bytes.subarray(offset, offset + decoded.offset))
    const cose = parseCoseKey(publicKeyBytes)
    offset += decoded.offset
    credential = { id, publicKeyBytes, cose, aaguid }
  }
  let extensions = null
  if (flags.ed) {
    if (offset >= bytes.length) throw new WebAuthnError('BAD_AUTH_DATA', 'extensions flag set without extension data')
    const decoded = decodeCbor(bytes, offset)
    extensions = decoded.value
    offset = decoded.offset
  }
  if (offset !== bytes.length) throw new WebAuthnError('BAD_AUTH_DATA', 'trailing bytes after authenticatorData')
  return { raw: bytes, rpIdHash, flags, signCount, credential, aaguid, extensions }
}

/**
 * @param {string | Uint8Array} input base64url string or raw bytes
 * @param {{type?: string, challenge?: string, origin?: string, origins?: string[], allowCrossOrigin?: boolean, tokenBindingId?: string}} [expected]
 */
export function parseClientDataJSON(input, expected = {}) {
  let bytes
  if (typeof input === 'string') bytes = base64urlDecode(input)
  else if (input instanceof Uint8Array) bytes = Buffer.from(input)
  else throw new WebAuthnError('BAD_CLIENT_DATA', 'clientDataJSON must be bytes or base64url')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WebAuthnError('BAD_CLIENT_DATA', 'clientDataJSON is not valid UTF-8')
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new WebAuthnError('BAD_CLIENT_DATA', 'clientDataJSON is not valid JSON')
  }
  if (!data || typeof data !== 'object' || typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') {
    throw new WebAuthnError('BAD_CLIENT_DATA', 'clientDataJSON is missing type, challenge or origin')
  }
  const parsed = {
    data,
    bytes,
    type: data.type,
    challenge: data.challenge,
    origin: data.origin,
    crossOrigin: data.crossOrigin === true,
    tokenBinding: data.tokenBinding ?? null,
  }
  if (expected.type || expected.challenge || expected.origin || expected.origins) validateClientData(parsed, expected)
  return parsed
}

/** @param {string} origin */
function normalizeOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    throw new WebAuthnError('BAD_ORIGIN', `invalid origin ${origin}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new WebAuthnError('BAD_ORIGIN', 'origin must use https outside localhost')
  }
  return url.origin
}

/**
 * Validate the clientData binding. Throws a coded `WebAuthnError` on mismatch.
 * @param {ReturnType<typeof parseClientDataJSON>} parsed
 * @param {{type?: string, challenge?: string, origin?: string, origins?: string[], allowCrossOrigin?: boolean, tokenBindingId?: string}} expected
 */
export function validateClientData(parsed, expected) {
  if (!parsed || typeof parsed !== 'object') throw new WebAuthnError('BAD_CLIENT_DATA', 'parsed client data is required')
  if (expected.type && parsed.type !== expected.type) throw new WebAuthnError('BAD_TYPE', `clientData type must be ${expected.type}`)
  if (parsed.crossOrigin && expected.allowCrossOrigin !== true) throw new WebAuthnError('BAD_CROSS_ORIGIN', 'cross-origin WebAuthn is not allowed')
  const allowedOrigins = (expected.origins ?? (expected.origin ? [expected.origin] : [])).map(normalizeOrigin)
  if (allowedOrigins.length === 0) throw new WebAuthnError('BAD_ORIGIN', 'an expected origin is required')
  if (!allowedOrigins.includes(normalizeOrigin(parsed.origin))) throw new WebAuthnError('BAD_ORIGIN', `origin ${parsed.origin} is not allowed`)
  if (expected.challenge !== undefined) {
    let actual
    let wanted
    try {
      actual = base64urlDecode(parsed.challenge)
      wanted = base64urlDecode(String(expected.challenge))
    } catch {
      throw new WebAuthnError('BAD_CHALLENGE', 'challenge must be base64url encoded')
    }
    if (!actual.equals(wanted)) throw new WebAuthnError('BAD_CHALLENGE', 'challenge does not match the expected challenge')
  }
  const tokenBinding = parsed.tokenBinding
  if (tokenBinding && tokenBinding.status === 'present' && tokenBinding.id !== expected.tokenBindingId) {
    throw new WebAuthnError('BAD_TOKEN_BINDING', 'token binding id does not match')
  }
  return true
}

/**
 * @param {Buffer} left
 * @param {Buffer} right
 */
function buffersEqual(left, right) {
  return left.length === right.length && left.equals(right)
}

/**
 * Verify a registration (attestation) response.
 * @param {{response: {clientDataJSON: string, attestationObject: string}, id?: string}} registration
 * @param {{challenge: string, origin?: string, origins?: string[], rpId: string, userVerification?: 'required' | 'preferred' | 'discouraged', attestationTypes?: string[], allowCrossOrigin?: boolean}} expected
 */
export function verifyRegistration(registration, expected) {
  const response = registration?.response
  if (!response || typeof response.clientDataJSON !== 'string' || typeof response.attestationObject !== 'string') {
    throw new WebAuthnError('BAD_RESPONSE', 'registration.response needs clientDataJSON and attestationObject')
  }
  if (!expected || typeof expected.rpId !== 'string' || expected.rpId.length === 0) throw new WebAuthnError('BAD_RP_ID', 'expected.rpId is required')
  const clientData = parseClientDataJSON(response.clientDataJSON, { ...expected, type: 'webauthn.create' })
  const attestationBytes = base64urlDecode(response.attestationObject)
  let attestation
  try {
    const decoded = decodeCbor(attestationBytes)
    if (decoded.offset !== attestationBytes.length) throw new WebAuthnError('BAD_CBOR', 'trailing bytes after attestation object')
    attestation = decoded.value
  } catch (error) {
    if (error instanceof WebAuthnError) throw error
    throw new WebAuthnError('BAD_ATTESTATION', 'attestationObject is not valid CBOR')
  }
  if (!(attestation instanceof Map)) throw new WebAuthnError('BAD_ATTESTATION', 'attestationObject must be a CBOR map')
  const fmt = attestation.get('fmt')
  const authDataBytes = attestation.get('authData')
  const attestationStatement = attestation.get('attStmt')
  if (typeof fmt !== 'string' || !(authDataBytes instanceof Uint8Array)) {
    throw new WebAuthnError('BAD_ATTESTATION', 'attestationObject needs fmt and authData')
  }
  if (expected.attestationTypes && !expected.attestationTypes.includes(fmt)) {
    throw new WebAuthnError('UNSUPPORTED_ATTESTATION', `attestation format ${fmt} is not allowed`)
  }
  const authData = parseAuthenticatorData(authDataBytes)
  if (!buffersEqual(authData.rpIdHash, sha256(expected.rpId))) throw new WebAuthnError('BAD_RP_ID', 'rpIdHash does not match the expected rpId')
  if (!authData.flags.up) throw new WebAuthnError('USER_NOT_PRESENT', 'user presence flag is not set')
  if (expected.userVerification === 'required' && !authData.flags.uv) throw new WebAuthnError('USER_NOT_VERIFIED', 'user verification is required')
  if (!authData.flags.at || !authData.credential) throw new WebAuthnError('BAD_AUTH_DATA', 'attested credential data is missing')
  if (registration.id !== undefined && registration.id !== base64urlEncode(authData.credential.id)) {
    throw new WebAuthnError('CREDENTIAL_MISMATCH', 'registration id does not match attested credential id')
  }
  return {
    verified: true,
    fmt,
    attestationStatement,
    aaguid: base64urlEncode(authData.credential.aaguid),
    credentialId: base64urlEncode(authData.credential.id),
    credentialPublicKey: authData.credential.publicKeyBytes,
    cose: authData.credential.cose,
    signCount: authData.signCount,
    flags: authData.flags,
    userVerified: authData.flags.uv,
    backupEligible: authData.flags.be,
    backupState: authData.flags.bs,
    clientData: clientData.data,
  }
}

/**
 * @typedef {{id: string, publicKey: string | Uint8Array | {x: string, y: string}, signCount?: number, userHandle?: string | null, aaguid?: string | null, transports?: string[], createdAt?: number | null, lastUsedAt?: number | null, backupEligible?: boolean, backupState?: boolean}} CredentialRecord
 */

/**
 * @param {CredentialRecord} record
 */
function normalizeCredential(record) {
  if (!record || typeof record.id !== 'string' || record.id.length === 0) throw new WebAuthnError('BAD_CREDENTIAL', 'credential.id is required')
  const publicKey = typeof record.publicKey === 'string' ? base64urlDecode(record.publicKey) : record.publicKey
  if (!publicKey || (typeof publicKey !== 'object')) throw new WebAuthnError('BAD_CREDENTIAL', 'credential.publicKey is required')
  if (record.signCount !== undefined && (!Number.isInteger(record.signCount) || record.signCount < 0)) {
    throw new WebAuthnError('BAD_COUNTER', 'signCount must be a non-negative integer')
  }
  return {
    id: record.id,
    publicKey,
    signCount: record.signCount ?? 0,
    userHandle: typeof record.userHandle === 'string' ? record.userHandle : null,
    aaguid: typeof record.aaguid === 'string' ? record.aaguid : null,
    transports: Array.isArray(record.transports) ? record.transports.filter((entry) => typeof entry === 'string') : [],
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
    lastUsedAt: Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : null,
    backupEligible: record.backupEligible === true,
    backupState: record.backupState === true,
  }
}

/**
 * In-memory credential store with monotonic signCount enforcement.
 * Replace the backing map with a database in production; the API is deliberately
 * narrow so the persistence layer can be swapped without touching verification.
 */
export class CredentialStore {
  /** @type {Map<string, ReturnType<typeof normalizeCredential>>} */
  #records = new Map()

  /** @param {CredentialRecord[]} [records] */
  constructor(records = []) {
    for (const record of records) this.put(record)
  }

  /** @param {CredentialRecord} record */
  put(record) {
    const normalized = normalizeCredential(record)
    this.#records.set(normalized.id, normalized)
    return this.get(normalized.id)
  }

  /**
   * @param {string} id
   * @returns {ReturnType<typeof normalizeCredential> | null}
   */
  get(id) {
    const record = this.#records.get(id)
    if (!record) return null
    return structuredClone(record)
  }

  /** @param {string} id */
  has(id) {
    return this.#records.has(id)
  }

  /** @param {string} id */
  delete(id) {
    return this.#records.delete(id)
  }

  get size() {
    return this.#records.size
  }

  /** @param {string} userHandle */
  listForUser(userHandle) {
    return [...this.#records.values()]
      .filter((record) => record.userHandle === userHandle)
      .map((record) => structuredClone(record))
      .sort((left, right) => (left.id < right.id ? -1 : 1))
  }

  /**
   * Persist a new counter after a verified assertion.
   * @param {string} id
   * @param {number} signCount
   */
  updateCounter(id, signCount) {
    const record = this.#records.get(id)
    if (!record) throw new WebAuthnError('UNKNOWN_CREDENTIAL', `unknown credential ${id}`)
    if (!Number.isInteger(signCount) || signCount < 0) throw new WebAuthnError('BAD_COUNTER', 'signCount must be a non-negative integer')
    if (signCount < record.signCount) throw new WebAuthnError('SIGN_COUNT_REGRESSION', 'signCount must be monotonic')
    record.signCount = signCount
    record.lastUsedAt = Date.now()
    return this.get(id)
  }

  toJSON() {
    return {
      version: 1,
      credentials: [...this.#records.values()].map((record) => ({
        ...record,
        publicKey: record.publicKey instanceof Uint8Array ? base64urlEncode(record.publicKey) : record.publicKey,
      })),
    }
  }

  /** @param {string} json */
  static fromJSON(json) {
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new WebAuthnError('BAD_STORE', 'credential store is not valid JSON')
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.credentials)) throw new WebAuthnError('BAD_STORE', 'unsupported credential store document')
    return new CredentialStore(parsed.credentials)
  }
}

/**
 * Verify an authentication assertion against a stored credential.
 * @param {{response: {clientDataJSON: string, authenticatorData: string, signature: string, userHandle?: string | null}, id?: string}} assertion
 * @param {CredentialRecord} credential
 * @param {{challenge: string, origin?: string, origins?: string[], rpId: string, userVerification?: 'required' | 'preferred' | 'discouraged', allowCrossOrigin?: boolean, requireUserHandle?: boolean}} expected
 */
export function verifyAssertion(assertion, credential, expected) {
  const response = assertion?.response
  if (!response || typeof response.clientDataJSON !== 'string' || typeof response.authenticatorData !== 'string' || typeof response.signature !== 'string') {
    throw new WebAuthnError('BAD_RESPONSE', 'assertion.response needs clientDataJSON, authenticatorData and signature')
  }
  if (!expected || typeof expected.rpId !== 'string' || expected.rpId.length === 0) throw new WebAuthnError('BAD_RP_ID', 'expected.rpId is required')
  const record = normalizeCredential(credential)
  const clientData = parseClientDataJSON(response.clientDataJSON, { ...expected, type: 'webauthn.get' })
  const authDataBytes = base64urlDecode(response.authenticatorData)
  const authData = parseAuthenticatorData(authDataBytes)
  const credentialId = assertion.id ?? record.id
  if (credentialId !== record.id) throw new WebAuthnError('CREDENTIAL_MISMATCH', 'assertion id does not match the stored credential')
  if (response.userHandle !== undefined && response.userHandle !== null && response.userHandle !== record.userHandle) {
    throw new WebAuthnError('USER_HANDLE_MISMATCH', 'userHandle does not match the stored credential')
  }
  if (expected.requireUserHandle === true && !response.userHandle) throw new WebAuthnError('USER_HANDLE_MISMATCH', 'userHandle is required')
  if (!buffersEqual(authData.rpIdHash, sha256(expected.rpId))) throw new WebAuthnError('BAD_RP_ID', 'rpIdHash does not match the expected rpId')
  if (!authData.flags.up) throw new WebAuthnError('USER_NOT_PRESENT', 'user presence flag is not set')
  if (expected.userVerification === 'required' && !authData.flags.uv) throw new WebAuthnError('USER_NOT_VERIFIED', 'user verification is required')
  const storedCounter = Number(record.signCount ?? 0)
  if (!(authData.signCount === 0 && storedCounter === 0) && authData.signCount <= storedCounter) {
    throw new WebAuthnError('SIGN_COUNT_REGRESSION', `signCount ${authData.signCount} <= stored ${storedCounter}`)
  }
  const clientHash = sha256(clientData.bytes)
  const signedData = Buffer.concat([authDataBytes, clientHash])
  const signature = base64urlDecode(response.signature)
  const publicKey = coseToPublicKey(record.publicKey)
  const dsaEncoding = signature.length === 64 ? 'ieee-p1363' : 'der'
  let verified = false
  try {
    verified = cryptoVerify('sha256', signedData, { key: publicKey, dsaEncoding }, signature)
  } catch {
    verified = false
  }
  if (!verified) throw new WebAuthnError('BAD_SIGNATURE', 'assertion signature does not verify')
  return {
    verified: true,
    credentialId: record.id,
    userHandle: record.userHandle,
    newSignCount: authData.signCount,
    previousSignCount: storedCounter,
    flags: authData.flags,
    userVerified: authData.flags.uv,
    backupEligible: authData.flags.be,
    backupState: authData.flags.bs,
    clientData: clientData.data,
  }
}

/**
 * Look up the credential, verify the assertion and persist the new counter.
 * A failed verification never mutates the store.
 * @param {CredentialStore} store
 * @param {Parameters<typeof verifyAssertion>[0]} assertion
 * @param {Parameters<typeof verifyAssertion>[2] & {credentialId?: string}} expected
 */
export function authenticate(store, assertion, expected) {
  if (!(store instanceof CredentialStore)) throw new WebAuthnError('BAD_STORE', 'a CredentialStore is required')
  const id = assertion?.id ?? expected?.credentialId
  if (typeof id !== 'string' || id.length === 0) throw new WebAuthnError('BAD_RESPONSE', 'assertion id is required')
  const credential = store.get(id)
  if (!credential) throw new WebAuthnError('UNKNOWN_CREDENTIAL', `unknown credential ${id}`)
  const result = verifyAssertion(assertion, credential, expected)
  store.updateCounter(id, result.newSignCount)
  return result
}
