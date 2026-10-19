import test from 'node:test'
import assert from 'node:assert/strict'
import { createHookBus, HOOK_PHASES } from '../tools/hook/hookbus.js'
import { createTraceRecorder } from '../tools/instrumentation/trace.js'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

/**
 * Trace budget (docs/EVALUATION-TOOLS.md D4).
 *
 * Instrumented guest code calls the hook bus once per statement and per loop
 * iteration. Those probes are useful to a subscriber but worthless as evidence:
 * `code:step` re-describes the `code` event the same probe already emitted. The
 * budget checks below pin the invariant "an unlistened phase costs nothing and
 * writes nothing", which is what keeps a loop-heavy sample readable.
 */

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'storage', 'anti-fingerprint']

async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    ...options,
  })
}

test('a loop-heavy run keeps code evidence and spends almost no hook budget', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('var total = 0; for (var i = 0; i < 20; i++) { total += i }\ntotal')
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 190)

    const hookEvents = (run.events ?? []).filter((event) => event.kind === 'hook')
    const codeEvents = (run.events ?? []).filter((event) => event.kind === 'code')

    // 20 iterations of an instrumented statement used to add ~45 `hook` events,
    // one per unlistened `code:step`. Only phases somebody subscribed to remain.
    assert.ok(hookEvents.length < 10, `hook events: ${hookEvents.length}`)
    assert.ok(codeEvents.length > 20, `code events: ${codeEvents.length}`)
    assert.equal(run.traceStats.byKind.hook, hookEvents.length)
    assert.ok(run.traceStats.byKind.code > 20)

    // The budget must not be saved by dropping the evidence itself: per-statement
    // probes are still recorded as `code` step events with their source location.
    const steps = codeEvents.filter((event) => event.phase === 'step')
    assert.ok(steps.length > 20, `code step events: ${steps.length}`)
    assert.ok(steps.every((event) => event.kind === 'code'))
    assert.ok(steps.some((event) => event.event === 'loop'))
    assert.ok(steps.some((event) => event.line > 0))

    assert.ok(
      !hookEvents.some((event) => event.phase === 'code:step' || event.hook === 'code:step'),
      'code:step must never reach the trace',
    )
  } finally {
    sb.dispose()
  }
})

test('an emit with no enabled registration neither traces nor counts a dispatch', () => {
  const trace = createTraceRecorder()
  const bus = createHookBus({ trace })

  assert.deepEqual(bus.emit('code:step', { site: { id: 1 } }), { phase: 'code:step', results: [] })
  const decision = bus.dispatch('api:before', { api: 'fetch' })
  assert.equal(decision.blocked, false)
  assert.equal(decision.stopped, false)
  assert.deepEqual(decision.results, [])
  assert.equal(decision.phase, 'api:before')

  assert.equal(trace.events.length, 0, 'no trace event for an unlistened phase')
  assert.equal(bus.stats().dispatches, 0, 'unlistened phases do not count as dispatches')

  // A disabled registration is not a listener either.
  const off = bus.on('code:step', () => assert.fail('disabled hook must not run'), { id: 'disabled' })
  bus.setEnabled('disabled', false)
  bus.emit('code:step', {})
  assert.equal(trace.events.length, 0)
  assert.equal(bus.stats().dispatches, 0)
  off()

  // A real subscriber restores dispatch and the trace record.
  bus.on('api:before', () => undefined, { id: 'listener' })
  bus.emit('api:before', { api: 'x' })
  assert.equal(bus.stats().dispatches, 1)
  assert.equal(trace.events.filter((event) => event.kind === 'hook').length, 1)
})

test('strict mode accepts every declared platform phase and still rejects typos', () => {
  const bus = createHookBus({ strict: true })
  assert.ok(HOOK_PHASES.includes('code:step'), 'code:step is emitted by instrumentation/code.js')
  assert.doesNotThrow(() => bus.emit('code:step', { site: { id: 1 } }))
  assert.doesNotThrow(() => bus.on('code:step', () => undefined))
  assert.doesNotThrow(() => bus.dispatch('api:before', { api: 'x' }))
  assert.throws(() => bus.emit('bogus:phase', {}), /unknown hook phase/)
  assert.throws(() => bus.dispatch('bogus:phase', {}), /unknown hook phase/)
})

test('hook error storage is bounded and reports truncation', () => {
  const bus = createHookBus({ record: false })
  let calls = 0
  bus.on(
    'api:before',
    () => {
      calls += 1
      throw new Error(`boom ${calls}`)
    },
    { id: 'always-throws' },
  )

  for (let index = 0; index < 1000; index += 1) bus.dispatch('api:before', { api: 'x', index })

  const stats = bus.stats()
  assert.equal(calls, 1000, 'every dispatch still reached the failing hook')
  assert.equal(stats.errors.length, 200)
  assert.ok(stats.errors.length <= 200)
  assert.equal(stats.errorsTruncated, true)
  // Newest failures are the ones kept.
  assert.equal(stats.errors.at(-1).message, 'boom 1000')
  assert.equal(stats.errors[0].message, 'boom 801')
  assert.equal(stats.errors.every((entry) => entry.hook === 'always-throws'), true)
})

test('a bus that never fails does not claim truncation', () => {
  const bus = createHookBus({ record: false })
  bus.on('api:before', () => undefined, { id: 'healthy' })
  bus.dispatch('api:before', { api: 'x' })
  const stats = bus.stats()
  assert.deepEqual(stats.errors, [])
  assert.equal(stats.errorsTruncated, false)
})
