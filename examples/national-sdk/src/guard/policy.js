/**
 * Zero-trust policy.
 *
 * A single failed signal never decides alone unless it is a *proof*: the
 * `document.all` invariant cannot fail in a browser, so it is decisive. Every
 * other failure is a weight that must be corroborated, and `unknown` results
 * reduce confidence instead of being silently treated as clean. The output is
 * deliberately small enough to travel in a request header while carrying:
 *
 *   level       trusted | guarded | suspicious | hostile
 *   score       0..100 risk score
 *   confidence  0..1 fraction of signals that actually produced an answer
 *   layers      per-layer pass/fail/unknown/weight
 *   evidence    the highest-weight failures (for server-side triage)
 */

export const LEVELS = Object.freeze(['trusted', 'guarded', 'suspicious', 'hostile'])

/**
 * @param {Array<{id: string, layer: string, weight: number, critical?: boolean, proof?: boolean}>} signals
 * @param {Array<{id: string, status: string, detail: string}>} results
 */
export function evaluateSignals(signals, results) {
  const byId = new Map(results.map((result) => [result.id, result]))
  const layers = {}
  let rawScore = 0
  let passed = 0
  let failed = 0
  let unknown = 0
  const criticals = []
  const proofs = []
  const failures = []

  for (const signal of signals) {
    const result = byId.get(signal.id) ?? { status: 'unknown', detail: 'signal did not run' }
    if (!layers[signal.layer]) layers[signal.layer] = { pass: 0, fail: 0, unknown: 0, weight: 0, score: 0 }
    const layer = layers[signal.layer]
    if (result.status === 'pass') {
      passed += 1
      layer.pass += 1
      layer.weight += signal.weight
    } else if (result.status === 'fail') {
      failed += 1
      layer.fail += 1
      layer.weight += signal.weight
      layer.score += signal.weight
      rawScore += signal.weight
      const entry = { id: signal.id, layer: signal.layer, weight: signal.weight, detail: result.detail }
      failures.push(entry)
      if (signal.critical) criticals.push(entry)
      if (signal.proof) proofs.push(entry)
    } else {
      unknown += 1
      layer.unknown += 1
    }
  }

  for (const layer of Object.values(layers)) {
    const total = layer.pass + layer.fail + layer.unknown
    layer.coverage = total === 0 ? 0 : Number(((layer.pass + layer.fail) / total).toFixed(3))
  }

  const total = signals.length
  const coverage = total === 0 ? 0 : (passed + failed) / total
  const purity = passed + failed === 0 ? 0 : passed / (passed + failed)
  const confidence = Number(Math.max(0, Math.min(1, purity * (0.4 + 0.6 * coverage))).toFixed(3))
  const score = Math.min(100, Math.round(rawScore + (1 - confidence) * 22))

  /** @type {'trusted'|'guarded'|'suspicious'|'hostile'} */
  let level
  if (proofs.length > 0) level = 'hostile'
  else if (criticals.length >= 2 || rawScore >= 60) level = 'hostile'
  else if (criticals.length >= 1 || rawScore >= 30) level = 'suspicious'
  else if (rawScore >= 10 || confidence < 0.55) level = 'guarded'
  else level = 'trusted'

  failures.sort((left, right) => right.weight - left.weight)

  return {
    level,
    score,
    rawScore,
    confidence,
    coverage: Number(coverage.toFixed(3)),
    counts: { pass: passed, fail: failed, unknown, total },
    criticals,
    proofs,
    evidence: failures.slice(0, 10),
    layers,
  }
}

/**
 * Compact wire token: level initial + base36 score + base36 confidence percent.
 * Example: `t0`, `s47`, `h81`.
 * @param {{level: string, score: number, confidence: number}} result
 * @returns {string}
 */
export function riskToken(result) {
  const initial = String(result.level ?? 'u')[0]
  const score = Math.max(0, Math.min(99, Math.round(result.score ?? 0))).toString(36)
  const confidence = Math.max(0, Math.min(99, Math.round((result.confidence ?? 0) * 100))).toString(36)
  return `${initial}${score}.${confidence}`
}

/**
 * @param {string} token
 * @returns {{level: string, score: number, confidence: number}|null}
 */
export function parseRiskToken(token) {
  const match = /^([tgshu])([0-9a-z]{1,2})\.([0-9a-z]{1,2})$/i.exec(String(token ?? ''))
  if (!match) return null
  const names = { t: 'trusted', g: 'guarded', s: 'suspicious', h: 'hostile', u: 'unknown' }
  return {
    level: names[match[1].toLowerCase()] ?? 'unknown',
    score: parseInt(match[2], 36),
    confidence: parseInt(match[3], 36) / 100,
  }
}
