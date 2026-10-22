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

import { hashObject } from '../util/hash.js'
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

/**
 * Brand targets pre-split here so the guest snapshot never has to call
 * `String.prototype.split` (itself a poisonable intrinsic).
 */
const BRAND_TARGET_PATHS = BRAND_TARGETS.map((name) => ({ name, path: name.split('.') }))

/**
 * Snapshot primitives captured once per context, before guest code runs.
 *
 * The snapshot is built from guest-visible objects, so every intrinsic it uses
 * is writable by the sample. Two defences:
 *
 *  1. `makeIntegritySnapshot` closes over the originals captured at first
 *     capture time and reports which of them have since been replaced, so a
 *     tampered primitive yields `{ tampered: <name> }` instead of a forged view.
 *  2. The produced object is serialised by the host with the *captured*
 *     original `JSON.stringify` handle, never by the guest's writable global.
 *
 * @type {WeakMap<object, { snapshot: object, stringify: object }>}
 */
const SNAPSHOT_PRIMITIVES = new WeakMap()

const SNAPSHOT_SOURCE = `(function makeIntegritySnapshot(){
  var g = globalThis;
  var getOwnPropertyNames = Object.getOwnPropertyNames;
  var getOwnPropertySymbols = Object.getOwnPropertySymbols;
  var fnToString = Function.prototype.toString;
  var stringify = JSON.stringify;
  var apply = Reflect.apply;
  var arraySort = Array.prototype.sort;
  var create = Object.create;
  var setPrototypeOf = Object.setPrototypeOf;
  var StringCtor = String;
  var DateCtor = Date;
  var names = ${JSON.stringify(INTRINSIC_NAMES)};
  var brandTargets = ${JSON.stringify(BRAND_TARGET_PATHS)};

  function tamperedPrimitive() {
    if (stringify !== JSON.stringify) return 'JSON.stringify';
    if (getOwnPropertyNames !== Object.getOwnPropertyNames) return 'Object.getOwnPropertyNames';
    if (getOwnPropertySymbols !== Object.getOwnPropertySymbols) return 'Object.getOwnPropertySymbols';
    if (fnToString !== Function.prototype.toString) return 'Function.prototype.toString';
    if (apply !== Reflect.apply) return 'Reflect.apply';
    if (arraySort !== Array.prototype.sort) return 'Array.prototype.sort';
    if (create !== Object.create) return 'Object.create';
    if (setPrototypeOf !== Object.setPrototypeOf) return 'Object.setPrototypeOf';
    if (StringCtor !== String) return 'String';
    return null;
  }

  // Records and arrays are detached from their prototypes so inherited
  // accessors or a polluted \`toJSON\` cannot rewrite the snapshot while the
  // host serialises it.
  function detached(array) {
    // Direct call: QuickJS's Reflect.apply rejects a null argument, which
    // would leave the array wearing a prototype the sample can pollute.
    try { setPrototypeOf(array, null); } catch (e) { /* best effort */ }
    return array
  }

  function record() {
    return create(null);
  }

  return function snapshot() {
    var tampered = tamperedPrimitive();
    if (tampered) {
      var sentinel = record();
      sentinel.tampered = tampered;
      return sentinel;
    }
    var out = record();
    try { out.globals = detached(apply(arraySort, getOwnPropertyNames(g), [])); } catch (e) { out.globals = []; }
    try {
      var symbolList = typeof getOwnPropertySymbols === 'function' ? getOwnPropertySymbols(g) : [];
      var symbolNames = [];
      for (var s = 0; s < symbolList.length; s++) symbolNames[s] = StringCtor(symbolList[s]);
      out.symbols = detached(apply(arraySort, symbolNames, []));
    } catch (e) { out.symbols = []; }
    var intrinsics = record();
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        var ctor = g[name];
        // Both constructor intrinsics (Error, Uint8Array) and namespace objects
        // (Math, JSON, Reflect) are recorded. A value of any other shape means
        // the sample replaced the intrinsic, which \`diffIntegrity\` reports.
        var isFunction = typeof ctor === 'function';
        var isObject = typeof ctor === 'object' && ctor !== null;
        if (!isFunction && !isObject) { intrinsics[name] = null; continue; }
        var proto = isFunction ? ctor.prototype || {} : {};
        var entry = record();
        entry.kind = isFunction ? 'function' : 'object';
        entry.ctor = detached(apply(arraySort, getOwnPropertyNames(ctor), []));
        entry.proto = detached(apply(arraySort, getOwnPropertyNames(proto), []));
        intrinsics[name] = entry;
      } catch (e) { intrinsics[name] = null; }
    }
    out.intrinsics = intrinsics;
    var natives = record();
    for (var j = 0; j < brandTargets.length; j++) {
      var brand = brandTargets[j];
      var path = brand.path;
      var value = g;
      for (var k = 0; k < path.length && value !== undefined && value !== null; k++) {
        try { value = value[path[k]]; } catch (e) { value = undefined; }
      }
      var text = 'missing';
      if (typeof value === 'function') {
        try { text = apply(fnToString, value, []); } catch (e) { text = 'unreadable'; }
      }
      natives[brand.name] = text;
    }
    out.natives = natives;
    var values = record();
    try {
      values.userAgent = StringCtor((g.navigator && g.navigator.userAgent) || '');
      values.platform = StringCtor((g.navigator && g.navigator.platform) || '');
      values.hardwareConcurrency = (g.navigator && g.navigator.hardwareConcurrency) || 0;
      values.timezoneOffset = new DateCtor(0).getTimezoneOffset();
      values.language = StringCtor((g.navigator && g.navigator.language) || '');
    } catch (e) { values.error = StringCtor(e && e.message); }
    out.values = values;
    return out;
  };
})()`

/**
 * Obtain (or create) the snapshot function and the original `JSON.stringify`
 * handle for a context. The first call runs before guest code, so those are the
 * pristine originals; later calls reuse them even if the guest rewrote globals.
 *
 * @param {object} ctx QuickJSContext
 * @param {object|null} trace
 * @returns {{ snapshot: object, stringify: object }|null}
 */
function snapshotPrimitives(ctx, trace) {
  const cached = SNAPSHOT_PRIMITIVES.get(ctx)
  if (cached) return cached
  let result
  try {
    result = ctx.evalCode(SNAPSHOT_SOURCE, 'ai4r-internal:integrity-snapshot')
  } catch (error) {
    trace?.emit?.('sandbox', 'error', {
      event: 'integrity.primitives.failed',
      message: errorMessage(error),
    })
    return null
  }
  if (result.error) {
    disposeResult(result.error)
    return null
  }
  let stringify
  try {
    stringify = ctx.unwrapResult(ctx.evalCode('JSON.stringify', 'ai4r-internal:integrity-stringify'))
  } catch (error) {
    disposeResult(result.value)
    trace?.emit?.('sandbox', 'error', {
      event: 'integrity.primitives.failed',
      message: errorMessage(error),
    })
    return null
  }
  const primitives = { snapshot: result.value, stringify }
  SNAPSHOT_PRIMITIVES.set(ctx, primitives)
  releaseWithContext(ctx, primitives)
  return primitives
}

/**
 * Cached primitives are live guest handles. The context owns their lifetime, so
 * dispose them just before the context is freed — otherwise the runtime's
 * `JS_FreeRuntime` aborts on the leaked GC objects.
 *
 * @param {object} ctx QuickJSContext
 * @param {{ snapshot: object, stringify: object }} primitives
 */
function releaseWithContext(ctx, primitives) {
  const originalDispose = ctx.dispose
  let released = false
  ctx.dispose = function disposeWithSnapshotPrimitives() {
    if (!released) {
      released = true
      SNAPSHOT_PRIMITIVES.delete(ctx)
      disposeResult(primitives.snapshot)
      disposeResult(primitives.stringify)
    }
    return originalDispose.call(ctx)
  }
}

function disposeResult(handle) {
  try {
    handle?.dispose?.()
  } catch {
    /* already released */
  }
}

/**
 * @param {object} ctx QuickJSContext
 * @param {object} [options]
 * @param {object} [options.stealth]
 * @param {object} [options.trace]
 */
export function captureIntegrity(ctx, options = {}) {
  const { stealth, trace } = options
  const primitives = snapshotPrimitives(ctx, trace)
  if (!primitives) {
    return unavailableSnapshot(trace, 'snapshot primitives unavailable')
  }
  let result
  try {
    result = ctx.callFunction(primitives.snapshot, ctx.undefined, [])
  } catch (error) {
    // The guest controls the snapshot's globals, so even the evaluation may
    // fail at the host boundary. Integrity is one evidence source, not a
    // precondition for the run record.
    return unavailableSnapshot(trace, `snapshot failed: ${errorMessage(error)}`)
  }
  if (result.error) {
    let dumped = null
    try {
      // `dump()` consumes promise handles; disposing it again would throw.
      dumped = ctx.dump(result.error)
    } catch {
      dumped = null
    }
    try {
      result.error.dispose()
    } catch {
      /* already released by dump() */
    }
    return unavailableSnapshot(trace, dumped?.message ?? 'snapshot failed')
  }
  const snapshotHandle = result.value
  let text
  try {
    text = stringifySnapshot(ctx, primitives.stringify, snapshotHandle, trace)
  } finally {
    disposeResult(snapshotHandle)
  }
  if (text === null) return unavailableSnapshot(trace, 'snapshot unreadable')
  try {
    const data = JSON.parse(text)
    // A snapshot whose own primitives were replaced is untrustworthy even when
    // the returned shape looks valid.
    if (isPlainRecord(data) && typeof data.tampered === 'string') {
      return unavailableSnapshot(trace, `snapshot primitives replaced: ${data.tampered}`)
    }
    // The snapshot's shape is untrusted input: malformed data only costs this
    // snapshot, never the whole run.
    if (!isSnapshotShape(data)) {
      return unavailableSnapshot(trace, 'snapshot shape invalid')
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
  } catch (error) {
    // Any post-parse failure (a getter-shaped snapshot, sanitisation, hashing)
    // degrades to "unavailable" instead of escaping to `run()`.
    return unavailableSnapshot(trace, `snapshot invalid: ${errorMessage(error)}`)
  }
}

/**
 * Serialise the snapshot object with the host-captured original
 * `JSON.stringify`, so replacing the guest global cannot forge the record.
 *
 * @param {object} ctx QuickJSContext
 * @param {object} stringifyHandle original `JSON.stringify` handle
 * @param {object} snapshotHandle guest snapshot object
 * @param {object|null} trace
 * @returns {string|null}
 */
function stringifySnapshot(ctx, stringifyHandle, snapshotHandle, trace) {
  let call
  try {
    call = ctx.callFunction(stringifyHandle, ctx.undefined, [snapshotHandle])
  } catch (error) {
    trace?.emit?.('sandbox', 'error', {
      event: 'integrity.serialize.failed',
      message: errorMessage(error),
    })
    return null
  }
  if (call.error) {
    try {
      const dumped = ctx.dump(call.error)
      trace?.emit?.('sandbox', 'error', {
        event: 'integrity.serialize.failed',
        message: dumped?.message ?? 'serialize failed',
      })
    } catch {
      /* diagnostics are best-effort */
    }
    disposeResult(call.error)
    return null
  }
  try {
    return ctx.getString(call.value)
  } catch (error) {
    trace?.emit?.('sandbox', 'error', {
      event: 'integrity.serialize.failed',
      message: errorMessage(error),
    })
    return null
  } finally {
    disposeResult(call.value)
  }
}

/**
 * The record used whenever a snapshot cannot be taken or trusted.
 * @param {{emit?: Function}|null} trace
 * @param {string} message
 * @returns {object}
 */
function unavailableSnapshot(trace, message) {
  trace?.emit?.('sandbox', 'error', { event: 'integrity.capture.failed', message })
  return {
    hash: 'unavailable',
    error: message,
    globals: [],
    symbols: [],
    intrinsics: {},
    natives: {},
    values: {},
    takenAt: Date.now(),
  }
}

/**
 * Minimum shape `diffIntegrity` and the run record rely on.
 * @param {unknown} data
 * @returns {boolean}
 */
function isSnapshotShape(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  if (!Array.isArray(data.globals) || !data.globals.every((name) => typeof name === 'string')) return false
  if (!Array.isArray(data.symbols)) return false
  return isPlainRecord(data.intrinsics) && isPlainRecord(data.natives) && isPlainRecord(data.values)
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A recorded intrinsic entry (`{ kind, ctor, proto }`). A `null` entry means the
 * global was absent or no longer had a function/object shape.
 * @param {unknown} value
 * @returns {boolean}
 */
function isIntrinsicEntry(value) {
  return isPlainRecord(value) && typeof value.kind === 'string'
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'unknown error')
}


/**
 * Compare two snapshots and list every observable difference.
 * @param {object} before
 * @param {object} after
 */
export function diffIntegrity(before, after) {
  const drift = []
  if (!before || !after || before.hash === 'unavailable' || after.hash === 'unavailable') {
    // Keep the record shape identical to the comparable case: consumers index
    // `intrinsicDrift` unconditionally, and an unavailable snapshot is drift.
    const unavailable = [{ kind: 'unavailable', detail: 'integrity snapshot unavailable' }]
    return {
      intact: false,
      drift: unavailable,
      intrinsicDrift: unavailable,
      beforeHash: before?.hash,
      afterHash: after?.hash,
      addedGlobals: [],
      removedGlobals: [],
    }
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
    // A baseline entry proves the intrinsic existed with a function/object
    // shape. Losing that shape means the sample replaced it; a missing entry on
    // both sides is not observable and stays out of the record.
    if (!isIntrinsicEntry(beforeIntrinsic)) continue
    if (!isIntrinsicEntry(afterIntrinsic) || afterIntrinsic.kind !== beforeIntrinsic.kind) {
      drift.push({ kind: 'intrinsic-replaced', target: name })
      continue
    }
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
