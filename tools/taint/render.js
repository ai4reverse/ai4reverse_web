import { normalizeTaintReport } from './report.js'

/** Human-readable taint evidence. A flow is not a dynamic execution witness. */
export function renderTaintReport(input) {
  const report = normalizeTaintReport(input)
  const stats = report.stats
  // A failure before parsing (budget, source layout, worker) must not print a
  // parse *outcome*: "0 error(s)" would imply a parse actually ran.
  const parsed = report.parse.ok === true
    || report.parse.errorCount > 0
    || report.parse.errors.length > 0
    || report.error?.code === 'TAINT_PARSE'
  const lines = ['# Taint analysis', '']
  lines.push(`- **Engine:** circle-ir${report.engineVersion ? ` ${text(report.engineVersion)}` : ''}`)
  lines.push(`- **File:** ${text(report.filename)} (${text(report.language)})`)
  lines.push(`- **Status:** ${!report.enabled ? 'disabled' : report.ok ? 'ok' : 'failed / partial'}`)
  lines.push(!report.enabled
    ? '- **Parse:** not run'
    : parsed
      ? `- **Parse:** ${report.parse.ok ? 'ok' : 'not successful'} (${report.parse.errorCount} error(s))`
      : '- **Parse:** not run')
  lines.push(`- **Evidence:** ${stats.sources} source(s), ${stats.sinks} sink(s), ${stats.sanitizers} sanitizer(s), ${stats.flows} flow(s)`)
  if (report.error) {
    lines.push(`- **Error:** ${report.error.code ? `${text(report.error.code)}: ` : ''}${text(report.error.message)}`)
  }
  if (report.truncated) lines.push(`- **Truncated:** true (${report.truncatedBy.map(text).join(', ') || 'upstream limit'})`)
  lines.push('', '## Flows', '')
  if (report.flows.length === 0) {
    lines.push(!report.enabled
      ? 'Taint analysis was disabled; no flows were collected.'
      : parsed
        ? 'No source-to-sink flows reported. This is not proof of safety.'
        : 'Taint analysis did not reach a complete parse; no flows were retained.')
  } else {
    lines.push('| Source | Sink | Confidence | Sanitized | Path truncated | Path |', '| --- | --- | ---: | --- | --- | --- |')
    for (const flow of report.flows) {
      const path = flow.path.map((step) => `${step.type} ${step.variable}@${step.line}`).join(' → ')
      lines.push(`| ${text(flow.source_type)}:${flow.source_line} | ${text(flow.sink_type)}:${flow.sink_line} | ${flow.confidence.toFixed(2)} | ${flow.sanitized} | ${flow.pathTruncated} | ${text(path)} |`)
    }
  }
  for (const [title, items] of [['Sources', report.sources], ['Sinks', report.sinks]]) {
    lines.push('', `## ${title}`, '')
    if (items.length === 0) lines.push('None reported.')
    else {
      lines.push('| Line | Type | Location | Code |', '| ---: | --- | --- | --- |')
      for (const item of items) {
        const type = title === 'Sinks' && item.cwe ? `${text(item.type)} (${text(item.cwe)})` : text(item.type)
        lines.push(`| ${item.line} | ${type} | ${text(item.location)} | ${text(item.code)} |`)
      }
    }
  }
  lines.push('', '## Sanitizers', '')
  if (report.sanitizers.length === 0) lines.push('None reported.')
  else {
    lines.push('| Line | Method | Sink types |', '| ---: | --- | --- |')
    for (const item of report.sanitizers) lines.push(`| ${item.line} | ${text(item.method)} | ${item.sanitizes.map(text).join(', ')} |`)
  }
  const interprocedural = report.interprocedural
  if (interprocedural.tainted_methods.length > 0 || interprocedural.taint_bridges.length > 0 || interprocedural.method_flows.length > 0) {
    lines.push('', '## Interprocedural evidence', '')
    if (interprocedural.tainted_methods.length > 0) {
      lines.push(`- **Tainted methods:** ${interprocedural.tainted_methods.map(text).join(', ')}`)
    }
    if (interprocedural.taint_bridges.length > 0) {
      lines.push(`- **Taint bridges:** ${interprocedural.taint_bridges.map(text).join(', ')}`)
    }
    for (const flow of interprocedural.method_flows) {
      lines.push(`- ${text(flow.caller)} → ${text(flow.callee)} at line ${flow.call_line}; tainted arguments: ${flow.tainted_args.join(', ')}; returns taint: ${flow.returns_taint}`)
    }
  }
  if (report.notes.length > 0) {
    lines.push('', '## Notes', '')
    for (const note of report.notes) lines.push(`- ${text(note)}`)
  }
  return `${lines.join('\n')}\n`
}

function text(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#!|]/g, '\\$&').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
}
