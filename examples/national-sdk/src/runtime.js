/**
 * SDK runtime.
 *
 * Composition only: the runtime wires the white-box key material, the guard,
 * the device identity, the VM and the signer into one object. It contains no
 * cryptographic logic of its own, which keeps the protected bundle small and
 * makes the security-relevant code reviewable in its modules.
 */

import { bytesToUtf8, fromHex, toHex } from './core/bytes.js'
import { sm3Hex, kdfSm3 } from './core/hash.js'
import { aesEncryptBlock } from './core/aes.js'
import { sm4EncryptBlock } from './core/sm4.js'
import { createWhiteboxAes } from './core/whitebox/aes-wb.js'
import { createWhiteboxSm4 } from './core/whitebox/sm4-wb.js'
import { createWhiteboxSpn } from './core/whitebox/spn-wb.js'
import { createCatalogue } from './core/variants.js'
import { createVault } from './core/vault.js'
import { createProbe } from './guard/probe.js'
import { createGuard } from './guard/index.js'
import { createStorage, createDeviceIdentity } from './fingerprint/device-token.js'
import { createSigner, deriveDeviceKey } from './signing/sign.js'
import { createVmFromSpn } from './vm/interpreter.js'
import { createHostApi } from './vm/host.js'

export const SDK_VERSION = '1.0.0'

/**
 * Default development white-box key. A production build replaces it with a
 * per-build value (see `build/build-sdk.mjs`); it is not a secret against an
 * attacker who owns the bundle, and the docs say so.
 */
export const DEV_SPN_KEY = '6e73646b2d6465762d7768697465626f782d6b65792d30303132323333343535'

/**
 * @param {object} options
 * @param {string|{x: bigint, y: bigint}} options.serverPublicKey
 * @param {object} [options.scope] global object (tests inject a synthetic one)
 * @param {string} [options.namespace]
 * @param {string} [options.buildSalt]
 * @param {string} [options.spnKeyHex]
 * @param {Uint8Array|number[]} [options.installSecret] provisioned device secret
 * @param {object} [options.vmBlob] precompiled signing program
 * @param {object} [options.vm] explicit VM instance
 * @param {() => number} [options.now]
 * @param {object} [options.probe]
 */
export function createSdk(options = {}) {
  if (!options.serverPublicKey) throw new TypeError('createSdk requires serverPublicKey')
  const scope = options.scope ?? (typeof globalThis !== 'undefined' ? globalThis : {})
  const buildSalt = options.buildSalt ?? 'nsdk-dev-build'
  const spnKeyHex = options.spnKeyHex ?? DEV_SPN_KEY
  const namespace = options.namespace ?? 'nsdk'
  const probe = options.probe ?? createProbe(scope)

  const spn = createWhiteboxSpn({
    seed: `${buildSalt}::device-spn`,
    key: fromHex(spnKeyHex),
  })
  const guard = createGuard({ probe })
  const storage = createStorage(scope, namespace)
  const vault = createVault({ buildSalt, spnKeyHex })
  const identity = createDeviceIdentity({
    probe,
    spn,
    vault,
    storage,
    namespace,
    installSecret: options.installSecret,
  })
  const vm =
    options.vm ??
    (options.vmBlob ? createVmFromSpn({ blob: options.vmBlob, spn, label: 'signing' }) : null)
  const signer = createSigner({
    identity,
    spn,
    serverPublicKey: options.serverPublicKey,
    guard,
    vm,
    now: options.now,
  })
  const deviceKey = deriveDeviceKey(identity, spn)
  const catalogue = createCatalogue({ seed: identity.stableHash })

  function selfTest() {
    const results = []
    // Known-answer tests for the primitives with published vectors.
    results.push({ id: 'sm3-vector', ok: sm3Hex('abc') === '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0' })
    results.push({
      id: 'sm4-vector',
      ok:
        toHex(sm4EncryptBlock(fromHex('0123456789abcdeffedcba9876543210'), fromHex('0123456789abcdeffedcba9876543210'))) ===
        '681edf34d206965e86b3e94f536e4246',
    })
    // Table integrity: a freshly generated white-box must agree with the
    // reference cipher for the same key.
    const testKey = fromHex('00112233445566778899aabbccddeeff')
    const block = fromHex('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    const wbAes = createWhiteboxAes({ seed: `${buildSalt}::selftest-aes`, key: testKey })
    results.push({ id: 'whitebox-aes', ok: toHex(wbAes.encryptBlock(block)) === toHex(aesEncryptBlock(testKey, block)) })
    const sm4Key = fromHex('0123456789abcdeffedcba9876543210')
    const wbSm4 = createWhiteboxSm4({ seed: `${buildSalt}::selftest-sm4`, key: sm4Key })
    results.push({ id: 'whitebox-sm4', ok: toHex(wbSm4.encryptBlock(block)) === toHex(sm4EncryptBlock(sm4Key, block)) })
    const testSpn = createWhiteboxSpn({ seed: `${buildSalt}::selftest-spn`, key: fromHex('ab'.repeat(32)) })
    results.push({ id: 'whitebox-spn', ok: toHex(testSpn.decryptBlock(testSpn.encryptBlock(block))) === toHex(block) })
    const vaultSample = vault.seal('vault-selftest', { nonce: fromHex('00'.repeat(16)), salt: fromHex('11'.repeat(8)) })
    results.push({ id: 'vault', ok: bytesToUtf8(vault.open(vaultSample)) === 'vault-selftest' })
    results.push({ id: 'vault-suite', ok: typeof vaultSample.suite === 'string' && vaultSample.suite.startsWith('wb-') })
    if (vm) {
      const sample = vm.run(
        [
          {
            h: createHostApi(),
            method: 'GET',
            path: '/selftest',
            query: [['b', '2'], ['a', '1']],
            bodyHash: toHex(new Uint8Array(32)),
            headers: [],
            ts: '0',
            nonce: '00'.repeat(16),
            fp: 'SELFTEST000000000000',
            risk: 't0.0',
            sessionKey: '11'.repeat(32),
          },
        ],
        { seed: 'selftest' },
      )
      results.push({
        id: 'vm-program',
        ok: sample?.canonical === 'GET\n/selftest\na=1&b=2\n' + toHex(new Uint8Array(32)) + '\n\n',
      })
    }
    return { ok: results.every((result) => result.ok), results, version: SDK_VERSION }
  }

  return {
    version: SDK_VERSION,
    keyId: signer.keyId,
    publicKey: signer.publicKey,
    token: identity.token,
    storage: storage.kind,
    vm: Boolean(vm),
    guard: () => guard.evaluate(),
    riskToken: () => guard.token(),
    fingerprint: () => identity.describe(),
    /** Sign a request; `sealBody: true` wraps the body in a hybrid envelope. */
    sign: (request, overrides) => signer.sign(request, overrides),
    /** Convenience: the request with signing headers merged. */
    signedRequest(request, overrides) {
      const signed = signer.sign(request, overrides)
      return {
        ...request,
        headers: { ...(request.headers ?? {}), ...signed.headers },
        body: signed.body,
        meta: { canonical: signed.canonical, layers: signed.layers, risk: signed.risk },
      }
    },
    catalogue: () => ({
      whiteboxes: catalogue.suites.map((suite) => suite.id),
      layers: catalogue.serverLayers,
    }),
    selfTest,
  }
}
