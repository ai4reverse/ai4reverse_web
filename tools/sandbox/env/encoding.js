/**
 * Base64 and text codecs.
 *
 * `atob`/`btoa` and `TextEncoder`/`TextDecoder` are the most common string
 * obfuscation primitives in malicious JavaScript, and their exact error
 * behaviour is fingerprinted by some loaders. Node's codecs run on the host
 * (correct UTF-8 and base64 semantics) while the guest sees browser-shaped
 * objects, browser-shaped errors, and native-looking function sources.
 */

export const meta = { id: 'encoding', order: 70, requires: [] }

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function install(bridge) {
  const { ctx } = bridge

  const invalidCharacter = (message) => {
    const error = new Error(message)
    error.name = 'InvalidCharacterError'
    return error
  }

  const Uint8ArrayFactory = ctx.unwrapResult(
    ctx.evalCode('(function(buffer){ return new Uint8Array(buffer) })'),
  )
  bridge.onDispose(() => Uint8ArrayFactory.dispose())

  const toGuestBytes = (bytes) => {
    const buffer = ctx.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const result = ctx.callFunction(Uint8ArrayFactory, ctx.undefined, [buffer])
    buffer.dispose()
    if (result.error) {
      const dumped = bridge.fromGuest(result.error)
      result.error.dispose()
      throw new Error(dumped?.message ?? 'Uint8Array construction failed')
    }
    return result.value
  }

  const readBytes = (handle) => {
    if (!handle) return new Uint8Array(0)
    if (ctx.typeof(handle) !== 'object') return new Uint8Array(0)
    try {
      const direct = ctx.getArrayBuffer(handle)
      const copy = direct.value.slice()
      direct.dispose()
      return copy
    } catch {
      let inner
      try {
        inner = ctx.getProp(handle, 'buffer')
        const viaBuffer = ctx.getArrayBuffer(inner)
        const copy = viaBuffer.value.slice()
        viaBuffer.dispose()
        return copy
      } catch {
        return new Uint8Array(0)
      } finally {
        if (inner) inner.dispose()
      }
    }
  }

  bridge.install(
    bridge.global,
    'atob',
    bridge.fn('atob', 1, ({ args }) => {
      const raw = bridge.str(args, 0, '')
      const input = raw.replace(/[\t\n\f\r ]/g, '')
      const padded = input.padEnd(Math.ceil(input.length / 4) * 4, '=')
      if (input.length > 0 && (input.length % 4 === 1 || !BASE64.test(padded))) {
        throw invalidCharacter("Failed to execute 'atob': The string to be decoded is not correctly encoded.")
      }
      const decoded = Buffer.from(input, 'base64')
      const text = decoded.toString('latin1')
      bridge.emit('api', 'before', {
        api: 'atob',
        length: input.length,
        decodedLength: decoded.length,
        value: text.length > 8192 ? `${text.slice(0, 8192)}…` : text,
      })
      return ctx.newString(text)
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    bridge.global,
    'btoa',
    bridge.fn('btoa', 1, ({ args }) => {
      const input = bridge.str(args, 0, '')
      for (let i = 0; i < input.length; i += 1) {
        if (input.charCodeAt(i) > 0xff) {
          throw invalidCharacter(
            "Failed to execute 'btoa': The string to be encoded contains characters outside of the Latin1 range.",
          )
        }
      }
      const encoded = Buffer.from(input, 'latin1').toString('base64')
      bridge.emit('api', 'before', {
        api: 'btoa',
        length: input.length,
        encodedLength: encoded.length,
        value: input.length > 4096 ? `${input.slice(0, 4096)}…` : input,
      })
      return ctx.newString(encoded)
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  // ---- TextEncoder -------------------------------------------------------
  const encodeInto = (destination, text) => {
    const bytes = Buffer.from(text, 'utf8')
    let written = 0
    if (destination) {
      const lengthValue = ctx.getProp(destination, 'length')
      const capacity = ctx.getNumber(lengthValue)
      lengthValue.dispose()
      written = Math.min(capacity, bytes.length)
      for (let i = 0; i < written; i += 1) {
        const byte = ctx.newNumber(bytes[i])
        ctx.setProp(destination, i, byte)
        byte.dispose()
      }
    }
    return bridge.obj({ read: written === bytes.length ? text.length : Math.floor(written), written })
  }

  const encodeHost = bridge.fn('encode', 1, ({ args }) => {
    const text = bridge.str(args, 0, '')
    bridge.emit('api', 'before', { api: 'TextEncoder.encode', length: text.length })
    return toGuestBytes(new Uint8Array(Buffer.from(text, 'utf8')))
  })
  const encodeIntoHost = bridge.fn('encodeInto', 2, ({ args }) =>
    encodeInto(args[1], bridge.str(args, 0, '')),
  )

  const TextEncoderCtor = bridge.nativeConstructor({
    name: 'TextEncoder',
    arity: 0,
    bindings: { __encode: encodeHost, __encodeInto: encodeIntoHost },
    body: `self.encoding = 'utf-8';\nself.encode = __encode;\nself.encodeInto = __encodeInto;`,
  })
  const encoderProto = ctx.getProp(TextEncoderCtor, 'prototype')
  bridge.install(encoderProto, 'encoding', 'utf-8', { enumerable: true, configurable: true, writable: false })
  bridge.install(encoderProto, 'encode', encodeHost, { enumerable: true, configurable: true, writable: true })
  bridge.install(encoderProto, 'encodeInto', encodeIntoHost, { enumerable: true, configurable: true, writable: true })
  encoderProto.dispose()
  bridge.install(bridge.global, 'TextEncoder', TextEncoderCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  // ---- TextDecoder -------------------------------------------------------
  const LABEL_ALIASES = new Map([
    ['utf-8', 'utf-8'],
    ['utf8', 'utf-8'],
    ['unicode-1-1-utf-8', 'utf-8'],
    ['utf-16le', 'utf-16le'],
    ['utf-16', 'utf-16le'],
    ['latin1', 'windows-1252'],
    ['iso-8859-1', 'windows-1252'],
    ['ascii', 'windows-1252'],
    ['windows-1252', 'windows-1252'],
  ])
  const normalizeLabel = (label) => LABEL_ALIASES.get(String(label ?? 'utf-8').toLowerCase()) ?? 'utf-8'

  const initDecoder = bridge.fn('initDecoder', 3, ({ args }) => {
    const rawLabel = bridge.str(args, 1, 'utf-8')
    let encoding
    try {
      encoding = new TextDecoder(rawLabel).encoding
    } catch {
      const error = new RangeError(
        `Failed to construct 'TextDecoder': The encoding label provided ('${rawLabel}') is invalid.`,
      )
      error.name = 'RangeError'
      throw error
    }
    const options = bridge.value(args, 2) ?? {}
    const fatal = Boolean(options.fatal)
    const ignoreBOM = Boolean(options.ignoreBOM)
    const self = args[0]
    bridge.install(self, 'encoding', encoding, { enumerable: true, configurable: true, writable: false })
    bridge.install(self, 'fatal', fatal, { enumerable: true, configurable: true, writable: false })
    bridge.install(self, 'ignoreBOM', ignoreBOM, { enumerable: true, configurable: true, writable: false })
    const decode = bridge.fn('decode', 1, ({ args: decodeArgs }) => {
      const bytes = readBytes(decodeArgs[0])
      try {
        const decoded = new TextDecoder(encoding, { fatal, ignoreBOM }).decode(bytes) // Node host codec
        bridge.emit('api', 'before', { api: 'TextDecoder.decode', encoding, length: bytes.length })
        return ctx.newString(decoded)
      } catch (error) {
        throw Object.assign(new Error(error.message), { name: 'TypeError' })
      }
    })
    bridge.install(self, 'decode', decode, { enumerable: true, configurable: true, writable: true })
    return ctx.undefined
  })

  const TextDecoderCtor = bridge.nativeConstructor({
    name: 'TextDecoder',
    arity: 2,
    bindings: { __init: initDecoder },
    body: '__init(self, a0, a1);',
  })
  const decoderProto = ctx.getProp(TextDecoderCtor, 'prototype')
  bridge.install(decoderProto, 'encoding', 'utf-8', { enumerable: true, configurable: true, writable: false })
  bridge.install(decoderProto, 'fatal', false, { enumerable: true, configurable: true, writable: false })
  bridge.install(decoderProto, 'ignoreBOM', false, { enumerable: true, configurable: true, writable: false })
  bridge.install(
    decoderProto,
    'decode',
    bridge.fn('decode', 1, ({ args }) => {
      const bytes = readBytes(args[0])
      const decoded = new TextDecoder('utf-8').decode(bytes)
      bridge.emit('api', 'before', { api: 'TextDecoder.decode', encoding: 'utf-8', length: bytes.length })
      return ctx.newString(decoded)
    }),
    { enumerable: true, configurable: true, writable: true },
  )
  decoderProto.dispose()
  bridge.install(bridge.global, 'TextDecoder', TextDecoderCtor, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}
