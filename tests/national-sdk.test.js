/**
 * National JS-SDK — platform integration tests.
 *
 * The SDK lives in `examples/national-sdk/` as a self-contained project. This
 * file tests it at three levels:
 *
 *  1. unit level: published crypto vectors, white-box equivalence, hybrid
 *     envelopes, guard policy and device identity;
 *  2. platform level: the protected bundle runs inside the QuickJS sandbox and
 *     its signature verifies, while the guard correctly flags the sandbox's
 *     unfakeable missing `document.all`;
 *  3. revalidation level: `examples/national-sdk/verify.mjs` rebuilds every
 *     artifact and runs the full evidence matrix; a failure there fails this
 *     suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  createFakeBrowser,
  emptyScope,
  runBundleInNodeVm,
  runBundleInSandbox,
} from '../examples/national-sdk/testing/fixtures.mjs'
import { fromHex, toHex, utf8ToBytes, bytesToUtf8 } from '../examples/national-sdk/src/core/bytes.js'
import { sm3Hex, hmacSm3, kdfSm3 } from '../examples/national-sdk/src/core/hash.js'
import { sm4EncryptBlock } from '../examples/national-sdk/src/core/sm4.js'
import { aesEncryptBlock } from '../examples/national-sdk/src/core/aes.js'
import {
  generateKeyPair,
  hexToBig,
  scalarMultiply,
  sm2Sign,
  sm2Verify,
  bigToHex,
} from '../examples/national-sdk/src/core/sm2.js'
import { WHITEBOX_SUITES, SERVER_LAYERS, instantiateWhitebox } from '../examples/national-sdk/src/core/variants.js'
import { createWhiteboxAes } from '../examples/national-sdk/src/core/whitebox/aes-wb.js'
import { createWhiteboxSm4 } from '../examples/national-sdk/src/core/whitebox/sm4-wb.js'
import { createWhiteboxSpn } from '../examples/national-sdk/src/core/whitebox/spn-wb.js'
import { createMutantAes, createMutantSm4, createRc6Like, createMagmaLike } from '../examples/national-sdk/src/core/custom.js'
import { sealEnvelope, openEnvelope, envelopeToString, parseEnvelopeString, sealLocal, openLocal } from '../examples/national-sdk/src/core/hybrid.js'
import { createGuard } from '../examples/national-sdk/src/guard/index.js'
import { createProbe } from '../examples/national-sdk/src/guard/probe.js'
import { probeDocumentAll } from '../examples/national-sdk/src/guard/document-all.js'
import { evaluateSignals, riskToken, parseRiskToken } from '../examples/national-sdk/src/guard/policy.js'
import { createDeviceIdentity, createStorage } from '../examples/national-sdk/src/fingerprint/device-token.js'
import { createVault } from '../examples/national-sdk/src/core/vault.js'
import { createSigner } from '../examples/national-sdk/src/signing/sign.js'
import { canonicalRequest } from '../examples/national-sdk/src/signing/canonical.js'
import { createVerifier } from '../examples/national-sdk/server/verify.mjs'
import { compileAndValidate, buildSigningBlob, createVm, SIGNING_PROGRAM_SOURCE } from '../examples/national-sdk/src/vm/index.js'
import { createHostApi } from '../examples/national-sdk/src/vm/host.js'
import { buildSdk } from '../examples/national-sdk/build/build-sdk.mjs'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SDK = `${ROOT}examples/national-sdk`
const serverKeys = generateKeyPair()
const serverPublicKey = serverKeys.publicHex

function identityFor(scope, spn, namespace) {
  return createDeviceIdentity({
    probe: createProbe(scope),
    spn,
    storage: createStorage(scope, namespace),
    namespace,
  })
}

test('published vectors: SM3, SM4, AES and SM2', () => {
  assert.equal(sm3Hex('abc'), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
  assert.equal(
    sm3Hex('abcd'.repeat(16)),
    'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732',
  )
  const key = fromHex('0123456789abcdeffedcba9876543210')
  assert.equal(toHex(sm4EncryptBlock(key, key)), '681edf34d206965e86b3e94f536e4246')
  assert.equal(
    toHex(aesEncryptBlock(fromHex('000102030405060708090a0b0c0d0e0f'), fromHex('00112233445566778899aabbccddeeff'))),
    '69c4e0d86a7b0430d8cdb78070b4c55a',
  )
  const d = hexToBig('3945208F7B2144B13F36E38AC6D39F95889393692860B51A42FB81EF4DF7C5B8')
  const publicKey = scalarMultiply(d)
  assert.equal(bigToHex(publicKey.x), '09f9df311e5421a150dd7d161e4bc5c672179fad1833fc076bb08ff356f35020')
  const signature = sm2Sign(utf8ToBytes('message digest'), d, {
    k: hexToBig('59276E27D506861A16680F3AD9C02DCCEF3CC1FA3CDBE4CE6D54B80DEAC1BC21'),
    publicKey,
  })
  assert.equal(bigToHex(signature.r), 'f5a03b0648d2c4630eeac513e1bb81a15944da3827d5b74143ac7eaceee720b3')
  assert.equal(bigToHex(signature.s), 'b1b6aa29df212fd8763182bc0d421ca1bb9038fd1f7f42d4840b69c485bbc1aa')
  assert.equal(sm2Verify(utf8ToBytes('message digest'), signature.hex, publicKey), true)
  assert.equal(sm2Verify(utf8ToBytes('message digesT'), signature.hex, publicKey), false)
})

test('all white-box suites are dynamic, implicit-key and match the reference cipher', () => {
  const aesKey = fromHex('00112233445566778899aabbccddeeff')
  const sm4Key = fromHex('0123456789abcdeffedcba9876543210')
  const block = fromHex('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  const ids = new Set()
  for (const suite of WHITEBOX_SUITES) {
    const instance = instantiateWhitebox(suite.id, `test-${suite.id}`)
    assert.equal(instance.meta.implicitKey, true, suite.id)
    ids.add(instance.meta.suiteId)
    if (suite.family === 'whitebox-aes-128') {
      const wb = createWhiteboxAes({ seed: `test-${suite.id}`, key: aesKey })
      assert.equal(toHex(wb.encryptBlock(block)), toHex(aesEncryptBlock(aesKey, block)), suite.id)
      assert.ok(!JSON.stringify(wb).includes(toHex(aesKey)), `${suite.id} leaks the key`)
    } else if (suite.family === 'whitebox-sm4') {
      const wb = createWhiteboxSm4({ seed: `test-${suite.id}`, key: sm4Key })
      assert.equal(toHex(wb.encryptBlock(block)), toHex(sm4EncryptBlock(sm4Key, block)), suite.id)
      assert.ok(!JSON.stringify(wb).includes(toHex(sm4Key)), `${suite.id} leaks the key`)
    } else {
      assert.equal(toHex(instance.decryptBlock(instance.encryptBlock(block))), toHex(block), suite.id)
    }
  }
  assert.equal(ids.size, WHITEBOX_SUITES.length, 'suite ids must be distinct per parameterisation')
})

test('the device vault rotates white-box suites and authenticates state', () => {
  const vault = createVault({ buildSalt: 'vault-test', spnKeyHex: '9a'.repeat(32) })
  const suites = new Set()
  for (const [index, suiteId] of ['wb-aes/a', 'wb-sm4/b', 'wb-spn/c'].entries()) {
    const envelope = vault.seal(`state-${index}`, {
      suiteId,
      nonce: fromHex('00'.repeat(15) + (index + 1).toString(16).padStart(2, '0')),
      salt: fromHex((index + 1).toString(16).padStart(16, '0')),
    })
    assert.equal(envelope.suite, suiteId)
    assert.equal(vault.openText(envelope), `state-${index}`)
    suites.add(envelope.suite)
  }
  assert.equal(suites.size, 3)
  const sample = vault.seal('tamper', { suiteId: 'wb-aes/a', nonce: fromHex('02'.repeat(16)), salt: fromHex('03'.repeat(8)) })
  assert.throws(() => vault.open({ ...sample, suite: 'wb-sm4/a' }), /authentication/)
  assert.throws(() => vault.open({ ...sample, tag: '00'.repeat(32) }), /authentication/)
})

test('mutated ciphers round-trip and avalanche', () => {
  const factories = [
    ['mutant-aes', createMutantAes, 16],
    ['mutant-sm4', createMutantSm4, 16],
    ['rc6-like', createRc6Like, 16],
    ['magma-like', createMagmaLike, 8],
  ]
  for (const [name, factory, size] of factories) {
    for (let index = 0; index < 4; index += 1) {
      const cipher = factory({ seed: `${name}-${index}` })
      const block = fromHex(toHex(utf8ToBytes(`${name}-${index}`)).padEnd(size * 2, '7').slice(0, size * 2))
      assert.equal(toHex(cipher.decryptBlock(cipher.encryptBlock(block))), toHex(block), `${name}/${index}`)
    }
  }
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
  assert.ok(bits >= 32, `avalanche ${bits} bits`)
})

test('hybrid envelopes round-trip, vary their plan and reject tampering', () => {
  const plans = new Set()
  for (let index = 0; index < 10; index += 1) {
    const nonce = fromHex('00'.repeat(15) + index.toString(16).padStart(2, '0'))
    const plaintext = utf8ToBytes(`payload-${index}-${'x'.repeat(index * 5)}`)
    const envelope = sealEnvelope(plaintext, {
      serverPublicKey,
      ephemeralScalar: hexToBig((BigInt(1000) + BigInt(index) * 7919n).toString(16)),
      nonce,
      kid: 'device-1',
    })
    assert.equal(toHex(openEnvelope(envelope, serverKeys.d)), toHex(plaintext))
    assert.ok(envelope.layers.length >= 3 && envelope.layers.length <= 5)
    assert.ok(envelope.layers.every((layer) => SERVER_LAYERS.includes(layer)))
    plans.add(envelope.layers.join(','))
  }
  assert.ok(plans.size >= 5, `only ${plans.size} plans`)

  const envelope = sealEnvelope('tamper me', {
    serverPublicKey,
    ephemeralScalar: 12345n,
    nonce: fromHex('01'.repeat(16)),
  })
  assert.throws(() => openEnvelope({ ...envelope, ct: `${envelope.ct.slice(0, -1)}${envelope.ct.endsWith('a') ? 'b' : 'a'}` }, serverKeys.d), /authentication/)
  assert.throws(() => openEnvelope({ ...envelope, layers: [...envelope.layers].reverse() }, serverKeys.d), /authentication/)
  assert.throws(() => openEnvelope({ ...envelope, tag: 'ff'.repeat(32) }, serverKeys.d), /authentication/)
  const parsed = parseEnvelopeString(envelopeToString(envelope))
  assert.equal(toHex(openEnvelope(parsed, serverKeys.d)), toHex(utf8ToBytes('tamper me')))
})

test('local white-box sealing is authenticated and device-bound', () => {
  const spn = createWhiteboxSpn({ seed: 'local-test', key: fromHex('11'.repeat(32)) })
  const other = createWhiteboxSpn({ seed: 'local-test', key: fromHex('22'.repeat(32)) })
  const envelope = sealLocal('state', { spn, nonce: fromHex('02'.repeat(16)), kid: 'k' })
  assert.equal(bytesToUtf8(openLocal(envelope, { spn })), 'state')
  assert.throws(() => openLocal(envelope, { spn: other }), /authentication/)
})

test('document.all is proof-grade; a synthetic browser fails it while passing everything else', () => {
  const probe = createProbe(createFakeBrowser())
  const direct = probeDocumentAll(probe)
  assert.equal(direct.status, 'fail')
  assert.ok(direct.checks.some((entry) => entry.id === 'typeof-undefined' && entry.ok === false))

  const verdict = createGuard({ scope: createFakeBrowser() }).evaluate()
  const failed = verdict.signals.filter((signal) => signal.status === 'fail').map((signal) => signal.id)
  assert.ok(failed.includes('dom-document-all'))
  assert.ok(verdict.proofs.some((proof) => proof.id === 'dom-document-all'))
  assert.equal(verdict.level, 'hostile')
  assert.ok(verdict.coverage > 0.8)
  const unexpected = failed.filter((id) => !['dom-document-all', 'engine-error-stack', 'render-audio'].includes(id))
  assert.deepEqual(unexpected, [])

  const empty = createGuard({ scope: emptyScope() }).evaluate()
  assert.equal(empty.level, 'hostile')
  assert.ok(empty.score >= 90)
})

test('zero-trust policy reaches trusted, guarded and hostile without a proof', () => {
  const signals = [
    { id: 'a', layer: 'L1', weight: 10 },
    { id: 'b', layer: 'L1', weight: 10, critical: true },
    { id: 'c', layer: 'L2', weight: 18, critical: true, proof: true },
  ]
  const allPass = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: 'pass', detail: '' })))
  assert.equal(allPass.level, 'trusted')
  const oneFail = evaluateSignals(signals, signals.map((signal, index) => ({ id: signal.id, status: index === 0 ? 'fail' : 'pass', detail: '' })))
  assert.ok(['guarded', 'suspicious'].includes(oneFail.level))
  const twoCritical = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: signal.critical ? 'fail' : 'pass', detail: '' })))
  assert.equal(twoCritical.level, 'hostile')
  const proof = evaluateSignals(signals, signals.map((signal) => ({ id: signal.id, status: signal.proof ? 'fail' : 'pass', detail: '' })))
  assert.equal(proof.level, 'hostile')
  assert.equal(parseRiskToken(riskToken(proof)).level, 'hostile')
})

test('device identity is stable, hardware-sensitive and software-tolerant', () => {
  const scope = createFakeBrowser()
  const spn = createWhiteboxSpn({ seed: 'identity-test', key: fromHex('33'.repeat(32)) })
  const storage = createStorage(scope, 'test-identity')
  const first = createDeviceIdentity({ probe: createProbe(scope), spn, storage, namespace: 'test-identity' })
  const second = createDeviceIdentity({ probe: createProbe(scope), spn, storage, namespace: 'test-identity' })
  assert.equal(first.token, second.token)
  assert.equal(second.seen, 2)

  const wider = createFakeBrowser()
  wider.screen.width = 2560
  const hardware = createDeviceIdentity({ probe: createProbe(wider), spn, storage, namespace: 'test-identity' })
  assert.notEqual(hardware.token, first.token)
  assert.notEqual(hardware.drift.verdict, 'stable')

  const upgraded = createFakeBrowser()
  upgraded.navigator.userAgent = upgraded.navigator.userAgent.replace('Chrome/126.0.0.0', 'Chrome/127.0.0.0')
  const software = createDeviceIdentity({ probe: createProbe(upgraded), spn, storage, namespace: 'test-identity' })
  assert.equal(software.token, first.token)
  assert.notEqual(software.softwareHash, first.softwareHash)
})

test('request signatures verify, and replay/tamper/skew are rejected', () => {
  const scope = createFakeBrowser()
  const spn = createWhiteboxSpn({ seed: 'sign-test', key: fromHex('44'.repeat(32)) })
  const identity = identityFor(scope, spn, 'test-sign')
  const signer = createSigner({ identity, spn, serverPublicKey, guard: { token: 't0.9' } })
  const verifier = createVerifier({ serverPrivateScalar: serverKeys.d, devices: { [signer.keyId]: signer.publicKey } })
  const request = {
    method: 'POST',
    url: 'https://api.example.test/v1/items?b=2&a=1',
    headers: { 'content-type': 'application/json' },
    body: '{"x":1}',
  }
  const signed = signer.sign(request, { sealBody: true })
  assert.equal(signed.signedDigest, sm3Hex(signed.signatureBase))
  const clean = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
  assert.equal(clean.ok, true, clean.reasons.join(','))
  assert.equal(bytesToUtf8(clean.plaintextBody), request.body)
  assert.ok(signed.layers.length >= 3)

  const replay = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
  assert.equal(replay.ok, false)
  assert.ok(replay.reasons.includes('replay-detected'))

  const tampered = signer.sign(request)
  const bodyTamper = verifier.verify({ ...request, headers: { ...request.headers, ...tampered.headers }, body: '{"x":2}' })
  assert.equal(bodyTamper.ok, false)
  const riskTamper = verifier.verify({
    ...request,
    headers: { ...request.headers, ...tampered.headers, 'x-nsdk-risk': 'h9.9' },
    body: tampered.body,
  })
  assert.equal(riskTamper.ok, false)
  const stale = signer.sign(request, { timestamp: Date.now() - 10 * 60 * 1000 })
  const staleResult = verifier.verify({ ...request, headers: { ...request.headers, ...stale.headers }, body: stale.body })
  assert.equal(staleResult.ok, false)
  assert.ok(staleResult.reasons.some((reason) => reason.startsWith('timestamp-too-old')))
})

test('VM program matches the reference canonicaliser, uses all dispatch variants and hides its bytecode', () => {
  const key = fromHex('77'.repeat(32))
  const { blob, program } = buildSigningBlob({ key })
  const vm = createVm({ blob, key })
  const host = createHostApi()
  const variants = new Set()
  const traces = new Set()
  for (let index = 0; index < 20; index += 1) {
    const query = [['b', String(index)], ['a', '1']]
    const url = `/v1/x?${query.map(([name, value]) => `${name}=${value}`).join('&')}`
    const request = { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: `{"i":${index}}` }
    const canonical = canonicalRequest(request)
    const trace = []
    const result = vm.run(
      [
        {
          h: host,
          method: canonical.method,
          path: canonical.path,
          query,
          bodyHash: canonical.bodyHash,
          headers: canonical.headers,
          ts: '1700000000000',
          nonce: 'a'.repeat(32),
          fp: 'DEVICE000000000001',
          risk: 't0.9',
          sessionKey: 'f'.repeat(64),
        },
      ],
      {
        seed: `test-${index}`,
        trace: (event) => {
          variants.add(event.variant)
          trace.push(`${event.pc}:${event.runtime}`)
        },
      },
    )
    assert.equal(result.canonical, canonical.canonical)
    assert.ok(result.layers.length >= 3 && result.layers.length <= 5)
    assert.equal(result.kid.length, 16)
    traces.add(trace.slice(0, 8).join('|'))
  }
  assert.equal(variants.size, 3)
  assert.ok(traces.size >= 15)
  const serialized = JSON.stringify(blob)
  for (const marker of ['canonical', 'sigBase', 'nsdk', 'signing']) {
    assert.ok(!serialized.includes(marker), `blob leaks ${marker}`)
  }
  assert.ok(program.instructions.length > 300)
})

test('protected build runs on the host and in the QuickJS sandbox, and is polymorphic', async () => {
  const outDir = path.join(tmpdir(), `nsdk-test-builds-${process.pid}`)
  const first = await buildSdk({ seed: 'test-a', root: SDK, outDir })
  const second = await buildSdk({ seed: 'test-b', root: SDK, outDir })
  assert.notEqual(first.manifest.sha256, second.manifest.sha256)
  assert.notEqual(first.manifest.vm.perm.join(','), second.manifest.vm.perm.join(','))
  for (const build of [first, second]) {
    for (const marker of ['x-nsdk-sig', 'createSdk', 'SERVER_LAYERS', 'nsdk/device/v1', 'document.all', '__nsdk_m_', '__nsdk_s']) {
      assert.ok(!build.code.includes(marker), `bundle leaks ${marker}`)
    }
    const context = runBundleInNodeVm(build.code)
    const sdk = context.NSDK.create({ serverPublicKey })
    assert.equal(sdk.selfTest().ok, true)
    const request = { method: 'GET', url: '/v1/ping?z=1', headers: {}, body: '' }
    const signed = sdk.sign(request)
    const verifier = createVerifier({ serverPrivateScalar: serverKeys.d, devices: { [sdk.keyId]: sdk.publicKey } })
    const result = verifier.verify({ ...request, headers: { ...request.headers, ...signed.headers }, body: signed.body })
    assert.equal(result.ok, true, result.reasons.join(','))
  }

  const sandbox = await runBundleInSandbox({
    code: first.code,
    serverPublicKey,
    request: { method: 'POST', url: '/v1/sandbox?b=2&a=1', headers: { 'content-type': 'application/json' }, body: '{"sandbox":true}' },
  })
  assert.equal(sandbox.result.selfTest.ok, true)
  assert.equal(sandbox.result.vm, true)
  assert.equal(sandbox.result.storage, 'localStorage')
  assert.ok(sandbox.result.fingerprintCoverage > 0.5)
  assert.equal(sandbox.result.guard.documentAll.status, 'fail')
  assert.equal(sandbox.result.guard.level, 'hostile')
  assert.ok(sandbox.result.guard.evidence.includes('dom-document-all'))
  const verifier = createVerifier({
    serverPrivateScalar: serverKeys.d,
    devices: { [sandbox.result.kid]: sandbox.result.publicKey },
    now: () => Number(sandbox.result.headers['x-nsdk-ts']) + 1,
  })
  const verified = verifier.verify({
    method: 'POST',
    url: '/v1/sandbox?b=2&a=1',
    headers: { 'content-type': 'application/json', ...sandbox.result.headers },
    body: sandbox.result.body,
  })
  assert.equal(verified.ok, true, verified.reasons.join(','))
  assert.equal(bytesToUtf8(verified.plaintextBody), '{"sandbox":true}')
  assert.deepEqual(sandbox.disposal, { ok: true, errors: [] })
})

test('verify.mjs matrix passes end-to-end', async () => {
  const { stdout } = await exec(process.execPath, [`${SDK}/verify.mjs`], {
    cwd: SDK,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.match(stdout, /checks passed/)
  const summary = /(\d+)\/(\d+) checks passed/.exec(stdout)
  assert.ok(summary, stdout.slice(-2000))
  assert.equal(summary[1], summary[2], `failing checks:\n${stdout.slice(0, 4000)}`)
})
