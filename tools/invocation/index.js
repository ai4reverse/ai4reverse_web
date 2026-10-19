/**
 * Barrel for the invocation subpath (`ai4reverse-web/invocation`).
 *
 * `invoke.js` runs a source string against the sandbox; `stealth.js` masks the
 * shim sources. Both belong to the same public surface.
 */
export { createInvoker } from './invoke.js'
export { createStealth } from './stealth.js'
