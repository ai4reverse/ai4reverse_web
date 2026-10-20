/**
 * DRM / Watermarking SDK — invisible, error-correcting text watermarks.
 *
 * A compact binary frame (magic, version, flags, payload length, canonical JSON
 * metadata, truncated HMAC/SHA-256 tag) is Hamming(7,4) encoded and mapped to
 * zero-width characters. The symbol stream is distributed across the visible
 * text between two invisible sentinels, so the cover text renders unchanged
 * while the watermark survives copy/paste through rich-text pipelines. Single
 * bit errors are corrected by the Hamming code; anything beyond the correction
 * budget is rejected by the tag.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const VERSION = '1.0.0'
export const WATERMARK_START = '\u2063'
export const WATERMARK_END = '\u2062'
export const WATERMARK_BIT0 = '\u200b'
export const WATERMARK_BIT1 = '\u200c'
export const DEFAULT_DENSITY = 0.5
const MAGIC = 0xa7
const FRAME_VERSION = 1
const TAG_LENGTH = 8
const HEADER_LENGTH = 5
const OVERHEAD = HEADER_LENGTH + TAG_LENGTH
const SENTINELS = new Set([WATERMARK_START, WATERMARK_END])
const SYMBOLS = new Set([WATERMARK_START, WATERMARK_END, WATERMARK_BIT0, WATERMARK_BIT1])
const INVISIBLES = new Set([
  WATERMARK_START,
  WATERMARK_END,
  WATERMARK_BIT0,
  WATERMARK_BIT1,
  '\u200d',
  '\u2060',
  '\u200e',
  '\u200f',
  '\ufeff',
])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class WatermarkError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code)
    this.name = 'WatermarkError'
    this.code = code
  }
}

/** @param {...(Uint8Array|Buffer|string)} chunks */
export function sha256(...chunks) {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
  return new Uint8Array(hash.digest())
}

/** @param {string|Uint8Array} key @param {Uint8Array} bytes */
function hmac(key, bytes) {
  return new Uint8Array(createHmac('sha256', key).update(bytes).digest())
}

/** @param {string|Uint8Array} key */
function keyBytes(key) {
  return typeof key === 'string' ? encoder.encode(key) : key
}

/** @param {...Uint8Array} chunks @returns {Uint8Array} */
function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

/** @param {any} value @returns {string} */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {string} cover */
export function visibleLength(cover) {
  let count = 0
  for (const character of String(cover)) if (!INVISIBLES.has(character)) count += 1
  return count
}

/** @param {string} text */
export function analyzeInvisible(text) {
  const counts = {}
  let visible = 0
  for (const character of String(text)) {
    if (INVISIBLES.has(character)) counts[character] = (counts[character] ?? 0) + 1
    else visible += 1
  }
  return { visible, invisible: Object.values(counts).reduce((sum, count) => sum + count, 0), counts }
}

/**
 * Hamming(7,4) encoder: returns the seven codeword bits for a nibble.
 * @param {number} nibble
 * @returns {number[]}
 */
export function hammingEncodeNibble(nibble) {
  const value = nibble & 0x0f
  const d1 = (value >> 3) & 1
  const d2 = (value >> 2) & 1
  const d3 = (value >> 1) & 1
  const d4 = value & 1
  return [d1 ^ d2 ^ d4, d1 ^ d3 ^ d4, d1, d2 ^ d3 ^ d4, d2, d3, d4]
}

/**
 * Hamming(7,4) decoder with single-bit correction.
 * @param {number[]} bits
 * @returns {{nibble: number, corrected: boolean}}
 */
export function hammingDecodeCodeword(bits) {
  if (!Array.isArray(bits) || bits.length !== 7) throw new WatermarkError('BAD_CODEWORD', 'expected a 7-bit codeword')
  const codeword = bits.map((bit) => (bit ? 1 : 0))
  const syndrome =
    (codeword[0] ^ codeword[2] ^ codeword[4] ^ codeword[6]) |
    ((codeword[1] ^ codeword[2] ^ codeword[5] ^ codeword[6]) << 1) |
    ((codeword[3] ^ codeword[4] ^ codeword[5] ^ codeword[6]) << 2)
  if (syndrome > 0) codeword[syndrome - 1] ^= 1
  const nibble = (codeword[2] << 3) | (codeword[4] << 2) | (codeword[5] << 1) | codeword[6]
  return { nibble, corrected: syndrome !== 0 }
}

/** @param {number} nibble @returns {number[]} */
function nibbleToBits(nibble) {
  return hammingEncodeNibble(nibble)
}

/** @param {Uint8Array} frame */
function frameToSymbols(frame) {
  const symbols = [WATERMARK_START]
  for (const byte of frame) {
    for (const nibble of [byte >> 4, byte & 0x0f]) {
      for (const bit of nibbleToBits(nibble)) symbols.push(bit ? WATERMARK_BIT1 : WATERMARK_BIT0)
    }
  }
  symbols.push(WATERMARK_END)
  return symbols
}

/**
 * @param {object} metadata
 * @param {{key?: string|Uint8Array}} [options]
 */
export function buildFrame(metadata, options = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new WatermarkError('BAD_METADATA', 'metadata must be a plain object')
  const serialized = canonicalJson(metadata)
  try {
    const parsed = JSON.parse(serialized)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
  } catch {
    throw new WatermarkError('BAD_METADATA', 'metadata must be JSON serializable')
  }
  const payload = encoder.encode(serialized)
  if (payload.length > 0xffff) throw new WatermarkError('BAD_METADATA', 'metadata exceeds 65535 bytes')
  const keyed = options.key !== undefined && options.key !== null
  const body = concatBytes(Uint8Array.of(MAGIC, FRAME_VERSION, keyed ? 1 : 0), Uint8Array.of(payload.length >> 8, payload.length & 0xff), payload)
  const tag = keyed ? hmac(keyBytes(options.key), body).subarray(0, TAG_LENGTH) : sha256(body).subarray(0, TAG_LENGTH)
  return { frame: concatBytes(body, tag), body, payload, keyed }
}

/** @param {Uint8Array} frame */
export function parseFrame(frame, options = {}) {
  if (!(frame instanceof Uint8Array) || frame.length < OVERHEAD) throw new WatermarkError('BAD_FRAME', 'frame is too short')
  if (frame[0] !== MAGIC) throw new WatermarkError('BAD_FRAME', `unexpected magic 0x${frame[0].toString(16)}`)
  if (frame[1] !== FRAME_VERSION) throw new WatermarkError('BAD_FRAME', 'unsupported watermark version')
  const keyed = (frame[2] & 1) === 1
  const length = (frame[3] << 8) | frame[4]
  if (frame.length !== HEADER_LENGTH + length + TAG_LENGTH) throw new WatermarkError('BAD_FRAME', 'frame length mismatch')
  const body = frame.subarray(0, HEADER_LENGTH + length)
  const tag = frame.subarray(HEADER_LENGTH + length)
  if (keyed) {
    if (options.key === undefined || options.key === null) {
      if (!options.allowUnverified) throw new WatermarkError('AUTH_REQUIRED', 'watermark is keyed but no key was supplied')
    } else {
      const expected = hmac(keyBytes(options.key), body).subarray(0, TAG_LENGTH)
      if (!equalBytes(tag, expected)) throw new WatermarkError('AUTH_FAILED', 'watermark authentication failed')
    }
  } else {
    const expected = sha256(body).subarray(0, TAG_LENGTH)
    if (!equalBytes(tag, expected)) throw new WatermarkError('CHECKSUM_FAILED', 'watermark checksum failed')
  }
  let metadata
  try {
    metadata = JSON.parse(decoder.decode(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + length)))
  } catch {
    throw new WatermarkError('BAD_FRAME', 'watermark payload is not valid JSON')
  }
  return { metadata, keyed, frameLength: frame.length }
}

/**
 * Maximum metadata payload for a cover text.
 * @param {string} cover
 * @param {{density?: number}} [options]
 */
export function watermarkCapacity(cover, options = {}) {
  if (typeof cover !== 'string') throw new WatermarkError('BAD_COVER', 'cover text must be a string')
  const density = options.density ?? DEFAULT_DENSITY
  if (!(density > 0 && density <= 1)) throw new WatermarkError('BAD_DENSITY', 'density must be in (0, 1]')
  const symbols = Math.floor(visibleLength(cover) * density)
  const frameBytes = Math.floor(symbols / 14)
  return {
    density,
    symbols,
    frameBytes,
    maxPayloadBytes: Math.max(0, frameBytes - OVERHEAD),
  }
}

/** @param {string} cover @param {string[]} stream */
function distribute(cover, stream) {
  const visible = visibleLength(cover)
  const step = stream.length === 0 ? 1 : Math.max(1, Math.floor((visible + 1) / (stream.length + 1)))
  const output = []
  let cursor = 0
  let seen = 0
  for (const character of cover) {
    output.push(character)
    if (INVISIBLES.has(character)) continue
    seen += 1
    if (cursor < stream.length && seen % step === 0) output.push(stream[cursor++])
  }
  while (cursor < stream.length) output.push(stream[cursor++])
  return output.join('')
}

/**
 * Embed metadata into cover text as an invisible watermark.
 * @param {string} cover
 * @param {object} metadata
 * @param {{key?: string|Uint8Array, density?: number}} [options]
 * @returns {string}
 */
export function embedWatermark(cover, metadata, options = {}) {
  if (typeof cover !== 'string' || cover.length === 0) throw new WatermarkError('BAD_COVER', 'cover text must be a non-empty string')
  const built = buildFrame(metadata, options)
  const symbols = frameToSymbols(built.frame)
  const capacity = watermarkCapacity(cover, options)
  if (built.frame.length > capacity.frameBytes) {
    throw new WatermarkError('CAPACITY_EXCEEDED', `watermark needs ${built.frame.length} frame bytes, capacity is ${capacity.frameBytes}`)
  }
  return distribute(cover, symbols)
}

/** @param {string} text */
function collectSymbols(text) {
  let started = false
  const bits = []
  for (const character of text) {
    if (character === WATERMARK_START) {
      started = true
      bits.length = 0
      continue
    }
    if (character === WATERMARK_END) {
      if (started) return bits
      continue
    }
    if (!started) continue
    if (character === WATERMARK_BIT0) bits.push(0)
    else if (character === WATERMARK_BIT1) bits.push(1)
  }
  return null
}

/**
 * @param {string} text
 * @param {{key?: string|Uint8Array, allowUnverified?: boolean}} [options]
 */
export function extractWatermark(text, options = {}) {
  if (typeof text !== 'string') throw new WatermarkError('BAD_COVER', 'watermarked text must be a string')
  const bits = collectSymbols(text)
  if (bits === null) throw new WatermarkError('MISSING_WATERMARK', 'no watermark sentinels found')
  if (bits.length === 0 || bits.length % 7 !== 0) throw new WatermarkError('BAD_FRAME', 'symbol stream is not codeword-aligned')
  const nibbles = []
  let correctedCodewords = 0
  for (let offset = 0; offset < bits.length; offset += 7) {
    const decoded = hammingDecodeCodeword(bits.slice(offset, offset + 7))
    if (decoded.corrected) correctedCodewords += 1
    nibbles.push(decoded.nibble)
  }
  if (nibbles.length % 2 !== 0) throw new WatermarkError('BAD_FRAME', 'nibble stream has an odd length')
  const frame = new Uint8Array(nibbles.length / 2)
  for (let index = 0; index < frame.length; index += 1) frame[index] = (nibbles[index * 2] << 4) | nibbles[index * 2 + 1]
  const parsed = parseFrame(frame, options)
  return { ...parsed, correctedCodewords, symbols: bits.length + 2, bytes: frame.length }
}

/**
 * @param {string} text
 * @returns {{present: boolean, keyed: boolean, corrected: number, metadata?: object}}
 */
export function detectWatermark(text) {
  try {
    const result = extractWatermark(text, { allowUnverified: true })
    return { present: true, keyed: result.keyed, corrected: result.correctedCodewords, metadata: result.metadata }
  } catch {
    return { present: false, keyed: false, corrected: 0 }
  }
}

/** Remove every supported invisible character (watermark and decoys). @param {string} text */
export function stripWatermark(text) {
  let output = ''
  for (const character of String(text)) if (!INVISIBLES.has(character)) output += character
  return output
}

/** @param {string} text @returns {string} */
export function watermarkFingerprint(text) {
  return Buffer.from(sha256(text)).toString('hex').slice(0, 16)
}

/**
 * @param {{key?: string|Uint8Array, density?: number}} [options]
 */
export function createWatermarker(options = {}) {
  const key = options.key
  const density = options.density
  return {
    keyed: key !== undefined && key !== null,
    embed: (cover, metadata, embedOptions = {}) => embedWatermark(cover, metadata, { key, density, ...embedOptions }),
    extract: (text, extractOptions = {}) => extractWatermark(text, { key, ...extractOptions }),
    detect: (text) => detectWatermark(text),
    capacity: (cover, capacityOptions = {}) => watermarkCapacity(cover, { density, ...capacityOptions }),
    strip: stripWatermark,
    analyze: analyzeInvisible,
  }
}
