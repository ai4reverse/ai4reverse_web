/**
 * Reference SDK entry (Node / tests).
 *
 * The protected bundle uses `runtime.js` directly and injects a precompiled VM.
 * This entry adds a development helper that compiles the NSL program at runtime
 * (and therefore imports Babel); it must never be part of a browser bundle.
 */

export { createSdk, SDK_VERSION, DEV_SPN_KEY } from './runtime.js'
export { createVm, createVmFromSpn, buildSigningBlob, compileAndValidate, SIGNING_PROGRAM_SOURCE, disassemble } from './vm/index.js'
export { createGuard } from './guard/index.js'
export { createDeviceIdentity, createStorage } from './fingerprint/device-token.js'
export { createSigner, deriveDeviceKey, deriveMacKey } from './signing/sign.js'
export { canonicalRequest, signatureBase } from './signing/canonical.js'
export { sealEnvelope, openEnvelope, envelopeToString, parseEnvelopeString } from './core/hybrid.js'
export { createCatalogue } from './core/variants.js'
export { createVerifier, createReplayCache } from '../server/verify.mjs'

import { createSdk } from './runtime.js'
import { buildSigningBlob } from './vm/index.js'
import { createVm } from './vm/interpreter.js'
import { fromHex } from './core/bytes.js'

/**
 * Development factory: compiles the VM from source so changes to the NSL
 * program are picked up without running the build pipeline.
 * @param {object} options same as createSdk, plus `vmKeyHex`
 */
export function createDevelopmentSdk(options = {}) {
  const keyHex = options.vmKeyHex ?? '766d2d646576656c6f706d656e742d6b65792d303030313233343536373839'
  const key = fromHex(keyHex)
  const { blob } = buildSigningBlob({ key })
  const vm = createVm({ blob, key })
  return createSdk({ ...options, vm })
}
