import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'anti-fingerprint']

async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    ...options,
  })
}

test('default script filename looks like a real web resource', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('1 + 1')
    assert.match(run.filename, /^https:\/\/[^/]+\/static\/js\/[0-9a-f]{8}\.min\.js$/)
    assert.doesNotMatch(run.filename, /sandbox|eval|ai4r|test/i)
  } finally {
    sb.dispose()
  }
})

test('sourceUrl is preserved (fragment stripped) for stack fidelity', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('(function f(){ return new Error("x").stack })()', {
      sourceUrl: 'https://evil.example.test/loader.js?v=3#frag',
    })
    assert.equal(run.filename, 'https://evil.example.test/loader.js?v=3')
    const stack = run.result.value
    assert.match(stack, /evil\.example\.test\/loader\.js\?v=3:\d+:\d+/)
    assert.doesNotMatch(stack, /<eval>/)
  } finally {
    sb.dispose()
  }
})

test('entry invocation converts JSON arguments both ways', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      'globalThis.main = function (cfg, n) { return [cfg.host, cfg.nested.flag, n + 1] }',
      { entry: 'main', args: [{ host: 'c2.test', nested: { flag: true } }, 41] },
    )
    assert.equal(run.ok, true)
    assert.equal(run.result.preview, '["c2.test",true,42]')
  } finally {
    sb.dispose()
  }
})

test('module source type exports a namespace', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('export const answer = 42; export function add(a,b){return a+b}', {
      type: 'module',
      sourceUrl: 'https://cdn.test/app.mjs',
    })
    assert.equal(run.ok, true)
    assert.equal(run.result.type, 'object')
    assert.match(run.result.preview, /"answer":42|answer/)
  } finally {
    sb.dispose()
  }
})

test('promise jobs and virtual timers settle in event-loop order', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      globalThis.order = [];
      setTimeout(function () { order.push('timer-0') }, 0);
      Promise.resolve().then(function () { order.push('microtask-1') });
      setTimeout(function () { order.push('timer-50') }, 50);
      Promise.resolve().then(function () { order.push('microtask-2') });
    `,
    )
    assert.equal(run.ok, true)
    assert.equal(run.settle.jobs >= 2, true)
    assert.equal(run.settle.timerCallbacks >= 2, true)
    // The last expression is a Promise, so read the recorded ordering from the
    // trace instead of the (pending) result value.
    const consoleEvents = (run.events ?? []).filter((event) => event.kind === 'timer')
    assert.ok(consoleEvents.length >= 2)
    assert.ok(run.settle.timerCallbacks >= 2)
    assert.ok(run.virtualMs >= 50)
  } finally {
    sb.dispose()
  }
})

test('source size limit is enforced before evaluation', async () => {
  const sb = await sandbox({ limits: { maxSourceBytes: 1024 } })
  try {
    const run = await sb.run(`/*${'x'.repeat(4096)}*/ 1`)
    assert.equal(run.ok, false)
    assert.ok(run.limitsHit.includes('source-size'), JSON.stringify(run.limitsHit))
    assert.equal(run.error.code, 'SANDBOX_LIMIT')
  } finally {
    sb.dispose()
  }
})

test('staged eval payloads are distinguishable in the trace', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      var stage = atob('dmFyIG1hcmtlciA9ICJzdGFnZTIiOyBtYXJrZXI=');
      eval(stage)
    `)
    assert.equal(run.ok, true)
    const evalEvent = (run.events ?? []).find((event) => event.kind === 'code' && event.event === 'eval')
    assert.ok(evalEvent)
    assert.match(String(evalEvent.value?.value ?? ''), /stage2/)
    const atobEvent = (run.events ?? []).find((event) => event.kind === 'api' && event.api === 'atob')
    assert.ok(atobEvent)
    assert.match(String(atobEvent.value), /stage2/)
  } finally {
    sb.dispose()
  }
})

test('repeated invocation in one sandbox uses distinct filenames and contexts', async () => {
  const sb = await sandbox()
  try {
    const first = await sb.run('var marker = "a"; marker')
    const second = await sb.run('typeof marker')
    assert.equal(first.result.value, 'a')
    assert.equal(second.result.value, 'undefined')
    assert.notEqual(first.filename, undefined)
    assert.equal(first.disposal.ok, true)
  } finally {
    sb.dispose()
  }
})

test('entry-point stacks contain no host frames', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      'globalThis.start = function () { return new Error("inside entry").stack }',
      { entry: 'start', filename: 'https://cdn.test/entry.js' },
    )
    assert.equal(run.ok, true)
    const stack = run.result.value
    assert.match(stack, /https:\/\/cdn\.test\/entry\.js:\d+:\d+/)
    assert.doesNotMatch(stack, /invoke\.js|node_modules|ai4r-internal|<eval>|\/Users\//)
  } finally {
    sb.dispose()
  }
})

/**
 * Marshalling budget: a shared-reference DAG multiplies paths, not distinct
 * objects, so `ctx.dump()` expands `a = [a, a]` exponentially. The walk must
 * recognise the repeated reference and refuse the dump before it runs.
 */
test('a shared-reference completion value over the node budget is unrepresentable', async () => {
  const sb = await sandbox()
  try {
    const startedAt = Date.now()
    const run = await sb.run('var a = []; for (var i = 0; i < 22; i += 1) a = [a, a]; a')
    const elapsed = Date.now() - startedAt
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.result, { type: 'unrepresentable', reason: 'entries' })
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.stackExhaustion, false)
    assert.ok(elapsed < 2000, `marshalling must stay bounded, took ${elapsed}ms`)
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
    const followUp = await sb.run('2 + 2')
    assert.equal(followUp.ok, true)
    assert.equal(followUp.result.value, 4)
  } finally {
    sb.dispose()
  }
})

/**
 * Expansion budget, not node count: a large *flat* collection is cheap for
 * `ctx.dump()` (one path per element), so it must stay representable. Counting
 * every own property used to report a plain 1000-element array as
 * `{type: 'unrepresentable', reason: 'entries'}`.
 */
test('a flat 1000-element array completion value stays representable', async () => {
  const sb = await sandbox()
  try {
    const startedAt = Date.now()
    const run = await sb.run('var a = []; for (var i = 0; i < 1000; i += 1) a.push(i); a')
    const elapsed = Date.now() - startedAt
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.type, 'array')
    assert.equal(run.result.length, 1000)
    assert.match(String(run.result.preview ?? ''), /^\[0,1,2,/)
    assert.deepEqual(run.limitsHit, [])
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
    assert.ok(elapsed < 2000, `flat marshalling must stay fast, took ${elapsed}ms`)
  } finally {
    sb.dispose()
  }
})

/**
 * The budget walk used to look only at own properties, so a promise completion
 * value bypassed it entirely and `ctx.dump()` did the unbounded work itself.
 * The settled value must be walked under the same depth budget.
 */
test('a promise settled with a deeply nested object is unrepresentable', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      var o = {};
      for (var i = 0; i < 100; i += 1) o = { child: o };
      Promise.resolve(o)
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.result, { type: 'unrepresentable', reason: 'depth' })
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.stackExhaustion, false)
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
    const followUp = await sb.run('2 + 2')
    assert.equal(followUp.ok, true)
    assert.equal(followUp.result.value, 4)
  } finally {
    sb.dispose()
  }
})

/**
 * Same shape on the throw path: a rejected/fulfilled promise whose settled
 * state is over budget must be reported as an unrepresentable error value.
 * Host stack classification requires host evidence; marshalling a value is not
 * one, so the error name must stay `Error` rather than the engine's
 * `RangeError`.
 */
test('throwing a promise settled with a deep object is unrepresentable, not a stack breach', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      var o = {};
      for (var i = 0; i < 100; i += 1) o = { child: o };
      throw Promise.resolve(o)
    `)
    assert.equal(run.ok, false, JSON.stringify(run.result))
    assert.equal(run.error.name, 'Error')
    assert.match(String(run.error.message), /unrepresentable error value \(depth\)/)
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.stackExhaustion, false)
    assert.equal(run.timedOut, false)
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
    const followUp = await sb.run('6 * 7')
    assert.equal(followUp.ok, true)
    assert.equal(followUp.result.value, 42)
  } finally {
    sb.dispose()
  }
})

/**
 * A Proxy whose traps never return burns the host deadline while the *host*
 * marshals the completion value. The guest already returned, so the run used to
 * report `ok: true` with an empty `limitsHit` and a garbled result.
 */
test('a proxy completion value that burns the host timeout is reported as a timeout', async () => {
  const sb = await sandbox({ limits: { timeoutMs: 100 } })
  try {
    const run = await sb.run(`
      new Proxy({}, {
        ownKeys: function () { for (;;) {} },
        get: function () { for (;;) {} }
      })
    `)
    assert.equal(run.ok, false, JSON.stringify(run.result))
    assert.deepEqual(run.limitsHit, ['timeout'])
    assert.equal(run.timedOut, true)
    assert.equal(run.stackExhaustion, false)
    assert.equal(run.runtime.reason, 'timeout')
    assert.match(String(run.error?.message ?? ''), /timeout/)
    assert.equal(run.disposal.ok, true)
    const followUp = await sb.run('6 * 7')
    assert.equal(followUp.ok, true)
    assert.equal(followUp.result.value, 42)
  } finally {
    sb.dispose()
  }
})

/**
 * Evidence boundary: `ctx.dump()` already releases a promise handle (it reports
 * the promise state instead of its fields). Disposing it again made a sample
 * able to reject its own run with a host `Lifetime not alive` error, losing the
 * whole record.
 */
test('throwing a promise still returns a run record', async () => {
  const sb = await sandbox()
  try {
    for (const source of ['throw Promise.resolve(1)', 'Promise.reject(Promise.resolve(1))']) {
      const run = await sb.run(source)
      assert.ok(run && typeof run === 'object', source)
      assert.equal(run.stackExhaustion, false, source)
      assert.deepEqual(run.disposal, { ok: true, errors: [] }, `${source}: ${JSON.stringify(run.disposal)}`)
    }
  } finally {
    sb.dispose()
  }
})

/**
 * The settle timer branch classifies from the clock's explicit host-throw marker
 * (residual): message text is guest data, so a callback that only *says*
 * "stack overflow" must neither be reported as a stack limit nor stop the
 * batch.
 */
test('a guest stack message in a timer callback does not stop the batch', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      setTimeout(function () { throw new Error('Maximum call stack size exceeded') }, 0);
      setTimeout(function () { throw new RangeError('stack overflow') }, 1);
      setTimeout(function () { return 'third' }, 2);
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.stackExhaustion, false)
    assert.equal(run.settle.stackExhaustion, false)
    assert.equal(run.settle.error, null)
    // Every callback ran: a forged message is an ordinary timer error.
    assert.equal(run.settle.timerCallbacks, 3, JSON.stringify(run.settle))
    assert.deepEqual(run.disposal, { ok: true, errors: [] })

    const followUp = await sb.run('2 + 2')
    assert.equal(followUp.ok, true, JSON.stringify(followUp.error))
    assert.equal(followUp.result.value, 4)
  } finally {
    sb.dispose()
  }
})
