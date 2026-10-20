import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { createVirtualClock } from '../tools/sandbox/clock.js'
import { createHarness } from './helpers/harness.js'

/**
 * Virtual timer bookkeeping (R1.3).
 *
 * QuickJS refcounts its handles. Disposing a guest function handle while the
 * engine is still executing that function corrupts the handle list, and the
 * corruption surfaces as `Aborted(Assertion failed: list_empty(...))` when the
 * runtime is disposed — for the run that cleared itself, or for the next run of
 * the same sandbox. `clearTimeout`/`clearInterval` are therefore allowed to run
 * *inside* their own callback, and every scenario below is followed by a normal
 * run in the same sandbox to prove no handle was corrupted.
 *
 * Every probe runs in a real sandbox with the full environment; timers fire
 * during `settle()` on the virtual clock, so a later timer reports the outcome
 * through `console.log`.
 */

/** Full-environment sandbox: the timer module is part of the default set. */
async function sandbox() {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true },
    profile: { locale: 'zh-CN', os: 'windows', browser: 'chrome' },
  })
}

/** `console.log` payloads, as the guest printed them. */
function consoleLogs(run) {
  return (run.events ?? [])
    .filter((event) => event.kind === 'api' && event.api === 'console.log')
    .map((event) => String(event.text))
}

/** Assert the run completed, its runtime disposed cleanly and a re-run works. */
async function assertHealthy(sb, run, label) {
  assert.equal(run.ok, true, `${label}: ${JSON.stringify(run.error)}`)
  assert.deepEqual(run.disposal, { ok: true, errors: [] }, `${label}: runtime disposal failed`)
  const again = await sb.run('1+1')
  assert.equal(again.ok, true, `${label}: the next run in the same sandbox failed`)
  assert.equal(again.result.preview, '2')
  assert.deepEqual(again.disposal, { ok: true, errors: [] }, `${label}: the next run corrupted the runtime`)
}

test('a timeout may clear itself from inside its own callback', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `var steps = 0;
       var id = setTimeout(function () { steps += 1; clearTimeout(id); steps += 1; }, 5);
       setTimeout(function () { console.log('steps=' + steps) }, 50);`,
      { level: 'off' },
    )
    // Both statements after the self-clear ran: the callback finished normally.
    assert.ok(consoleLogs(run).includes('steps=2'), JSON.stringify(consoleLogs(run)))
    await assertHealthy(sb, run, 'self-clearing setTimeout')
  } finally {
    sb.dispose()
  }
})

test('an interval may clear itself from inside its own callback', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `var count = 0;
       var id = setInterval(function () {
         count += 1;
         if (count === 2) clearInterval(id);
       }, 10);
       setTimeout(function () { console.log('count=' + count) }, 120);`,
      { level: 'off' },
    )
    // 12 ticks would have elapsed; a self-cleared interval stops after two.
    assert.ok(consoleLogs(run).includes('count=2'), JSON.stringify(consoleLogs(run)))
    await assertHealthy(sb, run, 'self-clearing setInterval')
  } finally {
    sb.dispose()
  }
})

test('a callback may clear a sibling timer and a cleared timer never fires', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `var fired = [];
       var sibling = setTimeout(function () { fired.push('sibling') }, 100);
       setTimeout(function () { fired.push('first'); clearTimeout(sibling); }, 10);
       setTimeout(function () { console.log('fired=' + fired.join(',')) }, 200);`,
      { level: 'off' },
    )
    assert.ok(consoleLogs(run).includes('fired=first'), JSON.stringify(consoleLogs(run)))
    await assertHealthy(sb, run, 'sibling clear')
  } finally {
    sb.dispose()
  }
})

test('double clears, stale ids and string callbacks stay harmless', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `var hits = [];
       var id = setTimeout(function () { hits.push('once'); clearTimeout(id); clearTimeout(id); }, 5);
       clearTimeout(id);
       clearInterval(4242);
       cancelAnimationFrame(4242);
       var frame = requestAnimationFrame(function () { hits.push('frame'); cancelAnimationFrame(frame) });
       setTimeout('hits.push("string")', 10);
       setTimeout(function () { console.log('hits=' + hits.join(',')) }, 100);`,
      { level: 'off' },
    )
    // The first timeout was cleared before it fired, the 10ms string callback
    // ran before the 16ms frame, and the self-cancelled frame ran its body once.
    assert.ok(consoleLogs(run).includes('hits=string,frame'), JSON.stringify(consoleLogs(run)))
    await assertHealthy(sb, run, 'double clear')
  } finally {
    sb.dispose()
  }
})

test('requestIdleCallback may be cancelled from inside its callback', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `var idle = [];
       var handle = requestIdleCallback(function (deadline) {
         idle.push('idle:' + deadline.didTimeout);
         cancelIdleCallback(handle);
       }, 5);
       setTimeout(function () { console.log('idle=' + idle.join(',')) }, 100);`,
      { level: 'off' },
    )
    assert.ok(consoleLogs(run).includes('idle=idle:true'), JSON.stringify(consoleLogs(run)))
    await assertHealthy(sb, run, 'self-cancelling requestIdleCallback')
  } finally {
    sb.dispose()
  }
})

test('queued microtasks drain as promise jobs, before the next timer', async () => {
  // `queueMicrotask` enqueues inside the engine (`Promise.resolve().then`), so
  // the promise job queue the runtime already drains is the only queue. There is
  // no host-side microtask list: one existed once and nothing ever fed it, which
  // is why it is asserted to be absent below.
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `var order = [];
       queueMicrotask(function () { order.push('microtask') });
       Promise.resolve().then(function () { order.push('promise') });
       setTimeout(function () { console.log('order=' + order.join(',')) }, 1);`,
      { level: 'off' },
    )
    assert.ok(consoleLogs(run).includes('order=microtask,promise'), JSON.stringify(consoleLogs(run)))
    await assertHealthy(sb, run, 'microtask FIFO order')
  } finally {
    sb.dispose()
  }
})

test('the timers module exposes no unfed microtask queue', async () => {
  // A `drainMicrotasks` surface with no writer is dead code that also invites a
  // caller to believe it drains something; the runtime's promise jobs do that.
  const harness = await createHarness({ modules: ['globals', 'timers'] })
  let disposal
  try {
    assert.equal(typeof harness.bridge.drainMicrotasks, 'undefined')
    assert.equal(typeof harness.bridge.pendingTimers, 'function')
    const result = harness.run(
      `var seen = [];
       queueMicrotask(function () { seen.push('microtask') });
       globalThis.__seen = seen;
       0`,
    )
    assert.equal(result.ok, true, JSON.stringify(result.error))
    harness.jobs()
    assert.deepEqual(harness.run('__seen.slice()').value, ['microtask'])
  } finally {
    disposal = harness.dispose()
  }
  assert.equal(disposal.leaked, false, 'the timers module must not keep guest handles')
  assert.equal(disposal.ok, true)
})

test('microtasks drain between same-batch timer callbacks like a browser', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: false, only: ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'storage', 'anti-fingerprint'] } })
  try {
    const run = await sb.run(
      `
      var order = [];
      setTimeout(function () {
        order.push('t1');
        Promise.resolve().then(function () { order.push('m1'); });
      }, 5);
      setTimeout(function () { order.push('t2'); }, 5);
      setTimeout(function () { console.log('ORDER:' + order.join(',')); }, 10);
      0
    `,
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const logged = (run.events ?? []).find((event) => event.kind === 'api' && event.api === 'console.log' && String(event.text ?? '').startsWith('ORDER:'))
    assert.ok(logged, 'marker log missing')
    assert.equal(logged.text, 'ORDER:t1,m1,t2', `browser order violated: ${logged.text}`)
  } finally {
    sb.dispose()
  }
})

test('the virtual clock refuses schedules beyond maxTimers and counts the drops', () => {
  const clock = createVirtualClock({ seed: 'timer-cap', maxTimers: 2 })
  const first = clock.schedule({ fn: () => {}, delay: 1 })
  const second = clock.schedule({ fn: () => {}, delay: 2 })
  const third = clock.schedule({ fn: () => {}, delay: 3 })
  // Refused schedules get 0 (never a real id: those start at 1), deterministically.
  assert.deepEqual([first, second, third], [1, 2, 0])
  assert.equal(clock.pending(), 2)
  assert.equal(clock.stats().droppedTimers, 1)
  // Cancelling frees a slot, so ordinary timer churn is unaffected.
  clock.cancel(first)
  assert.equal(clock.schedule({ fn: () => {}, delay: 1 }), 3)
  clock.dispose()
})

test('scheduling beyond the timer cap returns 0 and earlier timers still fire', async () => {
  // A restricted module set: the full environment schedules install-time
  // timers of its own (e.g. the service-worker registration promise in
  // `env/misc.js`), which would consume cap slots ahead of the guest.
  const sb = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true, only: ['globals', 'console', 'timers'] },
    limits: { maxTimers: 3 },
  })
  try {
    const run = await sb.run(
      `var ids = [];
       for (var i = 0; i < 5; i++) ids.push(setTimeout(function () { console.log('fired') }, 10));
       console.log('ids=' + ids.join(','));`,
      { level: 'off' },
    )
    assert.ok(consoleLogs(run).includes('ids=1,2,3,0,0'), JSON.stringify(consoleLogs(run)))
    assert.equal(consoleLogs(run).filter((line) => line === 'fired').length, 3)
    assert.equal(run.clock.droppedTimers, 2)
    await assertHealthy(sb, run, 'timer cap')
  } finally {
    sb.dispose()
  }
})

test('requestAnimationFrame beyond the timer cap is refused without corrupting the runtime', async () => {
  const sb = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true, only: ['globals', 'console', 'timers'] },
    limits: { maxTimers: 2 },
  })
  try {
    const run = await sb.run(
      `setTimeout(function () { console.log('timeout') }, 5);
       var frame = requestAnimationFrame(function () { console.log('frame') });
       console.log('refused=' + setTimeout(function () { console.log('never') }, 50));`,
      { level: 'off' },
    )
    assert.ok(consoleLogs(run).includes('refused=0'), JSON.stringify(consoleLogs(run)))
    assert.ok(consoleLogs(run).includes('timeout'), JSON.stringify(consoleLogs(run)))
    assert.ok(consoleLogs(run).includes('frame'), JSON.stringify(consoleLogs(run)))
    assert.ok(!consoleLogs(run).includes('never'), JSON.stringify(consoleLogs(run)))
    assert.equal(run.clock.droppedTimers, 1)
    await assertHealthy(sb, run, 'rAF timer cap')
  } finally {
    sb.dispose()
  }
})
