/**
 * Canonicalisation and drift analysis.
 *
 * Two different hashes are derived:
 *
 *  - `hardwareHash` covers hardware-class fields only (GPU, screen, CPU, audio,
 *    timezone, platform). It is what the device token is bound to, so a browser
 *    update does not mint a new identity.
 *  - `softwareHash` covers software-class fields (UA build, codecs, fonts,
 *    locale data, CSS support) and is reported alongside for risk scoring.
 *
 * Session-class fields (window geometry, motion preference) are collected but
 * never hashed: they change with every resize.
 */

import { sm3 } from '../core/hash.js'
import { toHex, utf8ToBytes } from '../core/bytes.js'

/**
 * Deterministic JSON: object keys sorted, `-0` normalised, non-finite numbers
 * tagged so `NaN` and `Infinity` cannot collide with strings.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'number') {
    // Persisted state goes through JSON, which turns NaN/Infinity into null.
    // Canonicalisation must agree with that, otherwise the same fingerprint
    // hashes differently before and after a save.
    if (!Number.isFinite(value)) return 'null'
    if (Object.is(value, -0)) return '0'
    return String(value)
  }
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)
  if (type === 'bigint') return `{"$bigint":"${value.toString()}"}`
  if (type === 'undefined') return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (type === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

/**
 * Keep only entries whose top-level stability matches `classes`.
 * @param {object} fields
 * @param {Record<string, string>} stability
 * @param {string[]} classes
 * @returns {object}
 */
export function subsetByStability(fields, stability, classes) {
  const out = {}
  for (const key of Object.keys(fields)) {
    if (classes.includes(stability[key])) out[key] = fields[key]
  }
  return out
}

/**
 * @param {object} fields
 * @param {Record<string, string>} stability
 * @returns {{hardwareHash: string, softwareHash: string, stableHash: string, hardware: object, software: object}}
 */
export function hashFingerprint(fields, stability) {
  const hardware = subsetByStability(fields, stability, ['hardware'])
  const software = subsetByStability(fields, stability, ['software'])
  const stable = { hardware, software }
  return {
    hardwareHash: toHex(sm3(utf8ToBytes(canonicalize(hardware)))),
    softwareHash: toHex(sm3(utf8ToBytes(canonicalize(software)))),
    stableHash: toHex(sm3(utf8ToBytes(canonicalize(stable)))),
    hardware,
    software,
  }
}

const WEIGHTS = { hardware: 3, software: 2, session: 0 }

/**
 * Compare two fingerprints field by field.
 * @param {object} previous
 * @param {object} current
 * @param {Record<string, string>} stability
 * @returns {{score: number, changed: string[], hardwareChanged: string[], softwareChanged: string[], verdict: 'stable'|'minor'|'major'|'impossible'}}
 */
export function compareFingerprints(previous, current, stability) {
  if (!previous) {
    return { score: 1, changed: [], hardwareChanged: [], softwareChanged: [], verdict: 'stable' }
  }
  let totalWeight = 0
  let changedWeight = 0
  const changed = []
  const hardwareChanged = []
  const softwareChanged = []
  for (const key of Object.keys(current)) {
    const className = stability[key] ?? 'software'
    const weight = WEIGHTS[className] ?? 0
    if (weight === 0) continue
    totalWeight += weight
    const before = canonicalize(previous[key])
    const after = canonicalize(current[key])
    if (before !== after) {
      changedWeight += weight
      changed.push(key)
      if (className === 'hardware') hardwareChanged.push(key)
      else softwareChanged.push(key)
    }
  }
  // A changed platform/GPU/screen is a different machine, not drift. Treat a
  // hardware change that exceeds half the hardware weight as "impossible".
  const hardwareKeys = Object.keys(current).filter((key) => stability[key] === 'hardware')
  const hardwareTotal = hardwareKeys.length * WEIGHTS.hardware
  const hardwareShare = hardwareTotal === 0 ? 0 : (hardwareChanged.length * WEIGHTS.hardware) / hardwareTotal
  let verdict = 'stable'
  const score = totalWeight === 0 ? 1 : Number((1 - changedWeight / totalWeight).toFixed(3))
  if (hardwareShare >= 0.5) verdict = 'impossible'
  else if (score >= 0.95) verdict = 'stable'
  else if (score >= 0.75) verdict = 'minor'
  else verdict = 'major'
  return { score, changed, hardwareChanged, softwareChanged, verdict }
}
