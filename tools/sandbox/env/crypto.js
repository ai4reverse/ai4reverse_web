/**
 * `crypto` surface.
 *
 * `getRandomValues` is seeded: analyses must be reproducible, and a sample that
 * keys its C2 traffic off `Math.random`/`crypto.getRandomValues` must produce
 * the same observable behaviour on every run. `subtle.digest` is real (Node
 * crypto) because samples hash strings to derive keys and self-check their own
 * source; a wrong digest changes behaviour.
 */
import { createHash, createCipheriv, createDecipheriv, randomUUID as hostRandomUUID } from 'node:crypto'
import { createSeededRandom } from '../../util/random.js'
export const meta = { id: 'crypto', order: 80, requires: ['globals'] }

const HASH_ALGORITHMS = new Map([
  ['SHA-1', 'sha1'],
  ['SHA-256', 'sha256'],
  ['SHA-384', 'sha384'],
  ['SHA-512', 'sha512'],
])

export function install(bridge) {
  const { ctx, profile } = bridge
  const rng = createSeededRandom(`${profile.seed}::crypto`)
  const crypto = bridge.obj()
  // Write entropy into the view's byte window (not element indices) — P0-9.
  const fillView = ctx.unwrapResult(
    ctx.evalCode(
      '(function(view, bytes){ var u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength); for (var i = 0; i < bytes.length; i++) u8[i] = bytes[i]; return view; })',
      'ai4r-internal:crypto-fill',
    ),
  )
  const asUint8 = ctx.unwrapResult(
    ctx.evalCode('(function(b){ return new Uint8Array(b) })', 'ai4r-internal:crypto-u8'),
  )
  bridge.onDispose(() => {
    try { fillView.dispose() } catch { /* already gone */ }
    try { asUint8.dispose() } catch { /* already gone */ }
  })

  bridge.install(crypto, 'getRandomValues', bridge.fn('getRandomValues', 1, ({ args }) => {
    const target = args[0]
    if (!target) {
      throw Object.assign(new TypeError("Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present."), {})
    }
    let byteLength = 0
    try {
      const lengthValue = ctx.getProp(target, 'byteLength')
      byteLength = ctx.getNumber(lengthValue)
      lengthValue.dispose()
    } catch {
      byteLength = 0
    }
    if (byteLength > 65536) {
      throw Object.assign(new Error("Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + byteLength + ') exceeds the number of bytes of entropy available via this API (65536).'), { name: 'QuotaExceededError' })
    }
    const bytes = rng.bytes(byteLength)
    const bytesHandle = ctx.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    let bytesArray
    try {
      bytesArray = ctx.unwrapResult(ctx.callFunction(asUint8, ctx.undefined, [bytesHandle]))
      const filled = ctx.callFunction(fillView, ctx.undefined, [target, bytesArray])
      if (filled.error) {
        filled.error.dispose()
        throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': parameter 1 is not of type 'ArrayBufferView'.")
      }
      filled.value.dispose()
    } finally {
      bytesArray?.dispose?.()
      bytesHandle.dispose()
    }
    bridge.emit('api', 'before', { api: 'crypto.getRandomValues', length: byteLength })
    return target
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(crypto, 'randomUUID', bridge.fn('randomUUID', 0, () => {
    const uuid = rng.uuid()
    bridge.emit('api', 'before', { api: 'crypto.randomUUID', uuid })
    return ctx.newString(uuid)
  }), { enumerable: true, configurable: true, writable: true })

  const subtle = bridge.obj()
  // CryptoKey objects are opaque to the guest: the raw material lives on the
  // host and is addressed by a registered (hidden) symbol.
  const keySymbol = ctx.newSymbolFor('ai4r.crypto.key')
  let nextKeyId = 0
  const keyStore = new Map()
  bridge.onDispose(() => {
    keyStore.clear()
    try {
      keySymbol.dispose()
    } catch {
      /* already gone */
    }
  })

  const algorithmName = (value) => {
    if (typeof value === 'string') return value.toUpperCase()
    if (value && typeof value === 'object') return String(value.name ?? '').toUpperCase()
    return ''
  }
  const readBytesFrom = (handle) => readBytes(ctx, handle)
  const makeKey = (bytes, algorithm, extractable, usages) => {
    nextKeyId += 1
    const keyId = nextKeyId
    keyStore.set(keyId, { bytes: new Uint8Array(bytes), algorithm, extractable, usages })
    const key = bridge.obj({
      type: 'secret',
      extractable: Boolean(extractable),
      algorithm: { name: algorithm, length: bytes.length * 8 },
      usages: bridge.arr(usages),
    })
    const idHandle = ctx.newNumber(keyId)
    ctx.setProp(key, keySymbol, idHandle)
    idHandle.dispose()
    return key
  }
  const keyFor = (handle) => {
    try {
      const idHandle = ctx.getProp(handle, keySymbol)
      const keyId = ctx.getNumber(idHandle)
      idHandle.dispose()
      return keyStore.get(keyId) ?? null
    } catch {
      return null
    }
  }
  const promiseOfBuffer = (bytes) => {
    const deferred = bridge.deferred()
    deferred.resolve(bridge.toGuest(new Uint8Array(bytes)))
    return deferred.handle
  }
  const cipherName = (algorithm, keyBytes, encrypting) => {
    const name = algorithmName(algorithm)
    const bits = keyBytes.length * 8
    if (name === 'AES-GCM') return `aes-${bits}-gcm`
    if (name === 'AES-CBC') return `aes-${bits}-cbc`
    if (name === 'AES-CTR') return `aes-${bits}-ctr`
    if (name === 'AES-ECB') return `aes-${bits}-ecb`
    return encrypting ? null : null
  }

  bridge.install(subtle, 'importKey', bridge.fn('importKey', 5, ({ args }) => {
    const format = String(bridge.str(args, 0, 'raw'))
    const algorithm = bridge.value(args, 2)
    const extractable = Boolean(bridge.value(args, 3))
    const usages = bridge.list(args[4])
    if (format !== 'raw') {
      throw Object.assign(new Error('Only raw key import is supported'), { name: 'NotSupportedError' })
    }
    const bytes = readBytesFrom(args[1])
    const name = algorithmName(algorithm)
    if (!['AES-GCM', 'AES-CBC', 'AES-CTR', 'AES-ECB'].includes(name)) {
      throw Object.assign(new Error(`Unsupported algorithm ${name}`), { name: 'NotSupportedError' })
    }
    const key = makeKey(bytes, name, extractable, usages)
    const deferred = bridge.deferred()
    deferred.resolve(key)
    return deferred.handle
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(subtle, 'exportKey', bridge.fn('exportKey', 2, ({ args }) => {
    const format = String(bridge.str(args, 0, 'raw'))
    const key = keyFor(args[1])
    if (!key) {
      const deferred = bridge.deferred()
      deferred.reject(Object.assign(new Error('InvalidAccessError'), { name: 'InvalidAccessError' }))
      return deferred.handle
    }
    if (format !== 'raw') {
      throw Object.assign(new Error('Only raw key export is supported'), { name: 'NotSupportedError' })
    }
    return promiseOfBuffer(key.bytes)
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(subtle, 'generateKey', bridge.fn('generateKey', 3, ({ args }) => {
    const algorithm = bridge.value(args, 0) ?? {}
    const name = algorithmName(algorithm)
    const length = Number(algorithm.length ?? 256)
    const key = makeKey(rng.bytes(length / 8), name, Boolean(bridge.value(args, 1)), bridge.list(args[2]))
    const deferred = bridge.deferred()
    deferred.resolve(key)
    return deferred.handle
  }), { enumerable: true, configurable: true, writable: true })

  const installCipher = (name, encrypting) => {
    bridge.install(subtle, name, bridge.fn(name, 3, ({ args }) => {
      const algorithm = bridge.value(args, 0) ?? {}
      const key = keyFor(args[1])
      if (!key) {
        const deferred = bridge.deferred()
        deferred.reject(Object.assign(new Error('InvalidAccessError'), { name: 'InvalidAccessError' }))
        return deferred.handle
      }
      const data = readBytesFrom(args[2])
      let ivBytes = null
      if (algorithm && algorithm.iv) {
        const ivHandle = ctx.getProp(args[0], 'iv')
        try {
          ivBytes = readBytesFrom(ivHandle)
        } finally {
          ivHandle.dispose()
        }
      }
      const cipher = cipherName(algorithm, key.bytes, encrypting)
      if (!cipher) {
        throw Object.assign(new Error(`Unsupported algorithm ${algorithmName(algorithm)}`), { name: 'NotSupportedError' })
      }
      try {
        if (encrypting) {
          const enc = createCipheriv(cipher, key.bytes, cipher.includes('ecb') ? null : ivBytes)
          const output = Buffer.concat([enc.update(Buffer.from(data)), enc.final()])
          if (cipher.endsWith('gcm')) return promiseOfBuffer(Buffer.concat([output, enc.getAuthTag()]))
          return promiseOfBuffer(output)
        }
        if (cipher.endsWith('gcm')) {
          const tag = data.subarray(Math.max(0, data.length - 16))
          const body = data.subarray(0, Math.max(0, data.length - 16))
          const dec = createDecipheriv(cipher, key.bytes, ivBytes)
          dec.setAuthTag(Buffer.from(tag))
          const output = Buffer.concat([dec.update(Buffer.from(body)), dec.final()])
          return promiseOfBuffer(output)
        }
        const dec = createDecipheriv(cipher, key.bytes, cipher.includes('ecb') ? null : ivBytes)
        return promiseOfBuffer(Buffer.concat([dec.update(Buffer.from(data)), dec.final()]))
      } catch (error) {
        const deferred = bridge.deferred()
        deferred.reject(Object.assign(new Error(error.message), { name: 'OperationError' }))
        return deferred.handle
      }
    }), { enumerable: true, configurable: true, writable: true })
  }
  installCipher('encrypt', true)
  installCipher('decrypt', false)
  bridge.install(subtle, 'digest', bridge.fn('digest', 2, ({ args }) => {
    const algorithm = normalizeAlgorithm(bridge.str(args, 0, ''))
    const data = readBytes(ctx, args[1])
    const deferred = bridge.deferred()
    const nodeAlgorithm = HASH_ALGORITHMS.get(algorithm)
    if (!nodeAlgorithm) {
      const error = new Error(`Unrecognized algorithm name: ${algorithm}`)
      error.name = 'NotSupportedError'
      deferred.reject(Object.assign(new Error(error.message), { name: error.name }))
      return deferred.handle
    }
    const digest = createHash(nodeAlgorithm).update(Buffer.from(data)).digest()
    bridge.emit('api', 'before', {
      api: 'crypto.subtle.digest',
      algorithm,
      inputLength: data.length,
      digest: digest.subarray(0, 8).toString('hex'),
    })
    deferred.resolve(bridge.toGuest(new Uint8Array(digest)))
    return deferred.handle
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(subtle, 'generateKey', bridge.fn('generateKey', 3, () => {
    const deferred = bridge.deferred()
    deferred.reject(Object.assign(new Error('Operation is not supported'), { name: 'NotSupportedError' }))
    return deferred.handle
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(crypto, 'subtle', subtle, { enumerable: true, configurable: true, writable: false })

  bridge.install(bridge.global, 'crypto', crypto, {
    enumerable: true,
    configurable: true,
    writable: false,
  })


  void hostRandomUUID
}

function normalizeAlgorithm(value) {
  const upper = String(value).toUpperCase()
  if (upper === 'SHA1') return 'SHA-1'
  if (upper === 'SHA256') return 'SHA-256'
  if (upper === 'SHA384') return 'SHA-384'
  if (upper === 'SHA512') return 'SHA-512'
  return upper
}

function readBytes(ctx, handle) {
  if (!handle) return new Uint8Array(0)
  // Prefer the view window (byteOffset/byteLength) so TypedArray slices are
  // hashed/digested correctly (P0-9).
  try {
    const inner = ctx.getProp(handle, 'buffer')
    const offsetHandle = ctx.getProp(handle, 'byteOffset')
    const lengthHandle = ctx.getProp(handle, 'byteLength')
    try {
      if (ctx.typeof(inner) === 'object' && ctx.typeof(offsetHandle) === 'number') {
        const offset = ctx.getNumber(offsetHandle)
        const length = ctx.getNumber(lengthHandle)
        const buffer = ctx.getArrayBuffer(inner)
        try {
          return new Uint8Array(buffer.value.slice(offset, offset + length))
        } finally {
          buffer.dispose()
        }
      }
    } finally {
      offsetHandle.dispose()
      lengthHandle.dispose()
      inner.dispose()
    }
  } catch {
    /* fall through to ArrayBuffer / full-buffer paths */
  }
  try {
    const buffer = ctx.getArrayBuffer(handle)
    try {
      return new Uint8Array(buffer.value.slice())
    } finally {
      buffer.dispose()
    }
  } catch {
    try {
      const inner = ctx.getProp(handle, 'buffer')
      try {
        const buffer = ctx.getArrayBuffer(inner)
        try {
          return new Uint8Array(buffer.value.slice())
        } finally {
          buffer.dispose()
        }
      } finally {
        inner.dispose()
      }
    } catch {
      return new Uint8Array(0)
    }
  }
}
