import { createWasmCrypto, loadWasmCrypto } from './src/index.js'

const api = await loadWasmCrypto()
const crypto = await createWasmCrypto()
const master = Buffer.alloc(32, 0x5a)
const envelope = crypto.seal(master, 'wasm authenticated payload · 机密计算', { aad: 'tenant-demo' })
const opened = crypto.open(master, envelope, { aad: 'tenant-demo', text: true })
const subkeys = crypto.deriveSubkeys(master)
console.log('module:', api.digest.slice(0, 24) + '…', 'bytes:', api.bytes.length, 'selftest:', api.selfTest.ok)
console.log('envelope:', JSON.stringify({ kid: envelope.kid, nonce: envelope.nonce, ct: envelope.ct.slice(0, 24) + '…', tag: envelope.tag.slice(0, 16) + '…' }))
console.log('opened:', opened)
console.log('subkeys:', Object.keys(subkeys).join(','), 'distinct:', !Buffer.from(subkeys.enc).equals(Buffer.from(subkeys.mac)))
