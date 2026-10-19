/**
 * Public API of the malicious-JavaScript analysis platform.
 *
 * The package is deliberately layered; import the submodule you need to keep
 * startup cheap, or use the convenience functions below for the whole pipeline.
 */

export { TracelessSandbox, createProfile, consistencyReport } from './sandbox/sandbox.js'
export { createHostBridge, isHandle } from './sandbox/bridge.js'
export { createVirtualClock } from './sandbox/clock.js'
export { normalizeLimits, DEFAULT_LIMITS } from './sandbox/limits.js'
export { captureIntegrity, diffIntegrity } from './sandbox/integrity.js'
export { installEnvironment, ENV_MODULE_IDS, loadEnvModule } from './sandbox/env/index.js'

export { createStealth } from './invocation/stealth.js'
export { createInvoker } from './invocation/invoke.js'

export {
  createTraceRecorder,
  TRACE_KINDS,
  createInstrumentation,
  createCodeInstrumenter,
  createApiInstrumenter,
  createExceptionInstrumenter,
  analyzeSource,
  scoreObfuscation,
  detectTechniques,
  detectDispatch,
  instrumentDispatch,
  locateInterpreter,
  summarizeOpcodeTrace,
  walkAst,
} from './instrumentation/index.js'

export { createHookBus, HOOK_PHASES, createDefaultHooks, registerHooks } from './hook/index.js'

export { restore, restoreWithPass, parse, generate, listPasses, selectPasses, PASSES } from './restore/index.js'

export {
  analyzeSample,
  extractIOCs,
  extractFromEvents,
  buildReport,
  renderMarkdown,
  scoreVerdict,
  summarizeBehavior,
  createArtifactStore,
  extractStagedPayloads,
} from './analysis/index.js'

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
} from './jsvmp/index.js'

export { createLogger, createEventSink, createMemoryDestination, redactPaths, scopeLogger } from './logging/logger.js'

import { analyzeSample } from './analysis/index.js'
import { restore } from './restore/index.js'
import { TracelessSandbox } from './sandbox/sandbox.js'

/**
 * One-shot analysis of a source string.
 * @param {string} source
 * @param {object} [options]
 */
export async function analyze(source, options = {}) {
  return analyzeSample(source, options)
}

/**
 * One-shot dynamic run without static analysis or reporting.
 * @param {string} source
 * @param {object} [options]
 */
export async function run(source, options = {}) {
  const sandbox = options.sandbox ?? (await TracelessSandbox.create(options))
  try {
    return await sandbox.run(source, options)
  } finally {
    if (!options.sandbox) sandbox.dispose()
  }
}

/**
 * One-shot restoration (parse -> passes -> generate).
 * @param {string} code
 * @param {object} [options]
 */
export function restoreCode(code, options = {}) {
  return restore(code, options)
}
