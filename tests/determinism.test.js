import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../tools/analysis/orchestrator.js'

/**
 * Truthful measurement (D3): a trace payload must be a pure function of the
 * seed and the sample. Host time and host addresses are not.
 *
 * `wall` is the host wall clock stamped on every trace event by design, and
 * `durationMs`/`startedAt` are measured durations; both are stripped before
 * comparing. `moved` used to carry a linear-memory address (a WASM pointer),
 * which is what made two same-seed analyses disagree.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SAMPLE = `${ROOT}examples/network-c2.js`

/** Recursively drop host-timing keys. */
function stripTiming(value) {
  if (Array.isArray(value)) return value.map(stripTiming)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'wall' || key === 'durationMs' || key === 'startedAt') continue
      out[key] = stripTiming(entry)
    }
    return out
  }
  return value
}

/** Kept separate so the events comparison is exactly "delete wall". */
function stripWall(events) {
  return (events ?? []).map((event) => {
    const { wall, ...rest } = event
    return rest
  })
}

async function twice() {
  const source = await readFile(SAMPLE, 'utf8')
  const options = { name: 'network-c2.js', logLevel: 'silent', seed: 0x5eed, env: { strict: false } }
  const first = await analyzeSample(source, options)
  const second = await analyzeSample(source, options)
  return [first, second]
}

test('same-seed analyses produce identical dynamic events after removing wall (D3)', async () => {
  const [first, second] = await twice()
  const eventsA = stripWall(first.report.dynamic.events)
  const eventsB = stripWall(second.report.dynamic.events)

  assert.ok(eventsA.length > 0, 'expected dynamic trace events')
  assert.equal(eventsA.length, eventsB.length)
  assert.deepEqual(eventsA, eventsB)

  // Report-level determinism: everything except measured host time.
  assert.deepEqual(stripTiming(first.report), stripTiming(second.report))
})

test('the prototypified event carries the real moved count, not a handle address (D3)', async () => {
  const [first, second] = await twice()
  const eventsA = (first.report.dynamic.events ?? []).filter(
    (event) => event.event === 'anti-fingerprint.prototypified',
  )
  const eventsB = (second.report.dynamic.events ?? []).filter(
    (event) => event.event === 'anti-fingerprint.prototypified',
  )
  assert.equal(eventsA.length, 1, 'one prototypified event per run')
  const moved = eventsA[0].moved

  assert.equal(typeof moved, 'number')
  assert.ok(Number.isInteger(moved), `moved must be an integer, got ${moved}`)
  assert.ok(moved > 0, `moved must be positive, got ${moved}`)
  assert.ok(moved < 10_000, `moved must stay bounded, got ${moved}`)
  assert.equal(moved, eventsB[0]?.moved, 'moved must be identical for the same seed')

  // No payload may smuggle a host pointer into evidence: a real property count
  // is far below 2^24, while a linear-memory address was ~5e6 and heap offsets
  // drifted by millions between runs.
  assert.ok(moved < 2 ** 24, `moved looks like an address: ${moved}`)

  // The dynamic section is part of the report and must agree with the events.
  const reportEvents = stripWall(first.report.dynamic.events)
  const reportEvent = reportEvents.find((event) => event.event === 'anti-fingerprint.prototypified')
  assert.equal(reportEvent?.moved, moved)
})
