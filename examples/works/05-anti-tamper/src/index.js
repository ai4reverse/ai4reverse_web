/**
 * Anti-Tamper SDK — runtime integrity baselines for critical objects.
 *
 * Captures property descriptors, prototype shape and native function source for
 * a set of targets, then detects replacement, redefinition, prototype pollution
 * and `Function.prototype.toString` tampering. Deterministic and side-effect free.
 */
export const VERSION = '1.0.0'

export class TamperError extends Error {
  constructor(drift) {
    super(`integrity violation: ${drift.map((entry) => entry.target).join(', ')}`)
    this.name = 'TamperError'
    this.code = 'TAMPERED'
    this.drift = drift
  }
}

function sourceOf(fn) {
  try {
    return Function.prototype.toString.call(fn)
  } catch {
    return '[unreadable]'
  }
}

function describeDescriptor(descriptor) {
  if (!descriptor) return null
  return {
    kind: descriptor.get || descriptor.set ? 'accessor' : 'data',
    enumerable: Boolean(descriptor.enumerable),
    configurable: Boolean(descriptor.configurable),
    writable: descriptor.get || descriptor.set ? null : Boolean(descriptor.writable),
    get: descriptor.get ? sourceOf(descriptor.get) : null,
    set: descriptor.set ? sourceOf(descriptor.set) : null,
    valueType: 'value' in descriptor ? typeof descriptor.value : null,
    valueSource: typeof descriptor.value === 'function' ? sourceOf(descriptor.value) : null,
  }
}

/**
 * @param {Record<string, object>} targets e.g. { Math, Function, Array: Array.prototype }
 */
export function snapshot(targets) {
  const captured = {}
  for (const [name, target] of Object.entries(targets)) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
      captured[name] = null
      continue
    }
    const properties = {}
    for (const key of Object.getOwnPropertyNames(target).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      properties[key] = describeDescriptor(descriptor)
    }
    const symbols = Object.getOwnPropertySymbols(target)
      .map((symbol) => String(symbol))
      .sort()
    const prototype = Object.getPrototypeOf(target)
    captured[name] = {
      kind: typeof target,
      properties,
      symbols,
      prototype: prototype ? (prototype.constructor?.name ?? 'null') : null,
      name: typeof target === 'function' ? target.name : null,
      length: typeof target === 'function' ? target.length : null,
    }
  }
  return { version: VERSION, captured }
}

export function diff(before, after) {
  const drift = []
  if (!before?.captured || !after?.captured) return [{ target: 'baseline', kind: 'missing' }]
  for (const name of Object.keys(before.captured)) {
    const left = before.captured[name]
    const right = after.captured[name]
    if (!right) {
      drift.push({ target: name, kind: 'missing-target' })
      continue
    }
    if (!left) continue
    if (left.name !== right.name) drift.push({ target: name, kind: 'name-changed', before: left.name, after: right.name })
    if (left.length !== right.length) drift.push({ target: name, kind: 'length-changed', before: left.length, after: right.length })
    if (left.prototype !== right.prototype) drift.push({ target: name, kind: 'prototype-changed' })
    const keys = new Set([...Object.keys(left.properties), ...Object.keys(right.properties)])
    for (const key of keys) {
      const a = left.properties[key]
      const b = right.properties[key]
      if (!a) drift.push({ target: `${name}.${key}`, kind: 'property-added' })
      else if (!b) drift.push({ target: `${name}.${key}`, kind: 'property-removed' })
      else if (JSON.stringify(a) !== JSON.stringify(b)) drift.push({ target: `${name}.${key}`, kind: 'descriptor-changed' })
    }
    if (left.symbols.join('|') !== right.symbols.join('|')) drift.push({ target: name, kind: 'symbols-changed' })
  }
  for (const name of Object.keys(after.captured)) {
    if (!(name in before.captured)) drift.push({ target: name, kind: 'target-added' })
  }
  return drift
}

export function assertIntact(before, after) {
  const drift = diff(before, after)
  if (drift.length > 0) throw new TamperError(drift)
  return true
}

/** Continuous guard: call check() at security boundaries or on a timer. */
export function createGuard(targets, options = {}) {
  const baseline = snapshot(targets)
  let lastDrift = []
  const guard = {
    baseline,
    check() {
      lastDrift = diff(baseline, snapshot(targets))
      if (lastDrift.length > 0 && options.onTamper) options.onTamper(lastDrift)
      return lastDrift.length === 0
    },
    assert() {
      guard.check()
      if (lastDrift.length > 0) throw new TamperError(lastDrift)
      return true
    },
    drift() {
      return lastDrift
    },
    rebaseline() {
      return snapshot(targets)
    },
  }
  return guard
}
