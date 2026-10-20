import { createVault } from './src/index.js'
const vault = await createVault({ password: 'demo-passphrase', iterations: 20_000 })
const envelope = await vault.sealJson({ account: 'demo', balance: 42 }, { aad: 'tenant-demo' })
console.log('envelope:', JSON.stringify(envelope).slice(0, 160) + '…')
console.log('opened:', await vault.openJson(envelope, { aad: 'tenant-demo' }))
