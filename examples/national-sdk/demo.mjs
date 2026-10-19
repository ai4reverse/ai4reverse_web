#!/usr/bin/env node
/**
 * SDK demo (host side).
 *
 * Uses the synthetic-browser fixture so every subsystem can run in Node. The
 * guard still reports `hostile` because `document.all` cannot be faked — that
 * is the expected, documented result, and it is printed as evidence rather than
 * hidden.
 *
 *   node examples/national-sdk/demo.mjs
 */

import { createDevelopmentSdk } from './src/index.js'
import { createFakeBrowser } from './testing/fixtures.mjs'
import { createVerifier } from './server/verify.mjs'
import { generateKeyPair } from './src/core/sm2.js'
import { bytesToUtf8 } from './src/core/bytes.js'

const server = generateKeyPair()
const scope = createFakeBrowser()
const sdk = createDevelopmentSdk({ scope, serverPublicKey: server.publicHex })

const verdict = sdk.guard()
console.log(`guard: level=${verdict.level} score=${verdict.score} token=${verdict.token} coverage=${verdict.coverage}`)
console.log(`guard evidence: ${verdict.evidence.map((entry) => entry.id).join(', ')}`)
const documentAll = verdict.signals.find((signal) => signal.id === 'dom-document-all')
console.log(`document.all: ${documentAll.status} (${documentAll.detail})`)

const fingerprint = sdk.fingerprint()
console.log(`device: kid=${sdk.keyId} token=${sdk.token} vault=${fingerprint.vaultSuite} fields=${Object.keys(fingerprint.fields).length} coverage=${fingerprint.coverage}`)
console.log(`catalogue: ${sdk.catalogue().whiteboxes.length} white-box suites, ${sdk.catalogue().layers.length} envelope layers`)

const request = {
  method: 'POST',
  url: 'https://api.example.test/v1/orders?b=2&a=1',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ order: 'A-1001', amount: 42 }),
}
const signed = sdk.sign(request, { sealBody: true })
console.log(`sign: layers=${signed.layers.join('+')} nonce=${signed.nonce.slice(0, 8)}… signature=${signed.signature.slice(0, 16)}…`)
console.log(`headers: ${Object.keys(signed.headers).join(', ')}`)

const verifier = createVerifier({ serverPrivateScalar: server.d, devices: { [sdk.keyId]: sdk.publicKey } })
const checked = verifier.verify({
  ...request,
  headers: { ...request.headers, ...signed.headers },
  body: signed.body,
})
console.log(`server verify: ok=${checked.ok} reasons=[${checked.reasons.join(',')}] risk=${checked.risk?.level}`)
console.log(`sealed body round-trip: ${bytesToUtf8(checked.plaintextBody) === request.body}`)

const selfTest = sdk.selfTest()
console.log(`self-test: ok=${selfTest.ok} (${selfTest.results.map((entry) => `${entry.id}:${entry.ok}`).join(' ')})`)

// Demonstrate the raw VM a little: opcode remapping differs per run even though
// the canonical output is identical. (A sealed request deliberately has a
// different canonical string: it covers the transmitted envelope.)
const first = sdk.sign(request).vm
const second = sdk.sign(request).vm
console.log(`vm: canonical stable=${first.canonical === second.canonical} plan=${first.layers.join('+')} kid=${first.kid}`)
