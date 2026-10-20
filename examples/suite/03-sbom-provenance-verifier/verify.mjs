import assert from 'node:assert/strict'
import {
  DSSE_PAYLOAD_TYPE,
  PROVENANCE_TYPE,
  ProvenanceError,
  buildSbom,
  canonicalJson,
  createProvenance,
  decodeStatement,
  diffSbom,
  exportProvenance,
  exportSbom,
  generateSigningKeyPair,
  hashContent,
  importProvenance,
  importSbom,
  normalizeFiles,
  preAuthenticationEncoding,
  sbomDigest,
  sha256Hex,
  verifyArtifacts,
  verifyProvenance,
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

const NOW = 1_700_000_000_000
const BUILDER = 'https://ci.example.test/builders/github-actions'
const files = {
  'src/app.js': 'export const app = 1',
  'src/util.js': 'export const util = 2',
  'package.json': '{"name":"demo-app","version":"1.2.3"}',
}
const bom = await buildSbom({ name: 'demo-app', version: '1.2.3', files, now: NOW, supplier: 'Example Corp' })
const hmacKey = { type: 'hmac', keyId: 'hmac-builder-1', secret: 'demo-hmac-secret-at-least-32-bytes!' }
const hmacVerifyKey = { keyId: 'hmac-builder-1', type: 'hmac', secret: hmacKey.secret }
const ecKey = generateSigningKeyPair('ec-builder-1')
const hmacEnvelope = await createProvenance({ bom, key: hmacKey, builder: { id: BUILDER, version: '2.1.0' }, now: NOW, materials: [{ name: 'base-image', digest: await sha256Hex('ubuntu-24.04') }] })
const trustedOptions = { keys: [hmacVerifyKey, { keyId: ecKey.keyId, type: 'ecdsa', publicKey: ecKey.publicKey }], trustedBuilders: [BUILDER], bom }

await check('SBOM is built with sorted components and real hashes', async () => {
  assert.equal(bom.bomFormat, 'CycloneDX')
  assert.equal(bom.specVersion, '1.5')
  assert.deepEqual(bom.components.map((component) => component.name), ['package.json', 'src/app.js', 'src/util.js'])
  const app = bom.components.find((component) => component.name === 'src/app.js')
  assert.equal(app.hashes[0].alg, 'SHA-256')
  assert.equal(app.hashes[0].content, await sha256Hex(files['src/app.js']))
  assert.equal(app.properties.find((property) => property.name === 'size').value, String(Buffer.byteLength(files['src/app.js'])))
  assert.equal(bom.metadata.component['bom-ref'], 'demo-app@1.2.3')
  assert.equal(bom.dependencies[0].dependsOn.length, 3)
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/)
  const hash = await hashContent(files['package.json'])
  assert.equal(hash.size, Buffer.byteLength(files['package.json']))
})

await check('SBOM digest is reproducible and content-sensitive', async () => {
  const rebuilt = await buildSbom({ name: 'demo-app', version: '1.2.3', files, now: NOW + 99_000 })
  assert.notEqual(rebuilt.serialNumber, bom.serialNumber)
  assert.notEqual(rebuilt.metadata.timestamp, bom.metadata.timestamp)
  assert.equal(await sbomDigest(rebuilt), await sbomDigest(bom))
  const changed = await buildSbom({ name: 'demo-app', version: '1.2.3', files: { ...files, 'src/app.js': 'export const app = 2' }, now: NOW })
  assert.notEqual(await sbomDigest(changed), await sbomDigest(bom))
  await assert.rejects(() => buildSbom({ name: 'demo-app', version: '1.2.3', files: {} }), (error) => error.code === 'BAD_SBOM')
})

await check('HMAC provenance verifies against the SBOM and builder', async () => {
  const result = await verifyProvenance(hmacEnvelope, trustedOptions)
  assert.equal(result.valid, true, result.reason)
  assert.equal(result.checks.length, 9)
  assert.ok(result.checks.every((entry) => entry.ok))
  assert.equal(result.builder.id, BUILDER)
  assert.equal(result.subjectDigest, await sbomDigest(bom))
  assert.equal(result.statement.predicateType, PROVENANCE_TYPE)
  assert.equal(result.statement.predicate.buildDefinition.resolvedDependencies[0].name, 'base-image')
})

await check('ECDSA provenance and DSSE pre-authentication encoding', async () => {
  const envelope = await createProvenance({ bom, key: ecKey, builder: { id: BUILDER, version: '2.1.0' }, now: NOW })
  assert.equal(envelope.signatures[0].alg, 'ES256')
  const result = await verifyProvenance(envelope, trustedOptions)
  assert.equal(result.valid, true, result.reason)
  const pae = preAuthenticationEncoding(DSSE_PAYLOAD_TYPE, Buffer.from('{}'))
  assert.match(pae.toString(), /^DSSEv1 28 application\/vnd\.in-toto\+json 2 \{\}$/)
  assert.throws(() => preAuthenticationEncoding('', Buffer.from('')), (error) => error.code === 'BAD_ENVELOPE')
})

await check('builder allowlist and predicate type are enforced', async () => {
  const wrongBuilder = await verifyProvenance(hmacEnvelope, { ...trustedOptions, trustedBuilders: ['https://ci.example.test/other/*'] })
  assert.equal(wrongBuilder.valid, false)
  assert.ok(wrongBuilder.checks.some((entry) => entry.name === 'builder.allowlist' && !entry.ok))
  const wildcard = await verifyProvenance(hmacEnvelope, { ...trustedOptions, trustedBuilders: ['https://ci.example.test/*'] })
  assert.equal(wildcard.valid, true)
  const pinnedVersion = await verifyProvenance(hmacEnvelope, { ...trustedOptions, trustedBuilders: [{ id: BUILDER, version: '9.9.9' }] })
  assert.equal(pinnedVersion.valid, false)
  const wrongType = await verifyProvenance(hmacEnvelope, { ...trustedOptions, predicateTypes: ['https://slsa.dev/provenance/v0.2'] })
  assert.ok(wrongType.checks.some((entry) => entry.name === 'predicate.type' && !entry.ok))
})

await check('tampered payload and signatures fail closed', async () => {
  const tamperedPayload = structuredClone(hmacEnvelope)
  const statement = decodeStatement(hmacEnvelope)
  statement.predicate.runDetails.builder.id = 'https://evil.example.test/builder'
  tamperedPayload.payload = Buffer.from(canonicalJson(statement), 'utf8').toString('base64url')
  const payloadResult = await verifyProvenance(tamperedPayload, trustedOptions)
  assert.equal(payloadResult.valid, false)
  assert.ok(payloadResult.checks.some((entry) => entry.name === 'signature' && !entry.ok))

  const tamperedSignature = structuredClone(hmacEnvelope)
  const sig = tamperedSignature.signatures[0].sig
  tamperedSignature.signatures[0].sig = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`
  const signatureResult = await verifyProvenance(tamperedSignature, trustedOptions)
  assert.equal(signatureResult.valid, false)
  assert.ok(signatureResult.checks.some((entry) => entry.name === 'signature' && !entry.ok))

  const unknownKey = structuredClone(hmacEnvelope)
  unknownKey.signatures[0].keyid = 'unknown-key'
  const unknownResult = await verifyProvenance(unknownKey, trustedOptions)
  assert.equal(unknownResult.valid, false)
  assert.ok(unknownResult.checks.some((entry) => entry.name === 'signature.keys' && !entry.ok))

  const threshold = await verifyProvenance(hmacEnvelope, { ...trustedOptions, threshold: 2 })
  assert.equal(threshold.valid, false)
})

await check('subject digest binds provenance to the exact SBOM', async () => {
  const otherBom = await buildSbom({ name: 'demo-app', version: '1.2.3', files: { ...files, 'src/util.js': 'tampered' }, now: NOW })
  const mismatch = await verifyProvenance(hmacEnvelope, { keys: [hmacVerifyKey], bom: otherBom })
  assert.equal(mismatch.valid, false)
  assert.ok(mismatch.checks.some((entry) => entry.name === 'subject.digest' && !entry.ok))
  assert.ok(mismatch.checks.some((entry) => entry.name === 'subject.name' && entry.ok))
  const renamed = await buildSbom({ name: 'other-app', version: '1.2.3', files, now: NOW })
  const nameMismatch = await verifyProvenance(hmacEnvelope, { keys: [hmacVerifyKey], bom: renamed })
  assert.ok(nameMismatch.checks.some((entry) => entry.name === 'subject.name' && !entry.ok))
})

await check('artifact verification reports missing, extra and tampered files', async () => {
  const drifted = {
    'src/app.js': files['src/app.js'],
    'src/util.js': files['src/util.js'],
    'package.json': '{"name":"demo-app","version":"6.6.6"}',
    'extra.txt': 'unexpected',
  }
  delete drifted['src/util.js']
  const report = await verifyArtifacts(bom, drifted)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missing, ['src/util.js'])
  assert.deepEqual(report.extra, ['extra.txt'])
  assert.deepEqual(report.tampered.map((entry) => entry.path), ['package.json'])
  assert.equal(report.checked, 3)
  assert.equal(report.tampered[0].expected, await sha256Hex(files['package.json']))
  const clean = await verifyArtifacts(bom, files)
  assert.equal(clean.ok, true)
  assert.equal(clean.tampered.length, 0)
})

await check('SBOM structural diff detects drift deterministically', async () => {
  const actual = await buildSbom({
    name: 'demo-app',
    version: '1.2.3',
    files: { 'src/app.js': 'export const app = 99', 'extra.txt': 'new', 'package.json': files['package.json'] },
    now: NOW,
  })
  const diff = diffSbom(bom, actual)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.missing, ['src/util.js'])
  assert.deepEqual(diff.extra, ['extra.txt'])
  assert.deepEqual(diff.tampered.map((entry) => entry.path), ['src/app.js'])
  const same = diffSbom(bom, await buildSbom({ name: 'demo-app', version: '1.2.3', files, now: NOW + 1 }))
  assert.equal(same.ok, true)
})

await check('provenance and SBOM JSON round-trip with validation', async () => {
  const exported = exportProvenance(hmacEnvelope)
  const imported = importProvenance(exported)
  assert.deepEqual(imported, hmacEnvelope)
  assert.equal((await verifyProvenance(imported, trustedOptions)).valid, true)
  assert.deepEqual(importSbom(exportSbom(bom)), bom)
  assert.throws(() => importProvenance('{}'), (error) => error instanceof ProvenanceError && error.code === 'BAD_ENVELOPE')
  assert.throws(() => importProvenance('{bad json'), (error) => error.code === 'BAD_ENVELOPE')
  assert.throws(() => importSbom('{"bomFormat":"CycloneDX"}'), (error) => error.code === 'BAD_SBOM')
  const broken = structuredClone(hmacEnvelope)
  broken.payload = 'not base64url!!'
  assert.throws(() => exportProvenance(broken), (error) => error.code === 'BAD_BASE64URL')
})

await check('input validation rejects duplicate paths and bad keys', async () => {
  assert.throws(
    () => normalizeFiles([{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }]),
    (error) => error.code === 'DUPLICATE_PATH',
  )
  assert.throws(() => normalizeFiles('nope'), (error) => error.code === 'BAD_FILES')
  const hash = await hashContent('abc')
  assert.equal(hash.digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  await assert.rejects(
    () => createProvenance({ bom, key: { type: 'hmac', keyId: 'short', secret: 'tiny' }, builder: { id: BUILDER } }),
    (error) => error.code === 'BAD_KEY',
  )
  await assert.rejects(
    () => createProvenance({ bom, key: hmacKey, builder: { id: BUILDER }, materials: [{ name: 'bad', digest: 'zz' }] }),
    (error) => error.code === 'BAD_DIGEST',
  )
  assert.throws(() => canonicalJson(undefined), (error) => error.code === 'BAD_INPUT')
})

console.log(`checks: ${passed}/${total}`)
