import { buildSbom, createProvenance, generateSigningKeyPair, sbomDigest, verifyArtifacts, verifyProvenance } from './src/index.js'

const files = { 'dist/app.js': 'console.log("build")', 'dist/app.css': 'body{}' }
const bom = await buildSbom({ name: 'demo-service', version: '1.0.0', files })
const key = generateSigningKeyPair('ci-builder')
const envelope = await createProvenance({ bom, key, builder: { id: 'https://ci.example.test/gha', version: '2.1.0' } })
const result = await verifyProvenance(envelope, {
  keys: [{ keyId: key.keyId, type: key.type, publicKey: key.publicKey }],
  trustedBuilders: ['https://ci.example.test/*'],
  bom,
})
const drift = await verifyArtifacts(bom, { ...files, 'dist/app.css': 'body{color:red}' })
console.log('subject digest:', (await sbomDigest(bom)).slice(0, 24) + '…')
console.log('provenance valid:', result.valid, 'builder:', result.builder.id)
console.log('artifacts ok:', drift.ok, 'tampered:', drift.tampered.map((entry) => entry.path))
