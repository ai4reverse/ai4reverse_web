/**
 * VM facade: compile-time tooling (Node only) and the runtime interpreter.
 *
 * A protected bundle imports only `format.js` and `interpreter.js`; the
 * compiler (and therefore Babel) never ships. The reference SDK uses the
 * compiler to build the same bytecode in tests, which is how the VM program is
 * validated against the readable canonicaliser.
 */

export { ISA, OPCODE_ID, ID_OPCODE } from './isa.js'
export { compile, compileAndValidate } from './compiler.js'
export { buildBlob, decodeBlob, disassemble, shuffleHandlerIds, keyFromHex, VM_FORMAT_VERSION } from './format.js'
export { createVm, createVmFromSpn, OPS } from './interpreter.js'
export { SIGNING_PROGRAM_SOURCE } from './programs/signing.nsl.js'

import { compileAndValidate } from './compiler.js'
import { buildBlob } from './format.js'
import { SIGNING_PROGRAM_SOURCE } from './programs/signing.nsl.js'

/**
 * Compile the signing program and package it into an encrypted container.
 * @param {{key: Uint8Array|number[], perm?: number[]}} options
 */
export function buildSigningBlob(options) {
  const program = compileAndValidate(SIGNING_PROGRAM_SOURCE)
  return { blob: buildBlob(program, options.key, { perm: options.perm }), program }
}
