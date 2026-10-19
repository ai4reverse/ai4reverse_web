/**
 * Bundle entry.
 *
 * The generated `config.js` carries the per-build white-box key, build salt and
 * the encrypted VM container. `create()` is the only public factory; the
 * bundle attaches itself to `globalThis.NSDK`, which is the shape a browser SDK
 * loader expects.
 */

import { createSdk, SDK_VERSION } from '../src/runtime.js'
import { BUILD_CONFIG } from './generated/config.js'

/**
 * @param {object} options
 * @param {string|{x: bigint, y: bigint}} options.serverPublicKey
 */
export function create(options = {}) {
  return createSdk({
    ...options,
    buildSalt: BUILD_CONFIG.buildSalt,
    spnKeyHex: BUILD_CONFIG.spnKeyHex,
    vmBlob: BUILD_CONFIG.vmBlob,
  })
}

export const meta = Object.freeze({
  version: SDK_VERSION,
  buildSeed: BUILD_CONFIG.seed,
  buildSalt: BUILD_CONFIG.buildSalt,
  vmInstructions: BUILD_CONFIG.vmBlob ? BUILD_CONFIG.vmBlob.perm.length : 0,
})
