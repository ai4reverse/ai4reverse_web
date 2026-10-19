/**
 * Byte, text and radix primitives.
 *
 * Everything here is dependency-free so that the same code runs unchanged in
 * Node, in a browser and inside the platform's QuickJS sandbox. Nothing in this
 * module touches `TextEncoder`, `atob`, `Buffer` or `crypto`: an anti-tamper SDK
 * must not inherit a sandbox's shim behaviour, and a self-contained encoder is
 * also the only way the server verifier and the device agree bit for bit.
 */

const HEX = '0123456789abcdef'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** @param {number} value @returns {number} */
function clampByte(value) {
  return value & 0xff
}

/**
 * @param {Uint8Array|number[]} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index] & 0xff
    out += HEX[value >>> 4] + HEX[value & 0x0f]
  }
  return out
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  const text = String(hex)
  if (text.length % 2 !== 0) throw new TypeError('hex length must be even')
  const out = new Uint8Array(text.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    const high = HEX.indexOf(text[index * 2].toLowerCase())
    const low = HEX.indexOf(text[index * 2 + 1].toLowerCase())
    if (high < 0 || low < 0) throw new TypeError(`invalid hex at offset ${index * 2}`)
    out[index] = (high << 4) | low
  }
  return out
}

/**
 * Strict UTF-8 encoder (surrogate pairs handled, lone surrogates become
 * U+FFFD, which is what browsers do when encoding to UTF-8).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function utf8ToBytes(text) {
  const source = String(text)
  const out = []
  for (let index = 0; index < source.length; index += 1) {
    let code = source.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        index += 1
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/**
 * UTF-8 decoder with the WHATWG replacement behaviour.
 * @param {Uint8Array|number[]} bytes
 * @returns {string}
 */
export function bytesToUtf8(bytes) {
  let out = ''
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index] & 0xff
    let code = 0xfffd
    let width = 1
    if (first < 0x80) {
      code = first
    } else if (first >= 0xc2 && first <= 0xdf) {
      width = 2
      if (index + 1 < bytes.length && (bytes[index + 1] & 0xc0) === 0x80) {
        code = ((first & 0x1f) << 6) | (bytes[index + 1] & 0x3f)
      }
    } else if (first >= 0xe0 && first <= 0xef) {
      width = 3
      if (
        index + 2 < bytes.length &&
        (bytes[index + 1] & 0xc0) === 0x80 &&
        (bytes[index + 2] & 0xc0) === 0x80
      ) {
        const value = ((first & 0x0f) << 12) | ((bytes[index + 1] & 0x3f) << 6) | (bytes[index + 2] & 0x3f)
        code = value < 0x800 ? 0xfffd : value
      }
    } else if (first >= 0xf0 && first <= 0xf4) {
      width = 4
      if (
        index + 3 < bytes.length &&
        (bytes[index + 1] & 0xc0) === 0x80 &&
        (bytes[index + 2] & 0xc0) === 0x80 &&
        (bytes[index + 3] & 0xc0) === 0x80
      ) {
        const value =
          ((first & 0x07) << 18) |
          ((bytes[index + 1] & 0x3f) << 12) |
          ((bytes[index + 2] & 0x3f) << 6) |
          (bytes[index + 3] & 0x3f)
        code = value < 0x10000 || value > 0x10ffff ? 0xfffd : value
      }
    }
    if (code > 0xffff) {
      const offset = code - 0x10000
      out += String.fromCharCode(0xd800 + (offset >>> 10), 0xdc00 + (offset & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
    index += width
  }
  return out
}

/**
 * @param {Uint8Array|number[]} bytes
 * @returns {string}
 */
export function base64Encode(bytes) {
  let out = ''
  let index = 0
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2]
    out += B64[(chunk >>> 18) & 63] + B64[(chunk >>> 12) & 63] + B64[(chunk >>> 6) & 63] + B64[chunk & 63]
  }
  const rest = bytes.length - index
  if (rest === 1) {
    const chunk = bytes[index] << 16
    out += `${B64[(chunk >>> 18) & 63]}${B64[(chunk >>> 12) & 63]}==`
  } else if (rest === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8)
    out += `${B64[(chunk >>> 18) & 63]}${B64[(chunk >>> 12) & 63]}${B64[(chunk >>> 6) & 63]}=`
  }
  return out
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64Decode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '')
  const out = []
  for (let index = 0; index < clean.length; index += 4) {
    const a = B64.indexOf(clean[index])
    const b = B64.indexOf(clean[index + 1] ?? 'A')
    const c = clean[index + 2] === undefined ? 0 : B64.indexOf(clean[index + 2])
    const d = clean[index + 3] === undefined ? 0 : B64.indexOf(clean[index + 3])
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new TypeError('invalid base64')
    const chunk = (a << 18) | (b << 12) | (c << 6) | d
    out.push((chunk >>> 16) & 0xff)
    if (clean[index + 2] !== undefined) out.push((chunk >>> 8) & 0xff)
    if (clean[index + 3] !== undefined) out.push(chunk & 0xff)
  }
  return Uint8Array.from(out)
}

/**
 * Repeated long division of a big-endian byte string. Used by the radix
 * encoders; `base` must be 2..256.
 * @param {number[]} digits big-endian, mutable copy expected
 * @param {number} base
 * @returns {number} remainder, digits become the quotient
 */
function divideInPlace(digits, base) {
  let remainder = 0
  for (let index = 0; index < digits.length; index += 1) {
    const value = (remainder << 8) | digits[index]
    digits[index] = Math.floor(value / base)
    remainder = value % base
  }
  return remainder
}

/**
 * Base-`alphabet.length` encoding of a byte string (big-endian, no padding,
 * leading zero bytes preserved through a sentinel scheme).
 * @param {Uint8Array|number[]} bytes
 * @param {string} [alphabet]
 * @returns {string}
 */
export function radixEncode(bytes, alphabet = B62) {
  const digits = Array.from(bytes, clampByte)
  if (digits.length === 0) return ''
  let zeros = 0
  while (zeros < digits.length && digits[zeros] === 0) zeros += 1
  // Work on the significant part only; leading zeros are carried as sentinel
  // digits because the numeric representation cannot express them.
  const work = digits.slice(zeros)
  const out = []
  while (work.length > 0) {
    out.push(alphabet[divideInPlace(work, alphabet.length)])
    while (work.length > 0 && work[0] === 0) work.shift()
  }
  out.reverse()
  return alphabet[0].repeat(zeros) + out.join('')
}

/**
 * @param {string} text
 * @param {string} [alphabet]
 * @returns {Uint8Array}
 */
export function radixDecode(text, alphabet = B62) {
  const source = String(text)
  if (source.length === 0) return new Uint8Array(0)
  // Leading `alphabet[0]` digits are a sentinel for leading zero bytes: the
  // numeric representation never emits a leading zero digit.
  let zeros = 0
  while (zeros < source.length && source[zeros] === alphabet[0]) zeros += 1
  /** @type {number[]} little-endian numeric accumulator in base 256 */
  const accumulator = []
  for (const character of source.slice(zeros)) {
    const value = alphabet.indexOf(character)
    if (value < 0) throw new TypeError(`invalid radix digit '${character}'`)
    let carry = value
    for (let index = 0; index < accumulator.length; index += 1) {
      const next = accumulator[index] * alphabet.length + carry
      accumulator[index] = next & 0xff
      carry = next >>> 8
    }
    while (carry > 0) {
      accumulator.push(carry & 0xff)
      carry >>>= 8
    }
  }
  while (accumulator.length > 1 && accumulator[accumulator.length - 1] === 0) accumulator.pop()
  const body = accumulator.reverse()
  const out = new Uint8Array(zeros + body.length)
  out.set(body, zeros)
  return out
}

/**
 * @param {...(Uint8Array|number[])} parts
 * @returns {Uint8Array}
 */
export function concatBytes(...parts) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * @param {Uint8Array|number[]} a
 * @param {Uint8Array|number[]} b
 * @returns {Uint8Array}
 */
export function xorBytes(a, b) {
  const length = Math.min(a.length, b.length)
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) out[index] = (a[index] ^ b[index]) & 0xff
  return out
}

/**
 * Constant-time byte comparison: the loop length depends only on the inputs'
 * common length, never on where they first differ.
 * @param {Uint8Array|number[]} a
 * @param {Uint8Array|number[]} b
 * @returns {boolean}
 */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ^ b[index]) & 0xff
  return difference === 0
}

/**
 * @param {string} hex
 * @returns {string} hex of the UTF-8 bytes of `hex`'s string value
 */
export function textToHex(text) {
  return toHex(utf8ToBytes(text))
}

/** @param {string} hex @returns {string} */
export function hexToText(hex) {
  return bytesToUtf8(fromHex(hex))
}

/**
 * Left-rotate a 32-bit word.
 * @param {number} value
 * @param {number} shift
 * @returns {number}
 */
export function rotl32(value, shift) {
  const amount = shift & 31
  return ((value << amount) | (value >>> ((32 - amount) & 31))) >>> 0
}

/**
 * @param {number} value
 * @param {number} shift
 * @returns {number}
 */
export function rotr32(value, shift) {
  const amount = shift & 31
  return ((value >>> amount) | (value << ((32 - amount) & 31))) >>> 0
}

/**
 * Read a big-endian 32-bit word.
 * @param {Uint8Array|number[]} bytes
 * @param {number} offset
 * @returns {number}
 */
export function readU32BE(bytes, offset) {
  return (
    (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0)
  )
}

/**
 * @param {Uint8Array|number[]} bytes
 * @param {number} offset
 * @returns {number}
 */
export function readU32LE(bytes, offset) {
  return (
    ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0)
  )
}

/**
 * @param {number} value
 * @returns {number[]} four bytes, big-endian
 */
export function u32BE(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/**
 * @param {number} value
 * @returns {number[]} four bytes, little-endian
 */
export function u32LE(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

/**
 * @param {Uint8Array|number[]} bytes
 * @returns {number}
 */
export function readU64LE(bytes, offset = 0) {
  return (
    BigInt(readU32LE(bytes, offset)) | (BigInt(readU32LE(bytes, offset + 4)) << 32n)
  )
}

/**
 * @param {bigint} value
 * @returns {number[]} eight bytes, little-endian
 */
export function u64LE(value) {
  const mask = 0xffffffffn
  return [...u32LE(Number(value & mask)), ...u32LE(Number((value >> 32n) & mask))]
}

/** @param {Uint8Array|number[]} bytes @returns {Uint8Array} */
export function cloneBytes(bytes) {
  return Uint8Array.from(bytes)
}

/** @param {number|bigint} value @returns {bigint} */
export function toBigInt(value) {
  return typeof value === 'bigint' ? value : BigInt(value)
}
