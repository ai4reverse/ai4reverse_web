/**
 * Declarations for the `ai4reverse-web/invocation` subpath.
 *
 * Traceless invocation (`invoke.js`) and the shim/`toString` masker
 * (`stealth.js`).
 */

export { createInvoker, createStealth } from './ai4reverse.js'

export type {
  Invoker,
  InvocationResult,
  Stealth,
  StealthOptions,
  StealthStats,
} from './ai4reverse.js'
