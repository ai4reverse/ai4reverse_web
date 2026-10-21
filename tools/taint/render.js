import { normalizeTaintReport } from './report.js'

/** Human-readable taint evidence. A flow is not a dynamic execution witness. */
export function renderTaintReport(input) {
  const report = normalizeTaintReport(input)
  const stats = report.stats
  const lines = ['# Taint analysis', '']
  lines.push(`- **Engine:** circle-ir${report.engineVersion ? ` ${text(report.engineVersion)}` : ''}`)
  lines.push(`- **File:** ${text(report.filename)} (${text(report.language)})`)
  lines.push(`- **Status:** ${!report.enabled ? 'disabled' : report.ok ? 'ok' : 'failed / partial'}`)
  lines.push(`- **Parse:** ${report.parse.ok ? 'ok' : 'not successful'} (${report.parse.errorCount} error(s))`)
  lines.push(`- **Evidence:** ${stats.sources} source(s), ${stats.sinks} sink(s), ${stats.sanitizers} sanitizer(s), ${stats.flows} flow(s)`)
  if (report.error) lines.push(`- **Error:** ${text(report.error.code)}: ${text(report.error.message)}`)
  if (report.truncated) lines.push(`- **Truncated:** true (${report.truncatedBy.map(text).join(', ') || 'upstream limit'})`)
  lines.push('', '## Flows', '')
  if (report.flows.length === 0) lines.push('No source-to-sink flows reported. This is not proof of safety.')
  else {
    lines.push('| Source | Sink | Confidence | Sanitized | Path |', '| --- | --- | ---: | --- | --- |')
    for (const flow of report.flows) {
      const path = flow.path.map((step) => `${step.type} ${step.variable}@${step.line}`).join(' → ')
      lines.push(`| ${text(flow.source_type)}:${flow.source_line} | ${text(flow.sink_type)}:${flow.sink_line} | ${flow.confidence.toFixed(2)} | ${flow.sanitized} | ${text(path)} |`)
    }
  }
  for (const [title, items] of [['Sources', report.sources], ['Sinks', report.sinks]]) {
    lines.push('', `## ${title}`, '')
    if (items.length === 0) lines.push('None reported.')
    else {
      lines.push('| Line | Type | Location | Code |', '| ---: | --- | --- | --- |')
      for (const item of items) lines.push(`| ${item.line} | ${text(item.type)}${item.cwe ? ` (${text(item.cwe)})` : ''} | ${text(item.location)} | ${text(item.code)} |`)
    }
  }
  lines.push('', '## Sanitizers', '')
  if (report.sanitizers.length === 0) lines.push('None reported.')
  else {
    lines.push('| Line | Method | Sink types |', '| ---: | --- | --- |')
    for (const item of report.sanitizers) lines.push(`| ${item.line} | ${text(item.method)} | ${item.sanitizes.map(text).join(', ')} |`)
  }
  if (report.interprocedural.tainted_methods.length > 0) {
    lines.push('', '## Interprocedural evidence', '')
    lines.push(`- **Tainted methods:** ${report.interprocedural.tainted_methods.map(text).join(', ')}`)
    for (const flow of report.interprocedural.method_flows) {
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
