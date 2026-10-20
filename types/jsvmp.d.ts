/**
 * Declarations for the `ai4reverse-web/jsvmp` subpath.
 *
 * The canonical opcode table (`spec`), the interpreter-source builder
 * (`builder`) and the dispatcher analyzer (`analyze`).
 *
 * The builder artifact's `run(options)` convenience runner executes the
 * generated source in the host process; it requires the explicit
 * `run({ trust: 'host' })` acknowledgement and throws `TrustError` otherwise.
 */

export {
  OPCODES,
  OPCODE_BY_NAME,
  OPCODE_BY_CODE,
  SEMANTICS,
  assemble,
  buildVM,
  buildSampleProgram,
  analyzeVM,
  extractHandlers,
  isJSVMP,
  summarizeVM,
} from './ai4reverse.js'

export type { OpcodeSpec, AssembledProgram, BuildVMOptions, VMArtifact } from './ai4reverse.js'

/** Default guest-visible name of the generated VM entry function. */
export declare const DEFAULT_VM_NAME: string

/** Mnemonic for a canonical opcode number, or `undefined` when unknown. */
export declare function opcodeName(code: number): string | undefined
