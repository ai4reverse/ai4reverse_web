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

/**
 * Code units handed to one `String.fromCharCode.apply` call. Kept far below
 * both V8's spread limit and QuickJS's 65,534-argument cap, so a large string
 * never overflows either engine.
 */
const CHAR_CHUNK = 4096

const FROM_CODE_UNITS_SOURCE =
  `(function(buffer){ var codes = new Uint16Array(buffer); var size = ${CHAR_CHUNK}; var out = '';` +
  ` for (var i = 0; i < codes.length; i += size) { var end = i + size; if (end > codes.length) end = codes.length;` +
  ` out += String.fromCharCode.apply(null, codes.subarray(i, end)); } return out })`

/**
 * Create a guest-string builder that survives embedded NULs and large inputs.
 *
 * `ctx.newString` stops at the first NUL, and one
 * `String.fromCharCode(...codes)` spread overflows both V8's stack and
 * QuickJS's argument limit. NUL-bearing text therefore travels as UTF-16 code
 * units in an ArrayBuffer and is joined in fixed-size chunks inside the guest.
 *
 * @param {object} ctx QuickJS context
 * @returns {{ fromText: (text: string) => object, dispose: () => void }}
 */
export function createTextBuilder(ctx) {
  const fromCodeUnits = ctx.unwrapResult(
    ctx.evalCode(FROM_CODE_UNITS_SOURCE, 'ai4r-internal:text-from-code-units'),
  )
  const fromText = (text) => {
    const value = String(text)
    if (!value.includes('\0')) return ctx.newString(value)
    const units = new Uint16Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      units[index] = value.charCodeAt(index)
    }
    const buffer = ctx.newArrayBuffer(units.buffer)
    try {
      return ctx.unwrapResult(ctx.callFunction(fromCodeUnits, ctx.undefined, [buffer]))
    } finally {
      buffer.dispose()
    }
  }
  return {
    fromText,
    dispose() {
      try {
        fromCodeUnits.dispose()
      } catch {
        /* already gone */
      }
    },
  }
}

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
  const textBuilder = createTextBuilder(ctx)
  const toCharCodes = ctx.unwrapResult(
    ctx.evalCode(
      '(function(s){ var out = []; for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); return out })',
      'ai4r-internal:encoding-to-codes',
    ),
  )
  bridge.onDispose(() => {
    Uint8ArrayFactory.dispose()
    textBuilder.dispose()
    try { toCharCodes.dispose() } catch { /* already gone */ }
  })

  const newJsString = (text) => textBuilder.fromText(text)

  /** Join host-side UTF-16 code units without a single large spread. */
  const joinCodeUnits = (codes) => {
    let text = ''
    for (let index = 0; index < codes.length; index += CHAR_CHUNK) {
      text += String.fromCharCode.apply(null, codes.slice(index, index + CHAR_CHUNK))
    }
    return text
  }

  const readJsString = (handle) => {
    if (!handle || ctx.typeof(handle) !== 'string') return bridge.str([handle], 0, '')
    const codesHandle = ctx.callFunction(toCharCodes, ctx.undefined, [handle])
    if (codesHandle.error) {
      codesHandle.error.dispose()
      return ctx.getString(handle)
    }
    try {
      const codes = ctx.dump(codesHandle.value)
      if (!Array.isArray(codes)) return ctx.getString(handle)
      return joinCodeUnits(codes)
    } finally {
      codesHandle.value.dispose()
    }
  }

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
      const inner = ctx.getProp(handle, 'buffer')
      const offsetHandle = ctx.getProp(handle, 'byteOffset')
      const lengthHandle = ctx.getProp(handle, 'byteLength')
      try {
        if (ctx.typeof(inner) === 'object' && ctx.typeof(offsetHandle) === 'number') {
          const offset = ctx.getNumber(offsetHandle)
          const length = ctx.getNumber(lengthHandle)
          const viaBuffer = ctx.getArrayBuffer(inner)
          try {
            return new Uint8Array(viaBuffer.value.slice(offset, offset + length))
          } finally {
            viaBuffer.dispose()
          }
        }
      } finally {
        offsetHandle.dispose()
        lengthHandle.dispose()
        inner.dispose()
      }
    } catch {
      /* fall through */
    }
    try {
      const direct = ctx.getArrayBuffer(handle)
      try {
        return new Uint8Array(direct.value.slice())
      } finally {
        direct.dispose()
      }
    } catch {
      return new Uint8Array(0)
    }
  }

  bridge.install(
    bridge.global,
    'atob',
    bridge.fn('atob', 1, ({ args }) => {
      const raw = args[0] ? readJsString(args[0]) : ''
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
      return newJsString(text)
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    bridge.global,
    'btoa',
    bridge.fn('btoa', 1, ({ args }) => {
      const input = args[0] ? readJsString(args[0]) : ''
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
    if (!destination) return bridge.obj({ read: 0, written: 0 })
    const lengthValue = ctx.getProp(destination, 'byteLength')
    const capacity = ctx.getNumber(lengthValue)
    lengthValue.dispose()
    let read = 0
    let written = 0
    // Spec: never write an incomplete UTF-8 sequence (P0-9).
    while (read < text.length) {
      const codePoint = text.codePointAt(read)
      const units = codePoint > 0xffff ? 2 : 1
      const piece = String.fromCodePoint(codePoint)
      const bytes = Buffer.from(piece, 'utf8')
      if (written + bytes.length > capacity) break
      for (let i = 0; i < bytes.length; i += 1) {
        const byte = ctx.newNumber(bytes[i])
        ctx.setProp(destination, written + i, byte)
        byte.dispose()
      }
      written += bytes.length
      read += units
    }
    return bridge.obj({ read, written })
  }

  const encodeHost = bridge.fn('encode', 1, ({ args }) => {
    const text = args[0] ? readJsString(args[0]) : ''
    bridge.emit('api', 'before', { api: 'TextEncoder.encode', length: text.length })
    return toGuestBytes(new Uint8Array(Buffer.from(text, 'utf8')))
  })
  const encodeIntoHost = bridge.fn('encodeInto', 2, ({ args }) =>
    encodeInto(args[1], args[0] ? readJsString(args[0]) : ''),
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
        return newJsString(decoded)
      } catch (error) {
        // Only a real codec failure is a TypeError. Anything else keeps its
        // own identity so a host limit is never misreported as malformed input.
        if (!(error instanceof TypeError)) throw error
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
      return newJsString(decoded)
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
