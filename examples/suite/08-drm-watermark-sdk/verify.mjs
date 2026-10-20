import assert from 'node:assert/strict'
import {
  DEFAULT_DENSITY,
  WATERMARK_BIT0,
  WATERMARK_BIT1,
  WATERMARK_END,
  WATERMARK_START,
  WatermarkError,
  analyzeInvisible,
  buildFrame,
  canonicalJson,
  createWatermarker,
  detectWatermark,
  embedWatermark,
  extractWatermark,
  hammingDecodeCodeword,
  hammingEncodeNibble,
  stripWatermark,
  visibleLength,
  watermarkCapacity,
  watermarkFingerprint,
} from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}

const cover = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
const metadata = {
  owner: 'ACME Studios',
  licenseId: 'LIC-2024-0042',
  customer: 'tenant-42',
  issuedAt: 1_750_000_000,
  tier: 'enterprise',
}

await check('hamming(7,4) corrects every single-bit error', () => {
  assert.equal(DEFAULT_DENSITY, 0.5)
  for (let nibble = 0; nibble < 16; nibble += 1) {
    const codeword = hammingEncodeNibble(nibble)
    assert.equal(codeword.length, 7)
    assert.deepEqual(hammingDecodeCodeword(codeword), { nibble, corrected: false })
    for (let position = 0; position < 7; position += 1) {
      const damaged = codeword.slice()
      damaged[position] ^= 1
      assert.deepEqual(hammingDecodeCodeword(damaged), { nibble, corrected: true })
    }
  }
  assert.throws(() => hammingDecodeCodeword([1, 0]), (error) => error.code === 'BAD_CODEWORD')
})

await check('canonical JSON binds metadata deterministically', () => {
  const left = canonicalJson({ b: 2, a: 1, nested: { z: true, y: [3, 1] } })
  const right = canonicalJson({ nested: { y: [3, 1], z: true }, a: 1, b: 2 })
  assert.equal(left, '{"a":1,"b":2,"nested":{"y":[3,1],"z":true}}')
  assert.equal(left, right)
  assert.notEqual(canonicalJson(metadata), canonicalJson({ ...metadata, tier: 'trial' }))
})

await check('keyed watermark roundtrip leaves the visible text intact', () => {
  const watermarker = createWatermarker({ key: 'drm-master-key-2024' })
  const marked = watermarker.embed(cover, metadata)
  assert.ok(marked.length > cover.length)
  assert.equal(stripWatermark(marked), cover)
  assert.equal(visibleLength(marked), visibleLength(cover))
  const analysis = analyzeInvisible(marked)
  assert.ok(analysis.invisible > 0)
  assert.equal(analysis.visible, cover.length)
  const extracted = watermarker.extract(marked)
  assert.deepEqual(extracted.metadata, metadata)
  assert.equal(extracted.keyed, true)
  assert.equal(extracted.correctedCodewords, 0)
  assert.equal(marked.includes(WATERMARK_START), true)
  assert.equal(marked.includes(WATERMARK_END), true)
})

await check('unkeyed watermark supports detect, extract and strip', () => {
  const marked = embedWatermark(cover, metadata)
  assert.equal(stripWatermark(marked), cover)
  const detection = detectWatermark(marked)
  assert.equal(detection.present, true)
  assert.equal(detection.keyed, false)
  assert.deepEqual(detection.metadata, metadata)
  assert.deepEqual(extractWatermark(marked).metadata, metadata)
  assert.equal(detectWatermark(cover).present, false)
  assert.equal(detectWatermark(stripWatermark(marked)).present, false)
  assert.throws(() => extractWatermark(cover), (error) => error.code === 'MISSING_WATERMARK')
  assert.equal(stripWatermark('\u200bplain\u2060 text'), 'plain text')
})

await check('capacity is reported and enforced', () => {
  const capacity = watermarkCapacity(cover)
  assert.equal(capacity.density, DEFAULT_DENSITY)
  assert.equal(capacity.symbols, Math.floor(cover.length * DEFAULT_DENSITY))
  assert.ok(capacity.maxPayloadBytes >= 100)
  const adjusted = watermarkCapacity(cover, { density: 0.25 })
  assert.ok(adjusted.maxPayloadBytes < capacity.maxPayloadBytes)
  const shortCover = 'short cover text'
  assert.equal(watermarkCapacity(shortCover).maxPayloadBytes, 0)
  assert.throws(() => embedWatermark(shortCover, metadata), (error) => error.code === 'CAPACITY_EXCEEDED')
  assert.throws(() => watermarkCapacity(cover, { density: 0 }), (error) => error.code === 'BAD_DENSITY')
  assert.throws(() => watermarkCapacity(cover, { density: 2 }), (error) => error.code === 'BAD_DENSITY')
})

await check('single-symbol tampering is corrected', () => {
  const marked = embedWatermark(cover, metadata, { key: 'tamper-key' })
  const position = marked.indexOf(WATERMARK_BIT0)
  assert.ok(position >= 0)
  const damaged = `${marked.slice(0, position)}${WATERMARK_BIT1}${marked.slice(position + 1)}`
  const extracted = extractWatermark(damaged, { key: 'tamper-key' })
  assert.equal(extracted.correctedCodewords, 1)
  assert.deepEqual(extracted.metadata, metadata)
  const secondPosition = damaged.lastIndexOf(WATERMARK_BIT1)
  const twice = `${damaged.slice(0, secondPosition)}${WATERMARK_BIT0}${damaged.slice(secondPosition + 1)}`
  assert.equal(extractWatermark(twice, { key: 'tamper-key' }).correctedCodewords, 2)
})

await check('corruption beyond the correction budget is rejected', () => {
  const marked = embedWatermark(cover, metadata, { key: 'budget-key' })
  const destroyed = marked.replaceAll(WATERMARK_BIT0, WATERMARK_BIT1)
  assert.throws(() => extractWatermark(destroyed, { key: 'budget-key' }), (error) => error instanceof WatermarkError)
  const tagOnly = marked.slice(0, marked.indexOf(WATERMARK_END))
  assert.throws(() => extractWatermark(tagOnly, { key: 'budget-key' }), (error) => error.code === 'MISSING_WATERMARK')
  assert.throws(() => extractWatermark(`${WATERMARK_START}${WATERMARK_BIT0}${WATERMARK_END}`), (error) => error.code === 'BAD_FRAME')
})

await check('distinct watermarks do not collide', () => {
  const first = embedWatermark(cover, metadata)
  const second = embedWatermark(cover, { ...metadata, licenseId: 'LIC-2024-0043' })
  assert.notEqual(first, second)
  assert.notEqual(watermarkFingerprint(first), watermarkFingerprint(second))
  assert.equal(extractWatermark(first).metadata.licenseId, 'LIC-2024-0042')
  assert.equal(extractWatermark(second).metadata.licenseId, 'LIC-2024-0043')
  const reencoded = embedWatermark(cover, metadata)
  assert.equal(reencoded, first, 'unkeyed embedding is deterministic')
  assert.notEqual(embedWatermark(cover, metadata, { key: 'key-a' }), embedWatermark(cover, metadata, { key: 'key-b' }))
  const keyed = embedWatermark(cover, metadata, { key: 'key-a' })
  assert.throws(() => extractWatermark(keyed, { key: 'key-b' }), (error) => error.code === 'AUTH_FAILED')
  assert.throws(() => extractWatermark(keyed), (error) => error.code === 'AUTH_REQUIRED')
})

await check('stray invisible characters do not break extraction', () => {
  const marked = embedWatermark(cover, metadata)
  const noisy = `\u200b\u200e${marked}\u200f\u2060`
  assert.deepEqual(extractWatermark(noisy).metadata, metadata)
  assert.equal(stripWatermark(noisy), cover)
  const decoy = `${WATERMARK_BIT1}${WATERMARK_BIT0}${marked}`
  assert.deepEqual(extractWatermark(decoy).metadata, metadata)
})

await check('frame parsing and metadata validation fail closed', () => {
  const built = buildFrame(metadata)
  assert.equal(built.frame[0], 0xa7)
  assert.equal(built.frame[1], 1)
  assert.equal(built.keyed, false)
  const badLength = new Uint8Array(built.frame)
  badLength[3] = 0xff
  assert.throws(() => extractWatermark(`${WATERMARK_START}${Array.from(badLength).flatMap((byte) => [byte >> 4, byte & 0x0f]).flatMap((nibble) => hammingEncodeNibble(nibble)).map((bit) => (bit ? WATERMARK_BIT1 : WATERMARK_BIT0)).join('')}${WATERMARK_END}`), (error) => error instanceof WatermarkError)
  assert.throws(() => buildFrame([]), (error) => error.code === 'BAD_METADATA')
  assert.throws(() => buildFrame(null), (error) => error.code === 'BAD_METADATA')
  assert.throws(() => buildFrame({ owner: undefined }), (error) => error.code === 'BAD_METADATA')
  assert.throws(() => embedWatermark('', metadata), (error) => error.code === 'BAD_COVER')
  assert.throws(() => embedWatermark(42, metadata), (error) => error.code === 'BAD_COVER')
  assert.throws(() => extractWatermark(null), (error) => error.code === 'BAD_COVER')
})

console.log(`checks: ${passed}/${total}`)
