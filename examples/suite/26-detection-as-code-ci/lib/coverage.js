/**
 * Coverage and hygiene evaluation.
 *
 * The CI contract is simple and testable:
 *   1. every *required* sample (malicious, or suspicious when configured) must be
 *      matched by at least one rule → otherwise the gate fails;
 *   2. no rule may match a sample that is not required → false positives fail
 *      the gate as well;
 *   3. rules that match nothing are reported as stale (warning only).
 */

import { matchYara, matchSigma } from './rules.js'

const round = (value, digits = 4) => Number(value.toFixed(digits))

/** Is this sample expected to be covered by a detection? */
export function isRequired(sample, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 60
  if (sample.verdict === 'malicious') return true
  if ((options.failOn ?? 'malicious') === 'suspicious' && sample.verdict === 'suspicious') return true
  return sample.score >= minScore
}

/** Does one rule match one sample? */
export function ruleMatches(rule, sample) {
  return rule.kind === 'yara' ? matchYara(rule.rule, sample.haystack) : matchSigma(rule.rule, sample.record)
}

/**
 * Evaluate coverage, false positives and stale rules.
 *
 * @param {{samples: object[], detections: object[], errors?: object[], failOn?: string, minScore?: number}} options
 */
export function evaluateCoverage(options) {
  const samples = options.samples ?? []
  const detections = options.detections ?? []
  const errors = options.errors ?? []
  const required = samples.filter((sample) => isRequired(sample, options))

  const rows = []
  const falsePositives = []
  const hitsByRule = new Map(detections.map((detection) => [detection.file, 0]))
  for (const sample of samples) {
    const matchedBy = []
    for (const detection of detections) {
      if (!ruleMatches(detection, sample)) continue
      matchedBy.push({ id: detection.id, file: detection.file, kind: detection.kind })
      hitsByRule.set(detection.file, hitsByRule.get(detection.file) + 1)
      if (!isRequired(sample, options)) falsePositives.push({ rule: detection.id, file: detection.file, sample: sample.relative })
    }
    rows.push({
      relative: sample.relative,
      verdict: sample.verdict,
      score: sample.score,
      required: isRequired(sample, options),
      matchedBy,
    })
  }

  const requiredRows = rows.filter((row) => row.required)
  const uncovered = requiredRows.filter((row) => row.matchedBy.length === 0).map((row) => row.relative)
  const covered = requiredRows.length - uncovered.length
  const stale = detections.filter((detection) => (hitsByRule.get(detection.file) ?? 0) === 0).map((detection) => detection.file)

  const reasons = []
  if (uncovered.length > 0) reasons.push(`${uncovered.length} required sample(s) uncovered: ${uncovered.join(', ')}`)
  for (const entry of falsePositives) reasons.push(`false positive: ${entry.rule} matched benign ${entry.sample}`)
  for (const entry of errors) reasons.push(`invalid detection ${entry.file}: ${entry.message}`)

  const ok = reasons.length === 0
  return {
    rows,
    coverage: {
      required: requiredRows.length,
      covered,
      ratio: requiredRows.length === 0 ? 1 : round(covered / requiredRows.length),
      uncovered,
    },
    falsePositives,
    stale,
    errors,
    gate: { ok, exitCode: ok ? 0 : 2, reasons },
  }
}
