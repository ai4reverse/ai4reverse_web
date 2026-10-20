import test from 'node:test'
import assert from 'node:assert/strict'
import { createHookBus, HOOK_PHASES } from '../tools/hook/hookbus.js'
import { createTraceRecorder, TRACE_PHASES } from '../tools/instrumentation/trace.js'
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

test('hook error storage is bounded by total characters, not just by count', () => {
  const bus = createHookBus({ record: false })
  // A megabyte of message per failure: the count-only bound used to retain
  // ~200 MB (the audit measured up to ~838 MB with real stacks).
  bus.on(
    'api:before',
    () => {
      throw new Error('x'.repeat(1024 * 1024))
    },
    { id: 'huge' },
  )
  for (let index = 0; index < 50; index += 1) bus.dispatch('api:before', { api: 'x' })

  const stats = bus.stats()
  assert.equal(stats.errorsTruncated, true)
  assert.ok(stats.errors.length <= 200, `retained entries: ${stats.errors.length}`)
  assert.ok(stats.errors.length >= 1, 'the newest failure must survive')
  const retainedChars = stats.errors.reduce((total, entry) => total + entry.message.length, 0)
  assert.ok(retainedChars <= 64 * 1024, `retained message characters: ${retainedChars}`)
  // Each message is clipped, and the clip is visible rather than silent.
  assert.ok(stats.errors.every((entry) => entry.message.length <= 2 * 1024 + 32))
  assert.ok(stats.errors.every((entry) => entry.message.startsWith('xxxx')))
  assert.match(stats.errors.at(-1).message, /…\[1048576\]$/)
})

test('a short failure keeps its exact message even next to a clipped one', () => {
  const bus = createHookBus({ record: false })
  bus.on('api:before', () => {
    throw new Error('short and exact')
  }, { id: 'short' })
  bus.on('api:before', () => {
    throw new Error('y'.repeat(5000))
  }, { id: 'long' })
  bus.dispatch('api:before', {})
  const [shortEntry, longEntry] = bus.stats().errors
  assert.equal(shortEntry.message, 'short and exact')
  assert.equal(longEntry.message.length, 2 * 1024 + '…[5000]'.length)
})

test('hook trace events use a declared trace phase, so a strict recorder accepts lifecycle hooks', () => {
  // Regression: the bus forwarded the hook sub-phase (`init`, `run`, `dispose`)
  // as the trace phase, and a strict recorder rejected it with
  // "unknown trace phase: run". The hook phase now travels in the payload.
  const trace = createTraceRecorder({ strict: true })
  const bus = createHookBus({ trace })
  for (const phase of ['lifecycle:init', 'lifecycle:run', 'lifecycle:dispose', 'code:before']) {
    bus.on(phase, (payload) => payload, { id: `listen-${phase}` })
  }
  assert.doesNotThrow(() => bus.emit('lifecycle:init', { runId: 'run-1' }))
  assert.doesNotThrow(() => bus.emit('lifecycle:run', { ok: true }))
  assert.doesNotThrow(() => bus.emit('lifecycle:dispose', {}))
  assert.doesNotThrow(() => bus.dispatch('code:before', {}))
  assert.doesNotThrow(() => bus.pipeline('code:before', 'source'))

  const hookEvents = trace.events.filter((event) => event.kind === 'hook')
  assert.equal(hookEvents.length, 5)
  assert.deepEqual(hookEvents.map((event) => event.phase), ['emit', 'emit', 'emit', 'emit', 'transform'])
  // The hook phase is never lost: it travels in `hook` (the envelope keeps the
  // declared trace phase).
  assert.deepEqual(
    hookEvents.map((event) => event.hook),
    ['lifecycle:init', 'lifecycle:run', 'lifecycle:dispose', 'code:before', 'code:before'],
  )
  assert.ok(TRACE_PHASES.includes('emit'))
  assert.ok(TRACE_PHASES.includes('transform'))
})

test('an unknown trace kind is rejected without strict phase validation', () => {
  const recorder = createTraceRecorder()
  assert.throws(() => recorder.emit('bogus', 'emit', {}), /unknown trace kind: bogus/)
  assert.equal(recorder.seq, 0, 'a rejected event must not advance the sequence')
  assert.deepEqual(recorder.stats().byKind, {})
  // A non-strict recorder still accepts a descriptive phase: the guest trace
  // hook forwards whatever phase the DOM shim reports.
  assert.doesNotThrow(() => recorder.emit('api', 'guest-supplied-phase', {}))
  assert.equal(recorder.seq, 1)
})

test('a limited recorder retains exactly the newest maxEvents events in emit order', () => {
  // A small limit keeps the test fast while still running the ring's
  // dead-prefix reclaim (one per `limit` evictions) more than once.
  const limit = 2000
  const recorder = createTraceRecorder({ limit })

  for (let index = 0; index < limit + 5000; index += 1) {
    recorder.emit('api', 'emit', { index })
  }

  const events = recorder.events
  assert.equal(events.length, limit, 'exposed events stay capped at the limit')
  assert.equal(recorder.size, limit)
  assert.equal(recorder.dropped, 5000)
  const stats = recorder.stats()
  assert.equal(stats.retained, limit)
  assert.equal(stats.total, limit + 5000)

  // The window is the newest `limit` events, oldest first: seqs are contiguous
  // and the first payload index is the one that survived eviction.
  assert.equal(events[0].seq, 5001)
  assert.equal(events[0].index, 5000)
  assert.equal(events.at(-1).seq, limit + 5000)
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].seq, events[index - 1].seq + 1, `seq contiguity at index ${index}`)
  }
})
