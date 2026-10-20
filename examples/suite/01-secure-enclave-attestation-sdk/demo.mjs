import {
  ReplayCache,
  createAttestor,
  createChallenge,
  createPolicy,
  generateEnclaveKeyPair,
  measureManifest,
  verifyAttestation,
} from './src/index.js'

const manifest = { 'enclave/boot.bin': 'boot-v3', 'enclave/app.wasm': 'app-v3' }
const measurement = measureManifest(manifest)
const policy = createPolicy({ name: 'demo', measurements: [measurement.root], enclaves: ['enclave-demo'], requiredClaims: { stage: 'prod' } })
const { privateKey, publicKey, keyId } = generateEnclaveKeyPair()
const attestor = createAttestor({ enclaveId: 'enclave-demo', privateKey, keyId, policy, claims: { stage: 'prod' } })
const challenge = createChallenge({ ttlMs: 30_000 })
const quote = attestor.attest({ challenge, manifest })
const result = verifyAttestation(quote, { publicKey, challenge, policy, replayCache: new ReplayCache() })
console.log('measurement:', measurement.root.slice(0, 24) + '…')
console.log('quote checks:', result.checks.map((entry) => `${entry.name}=${entry.ok}`).join(' '))
console.log('valid:', result.valid)
