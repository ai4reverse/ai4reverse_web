import { createHash } from 'node:crypto'
import { createSeededRandom, hashSeed } from '../../util/random.js'
import { isHandle } from '../bridge.js'

/**
 * Canvas 2D, WebGL/WebGL2, Web Audio and font-metrics surfaces.
 *
 * These four APIs are the classic "device fingerprint" cluster: a sample draws
 * text or a gradient and hashes `toDataURL`, reads `getImageData`, asks WebGL for
 * its unmasked renderer, or sums the output of an `AnalyserNode`. Every value
 * below is derived from the seeded profile, so a given profile always produces
 * the same fingerprint (an analyst can reproduce a trace byte-for-byte) while
 * two profiles differ, exactly like two real machines.
 *
 * Hard rules implemented here:
 *  - No host time, no `Math.random`, no host pixel decoding: the "rendered"
 *    image is a deterministic buffer keyed by `sha256(seed + dimensions + ops)`.
 *  - Every drawing operation is recorded (bounded log) and emitted as a `dom`
 *    trace event, so a canvas-based anti-VM probe is visible in the report.
 *  - Guest-visible functions are created through `bridge.fn`, so `toString()`
 *    reports `[native code]` and no host frame ever appears in a stack.
 *
 * Bridge integration hooks:
 *  - reads `bridge.elementFactories` (`Map<string, Function>`) and registers the
 *    `canvas`, `img`, `audio` and `video` factories used by `document.createElement`;
 *  - publishes the same map as `bridge.canvasFactories`;
 *  - publishes `bridge.fontMetrics` (`Map<family, metric>`) so any other module
 *    measures text with the same per-font advance the canvas uses;
 *  - installs `document.fonts` immediately when `bridge.global.document` exists,
 *    otherwise queues the work through `bridge.deferUntilDocument(task)`.
 */

export const meta = { id: 'canvas', order: 105, requires: ['globals'] }

/** CSS default size of a `canvas` element. */
const DEFAULT_CANVAS_WIDTH = 300
const DEFAULT_CANVAS_HEIGHT = 150
/** Largest dimension a canvas may be resized to. */
const MAX_CANVAS_DIMENSION = 32767
/** Drawing operations retained for the digest and the report. */
const OP_LOG_LIMIT = 256
const OP_TEXT_LIMIT = 64
/** `getImageData` refuses allocations larger than a browser-style guard. */
const MAX_IMAGE_DATA_BYTES = 4 * 1024 * 1024
const DEFAULT_FONT = '10px sans-serif'

/** PNG magic bytes; the base64 of this prefix is `iVBORw0KGgo`. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC-32 table for PNG chunk checksums (polynomial 0xEDB88320). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * PNG signature plus a real IHDR chunk for the canvas dimensions.
 *
 * The header is what makes the data URL start with the canonical
 * `iVBORw0KGgo` prefix and lets a sample that parses the image learn the
 * dimensions it asked for; the pixel payload that follows is synthetic.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} 33 bytes: 8 signature + 25 IHDR
 */
function pngHeader(width, height) {
  const chunk = Buffer.alloc(25)
  chunk.writeUInt32BE(13, 0)
  chunk.write('IHDR', 4, 'latin1')
  chunk.writeUInt32BE(Math.max(1, Math.trunc(width)) >>> 0, 8)
  chunk.writeUInt32BE(Math.max(1, Math.trunc(height)) >>> 0, 12)
  chunk[16] = 8 // bit depth
  chunk[17] = 6 // colour type: truecolour with alpha
  chunk[18] = 0 // compression: deflate
  chunk[19] = 0 // filter: adaptive
  chunk[20] = 0 // interlace: none
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 21)), 21)
  return Buffer.concat([PNG_SIGNATURE, chunk])
}

/** CSS absolute length units, expressed in CSS pixels. */
const CSS_UNIT_PX = Object.freeze({
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  em: 16,
  rem: 16,
  '%': 16,
})

const METHOD_FLAGS = Object.freeze({ enumerable: true, configurable: true, writable: true })
const CONSTRUCTOR_FLAGS = Object.freeze({ enumerable: false, configurable: true, writable: true })

/** WebGL enum table. Only the values a fingerprint probe can observe. */
const GL = Object.freeze({
  DEPTH_BUFFER_BIT: 0x00000100,
  STENCIL_BUFFER_BIT: 0x00000400,
  COLOR_BUFFER_BIT: 0x00004000,
  POINTS: 0x0000,
  LINES: 0x0001,
  LINE_LOOP: 0x0002,
  LINE_STRIP: 0x0003,
  TRIANGLES: 0x0004,
  TRIANGLE_STRIP: 0x0005,
  TRIANGLE_FAN: 0x0006,
  ZERO: 0,
  ONE: 1,
  SRC_COLOR: 0x0300,
  ONE_MINUS_SRC_COLOR: 0x0301,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  DST_ALPHA: 0x0304,
  ONE_MINUS_DST_ALPHA: 0x0305,
  DST_COLOR: 0x0306,
  ONE_MINUS_DST_COLOR: 0x0307,
  SRC_ALPHA_SATURATE: 0x0308,
  FUNC_ADD: 0x8006,
  FUNC_SUBTRACT: 0x800a,
  FUNC_REVERSE_SUBTRACT: 0x800b,
  BLEND_EQUATION: 0x8009,
  BLEND_EQUATION_RGB: 0x8009,
  BLEND_EQUATION_ALPHA: 0x883d,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_ALPHA: 0x80ca,
  BLEND_SRC_ALPHA: 0x80cb,
  BLEND_COLOR: 0x8005,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  ARRAY_BUFFER_BINDING: 0x8894,
  ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  STREAM_DRAW: 0x88e0,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  BUFFER_SIZE: 0x8764,
  BUFFER_USAGE: 0x8765,
  CURRENT_VERTEX_ATTRIB: 0x8626,
  FRONT: 0x0404,
  BACK: 0x0405,
  FRONT_AND_BACK: 0x0408,
  CULL_FACE: 0x0b44,
  BLEND: 0x0be2,
  DITHER: 0x0bd0,
  STENCIL_TEST: 0x0b90,
  DEPTH_TEST: 0x0b71,
  SCISSOR_TEST: 0x0c11,
  POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  SAMPLE_COVERAGE: 0x80a0,
  NO_ERROR: 0,
  INVALID_ENUM: 0x0500,
  INVALID_VALUE: 0x0501,
  INVALID_OPERATION: 0x0502,
  OUT_OF_MEMORY: 0x0505,
  CW: 0x0900,
  CCW: 0x0901,
  LINE_WIDTH: 0x0b21,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  TEXTURE_2D: 0x0de1,
  TEXTURE_3D: 0x806f,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE0: 0x84c0,
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  RGBA: 0x1908,
  RGB: 0x1907,
  ALPHA: 0x1906,
  LUMINANCE: 0x1909,
  DEPTH_COMPONENT: 0x1902,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  HIGH_FLOAT: 0x8df2,
  MEDIUM_FLOAT: 0x8df1,
  LOW_FLOAT: 0x8df0,
  HIGH_INT: 0x8df5,
  MEDIUM_INT: 0x8df4,
  LOW_INT: 0x8df3,
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  VERSION: 0x1f02,
  EXTENSIONS: 0x1f03,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_COMBINED_UNIFORM_BLOCKS: 0x8a2e,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f,
  MAX_SAMPLES: 0x8d57,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_ELEMENT_INDEX: 0x8d6b,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
  RED_BITS: 0x0d52,
  GREEN_BITS: 0x0d53,
  BLUE_BITS: 0x0d54,
  ALPHA_BITS: 0x0d55,
  DEPTH_BITS: 0x0d56,
  STENCIL_BITS: 0x0d57,
  SUBPIXEL_BITS: 0x0d50,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  RGBA8: 0x8058,
  RGBA4: 0x8056,
  RGB5_A1: 0x8057,
  VERTEX_ARRAY_BINDING: 0x85b5,
  SCISSOR_BOX: 0x0c10,
  VIEWPORT: 0x0ba2,
  RASTERIZER_DISCARD: 0x8c89,
  READ_BUFFER: 0x0c02,
  DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER: 0x8ca8,
})

/** Parameter values that are not profile-derived but must stay plausible. */
const WEBGL_PARAMETER_DEFAULTS = Object.freeze({
  [GL.MAX_VERTEX_ATTRIBS]: 16,
  [GL.MAX_VARYING_VECTORS]: 30,
  [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 32,
  [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 16,
  [GL.MAX_TEXTURE_IMAGE_UNITS]: 16,
  [GL.MAX_FRAGMENT_UNIFORM_VECTORS]: 1024,
  [GL.MAX_VERTEX_UNIFORM_VECTORS]: 4096,
  [GL.MAX_CUBE_MAP_TEXTURE_SIZE]: 16384,
  [GL.MAX_COMBINED_UNIFORM_BLOCKS]: 24,
  [GL.MAX_UNIFORM_BUFFER_BINDINGS]: 24,
  [GL.MAX_SAMPLES]: 4,
  [GL.MAX_3D_TEXTURE_SIZE]: 2048,
  [GL.MAX_ARRAY_TEXTURE_LAYERS]: 2048,
  [GL.MAX_DRAW_BUFFERS]: 8,
  [GL.MAX_COLOR_ATTACHMENTS]: 8,
  [GL.MAX_ELEMENT_INDEX]: 4294967294,
  [GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT]: 16,
  [GL.RED_BITS]: 8,
  [GL.GREEN_BITS]: 8,
  [GL.BLUE_BITS]: 8,
  [GL.ALPHA_BITS]: 8,
  [GL.DEPTH_BITS]: 24,
  [GL.STENCIL_BITS]: 0,
  [GL.SUBPIXEL_BITS]: 4,
})

/** Extensions Chromium reports for a WebGL 1 context (alphabetical, like Chrome). */
const CHROMIUM_WEBGL_EXTENSIONS = Object.freeze([
  'ANGLE_instanced_arrays',
  'EXT_blend_minmax',
  'EXT_clip_control',
  'EXT_color_buffer_half_float',
  'EXT_depth_clamp',
  'EXT_disjoint_timer_query',
  'EXT_float_blend',
  'EXT_frag_depth',
  'EXT_polygon_offset_clamp',
  'EXT_shader_texture_lod',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'EXT_texture_mirror_clamp_to_edge',
  'EXT_sRGB',
  'KHR_parallel_shader_compile',
  'OES_element_index_uint',
  'OES_fbo_render_sample',
  'OES_standard_derivatives',
  'OES_texture_float',
  'OES_texture_float_linear',
  'OES_texture_half_float',
  'OES_texture_half_float_linear',
  'OES_vertex_array_object',
  'WEBGL_blend_func_extended',
  'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_depth_texture',
  'WEBGL_draw_buffers',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
  'WEBGL_polygon_mode',
  'WEBGL_provoking_vertex',
])

/** Extensions a Gecko profile reports instead. */
const GECKO_WEBGL_EXTENSIONS = Object.freeze([
  'EXT_blend_minmax',
  'EXT_color_buffer_half_float',
  'EXT_disjoint_timer_query',
  'EXT_float_blend',
  'EXT_frag_depth',
  'EXT_shader_texture_lod',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'EXT_sRGB',
  'MOZ_debug',
  'OES_element_index_uint',
  'OES_fbo_render_sample',
  'OES_standard_derivatives',
  'OES_texture_float',
  'OES_texture_float_linear',
  'OES_texture_half_float',
  'OES_texture_half_float_linear',
  'OES_vertex_array_object',
  'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_depth_texture',
  'WEBGL_draw_buffers',
  'WEBGL_lose_context',
])

/** WebGL 2 only extensions (Chromium). */
const CHROMIUM_WEBGL2_ONLY_EXTENSIONS = Object.freeze([
  'EXT_color_buffer_float',
  'EXT_conservative_depth',
  'EXT_render_snorm',
  'EXT_texture_norm16',
  'NV_shader_noperspective_interpolation',
  'OES_draw_buffers_indexed',
  'OVR_multiview2',
  'WEBGL_clip_cull_distance',
  'WEBGL_multi_draw_instanced_base_vertex_base_instance',
  'WEBGL_render_shared_exponent',
  'WEBGL_stencil_texturing',
])

/** Non-parameter WebGL methods and their guest-visible arity. */
const WEBGL_SIMPLE_METHODS = Object.freeze({
  shaderSource: 2,
  compileShader: 1,
  attachShader: 2,
  detachShader: 2,
  linkProgram: 1,
  useProgram: 1,
  deleteShader: 1,
  deleteProgram: 1,
  bindBuffer: 2,
  bufferData: 3,
  bufferSubData: 3,
  deleteBuffer: 1,
  bindTexture: 2,
  texImage2D: 6,
  texSubImage2D: 7,
  texParameteri: 3,
  texParameterf: 3,
  generateMipmap: 1,
  activeTexture: 1,
  deleteTexture: 1,
  bindFramebuffer: 2,
  framebufferTexture2D: 5,
  framebufferRenderbuffer: 4,
  bindRenderbuffer: 2,
  renderbufferStorage: 4,
  deleteFramebuffer: 1,
  deleteRenderbuffer: 1,
  bindVertexArray: 1,
  deleteVertexArray: 1,
  enableVertexAttribArray: 1,
  disableVertexAttribArray: 1,
  vertexAttribPointer: 6,
  uniform1f: 2,
  uniform1i: 2,
  uniform2f: 3,
  uniform3f: 4,
  uniform4f: 5,
  uniform1fv: 2,
  uniform4fv: 2,
  uniformMatrix4fv: 3,
  drawArrays: 3,
  drawElements: 4,
  drawArraysInstanced: 4,
  drawElementsInstanced: 5,
  enable: 1,
  disable: 1,
  blendFunc: 2,
  blendFuncSeparate: 4,
  depthFunc: 1,
  depthMask: 1,
  colorMask: 4,
  cullFace: 1,
  frontFace: 1,
  lineWidth: 1,
  pixelStorei: 2,
  polygonOffset: 2,
  scissor: 4,
  viewport: 4,
  clear: 1,
  clearColor: 4,
  clearDepth: 1,
  clearStencil: 1,
  flush: 0,
  finish: 0,
  validateProgram: 1,
  bindAttribLocation: 3,
})

/** 2D path/drawing operations that only need to be recorded. */
const SIMPLE_2D_OPS = Object.freeze({
  fillRect: 4,
  strokeRect: 4,
  clearRect: 4,
  beginPath: 0,
  closePath: 0,
  moveTo: 2,
  lineTo: 2,
  bezierCurveTo: 6,
  quadraticCurveTo: 4,
  rect: 4,
  arc: 5,
  arcTo: 5,
  ellipse: 7,
  fill: 0,
  stroke: 0,
  clip: 0,
  translate: 2,
  rotate: 1,
  scale: 2,
  transform: 6,
  setTransform: 6,
  resetTransform: 0,
})

/** Mutable 2D context state; `save()`/`restore()` snapshot exactly these. */
const CONTEXT_2D_STATE = Object.freeze({
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 10,
  lineDashOffset: 0,
  font: DEFAULT_FONT,
  textAlign: 'start',
  textBaseline: 'alphabetic',
  direction: 'ltr',
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
  filter: 'none',
})

/** Fixed metrics for the generic families every platform resolves. */
const GENERIC_FONT_METRICS = Object.freeze({
  'sans-serif': { charRatio: 0.5, ascentRatio: 0.8, descentRatio: 0.2 },
  serif: { charRatio: 0.5, ascentRatio: 0.78, descentRatio: 0.22 },
  monospace: { charRatio: 0.6, ascentRatio: 0.8, descentRatio: 0.2 },
  'system-ui': { charRatio: 0.5, ascentRatio: 0.8, descentRatio: 0.2 },
  cursive: { charRatio: 0.48, ascentRatio: 0.78, descentRatio: 0.24 },
  fantasy: { charRatio: 0.52, ascentRatio: 0.8, descentRatio: 0.22 },
})

/** @param {number} value */
function round3(value) {
  return Math.round(Number(value) * 1000) / 1000
}

/** @param {string} value @param {number} [limit] */
function truncate(value, limit = OP_TEXT_LIMIT) {
  const text = String(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * CSS property name to the camel-case IDL attribute `style` exposes.
 * @param {string} name e.g. `background-color`
 * @returns {string} e.g. `backgroundColor`
 */
function camelCase(name) {
  return String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Deterministic pixel payload for a synthetic image.
 *
 * The length is derived from the digest (64..256 bytes) so two different
 * profiles never share a payload length by accident, and the digest bytes are
 * mixed in so any change in dimensions, operations or profile seed changes
 * every byte of the payload.
 *
 * @param {string[]} keyParts digest inputs, in a fixed order
 * @returns {Buffer} payload without a container signature
 */
function deterministicPayload(keyParts) {
  const digest = createHash('sha256').update(keyParts.join('\u0000')).digest()
  const size = 64 + (digest[1] % 193)
  const rng = createSeededRandom(digest.toString('hex'))
  const payload = Buffer.from(rng.bytes(size))
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (payload[index] ^ digest[index % digest.length]) & 0xff
  }
  return payload
}

/**
 * `ImageData.data` for `getImageData`: opaque RGBA noise derived from the
 * profile's canvas noise and the requested rectangle (the classic pixel-read
 * fingerprint vector).
 *
 * @param {{seed: string, noise: string, x: number, y: number, width: number, height: number}} request
 * @returns {Uint8ClampedArray}
 */
function imageDataBytes(request) {
  const rng = createSeededRandom(
    `${request.seed}::${request.noise}::image:${request.x},${request.y}:${request.width}x${request.height}`,
  )
  const data = new Uint8ClampedArray(request.width * request.height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.floor(rng.next() * 256)
    data[index + 1] = Math.floor(rng.next() * 256)
    data[index + 2] = Math.floor(rng.next() * 256)
    data[index + 3] = 255
  }
  return data
}

/**
 * Samples for one channel of an `AudioBuffer`, rounded so a value survives a
 * JSON round-trip unchanged (traces must be reproducible).
 *
 * @param {string} noise profile audio noise
 * @param {number} channel
 * @param {number} length
 * @returns {Float32Array}
 */
function audioChannelSamples(noise, channel, length) {
  const rng = createSeededRandom(`${noise}::channel:${channel}:${length}`)
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    samples[index] = round3(rng.next() * 2 - 1)
  }
  return samples
}

/**
 * Frequency-bin value for `AnalyserNode.getFloatFrequencyData`, in dBFS.
 * A real analyser reports a decaying spectrum around -100..-30 dB; the
 * fingerprint is the exact sequence, which here is a pure function of the
 * profile.
 *
 * @param {string} noise
 * @param {number} binCount
 * @param {number} index
 * @returns {number}
 */
function analyserBin(noise, binCount, index) {
  const rng = createSeededRandom(`${noise}::analyser:${binCount}:${index}`)
  return round3(-(60 + rng.next() * 40))
}

/**
 * Per-family advance/ascent ratios. Real font outlines are unknowable on the
 * host; what matters is that the metrics are stable for a profile, consistent
 * between `document.fonts` and `measureText`, and plausible.
 *
 * @param {string} seed
 * @param {string} family lower-case family name
 * @returns {{charRatio: number, ascentRatio: number, descentRatio: number}}
 */
function createFontMetric(seed, family) {
  const generic = GENERIC_FONT_METRICS[family]
  if (generic) return { ...generic }
  const rng = createSeededRandom(`${seed}::font:${family}`)
  return {
    charRatio: round3(0.46 + rng.next() * 0.16),
    ascentRatio: round3(0.74 + rng.next() * 0.1),
    descentRatio: round3(0.18 + rng.next() * 0.06),
  }
}

/**
 * Split a CSS font shorthand into the parts canvas needs.
 * @param {string} font e.g. `bold 12px "Segoe UI", Arial`
 * @returns {{size: number, family: string}}
 */
function parseFont(font) {
  const text = String(font ?? DEFAULT_FONT)
  const match = /(\d*\.?\d+)(px|pt|pc|in|cm|mm|em|rem|%)\s+(.+)/.exec(text)
  if (!match) return { size: 10, family: 'sans-serif' }
  const size = Number.parseFloat(match[1]) * (CSS_UNIT_PX[match[2]] ?? 1)
  const first = match[3].split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase()
  return { size: size > 0 ? size : 10, family: first || 'sans-serif' }
}

/**
 * Deterministic advance width. Every code point advances by a positive amount,
 * so width strictly grows with text length (a property fingerprint scripts
 * assert).
 *
 * @param {{size: number, charRatio: number}} metric
 * @param {string} text
 * @param {string} seed profile seed, so glyph weights vary per profile
 * @returns {number}
 */
function measureWidth(metric, text, seed) {
  let total = 0
  for (const char of String(text ?? '')) {
    const weight = 0.55 + (hashSeed(`${seed}::glyph:${char}`) % 451) / 1000
    total += metric.size * metric.charRatio * weight
  }
  return round3(total)
}

/** @param {object} bridge */
export function install(bridge) {
  const { ctx, profile, clock } = bridge
  const profileSeed = String(profile.seed ?? '')
  const canvasNoise = String(profile.canvas?.noise ?? profileSeed)
  const canvasSeed = String(profile.canvas?.seed ?? profileSeed)
  const audioNoise = String(profile.audio?.fingerprintNoise ?? profileSeed)
  const webgl = profile.webgl

  /** @type {Map<number, object>} per-object state, keyed by the hidden id on each guest object */
  const instances = new Map()
  let nextStateId = 1
  /** @type {Map<string, {charRatio: number, ascentRatio: number, descentRatio: number}>} */
  const fontMetrics = new Map()
  bridge.fontMetrics = fontMetrics

  /** Register a handle for teardown and return it. */
  const retain = (handle) => {
    bridge.onDispose(() => {
      try {
        handle.dispose()
      } catch {
        /* the guest may already have released it */
      }
    })
    return handle
  }

  const guestFunction = (source, label) => {
    const result = ctx.evalCode(source, 'ai4r-internal:platform')
    if (result.error) {
      const dumped = bridge.fromGuest(result.error)
      result.error.dispose()
      throw new Error(`canvas: ${label} helper failed to compile: ${dumped?.message ?? dumped}`)
    }
    return result.value
  }

  const helpers = {
    create: retain(guestFunction('(function(proto){ return Object.create(proto) })', 'create')),
    construct: retain(guestFunction('(function(target, args){ return new target(...args) })', 'construct')),
    toStringTag: retain(
      guestFunction(
        '(function(target, tag){ Object.defineProperty(target, Symbol.toStringTag, { value: tag, configurable: true }) })',
        'toStringTag',
      ),
    ),
    defineAccessor: retain(
      guestFunction(
        '(function(target, key, get, set){ Object.defineProperty(target, key, { get: get, set: set, enumerable: true, configurable: true }) })',
        'defineAccessor',
      ),
    ),
    Uint8ClampedArray: retain(
      guestFunction('(function(buffer){ return new Uint8ClampedArray(buffer) })', 'Uint8ClampedArray'),
    ),
    Float32Array: retain(guestFunction('(function(buffer){ return new Float32Array(buffer) })', 'Float32Array')),
    Int32Array: retain(guestFunction('(function(buffer){ return new Int32Array(buffer) })', 'Int32Array')),
    iterate: retain(guestFunction('(function(values){ return values[Symbol.iterator]() })', 'iterate')),
    equals: retain(guestFunction('(function(left, right){ return left === right })', 'equals')),
  }

  /** Hidden keys: object state and the per-canvas rendering contexts. */
  // Registered ai4r.* symbols are hidden by the anti-fingerprint filter, so
  // instances keep zero observable own symbols like real platform objects.
  const STATE_KEY = retain(ctx.newSymbolFor('ai4r.canvas.state'))
  const CONTEXT_2D_KEY = retain(ctx.newSymbolFor('ai4r.canvas.context2d'))
  const CONTEXT_WEBGL_KEY = retain(ctx.newSymbolFor('ai4r.canvas.contextwebgl'))
  const CONTEXT_WEBGL2_KEY = retain(ctx.newSymbolFor('ai4r.canvas.contextwebgl2'))
  const ITERATOR_KEY = retain(ctx.unwrapResult(ctx.evalCode('Symbol.iterator')))

  const invoke = (helper, args = []) => {
    const result = ctx.callFunction(helper, ctx.undefined, args)
    if (result.error) {
      const dumped = bridge.fromGuest(result.error)
      result.error.dispose()
      throw new TypeError(dumped?.message ?? 'platform helper failed')
    }
    return result.value
  }

  /** Guest `===` on two handles, used to match listeners by identity. */
  const guestEquals = (left, right) => {
    const result = invoke(helpers.equals, [left, right])
    const equal = ctx.typeof(result) === 'boolean' ? ctx.dump(result) : false
    result.dispose()
    return equal
  }

  const illegalInvocation = () => new TypeError('Illegal invocation')

  const notSupported = (message) => {
    const error = new Error(message)
    error.name = 'NotSupportedError'
    return error
  }

  /**
   * Resolve the host-side state of a guest object through its hidden id.
   * @param {object} thisHandle
   * @param {string} [group] required state group
   */
  const stateFor = (thisHandle, group) => {
    if (!thisHandle || ctx.typeof(thisHandle) !== 'object') throw illegalInvocation()
    const idValue = ctx.getProp(thisHandle, STATE_KEY)
    const id = ctx.typeof(idValue) === 'number' ? ctx.getNumber(idValue) : 0
    idValue.dispose()
    const state = instances.get(id)
    if (!state || (group && state.group !== group)) throw illegalInvocation()
    return state
  }

  const attachState = (targetHandle, state) => {
    instances.set(state.id, state)
    const idValue = ctx.newNumber(state.id)
    ctx.setProp(targetHandle, STATE_KEY, idValue)
    idValue.dispose()
    return targetHandle
  }

  /** Write a plain JS value (recursively) onto a guest object, freeing temporaries. */
  const writeValue = (target, key, value) => {
    if (value === null) {
      ctx.setProp(target, key, ctx.null)
      return
    }
    if (value === undefined) return
    if (typeof value === 'boolean') {
      ctx.setProp(target, key, value ? ctx.true : ctx.false)
      return
    }
    if (isHandle(value)) {
      ctx.setProp(target, key, value)
      return
    }
    let handle
    if (typeof value === 'number') handle = ctx.newNumber(value)
    else if (typeof value === 'string') handle = ctx.newString(value)
    else if (Array.isArray(value)) {
      handle = ctx.newArray()
      value.forEach((item, index) => writeValue(handle, index, item))
    } else if (typeof value === 'object') handle = plainObject(value)
    else return
    ctx.setProp(target, key, handle)
    handle.dispose()
  }

  /** Create a guest object from a plain JS record. */
  const plainObject = (values) => {
    const object = ctx.newObject()
    for (const [key, value] of Object.entries(values ?? {})) writeValue(object, key, value)
    return object
  }

  /** `Object.create(Constructor.prototype)`; no constructor call, so `instanceof` holds. */
  const createInstance = (ctorHandle) => {
    const proto = ctx.getProp(ctorHandle, 'prototype')
    const instance = invoke(helpers.create, [proto])
    proto.dispose()
    return instance
  }

  /**
   * `new Constructor(...values)`.
   *
   * Values may be guest handles (owned by the caller, e.g. the options object
   * `document.createElement` passes to an element factory), primitives or plain
   * records.
   */
  const construct = (ctorHandle, values = []) => {
    const args = ctx.newArray()
    const temporaries = [args]
    values.forEach((value, index) => {
      if (isHandle(value)) {
        ctx.setProp(args, index, value)
        return
      }
      if (value === undefined || value === null || typeof value === 'boolean') {
        const borrowed = value === undefined ? ctx.undefined : value === null ? ctx.null : value ? ctx.true : ctx.false
        ctx.setProp(args, index, borrowed)
        return
      }
      const handle =
        typeof value === 'object'
          ? plainObject(value)
          : typeof value === 'string'
            ? ctx.newString(value)
            : typeof value === 'number'
              ? ctx.newNumber(value)
              : ctx.undefined
      temporaries.push(handle)
      ctx.setProp(args, index, handle)
    })
    const instance = invoke(helpers.construct, [ctorHandle, args])
    for (const handle of temporaries) handle.dispose()
    return instance
  }

  /** Guest typed array from a list of numbers. */
  const typedArray = (kind, numbers) => {
    const buffer =
      kind === 'float32'
        ? new Float32Array(numbers).buffer
        : kind === 'uint8clamped'
          ? new Uint8ClampedArray(numbers).buffer
          : new Int32Array(numbers).buffer
    const helper =
      kind === 'float32' ? helpers.Float32Array : kind === 'uint8clamped' ? helpers.Uint8ClampedArray : helpers.Int32Array
    const bufferHandle = ctx.newArrayBuffer(buffer)
    const view = invoke(helper, [bufferHandle])
    bufferHandle.dispose()
    return view
  }

  const readNumber = (handle, key, fallback) => {
    if (!handle || ctx.typeof(handle) !== 'object') return fallback
    const value = ctx.getProp(handle, key)
    const out = ctx.typeof(value) === 'number' ? ctx.getNumber(value) : fallback
    value.dispose()
    return out
  }

  const readString = (handle, key, fallback) => {
    if (!handle || ctx.typeof(handle) !== 'object') return fallback
    const value = ctx.getProp(handle, key)
    const out = ctx.typeof(value) === 'string' ? ctx.getString(value) : fallback
    value.dispose()
    return out
  }

  const lengthOf = (handle) => readNumber(handle, 'length', 0)

  /** Run a callback later on the virtual clock (never on the host clock). */
  const schedule = (delay, task) => {
    if (clock?.schedule) return clock.schedule({ delay, fn: task })
    task()
    return null
  }

  /** Resolve a guest promise on a later turn of the virtual clock. */
  const deferredAfter = (delay, produce) => {
    const deferred = bridge.deferred()
    schedule(delay, () => {
      let handle = null
      try {
        handle = bridge.toGuest(produce())
        deferred.resolve(handle)
      } catch (error) {
        deferred.reject(Object.assign(new Error(error?.message ?? String(error)), { name: error?.name ?? 'Error' }))
      } finally {
        if (isHandle(handle)) handle.dispose()
      }
    })
    return deferred.handle
  }

  // ---- font metrics ------------------------------------------------------
  for (const family of [...profile.fonts, ...Object.keys(GENERIC_FONT_METRICS)]) {
    const key = String(family).toLowerCase()
    if (!fontMetrics.has(key)) fontMetrics.set(key, createFontMetric(profileSeed, key))
  }

  /** Metric for a CSS font shorthand, registering unknown families on demand. */
  const metricFor = (font) => {
    const parsed = parseFont(font)
    let metric = fontMetrics.get(parsed.family)
    if (!metric) {
      metric = createFontMetric(profileSeed, parsed.family)
      fontMetrics.set(parsed.family, metric)
    }
    return { source: parsed, metric }
  }

  // ---- class helpers -----------------------------------------------------
  /**
   * Convert a host primitive into a guest handle.
   *
   * `bridge.fn` tracks converted primitives in the call bag and disposes the bag
   * once the host implementation returns, so an implementation must hand back a
   * *handle* for numbers and strings; returning the raw value would make it dead
   * on arrival.
   *
   * @param {unknown} value
   * @returns {unknown} handle, or the untouched value for handles/booleans/null
   */
  const guestValue = (value) => {
    if (isHandle(value) || value === undefined || value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return ctx.newNumber(value)
    if (typeof value === 'string') return ctx.newString(value)
    return value
  }

  /** Wrap a method implementation so it receives the state of its `this`. */
  const wrapMethod = (group, definition) => (call) =>
    guestValue(definition.run(stateFor(call.thisHandle, group), call))

  /**
   * Create native-looking guest function handles for a method table.
   * @param {string} group required state group
   * @param {object} methods `{name: {length, run(state, call)}}`
   * @returns {Record<string, object>} handles, owned by the bridge
   */
  function buildMethodHandles(group, methods) {
    const handles = {}
    for (const [name, definition] of Object.entries(methods)) {
      handles[name] = bridge.fn(name, definition.length ?? 0, wrapMethod(group, definition))
    }
    return handles
  }

  function defineAccessor(target, key, group, definition) {
    const getter = definition.get
      ? bridge.fn(`get ${key}`, 0, (call) => guestValue(definition.get(stateFor(call.thisHandle, group), call)))
      : ctx.undefined
    const setter = definition.set
      ? bridge.fn(`set ${key}`, 1, (call) => definition.set(stateFor(call.thisHandle, group), call))
      : ctx.undefined
    const keyHandle = ctx.newString(key)
    const result = ctx.callFunction(helpers.defineAccessor, ctx.undefined, [target, keyHandle, getter, setter])
    keyHandle.dispose()
    if (result.error) {
      const dumped = bridge.fromGuest(result.error)
      result.error.dispose()
      throw new Error(`canvas: accessor ${key} failed: ${dumped?.message ?? dumped}`)
    }
    result.value.dispose()
  }

  /**
   * Build a native-looking platform class: constructor on the global, prototype
   * with `Symbol.toStringTag`, data properties, methods and accessors.
   *
   * @param {object} spec
   * @param {string} spec.name
   * @param {number} [spec.arity] guest-visible `length` (required argument count)
   * @param {number} [spec.accepts] arguments forwarded to `init` (optional args)
   * @param {object} [spec.init] host init handle called from the constructor body
   * @param {string} [spec.group] state group required by every member
   * @param {boolean} [spec.illegalConstructor] direct `new` throws, like WebIDL
   * @param {object} [spec.properties] read-only data properties on the prototype
   * @param {object} [spec.methods] method table, built here
   * @param {object} [spec.methodHandles] pre-built handles (shared prototypes)
   * @param {object} [spec.accessors]
   * @returns {object} constructor handle
   */
  function defineClass(spec) {
    const {
      name,
      arity = 0,
      accepts = arity,
      init = null,
      group = '',
      illegalConstructor = false,
      properties = {},
      methods = {},
      accessors = {},
      methodHandles = null,
      bindings = {},
    } = spec
    const forwarded = Array.from({ length: accepts }, (_, index) => `arguments[${index}]`)
    let body
    if (illegalConstructor) {
      body = `throw new TypeError('Illegal constructor')`
    } else {
      if (init) bindings.__init = init
      body = `if (!(this instanceof ${name})) { throw new TypeError('Illegal constructor') }`
      if (init) body += `\n__init(self${forwarded.map((argument) => `, ${argument}`).join('')});`
    }
    const ctor = bridge.nativeConstructor({ name, arity, bindings, body })
    const proto = ctx.getProp(ctor, 'prototype')
    const tagValue = ctx.newString(name)
    const tagged = ctx.callFunction(helpers.toStringTag, ctx.undefined, [proto, tagValue])
    tagValue.dispose()
    if (tagged.error) tagged.error.dispose()
    else tagged.value.dispose()
    for (const [key, value] of Object.entries(properties)) bridge.install(proto, key, value, METHOD_FLAGS)
    for (const [key, handle] of Object.entries(methodHandles ?? buildMethodHandles(group, methods))) {
      bridge.install(proto, key, handle, METHOD_FLAGS)
    }
    for (const [key, definition] of Object.entries(accessors)) defineAccessor(proto, key, group, definition)
    proto.dispose()
    return ctor
  }

  // ---- event targets -----------------------------------------------------
  const createEvent = (type, targetHandle, detail) => {
    const event = plainObject({ type, bubbles: false, cancelable: true, defaultPrevented: false, timeStamp: 0, ...detail })
    bridge.install(event, 'preventDefault', bridge.fn('preventDefault', 0, ({ thisHandle }) => {
      ctx.setProp(thisHandle, 'defaultPrevented', ctx.true)
      return ctx.undefined
    }), METHOD_FLAGS)
    bridge.install(event, 'stopPropagation', bridge.fn('stopPropagation', 0, () => ctx.undefined), METHOD_FLAGS)
    bridge.install(event, 'target', targetHandle, METHOD_FLAGS)
    bridge.install(event, 'currentTarget', targetHandle, METHOD_FLAGS)
    return event
  }

  /** Dispatch `type` to the listeners and the `on<type>` handler of an element. */
  const fireEvent = (state, targetHandle, type, detail = {}) => {
    const event = createEvent(type, targetHandle, detail)
    const dispatch = (callback) => {
      const result = ctx.callFunction(callback, targetHandle, [event])
      if (result.error) result.error.dispose()
      else result.value.dispose()
    }
    for (const callback of state.listeners?.get(type) ?? []) dispatch(callback)
    const handler = ctx.getProp(targetHandle, `on${type}`)
    if (ctx.typeof(handler) === 'function') dispatch(handler)
    handler.dispose()
    const prevented = bridge.get(event, 'defaultPrevented') === true
    event.dispose()
    return !prevented
  }

  const eventTargetMethods = {
    addEventListener: {
      length: 2,
      run: (state, call) => {
        const type = bridge.str(call.args, 0, '')
        const callback = call.args[1]
        if (!type || !callback || ctx.typeof(callback) !== 'function') return ctx.undefined
        if (!state.listeners) state.listeners = new Map()
        const list = state.listeners.get(type) ?? []
        list.push(callback.dup())
        state.listeners.set(type, list)
        return ctx.undefined
      },
    },
    removeEventListener: {
      length: 2,
      run: (state, call) => {
        const list = state.listeners?.get(bridge.str(call.args, 0, ''))
        const callback = call.args[1]
        if (!list || !callback || list.length === 0) return ctx.undefined
        for (let index = list.length - 1; index >= 0; index -= 1) {
          if (!guestEquals(list[index], callback)) continue
          list[index].dispose()
          list.splice(index, 1)
          break
        }
        return ctx.undefined
      },
    },
    dispatchEvent: {
      length: 1,
      run: (state, call) =>
        fireEvent(state, call.thisHandle, readString(call.args[0], 'type', ''), {}) ? ctx.true : ctx.false,
    },
  }

  /** `{ onload: null, onerror: null, ... }`: writable prototype slots, as elements expose. */
  const handlerProperties = (...types) => Object.fromEntries(types.map((type) => [`on${type}`, null]))

  // ---- 2D context --------------------------------------------------------
  const summarizeArg = (handle) => {
    if (!handle) return undefined
    const type = ctx.typeof(handle)
    if (type === 'number') return round3(ctx.getNumber(handle))
    if (type === 'string') return truncate(ctx.getString(handle))
    if (type === 'boolean') return ctx.dump(handle)
    if (type === 'undefined') return undefined
    return '[object]'
  }

  const summarizeStyle = (handle) => {
    if (!handle) return ''
    const type = ctx.typeof(handle)
    if (type === 'string') {
      const value = ctx.getString(handle)
      handle.dispose()
      return truncate(value)
    }
    handle.dispose()
    return '[object]'
  }

  /**
   * Record one drawing operation in the bounded op log and emit it as a `dom`
   * trace event. The op log is a digest input, so tracing never changes the
   * resulting image.
   *
   * @param {object} canvasState
   * @param {object} contextHandle
   * @param {string} name
   * @param {unknown[]} args plain, JSON-serializable arguments
   * @param {object} [extra]
   */
  const recordOp = (canvasState, contextHandle, name, args, extra = {}) => {
    const fillStyle = summarizeStyle(ctx.getProp(contextHandle, 'fillStyle'))
    const font = readString(contextHandle, 'font', DEFAULT_FONT)
    const entry = { op: name, args, fillStyle, font, ...extra }
    if (canvasState.ops.length < OP_LOG_LIMIT) canvasState.ops.push(entry)
    bridge.emit('dom', 'before', {
      api: `canvas.${name}`,
      op: name,
      args,
      fillStyle,
      font,
      stored: canvasState.ops.length < OP_LOG_LIMIT,
      ...extra,
    })
    return entry
  }

  const plainArgs = (call, count) => call.args.slice(0, count).map(summarizeArg)

  const argNumbers = (call, start, count) => {
    const values = []
    for (let index = start; index < start + count; index += 1) values.push(bridge.num(call.args, index, 0))
    return values
  }

  const snapshotContext = (contextHandle) => {
    const snapshot = {}
    for (const key of Object.keys(CONTEXT_2D_STATE)) {
      const value = ctx.getProp(contextHandle, key)
      snapshot[key] = bridge.fromGuest(value)
      value.dispose()
    }
    return snapshot
  }

  const context2dMethods = {}
  for (const [name, arity] of Object.entries(SIMPLE_2D_OPS)) {
    context2dMethods[name] = {
      length: arity,
      run: (state, call) => {
        recordOp(state.canvas, call.thisHandle, name, plainArgs(call, arity))
        return ctx.undefined
      },
    }
  }

  const recordTextOp = (state, call, name) => {
    recordOp(state.canvas, call.thisHandle, name, [
      truncate(bridge.str(call.args, 0, '')),
      round3(bridge.num(call.args, 1, 0)),
      round3(bridge.num(call.args, 2, 0)),
    ])
    return ctx.undefined
  }

  Object.assign(context2dMethods, {
    fillText: { length: 3, run: (state, call) => recordTextOp(state, call, 'fillText') },
    strokeText: { length: 3, run: (state, call) => recordTextOp(state, call, 'strokeText') },
    measureText: {
      length: 1,
      run: (state, call) => {
        const text = bridge.str(call.args, 0, '')
        const font = readString(call.thisHandle, 'font', DEFAULT_FONT)
        const { source, metric } = metricFor(font)
        const width = measureWidth({ size: source.size, charRatio: metric.charRatio }, text, profileSeed)
        const ascent = round3(source.size * metric.ascentRatio)
        const descent = round3(source.size * metric.descentRatio)
        bridge.emit('dom', 'before', { api: 'canvas.measureText', text: truncate(text), font, width })
        return plainObject({
          width,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: width,
          actualBoundingBoxAscent: text ? round3(Math.max(0, ascent - source.size * 0.04)) : 0,
          actualBoundingBoxDescent: text ? round3(Math.max(0, descent - source.size * 0.02)) : 0,
          fontBoundingBoxAscent: ascent,
          fontBoundingBoxDescent: descent,
        })
      },
    },
    drawImage: {
      length: 3,
      run: (state, call) => {
        const source = call.args[0]
        const sourceWidth = readNumber(source, 'width', readNumber(source, 'naturalWidth', 0))
        const sourceHeight = readNumber(source, 'height', readNumber(source, 'naturalHeight', 0))
        const coords = argNumbers(call, 1, Math.min(Math.max(call.args.length - 1, 0), 4))
        recordOp(state.canvas, call.thisHandle, 'drawImage', [sourceWidth, sourceHeight, ...coords.map(round3)], {
          sourceWidth,
          sourceHeight,
        })
        return ctx.undefined
      },
    },
    save: {
      length: 0,
      run: (state, call) => {
        recordOp(state.canvas, call.thisHandle, 'save', [])
        state.stack.push(snapshotContext(call.thisHandle))
        return ctx.undefined
      },
    },
    restore: {
      length: 0,
      run: (state, call) => {
        recordOp(state.canvas, call.thisHandle, 'restore', [])
        const snapshot = state.stack.pop()
        if (snapshot) for (const [key, value] of Object.entries(snapshot)) writeValue(call.thisHandle, key, value)
        return ctx.undefined
      },
    },
    getImageData: {
      length: 4,
      run: (state, call) => {
        const x = bridge.int(call.args, 0, 0)
        const y = bridge.int(call.args, 1, 0)
        const width = Math.max(0, bridge.int(call.args, 2, 0))
        const height = Math.max(0, bridge.int(call.args, 3, 0))
        if (width * height * 4 > MAX_IMAGE_DATA_BYTES) {
          throw new RangeError('The source width and height are too large for getImageData')
        }
        bridge.emit('dom', 'before', { api: 'canvas.getImageData', x, y, width, height })
        return createImageData({ seed: canvasSeed, noise: canvasNoise, x, y, width, height })
      },
    },
    putImageData: {
      length: 3,
      run: (state, call) => {
        const image = call.args[0]
        recordOp(state.canvas, call.thisHandle, 'putImageData', [
          readNumber(image, 'width', 0),
          readNumber(image, 'height', 0),
          bridge.int(call.args, 1, 0),
          bridge.int(call.args, 2, 0),
        ])
        return ctx.undefined
      },
    },
    createImageData: {
      length: 2,
      run: (state, call) => {
        const first = call.args[0]
        const isSource = first && ctx.typeof(first) === 'object'
        const width = isSource ? readNumber(first, 'width', 0) : bridge.int(call.args, 0, 0)
        const height = isSource ? readNumber(first, 'height', 0) : bridge.int(call.args, 1, 0)
        recordOp(state.canvas, call.thisHandle, 'createImageData', [width, height])
        return createImageData({ seed: canvasSeed, noise: canvasNoise, x: 0, y: 0, width, height })
      },
    },
    createLinearGradient: {
      length: 4,
      run: (state, call) => {
        const args = argNumbers(call, 0, 4).map(round3)
        recordOp(state.canvas, call.thisHandle, 'createLinearGradient', args)
        return createGradient('linear')
      },
    },
    createRadialGradient: {
      length: 6,
      run: (state, call) => {
        const args = argNumbers(call, 0, 6).map(round3)
        recordOp(state.canvas, call.thisHandle, 'createRadialGradient', args)
        return createGradient('radial')
      },
    },
    createConicGradient: {
      length: 3,
      run: (state, call) => {
        const args = argNumbers(call, 0, 3).map(round3)
        recordOp(state.canvas, call.thisHandle, 'createConicGradient', args)
        return createGradient('conic')
      },
    },
    createPattern: {
      length: 2,
      run: (state, call) => {
        recordOp(state.canvas, call.thisHandle, 'createPattern', [truncate(bridge.str(call.args, 1, 'repeat'))])
        const pattern = createInstance(CanvasPatternCtor)
        attachState(pattern, { id: nextStateId++, group: 'pattern' })
        return pattern
      },
    },
    getLineDash: {
      length: 0,
      run: () => {
        bridge.emit('dom', 'before', { api: 'canvas.getLineDash' })
        return ctx.newArray()
      },
    },
    setLineDash: {
      length: 1,
      run: (state, call) => {
        const segments = call.args[0] ? bridge.list(call.args[0], 32) : []
        recordOp(state.canvas, call.thisHandle, 'setLineDash', segments)
        return ctx.undefined
      },
    },
    getTransform: { length: 0, run: () => plainObject({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) },
  })

  const createImageData = (request) => {
    const data = imageDataBytes(request)
    const bufferHandle = ctx.newArrayBuffer(data.buffer)
    const view = invoke(helpers.Uint8ClampedArray, [bufferHandle])
    bufferHandle.dispose()
    const image = createInstance(ImageDataCtor)
    attachState(image, { id: nextStateId++, group: 'image-data', width: request.width, height: request.height, data })
    ctx.setProp(image, 'data', view)
    view.dispose()
    return image
  }

  const createGradient = (kind) => {
    const gradient = createInstance(CanvasGradientCtor)
    attachState(gradient, { id: nextStateId++, group: 'gradient', kind, stops: [] })
    return gradient
  }

  // ---- elements ----------------------------------------------------------
  const clampCanvasDimension = (value) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(MAX_CANVAS_DIMENSION, Math.trunc(value)))
  }

  const resetCanvas = (state) => {
    if (Array.isArray(state.ops)) state.ops.length = 0
  }

  const optionNumber = (options, key, fallback) => {
    if (!options) return fallback
    if (isHandle(options)) return readNumber(options, key, fallback)
    const value = Number(options[key])
    return Number.isFinite(value) ? value : fallback
  }

  /** Coerce a constructor argument to a byte-like dimension. */
  const numberOr = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  const optionString = (options, key, fallback) => {
    if (!options) return fallback
    if (isHandle(options)) return readString(options, key, fallback)
    return typeof options[key] === 'string' ? options[key] : fallback
  }

  // `style` is shared-prototype: one set of native methods for every element.
  const styleProto = retain(plainObject({ cssText: '', length: 0 }))
  bridge.install(styleProto, 'getPropertyValue', bridge.fn('getPropertyValue', 1, ({ args, thisHandle }) => {
    const name = camelCase(bridge.str(args, 0, ''))
    const value = ctx.getProp(thisHandle, name)
    const text = ctx.typeof(value) === 'string' ? ctx.getString(value) : ''
    value.dispose()
    return ctx.newString(text)
  }), METHOD_FLAGS)
  bridge.install(styleProto, 'setProperty', bridge.fn('setProperty', 2, ({ args, thisHandle }) => {
    writeValue(thisHandle, camelCase(bridge.str(args, 0, '')), bridge.str(args, 1, ''))
    return ctx.undefined
  }), METHOD_FLAGS)
  bridge.install(styleProto, 'removeProperty', bridge.fn('removeProperty', 1, ({ thisHandle }) => ctx.undefined), METHOD_FLAGS)

  const createStyle = () => invoke(helpers.create, [styleProto])

  /** Attach the `style`/`dataset` expandos every element carries. */
  const attachElementChrome = (elementHandle) => {
    const style = createStyle()
    ctx.setProp(elementHandle, 'style', style)
    style.dispose()
    const dataset = plainObject({})
    ctx.setProp(elementHandle, 'dataset', dataset)
    dataset.dispose()
  }

  const elementAccessors = {
    width: {
      get: (state) => state.width,
      set: (state, call) => {
        state.width = clampCanvasDimension(bridge.num(call.args, 0, 0))
        resetCanvas(state)
        return ctx.undefined
      },
    },
    height: {
      get: (state) => state.height,
      set: (state, call) => {
        state.height = clampCanvasDimension(bridge.num(call.args, 0, 0))
        resetCanvas(state)
        return ctx.undefined
      },
    },
  }

  const elementMethods = {
    getBoundingClientRect: {
      length: 0,
      run: (state) => {
        const { width, height } = state
        return plainObject({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height })
      },
    },
    ...eventTargetMethods,
  }

  const canvasElementAccessors = {
    ...elementAccessors,
    offsetWidth: { get: (state) => state.width },
    offsetHeight: { get: (state) => state.height },
    clientWidth: { get: (state) => state.width },
    clientHeight: { get: (state) => state.height },
  }

  /** Deterministic bytes backing `toDataURL`/`toBlob`. */
  const canvasBytes = (state, type) => {
    const payload = deterministicPayload([
      profileSeed,
      canvasSeed,
      canvasNoise,
      type,
      `${state.width}x${state.height}`,
      JSON.stringify(state.ops),
    ])
    return type === 'image/png' ? Buffer.concat([pngHeader(state.width, state.height), payload]) : payload
  }

  const canvasElementMethods = {
    ...elementMethods,
    getContext: { length: 1, run: (state, call) => getContext(state, call) },
    toDataURL: {
      length: 0,
      run: (state, call) => {
        const type = normalizeImageType(bridge.str(call.args, 0, 'image/png'))
        const bytes = canvasBytes(state, type)
        bridge.emit('dom', 'before', {
          api: 'canvas.toDataURL',
          type,
          width: state.width,
          height: state.height,
          bytes: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
          ops: state.ops.length,
        })
        return ctx.newString(`data:${type};base64,${bytes.toString('base64')}`)
      },
    },
    toBlob: {
      length: 3,
      run: (state, call) => {
        const callback = call.args[0]
        const type = normalizeImageType(bridge.str(call.args, 1, 'image/png'))
        const bytes = canvasBytes(state, type)
        bridge.emit('dom', 'before', {
          api: 'canvas.toBlob',
          type,
          width: state.width,
          height: state.height,
          bytes: bytes.length,
        })
        if (!callback || ctx.typeof(callback) !== 'function') return ctx.undefined
        const handler = callback.dup()
        schedule(1, () => {
          const blob = createBlob(bytes, type)
          const result = ctx.callFunction(handler, ctx.undefined, [blob])
          if (result.error) result.error.dispose()
          else result.value.dispose()
          blob.dispose()
          handler.dispose()
        })
        return ctx.undefined
      },
    },
    transferControlToOffscreen: {
      length: 0,
      run: () => {
        throw notSupported('transferControlToOffscreen is not available in this environment')
      },
    },
  }

  // ---- image data / gradient surface ------------------------------------
  const imageDataAccessors = {
    width: { get: (state) => state.width },
    height: { get: (state) => state.height },
  }

  const gradientMethods = {
    addColorStop: {
      length: 2,
      run: (state, call) => {
        const offset = bridge.num(call.args, 0, 0)
        if (!(offset >= 0 && offset <= 1)) {
          throw new Error("Failed to execute 'addColorStop': The provided value is outside the range [0.0, 1.0].")
        }
        state.stops.push({ offset: round3(offset), color: truncate(bridge.str(call.args, 1, '')) })
        return ctx.undefined
      },
    },
  }

  const patternMethods = { setTransform: { length: 1, run: () => ctx.undefined } }

  // ---- WebGL -------------------------------------------------------------
  const webglMethodSpecs = {}

  /**
   * Answer `getParameter` for the fingerprint-relevant enums.
   *
   * `VENDOR`/`RENDERER` and the `WEBGL_debug_renderer_info` enums all report the
   * profile GPU strings: the sandbox has no GPU, so a separate masked value
   * ("WebKit WebGL") would be a second source of truth able to drift from the
   * profile, and a mismatch between the two is itself a detection signal.
   */
  const webglParameter = (state, pname) => {
    switch (pname) {
      case GL.VENDOR:
        // Chrome masks these; the profile strings are only exposed through
        // WEBGL_debug_renderer_info. Equality of masked and unmasked renderer
        // is impossible in a real browser and therefore a detection signal.
        return 'WebKit'
      case GL.UNMASKED_VENDOR_WEBGL:
        return webgl.vendor
      case GL.RENDERER:
        return 'WebKit WebGL'
      case GL.UNMASKED_RENDERER_WEBGL:
        return webgl.renderer
      case GL.VERSION:
        return state.webgl2 ? webglVersion(webgl.version) : webgl.version
      case GL.SHADING_LANGUAGE_VERSION:
        return state.webgl2 ? shadingLanguageVersion(webgl.shadingLanguageVersion) : webgl.shadingLanguageVersion
      case GL.MAX_TEXTURE_SIZE:
        return webgl.maxTextureSize
      case GL.MAX_RENDERBUFFER_SIZE:
        return webgl.maxRenderbufferSize
      case GL.MAX_VIEWPORT_DIMS:
        return { kind: 'int32', values: [webgl.maxViewportDims[0], webgl.maxViewportDims[1]] }
      case GL.ALIASED_LINE_WIDTH_RANGE:
        return { kind: 'float32', values: [...webgl.aliasedLineWidthRange] }
      case GL.ALIASED_POINT_SIZE_RANGE:
        return { kind: 'float32', values: [...webgl.aliasedPointSizeRange] }
      case GL.VIEWPORT:
      case GL.SCISSOR_BOX:
        return { kind: 'int32', values: [...state.viewport] }
      case GL.EXTENSIONS:
        return null
      default:
        return WEBGL_PARAMETER_DEFAULTS[pname] ?? null
    }
  }

  const createOpaque = (group, values) => {
    const object = plainObject(values)
    attachState(object, { id: nextStateId++, group })
    return object
  }

  const fillWithZeros = (target) => {
    const count = lengthOf(target)
    if (ctx.typeof(target) !== 'object') return 0
    for (let index = 0; index < count; index += 1) {
      const value = ctx.newNumber(0)
      ctx.setProp(target, index, value)
      value.dispose()
    }
    return count
  }

  Object.assign(webglMethodSpecs, {
    getParameter: {
      length: 1,
      run: (state, call) => {
        const pname = bridge.int(call.args, 0, 0)
        const value = webglParameter(state, pname)
        bridge.emit('dom', 'before', {
          api: 'webgl.getParameter',
          pname,
          supported: value !== null,
          value: value && typeof value === 'object' ? `${value.kind}[${value.values.length}]` : value,
        })
        if (value && typeof value === 'object') return typedArray(value.kind, value.values)
        if (typeof value === 'string') return ctx.newString(value)
        if (typeof value === 'number') return ctx.newNumber(value)
        return ctx.null
      },
    },
    getExtension: {
      length: 1,
      run: (state, call) => {
        const name = bridge.str(call.args, 0, '')
        if (!state.extensions.includes(name)) return ctx.null
        bridge.emit('dom', 'before', { api: 'webgl.getExtension', name })
        if (name === 'WEBGL_debug_renderer_info') {
          return plainObject({
            UNMASKED_VENDOR_WEBGL: GL.UNMASKED_VENDOR_WEBGL,
            UNMASKED_RENDERER_WEBGL: GL.UNMASKED_RENDERER_WEBGL,
          })
        }
        if (name === 'EXT_texture_filter_anisotropic') {
          return plainObject({
            TEXTURE_MAX_ANISOTROPY_EXT: GL.TEXTURE_MAX_ANISOTROPY_EXT,
            MAX_TEXTURE_MAX_ANISOTROPY_EXT: GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
          })
        }
        if (name === 'WEBGL_lose_context') {
          const extension = plainObject({})
          bridge.install(extension, 'loseContext', bridge.fn('loseContext', 0, () => ctx.undefined), METHOD_FLAGS)
          bridge.install(extension, 'restoreContext', bridge.fn('restoreContext', 0, () => ctx.undefined), METHOD_FLAGS)
          return extension
        }
        return plainObject({})
      },
    },
    getSupportedExtensions: {
      length: 0,
      run: (state) => {
        const names = ctx.newArray()
        state.extensions.forEach((name, index) => {
          const value = ctx.newString(name)
          ctx.setProp(names, index, value)
          value.dispose()
        })
        bridge.emit('dom', 'before', { api: 'webgl.getSupportedExtensions', count: state.extensions.length })
        return names
      },
    },
    getShaderPrecisionFormat: {
      length: 2,
      run: (state, call) => {
        const precisionType = bridge.int(call.args, 1, 0)
        const precision =
          precisionType === GL.LOW_FLOAT || precisionType === GL.LOW_INT
            ? 8
            : precisionType === GL.MEDIUM_FLOAT || precisionType === GL.MEDIUM_INT
              ? 10
              : 23
        return plainObject({ rangeMin: 127, rangeMax: 127, precision })
      },
    },
    getContextAttributes: {
      length: 0,
      run: () =>
        plainObject({
          alpha: true,
          antialias: true,
          depth: true,
          desynchronized: false,
          failIfMajorPerformanceCaveat: false,
          powerPreference: 'default',
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
          stencil: false,
          xrCompatible: false,
        }),
    },
    createShader: { length: 1, run: () => createOpaque('webgl-object', {}) },
    createProgram: { length: 0, run: () => createOpaque('webgl-object', {}) },
    createBuffer: { length: 0, run: () => createOpaque('webgl-object', {}) },
    createTexture: { length: 0, run: () => createOpaque('webgl-object', {}) },
    createFramebuffer: { length: 0, run: () => createOpaque('webgl-object', {}) },
    createRenderbuffer: { length: 0, run: () => createOpaque('webgl-object', {}) },
    createVertexArray: { length: 0, run: () => createOpaque('webgl-object', {}) },
    getShaderParameter: { length: 2, run: () => ctx.true },
    getProgramParameter: { length: 2, run: () => ctx.true },
    getShaderInfoLog: { length: 1, run: () => ctx.newString('') },
    getProgramInfoLog: { length: 1, run: () => ctx.newString('') },
    getShaderSource: { length: 1, run: () => ctx.newString('') },
    getAttribLocation: { length: 2, run: () => ctx.newNumber(0) },
    getUniformLocation: { length: 2, run: () => plainObject({}) },
    getActiveUniform: { length: 2, run: () => plainObject({ name: 'u_resolution', size: 1, type: GL.FLOAT }) },
    getActiveAttrib: { length: 2, run: () => plainObject({ name: 'a_position', size: 1, type: GL.FLOAT }) },
    checkFramebufferStatus: { length: 1, run: () => ctx.newNumber(GL.FRAMEBUFFER_COMPLETE) },
    getError: { length: 0, run: () => ctx.newNumber(GL.NO_ERROR) },
    isContextLost: { length: 0, run: () => ctx.false },
    readPixels: {
      length: 7,
      run: (state, call) => {
        const pixels = call.args[6]
        const count = pixels && ctx.typeof(pixels) === 'object' ? fillWithZeros(pixels) : 0
        bridge.emit('dom', 'before', {
          api: 'webgl.readPixels',
          x: bridge.int(call.args, 0, 0),
          y: bridge.int(call.args, 1, 0),
          width: bridge.int(call.args, 2, 0),
          height: bridge.int(call.args, 3, 0),
          pixels: count,
        })
        return ctx.undefined
      },
    },
  })

  for (const [name, arity] of Object.entries(WEBGL_SIMPLE_METHODS)) {
    if (webglMethodSpecs[name]) continue
    webglMethodSpecs[name] = {
      length: arity,
      run: (state, call) => {
        if (name === 'viewport') {
          state.viewport = [0, 1, 2, 3].map((index) => bridge.int(call.args, index, 0))
        }
        if (name === 'drawArrays' || name === 'drawElements' || name === 'clear') {
          bridge.emit('dom', 'before', { api: `webgl.${name}` })
        }
        return ctx.undefined
      },
    }
  }

  const webglMethodHandles = buildMethodHandles('webgl', webglMethodSpecs)

  // ---- audio -------------------------------------------------------------
  const fillAnalyser = (target, binCount, asBytes) => {
    if (!target || ctx.typeof(target) !== 'object') return 0
    const count = Math.min(lengthOf(target), binCount)
    for (let index = 0; index < count; index += 1) {
      const decibels = analyserBin(audioNoise, binCount, index)
      const value = ctx.newNumber(asBytes ? Math.max(0, Math.min(255, Math.round((decibels + 100) * 2.55))) : decibels)
      ctx.setProp(target, index, value)
      value.dispose()
    }
    return count
  }

  const createAudioNode = (group, ctor, contextHandle, values = {}) => {
    const node = createInstance(ctor)
    const state = {
      id: nextStateId++,
      group: 'audio-node',
      nodeGroup: group,
      type: values.type ?? '',
      fftSize: 2048,
      channels: new Map(),
    }
    attachState(node, state)
    if (contextHandle) ctx.setProp(node, 'context', contextHandle)
    const param = (name, defaultValue) => {
      const audioParam = createInstance(AudioParamCtor)
      attachState(audioParam, { id: nextStateId++, group: 'audio-param', value: defaultValue, defaultValue })
      ctx.setProp(node, name, audioParam)
      audioParam.dispose()
    }
    if (group === 'gain') param('gain', 1)
    if (group === 'oscillator') {
      param('frequency', 440)
      param('detune', 0)
    }
    if (group === 'biquad') {
      param('frequency', 350)
      param('detune', 0)
      param('Q', 1)
      param('gain', 0)
    }
    if (group === 'compressor') {
      param('threshold', -24)
      param('knee', 30)
      param('ratio', 12)
      param('attack', 0.003)
      param('release', 0.25)
    }
    if (group === 'buffer-source') param('playbackRate', 1)
    return node
  }

  const createAudioBuffer = (numberOfChannels, length, sampleRate, noise) => {
    const channels = Math.max(1, Math.trunc(numberOfChannels) || 1)
    const frames = Math.trunc(length)
    if (!Number.isFinite(frames) || frames <= 0) throw notSupported('The number of frames provided is zero or negative')
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : profile.audio.sampleRate
    const buffer = createInstance(AudioBufferCtor)
    attachState(buffer, {
      id: nextStateId++,
      group: 'audio-buffer',
      numberOfChannels: channels,
      length: frames,
      sampleRate: rate,
      noise: noise ?? audioNoise,
      channels: new Map(),
    })
    return buffer
  }

  const audioContextMethods = {
    resume: {
      length: 0,
      run: (state) =>
        deferredAfter(1, () => {
          state.state = 'running'
          bridge.emit('api', 'before', { api: 'AudioContext.resume', state: state.state })
          return state.state
        }),
    },
    suspend: {
      length: 0,
      run: (state) =>
        deferredAfter(1, () => {
          state.state = 'suspended'
          bridge.emit('api', 'before', { api: 'AudioContext.suspend', state: state.state })
          return state.state
        }),
    },
    close: {
      length: 0,
      run: (state) =>
        deferredAfter(1, () => {
          state.state = 'closed'
          bridge.emit('api', 'before', { api: 'AudioContext.close' })
          return undefined
        }),
    },
    createOscillator: { length: 0, run: (state, call) => createAudioNode('oscillator', OscillatorNodeCtor, call.thisHandle, { type: 'sine' }) },
    createGain: { length: 0, run: (state, call) => createAudioNode('gain', GainNodeCtor, call.thisHandle) },
    createAnalyser: { length: 0, run: (state, call) => createAudioNode('analyser', AnalyserNodeCtor, call.thisHandle) },
    createDynamicsCompressor: { length: 0, run: (state, call) => createAudioNode('compressor', DynamicsCompressorNodeCtor, call.thisHandle) },
    createBiquadFilter: { length: 0, run: (state, call) => createAudioNode('biquad', BiquadFilterNodeCtor, call.thisHandle, { type: 'lowpass' }) },
    createBufferSource: { length: 0, run: (state, call) => createAudioNode('buffer-source', AudioBufferSourceNodeCtor, call.thisHandle) },
    createBuffer: {
      length: 3,
      run: (state, call) =>
        createAudioBuffer(
          bridge.int(call.args, 0, 1),
          bridge.int(call.args, 1, 1),
          bridge.num(call.args, 2, state.sampleRate),
          state.noise,
        ),
    },
  }

  const audioNodeMethods = {
    connect: { length: 1, run: (state, call) => call.args[0] ?? ctx.undefined },
    disconnect: { length: 0, run: () => ctx.undefined },
  }

  const analyserMethods = {
    getFloatFrequencyData: {
      length: 1,
      run: (state, call) => {
        const bins = fillAnalyser(call.args[0], state.fftSize / 2, false)
        bridge.emit('api', 'before', { api: 'AnalyserNode.getFloatFrequencyData', bins })
        return ctx.undefined
      },
    },
    getByteFrequencyData: {
      length: 1,
      run: (state, call) => {
        const bins = fillAnalyser(call.args[0], state.fftSize / 2, true)
        bridge.emit('api', 'before', { api: 'AnalyserNode.getByteFrequencyData', bins })
        return ctx.undefined
      },
    },
    getFloatTimeDomainData: {
      length: 1,
      run: (state, call) => {
        const target = call.args[0]
        const count = target && ctx.typeof(target) === 'object' ? lengthOf(target) : 0
        const rng = createSeededRandom(`${audioNoise}::time-domain:${count}`)
        for (let index = 0; index < count; index += 1) {
          const value = ctx.newNumber(round3(rng.next() * 2 - 1))
          ctx.setProp(target, index, value)
          value.dispose()
        }
        bridge.emit('api', 'before', { api: 'AnalyserNode.getFloatTimeDomainData', samples: count })
        return ctx.undefined
      },
    },
  }

  const audioBufferMethods = {
    getChannelData: {
      length: 1,
      run: (state, call) => {
        const channel = bridge.int(call.args, 0, 0)
        if (channel < 0 || channel >= state.numberOfChannels) {
          throw new Error('getChannelData: channel index is out of range')
        }
        const cached = state.channels.get(channel)
        if (cached) return cached
        const samples = audioChannelSamples(state.noise, channel, state.length)
        const view = typedArrayValues('float32', samples)
        state.channels.set(channel, view)
        return view
      },
    },
    copyFromChannel: {
      length: 2,
      run: (state, call) => {
        const target = call.args[0]
        const channel = bridge.int(call.args, 1, 0)
        const samples = audioChannelSamples(state.noise, channel, state.length)
        const count = target && ctx.typeof(target) === 'object' ? lengthOf(target) : 0
        for (let index = 0; index < count; index += 1) {
          const value = ctx.newNumber(samples[index] ?? 0)
          ctx.setProp(target, index, value)
          value.dispose()
        }
        return ctx.undefined
      },
    },
    copyToChannel: { length: 2, run: () => ctx.undefined },
  }

  const audioParamMethods = {
    setValueAtTime: { length: 2, run: (state, call) => rampParam(state, call) },
    linearRampToValueAtTime: { length: 2, run: (state, call) => rampParam(state, call) },
    exponentialRampToValueAtTime: { length: 2, run: (state, call) => rampParam(state, call) },
    setTargetAtTime: { length: 3, run: (state, call) => call.thisHandle },
    setValueCurveAtTime: { length: 3, run: (state, call) => call.thisHandle },
    cancelScheduledValues: { length: 1, run: (state, call) => call.thisHandle },
  }

  const rampParam = (state, call) => {
    state.value = bridge.num(call.args, 0, state.value)
    return call.thisHandle
  }

  /** Guest typed array from an existing numeric view (no intermediate array). */
  const typedArrayValues = (kind, values) => {
    const bufferHandle = ctx.newArrayBuffer(values.buffer.slice(0))
    const helper = kind === 'float32' ? helpers.Float32Array : helpers.Int32Array
    const view = invoke(helper, [bufferHandle])
    bufferHandle.dispose()
    return view
  }

  // ---- forward-declared constructors ------------------------------------
  let ImageDataCtor
  let CanvasGradientCtor
  let CanvasPatternCtor
  let CanvasRenderingContext2DCtor
  let WebGLRenderingContextCtor
  let WebGL2RenderingContextCtor
  let AudioContextCtor
  let OfflineAudioContextCtor
  let AudioBufferCtor
  let AudioParamCtor
  let AudioNodeCtor
  let GainNodeCtor
  let OscillatorNodeCtor
  let AnalyserNodeCtor
  let DynamicsCompressorNodeCtor
  let BiquadFilterNodeCtor
  let AudioBufferSourceNodeCtor
  let AudioDestinationNodeCtor
  let FontFaceCtor
  let FontFaceSetCtor
  let HTMLCanvasElementCtor
  let HTMLImageElementCtor
  let HTMLAudioElementCtor
  let HTMLVideoElementCtor

  // ---- blobs -------------------------------------------------------------
  const createBlob = (bytes, type) => {
    const blob = plainObject({ size: bytes.length, type })
    attachState(blob, { id: nextStateId++, group: 'blob' })
    bridge.install(blob, 'arrayBuffer', bridge.fn('arrayBuffer', 0, () => deferredAfter(1, () => new Uint8Array(bytes))), METHOD_FLAGS)
    bridge.install(blob, 'text', bridge.fn('text', 0, () => deferredAfter(1, () => new TextDecoder('utf-8').decode(bytes))), METHOD_FLAGS)
    bridge.install(blob, 'slice', bridge.fn('slice', 2, () => createBlob(bytes, type)), METHOD_FLAGS)
    return blob
  }

  // ---- document / canvas context wiring ---------------------------------
  const normalizeImageType = (type) => {
    const text = String(type ?? '').trim().toLowerCase()
    return text.includes('/') ? text : 'image/png'
  }

  const webglVersion = (version) =>
    String(version).replace('WebGL 1.0', 'WebGL 2.0').replace('OpenGL ES 2.0', 'OpenGL ES 3.0')

  const shadingLanguageVersion = (version) =>
    String(version).replaceAll('GLSL ES 1.0', 'GLSL ES 3.00').replaceAll('ES 1.0', 'ES 3.0')

  const webglExtensions = (webgl2) => {
    if (profile.engine === 'Gecko') {
      return webgl2 ? [...GECKO_WEBGL_EXTENSIONS, 'EXT_color_buffer_float', 'OVR_multiview2'] : [...GECKO_WEBGL_EXTENSIONS]
    }
    return webgl2 ? [...CHROMIUM_WEBGL_EXTENSIONS, ...CHROMIUM_WEBGL2_ONLY_EXTENSIONS] : [...CHROMIUM_WEBGL_EXTENSIONS]
  }

  const createCanvasState = (options) => ({
    id: nextStateId++,
    group: 'element',
    width: clampCanvasDimension(optionNumber(options, 'width', DEFAULT_CANVAS_WIDTH)),
    height: clampCanvasDimension(optionNumber(options, 'height', DEFAULT_CANVAS_HEIGHT)),
    ops: [],
  })

  /**
   * Return the cached rendering context of a canvas, creating it on first use.
   * The slot lives in the guest object so repeated calls hand back the same
   * object (a host-kept handle would be dead after the first return).
   *
   * @param {object} canvasState
   * @param {object} call
   * @param {object} slotKey symbol handle
   * @param {() => object} create
   */
  const cachedContext = (call, slotKey, create) => {
    const cached = ctx.getProp(call.thisHandle, slotKey)
    if (ctx.typeof(cached) === 'object') return cached
    cached.dispose()
    const context = create()
    ctx.setProp(call.thisHandle, slotKey, context)
    return context
  }

  const getContext = (canvasState, call) => {
    const type = String(bridge.str(call.args, 0, '')).toLowerCase()
    bridge.emit('dom', 'before', { api: 'canvas.getContext', type })
    if (type === '2d') {
      return cachedContext(call, CONTEXT_2D_KEY, () => {
        const context = createInstance(CanvasRenderingContext2DCtor)
        attachState(context, { id: nextStateId++, group: '2d', canvas: canvasState, stack: [] })
        ctx.setProp(context, 'canvas', call.thisHandle)
        for (const [key, value] of Object.entries(CONTEXT_2D_STATE)) writeValue(context, key, value)
        return context
      })
    }
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
      const webgl2 = type === 'webgl2'
      return cachedContext(call, webgl2 ? CONTEXT_WEBGL2_KEY : CONTEXT_WEBGL_KEY, () => {
        const context = createInstance(webgl2 ? WebGL2RenderingContextCtor : WebGLRenderingContextCtor)
        attachState(context, {
          id: nextStateId++,
          group: 'webgl',
          webgl2,
          canvas: canvasState,
          extensions: webglExtensions(webgl2),
          viewport: [0, 0, canvasState.width, canvasState.height],
        })
        ctx.setProp(context, 'canvas', call.thisHandle)
        return context
      })
    }
    return ctx.null
  }

  // ---- element initializers ---------------------------------------------
  const initCanvasElement = bridge.fn('initialize', 1, ({ args }) => {
    attachState(args[0], createCanvasState(bridge.value(args, 1)))
    attachElementChrome(args[0])
    return ctx.undefined
  })

  const initImageElement = bridge.fn('initialize', 3, ({ args }) => {
    const first = bridge.value(args, 1)
    const second = bridge.value(args, 2)
    const options = first && typeof first === 'object' ? first : null
    attachState(args[0], {
      id: nextStateId++,
      group: 'element',
      width: clampCanvasDimension(options ? optionNumber(options, 'width', 0) : numberOr(first, 0)),
      height: clampCanvasDimension(options ? optionNumber(options, 'height', 0) : numberOr(second, 0)),
      naturalWidth: 0,
      naturalHeight: 0,
      complete: false,
      src: '',
      listeners: new Map(),
    })
    attachElementChrome(args[0])
    return ctx.undefined
  })

  const initMediaElement = bridge.fn('initialize', 2, ({ args }) => {
    const first = bridge.value(args, 1)
    const options = first && typeof first === 'object' ? first : null
    attachState(args[0], {
      id: nextStateId++,
      group: 'element',
      width: 0,
      height: 0,
      duration: NaN,
      currentTime: 0,
      paused: true,
      volume: 1,
      muted: false,
      playbackRate: 1,
      readyState: 0,
      src: options ? optionString(options, 'src', '') : typeof first === 'string' ? first : '',
      listeners: new Map(),
    })
    attachElementChrome(args[0])
    return ctx.undefined
  })

  // ---- image / media surface --------------------------------------------
  const imageAccessors = {
    ...elementAccessors,
    naturalWidth: { get: (state) => state.naturalWidth },
    naturalHeight: { get: (state) => state.naturalHeight },
    complete: { get: (state) => state.complete },
    crossOrigin: {
      get: (state) => state.crossOrigin ?? null,
      set: (state, call) => {
        state.crossOrigin = bridge.str(call.args, 0, '') || null
        return ctx.undefined
      },
    },
    src: {
      get: (state) => state.src,
      set: (state, call) => {
        state.src = bridge.str(call.args, 0, '')
        state.complete = false
        bridge.emit('dom', 'before', { api: 'img.src', length: state.src.length })
        const element = call.thisHandle.dup()
        schedule(1, () => {
          state.complete = true
          state.naturalWidth = state.width
          state.naturalHeight = state.height
          if (state.src) fireEvent(state, element, 'load', {})
          element.dispose()
        })
        return ctx.undefined
      },
    },
  }

  const mediaAccessors = {
    ...elementAccessors,
    currentTime: {
      get: (state) => state.currentTime,
      set: (state, call) => {
        state.currentTime = bridge.num(call.args, 0, 0)
        return ctx.undefined
      },
    },
    duration: { get: (state) => state.duration },
    paused: { get: (state) => state.paused },
    ended: { get: (state) => state.ended ?? false },
    volume: {
      get: (state) => state.volume,
      set: (state, call) => {
        state.volume = Math.max(0, Math.min(1, bridge.num(call.args, 0, 1)))
        return ctx.undefined
      },
    },
    muted: {
      get: (state) => state.muted,
      set: (state, call) => {
        state.muted = Boolean(ctx.dump(call.args[0] ?? ctx.false))
        return ctx.undefined
      },
    },
    playbackRate: { get: (state) => state.playbackRate },
    readyState: { get: (state) => state.readyState },
    src: {
      get: (state) => state.src,
      set: (state, call) => {
        state.src = bridge.str(call.args, 0, '')
        return ctx.undefined
      },
    },
  }

  const mediaMethods = {
    ...elementMethods,
    play: {
      length: 0,
      run: (state) =>
        deferredAfter(1, () => {
          state.paused = false
          return undefined
        }),
    },
    pause: {
      length: 0,
      run: (state) => {
        state.paused = true
        return ctx.undefined
      },
    },
    load: { length: 0, run: () => ctx.undefined },
    canPlayType: { length: 1, run: () => ctx.newString('') },
  }

  // ---- font surface -----------------------------------------------------
  const fontFaceSetAccessors = {
    status: { get: () => 'loaded' },
    size: { get: (state) => state.faces.length },
  }

  const fontFaceSetMethods = {
    check: {
      length: 2,
      run: (state, call) => {
        const font = bridge.str(call.args, 0, '')
        bridge.emit('api', 'before', { api: 'FontFaceSet.check', font: truncate(font) })
        // `12px "Segoe UI", sans-serif` -> check the profile's font list.
        const match = /(?:^|\s)(?:"([^"]+)"|'([^']+)'|([A-Za-z][\w -]*?))(?:,|$)/.exec(font.replace(/^[^ ]+\s+/, ''))
        const family = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase()
        if (!family) return ctx.true
        const known = profile.fonts.some((item) => item.toLowerCase() === family)
        return known ? ctx.true : ctx.false
      },
    },
    load: {
      length: 2,
      run: (state, call) => {
        bridge.emit('api', 'before', { api: 'FontFaceSet.load', font: truncate(bridge.str(call.args, 0, '')) })
        return deferredAfter(1, () => [])
      },
    },
    add: {
      length: 1,
      run: (state, call) => {
        const face = call.args[0]
        if (face && ctx.typeof(face) === 'object') state.faces.push(face.dup())
        return call.thisHandle
      },
    },
    delete: { length: 1, run: () => ctx.false },
    clear: {
      length: 0,
      run: (state) => {
        state.faces = []
        return ctx.undefined
      },
    },
    has: { length: 1, run: (state) => (state.faces.length > 0 ? ctx.true : ctx.false) },
    forEach: {
      length: 1,
      run: (state, call) => {
        const callback = call.args[0]
        if (!callback || ctx.typeof(callback) !== 'function') return ctx.undefined
        for (const face of state.faces) {
          const result = ctx.callFunction(callback, call.thisHandle, [face, face, call.thisHandle])
          if (result.error) {
            result.error.dispose()
            return ctx.undefined
          }
          result.value.dispose()
        }
        return ctx.undefined
      },
    },
  }

  const fontFaceAccessors = {
    status: { get: () => 'loaded' },
    family: { get: (state) => state.family },
    style: { get: () => 'normal' },
    weight: { get: () => '400' },
    stretch: { get: () => 'normal' },
    unicodeRange: { get: () => 'U+0-10FFFF' },
    display: { get: () => 'auto' },
  }

  // ---- constructors -----------------------------------------------------
  ImageDataCtor = defineClass({
    name: 'ImageData',
    arity: 2,
    group: 'image-data',
    init: bridge.fn('initialize', 2, ({ args }) => {
      const width = Math.max(0, bridge.int(args, 1, 0))
      const height = Math.max(0, bridge.int(args, 2, 0))
      const request = { seed: canvasSeed, noise: canvasNoise, x: 0, y: 0, width, height }
      attachState(args[0], { id: nextStateId++, group: 'image-data', width, height, data: imageDataBytes(request) })
      return ctx.undefined
    }),
    accessors: imageDataAccessors,
  })
  CanvasGradientCtor = defineClass({
    name: 'CanvasGradient',
    arity: 0,
    group: 'gradient',
    illegalConstructor: true,
    methods: gradientMethods,
  })
  CanvasPatternCtor = defineClass({
    name: 'CanvasPattern',
    arity: 0,
    group: 'pattern',
    illegalConstructor: true,
    methods: patternMethods,
  })
  CanvasRenderingContext2DCtor = defineClass({
    name: 'CanvasRenderingContext2D',
    arity: 0,
    group: '2d',
    illegalConstructor: true,
    methods: context2dMethods,
  })
  const webglAccessors = {
    drawingBufferWidth: { get: (state) => state.canvas.width },
    drawingBufferHeight: { get: (state) => state.canvas.height },
  }
  WebGLRenderingContextCtor = defineClass({
    name: 'WebGLRenderingContext',
    arity: 0,
    group: 'webgl',
    illegalConstructor: true,
    properties: GL,
    methodHandles: webglMethodHandles,
    accessors: webglAccessors,
  })
  WebGL2RenderingContextCtor = defineClass({
    name: 'WebGL2RenderingContext',
    arity: 0,
    group: 'webgl',
    illegalConstructor: true,
    properties: GL,
    methodHandles: webglMethodHandles,
    accessors: webglAccessors,
  })

  const audioBufferAccessors = {
    numberOfChannels: { get: (state) => state.numberOfChannels },
    length: { get: (state) => state.length },
    sampleRate: { get: (state) => state.sampleRate },
    duration: { get: (state) => round3(state.length / state.sampleRate) },
  }

  AudioBufferCtor = defineClass({
    name: 'AudioBuffer',
    arity: 1,
    group: 'audio-buffer',
    init: bridge.fn('initialize', 1, ({ args }) => {
      const options = bridge.value(args, 1)
      if (!options || typeof options !== 'object') {
        throw new TypeError("Failed to construct 'AudioBuffer': 1 argument required, but only 0 present.")
      }
      attachState(args[0], {
        id: nextStateId++,
        group: 'audio-buffer',
        numberOfChannels: Math.max(1, Math.trunc(optionNumber(options, 'numberOfChannels', 1)) || 1),
        length: Math.max(1, Math.trunc(optionNumber(options, 'length', 1)) || 1),
        sampleRate: optionNumber(options, 'sampleRate', profile.audio.sampleRate),
        noise: audioNoise,
        channels: new Map(),
      })
      return ctx.undefined
    }),
    accessors: audioBufferAccessors,
    methods: audioBufferMethods,
  })
  AudioParamCtor = defineClass({
    name: 'AudioParam',
    arity: 0,
    group: 'audio-param',
    illegalConstructor: true,
    accessors: {
      value: {
        get: (state) => state.value,
        set: (state, call) => {
          state.value = bridge.num(call.args, 0, state.value)
          return ctx.undefined
        },
      },
      defaultValue: { get: (state) => state.defaultValue },
      minValue: { get: () => -3.4028234663852886e38 },
      maxValue: { get: () => 3.4028234663852886e38 },
      automationRate: { get: () => 'a-rate' },
    },
    methods: audioParamMethods,
  })

  const nodeAccessors = {
    numberOfInputs: { get: () => 1 },
    numberOfOutputs: { get: (state) => (state.nodeGroup === 'destination' ? 0 : 1) },
    channelCount: {
      get: (state) => state.channelCount ?? 2,
      set: (state, call) => {
        state.channelCount = bridge.int(call.args, 0, 2)
        return ctx.undefined
      },
    },
    channelCountMode: { get: () => 'max' },
    channelInterpretation: { get: () => 'speakers' },
  }

  AudioNodeCtor = defineClass({
    name: 'AudioNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: nodeAccessors,
    methods: audioNodeMethods,
  })
  AudioDestinationNodeCtor = defineClass({
    name: 'AudioDestinationNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: { ...nodeAccessors, maxChannelCount: { get: () => profile.audio.maxChannelCount } },
    methods: audioNodeMethods,
  })
  GainNodeCtor = defineClass({
    name: 'GainNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: nodeAccessors,
    methods: audioNodeMethods,
  })
  OscillatorNodeCtor = defineClass({
    name: 'OscillatorNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: {
      ...nodeAccessors,
      type: {
        get: (state) => state.type,
        set: (state, call) => {
          state.type = bridge.str(call.args, 0, 'sine')
          return ctx.undefined
        },
      },
    },
    methods: {
      ...audioNodeMethods,
      start: { length: 0, run: () => ctx.undefined },
      stop: { length: 0, run: () => ctx.undefined },
      setPeriodicWave: { length: 1, run: () => ctx.undefined },
    },
  })
  AnalyserNodeCtor = defineClass({
    name: 'AnalyserNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: {
      ...nodeAccessors,
      fftSize: {
        get: (state) => state.fftSize,
        set: (state, call) => {
          const value = bridge.int(call.args, 0, 2048)
          state.fftSize = value >= 32 && value <= 32768 && (value & (value - 1)) === 0 ? value : 2048
          return ctx.undefined
        },
      },
      frequencyBinCount: { get: (state) => state.fftSize / 2 },
      minDecibels: { get: () => -100 },
      maxDecibels: { get: () => -30 },
      smoothingTimeConstant: {
        get: (state) => state.smoothing ?? 0.8,
        set: (state, call) => {
          state.smoothing = Math.max(0, Math.min(1, bridge.num(call.args, 0, 0.8)))
          return ctx.undefined
        },
      },
    },
    methods: { ...audioNodeMethods, ...analyserMethods },
  })
  DynamicsCompressorNodeCtor = defineClass({
    name: 'DynamicsCompressorNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: { ...nodeAccessors, reduction: { get: () => 0 } },
    methods: audioNodeMethods,
  })
  BiquadFilterNodeCtor = defineClass({
    name: 'BiquadFilterNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: {
      ...nodeAccessors,
      type: {
        get: (state) => state.type,
        set: (state, call) => {
          state.type = bridge.str(call.args, 0, 'lowpass')
          return ctx.undefined
        },
      },
    },
    methods: audioNodeMethods,
  })
  AudioBufferSourceNodeCtor = defineClass({
    name: 'AudioBufferSourceNode',
    arity: 0,
    group: 'audio-node',
    illegalConstructor: true,
    accessors: { ...nodeAccessors, loop: { get: () => false } },
    methods: {
      ...audioNodeMethods,
      start: { length: 0, run: () => ctx.undefined },
      stop: { length: 0, run: () => ctx.undefined },
    },
  })

  const audioContextAccessors = {
    state: { get: (state) => state.state },
    sampleRate: { get: (state) => state.sampleRate },
    currentTime: {
      get: (state) => round3(Math.max(0, (clock?.performanceNow?.() ?? 0) - state.t0) / 1000),
    },
    baseLatency: { get: (state) => (state.kind === 'OfflineAudioContext' ? 0 : 0.01) },
    outputLatency: { get: (state) => (state.kind === 'OfflineAudioContext' ? 0 : 0.02) },
  }

  /** Destination node shared by online and offline contexts. */
  const attachDestinationNode = (contextHandle) => {
    const destination = createInstance(AudioDestinationNodeCtor)
    attachState(destination, {
      id: nextStateId++,
      group: 'audio-node',
      nodeGroup: 'destination',
      fftSize: 2048,
      channels: new Map(),
    })
    ctx.setProp(contextHandle, 'destination', destination)
    destination.dispose()
  }

  const initAudioContext = bridge.fn('initialize', 1, ({ args }) => {
    const options = bridge.value(args, 1)
    attachState(args[0], {
      id: nextStateId++,
      group: 'audio-context',
      kind: 'AudioContext',
      sampleRate: optionNumber(options, 'sampleRate', profile.audio.sampleRate),
      state: 'suspended',
      t0: clock?.performanceNow?.() ?? 0,
      noise: audioNoise,
    })
    attachDestinationNode(args[0])
    return ctx.undefined
  })

  const initOfflineAudioContext = bridge.fn('initialize', 3, ({ args }) => {
    const first = bridge.value(args, 1)
    const options = first && typeof first === 'object' ? first : null
    const numberOfChannels = options ? optionNumber(options, 'numberOfChannels', 1) : bridge.int(args, 1, 1)
    const length = options ? optionNumber(options, 'length', 1) : bridge.num(args, 2, 1)
    const sampleRate = options ? optionNumber(options, 'sampleRate', profile.audio.sampleRate) : bridge.num(args, 3, profile.audio.sampleRate)
    attachState(args[0], {
      id: nextStateId++,
      group: 'audio-context',
      kind: 'OfflineAudioContext',
      numberOfChannels: Math.max(1, Math.trunc(numberOfChannels) || 1),
      length: Math.max(1, Math.trunc(length) || 1),
      sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : profile.audio.sampleRate,
      state: 'suspended',
      t0: clock?.performanceNow?.() ?? 0,
      noise: audioNoise,
    })
    attachDestinationNode(args[0])
    return ctx.undefined
  })

  AudioContextCtor = defineClass({
    name: 'AudioContext',
    arity: 0,
    accepts: 1,
    group: 'audio-context',
    init: initAudioContext,
    accessors: audioContextAccessors,
    methods: audioContextMethods,
  })
  OfflineAudioContextCtor = defineClass({
    name: 'OfflineAudioContext',
    arity: 1,
    accepts: 3,
    group: 'audio-context',
    init: initOfflineAudioContext,
    accessors: audioContextAccessors,
    methods: {
      ...audioContextMethods,
      startRendering: {
        length: 0,
        run: (state) => {
          bridge.emit('api', 'before', {
            api: 'OfflineAudioContext.startRendering',
            sampleRate: state.sampleRate,
            length: state.length,
          })
          return deferredAfter(1, () => createAudioBuffer(state.numberOfChannels, state.length, state.sampleRate, state.noise))
        },
      },
    },
  })

  FontFaceCtor = defineClass({
    name: 'FontFace',
    arity: 2,
    group: 'font-face',
    init: bridge.fn('initialize', 3, ({ args }) => {
      attachState(args[0], { id: nextStateId++, group: 'font-face', family: bridge.str(args, 1, '') })
      const loaded = bridge.deferred()
      loaded.resolve(args[0])
      ctx.setProp(args[0], 'loaded', loaded.handle)
      return ctx.undefined
    }),
    accessors: fontFaceAccessors,
    methods: {
      load: {
        length: 0,
        run: (state, call) => {
          const self = call.thisHandle.dup()
          return deferredAfter(1, () => self)
        },
      },
    },
  })
  FontFaceSetCtor = defineClass({
    name: 'FontFaceSet',
    arity: 0,
    group: 'font-face-set',
    illegalConstructor: true,
    accessors: fontFaceSetAccessors,
    methods: fontFaceSetMethods,
  })

  HTMLCanvasElementCtor = defineClass({
    name: 'HTMLCanvasElement',
    arity: 0,
    accepts: 1,
    group: 'element',
    init: initCanvasElement,
    accessors: canvasElementAccessors,
    methods: canvasElementMethods,
    properties: { tagName: 'CANVAS', nodeName: 'CANVAS', nodeType: 1 },
  })
  HTMLImageElementCtor = defineClass({
    name: 'HTMLImageElement',
    arity: 0,
    accepts: 2,
    group: 'element',
    init: initImageElement,
    accessors: imageAccessors,
    methods: elementMethods,
    properties: { tagName: 'IMG', nodeName: 'IMG', nodeType: 1, ...handlerProperties('load', 'error') },
  })
  HTMLAudioElementCtor = defineClass({
    name: 'HTMLAudioElement',
    arity: 0,
    accepts: 1,
    group: 'element',
    init: initMediaElement,
    accessors: mediaAccessors,
    methods: mediaMethods,
    properties: { tagName: 'AUDIO', nodeName: 'AUDIO', nodeType: 1, ...handlerProperties('play', 'pause', 'ended') },
  })
  HTMLVideoElementCtor = defineClass({
    name: 'HTMLVideoElement',
    arity: 0,
    accepts: 1,
    group: 'element',
    init: initMediaElement,
    accessors: mediaAccessors,
    methods: mediaMethods,
    properties: { tagName: 'VIDEO', nodeName: 'VIDEO', nodeType: 1, ...handlerProperties('play', 'pause', 'ended') },
  })

  // ---- globals -----------------------------------------------------------
  const interfaceConstructors = {
    HTMLCanvasElement: HTMLCanvasElementCtor,
    HTMLImageElement: HTMLImageElementCtor,
    HTMLAudioElement: HTMLAudioElementCtor,
    HTMLVideoElement: HTMLVideoElementCtor,
    Image: HTMLImageElementCtor,
    Audio: HTMLAudioElementCtor,
    CanvasRenderingContext2D: CanvasRenderingContext2DCtor,
    CanvasGradient: CanvasGradientCtor,
    CanvasPattern: CanvasPatternCtor,
    ImageData: ImageDataCtor,
    WebGLRenderingContext: WebGLRenderingContextCtor,
    WebGL2RenderingContext: WebGL2RenderingContextCtor,
    AudioContext: AudioContextCtor,
    OfflineAudioContext: OfflineAudioContextCtor,
    AudioBuffer: AudioBufferCtor,
    AudioParam: AudioParamCtor,
    AudioNode: AudioNodeCtor,
    AudioDestinationNode: AudioDestinationNodeCtor,
    GainNode: GainNodeCtor,
    OscillatorNode: OscillatorNodeCtor,
    AnalyserNode: AnalyserNodeCtor,
    DynamicsCompressorNode: DynamicsCompressorNodeCtor,
    BiquadFilterNode: BiquadFilterNodeCtor,
    AudioBufferSourceNode: AudioBufferSourceNodeCtor,
    FontFace: FontFaceCtor,
    FontFaceSet: FontFaceSetCtor,
  }
  for (const [name, ctor] of Object.entries(interfaceConstructors)) {
    bridge.install(bridge.global, name, ctor, CONSTRUCTOR_FLAGS)
  }
  // Blink aliases a prefixed constructor; Gecko historically does not.
  if (profile.browser !== 'firefox') {
    bridge.install(bridge.global, 'webkitAudioContext', AudioContextCtor, CONSTRUCTOR_FLAGS)
  }

  // ---- element factories (consumed by the document module) --------------
  // `document.createElement(tag, options)` calls these with the guest options
  // object (or a throwaway empty object) and installs whatever they return.
  const makeElement = (ctor, options) => {
    const element = construct(ctor, [options ?? {}])
    const documentHandle = ctx.getProp(bridge.global, 'document')
    if (documentHandle && ctx.typeof(documentHandle) === 'object') {
      ctx.setProp(element, 'ownerDocument', documentHandle)
    }
    documentHandle?.dispose()
    return element
  }

  const factories = bridge.elementFactories ?? new Map()
  factories.set('canvas', (options) => makeElement(HTMLCanvasElementCtor, options))
  factories.set('img', (options) => makeElement(HTMLImageElementCtor, options))
  factories.set('audio', (options) => makeElement(HTMLAudioElementCtor, options))
  factories.set('video', (options) => makeElement(HTMLVideoElementCtor, options))
  if (!bridge.elementFactories) bridge.elementFactories = factories
  bridge.canvasFactories = factories

  // ---- document.fonts ---------------------------------------------------
  /** @type {object[]} one FontFace per profile font, retained for the set's lifetime */
  const fontFaces = []
  for (const family of profile.fonts) {
    fontFaces.push(retain(construct(FontFaceCtor, [family, `local("${family}")`])))
  }
  const faceArray = retain(ctx.newArray())
  fontFaces.forEach((face, index) => ctx.setProp(faceArray, index, face))
  /** Fresh iterator over the profile's faces; `[Symbol.iterator]` must return one per call. */
  const facesIterator = bridge.fn('values', 0, () => invoke(helpers.iterate, [faceArray]))

  const installDocumentFonts = () => {
    const documentHandle = ctx.getProp(bridge.global, 'document')
    if (!documentHandle || ctx.typeof(documentHandle) !== 'object') {
      documentHandle?.dispose()
      return false
    }
    const existing = ctx.getProp(documentHandle, 'fonts')
    if (existing && ctx.typeof(existing) === 'object') {
      existing.dispose()
      documentHandle.dispose()
      return true
    }
    existing.dispose()
    const set = createInstance(FontFaceSetCtor)
    attachState(set, { id: nextStateId++, group: 'font-face-set', faces: [...fontFaces] })
    ctx.setProp(set, ITERATOR_KEY, facesIterator)
    bridge.install(set, 'values', facesIterator, METHOD_FLAGS)
    const ready = bridge.deferred()
    ready.resolve(set)
    ctx.setProp(set, 'ready', ready.handle)
    bridge.install(documentHandle, 'fonts', set, METHOD_FLAGS)
    set.dispose()
    documentHandle.dispose()
    bridge.emit('dom', 'emit', { event: 'document.fonts.installed', faces: fontFaces.length })
    return true
  }

  if (!installDocumentFonts()) {
    if (typeof bridge.deferUntilDocument !== 'function') {
      /** @type {Array<() => boolean>} */
      const pending = []
      bridge.pendingDocumentTasks = pending
      bridge.deferUntilDocument = (task) => {
        if (typeof task === 'function') pending.push(task)
        return pending.length
      }
    }
    bridge.deferUntilDocument(installDocumentFonts)
  }
}
