import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { MAX_RECORDED_ARGS } from '../tools/sandbox/env/console.js'

/**
 * Host-callback caps for the console surface (assessment M1).
 *
 * Interrupt checks fire only in the guest interpreter loop, never inside a
 * host callback, so one call with a huge argument spread must not convert or
 * serialize every argument. These tests pin the dual count+chars bounds of
 * `record()` and the distinct-label cap of the `console.count` bookkeeping.
 */

/** Console trace events of one kind, in order. */
function consoleEvents(harness, api) {
  return harness.trace.events.filter((event) => event.kind === 'api' && event.api === api)
}

test('one console.log with 10k args records at most the arg cap, with a visible marker', async () => {
  const harness = await createHarness({ modules: ['globals', 'console'] })
  try {
    const result = harness.run(`console.log.apply(null, new Array(10000).fill('AAAA'))`)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    const [logged] = consoleEvents(harness, 'console.log')
    assert.ok(logged, 'console.log trace event missing')
    const recorded = logged.text.split('AAAA').length - 1
    assert.ok(recorded > 0 && recorded <= MAX_RECORDED_ARGS, `recorded ${recorded} arguments`)
    assert.ok(logged.text.endsWith(`…(+${10000 - recorded} args)`), logged.text.slice(-40))
  } finally {
    harness.dispose()
  }
})

test('10k distinct console.count labels leave at most the label cap tracked', async () => {
  const harness = await createHarness({ modules: ['globals', 'console'] })
  try {
    const result = harness.run(`for (var i = 0; i < 10000; i++) console.count('label-' + i)`)
    assert.equal(result.ok, true, JSON.stringify(result.error))

    // Within the cap the label is stored, so recounting it increments.
    harness.run(`console.count('label-0'); console.count('label-0')`)
    const tracked = consoleEvents(harness, 'console.count').filter((event) => event.label === 'label-0')
    assert.equal(tracked.length, 3)
    assert.deepEqual(
      tracked.map((event) => event.count),
      [1, 2, 3],
    )

    // Past the cap a new label is never stored: every call reports it as new,
    // and the trace event says so instead of silently dropping the count.
    harness.run(`console.count('label-9999'); console.count('label-9999')`)
    const untracked = consoleEvents(harness, 'console.count').filter((event) => event.label === 'label-9999')
    assert.equal(untracked.length, 3)
    assert.ok(untracked.every((event) => event.untracked === true && event.count === undefined))
  } finally {
    harness.dispose()
  }
})

test('normal console entries are recorded fully, unchanged', async () => {
  const harness = await createHarness({ modules: ['globals', 'console'] })
  try {
    harness.run(`console.log('alpha', 'beta', 3)`)
    const logged = consoleEvents(harness, 'console.log').at(-1)
    assert.equal(logged.text, 'alpha beta 3')

    harness.run(`console.log('%s=%d', 'k', 42)`)
    const formatted = consoleEvents(harness, 'console.log').at(-1)
    assert.equal(formatted.text, 'k=42')

    // Two long arguments whose combined serialization passes the char cap are
    // clipped near the cap with a visible length marker (the api-instrumentation
    // layer adds its own `…[len]` tail on top of `record()`'s clip).
    harness.run(`console.log(new Array(1600).join('a'), new Array(1600).join('b'))`)
    const clipped = consoleEvents(harness, 'console.log').at(-1)
    assert.ok(clipped.text.length > 2000 && clipped.text.length < 2100, `clipped length ${clipped.text.length}`)
    assert.ok(/…\[\d+\]$/.test(clipped.text), clipped.text.slice(-20))
  } finally {
    harness.dispose()
  }
})
