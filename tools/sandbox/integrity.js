import { hashObject } from '../util/hash.js'

/**
 * Intrinsic integrity snapshots.
 *
 * Two independent questions need an answer for every run:
 *  1. Did *we* alter the environment while instrumenting? (a platform bug)
 *  2. Did the *sample* alter intrinsics/prototypes? (very common malware
 *     behaviour and analytically valuable: prototype pollution, `Array.prototype`
 *     patching, `JSON.stringify` replacement to hide data, `Function.prototype.toString`
 *     brand checks, hooking `fetch`.)
 *
 * Because every run starts from a fresh context, "restore" means "next run is
 * pristine". Snapshotting lets the report prove that.
 */

const INTRINSIC_NAMES = [
  'Object',
  'Function',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'JSON',
  'Promise',
  'Math',
  'Symbol',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Reflect',
  'Proxy',
  'Intl',
  'ArrayBuffer',
  'Uint8Array',
  'WebAssembly',
]

const BRAND_TARGETS = [
  'Object.keys',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertyDescriptor',
  'Object.defineProperty',
  'Function.prototype.call',
  'Function.prototype.apply',
  'Function.prototype.bind',
  'Array.prototype.push',
  'Array.prototype.join',
  'String.prototype.indexOf',
  'String.prototype.slice',
  'JSON.stringify',
  'JSON.parse',
  'Date.now',
  'Promise.prototype.then',
]

const SNAPSHOT_SOURCE = `(function snapshot(){
  var g = globalThis;
  var out = { globals: [], symbols: [], intrinsics: {}, natives: {}, values: {} };
  out.globals = Object.getOwnPropertyNames(g).sort();
  try {
    out.symbols = (Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(g) : []).map(function(s){ return String(s); }).sort();
  } catch (e) { out.symbols = []; }
  var names = ${JSON.stringify(INTRINSIC_NAMES)};
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var ctor = g[name];
    if (typeof ctor !== 'function') { out.intrinsics[name] = null; continue; }
    var proto = ctor.prototype || {};
    out.intrinsics[name] = {
      ctor: Object.getOwnPropertyNames(ctor).sort(),
      proto: Object.getOwnPropertyNames(proto).sort()
    };
  }
  var brandTargets = ${JSON.stringify(BRAND_TARGETS)};
  for (var j = 0; j < brandTargets.length; j++) {
    var path = brandTargets[j].split('.');
    var value = g;
    for (var k = 0; k < path.length && value !== undefined && value !== null; k++) {
      try { value = value[path[k]]; } catch (e) { value = undefined; }
    }
    var text = 'missing';
    if (typeof value === 'function') {
      try { text = Function.prototype.toString.call(value); } catch (e) { text = 'unreadable'; }
    }
    out.natives[brandTargets[j]] = text;
  }
  try {
    out.values.userAgent = String((g.navigator && g.navigator.userAgent) || '');
    out.values.platform = String((g.navigator && g.navigator.platform) || '');
    out.values.hardwareConcurrency = (g.navigator && g.navigator.hardwareConcurrency) || 0;
    out.values.timezoneOffset = new Date(0).getTimezoneOffset();
    out.values.language = String((g.navigator && g.navigator.language) || '');
  } catch (e) { out.values.error = String(e && e.message); }
  return JSON.stringify(out);
})()`

/**
 * @param {object} ctx QuickJSContext
 * @param {object} [options]
 * @param {object} [options.stealth]
 * @param {object} [options.trace]
 */
export function captureIntegrity(ctx, options = {}) {
  const { stealth, trace } = options
  const result = ctx.evalCode(SNAPSHOT_SOURCE, 'about:blank')
  if (result.error) {
    const dumped = ctx.dump(result.error)
    result.error.dispose()
    trace?.emit('sandbox', 'error', { event: 'integrity.capture.failed', message: dumped?.message })
    return {
      hash: 'unavailable',
      error: dumped?.message ?? 'snapshot failed',
      globals: [],
      intrinsics: {},
      natives: {},
      values: {},
      takenAt: Date.now(),
    }
  }
  const text = ctx.getString(result.value)
  result.value.dispose()
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { hash: 'unavailable', error: `snapshot JSON invalid: ${error.message}`, globals: [], intrinsics: {}, natives: {} }
  }
  const snapshot = {
    ...data,
    hash: hashObject(data),
    takenAt: Date.now(),
    globalCount: data.globals.length,
    nativeCount: Object.keys(data.natives).length,
  }
  if (stealth) {
    // Snapshot stacks/strings are produced by masked toString; run the text
    // through the same sanitiser so reports never leak platform markers.
    snapshot.sanitized = stealth.sanitizeText(text).length > 0
  }
  return snapshot
}

/**
 * Compare two snapshots and list every observable difference.
 * @param {object} before
 * @param {object} after
 */
export function diffIntegrity(before, after) {
  const drift = []
  if (!before || !after || before.hash === 'unavailable' || after.hash === 'unavailable') {
    return { intact: false, drift: [{ kind: 'unavailable', detail: 'integrity snapshot unavailable' }] }
  }

  const beforeGlobals = new Set(before.globals ?? [])
  const afterGlobals = new Set(after.globals ?? [])
  for (const name of afterGlobals) {
    if (!beforeGlobals.has(name)) drift.push({ kind: 'global-added', target: name })
  }
  for (const name of beforeGlobals) {
    if (!afterGlobals.has(name)) drift.push({ kind: 'global-removed', target: name })
  }

  const beforeSymbols = new Set(before.symbols ?? [])
  const afterSymbols = new Set(after.symbols ?? [])
  for (const symbol of afterSymbols) {
    if (!beforeSymbols.has(symbol)) drift.push({ kind: 'symbol-added', target: symbol })
  }
  for (const symbol of beforeSymbols) {
    if (!afterSymbols.has(symbol)) drift.push({ kind: 'symbol-removed', target: symbol })
  }

  for (const name of INTRINSIC_NAMES) {
    const beforeIntrinsic = before.intrinsics?.[name]
    const afterIntrinsic = after.intrinsics?.[name]
    if (!beforeIntrinsic || !afterIntrinsic) continue
    const beforeProto = new Set(beforeIntrinsic.proto ?? [])
    const afterProto = new Set(afterIntrinsic.proto ?? [])
    for (const prop of afterProto) {
      if (!beforeProto.has(prop)) drift.push({ kind: 'prototype-added', target: `${name}.prototype.${prop}` })
    }
    for (const prop of beforeProto) {
      if (!afterProto.has(prop)) drift.push({ kind: 'prototype-removed', target: `${name}.prototype.${prop}` })
    }
    const beforeCtor = new Set(beforeIntrinsic.ctor ?? [])
    const afterCtor = new Set(afterIntrinsic.ctor ?? [])
    for (const prop of afterCtor) {
      if (!beforeCtor.has(prop)) drift.push({ kind: 'constructor-added', target: `${name}.${prop}` })
    }
    for (const prop of beforeCtor) {
      if (!afterCtor.has(prop)) drift.push({ kind: 'constructor-removed', target: `${name}.${prop}` })
    }
  }

  for (const [name, text] of Object.entries(after.natives ?? {})) {
    const previous = before.natives?.[name]
    if (previous !== undefined && previous !== text) {
      drift.push({ kind: 'native-changed', target: name, detail: `${truncate(previous)} -> ${truncate(text)}` })
    }
  }

  for (const [key, value] of Object.entries(after.values ?? {})) {
    const previous = before.values?.[key]
    if (previous !== undefined && previous !== value) {
      drift.push({ kind: 'value-changed', target: key, detail: `${String(previous)} -> ${String(value)}` })
    }
  }

  // Scripts legitimately define globals (`var payload = ...`). Those are
  // recorded, not treated as integrity violations; only intrinsic/prototype or
  // native-function changes count as tampering.
  const intrinsicDrift = drift.filter(
    (entry) => entry.kind !== 'global-added' && entry.kind !== 'global-removed',
  )
  return {
    intact: intrinsicDrift.length === 0,
    drift,
    intrinsicDrift,
    beforeHash: before.hash,
    afterHash: after.hash,
    addedGlobals: drift.filter((entry) => entry.kind === 'global-added').map((entry) => entry.target),
    removedGlobals: drift.filter((entry) => entry.kind === 'global-removed').map((entry) => entry.target),
  }
}

function truncate(text, max = 120) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export { INTRINSIC_NAMES, BRAND_TARGETS, SNAPSHOT_SOURCE }
