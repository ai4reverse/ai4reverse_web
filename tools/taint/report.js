import { TAINT_LIMITS, normalizeTaintLimits } from './limits.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const array = (value) => Array.isArray(value) ? value : []
const count = (value) => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
const confidence = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const DISABLED_NOTE = 'Taint analysis is disabled; no source, sink, sanitizer or flow evidence was collected.'

/** Stable, JSON-only, bounded projection shared by the worker and report builder. */
export function normalizeTaintReport(value = {}) {
  const input = object(value)
  let limits
  try {
    limits = normalizeTaintLimits(input.limits)
  } catch {
    limits = { ...TAINT_LIMITS }
  }
  const reasons = ['source-size', 'overlong-line', 'timeout', 'memory', 'source-limit', 'sink-limit', 'sanitizer-limit', 'flow-limit', 'path-limit', 'text-limit', 'method-limit', 'bridge-limit', 'method-flow-limit', 'parse-error-limit', 'sanitizer-type-limit', 'argument-limit', 'note-limit']
  const truncatedBy = new Set(array(input.truncatedBy).filter((item) => reasons.includes(item)))
  const boundedText = (value, maximum) => {
    const raw = typeof value === 'string' ? value : ''
    if (raw.length > maximum) truncatedBy.add('text-limit')
    return raw.slice(0, maximum)
  }
  const text = (value) => boundedText(value, limits.maxTextLength)
  // Semantic labels and failure codes are not evidence snippets. A tiny
  // maxTextLength must not turn TAINT_TIMEOUT into an unrecognizable code.
  const label = (value) => boundedText(value, 100)
  const list = (value, maximum, reason, project) => {
    const items = array(value)
    if (items.length > maximum) truncatedBy.add(reason)
    return items.slice(0, maximum).map((item) => project(object(item)))
  }
  const strings = (value, maximum, reason) => {
    const items = array(value)
    if (items.length > maximum) truncatedBy.add(reason)
    return items.slice(0, maximum).map(text)
  }
  const indexes = (value) => {
    const items = array(value)
    if (items.length > 20) truncatedBy.add('argument-limit')
    return items.slice(0, 20).filter((index) => Number.isSafeInteger(index) && index >= 0)
  }
  const point = (item) => ({
    type: label(item.type),
    line: count(item.line),
    location: text(item.location),
    confidence: confidence(item.confidence),
    method: text(item.method),
    code: text(item.code),
  })
  const sources = list(input.sources, limits.maxSources, 'source-limit', (item) => ({
    ...point(item),
    severity: ['critical', 'high', 'medium', 'low'].includes(item.severity) ? item.severity : 'medium',
    variable: text(item.variable),
    in_method: text(item.in_method),
  }))
  const sinks = list(input.sinks, limits.maxSinks, 'sink-limit', (item) => ({
    ...point(item),
    cwe: label(item.cwe),
    argPositions: indexes(item.argPositions),
  }))
  const sanitizers = list(input.sanitizers, limits.maxSanitizers, 'sanitizer-limit', (item) => ({
    type: label(item.type),
    method: text(item.method),
    line: count(item.line),
    sanitizes: strings(item.sanitizes, 40, 'sanitizer-type-limit'),
  }))
  const flows = list(input.flows, limits.maxFlows, 'flow-limit', (item) => {
    const path = array(item.path)
    // Preserve the actual sink endpoint even when intermediate steps are cut.
    const retained = path.length > limits.maxPathLength
      ? [...path.slice(0, limits.maxPathLength - 1), path.at(-1)]
      : path
    if (retained.length < path.length) truncatedBy.add('path-limit')
    return {
      source_line: count(item.source_line),
      sink_line: count(item.sink_line),
      source_type: label(item.source_type),
      sink_type: label(item.sink_type),
      confidence: confidence(item.confidence),
      sanitized: item.sanitized === true,
      pathTruncated: item.pathTruncated === true || retained.length < path.length,
      path: retained.map((step) => ({
        variable: text(object(step).variable),
        line: count(object(step).line),
        type: label(object(step).type),
      })),
    }
  })
  const interprocedural = object(input.interprocedural)
  const taintedMethods = strings(interprocedural.tainted_methods, limits.maxSources, 'method-limit')
  const taintBridges = strings(interprocedural.taint_bridges, limits.maxFlows, 'bridge-limit')
  const methodFlows = list(interprocedural.method_flows, limits.maxFlows, 'method-flow-limit', (item) => ({
    caller: text(item.caller),
    callee: text(item.callee),
    call_line: count(item.call_line),
    tainted_args: indexes(item.tainted_args),
    returns_taint: item.returns_taint === true,
  }))
  const parse = object(input.parse)
  // Retained evidence is more important than the caller's `enabled` flag: a
  // public buildReport caller that supplies taint records without the flag must
  // not get `enabled:false` plus non-empty lists, which would hide the section.
  const enabled = input.enabled === true
    || array(input.sources).length > 0
    || array(input.sinks).length > 0
    || array(input.sanitizers).length > 0
    || array(input.flows).length > 0
    || parse.ok === true
  const parseErrors = list(parse.errors, 20, 'parse-error-limit', (item) => ({
    line: count(item.line),
    column: count(item.column),
    message: text(item.message),
  }))
  // A skipped stage must say so; an empty list is ambiguous between "nothing
  // found" and "never ran". Synthesize before the cap so the note cannot push
  // the list past its own bound, and keep it only for an empty list so a second
  // normalization of the same report cannot duplicate it.
  const notes = strings(
    !enabled && array(input.notes).length === 0 ? [DISABLED_NOTE] : input.notes,
    20,
    'note-limit',
  )
  const error = input.error == null ? null : {
    code: label(object(input.error).code),
    message: text(typeof input.error === 'string' ? input.error : object(input.error).message),
  }
  const stats = object(input.stats)
  const filename = boundedText(input.filename, 4096)
  const engineVersion = label(input.engineVersion) || null
  const language = label(input.language) || 'javascript'
  return {
    enabled,
    ok: enabled && input.ok === true && parse.ok === true && count(parse.errorCount) === 0 && error === null,
    engine: 'circle-ir',
    engineVersion,
    filename,
    language,
    parse: { ok: parse.ok === true, errorCount: count(parse.errorCount), errors: parseErrors },
    stats: {
      sources: count(stats.sources ?? array(input.sources).length),
      sinks: count(stats.sinks ?? array(input.sinks).length),
      sanitizers: count(stats.sanitizers ?? array(input.sanitizers).length),
      flows: count(stats.flows ?? array(input.flows).length),
      taintedMethods: count(stats.taintedMethods ?? array(interprocedural.tainted_methods).length),
      methodFlows: count(stats.methodFlows ?? array(interprocedural.method_flows).length),
    },
    sources,
    sinks,
    sanitizers,
    flows,
    interprocedural: { tainted_methods: taintedMethods, taint_bridges: taintBridges, method_flows: methodFlows },
    limits,
    truncated: input.truncated === true || truncatedBy.size > 0,
    truncatedBy: [...truncatedBy],
    notes,
    error,
    elapsedMs: count(input.elapsedMs),
  }
}

/** Project only taint evidence; do not expose the engine's AST or quality passes. */
export function projectTaintIR(ir, context) {
  const status = object(ir.parse_status)
  return normalizeTaintReport({
    ...context,
    enabled: true,
    ok: status.success === true && status.has_errors !== true,
    parse: {
      ok: status.success === true && status.has_errors !== true,
      errorCount: status.error_count,
      errors: array(status.error_locations).map((item) => ({ ...item, message: 'Circle-IR syntax error' })),
    },
    ...object(ir.taint),
    error: status.success !== true || status.has_errors === true
      ? { code: 'TAINT_PARSE', message: 'Circle-IR did not parse the complete source; recovered evidence is partial' }
      : null,
    notes: [
      'Static, heuristic evidence from Circle-IR; no sample code was executed.',
      'No flows does not prove safety. Dynamic code, aliases and sanitizer modeling can hide flows.',
    ],
  })
}
