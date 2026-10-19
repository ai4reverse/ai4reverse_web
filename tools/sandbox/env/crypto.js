import { createHash, randomUUID as hostRandomUUID } from 'node:crypto'
import { createSeededRandom } from '../../util/random.js'

/**
 * `crypto` surface.
 *
 * `getRandomValues` is seeded: analyses must be reproducible, and a sample that
 * keys its C2 traffic off `Math.random`/`crypto.getRandomValues` must produce
 * the same observable behaviour on every run. `subtle.digest` is real (Node
 * crypto) because samples hash strings to derive keys and self-check their own
 * source; a wrong digest changes behaviour.
 */

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

  bridge.install(crypto, 'getRandomValues', bridge.fn('getRandomValues', 1, ({ args }) => {
    const target = args[0]
    if (!target) {
      throw Object.assign(new TypeError("Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present."), {})
    }
    let length = 0
    try {
      const lengthValue = ctx.getProp(target, 'length')
      length = ctx.getNumber(lengthValue)
      lengthValue.dispose()
    } catch {
      length = 0
    }
    if (length > 65536) {
      throw Object.assign(new Error("Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + length + ') exceeds the number of bytes of entropy available via this API (65536).'), { name: 'QuotaExceededError' })
    }
    const bytes = rng.bytes(length)
    for (let i = 0; i < length; i += 1) {
      const value = ctx.newNumber(bytes[i])
      ctx.setProp(target, i, value)
      value.dispose()
    }
    bridge.emit('api', 'before', { api: 'crypto.getRandomValues', length })
    return target
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(crypto, 'randomUUID', bridge.fn('randomUUID', 0, () => {
    const uuid = rng.uuid()
    bridge.emit('api', 'before', { api: 'crypto.randomUUID', uuid })
    return ctx.newString(uuid)
  }), { enumerable: true, configurable: true, writable: true })

  const subtle = bridge.obj()
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
  try {
    const buffer = ctx.getArrayBuffer(handle)
    const bytes = buffer.value.slice()
    buffer.dispose()
    return bytes
  } catch {
    try {
      const inner = ctx.getProp(handle, 'buffer')
      const buffer = ctx.getArrayBuffer(inner)
      inner.dispose()
      const bytes = buffer.value.slice()
      buffer.dispose()
      return bytes
    } catch {
      return new Uint8Array(0)
    }
  }
}
