/**
 * Secure Storage SDK — authenticated, password-derived at-rest encryption.
 *
 * Browser/Node compatible: uses WebCrypto (`crypto.subtle`) only. A vault key is
 * derived with PBKDF2-SHA-256 and every record is sealed with AES-256-GCM using
 * a fresh 96-bit IV and optional additional authenticated data (AAD).
 */
export const VERSION = '1.0.0'
export const DEFAULT_ITERATIONS = 150_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class VaultError extends Error {
  constructor(code, message, cause) {
    super(message ?? code, cause ? { cause } : undefined)
    this.name = 'VaultError'
    this.code = code
  }
}

/** @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** @param {string} text */
export function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 */
export async function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  if (typeof password !== 'string' || password.length === 0) throw new VaultError('BAD_PASSWORD', 'password is required')
  if (!(salt instanceof Uint8Array) || salt.length < 8) throw new VaultError('BAD_SALT', 'salt must be at least 8 bytes')
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * @param {{password: string, salt?: Uint8Array, iterations?: number}} options
 */
export async function createVault(options) {
  const salt = options.salt ?? randomBytes(16)
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const key = await deriveKey(options.password, salt, iterations)

  const seal = async (plaintext, sealOptions = {}) => {
    const bytes = typeof plaintext === 'string' ? encoder.encode(plaintext) : new Uint8Array(plaintext)
    const iv = randomBytes(12)
    const aad = sealOptions.aad ? encoder.encode(String(sealOptions.aad)) : undefined
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) }, key, bytes)
    return {
      v: 1,
      alg: 'AES-256-GCM',
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations },
      salt: toBase64(salt),
      iv: toBase64(iv),
      aad: aad ? toBase64(aad) : null,
      ct: toBase64(new Uint8Array(cipher)),
    }
  }

  const open = async (envelope, openOptions = {}) => {
    if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM' || typeof envelope.ct !== 'string') {
      throw new VaultError('BAD_ENVELOPE', 'unsupported or malformed envelope')
    }
    let aad
    if (openOptions.aad !== undefined) aad = encoder.encode(String(openOptions.aad))
    else if (envelope.aad) aad = fromBase64(envelope.aad)
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(envelope.iv), ...(aad ? { additionalData: aad } : {}) },
        key,
        fromBase64(envelope.ct),
      )
      return openOptions.binary ? new Uint8Array(plain) : decoder.decode(plain)
    } catch (error) {
      throw new VaultError('DECRYPT_FAILED', 'authentication failed (wrong password, AAD or tampered ciphertext)', error)
    }
  }

  const sealJson = async (value, sealOptions) => seal(JSON.stringify(value), sealOptions)
  const openJson = async (envelope, openOptions) => JSON.parse(await open(envelope, openOptions))

  return { salt, iterations, seal, open, sealJson, openJson }
}

/** Open an envelope without a cached key (derives from the envelope salt). */
export async function openWithPassword(envelope, password, options = {}) {
  if (!envelope || typeof envelope.salt !== 'string') throw new VaultError('BAD_ENVELOPE', 'envelope has no salt')
  const vault = await createVault({ password, salt: fromBase64(envelope.salt), iterations: envelope.kdf?.iterations })
  return vault.open(envelope, options)
}
