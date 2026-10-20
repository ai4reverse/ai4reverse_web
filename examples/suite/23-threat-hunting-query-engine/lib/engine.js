/**
 * Query execution.
 *
 * Rules are evaluated at *report scope*, not per event: a selection is
 * satisfied when any observation in the table matches it, and the condition
 * then combines those selection outcomes. This mirrors how a hunter reasons
 * ("this sample both decoded a payload and beaconed out") while still keeping
 * the exact observations that satisfied each selection as evidence.
 *
 * Everything here is pure and order-stable so a hunt can be replayed in CI.
 */

const LEVEL_ORDER = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 }
const EVIDENCE_PER_SELECTION = 5

function ruleSummary(compiled) {
  const rule = compiled.rule
  return {
    id: rule.id,
    title: rule.title,
    level: rule.level,
    status: rule.status,
    tags: rule.tags,
    description: rule.description,
    author: rule.author,
    logsource: rule.logsource,
    falsepositives: rule.falsepositives,
    condition: rule.detection.condition,
  }
}

/**
 * Execute compiled rules over an observation table.
 *
 * @param {{observations: object[], rules: object[], limit?: number}} options
 * @returns {{summary: object, matches: object[]}}
 */
export function runHunt(options) {
  const observations = Array.isArray(options.observations) ? options.observations : []
  const rules = Array.isArray(options.rules) ? options.rules : []
  const limit = Number.isFinite(options.limit) ? options.limit : 500
  const matches = []
  for (const compiled of rules) {
    const outcome = compiled.collect(observations)
    if (!outcome.matched) continue
    matches.push({
      rule: ruleSummary(compiled),
      selections: outcome.selections,
      evidence: outcome.evidence,
      unusedSelections: outcome.unusedSelections,
    })
  }
  matches.sort((left, right) => {
    const level = (LEVEL_ORDER[left.rule.level] ?? 9) - (LEVEL_ORDER[right.rule.level] ?? 9)
    if (level !== 0) return level
    return left.rule.id < right.rule.id ? -1 : left.rule.id > right.rule.id ? 1 : 0
  })
  const kept = matches.slice(0, limit)
  const byLayer = {}
  let evidence = 0
  for (const match of kept) {
    for (const selection of match.evidence) {
      evidence += selection.observations.length
      for (const observation of selection.observations) {
        byLayer[observation.layer] = (byLayer[observation.layer] ?? 0) + 1
      }
    }
  }
  return {
    summary: {
      observations: observations.length,
      rules: rules.length,
      matches: kept.length,
      truncated: matches.length > kept.length,
      evidence,
      highestLevel: kept[0]?.rule.level ?? null,
      byLayer,
      byRule: Object.fromEntries(
        kept
          .map((match) => [match.rule.id, match.evidence.reduce((total, selection) => total + selection.observations.length, 0)])
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    },
    matches: kept,
  }
}

/** Human-readable explanation of why one rule fired, selection by selection. */
export function explainMatch(match) {
  const lines = [`${match.rule.id} [${match.rule.level}] ${match.rule.title}`]
  lines.push(`  condition   : ${match.rule.condition}`)
  for (const selection of match.evidence) {
    const first = selection.observations[0]
    lines.push(`  selection   : ${selection.name} satisfied by ${selection.observations.length} observation(s)`)
    lines.push(`  observation : ${first.id} (${first.layer}/${first.kind}${first.seq === null ? '' : ` seq=${first.seq}`})`)
    for (const detail of selection.details) {
      const actual = detail.actual === undefined || detail.actual === null ? '∅' : String(detail.actual)
      lines.push(`    - ${detail.field} [${detail.expected.join(' | ')}] -> ${actual}`)
    }
  }
  if (match.unusedSelections.length > 0) {
    lines.push(`  unused      : ${match.unusedSelections.join(', ')} (defined but not required by the condition)`)
  }
  return lines.join('\n')
}

/** Render the whole hunt result as a stable text block. */
export function renderHuntText(result, options = {}) {
  const summary = result.summary
  const lines = [
    `hunt: ${summary.matches}/${summary.rules} rule(s) matched | ${summary.observations} observation(s), ${summary.evidence} evidence hit(s)` +
      (summary.highestLevel ? ` | highest level ${summary.highestLevel}` : ''),
  ]
  if (summary.matches === 0) {
    lines.push('no rule matched; the report contains no rule-level evidence')
    return lines.join('\n')
  }
  for (const match of result.matches) {
    if (options.explain) {
      lines.push(explainMatch(match), '')
      continue
    }
    lines.push(`rule ${match.rule.id} [${match.rule.level}] ${match.rule.title}`)
    if (match.rule.tags.length > 0) lines.push(`  tags: ${match.rule.tags.join(', ')}`)
    for (const selection of match.evidence) {
      const observation = selection.observations[0]
      const extra = selection.observations.length > 1 ? ` (+${selection.observations.length - 1} more)` : ''
      const detail = observation.url ?? observation.value ?? observation.technique ?? ''
      lines.push(`  - ${selection.name}: ${observation.id}${observation.seq === null ? '' : ` seq=${observation.seq}`} ${detail}${extra}`.trimEnd())
    }
  }
  return lines.join('\n')
}
