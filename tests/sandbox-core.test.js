import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { createProfile, consistencyReport } from '../tools/sandbox/profile.js'
import { normalizeLimits } from '../tools/sandbox/limits.js'

const CORE_ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'random', 'anti-fingerprint']

/** @param {object} [options] */
async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: CORE_ENV, ...(options.env ?? {}) },
    ...options,
  })
}

/**
 * Intercept both sinks the WASM engine can print an abort to: emscripten's
 * `err()` uses `console.error`, a raw write uses `process.stderr.write`.
 * @param {string[]} sink collected chunks
 * @returns {() => void} restore hook
 */
function captureEngineOutput(sink) {
  const originalWrite = process.stderr.write
  const originalError = console.error
  process.stderr.write = (chunk) => {
    sink.push(String(chunk))
    return true
  }
  console.error = (...args) => {
    sink.push(args.map((item) => String(item)).join(' '))
  }
  return () => {
    process.stderr.write = originalWrite
    console.error = originalError
  }
}

test('sandbox runs code and reports the last expression value', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('var a = 40; a + 2', { filename: 'https://cdn.test/app.js' })
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 42)
    assert.equal(run.filename, 'https://cdn.test/app.js')
    assert.equal(run.disposal.ok, true)
    assert.ok(run.traceStats.total > 0)
    assert.ok(run.virtualMs >= 0)
  } finally {
    sb.dispose()
  }
})

test('each run gets a fresh context: globals do not survive', async () => {
  const sb = await sandbox()
  try {
    const first = await sb.run('globalThis.__leak = "stage1"; 1')
    assert.equal(first.ok, true)
    const second = await sb.run('typeof globalThis.__leak')
    assert.equal(second.result.value, 'undefined')
    assert.equal(second.disposal.ok, true)
  } finally {
    sb.dispose()
  }
})

test('host timeout interrupts an infinite loop and is classified', async () => {
  const sb = await sandbox({ limits: { timeoutMs: 250, maxVirtualMs: 600_000 } })
  try {
    const started = Date.now()
    const run = await sb.run('while (true) {}')
    const elapsed = Date.now() - started
    assert.equal(run.ok, false)
    assert.equal(run.timedOut, true)
    assert.ok(run.limitsHit.includes('timeout'), `expected timeout, got ${JSON.stringify(run.limitsHit)}`)
    assert.ok(elapsed < 5000, `timeout took too long: ${elapsed}ms`)
    assert.equal(run.settle?.skipped, true)
  } finally {
    sb.dispose()
  }
})

test('stack exhaustion is classified as a stack limit and never aborts the engine', async () => {
  const sb = await sandbox()
  const printed = []
  const restoreEngine = captureEngineOutput(printed)
  try {
    const run = await sb.run('function f(n){ return f(n + 1) } f(0)')
    assert.equal(run.ok, false)
    assert.match(`${run.error.name}: ${run.error.message}`, /stack|overflow|too deep/i)
    assert.ok(run.limitsHit.includes('stack'), JSON.stringify(run.limitsHit))
    // After stack exhaustion the runtime cannot be released at all, so it is
    // abandoned and the module quarantined: `ok === false` plus an explicit
    // leak marker, and no disposal error because nothing was attempted.
    assert.deepEqual(
      { ...run.disposal, errors: run.disposal.errors.length },
      { ok: false, errors: 0, leaked: true, stage: 'runtime', skipped: true },
    )

    // The next run recompiles the module and disposes cleanly.
    const next = await sb.run('1+1')
    assert.equal(next.ok, true, JSON.stringify(next.error))
    assert.equal(next.result.value, 2)
    assert.deepEqual(next.disposal, { ok: true, errors: [] })
  } finally {
    restoreEngine()
    sb.dispose()
  }

  assert.deepEqual(
    printed.filter((chunk) => /Aborted/i.test(chunk)),
    [],
    `engine abort printed to stderr: ${printed.join('')}`,
  )
})

test('memory limit is enforced', async () => {
  const sb = await sandbox({ limits: { memoryBytes: 2 * 1024 * 1024, timeoutMs: 3000 } })
  try {
    const run = await sb.run('var s = "x"; for (var i = 0; i < 30; i++) { s = s + s } s.length')
    assert.equal(run.ok, false)
    assert.ok(
      run.limitsHit.includes('memory') || /memory|allocation|stack/i.test(`${run.error?.name} ${run.error?.message}`),
      `unexpected failure: ${JSON.stringify(run.error)}`,
    )
  } finally {
    sb.dispose()
  }
})

test('entry point call returns the guest function result', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('globalThis.start = function (a, b) { return a * b }', {
      entry: 'start',
      args: [6, 7],
    })
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 42)
  } finally {
    sb.dispose()
  }
})

test('entry point errors are reported instead of thrown', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('globalThis.start = function () { throw new TypeError("nope") }', {
      entry: 'start',
    })
    assert.equal(run.ok, false)
    assert.equal(run.error.name, 'TypeError')
    assert.match(run.error.message, /nope/)
  } finally {
    sb.dispose()
  }
})

test('eval payloads are captured as code trace events', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('eval("var stage = 1 + 1; stage")')
    assert.equal(run.ok, true)
    const evalEvents = (run.events ?? []).filter((event) => event.kind === 'code' && event.event === 'eval')
    assert.equal(evalEvents.length, 1)
    assert.match(String(evalEvents[0].value?.value ?? ''), /stage/)
  } finally {
    sb.dispose()
  }
})

test('timers run on the virtual clock and jobs are settled', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      globalThis.__ticks = 0;
      setTimeout(function () { globalThis.__ticks += 1 }, 250);
      Promise.resolve(1).then(function () { globalThis.__ticks += 10 });
    `)
    assert.equal(run.ok, true)
    assert.ok(run.settle.jobs >= 1, JSON.stringify(run.settle))
    assert.ok(run.settle.timerCallbacks >= 1, JSON.stringify(run.settle))
    assert.ok(run.virtualMs >= 250, JSON.stringify(run.settle))
    // Settlement happened inside that run; a new run starts from a fresh context.
    const value = await sb.run('typeof globalThis.__ticks')
    assert.equal(value.result.value, 'undefined')
  } finally {
    sb.dispose()
  }
})

test('sample-defined globals are recorded but do not break integrity', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('var payload = 1; function helper() {} payload')
    assert.equal(run.integrity.intact, true)
    assert.deepEqual(run.integrity.intrinsicDrift, [])
    assert.ok(run.integrity.addedGlobals.includes('payload'))
    assert.ok(run.integrity.addedGlobals.includes('helper'))
  } finally {
    sb.dispose()
  }
})

test('prototype pollution is detected as intrinsic drift', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('Array.prototype.polluted = function () {}; 1')
    assert.equal(run.integrity.intact, false)
    assert.ok(
      run.integrity.drift.some(
        (entry) => entry.kind === 'prototype-added' && entry.target === 'Array.prototype.polluted',
      ),
      JSON.stringify(run.integrity.drift),
    )
  } finally {
    sb.dispose()
  }
})

test('profile is deterministic and internally coherent', () => {
  const a = createProfile({ seed: 1234 })
  const b = createProfile({ seed: 1234 })
  assert.deepEqual(a.screen, b.screen)
  assert.equal(a.userAgent, b.userAgent)
  assert.equal(a.timezone, b.timezone)
  const report = consistencyReport(a)
  assert.equal(report.ok, true, JSON.stringify(report.problems))

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const profile = createProfile({ seed })
    const check = consistencyReport(profile)
    assert.equal(check.ok, true, `seed ${seed}: ${JSON.stringify(check.problems)}`)
  }
})

test('Math.random is seeded and reproducible across sandboxes', async () => {
  const first = await sandbox({ seed: 99 })
  const second = await sandbox({ seed: 99 })
  try {
    const a = await first.run('Math.random()')
    const b = await second.run('Math.random()')
    assert.equal(a.result.value, b.result.value)
    const c = await first.run('Math.random()')
    assert.equal(c.result.value, a.result.value)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('limit normalization clamps hostile values', () => {
  const limits = normalizeLimits({ timeoutMs: -1, memoryBytes: 1, maxJobs: Number.NaN, maxEvents: 10 ** 12 })
  assert.ok(limits.timeoutMs >= 50)
  assert.ok(limits.memoryBytes >= 1024 * 1024)
  assert.equal(typeof limits.maxJobs, 'number')
  assert.ok(limits.maxEvents <= 1_000_000)
})

test('concurrent sandboxes stay isolated and dispose cleanly', async () => {
  const runs = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const sb = await sandbox({ seed: 100 + index })
      try {
        return await sb.run(`var identity = ${index}; identity * 2`, {
          filename: `https://cdn.test/worker-${index}.js`,
        })
      } finally {
        sb.dispose()
      }
    }),
  )
  runs.forEach((run, index) => {
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, index * 2)
    assert.equal(run.disposal.ok, true, JSON.stringify(run.disposal))
    assert.match(run.filename, new RegExp(`worker-${index}\\.js$`))
  })
})
