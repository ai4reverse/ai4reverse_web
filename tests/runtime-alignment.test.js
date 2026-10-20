import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { loadQuickJS } from '../tools/engine/runtime.js'
import { createInvoker } from '../tools/invocation/invoke.js'
import { createHarness } from './helpers/harness.js'

const MINIMAL_ENV = ['globals', 'console', 'timers', 'stack']

async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { only: MINIMAL_ENV },
    instrumentation: { code: { level: 'off' }, api: false, jsvmp: false },
    ...options,
  })
}

async function assertHealthyFollowUp(sb, module) {
  const run = await sb.run('21 * 2')
  assert.equal(run.ok, true)
  assert.equal(run.result.value, 42)
  assert.deepEqual(run.limitsHit, [])
  assert.equal(run.disposal.ok, true)
  assert.equal(await loadQuickJS(), module)
}

for (const [surface, setup] of [
  ['URLSearchParams', 'new URLSearchParams("a=1")'],
  ['FormData', 'new FormData()'],
]) {
  test(`${surface} forEach preserves guest exception identity without host stack evidence`, async () => {
    const sb = await sandbox({ env: { only: ['globals', 'url', 'blob'] } })
    const module = await loadQuickJS()
    try {
      const run = await sb.run(`
        var collection = ${setup};
        if (collection.append) collection.append('b', '2');
        var original = new RangeError('Maximum call stack size exceeded');
        var same = false;
        try { collection.forEach(function () { throw original }) }
        catch (error) { same = error === original }
        same
      `)
      assert.equal(run.ok, true)
      assert.equal(run.result.value, true)
      assert.deepEqual(run.limitsHit, [])
      assert.equal(run.stackExhaustion, false)
      assert.equal(run.disposal.ok, true)
      await assertHealthyFollowUp(sb, module)
      const uncaught = await sb.run(`
        var collection = ${setup};
        collection.append('b', '2');
        collection.forEach(function () { throw new Error('callback failed') })
      `)
      assert.equal(uncaught.ok, false)
      assert.equal(uncaught.error.message, 'callback failed')
      assert.doesNotMatch(uncaught.error.stack, /node_modules|\/Users\/|tools\/sandbox/)
      assert.deepEqual(uncaught.limitsHit, [])
      assert.equal(uncaught.disposal.ok, true)
      assert.equal(await loadQuickJS(), module)
    } finally {
      sb.dispose()
    }
  })
}

test('repeated network schedule refusal frees every rejected callback', async () => {
  const sb = await sandbox({ env: {}, limits: { maxTimers: 1 } })
  const module = await loadQuickJS()
  try {
    const run = await sb.run(`
      new WebSocket('wss://example.invalid/one');
      new WebSocket('wss://example.invalid/two');
      new WebSocket('wss://example.invalid/three');
      7
    `)
    assert.equal(run.ok, true)
    assert.ok(run.clock.droppedTimers >= 2)
    assert.equal(run.disposal.ok, true)
    await assertHealthyFollowUp(sb, module)
  } finally {
    sb.dispose()
  }
})

for (const [path, source, settle] of [
  ['executed', "new WebSocket('wss://example.invalid/accepted'); 7", {}],
  ['cancelled', "var socket = new WebSocket('wss://example.invalid/cancelled'); socket.close(); 7", {}],
  ['pending teardown', "new WebSocket('wss://example.invalid/pending'); 7", { maxTimerCallbacks: 0 }],
]) {
  test(`network callback ${path} path releases retained handles`, async () => {
    const sb = await sandbox({ env: { only: ['globals', 'network', 'websocket'] } })
    const module = await loadQuickJS()
    try {
      const run = await sb.run(source, { settle })
      assert.equal(run.ok, true)
      assert.equal(run.clock.droppedTimers, 0)
      assert.equal(run.disposal.ok, true)
      if (path === 'pending teardown') assert.ok(run.settle.pendingTimers > 0)
      else assert.ok(run.settle.timerCallbacks > 0)
      await assertHealthyFollowUp(sb, module)
    } finally {
      sb.dispose()
    }
  })
}

test('promise job batches respect the remaining settlement budget', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      for (var i = 0; i < 4; i++) Promise.resolve().then(function () { console.log('job') });
      7
    `, { settle: { maxJobs: 1 } })
    assert.equal(run.ok, true)
    assert.equal(run.settle.jobs, 1)
    assert.equal(run.settle.exhausted, true)
    assert.equal(run.events.filter((event) => event.api === 'console.log' && event.text === 'job').length, 1)
    assert.equal(run.disposal.ok, true)
  } finally {
    sb.dispose()
  }
})

for (const entry of [false, true]) {
  for (const message of ['interrupted', 'out of memory', 'allocation failed', 'string too long', 'array too long', 'source too large']) {
    test(`guest ${entry ? 'entry' : 'eval'} error text ${JSON.stringify(message)} is not resource evidence`, async () => {
      const sb = await sandbox()
      const module = await loadQuickJS()
      try {
        const body = `throw new Error(${JSON.stringify(message)})`
        const run = await sb.run(entry ? `function main() { ${body} }` : body, entry ? { entry: 'main' } : {})
        assert.equal(run.ok, false)
        assert.equal(run.error.message, message)
        assert.deepEqual(run.limitsHit, [])
        assert.equal(run.timedOut, false)
        assert.equal(run.stackExhaustion, false)
        assert.equal(run.disposal.ok, true)
        await assertHealthyFollowUp(sb, module)
      } finally {
        sb.dispose()
      }
    })
  }
}

for (const entry of [false, true]) {
  test(`real ${entry ? 'entry' : 'eval'} timeout uses the runtime reason and releases normally`, async () => {
    const sb = await sandbox({ limits: { timeoutMs: 100 } })
    const module = await loadQuickJS()
    try {
      await assertHealthyFollowUp(sb, module)
      // Finite CPU work, bounded by both iteration count and the sandbox deadline.
      const body = 'var sum = 0; for (var i = 0; i < 50000000; i++) sum += i;'
      const run = await sb.run(entry ? `function main() { ${body} }` : body, entry ? { entry: 'main' } : {})
      assert.equal(run.ok, false)
      assert.equal(run.runtime.reason, 'timeout')
      assert.ok(run.durationMs > 0)
      assert.deepEqual(run.limitsHit, ['timeout'])
      assert.equal(run.timedOut, true)
      assert.equal(run.stackExhaustion, false)
      assert.equal(run.disposal.ok, true)
      await assertHealthyFollowUp(sb, module)
    } finally {
      sb.dispose()
    }
  })

  test(`real ${entry ? 'entry' : 'eval'} guest memory limit is not a stack breach`, async () => {
    const sb = await sandbox({ limits: { memoryBytes: 2 * 1024 * 1024 } })
    const module = await loadQuickJS()
    try {
      // One finite guest allocation above the 2 MiB heap limit; no host allocation loop.
      const body = 'new ArrayBuffer(3 * 1024 * 1024)'
      const run = await sb.run(entry ? `function main() { return ${body} }` : body, entry ? { entry: 'main' } : {})
      assert.equal(run.ok, false)
      assert.deepEqual(run.limitsHit, ['memory'])
      assert.equal(run.timedOut, false)
      assert.equal(run.stackExhaustion, false)
      assert.equal(run.disposal.ok, true)
      await assertHealthyFollowUp(sb, module)
    } finally {
      sb.dispose()
    }
  })
}

for (const [kind, schedule] of [
  ['promise', 'Promise.resolve().then'],
  ['timer', 'setTimeout'],
]) {
  test(`a real timeout in a ${kind} callback retains interrupt attribution`, async () => {
    const sb = await sandbox({ limits: { timeoutMs: 100 } })
    const module = await loadQuickJS()
    try {
      await assertHealthyFollowUp(sb, module)
      const run = await sb.run(`
        ${schedule}(function () {
          var sum = 0;
          for (var i = 0; i < 50000000; i++) sum += i;
        });
        7
      `)
      assert.equal(run.ok, true)
      assert.equal(run.runtime.reason, 'timeout')
      assert.deepEqual(run.limitsHit, ['timeout'])
      assert.equal(run.timedOut, true)
      assert.equal(run.stackExhaustion, false)
      assert.equal(run.disposal.ok, true)
      await assertHealthyFollowUp(sb, module)
    } finally {
      sb.dispose()
    }
  })
}

test('promise-job error dumps cannot establish host stack provenance', () => {
  let pending = true
  let disposed = false
  const invoker = createInvoker({
    ctx: { dump: () => ({ name: 'RangeError', message: 'Maximum call stack size exceeded' }) },
    runtime: {
      hasPendingJob: () => pending,
      executePendingJobs: () => {
        pending = false
        return { error: { dispose() { disposed = true } } }
      },
    },
    bridge: {},
    clock: { elapsedMs: 0, nextDueIn: () => Infinity, pending: () => 0 },
    limits: { maxJobs: 1, maxTimerCallbacks: 1, maxVirtualMs: 100 },
  })
  const settled = invoker.settle()
  assert.equal(disposed, true)
  assert.deepEqual(settled.limitsHit, [])
  assert.equal(settled.stackExhaustion, false)
  assert.equal(settled.promiseErrors, 1)
})

for (const [reason, message, expected] of [
  ['timeout', 'interrupted', 'timeout'],
  ['virtual-time', 'interrupted', 'virtual-time'],
  [null, 'out of memory', 'memory'],
]) {
  test(`promise-job ${expected} uses the shared resource classifier`, () => {
    let disposed = false
    const invoker = createInvoker({
      ctx: { dump: () => ({ name: 'InternalError', message }) },
      runtime: {
        hasPendingJob: () => !disposed,
        executePendingJobs: () => ({ error: { dispose() { disposed = true } } }),
      },
      stealth: { isIntrinsicStackError: () => true },
      limitReason: () => disposed ? reason : null,
      bridge: {},
      clock: { elapsedMs: 0, nextDueIn: () => Infinity, pending: () => 0 },
      limits: { maxJobs: 1, maxTimerCallbacks: 1, maxVirtualMs: 100 },
    })
    const settled = invoker.settle()
    assert.equal(disposed, true)
    assert.deepEqual(settled.limitsHit, [expected])
    assert.equal(settled.stackExhaustion, false)
    assert.equal(settled.timedOut, expected !== 'memory')
  })
}

test('deferred host errors preserve error fields without copying host stacks', async () => {
  const harness = await createHarness()
  try {
    const reject = harness.bridge.fn('reject', 0, () => {
      const deferred = harness.bridge.deferred()
      const error = new Error('authentication failed')
      error.name = 'OperationError'
      error.stack = 'HOST_STACK_SENTINEL at /Users/example/private.js:1:2'
      deferred.reject(error)
      return deferred.handle
    })
    harness.bridge.install(harness.ctx.global, 'reject', reject)
    assert.equal(harness.run(`reject().catch(function (error) {
      globalThis.failure = [error instanceof Error, error.name, error.message, error.stack];
    }); 7`).ok, true)
    assert.equal(harness.jobs().ok, true)
    const result = harness.run('failure')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.slice(0, 3), [true, 'OperationError', 'authentication failed'])
    assert.doesNotMatch(String(result.value[3]), /HOST_STACK_SENTINEL|\/Users\/|bridge\.js|node_modules/)
  } finally {
    assert.equal(harness.dispose().ok, true)
  }
})

test('host stack evidence wins over a simultaneous entry timeout', () => {
  let signals = 0
  let reason = null
  const errorHandle = { dispose() {} }
  const invoker = createInvoker({
    ctx: {
      global: {},
      getProp: () => ({ dispose() {} }),
      typeof: () => 'function',
      callFunction: () => {
        signals += 1
        reason = 'timeout'
        return { error: errorHandle }
      },
      dump: () => ({ name: 'RangeError', message: 'Maximum call stack size exceeded' }),
    },
    runtime: {},
    bridge: {},
    stackSignals: () => signals,
    limitReason: () => reason,
  })
  const result = invoker.callEntry('main', [])
  assert.deepEqual(result.limitsHit, ['stack'])
  assert.equal(result.stackExhaustion, true)
  assert.equal(result.timedOut, false)
})

test('non-strict environment installation reports missing dependencies while continuing', async () => {
  const sb = await sandbox({ env: { only: ['misc'], strict: false } })
  try {
    const run = await sb.run('typeof AbortController')
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 'function')
    assert.equal(run.environment.complete, false)
    assert.deepEqual(run.environment.installed.map(({ id }) => id), ['misc'])
    assert.deepEqual(run.environment.missing, [
      { id: 'misc', reason: 'missing requirement globals' },
      { id: 'misc', reason: 'missing requirement navigator' },
    ])
    assert.equal(run.disposal.ok, true)
  } finally {
    sb.dispose()
  }
})
