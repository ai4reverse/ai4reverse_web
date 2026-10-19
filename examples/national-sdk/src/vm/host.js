/**
 * Host API exposed to the protected program.
 *
 * The VM program is not allowed to reach globals: it can only call this object.
 * That is a deliberate capability boundary — the program can canonicalise and
 * derive material, but cannot touch the DOM, storage or the SM2 private key.
 * Percent-encoding and the layer catalogue are imported from their single
 * owners so the VM and the JS reference cannot drift.
 */

import { fromHex, toHex } from '../core/bytes.js'
import { kdfSm3, sm3Hex } from '../core/hash.js'
import { SERVER_LAYERS } from '../core/variants.js'
import { percentEncode } from '../signing/canonical.js'

/** @returns {object} */
export function createHostApi() {
  return {
    /** RFC 3986 percent-encode, same function the reference canonicaliser uses. */
    pct: (value) => percentEncode(value),
    /** SM3 of a string, hex. */
    sm3hex: (value) => sm3Hex(String(value)),
    /** HKDF-style expander over SM3, hex in/out. */
    kdf: (hex, info, length) => toHex(kdfSm3(fromHex(hex), String(info), Number(length))),
    /** Byte read from a hex string (0..255). */
    byte: (hex, index) => fromHex(hex)[Number(index)] ?? 0,
    /** Hex slice by byte offsets. */
    hexslice: (hex, start, end) => String(hex).slice(Number(start) * 2, Number(end) * 2),
    /** Server-invertible layer ids, in canonical order. */
    layers: () => SERVER_LAYERS.slice(),
  }
}
