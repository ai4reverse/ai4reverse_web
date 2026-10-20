import assert from 'node:assert/strict'
import { createVault, openWithPassword, VaultError, toBase64, fromBase64, randomBytes } from './src/index.js'

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

await check('base64 roundtrip', () => {
  const bytes = randomBytes(37)
  assert.deepEqual(Array.from(fromBase64(toBase64(bytes))), Array.from(bytes))
})

const vault = await createVault({ password: 'correct horse battery staple', iterations: 20_000 })

await check('string roundtrip', async () => {
  const envelope = await vault.seal('top secret')
  assert.equal(await vault.open(envelope), 'top secret')
})

await check('binary roundtrip', async () => {
  const input = randomBytes(64)
  const envelope = await vault.seal(input)
  const output = await vault.open(envelope, { binary: true })
  assert.deepEqual(Array.from(output), Array.from(input))
})

await check('wrong password rejected', async () => {
  const envelope = await vault.seal('x')
  const other = await createVault({ password: 'wrong', salt: vault.salt, iterations: 20_000 })
  await assert.rejects(() => other.open(envelope), (error) => error instanceof VaultError && error.code === 'DECRYPT_FAILED')
})

await check('tampered ciphertext rejected', async () => {
  const envelope = await vault.seal('x')
  const bytes = fromBase64(envelope.ct)
  bytes[0] ^= 0xff
  envelope.ct = toBase64(bytes)
  await assert.rejects(() => vault.open(envelope), (error) => error.code === 'DECRYPT_FAILED')
})

await check('AAD mismatch rejected', async () => {
  const envelope = await vault.seal('x', { aad: 'tenant-a' })
  await assert.rejects(() => vault.open(envelope, { aad: 'tenant-b' }), (error) => error.code === 'DECRYPT_FAILED')
  assert.equal(await vault.open(envelope, { aad: 'tenant-a' }), 'x')
})

await check('fresh IV per record', async () => {
  const first = await vault.seal('same')
  const second = await vault.seal('same')
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ct, second.ct)
})

await check('derived key is reproducible from the envelope', async () => {
  const envelope = await vault.seal('portable')
  assert.equal(await openWithPassword(envelope, 'correct horse battery staple'), 'portable')
})

await check('malformed envelope rejected', async () => {
  await assert.rejects(() => vault.open({ v: 2 }), (error) => error.code === 'BAD_ENVELOPE')
  await assert.rejects(() => vault.open(null), (error) => error.code === 'BAD_ENVELOPE')
})

console.log(`checks: ${passed}/${total}`)
