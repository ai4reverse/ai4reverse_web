import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { loadQuickJS, markModuleUnhealthy, resetQuickJS } from '../tools/sandbox/runtime.js'
import { SandboxError } from '../tools/util/errors.js'

// The full environment is irrelevant here and costs time per run; the limits
// being tested are runtime-level.
const CORE_ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'random', 'anti-fingerprint']
const OVERFLOW = 'function f(n){return f(n+1)} f(0)'
const OVERFLOW_RUNS = 12

/** @param {object} [options] */
async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: CORE_ENV },
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

test(`${OVERFLOW_RUNS} consecutive stack overflows do not disable the sandbox (D1)`, async () => {
  const sb = await sandbox()
  const started = Date.now()
  const printed = []
  const restoreEngine = captureEngineOutput(printed)
  try {
    const runs = []
    for (let i = 1; i <= OVERFLOW_RUNS; i++) {
      // Every run must *return a record*. Before the fix the 12th call threw a
      // message-less QuickJSUnwrapError because the shared WASM module was
      // poisoned by the previous aborted disposals.
      const run = await sb.run(OVERFLOW)
      runs.push(run)
      assert.equal(run.ok, false, `run ${i} should report the stack overflow as a failure`)
      assert.ok(
        run.limitsHit.includes('stack'),
        `run ${i}: expected stack in limitsHit, got ${JSON.stringify(run.limitsHit)}`,
      )
      assert.match(`${run.error?.name}: ${run.error?.message}`, /stack|overflow|too deep/i)
    }

    // The leak is real and must stay visible: the runtime cannot be released
    // after stack exhaustion, so it is abandoned instead of disposed and the
    // record says exactly that. Before the fix `runtime.dispose()` aborted the
    // WASM engine (`list_empty(&rt->gc_obj_list)`) and printed the assertion.
    for (const [index, run] of runs.entries()) {
      assert.equal(run.disposal?.ok, false, `run ${index + 1}: disposal must report failure`)
      assert.equal(run.disposal?.leaked, true, `run ${index + 1}: leak marker missing`)
      assert.equal(run.disposal?.stage, 'runtime', `run ${index + 1}: wrong disposal stage`)
      assert.equal(run.disposal?.skipped, true, `run ${index + 1}: disposal was not skipped`)
      assert.deepEqual(run.disposal?.errors, [], `run ${index + 1}: a skipped disposal is not an error`)
    }

    // The quarantine must give the process its analysis capability back.
    const normal = await sb.run('1+1')
    assert.equal(normal.ok, true, `post-overflow run failed: ${JSON.stringify(normal.error)}`)
    assert.equal(normal.result.value, 2)
    assert.equal(normal.disposal.ok, true)
    assert.ok(!normal.disposal.leaked, 'a clean disposal must not report a leak')

    const elapsed = Date.now() - started
    assert.ok(elapsed < 60_000, `resilience sequence took ${elapsed}ms`)
  } finally {
    restoreEngine()
    sb.dispose()
  }

  // The engine abort must never surface: no `Aborted(Assertion failed: ...)` on
  // the host's stderr, and no abort exception escaping as a run error (checked
  // above through the RangeError shape of every record).
  const aborts = printed.filter((chunk) => /Aborted/i.test(chunk))
  assert.deepEqual(aborts, [], `engine abort printed to stderr: ${aborts.join('')}`)
})

test('a failed disposal quarantines the module and loadQuickJS() replaces it (D1)', async () => {
  try {
    const before = await loadQuickJS()
    markModuleUnhealthy(before)
    const after = await loadQuickJS()
    assert.notEqual(after, before, 'a quarantined module must not be handed out again')

    // The replacement module is usable: a fresh runtime and context work.
    const runtime = after.newRuntime()
    try {
      const ctx = runtime.newContext()
      try {
        const result = ctx.evalCode('40 + 2')
        if (result.error) {
          const dumped = ctx.dump(result.error)
          result.error.dispose()
          assert.fail(`fresh module failed: ${JSON.stringify(dumped)}`)
        }
        assert.equal(ctx.dump(result.value), 42)
        result.value.dispose()
      } finally {
        ctx.dispose()
      }
    } finally {
      runtime.dispose()
    }
  } finally {
    resetQuickJS()
  }
})

test('initialisation failures are typed SandboxErrors and leave no unhandled rejection (D2)', async () => {
  const sb = await sandbox()
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const original = sb.module.newRuntime
  try {
    let calls = 0
    sb.module.newRuntime = function newRuntimeOnceFailing(...args) {
      calls += 1
      if (calls === 1) throw new Error('forced init failure')
      return original.apply(this, args)
    }

    await assert.rejects(
      () => sb.run('1+1'),
      (error) => {
        assert.ok(error instanceof SandboxError, `expected SandboxError, got ${error?.constructor?.name}`)
        assert.equal(error.code, 'SANDBOX_INIT')
        assert.equal(typeof error.message, 'string')
        assert.ok(error.message.length > 0, 'SandboxError message must not be empty')
        assert.match(error.message, /forced init failure/)
        assert.ok(error.cause instanceof Error, 'the original error must survive as `cause`')
        assert.equal(error.cause.message, 'forced init failure')
        return true
      },
    )
  } finally {
    sb.module.newRuntime = original
  }

  try {
    // The failed acquisition must not poison the sandbox: the next run works.
    const recovered = await sb.run('1+1')
    assert.equal(recovered.ok, true, JSON.stringify(recovered.error))
    assert.equal(recovered.result.value, 2)
    assert.equal(recovered.disposal.ok, true)

    // Invalid input before acquisition is a typed error too, never a bare throw.
    await assert.rejects(
      () => sb.run(''),
      (error) => {
        assert.ok(error instanceof SandboxError)
        assert.ok(error.message.length > 0)
        return true
      },
    )
  } finally {
    sb.dispose()
    // Give any stray rejection a turn to be reported before asserting.
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', onUnhandled)
  }

  assert.deepEqual(unhandled, [], `unhandled rejections: ${unhandled.map((item) => String(item)).join(', ')}`)
})

test('a failure after acquisition is wrapped as SANDBOX_RUN (D2)', async () => {
  const sb = await sandbox()
  const original = sb.profileSummary
  try {
    // Fails inside the guarded run phase, after runtime/context/stealth/bridge
    // already exist (so the finally block has real work to do).
    sb.profileSummary = function failingProfileSummary() {
      throw new Error('forced run failure')
    }
    await assert.rejects(
      () => sb.run('1+1'),
      (error) => {
        assert.ok(error instanceof SandboxError, `expected SandboxError, got ${error?.constructor?.name}`)
        assert.equal(error.code, 'SANDBOX_RUN')
        assert.ok(error.message.length > 0, 'SandboxError message must not be empty')
        assert.match(error.message, /forced run failure/)
        assert.equal(error.cause?.message, 'forced run failure')
        return true
      },
    )
    // Building the failure record must not mask the failure: the sandbox is
    // still usable and its last run is recorded as failed.
    assert.equal(sb.lastRun?.ok, false)
    assert.equal(sb.lastRun?.disposal?.ok, true)
  } finally {
    sb.profileSummary = original
  }

  const recovered = await sb.run('1+1')
  assert.equal(recovered.ok, true, JSON.stringify(recovered.error))
  assert.equal(recovered.result.value, 2)
  sb.dispose()
})

/**
 * Event-loop stack exhaustion: the entry script returns normally, then a
 * callback recurses past the stack limit. The script did succeed, so `ok` stays
 * true, but the runtime's heap is as unrecoverable as after a main-script
 * overflow — so the breach must be classified (`limitsHit: ['stack']`), carried
 * on `settle.error`, and the runtime abandoned instead of disposed.
 *
 * Before the fix each case printed one `Aborted(Assertion failed:
 * list_empty(&rt->gc_obj_list))` line to stderr; the promise-job case also threw
 * `SANDBOX_RUN: sandbox run failed: Maximum call stack size exceeded`.
 */
const EVENT_LOOP_DEFORMATIONS = [
  {
    label: 'timer callback',
    source: 'setTimeout(function f(){ return f() }, 0)',
    origin: 'timer',
  },
  {
    label: 'promise job',
    source: 'Promise.resolve().then(function f(){ return f() })',
    origin: 'promise-job',
  },
]

for (const deformation of EVENT_LOOP_DEFORMATIONS) {
  test(`stack exhaustion in a ${deformation.label} is a classified limit, not an engine abort`, async () => {
    const sb = await sandbox()
    const printed = []
    const restoreEngine = captureEngineOutput(printed)
    try {
      // `run()` itself must resolve: a host RangeError escaping the WASM
      // trampoline used to turn the promise-job case into a SANDBOX_RUN throw.
      const run = await sb.run(deformation.source)

      // The evaluated script never threw; only the event loop did.
      assert.equal(run.ok, true, `unexpected failure: ${JSON.stringify(run.error)}`)
      assert.equal(run.error, null)
      assert.deepEqual(run.limitsHit, ['stack'], JSON.stringify(run.limitsHit))

      // The error is structured and attributable to the callback that recursed.
      assert.ok(run.settle && !run.settle.skipped, `settle missing: ${JSON.stringify(run.settle)}`)
      assert.deepEqual(run.settle.limitsHit, ['stack'], JSON.stringify(run.settle))
      assert.equal(run.settle.error?.origin, deformation.origin)
      assert.equal(run.settle.error?.name, 'RangeError')
      assert.match(String(run.settle.error?.message), /maximum call stack/i)

      // The heap cannot be released, so the runtime is abandoned (no dispose
      // attempt, therefore no abort) and the module is quarantined.
      assert.deepEqual(
        { ...run.disposal, errors: run.disposal.errors.length },
        { ok: false, errors: 0, leaked: true, stage: 'runtime', skipped: true },
      )

      // Quarantining must hand the analysis capability back immediately.
      const followUp = await sb.run('1+1')
      assert.equal(followUp.ok, true, JSON.stringify(followUp.error))
      assert.equal(followUp.result.value, 2)
      assert.deepEqual(followUp.disposal, { ok: true, errors: [] })
      assert.deepEqual(followUp.limitsHit, [])
      assert.equal(followUp.settle?.error, null)
    } finally {
      restoreEngine()
      sb.dispose()
    }

    const aborts = printed.filter((chunk) => /Aborted\(/.test(chunk))
    assert.deepEqual(aborts, [], `engine abort printed to stderr: ${aborts.join('')}`)
  })
}

test('a non-stack settle error stays a non-stack outcome (no stack quarantine)', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('setTimeout(function () { throw new RangeError("unrelated range error") }, 0)')
    assert.equal(run.ok, true)
    assert.deepEqual(run.limitsHit, [])
    // `settle.error` is the structured stack slot; a non-stack failure leaves it
    // empty (tolerating the pre-fix record that has no such key at all).
    assert.equal(run.settle?.error ?? null, null)
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
  } finally {
    sb.dispose()
  }
})
