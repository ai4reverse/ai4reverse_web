import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  ALGORITHM,
  CHUNK_SIZE,
  DATA_PTR,
  KEYSTREAM_PTR,
  MODULE_BASE64,
  MODULE_SHA256,
  MODULE_SIZE,
  WasmCrypto,
  WasmCryptoError,
  buildCryptoModule,
  constantTimeEqual,
  createWasmCrypto,
  loadWasmCrypto,
  mixReference,
  permuteReference,
  rotl32,
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

const api = await loadWasmCrypto()
const wasm = await createWasmCrypto()
const master = Buffer.alloc(32, 7)
const fixedNonce = Buffer.alloc(16, 3)
const sealed = wasm.seal(master, 'hello wasm authenticated stream', { aad: 'tenant-1', nonce: fixedNonce })

await check('WASM module compiles, instantiates and is byte-deterministic', () => {
  const bytes = buildCryptoModule()
  assert.equal(WebAssembly.validate(bytes), true)
  assert.deepEqual(Array.from(bytes), Array.from(buildCryptoModule()))
  assert.equal(bytes.length, MODULE_SIZE)
  assert.equal(MODULE_SHA256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(MODULE_SHA256.length, 64)
  assert.deepEqual(Array.from(Buffer.from(MODULE_BASE64, 'base64')), Array.from(bytes))
  for (const name of ['xor', 'rotl', 'mix', 'permute', 'xorBuf']) assert.equal(typeof api.exports[name], 'function', name)
  assert.equal(api.exports.memory.buffer.byteLength, 65_536)
})

await check('wasm primitives match the JavaScript reference', () => {
  const sample = Uint8Array.from({ length: 24 }, (_, index) => (index * 11) & 0xff)
  api.memory.set(sample, KEYSTREAM_PTR)
  api.exports.xor(KEYSTREAM_PTR, sample.length, 0xa5)
  const xored = Array.from(api.memory.slice(KEYSTREAM_PTR, KEYSTREAM_PTR + sample.length))
  assert.deepEqual(xored, Array.from(sample, (byte) => byte ^ 0xa5))

  for (const [value, shift] of [[0x12345678, 8], [0xffffffff, 1], [0x80000001, 31], [0, 17]]) {
    assert.equal(api.exports.rotl(value, shift) >>> 0, rotl32(value, shift))
  }
  for (const [left, right] of [[0x11111111, 0x22222222], [0, 0xffffffff], [0xdeadbeef, 0xfeedface]]) {
    assert.equal(api.exports.mix(left, right) >>> 0, mixReference(left, right))
  }

  const lanes = [1, 2, 3, 4, 5, 6, 7, 8]
  const view = new DataView(api.memory.buffer, KEYSTREAM_PTR, 32)
  lanes.forEach((lane, index) => view.setUint32(index * 4, lane, true))
  api.exports.permute(KEYSTREAM_PTR, 3)
  const permuted = Array.from({ length: 8 }, (_, index) => view.getUint32(index * 4, true))
  assert.deepEqual(permuted, permuteReference(lanes, 3))
  assert.deepEqual(api.selfTest.vectors.rotl, '34567812')
  assert.deepEqual(api.selfTest.vectors.xorBuf, '11223344')

  const left = Uint8Array.from([9, 8, 7, 6, 5])
  const right = Uint8Array.from([1, 2, 3, 4, 5])
  api.memory.set(left, DATA_PTR)
  api.memory.set(right, KEYSTREAM_PTR)
  api.exports.xorBuf(DATA_PTR, KEYSTREAM_PTR, left.length)
  assert.deepEqual(Array.from(api.memory.slice(DATA_PTR, DATA_PTR + left.length)), Array.from(left, (byte, index) => byte ^ right[index]))
  assert.equal(wasm.selfTest().ok, true)
})

await check('hash is deterministic, fixed-length and avalanches', () => {
  const hashAbc = Buffer.from(wasm.hash('abc')).toString('hex')
  assert.equal(hashAbc, 'e4f65c5c668e8195fcbf2e754651e95de0cfd0cd1c799f02943e411f35c4517c')
  assert.equal(Buffer.from(wasm.hash('abc')).toString('hex'), hashAbc)
  assert.equal(wasm.hash('abc').length, 32)
  const other = Buffer.from(wasm.hash('abd')).toString('hex')
  assert.notEqual(other, hashAbc)
  let bitDifference = 0
  const left = wasm.hash('payload')
  const right = wasm.hash('payloae')
  for (let index = 0; index < left.length; index += 1) bitDifference += (left[index] ^ right[index]).toString(2).replaceAll('0', '').length
  assert.ok(bitDifference >= 64, `expected avalanche, got ${bitDifference} bit flips`)
  assert.equal(wasm.hash('').length, 32)
  assert.notEqual(Buffer.from(wasm.hash('')).toString('hex'), Buffer.from(wasm.hash('\0')).toString('hex'))
  assert.notEqual(Buffer.from(wasm.hash(Buffer.alloc(100))).toString('hex'), Buffer.from(wasm.hash(Buffer.alloc(101))).toString('hex'))
})

await check('HKDF-like derive matches a fixed vector and separates inputs', () => {
  const derived = wasm.deriveKey({ ikm: 'master-secret-material', salt: 'unit-test-salt', info: 'encryption-key', length: 48 })
  assert.equal(Buffer.from(derived).toString('hex'), 'ede1113ea2a964739e344f694e311fcbf8aaddc6fdadfef431668cce259508f8b097d4fb90d43e776afa1a5ce5500e3d')
  assert.equal(derived.length, 48)
  const again = wasm.deriveKey({ ikm: 'master-secret-material', salt: 'unit-test-salt', info: 'encryption-key', length: 48 })
  assert.deepEqual(again, derived)
  const otherInfo = wasm.deriveKey({ ikm: 'master-secret-material', salt: 'unit-test-salt', info: 'mac-key', length: 48 })
  const otherSalt = wasm.deriveKey({ ikm: 'master-secret-material', salt: 'other-salt', info: 'encryption-key', length: 48 })
  assert.notDeepEqual(otherInfo, derived)
  assert.notDeepEqual(otherSalt, derived)
  assert.equal(wasm.deriveKey({ ikm: 'zk', length: 64 }).length, 64)
})

await check('key separation yields independent subkeys', () => {
  const subkeys = wasm.deriveSubkeys('master-secret-material', ['enc', 'mac', 'index', 'extra'])
  assert.deepEqual(Object.keys(subkeys), ['enc', 'mac', 'index', 'extra'])
  for (const value of Object.values(subkeys)) assert.equal(value.length, 32)
  assert.notDeepEqual(subkeys.enc, subkeys.mac)
  assert.notDeepEqual(subkeys.enc, subkeys.index)
  assert.notDeepEqual(subkeys.mac, subkeys.index)
  assert.deepEqual(wasm.deriveSubkeys('master-secret-material', ['enc', 'mac', 'index', 'extra']), subkeys)
  assert.notDeepEqual(wasm.deriveSubkeys('another-master-material', ['enc', 'mac']).enc, subkeys.enc)
})

await check('authenticated stream round-trips and is deterministic per nonce', () => {
  assert.equal(sealed.v, 1)
  assert.equal(sealed.alg, ALGORITHM)
  assert.equal(sealed.aad, Buffer.from('tenant-1').toString('base64url'))
  assert.equal(sealed.ct, 'MJBmTS6ChoX8rP2aMHjW--jhbu0pACuELTCTqCGJwQ')
  assert.equal(sealed.tag, 'p7QkiTv9vlPcTYcULxVJobP_-nG2RL_HSV_xLtXIMCQ')
  assert.equal(wasm.open(master, sealed, { aad: 'tenant-1', text: true }), 'hello wasm authenticated stream')
  const repeated = wasm.seal(master, 'hello wasm authenticated stream', { aad: 'tenant-1', nonce: fixedNonce })
  assert.deepEqual(repeated, sealed)
  const otherNonce = wasm.seal(master, 'hello wasm authenticated stream', { aad: 'tenant-1', nonce: Buffer.alloc(16, 4) })
  assert.notEqual(otherNonce.ct, sealed.ct)
  assert.notEqual(otherNonce.tag, sealed.tag)
})

await check('stream cipher handles multi-chunk payloads', () => {
  const payload = Buffer.alloc(CHUNK_SIZE * 2 + 137, 0x42)
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31) & 0xff
  const envelope = wasm.seal(master, payload, { aad: 'bulk', nonce: Buffer.alloc(16, 9) })
  assert.equal(Buffer.from(envelope.ct, 'base64url').length, payload.length)
  const opened = wasm.open(master, envelope, { aad: 'bulk' })
  assert.deepEqual(Buffer.from(opened), payload)
  const unicode = '机密计算 · wasm keystream · 0123456789'
  assert.equal(wasm.open(master, wasm.seal(master, unicode), { text: true }), unicode)
})

await check('MAC rejects wrong key, wrong AAD and tampered ciphertext before decrypting', () => {
  const wrongKey = Buffer.alloc(32, 8)
  assert.throws(() => wasm.open(wrongKey, sealed, { aad: 'tenant-1' }), (error) => error.code === 'AUTH_FAILED')
  assert.throws(() => wasm.open(master, sealed, { aad: 'tenant-2' }), (error) => error.code === 'AUTH_FAILED')
  const tamperedCt = { ...sealed, ct: `${sealed.ct.slice(0, -2)}AA` }
  assert.throws(() => wasm.open(master, tamperedCt, { aad: 'tenant-1' }), (error) => error.code === 'AUTH_FAILED')
  const tamperedTag = { ...sealed, tag: `${sealed.tag.slice(0, -2)}AA` }
  assert.throws(() => wasm.open(master, tamperedTag, { aad: 'tenant-1' }), (error) => error.code === 'AUTH_FAILED')
  const tamperedAadField = { ...sealed, aad: Buffer.from('tenant-9').toString('base64url') }
  assert.throws(() => wasm.open(master, tamperedAadField), (error) => error.code === 'AUTH_FAILED')
  assert.equal(constantTimeEqual(Buffer.from('tag'), Buffer.from('tag')), true)
  assert.equal(constantTimeEqual(Buffer.from('tag'), Buffer.from('tah')), false)
  assert.equal(constantTimeEqual(Buffer.from('tag'), Buffer.from('tags')), false)
})

await check('malformed keys, nonces and envelopes are rejected with codes', async () => {
  assert.throws(() => wasm.seal(Buffer.alloc(4), 'x'), (error) => error instanceof WasmCryptoError && error.code === 'BAD_KEY')
  assert.throws(() => wasm.seal(master, 'x', { nonce: Buffer.alloc(2) }), (error) => error.code === 'BAD_NONCE')
  assert.throws(() => wasm.deriveKey({ ikm: '' }), (error) => error.code === 'BAD_KEY')
  assert.throws(() => wasm.deriveKey({ ikm: 'x', length: 0 }), (error) => error.code === 'BAD_LENGTH')
  assert.throws(() => wasm.open(master, { ...sealed, ct: 'not base64url!!' }), (error) => error.code === 'BAD_ENVELOPE')
  assert.throws(() => wasm.open(master, { ...sealed, v: 2 }), (error) => error.code === 'BAD_ENVELOPE')
  assert.throws(() => new WasmCrypto(/** @type {any} */ ({})), (error) => error.code === 'NOT_READY')
  assert.equal(typeof (await WasmCrypto.create()).hash, 'function')
})

console.log(`checks: ${passed}/${total}`)
