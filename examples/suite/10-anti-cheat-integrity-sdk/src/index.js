/**
 * Anti-Cheat / Integrity SDK.
 *
 * Captures a baseline of game-critical function sources, property descriptors,
 * prototype chains and built-in prototype snapshots. A sampling guard re-checks
 * the live objects on a deterministic, bounded schedule and reports hot-patches,
 * descriptor tampering, prototype pollution and timing anomalies. Findings are
 * deduplicated, converted into telemetry events, aggregated into a report and
 * signed with ECDSA P-256 so a backend can trust the tamper evidence.
 *
 * Timing detection uses robust statistics (median + MAD) and a calibrated
 * budget, which keeps harmless jitter from producing false positives while
 * still catching gross anomalies.
 */
import { createHash } from 'node:crypto'

export const VERSION = '1.0.0'
export const SCHEMA = 'anti-cheat.report.v1'
export const ALGORITHM = 'ES256'
const originalToString = Function.prototype.toString
const encoder = new TextEncoder()

export const SEVERITY_BY_TYPE = Object.freeze({
  HOT_PATCH: 'critical',
  FUNCTION_REPLACED: 'critical',
  TO_STRING_TAMPER: 'critical',
  PROTOTYPE_POLLUTION: 'critical',
  PROTOTYPE_TAMPER: 'high',
  PROTOTYPE_MISSING: 'high',
  DESCRIPTOR_TAMPER: 'high',
  PROTOTYPE_CHAIN_TAMPER: 'high',
  TIMING_ANOMALY: 'medium',
})

export class IntegrityError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code)
    this.name = 'IntegrityError'
    this.code = code
  }
}

/** @param {...(Uint8Array|Buffer|string)} chunks */
export function sha256Hex(...chunks) {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
  return hash.digest('hex')
}

/** @param {any} value @returns {string} */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {Function} fn @returns {string} */
function functionSource(fn) {
  try {
    return originalToString.call(fn)
  } catch {
    return '<unreadable>'
  }
}

/** @param {Function} fn @returns {string} */
export function hashFunctionSource(fn) {
  return sha256Hex(functionSource(fn))
}

/** @param {number} seed */
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** @param {unknown} targets */
export function normalizeTargets(targets) {
  let list
  if (Array.isArray(targets)) {
    list = targets.map((target) => ({ name: target?.name, fn: target?.fn, owner: target?.owner, key: target?.key }))
  } else if (targets && typeof targets === 'object') {
    list = Object.entries(targets).map(([name, fn]) => ({ name, fn }))
  } else {
    throw new IntegrityError('BAD_TARGETS', 'targets must be an object map or an array')
  }
  if (list.length === 0) throw new IntegrityError('BAD_TARGETS', 'at least one target is required')
  const names = new Set()
  for (const target of list) {
    if (typeof target.name !== 'string' || target.name.length === 0) throw new IntegrityError('BAD_TARGETS', 'target name is required')
    if (names.has(target.name)) throw new IntegrityError('BAD_TARGETS', `duplicate target ${target.name}`)
    if (typeof target.fn !== 'function') throw new IntegrityError('BAD_TARGETS', `target ${target.name} is not a function`)
    if (target.owner !== undefined && (target.owner === null || typeof target.owner !== 'object')) {
      throw new IntegrityError('BAD_TARGETS', `target ${target.name} has an invalid owner`)
    }
    names.add(target.name)
  }
  return list
}

/** @param {object} owner @param {string} key */
function descriptorOf(owner, key) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (!descriptor) throw new IntegrityError('BAD_TARGETS', `property ${String(key)} does not exist`)
  return {
    writable: Boolean(descriptor.writable),
    enumerable: Boolean(descriptor.enumerable),
    configurable: Boolean(descriptor.configurable),
    getter: typeof descriptor.get === 'function',
    setter: typeof descriptor.set === 'function',
  }
}

/** @param {Array<{name: string, object: object}>} [custom] */
export function capturePrototypeSnapshot(custom = []) {
  const entries = new Map([
    ['Object.prototype', Object.prototype],
    ['Array.prototype', Array.prototype],
    ['Function.prototype', Function.prototype],
    ['String.prototype', String.prototype],
  ])
  for (const entry of custom) {
    if (!entry || typeof entry.name !== 'string' || !entry.object || typeof entry.object !== 'object') {
      throw new IntegrityError('BAD_PROTOTYPE', 'custom prototypes must be {name, object}')
    }
    entries.set(entry.name, entry.object)
  }
  const snapshot = {}
  for (const [name, object] of entries) {
    const keys = Object.getOwnPropertyNames(object).sort()
    snapshot[name] = { keys, fingerprint: prototypeFingerprint(object) }
  }
  return snapshot
}

/**
 * Stable fingerprint of a prototype's own descriptors and function sources.
 * @param {object} prototype
 */
export function prototypeFingerprint(prototype) {
  const names = Object.getOwnPropertyNames(prototype).sort()
  const parts = names.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    const type = typeof descriptor.value
    let value = type
    if (type === 'function') value = `fn:${hashFunctionSource(descriptor.value)}`
    else if (descriptor.get || descriptor.set) value = `accessor:${descriptor.get ? hashFunctionSource(descriptor.get) : '-'}:${descriptor.set ? hashFunctionSource(descriptor.set) : '-'}`
    else value = `${type}:${String(descriptor.value)}`
    return `${name}:${descriptor.writable ? 1 : 0}${descriptor.enumerable ? 1 : 0}${descriptor.configurable ? 1 : 0}:${value}`
  })
  return sha256Hex(parts.join('|'))
}

/** @param {object} target */
function liveFunction(target) {
  return target.owner !== undefined ? target.owner[target.key] : target.fn
}

/**
 * @param {object|Array} targets
 * @param {{now?: number, prototypes?: Array<{name: string, object: object}>}} [options]
 */
export function captureBaseline(targets, options = {}) {
  const list = normalizeTargets(targets)
  const functions = list.map((target) => {
    const descriptor = target.owner !== undefined ? descriptorOf(target.owner, target.key) : null
    return {
      name: target.name,
      sourceHash: hashFunctionSource(target.fn),
      length: target.fn.length,
      descriptor,
      ownNames: Object.getOwnPropertyNames(target.fn).sort(),
      protoName: Object.getPrototypeOf(target.fn)?.constructor?.name ?? null,
    }
  })
  return {
    v: 1,
    createdAt: options.now ?? Date.now(),
    functions,
    prototypes: capturePrototypeSnapshot(options.prototypes),
    toStringHash: hashFunctionSource(Function.prototype.toString),
  }
}

/**
 * Robust timing profile: median plus median absolute deviation.
 * @param {number[]} samples
 * @param {{ceiling?: number}} [options]
 */
export function createTimingProfile(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 5) throw new IntegrityError('BAD_TIMING', 'at least five timing samples are required')
  const values = samples.map(Number)
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) throw new IntegrityError('BAD_TIMING', 'timing samples must be finite non-negative numbers')
  const sorted = values.slice().sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]
  const deviations = values.map((value) => Math.abs(value - median)).sort((left, right) => left - right)
  const mad = deviations[Math.floor(deviations.length / 2)]
  const budget = options.ceiling ?? Math.max(median * 0.75, mad * 8, 1)
  return { median, mad, budget, sampleCount: values.length }
}

/**
 * @param {{median: number, mad: number, budget: number}} profile
 * @param {number} sample
 */
export function assessTiming(profile, sample) {
  if (!profile || !Number.isFinite(profile.median) || !Number.isFinite(profile.budget)) throw new IntegrityError('BAD_TIMING', 'timing profile is missing')
  if (!Number.isFinite(sample) || sample < 0) throw new IntegrityError('BAD_TIMING', 'timing sample must be a finite non-negative number')
  const deviation = Math.abs(sample - profile.median)
  return { anomaly: deviation > profile.budget, deviation, budget: profile.budget, median: profile.median }
}

/** @param {string} type @param {string} target @param {string} detail @param {object} evidence @param {number} now */
function findingOf(type, target, detail, evidence, now) {
  return {
    type,
    severity: SEVERITY_BY_TYPE[type] ?? 'medium',
    target,
    detail,
    evidence,
    detectedAt: now,
  }
}

/**
 * @param {Array<{name: string, fn: Function, owner?: object, key?: string}>} targets
 * @param {object} baseline
 * @param {Map<string, object>} prototypes
 * @param {number} now
 */
function inspect(targets, baseline, prototypes, now) {
  const findings = []
  if (hashFunctionSource(Function.prototype.toString) !== baseline.toStringHash) {
    findings.push(findingOf('TO_STRING_TAMPER', 'Function.prototype.toString', 'Function.prototype.toString was replaced', { expected: baseline.toStringHash, actual: hashFunctionSource(Function.prototype.toString) }, now))
  }
  for (const expected of baseline.functions) {
    const target = targets.find((candidate) => candidate.name === expected.name)
    if (!target) {
      findings.push(findingOf('FUNCTION_REPLACED', expected.name, 'target is no longer monitored', { expected: expected.sourceHash }, now))
      continue
    }
    const current = liveFunction(target)
    if (typeof current !== 'function') {
      findings.push(findingOf('FUNCTION_REPLACED', expected.name, 'target is no longer a function', { expected: expected.sourceHash, actual: typeof current }, now))
      continue
    }
    const actualHash = hashFunctionSource(current)
    if (actualHash !== expected.sourceHash) {
      findings.push(findingOf('HOT_PATCH', expected.name, 'function source changed after the baseline', { expected: expected.sourceHash, actual: actualHash }, now))
    }
    if (expected.descriptor && target.owner !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(target.owner, target.key)
      const currentDescriptor = descriptor
        ? {
            writable: Boolean(descriptor.writable),
            enumerable: Boolean(descriptor.enumerable),
            configurable: Boolean(descriptor.configurable),
            getter: typeof descriptor.get === 'function',
            setter: typeof descriptor.set === 'function',
          }
        : null
      if (JSON.stringify(currentDescriptor) !== JSON.stringify(expected.descriptor)) {
        findings.push(findingOf('DESCRIPTOR_TAMPER', expected.name, 'property descriptor changed', { expected: expected.descriptor, actual: currentDescriptor }, now))
      }
    }
    const ownNames = Object.getOwnPropertyNames(current).sort()
    if (JSON.stringify(ownNames) !== JSON.stringify(expected.ownNames)) {
      findings.push(findingOf('DESCRIPTOR_TAMPER', expected.name, 'function own properties changed', { expected: expected.ownNames, actual: ownNames }, now))
    }
    const protoName = Object.getPrototypeOf(current)?.constructor?.name ?? null
    if (protoName !== expected.protoName) {
      findings.push(findingOf('PROTOTYPE_CHAIN_TAMPER', expected.name, 'function prototype chain changed', { expected: expected.protoName, actual: protoName }, now))
    }
  }
  for (const name of Object.keys(baseline.prototypes).sort()) {
    const expected = baseline.prototypes[name]
    const prototype = prototypes.get(name)
    if (!prototype) {
      findings.push(findingOf('PROTOTYPE_MISSING', name, 'watched prototype is missing', {}, now))
      continue
    }
    const keys = Object.getOwnPropertyNames(prototype).sort()
    const added = keys.filter((key) => !expected.keys.includes(key))
    const removed = expected.keys.filter((key) => !keys.includes(key))
    if (added.length > 0) {
      findings.push(findingOf('PROTOTYPE_POLLUTION', name, 'unexpected prototype properties were added', { added }, now))
    }
    if (removed.length > 0) {
      findings.push(findingOf('PROTOTYPE_TAMPER', name, 'prototype properties were removed', { removed }, now))
    }
    if (added.length === 0 && removed.length === 0) {
      const fingerprint = prototypeFingerprint(prototype)
      if (fingerprint !== expected.fingerprint) {
        findings.push(findingOf('PROTOTYPE_TAMPER', name, 'prototype descriptors changed', { expected: expected.fingerprint, actual: fingerprint }, now))
      }
    }
  }
  return findings
}

/**
 * @param {{
 *   targets: object|Array, baseline?: object,
 *   sampleRate?: number, maxInterval?: number, seed?: number,
 *   timingProfile?: object, prototypes?: Array<{name: string, object: object}>,
 *   now?: number
 * }} options
 */
export function createIntegrityMonitor(options) {
  const targets = normalizeTargets(options.targets)
  const baseline = options.baseline ?? captureBaseline(targets, { now: options.now, prototypes: options.prototypes })
  if (!baseline || baseline.v !== 1 || !Array.isArray(baseline.functions) || !baseline.prototypes) {
    throw new IntegrityError('BAD_BASELINE', 'baseline is incomplete')
  }
  const names = new Set(baseline.functions.map((entry) => entry.name))
  for (const target of targets) if (!names.has(target.name)) throw new IntegrityError('BAD_BASELINE', `baseline has no entry for ${target.name}`)
  const registry = new Map([
    ['Object.prototype', Object.prototype],
    ['Array.prototype', Array.prototype],
    ['Function.prototype', Function.prototype],
    ['String.prototype', String.prototype],
  ])
  for (const entry of options.prototypes ?? []) registry.set(entry.name, entry.object)
  const sampleRate = options.sampleRate ?? 0.4
  const maxInterval = options.maxInterval ?? 10
  if (!(sampleRate >= 0 && sampleRate <= 1)) throw new IntegrityError('BAD_SAMPLING', 'sampleRate must be in [0, 1]')
  if (!Number.isInteger(maxInterval) || maxInterval < 1) throw new IntegrityError('BAD_SAMPLING', 'maxInterval must be a positive integer')
  const random = mulberry32(options.seed ?? 0x5eed)
  const findingMap = new Map()
  const state = { ticks: 0, checks: 0, skips: 0 }

  function record(findings) {
    for (const finding of findings) {
      const key = `${finding.type}::${finding.target}`
      const existing = findingMap.get(key)
      if (existing) {
        existing.count += 1
        existing.detectedAt = finding.detectedAt
        existing.detail = finding.detail
        existing.evidence = finding.evidence
      } else {
        findingMap.set(key, { ...finding, count: 1 })
      }
    }
  }

  const monitor = {
    baseline,
    timingProfile: options.timingProfile ?? null,
    get stats() {
      return { ...state, findings: findingMap.size }
    },
    check(checkOptions = {}) {
      state.ticks += 1
      const forced = checkOptions.force === true
      const due = forced || state.ticks % maxInterval === 0 || random() < sampleRate
      if (!due) {
        state.skips += 1
        return { checked: false, sampled: true, tick: state.ticks, findings: [] }
      }
      state.checks += 1
      const now = checkOptions.now ?? Date.now()
      const findings = inspect(targets, baseline, registry, now)
      record(findings)
      return { checked: true, sampled: true, tick: state.ticks, findings }
    },
    timing(sample, timingOptions = {}) {
      if (!monitor.timingProfile) throw new IntegrityError('NO_TIMING_PROFILE', 'timing profile is not configured')
      const assessed = assessTiming(monitor.timingProfile, sample)
      if (!assessed.anomaly) return { ...assessed, finding: null }
      const finding = findingOf('TIMING_ANOMALY', timingOptions.name ?? 'critical-path', 'timing sample exceeded the calibrated budget', assessed, timingOptions.now ?? Date.now())
      record([finding])
      return { ...assessed, finding }
    },
    report(reportOptions = {}) {
      return buildIntegrityReport([...findingMap.values()], reportOptions)
    },
    findings() {
      return [...findingMap.values()].map((finding) => ({ ...finding }))
    },
    reset() {
      findingMap.clear()
      state.ticks = 0
      state.checks = 0
      state.skips = 0
    },
  }
  return monitor
}

/**
 * @param {Array} findings
 * @param {{sessionId?: string, now?: number}} [options]
 */
export function buildIntegrityReport(findings, options = {}) {
  const list = (findings ?? []).map((finding) => ({ ...finding }))
  const bySeverity = {}
  const byType = {}
  for (const finding of list) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
    byType[finding.type] = (byType[finding.type] ?? 0) + 1
  }
  const report = {
    v: 1,
    schema: SCHEMA,
    sessionId: options.sessionId ?? 'local-session',
    generatedAt: options.now ?? Date.now(),
    findings: list,
    summary: { total: list.length, bySeverity, byType },
  }
  report.digest = sha256Hex(canonicalJson(report))
  return report
}

/**
 * @param {object} finding
 * @param {{sessionId?: string, sequence?: number, now?: number}} [options]
 */
export function createTelemetryEvent(finding, options = {}) {
  if (!finding || typeof finding.type !== 'string') throw new IntegrityError('BAD_FINDING', 'finding type is required')
  const event = {
    v: 1,
    schema: 'anti-cheat.event.v1',
    sessionId: options.sessionId ?? 'local-session',
    sequence: options.sequence ?? 0,
    at: options.now ?? Date.now(),
    type: finding.type,
    severity: finding.severity ?? SEVERITY_BY_TYPE[finding.type] ?? 'medium',
    target: finding.target ?? 'unknown',
    detail: finding.detail ?? '',
    evidence: finding.evidence ?? {},
  }
  event.digest = sha256Hex(canonicalJson(event))
  event.id = sha256Hex(`${event.digest}:${event.sequence}`).slice(0, 16)
  return event
}

export async function generateTelemetryKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privateJwk,
    publicJwk,
    keyId: `telemetry-key-${sha256Hex(canonicalJson(publicJwk)).slice(0, 16)}`,
  }
}

/**
 * @param {object} report
 * @param {{privateKey?: CryptoKey, privateJwk?: object, keyId?: string}} keys
 */
export async function signIntegrityReport(report, keys) {
  if (!report || report.schema !== SCHEMA) throw new IntegrityError('BAD_REPORT', 'unsupported report schema')
  const { digest, ...body } = report
  if (digest !== sha256Hex(canonicalJson(body))) throw new IntegrityError('BAD_REPORT', 'report digest does not match its body')
  const key = keys.privateKey ?? (await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonicalJson(report)))
  return { v: 1, alg: ALGORITHM, keyId: keys.keyId ?? null, report, signature: Buffer.from(signature).toString('base64url') }
}

/**
 * @param {object} envelope
 * @param {{publicJwk?: object, publicKey?: CryptoKey}} keys
 */
export async function verifyIntegrityReport(envelope, keys = {}) {
  if (!envelope || envelope.alg !== ALGORITHM || envelope.v !== 1 || !envelope.report) throw new IntegrityError('BAD_ENVELOPE', 'unsupported report envelope')
  const report = envelope.report
  const { digest, ...body } = report
  if (digest !== sha256Hex(canonicalJson(body))) throw new IntegrityError('BAD_REPORT', 'report digest does not match its body')
  const publicKey = keys.publicKey ?? (await crypto.subtle.importKey('jwk', keys.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']))
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(envelope.signature, 'base64url'),
      encoder.encode(canonicalJson(report)),
    )
  } catch {
    throw new IntegrityError('BAD_SIGNATURE', 'report signature could not be verified')
  }
  if (!valid) throw new IntegrityError('BAD_SIGNATURE', 'report signature is invalid')
  return { valid: true, report, digest: report.digest, keyId: envelope.keyId }
}
