/**
 * Declarations for the `ai4reverse-web/instrumentation` subpath.
 *
 * Static analysis, the trace recorder and the three instrumentation layers
 * (code/statement, API, exception) plus the JSVMP dispatch instrumenter.
 */

export {
  createTraceRecorder,
  TRACE_KINDS,
  createCodeInstrumenter,
  createApiInstrumenter,
  createExceptionInstrumenter,
  createInstrumentation,
  analyzeSource,
  scoreObfuscation,
  detectTechniques,
  walkAst,
  detectDispatch,
  instrumentDispatch,
  locateInterpreter,
  summarizeOpcodeTrace,
} from './ai4reverse.js'

export type {
  TraceRecorder,
  TraceRecorderOptions,
  TraceEvent,
  TraceStats,
  Instrumentation,
  InstrumentationConfig,
  InstrumentationDescribe,
  InstrumentationPrepared,
  CodeInstrumenter,
  CodeInstrumenterStats,
  InstrumentedCode,
  ApiInstrumenter,
  ApiInstrumenterStats,
  ExceptionInstrumenter,
  StaticFacts,
  ObfuscationScore,
  AnalyzeSourceOptions,
  AnalyzeSourceResult,
  HookBus,
  Logger,
  QuickJSContext,
  QuickJSHandle,
} from './ai4reverse.js'

/**
 * Every phase the trace recorder accepts. Kept in the declaration so a strict
 * recorder can be typed without importing the constant value.
 */
export type TracePhase =
  | 'emit'
  | 'before'
  | 'after'
  | 'invoke'
  | 'enter'
  | 'exit'
  | 'step'
  | 'transform'
  | 'skip'
  | 'error'
  | 'throw'
  | 'catch'
  | 'uncaught'
