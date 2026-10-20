import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, loadQuickJS, resetQuickJS } from '../tools/engine/runtime.js'
import { normalizeLimits } from '../tools/engine/limits.js'
import { createTraceRecorder } from '../tools/instrumentation/trace.js'
import { createLogger, createMemoryDestination } from '../tools/logging/logger.js'

// Inject the disposal failure without allocating or damaging a WASM runtime.
test('a fake runtime disposal failure returns its sentinel, logs, traces and quarantines the module', async (t) => {
  const module = await loadQuickJS()
  const sentinel = new Error('synthetic runtime disposal failure')
  const runtime = {
    setMemoryLimit: t.mock.fn(),
    setMaxStackSize: t.mock.fn(),
    setInterruptHandler: t.mock.fn(),
    dispose: t.mock.fn(() => { throw sentinel }),
  }
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'error', pretty: false, destination })
  const trace = createTraceRecorder({ strict: true })
  const factory = t.mock.method(module, 'newRuntime', () => runtime)
  try {
    const handle = createRuntime({ module, limits: normalizeLimits(), clock: { elapsedMs: 0 }, logger, trace })
    factory.mock.restore()

    const result = handle.dispose()

    assert.equal(result.ok, false)
    assert.equal(result.error, sentinel, 'the original host error must survive')
    assert.equal(runtime.dispose.mock.callCount(), 1)
    const records = destination.records()
    assert.equal(records.length, 1)
    assert.equal(records[0].level, 'error')
    assert.equal(records[0].err, sentinel.message)
    assert.match(records[0].msg, /runtime dispose aborted/)
    assert.equal(trace.events.length, 1)
    assert.equal(trace.events[0].kind, 'sandbox')
    assert.equal(trace.events[0].phase, 'error')
    assert.equal(trace.events[0].event, 'runtime.dispose.failed')
    assert.equal(trace.events[0].message, sentinel.message)
    assert.notEqual(await loadQuickJS(), module, 'the failed disposal must quarantine its module')
  } finally {
    factory.mock.restore()
    resetQuickJS()
  }
})
