/**
 * Human-readable projection of a constraint analysis report.
 *
 * The CLI prints this; the JSON report remains the authoritative shape. Output
 * is bounded (the report is bounded), never throws, and never emits
 * `[object Object]`.
 */

/**
 * @param {object} input report from `analyzeConstraints`
 * @returns {string}
 */
export function renderConstraintReport(input) {
  const report = input && typeof input === 'object' ? input : {}
  const lines = []
  const stats = report.stats && typeof report.stats === 'object' ? report.stats : {}
  const parse = report.parse && typeof report.parse === 'object' ? report.parse : {}
  lines.push('# Constraint solving report', '')
  const engine = text(report.engine) || 'z3-solver'
  const version = text(report.engineVersion)
  lines.push(`- **Engine:** ${engine}${version ? ` ${version}` : ''}`)
  lines.push(`- **Parse:** ${parse.ok === true ? 'ok' : 'failed'}${parse.sourceType ? ` (${text(parse.sourceType)})` : ''}`)
  if (report.error) lines.push(`- **Error:** ${text(report.error.message ?? report.error)}`)
  if (report.truncated) lines.push('- **Truncated:** true (a candidate or time budget was reached)')
  lines.push(
    `- **Candidates:** ${count(stats.candidates)} (${count(stats.predicates)} translated, ${count(stats.inexact)} inexact, ${count(stats.unsupported)} unsupported)`,
  )
  lines.push(
    `- **Proved constant:** ${count(stats.opaque)} (${count(stats.undecided)} undecided); **unreachable branches:** ${count(stats.unreachable)}`,
  )
  lines.push(`- **Simplifications:** ${count(stats.simplifications)} in ${count(stats.solverCalls)} solver call(s)`)
  const assumptions = Array.isArray(report.assumptions) ? report.assumptions : []
  if (assumptions.length > 0) lines.push(`- **Assumptions:** ${assumptions.join(', ')}`)
  lines.push('')

  const opaque = Array.isArray(report.opaquePredicates) ? report.opaquePredicates : []
  lines.push('## Opaque predicates', '')
  if (opaque.length === 0) {
    lines.push('None proven constant.')
  } else {
    lines.push('| Location | Verdict | Role | Condition | Variables |', '| --- | --- | --- | --- | --- |')
    for (const finding of opaque) {
      lines.push(
        `| ${location(finding)} | ${text(finding.kind)} | ${text(finding.role)} | ${cell(finding.text)} | ${cell(list(finding.variables))} |`,
      )
    }
  }
  lines.push('')

  const unreachable = Array.isArray(report.unreachableBranches) ? report.unreachableBranches : []
  lines.push('## Unreachable branches', '')
  if (unreachable.length === 0) {
    lines.push('None proven unreachable.')
  } else {
    lines.push('| Location | Arm | Path constraints |', '| --- | --- | --- |')
    for (const finding of unreachable) {
      lines.push(`| ${location(finding)} | ${text(finding.kind)} | ${cell(list(finding.path) || '(none)')} |`)
    }
  }
  lines.push('')

  const simplifications = Array.isArray(report.simplifications) ? report.simplifications : []
  lines.push('## Simplifications', '')
  if (simplifications.length === 0) {
    lines.push('None recorded.')
  } else {
    lines.push('| Location | Condition | z3 normal form | Verified |', '| --- | --- | --- | --- |')
    for (const finding of simplifications) {
      lines.push(
        `| ${location(finding)} | ${cell(finding.text)} | ${cell(finding.simplified)} | ${text(finding.verification)} |`,
      )
    }
  }
  lines.push('')

  const notes = Array.isArray(report.notes) ? report.notes : []
  if (notes.length > 0) {
    lines.push('## Notes', '')
    for (const note of notes) lines.push(`- ${text(note)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function location(finding) {
  if (!finding) return '?'
  if (finding.line == null) return '?'
  return `${finding.line}:${finding.column ?? 0}`
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function text(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\|/g, '\\|')
}

function cell(value) {
  return text(value).replace(/\n/g, ' ')
}

function list(value) {
  if (!Array.isArray(value)) return ''
  return value.map((item) => text(item)).join(', ')
}
