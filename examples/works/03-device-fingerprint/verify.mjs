import assert from 'node:assert/strict'
import { createFingerprint, similarity, isSameDevice, toJSON, fromJSON, DEFAULT_WEIGHTS } from './src/index.js'

let passed = 0
let total = 0
function check(name, fn) {
  total += 1
  try { fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

const base = {
  platform: () => 'Win32',
  userAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
  hardwareConcurrency: () => 8,
  deviceMemory: () => 8,
  timezone: () => -480,
  languages: () => 'zh-CN,zh,en',
  screen: () => '1920x1080x24',
  pixelRatio: () => 1,
  webgl: () => 'ANGLE (NVIDIA GTX 1660)',
  fonts: () => 'Arial,Segoe UI',
  touch: () => 0,
  viewport: () => '1920x960',
}

const first = createFingerprint(base)
const second = createFingerprint(base)
const viewportChanged = createFingerprint({ ...base, viewport: () => '1600x900' })
const platformChanged = createFingerprint({ ...base, platform: () => 'MacIntel' })

check('deterministic id for identical probes', () => {
  assert.equal(first.id, second.id)
  assert.match(first.id, /^[0-9a-f]{8}$/)
  assert.equal(first.quality, 1)
})

check('volatile viewport change keeps identity', () => {
  assert.equal(first.id, viewportChanged.id)
  assert.ok(similarity(first, viewportChanged) >= 0.9)
})

check('platform change breaks identity', () => {
  assert.notEqual(first.id, platformChanged.id)
  assert.equal(isSameDevice(first, platformChanged), false)
})

check('missing and throwing probes are tolerated', () => {
  const partial = createFingerprint({ platform: () => 'Win32', broken: () => { throw new Error('nope') } })
  assert.equal(partial.components.broken, '')
  assert.ok(partial.quality >= 0 && partial.quality <= 1)
})

check('weights influence similarity', () => {
  const weak = similarity(first, platformChanged, { ...DEFAULT_WEIGHTS, platform: 0.1 })
  const strong = similarity(first, platformChanged, { ...DEFAULT_WEIGHTS, platform: 10 })
  assert.ok(weak > strong)
})

check('serialization roundtrip preserves identity', () => {
  const restored = fromJSON(toJSON(first))
  assert.equal(restored.id, first.id)
  assert.equal(similarity(restored, first), 1)
})

check('salt separates namespaces', () => {
  const other = createFingerprint(base, { salt: 'tenant-b' })
  assert.notEqual(first.id, other.id)
})

console.log(`checks: ${passed}/${total}`)
