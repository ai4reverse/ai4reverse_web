#!/usr/bin/env node
/**
 * Revalidation matrix.
 *
 * One command that rebuilds the protected artifacts from scratch and proves
 * every claim in the README with executable evidence:
 *
 *   node verify.mjs            # full matrix (builds dist/nsdk-*.js)
 *   node verify.mjs --no-build # use the artifacts already in dist/
 *
 * Sections: primitives (published vectors + OpenSSL oracles), white-box
 * equivalence, mutated ciphers, hybrid envelopes, zero-trust guard, device
 * identity and drift, JSVMP bytecode equivalence and polymorphism, protected
 * builds (host and QuickJS sandbox), and a platform analysis pass.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, createCipheriv } from 'node:crypto'

import { createFakeBrowser, emptyScope, runBundleInNodeVm, runBundleInSandbox, assert } from './testing/fixtures.mjs'
import {
  fromHex,
  toHex,
  utf8ToBytes,
  bytesToUtf8,
  concatBytes,
} from './src/core/bytes.js'
import { sm3, sm3Hex, sha256, hmacSm3, kdfSm3 } from './src/core/hash.js'
import { sm4EncryptBlock, sm4Ctr } from './src/core/sm4.js'
import { aesEncryptBlock, aesCtr } from './src/core/aes.js'
import { chacha20Xor } from './src/core/chacha.js'
import {
  generateKeyPair,
  hexToBig,
  scalarMultiply,
  sm2Sign,
  sm2Verify,
  sm2SharedSecret,
  bigToHex,
  decodePoint,
} from './src/core/sm2.js'
import { createWhiteboxAes } from './src/core/whitebox/aes-wb.js'
import { createWhiteboxSm4 } from './src/core/whitebox/sm4-wb.js'
import { createWhiteboxSpn } from './src/core/whitebox/spn-wb.js'
import {
  createMutantAes,
  createMutantSm4,
  createRc6Like,
  createMagmaLike,
  createArxStream,
  spongeHash,
} from './src/core/custom.js'
import { WHITEBOX_SUITES, SERVER_LAYERS, instantiateWhitebox, deriveLayerMaterial, deriveEnvelopeSecrets } from './src/core/variants.js'
import { sealEnvelope, openEnvelope, envelopeToString, parseEnvelopeString, sealLocal, openLocal, deriveVmKey } from './src/core/hybrid.js'
import { createGuard } from './src/guard/index.js'
import { buildSignals } from './src/guard/signals.js'
import { createProbe } from './src/guard/probe.js'
import { probeDocumentAll } from './src/guard/document-all.js'
import { evaluateSignals, riskToken, parseRiskToken } from './src/guard/policy.js'
import { createDeviceIdentity, createStorage } from './src/fingerprint/device-token.js'
import { createVault } from './src/core/vault.js'
import { hashFingerprint, compareFingerprints } from './src/fingerprint/canonical.js'
import { collectFingerprint } from './src/fingerprint/collectors.js'
import { createSigner } from './src/signing/sign.js'
import { canonicalRequest, signatureBase } from './src/signing/canonical.js'
import { createVerifier } from './server/verify.mjs'
import { compileAndValidate, buildSigningBlob, createVm, SIGNING_PROGRAM_SOURCE, disassemble, decodeBlob } from './src/vm/index.js'
import { createHostApi } from './src/vm/host.js'
import { buildVariants } from './build/build-sdk.mjs'
import { analyzeSample } from '../../tools/analysis/orchestrator.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const checks = []
let currentSection = ''

/** @param {string} name @param {() => any} fn */
async function check(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail).slice(0, 160) })
    console.log(`  ok   ${name}${detail ? ` — ${String(detail).slice(0, 100)}` : ''}`)
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message })
    console.log(`  FAIL ${name} — ${error.message}`)
  }
}

/** @param {string} title */
function section(title) {
  currentSection = title
  console.log(`\n${title}`)
}

const nodeCrypto = { createHash, createHmac, createCipheriv }

/** @param {() => any} fn @param {string} message */
function expectThrow(fn, message) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(message)
}

const serverKeys = generateKeyPair()
const serverPublicKey = serverKeys.publicHex

// ---------------------------------------------------------------------------
section('1. published vectors and OpenSSL oracles')

await check('SM3("abc") matches GB/T 32905', () => {
  const digest = sm3Hex('abc')
  assert(digest === '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0', digest)
  return digest.slice(0, 16)
})

await check('SM3 512-block vector', () => {
  const digest = sm3Hex('abcd'.repeat(16))
  assert(digest === 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732', digest)
  return digest.slice(0, 16)
})

await check('SM4 KAT (GB/T 32907)', () => {
  const key = fromHex('0123456789abcdeffedcba9876543210')
  const cipher = toHex(sm4EncryptBlock(key, key))
  assert(cipher === '681edf34d206965e86b3e94f536e4246', cipher)
  return cipher
})

await check('AES-128/AES-256 KAT (FIPS 197)', () => {
  const block = fromHex('00112233445566778899aabbccddeeff')
  const key128 = fromHex('000102030405060708090a0b0c0d0e0f')
  const key256 = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
  assert(toHex(aesEncryptBlock(key128, block)) === '69c4e0d86a7b0430d8cdb78070b4c55a', 'AES-128')
  assert(toHex(aesEncryptBlock(key256, block)) === '8ea2b7ca516745bfeafc49904b496089', 'AES-256')
  return 'both key sizes'
})

await check('SM2 GM/T 0003.5 known-answer signature', () => {
  const d = hexToBig('3945208F7B2144B13F36E38AC6D39F95889393692860B51A42FB81EF4DF7C5B8')
  const publicKey = scalarMultiply(d)
  assert(bigToHex(publicKey.x) === '09f9df311e5421a150dd7d161e4bc5c672179fad1833fc076bb08ff356f35020', 'public x')
  assert(bigToHex(publicKey.y) === 'ccea490ce26775a52dc6ea718cc1aa600aed05fbf35e084a6632f6072da9ad13', 'public y')
  const k = hexToBig('59276E27D506861A16680F3AD9C02DCCEF3CC1FA3CDBE4CE6D54B80DEAC1BC21')
  const message = utf8ToBytes('message digest')
  const signature = sm2Sign(message, d, { k, publicKey })
  assert(bigToHex(signature.r) === 'f5a03b0648d2c4630eeac513e1bb81a15944da3827d5b74143ac7eaceee720b3', 'r')
  assert(bigToHex(signature.s) === 'b1b6aa29df212fd8763182bc0d421ca1bb9038fd1f7f42d4840b69c485bbc1aa', 's')
  assert(sm2Verify(message, signature.hex, publicKey), 'self verify')
  assert(!sm2Verify(utf8ToBytes('message digesT'), signature.hex, publicKey), 'tamper must fail')
  return 'r/s match'
})

await check('SM4/AES/SM3/HMAC-SHA256 agree with OpenSSL', () => {
  let tested = 0
  for (let index = 0; index < 12; index += 1) {
    const key = createHash('sha256').update(`key-${index}`).digest().subarray(0, 16)
    const block = createHash('sha256').update(`block-${index}`).digest().subarray(0, 16)
    const sm4 = createCipheriv('sm4-ecb', key, null)
    sm4.setAutoPadding(false)
    const sm4Reference = Buffer.concat([sm4.update(block), sm4.final()]).toString('hex')
    assert(toHex(sm4EncryptBlock(key, block)) === sm4Reference, `SM4 block ${index}`)

    const aes = createCipheriv('aes-128-ecb', key, null)
    aes.setAutoPadding(false)
    const aesReference = Buffer.concat([aes.update(block), aes.final()]).toString('hex')
    assert(toHex(aesEncryptBlock(key, block)) === aesReference, `AES block ${index}`)

    const message = createHash('sha256').update(`message-${index}`).digest()
    assert(toHex(hmacSm3(key, message)) === createHmac('sm3', key).update(message).digest('hex'), `HMAC-SM3 ${index}`)
    assert(toHex(sha256(message)) === createHash('sha256').update(message).digest('hex'), `SHA-256 ${index}`)
    tested += 1
  }
  return `${tested} blocks/hashes`
})

await check('ChaCha20 agrees with OpenSSL', () => {
  for (let index = 0; index < 5; index += 1) {
    const key = createHash('sha256').update(`chacha-${index}`).digest()
    const iv = createHash('sha256').update(`iv-${index}`).digest().subarray(0, 16)
    const plaintext = createHash('sha256').update(`plain-${index}`).digest()
    const cipher = createCipheriv('chacha20', key, iv)
    const reference = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('hex')
    const counter = iv.readUInt32LE(0)
    const mine = toHex(chacha20Xor(key, iv.subarray(4), counter, plaintext))
    assert(mine === reference, `ChaCha20 case ${index}`)
  }
  return '5 keystreams'
})

await check('SM2 ECDH is symmetric and rejects off-curve points', () => {
  const a = generateKeyPair()
  const b = generateKeyPair()
  const left = sm2SharedSecret(a.d, b.publicKey)
  const right = sm2SharedSecret(b.d, a.publicKey)
  assert(toHex(left) === toHex(right), 'shared secrets differ')
  expectThrow(() => decodePoint('04' + '11'.repeat(64)), 'off-curve point accepted')
  return 'symmetric'
})

// ---------------------------------------------------------------------------
section('2. white-box suites (implicit key, dynamic tables)')

await check('all 12 white-box suites are instantiated and functional', () => {
  const key = fromHex('00112233445566778899aabbccddeeff')
  const sm4Key = fromHex('0123456789abcdeffedcba9876543210')
  const block = fromHex('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  const suites = []
  for (const suite of WHITEBOX_SUITES) {
    const instance = instantiateWhitebox(suite.id, `verify-${suite.id}`)
    if (suite.family === 'whitebox-aes-128') {
      const reference = createWhiteboxAes({ seed: `verify-${suite.id}`, key })
      assert(toHex(reference.encryptBlock(block)) === toHex(aesEncryptBlock(key, block)), `${suite.id} AES mismatch`)
    } else if (suite.family === 'whitebox-sm4') {
      const reference = createWhiteboxSm4({ seed: `verify-${suite.id}`, key: sm4Key })
      assert(toHex(reference.encryptBlock(block)) === toHex(sm4EncryptBlock(sm4Key, block)), `${suite.id} SM4 mismatch`)
    } else {
      assert(toHex(instance.decryptBlock(instance.encryptBlock(block))) === toHex(block), `${suite.id} round trip`)
    }
    assert(instance.meta.implicitKey === true, `${suite.id} not implicit`)
    suites.push(instance.meta.suiteId)
  }
  assert(new Set(suites).size === suites.length, 'suite ids are not unique per parameterisation')
  return `${suites.length} suites, ${new Set(suites).size} distinct table sets`
})

await check('a white-box instance never exposes its key', () => {
  const key = fromHex('00112233445566778899aabbccddeeff')
  const instance = createWhiteboxAes({ seed: 'leak-check', key })
  const dump = JSON.stringify(instance)
  assert(!dump.includes(toHex(key)), 'key hex appears in serialised instance')
  assert(!dump.includes('00112233'), 'key prefix appears in instance')
  assert(!('key' in instance), 'instance has a key property')
  const different = createWhiteboxAes({ seed: 'leak-check-2', key })
  assert(instance.meta.suiteId !== different.meta.suiteId, 'two seeds produced the same tables')
  return instance.meta.suiteId
})

await check('vault seals with six different white-box suites and rejects tampering', () => {
  const vault = createVault({ buildSalt: 'vault-verify', spnKeyHex: '9a'.repeat(32) })
  const suiteIds = WHITEBOX_SUITES.map((suite) => suite.id)
  const used = new Set()
  for (const suiteId of suiteIds.slice(0, 6)) {
    const envelope = vault.seal(`vault-${suiteId}`, {
      suiteId,
      nonce: fromHex('00'.repeat(15) + suiteIds.indexOf(suiteId).toString(16).padStart(2, '0')),
      salt: fromHex(suiteIds.indexOf(suiteId).toString(16).padStart(16, '0')),
    })
    assert(envelope.suite === suiteId, `suite mismatch ${suiteId}`)
    assert(vault.openText(envelope) === `vault-${suiteId}`, `round trip ${suiteId}`)
    used.add(envelope.suite)
  }
  assert(used.size === 6, `only ${used.size} suites used`)
  const sample = vault.seal('tamper', { suiteId: 'wb-aes/a', nonce: fromHex('01'.repeat(16)), salt: fromHex('02'.repeat(8)) })
  expectThrow(() => vault.open({ ...sample, ct: sample.ct.slice(0, -1) + (sample.ct.endsWith('a') ? 'b' : 'a') }), 'vault ct tamper accepted')
  expectThrow(() => vault.open({ ...sample, suite: 'wb-sm4/a' }), 'vault suite tamper accepted')
  const transport = vault.toTransport(sample)
  assert(vault.openText(vault.fromTransport(transport)) === 'tamper', 'vault transport')
  return `${used.size} suites, tamper + transport`
})

await check('white-box SPN output depends on the key', () => {
  const one = createWhiteboxSpn({ seed: 'spn', key: fromHex('11'.repeat(32)) })
  const two = createWhiteboxSpn({ seed: 'spn', key: fromHex('22'.repeat(32)) })
  const left = toHex(one.encryptBlock(new Uint8Array(16)))
  const right = toHex(two.encryptBlock(new Uint8Array(16)))
  assert(left !== right, 'different keys produced identical ciphertext')
  return 'key-dependent s-boxes'
})

// ---------------------------------------------------------------------------
section('3. mutated/custom ciphers')

await check('every custom cipher round-trips across seeds', () => {
  const factories = [
    ['mutant-aes', createMutantAes, 16],
    ['mutant-sm4', createMutantSm4, 16],
    ['rc6-like', createRc6Like, 16],
    ['magma-like', createMagmaLike, 8],
  ]
  let count = 0
  for (const [name, factory, size] of factories) {
    for (let index = 0; index < 10; index += 1) {
      const cipher = factory({ seed: `${name}-${index}` })
      const block = createHash('sha256').update(`${name}-${index}`).digest().subarray(0, size)
      assert(toHex(cipher.decryptBlock(cipher.encryptBlock(block))) === toHex(block), `${name} seed ${index}`)
      count += 1
    }
  }
  return `${count} parameterisations`
})

await check('custom ciphers avalanche (one input bit changes many output bits)', () => {
  const cipher = createMutantAes({ seed: 'avalanche' })
  const left = cipher.encryptBlock(new Uint8Array(16))
  const right = cipher.encryptBlock(Uint8Array.from([1, ...new Array(15).fill(0)]))
  let bits = 0
  for (let index = 0; index < 16; index += 1) {
    let difference = left[index] ^ right[index]
    while (difference) {
      bits += difference & 1
      difference >>= 1
    }
  }
  assert(bits >= 32, `only ${bits} bits changed`)
  return `${bits}/128 bits`
})

await check('keyed sponge and ARX stream are seeded', () => {
  const a = toHex(spongeHash(utf8ToBytes('message'), fromHex('11'.repeat(32))))
  const b = toHex(spongeHash(utf8ToBytes('message'), fromHex('22'.repeat(32))))
  assert(a !== b, 'keyed sponge ignored the key')
  const stream = createArxStream({ seed: 'arx-1' }).keystream(64)
  assert(stream.some((value) => value !== 0), 'ARX stream is all zero')
  return `${a.slice(0, 12)}…`
})

// ---------------------------------------------------------------------------
section('4. hybrid envelopes')

await check('30 random layer plans round-trip', () => {
  let count = 0
  const plans = new Set()
  for (let index = 0; index < 30; index += 1) {
    const client = generateKeyPair()
    const nonce = createHash('sha256').update(`nonce-${index}`).digest().subarray(0, 16)
    const length = index * 7 % 300
    const plaintext = createHash('sha512').update(`plain-${index}`).digest().subarray(0, length === 0 ? 1 : length)
    const ephemeral = hexToBig(createHash('sha256').update(`eph-${index}`).digest('hex'))
    const envelope = sealEnvelope(plaintext, {
      serverPublicKey,
      ephemeralScalar: ephemeral,
      nonce,
      kid: 'device-1',
      fixedPlan: SERVER_LAYERS.slice(index % 7, (index % 7) + 3 + (index % 3)),
    })
    const opened = openEnvelope(envelope, serverKeys.d)
    assert(toHex(opened) === toHex(plaintext), `plan ${index} round trip`)
    plans.add(envelope.layers.join(','))
    count += 1
  }
  assert(plans.size >= 5, `only ${plans.size} distinct plans`)
  return `${count} envelopes, ${plans.size} plans`
})

await check('envelope tampering is detected (ciphertext, header, tag)', () => {
  const nonce = fromHex('000102030405060708090a0b0c0d0e0f')
  const envelope = sealEnvelope('confidential payload', {
    serverPublicKey,
    ephemeralScalar: hexToBig('59276E27D506861A16680F3AD9C02DCCEF3CC1FA3CDBE4CE6D54B80DEAC1BC21'),
    nonce,
    kid: 'device-1',
  })
  const flip = (value) => (value.endsWith('a') ? 'b' : 'a')
  expectThrow(() => openEnvelope({ ...envelope, ct: envelope.ct.slice(0, -1) + flip(envelope.ct) }, serverKeys.d), 'ciphertext tamper accepted')
  expectThrow(() => openEnvelope({ ...envelope, layers: [...envelope.layers].reverse() }, serverKeys.d), 'layer tamper accepted')
  expectThrow(() => openEnvelope({ ...envelope, nonce: 'ff'.repeat(16) }, serverKeys.d), 'nonce tamper accepted')
  expectThrow(() => openEnvelope({ ...envelope, tag: 'ff'.repeat(32) }, serverKeys.d), 'tag tamper accepted')
  return '4 tamper classes rejected'
})

await check('transport form is lossless', () => {
  const envelope = sealEnvelope('transport', {
    serverPublicKey,
    ephemeralScalar: hexToBig('1234567890abcdef'),
    nonce: fromHex('00'.repeat(16)),
  })
  const parsed = parseEnvelopeString(envelopeToString(envelope))
  assert(toHex(openEnvelope(parsed, serverKeys.d)) === toHex(utf8ToBytes('transport')), 'transport round trip')
  return envelopeToString(envelope).slice(0, 20) + '…'
})

await check('local white-box sealing rejects a different device key', () => {
  const spn = createWhiteboxSpn({ seed: 'local', key: fromHex('11'.repeat(32)) })
  const other = createWhiteboxSpn({ seed: 'local', key: fromHex('22'.repeat(32)) })
  const nonce = fromHex('0102030405060708090a0b0c0d0e0f10')
  const envelope = sealLocal('install state', { spn, nonce, kid: 'k1' })
  assert(bytesToUtf8(openLocal(envelope, { spn })) === 'install state', 'round trip')
  expectThrow(() => openLocal(envelope, { spn: other }), 'wrong key accepted')
  return 'authenticated'
})

// ---------------------------------------------------------------------------
section('5. zero-trust environment detection')

await check('document.all is proof-grade in a synthetic browser', () => {
  const probe = createProbe(createFakeBrowser())
  const result = probeDocumentAll(probe)
  assert(result.status === 'fail', 'synthetic document.all unexpectedly passed')
  const failed = result.checks.filter((entry) => !entry.ok).map((entry) => entry.id)
  assert(failed.includes('typeof-undefined'), `missing typeof check: ${failed.join(',')}`)
  assert(failed.includes('falsy'), 'missing truthiness check')
  assert(failed.includes('loose-null'), 'missing loose-null check')
  return `fails ${failed.join(', ')}`
})

await check('missing document.all is detected', () => {
  const probe = createProbe({ document: {} })
  const result = probeDocumentAll(probe)
  assert(result.status === 'fail', 'missing document.all passed')
  return 'property-exists fails'
})

await check('fake browser: only the un-fakeable proof fails', () => {
  const verdict = createGuard({ scope: createFakeBrowser() }).evaluate()
  const failed = verdict.signals.filter((signal) => signal.status === 'fail').map((signal) => signal.id)
  const allowed = new Set(['dom-document-all', 'engine-error-stack', 'render-audio'])
  for (const id of failed) assert(allowed.has(id), `unexpected failure ${id}`)
  assert(verdict.proofs.some((proof) => proof.id === 'dom-document-all'), 'document.all is not a proof')
  assert(verdict.level === 'hostile', `level ${verdict.level}`)
  assert(verdict.coverage > 0.8, `coverage ${verdict.coverage}`)
  return `${failed.length} fails, coverage ${verdict.coverage}, proof honoured`
})

await check('empty environment is maximally hostile', () => {
  const verdict = createGuard({ scope: emptyScope() }).evaluate()
  assert(verdict.level === 'hostile', verdict.level)
  assert(verdict.score >= 90, `score ${verdict.score}`)
  assert(verdict.counts.fail >= 25, `only ${verdict.counts.fail} failures`)
  return `score ${verdict.score}, ${verdict.counts.fail} failures`
})

await check('policy thresholds: trusted, guarded, hostile', () => {
  const signals = [
    { id: 'a', layer: 'L1', weight: 10 },
    { id: 'b', layer: 'L1', weight: 10, critical: true },
    { id: 'c', layer: 'L2', weight: 18, critical: true, proof: true },
    { id: 'd', layer: 'L2', weight: 5 },
  ]
  const allPass = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: 'pass', detail: '' })))
  assert(allPass.level === 'trusted', `all-pass level ${allPass.level}`)
  const oneFail = evaluateSignals(signals, signals.map((signal, index) => ({ id: signal.id, status: index === 0 ? 'fail' : 'pass', detail: '' })))
  assert(['guarded', 'suspicious'].includes(oneFail.level), `one-fail level ${oneFail.level}`)
  const twoCritical = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: signal.critical ? 'fail' : 'pass', detail: '' })))
  assert(twoCritical.level === 'hostile', `two-critical level ${twoCritical.level}`)
  const proof = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: signal.proof ? 'fail' : 'pass', detail: '' })))
  assert(proof.level === 'hostile', `proof level ${proof.level}`)
  const unknowns = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: 'unknown', detail: '' })))
  assert(unknowns.confidence === 0, 'unknown-heavy confidence')
  const token = riskToken(proof)
  assert(parseRiskToken(token)?.level === 'hostile', `token ${token}`)
  return '4 policy regimes'
})

// ---------------------------------------------------------------------------
section('6. device identity and drift')

await check('identity is stable across loads and hardware drift changes the token', () => {
  const scope = createFakeBrowser()
  const spn = createWhiteboxSpn({ seed: 'identity', key: fromHex('33'.repeat(32)) })
  const storage = createStorage(scope, 'verify')
  const first = createDeviceIdentity({ probe: createProbe(scope), spn, storage, namespace: 'verify' })
  const second = createDeviceIdentity({ probe: createProbe(scope), spn, storage, namespace: 'verify' })
  assert(first.token === second.token, 'token changed between loads')
  assert(second.seen === 2, `seen ${second.seen}`)

  const wider = createFakeBrowser()
  wider.screen.width = 2560
  wider.screen.availWidth = 2560
  const third = createDeviceIdentity({ probe: createProbe(wider), spn, storage, namespace: 'verify' })
  assert(third.hardwareHash !== first.hardwareHash, 'hardware hash ignored the screen change')
  assert(third.token !== first.token, 'token ignored a hardware change')
  assert(third.drift.hardwareChanged.includes('screen'), 'drift did not attribute the screen change')
  assert(third.drift.verdict !== 'stable', `drift verdict ${third.drift.verdict}`)

  const updated = createFakeBrowser()
  updated.navigator.userAgent = updated.navigator.userAgent.replace('Chrome/126.0.0.0', 'Chrome/127.0.0.0')
  const fourth = createDeviceIdentity({ probe: createProbe(updated), spn, storage, namespace: 'verify' })
  assert(fourth.token === first.token, 'software-only change altered the device token')
  assert(fourth.softwareHash !== first.softwareHash, 'software hash ignored the UA change')
  return `token ${first.token.slice(0, 12)}…`
})

await check('fingerprint collection covers hardware and software classes', () => {
  const collected = collectFingerprint(createProbe(createFakeBrowser()))
  const hashes = hashFingerprint(collected.fields, collected.stability)
  assert(collected.coverage > 0.7, `coverage ${collected.coverage}`)
  assert(hashes.hardwareHash.length === 64 && hashes.softwareHash.length === 64, 'hash length')
  assert(hashes.hardwareHash !== hashes.softwareHash, 'hardware and software hashes identical')
  const drift = compareFingerprints(hashes.hardware, hashes.hardware, collected.stability)
  assert(drift.verdict === 'stable', drift.verdict)
  return `coverage ${collected.coverage}`
})

// ---------------------------------------------------------------------------
section('7. request signing and server verification')

function identityFor(scope, spn, namespace = 'verify-sign') {
  return createDeviceIdentity({ probe: createProbe(scope), spn, storage: createStorage(scope, namespace), namespace })
}

await check('signed request verifies; tamper, replay and skew are rejected', () => {
  const scope = createFakeBrowser()
  const spn = createWhiteboxSpn({ seed: 'sign', key: fromHex('44'.repeat(32)) })
  const identity = identityFor(scope, spn)
  const signer = createSigner({ identity, spn, serverPublicKey, guard: { token: 't0.9' } })
  const verifier = createVerifier({ serverPrivateScalar: serverKeys.d, devices: { [signer.keyId]: signer.publicKey } })
  const request = { method: 'POST', url: 'https://api.example.test/v1/items?b=2&a=1', headers: { 'content-type': 'application/json' }, body: '{"x":1}' }
  const signed = signer.sign(request)
  const first = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
  assert(first.ok, `verify failed: ${first.reasons.join(',')}`)
  const replay = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
  assert(!replay.ok && replay.reasons.includes('replay-detected'), 'replay accepted')

  const tampered = signer.sign(request)
  const bodyTamper = verifier.verify({ ...request, headers: { ...request.headers, ...tampered.headers }, body: '{"x":2}' })
  assert(!bodyTamper.ok && bodyTamper.reasons.includes('signature-invalid'), 'body tamper accepted')
  const riskTamper = verifier.verify({ ...request, headers: { ...request.headers, ...tampered.headers, 'x-nsdk-risk': 'h9.9' }, body: tampered.body })
  assert(!riskTamper.ok, 'risk header tamper accepted')
  const old = signer.sign(request, { timestamp: Date.now() - 10 * 60 * 1000 })
  const oldResult = verifier.verify({ ...request, headers: { ...request.headers, ...old.headers }, body: old.body })
  assert(!oldResult.ok && oldResult.reasons.some((reason) => reason.startsWith('timestamp-too-old')), 'stale request accepted')
  return `${first.reasons.length} reasons on clean request`
})

await check('sealed body verifies and decrypts server-side', () => {
  const scope = createFakeBrowser()
  const spn = createWhiteboxSpn({ seed: 'sign-sealed', key: fromHex('55'.repeat(32)) })
  const identity = identityFor(scope, spn)
  const signer = createSigner({ identity, spn, serverPublicKey, guard: { token: 'g1.8' } })
  const verifier = createVerifier({ serverPrivateScalar: serverKeys.d, devices: { [signer.keyId]: signer.publicKey } })
  const request = { method: 'PUT', url: '/v2/device?z=9&a=1', headers: { 'content-type': 'application/json' }, body: '{"document":"secret"}' }
  const signed = signer.sign(request, { sealBody: true })
  const result = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
  assert(result.ok, `verify failed: ${result.reasons.join(',')}`)
  assert(bytesToUtf8(result.plaintextBody) === request.body, 'plaintext body mismatch')
  assert(signed.layers.length >= 3, 'layer plan too short')
  return `${signed.layers.length} layers: ${signed.layers.join('+')}`
})

// ---------------------------------------------------------------------------
section('8. JSVMP program, bytecode and polymorphism')

const vmKey = fromHex('77'.repeat(32))
const compiled = compileAndValidate(SIGNING_PROGRAM_SOURCE)
const builtVm = buildSigningBlob({ key: vmKey })
const vm = createVm({ blob: builtVm.blob, key: vmKey })
const host = createHostApi()

function vmArgs(request, overrides = {}) {
  const canonical = canonicalRequest(request)
  return {
    h: host,
    method: canonical.method,
    path: canonical.path,
    query: request.query ?? [],
    bodyHash: canonical.bodyHash,
    headers: canonical.headers,
    ts: '1700000000000',
    nonce: 'a'.repeat(32),
    fp: 'DEVICETOKEN000000001',
    risk: 't0.9',
    sessionKey: 'f'.repeat(64),
    ...overrides,
  }
}

await check('VM canonicalisation equals the reference encoder for 60 requests', () => {
  for (let index = 0; index < 60; index += 1) {
    const query = []
    for (let pair = 0; pair < index % 5; pair += 1) query.push([`k${(pair * 7) % 4}`, `v${(index + pair) % 9}`])
    const files = { 'content-type': index % 2 ? 'application/json' : 'text/plain' }
    const queryString = query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
    const request = { method: index % 3 ? 'POST' : 'get', url: `/v1/item/${index}${queryString ? `?${queryString}` : ''}`, headers: files, body: `body-${index}-${'x'.repeat(index % 13)}` }
    const reference = canonicalRequest(request)
    const result = vm.run([vmArgs(request, { query })], { seed: `verify-${index}` })
    assert(result.canonical === reference.canonical, `request ${index} canonical mismatch`)
    const expectedDigest = sm3Hex(signatureBase({
      canonical: reference.canonical,
      timestamp: '1700000000000',
      nonce: 'a'.repeat(32),
      fingerprint: 'DEVICETOKEN000000001',
      risk: 't0.9',
    }))
    assert(result.sigBase === expectedDigest, `request ${index} signature digest mismatch`)
    assert(result.layers.length >= 3 && result.layers.length <= 5, `plan length ${result.layers.length}`)
    assert(new Set(result.layers).size === result.layers.length, 'duplicate layer in plan')
    assert(result.layers.every((layer) => SERVER_LAYERS.includes(layer)), 'invalid layer id')
    assert(result.kid.length === 16, 'vm kid length')
  }
  return '60/60 requests'
})

await check('three dispatch strategies execute and opcode remap varies', () => {
  const variants = new Set()
  const traces = new Set()
  for (let index = 0; index < 40; index += 1) {
    const trace = []
    vm.run([vmArgs({ method: 'GET', url: '/x?a=1', headers: {}, body: '' })], {
      seed: `variant-${index}`,
      trace: (event) => {
        variants.add(event.variant)
        trace.push(`${event.pc}:${event.runtime}:${event.handler}`)
      },
    })
    traces.add(trace.slice(0, 8).join('|'))
  }
  assert(variants.size === 3, `only ${variants.size} variants observed`)
  assert(traces.size > 30, `only ${traces.size} distinct opcode prefixes`)
  return `${variants.size} variants, ${traces.size} remaps`
})

await check('bytecode container is encrypted and authenticated', () => {
  const serialized = JSON.stringify(builtVm.blob)
  for (const marker of ['canonical', 'sigBase', 'nsdk', 'LAYER', 'CONST', 'RETURN', 'signing']) {
    assert(!serialized.includes(marker), `blob contains plaintext marker '${marker}'`)
  }
  const tampered = { ...builtVm.blob, sum: '00'.repeat(32) }
  expectThrow(() => createVm({ blob: tampered, key: vmKey }), 'checksum tamper accepted')
  const decoded = decodeBlob(builtVm.blob, vmKey)
  assert(disassemble(decoded).length === builtVm.program.instructions.length, 'disassembler length')
  return `${builtVm.program.instructions.length} instructions, ${builtVm.blob.code.length} container bytes`
})

// ---------------------------------------------------------------------------
section('9. protected builds (host + QuickJS sandbox)')

const buildSeeds = ['1001', '1002', '1003']
const reuseBuilds = process.argv.includes('--no-build')
let buildResults
if (reuseBuilds) {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'dist/manifest.json'), 'utf8'))
  buildResults = []
  for (const seed of buildSeeds) {
    const entry = manifest.builds.find((build) => build.seed === seed)
    if (!entry) throw new Error(`dist/manifest.json has no build for seed ${seed}`)
    buildResults.push({ seed, manifest: entry, code: await readFile(path.join(ROOT, entry.file), 'utf8') })
  }
} else {
  buildResults = await buildVariants({ seeds: buildSeeds })
}
const hostRuns = []
for (const build of buildResults) {
  await check(`build ${build.seed}: runs on the host and verifies a sealed request`, () => {
    const code = build.code
    for (const marker of ['x-nsdk-sig', 'createSdk', 'SERVER_LAYERS', 'nsdk/device/v1', 'document.all', '__nsdk_m_', '__nsdk_s']) {
      assert(!code.includes(marker), `bundle leaks '${marker}'`)
    }
    assert(!code.includes('function __nsdk_m_'), 'module boundaries survived obfuscation')
    const context = runBundleInNodeVm(code)
    assert(context.NSDK && typeof context.NSDK.create === 'function', 'NSDK.create missing')
    const sdk = context.NSDK.create({ serverPublicKey })
    const request = { method: 'POST', url: 'https://api.example.test/v1/items?b=2&a=1', headers: { 'content-type': 'application/json' }, body: '{"x":1}' }
    const signed = sdk.sign(request, { sealBody: true })
    const verifier = createVerifier({ serverPrivateScalar: serverKeys.d, devices: { [sdk.keyId]: sdk.publicKey } })
    const result = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
    assert(result.ok, `verify failed: ${result.reasons.join(',')}`)
    assert(bytesToUtf8(result.plaintextBody) === request.body, 'sealed body mismatch')
    assert(sdk.selfTest().ok, 'self-test failed')
    hostRuns.push({ seed: build.seed, sdk, signed, result, code })
    return `${(code.length / 1024).toFixed(0)} KB, kid ${sdk.keyId}`
  })
}

await check('builds are byte-different and share no opcode permutation', () => {
  const hashes = new Set(buildResults.map((build) => build.manifest.sha256))
  const permutations = new Set(buildResults.map((build) => build.manifest.vm.perm.join(',')))
  assert(hashes.size === buildResults.length, 'duplicate build hashes')
  assert(permutations.size === buildResults.length, 'duplicate opcode permutations')
  for (const build of buildResults) {
    assert(build.manifest.vm.instructions === compiled.instructions.length, 'instruction count drift')
  }
  return `${hashes.size} hashes, ${permutations.size} permutations`
})

let sandboxEvidence = null
await check('build 1001: signs and verifies inside the QuickJS sandbox', async () => {
  const build = buildResults[0]
  const request = { method: 'POST', url: 'https://api.example.test/v1/items?b=2&a=1', headers: { 'content-type': 'application/json' }, body: '{"x":1}' }
  const run = await runBundleInSandbox({ code: build.code, serverPublicKey, request })
  const result = run.result
  assert(result.selfTest.ok, 'sandbox self-test failed')
  assert(result.vm === true, 'VM not active in sandbox')
  assert(result.storage === 'localStorage', `storage ${result.storage}`)
  assert(result.fingerprintCoverage > 0.5, `fingerprint coverage ${result.fingerprintCoverage}`)
  assert(result.layers.length >= 3, 'layer plan too short')
  assert(result.guard.documentAll.status === 'fail', 'document.all unexpectedly passed in QuickJS')
  assert(result.guard.level === 'hostile', `guard level ${result.guard.level}`)
  assert(result.guard.evidence.includes('dom-document-all'), 'document.all missing from evidence')
  // The QuickJS clock is the harness's virtual clock, which intentionally does
  // not track wall time; pin the verifier's clock to the signed timestamp so the
  // cryptographic checks (signature, MAC, envelope) are exercised for real.
  const sandboxNow = Number(result.headers['x-nsdk-ts'])
  const verifier = createVerifier({
    serverPrivateScalar: serverKeys.d,
    devices: { [result.kid]: result.publicKey },
    now: () => sandboxNow + 1,
  })
  const verified = verifier.verify({ ...request, headers: { ...request.headers, ...result.headers }, body: result.body })
  assert(verified.ok, `verify failed: ${verified.reasons.join(',')}`)
  assert(bytesToUtf8(verified.plaintextBody) === request.body, 'sandbox sealed body mismatch')
  sandboxEvidence = { result, events: run.events.length, disposal: run.disposal }
  return `hostile by document.all proof; signature valid; ${result.layers.join('+')}`
})

// ---------------------------------------------------------------------------
section('10. platform analysis of the protected artifact')

await check('platform analyze produces a report for the bundle', async () => {
  const build = buildResults[0]
  const analysis = await analyzeSample(build.code, {
    name: `nsdk-${build.seed}.js`,
    logLevel: 'silent',
    env: { strict: true },
    seed: 0x5eed,
    limits: { timeoutMs: 60_000, memoryBytes: 256 * 1024 * 1024 },
    instrumentation: { code: { level: 'off' } },
  })
  assert(analysis.report.dynamic.ok, `dynamic run failed: ${JSON.stringify(analysis.report.dynamic.error)}`)
  assert(analysis.report.sample.sha256.length === 64, 'sample hash')
  assert(analysis.report.static.techniques.length > 0, 'no techniques detected')
  assert(analysis.report.verdict.score >= 0, 'verdict score')
  return `verdict ${analysis.report.verdict.level} (${analysis.report.verdict.score}), ${analysis.report.static.techniques.length} techniques`
})

// ---------------------------------------------------------------------------
const passed = checks.filter((entry) => entry.ok).length
const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${passed}/${checks.length} checks passed`)
if (sandboxEvidence) {
  console.log(`sandbox: ${sandboxEvidence.events} trace events, disposal ${JSON.stringify(sandboxEvidence.disposal)}`)
}
if (failed.length > 0) {
  console.error(`\n${failed.length} failing checks:`)
  for (const entry of failed) console.error(` - ${entry.name}: ${entry.detail}`)
  process.exit(1)
}
