import assert from 'node:assert/strict'
import { generateKeyPair, issueLicense, verifyLicense, decodeLicense, LicenseError } from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try { await fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

const keys = await generateKeyPair()
const now = 1_800_000_000_000
const token = await issueLicense(keys, {
  subject: 'user-42', audience: 'demo-app', product: 'demo-pro', scope: ['read', 'write'], ttlSeconds: 3600, now,
  licenseId: 'lic-1',
})

await check('valid license verifies', async () => {
  const result = await verifyLicense(token, keys.publicJwk, { now, audience: 'demo-app', product: 'demo-pro' })
  assert.equal(result.valid, true)
  assert.equal(result.payload.sub, 'user-42')
  assert.deepEqual(result.payload.scope, ['read', 'write'])
})

await check('decoding exposes header and payload', () => {
  const decoded = decodeLicense(token)
  assert.equal(decoded.header.alg, 'ES256')
  assert.equal(decoded.payload.licenseId, undefined)
  assert.equal(decoded.payload.jti, 'lic-1')
})

await check('tampered payload is rejected', async () => {
  const [header, , signature] = token.split('.')
  const forged = btoa(JSON.stringify({ sub: 'admin', exp: Math.floor(now / 1000) + 3600, aud: 'demo-app', product: 'demo-pro' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  await assert.rejects(() => verifyLicense(`${header}.${forged}.${signature}`, keys.publicJwk, { now }), (error) => error.code === 'BAD_SIGNATURE')
})

await check('expired license is rejected', async () => {
  await assert.rejects(
    () => verifyLicense(token, keys.publicJwk, { now: now + 4_000_000 }),
    (error) => error.code === 'EXPIRED',
  )
})

await check('clock skew is honoured', async () => {
  const result = await verifyLicense(token, keys.publicJwk, { now: now + 3_700_000, clockSkewSeconds: 200 })
  assert.equal(result.valid, true)
})

await check('audience and product binding', async () => {
  await assert.rejects(() => verifyLicense(token, keys.publicJwk, { now, audience: 'other-app' }), (error) => error.code === 'BAD_AUDIENCE')
  await assert.rejects(() => verifyLicense(token, keys.publicJwk, { now, product: 'other-product' }), (error) => error.code === 'BAD_PRODUCT')
})

await check('wrong key and malformed tokens are rejected', async () => {
  const other = await generateKeyPair()
  await assert.rejects(() => verifyLicense(token, other.publicJwk, { now }), (error) => error.code === 'BAD_SIGNATURE')
  await assert.rejects(() => verifyLicense('a.b', keys.publicJwk), (error) => error.code === 'MALFORMED')
  await assert.rejects(() => verifyLicense(`${token}x`, keys.publicJwk, { now }), (error) => error instanceof LicenseError)
})

console.log(`checks: ${passed}/${total}`)
