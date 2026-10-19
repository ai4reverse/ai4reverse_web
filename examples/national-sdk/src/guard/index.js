/**
 * Guard facade.
 *
 * Evaluates the signal catalogue once per session and caches the verdict. The
 * raw verdict contains every signal detail (useful for a security team), while
 * `riskToken` is the compact form that travels in a header.
 */

import { createProbe } from './probe.js'
import { buildSignals } from './signals.js'
import { evaluateSignals, riskToken } from './policy.js'

/**
 * @param {{scope?: object}} [options]
 */
export function createGuard(options = {}) {
  const probe = options.probe ?? createProbe(options.scope)
  const signals = buildSignals(probe)
  let cached = null

  function evaluate() {
    if (cached) return cached
    const results = signals.map((signal) => {
      try {
        const result = signal.run(probe)
        return { id: signal.id, status: result?.status ?? 'unknown', detail: String(result?.detail ?? ''), value: result?.value }
      } catch (error) {
        return { id: signal.id, status: 'unknown', detail: `threw: ${error && error.message ? error.message : error}` }
      }
    })
    const policy = evaluateSignals(signals, results)
    cached = {
      ...policy,
      token: riskToken(policy),
      signals: signals.map((signal, index) => ({
        id: signal.id,
        layer: signal.layer,
        weight: signal.weight,
        description: signal.description,
        ...results[index],
      })),
    }
    return cached
  }

  return {
    probe,
    signals,
    evaluate,
    /** Re-run after the environment has changed (e.g. a detector was patched). */
    refresh() {
      cached = null
      return evaluate()
    },
    /** Full detail, optionally filtered to failures. */
    report(options = {}) {
      const verdict = evaluate()
      return options.failuresOnly
        ? { ...verdict, signals: verdict.signals.filter((signal) => signal.status === 'fail') }
        : verdict
    },
    token() {
      return evaluate().token
    },
  }
}

export { createProbe } from './probe.js'
export { buildSignals } from './signals.js'
export { probeDocumentAll } from './document-all.js'
export { evaluateSignals, riskToken, parseRiskToken, LEVELS } from './policy.js'
