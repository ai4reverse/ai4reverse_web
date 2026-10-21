/** Static, bounded Circle-IR taint analysis. No sample code is executed. */
export { analyzeTaint, renderTaintReport, TAINT_LIMITS } from './ai4reverse.js'
export type {
  TaintAnalysisOptions,
  TaintLimits,
  TaintConfig,
  TaintSourcePattern,
  TaintSinkPattern,
  TaintSanitizerPattern,
  TaintReport,
  TaintSource,
  TaintSink,
  TaintSanitizer,
  TaintFlow,
  TaintFlowStep,
} from './ai4reverse.js'
