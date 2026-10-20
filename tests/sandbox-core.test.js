import test from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { createProfile, consistencyReport } from '../tools/sandbox/profile.js'
import { normalizeLimits, DEFAULT_LIMITS } from '../tools/engine/limits.js'
import { SandboxError as SandboxErrorFromUtil } from '../tools/util/errors.js'
import { createHostBridge } from '../tools/sandbox/bridge.js'
import { createHarness } from './helpers/harness.js'

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
    // The limit is derived from the engine marker, not from the message.
    assert.equal(run.stackExhaustion, true)
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

/**
 * Forgery (audit N1): stack exhaustion is an *engine* signal, so a healthy run
 * must not be able to claim it. Both messages below are the exact text the
 * engine uses, and before the fix each one produced `limitsHit: ['stack']`,
 * abandoned the runtime and wrote a false leak marker into the evidence.
 */
const STACK_FORGERIES = [
  { label: 'Error', source: 'throw new Error("stack overflow")', name: 'Error', message: 'stack overflow' },
  {
    label: 'RangeError',
    source: 'throw new RangeError("Maximum call stack size exceeded")',
    name: 'RangeError',
    message: 'Maximum call stack size exceeded',
  },
]

for (const forgery of STACK_FORGERIES) {
  test(`a guest ${forgery.label} with a stack message is not a stack limit`, async () => {
    const sb = await sandbox()
    const printed = []
    const restoreEngine = captureEngineOutput(printed)
    try {
      const run = await sb.run(forgery.source)

      // The guest error is reported like any other failure...
      assert.equal(run.ok, false)
      assert.equal(run.error?.name, forgery.name)
      assert.equal(run.error?.message, forgery.message)

      // ...with no stack limit and no engine marker.
      assert.deepEqual(run.limitsHit, [], `forged stack limit: ${JSON.stringify(run.limitsHit)}`)
      assert.equal(run.stackExhaustion, false)
      assert.equal(run.settle, null)

      // ...and the runtime is healthy: disposal is clean and never abandoned.
      assert.deepEqual(run.disposal, { ok: true, errors: [] })
      assert.equal('leaked' in run.disposal, false, 'a forged overflow must not report a leak')
      assert.equal('skipped' in run.disposal, false, 'a forged overflow must not skip disposal')

      // No quarantine: the next run reuses the same, uncorrupted module.
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
}

/**
 * Forgery (R9b): the *name* is guest data too. QuickJS labels its own stack
 * overflow `InternalError`, so a dumped `{name: 'InternalError'}` record used to
 * be read as engine evidence — the remaining way to abandon a healthy runtime
 * from pure guest data. Classification now uses intrinsic identity of the live
 * handle (`stealth.isIntrinsicStackError`), so no crafted object classifies.
 */
const INTRINSIC_STACK_FORGERIES = [
  {
    label: 'plain object',
    source: "throw { name: 'InternalError', message: 'Maximum call stack size exceeded', stack: '' }",
  },
  {
    label: 'Error renamed to InternalError',
    source: "var error = new Error('Maximum call stack size exceeded'); error.name = 'InternalError'; throw error",
  },
  {
    label: 'object with an InternalError prototype stand-in',
    source: `
      var proto = Object.create(Error.prototype);
      proto.name = 'InternalError';
      var error = Object.create(proto);
      error.message = 'Maximum call stack size exceeded';
      error.stack = '';
      throw error;
    `,
  },
  {
    label: 'InternalError recovered from the constructor name',
    source: `
      var ErrorCtor = new Error('probe').constructor;
      var Fake = function InternalError(message) { this.message = message };
      Fake.prototype = Object.create(ErrorCtor.prototype);
      Fake.prototype.name = 'InternalError';
      throw new Fake('Maximum call stack size exceeded');
    `,
  },
]

for (const forgery of INTRINSIC_STACK_FORGERIES) {
  test(`${forgery.label} cannot forge engine stack exhaustion`, async () => {
    const sb = await sandbox()
    const printed = []
    const restoreEngine = captureEngineOutput(printed)
    try {
      const run = await sb.run(forgery.source)
      assert.equal(run.ok, false)
      assert.deepEqual(run.limitsHit, [], `forged stack limit: ${JSON.stringify(run.limitsHit)}`)
      assert.equal(run.stackExhaustion, false)
      // A healthy runtime: no leak marker, no skipped disposal, no quarantine.
      assert.deepEqual(run.disposal, { ok: true, errors: [] })

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
}

test('the engine InternalError prototype is unreachable from the guest', async () => {
  const sb = await sandbox()
  try {
    // The intrinsic is what the identity probe compares against; a guest that
    // could reach it could craft a prototype-identical object. `globals`
    // removes the constructor for every non-Firefox profile, so the only way to
    // a matching object is a *real* engine overflow.
    const surface = await sb.run(`
      ({
        type: typeof InternalError,
        own: Object.getOwnPropertyNames(globalThis).indexOf('InternalError'),
        inherit: (function () {
          var proto = Object.getPrototypeOf(new Error('x'))
          return proto !== null && proto !== Object.prototype && proto.name === 'InternalError'
        })()
      })
    `)
    assert.equal(surface.ok, true, JSON.stringify(surface.error))
    const value = JSON.parse(surface.result.preview)
    assert.equal(value.type, 'undefined', 'guest can still reach the engine InternalError')
    assert.equal(value.own, -1)
    assert.equal(value.inherit, false)
    assert.deepEqual(surface.disposal, { ok: true, errors: [] })
  } finally {
    sb.dispose()
  }
})

/**
 * Firefox fidelity with the engine prototype out of reach (F-B4).
 *
 * A Firefox profile has to expose `InternalError` (real Firefox does), and QuickJS
 * stamps that same prototype on the errors it throws itself. `env/stack` therefore
 * gives the wrapper its own prototype instead of sharing the engine's: same own
 * properties, `[[Prototype]] === Error.prototype` (exactly what SpiderMonkey has),
 * `constructor` pointing at the wrapper, and the stack sanitiser still applied.
 * Every surface a sample can check stays faithful, while the engine's own
 * prototype — the one an overflow carries — is unreachable.
 */
test('a Firefox profile keeps InternalError faithful but not engine-shaped', async () => {
  const sb = await sandbox({ env: { strict: true }, profile: { browser: 'firefox', os: 'linux', locale: 'en-US' } })
  try {
    const run = await sb.run(`
      (function () {
        var out = {};
        out.type = typeof InternalError;
        out.name = InternalError.name;
        out.length = InternalError.length;
        out.protoOwn = Object.getOwnPropertyNames(InternalError.prototype).sort();
        out.protoIsErrorProto = Object.getPrototypeOf(InternalError.prototype) === Error.prototype;
        out.constructorSelf = InternalError.prototype.constructor === InternalError;
        var error = new InternalError('probe');
        out.own = Object.getOwnPropertyNames(error).sort();
        out.name_ = error.name;
        out.message = error.message;
        out.instanceofInternal = error instanceof InternalError;
        out.instanceofError = error instanceof Error;
        out.protoMatches = Object.getPrototypeOf(error) === InternalError.prototype;
        out.stringifies = Function.prototype.toString.call(InternalError).indexOf('[native code]') >= 0;
        out.stackHasMarkers = /ai4r-internal|<eval>/.test(String(error.stack));
        out.seal = Object.prototype.toString.call(error);
        return JSON.stringify(out);
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.value)
    assert.equal(value.type, 'function', 'Firefox profile must keep InternalError')
    assert.equal(value.name, 'InternalError')
    assert.deepEqual(value.protoOwn, ['constructor', 'message', 'name'])
    assert.equal(value.protoIsErrorProto, true, 'InternalError.prototype must inherit Error.prototype')
    assert.equal(value.constructorSelf, true)
    assert.deepEqual(value.own, ['message', 'stack'], 'instance shape must match an engine error')
    assert.equal(value.name_, 'InternalError')
    assert.equal(value.message, 'probe')
    assert.equal(value.instanceofInternal, true)
    assert.equal(value.instanceofError, true)
    assert.equal(value.protoMatches, true)
    assert.equal(value.stringifies, true, 'the wrapper must stringify as a native function')
    assert.equal(value.stackHasMarkers, false, 'the stack sanitiser must still run')
    assert.equal(value.seal, '[object Error]')
  } finally {
    sb.dispose()
  }
})

/**
 * The same guarantee under the default (Chromium-like) profile, where the engine
 * constructor is deleted from the global object: no guest-reachable prototype can
 * match an engine overflow, on either profile.
 */
test('no guest-reachable object matches the engine stack prototype', async () => {
  for (const profile of [
    { browser: 'firefox', os: 'linux', locale: 'en-US' },
    { browser: 'edge', os: 'macos', locale: 'en-US' },
  ]) {
    const sb = await sandbox({ env: { strict: true }, profile })
    try {
      // A genuine overflow is the only way to an engine prototype; the run is
      // classified and abandoned, so the record is what carries the proof: the
      // interpreter-level path is only reachable with a reduced stack limit and
      // is covered in `tests/resilience.test.js`. Here: guest constructions must
      // never classify.
      const forged = await sb.run(`
        var candidates = [];
        if (typeof InternalError === 'function') {
          candidates.push(new InternalError('stack overflow'));
          candidates.push(Object.create(InternalError.prototype));
          var grafted = new Error('stack overflow');
          if (typeof InternalError === 'function') Object.setPrototypeOf(grafted, InternalError.prototype);
          candidates.push(grafted);
        }
        candidates.push(new RangeError('Maximum call stack size exceeded'));
        candidates.push(new Error('Maximum call stack size exceeded'));
        for (var i = 0; i < candidates.length; i += 1) {
          try { candidates[i].stack = '    at f (https://x.test/a.js:1:1)' } catch (e) {}
        }
        throw candidates[candidates.length - 1];
      `)
      assert.equal(forged.ok, false, `${profile.browser}: ${JSON.stringify(forged.error)}`)
      assert.deepEqual(forged.limitsHit, [], `${profile.browser}: ${JSON.stringify(forged.limitsHit)}`)
      assert.deepEqual(forged.disposal, { ok: true, errors: [] }, profile.browser)
    } finally {
      sb.dispose()
    }
  }
})

/**
 * A sample that *catches* the engine overflow must not be handed the engine's
 * prototype (F-B4 follow-up): the caught error still carries the intrinsic
 * prototype, and a constructor read from there would be the engine's own class —
 * enough to forge a classification later in the same run. The wrapper rewrites
 * that prototype's `constructor` to itself, so `error.constructor` is the global
 * wrapper and re-constructing through it produces a guest-prototype error.
 */
test('a caught engine overflow does not hand the sample the engine constructor', async () => {
  const sb = await sandbox({
    env: { strict: true },
    profile: { browser: 'firefox', os: 'linux', locale: 'en-US' },
    limits: { stackBytes: 64 * 1024 },
  })
  try {
    const run = await sb.run(`
      (function () {
        var out = { caught: false };
        try {
          (function f(n) { return f(n + 1) })(0);
        } catch (error) {
          out.caught = true;
          out.name = error.name;
          out.message = error.message;
          out.constructorIsGlobal = error.constructor === InternalError;
          out.constructorNative = Function.prototype.toString.call(error.constructor).indexOf('[native code]') >= 0;
          var Again = error.constructor;
          var clone = new Again('stack overflow');
          out.cloneOnGuestPrototype = Object.getPrototypeOf(clone) === InternalError.prototype;
          out.cloneOwn = Object.getOwnPropertyNames(clone).sort();
          out.stackHasMarkers = /ai4r-internal|<eval>/.test(String(error.stack));
        }
        return JSON.stringify(out);
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.value)
    assert.equal(value.caught, true, 'a reduced stack limit must be catchable inside the guest')
    assert.equal(value.name, 'InternalError')
    assert.equal(value.message, 'stack overflow')
    assert.equal(value.constructorIsGlobal, true, 'error.constructor must be the global wrapper')
    assert.equal(value.constructorNative, true)
    assert.equal(value.cloneOnGuestPrototype, true, 're-constructing must not reach the engine prototype')
    assert.deepEqual(value.cloneOwn, ['message', 'stack'])
    assert.equal(value.stackHasMarkers, false)
    // The guest swallowed the overflow, so this run is an ordinary success: no
    // limit, no abandonment (the engine never reached the host boundary).
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.stackExhaustion, false)
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
  } finally {
    sb.dispose()
  }
})

test('a forged stack message in a callback is a guest exception, not a stack limit', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      'Promise.resolve().then(function () { throw new RangeError("Maximum call stack size exceeded") })',
    )
    assert.equal(run.ok, true)
    assert.deepEqual(run.limitsHit, [])
    assert.equal(run.settle?.stackExhaustion ?? false, false)
    assert.equal(run.settle?.error ?? null, null)
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
  } finally {
    sb.dispose()
  }
})

test('memory limit is enforced', async () => {
  const sb = await sandbox({ limits: { memoryBytes: 2 * 1024 * 1024, timeoutMs: 3000 } })
  try {
    const run = await sb.run('var s = "x"; for (var i = 0; i < 30; i++) { s = s + s } s.length')
    assert.equal(run.ok, false)
    assert.deepEqual(run.limitsHit, ['memory'])
    assert.equal(run.stackExhaustion, false)
    assert.equal(run.timedOut, false)
    assert.equal(run.disposal.ok, true)
    const followUp = await sb.run('21 * 2')
    assert.equal(followUp.ok, true)
    assert.equal(followUp.result.value, 42)
    assert.deepEqual(followUp.limitsHit, [])
    assert.equal(followUp.disposal.ok, true)
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
  const limits = normalizeLimits({ timeoutMs: -1, memoryBytes: 1, maxEvents: 10 ** 12 })
  assert.ok(limits.timeoutMs >= 50)
  assert.ok(limits.memoryBytes >= 1024 * 1024)
  assert.equal(typeof limits.maxJobs, 'number')
  assert.ok(limits.maxEvents <= 1_000_000)
})

test('a mistyped limit option is a usage error, not a silent default', () => {
  // F5/D7: the old contract dropped unknown keys and non-finite values, so the
  // report showed a default as if the caller had asked for it.
  assert.throws(
    () => normalizeLimits({ maxEvent: 100 }),
    (error) => {
      assert.equal(error.name, 'SandboxError')
      assert.equal(error.code, 'SANDBOX_LIMITS')
      assert.match(error.message, /unknown limit 'maxEvent'/)
      assert.match(error.message, /accepted limits are timeoutMs/, 'the message must name the accepted keys')
      assert.deepEqual(error.details.unknownKeys, ['maxEvent'])
      assert.ok(error.details.accepted.includes('maxEvents'))
      return true
    },
  )
  assert.throws(
    () => normalizeLimits({ timeoutMs: 'abc' }),
    (error) => {
      assert.equal(error.code, 'SANDBOX_LIMITS')
      assert.match(error.message, /limit 'timeoutMs' needs a finite number/)
      assert.deepEqual(error.details.invalidValues, ['timeoutMs'])
      return true
    },
  )
  assert.throws(() => normalizeLimits({ timeoutMs: Number.NaN }), /needs a finite number/)

  // Lenient mode is the documented escape hatch for forwarded option bags: the
  // old ignore-and-default behaviour, plus one warning per ignored entry.
  const warnings = []
  const limits = normalizeLimits(
    { maxEvent: 100, timeoutMs: 'abc', maxVirtualMs: 5000 },
    { strict: false, logger: { warn: (payload, message) => warnings.push({ payload, message }) } },
  )
  assert.equal(limits.maxEvents, DEFAULT_LIMITS.maxEvents)
  assert.equal(limits.timeoutMs, DEFAULT_LIMITS.timeoutMs)
  assert.equal(limits.maxVirtualMs, 5000, 'valid options in the same bag still apply')
  assert.deepEqual(
    warnings.map((entry) => entry.payload.reason),
    ["unknown limit 'maxEvent'", "limit 'timeoutMs' needs a finite number"],
  )
  assert.ok(warnings.every((entry) => entry.message === 'ignored limit option'))

  // `undefined`/`null` mean "not provided" (a very common spread shape) and are
  // not usage errors. A numeric string is accepted because CLI/JSON callers
  // forward text.
  assert.equal(normalizeLimits({ timeoutMs: undefined, maxEvents: null }).timeoutMs, DEFAULT_LIMITS.timeoutMs)
  assert.equal(normalizeLimits({ timeoutMs: '2500' }).timeoutMs, 2500)

  // The sandbox constructor is where an analyst hits this: it must be a typed
  // error, not a silently different budget.
  assert.throws(
    () => new TracelessSandbox({ logLevel: 'silent', limits: { maxEvent: 100 } }),
    (error) => error instanceof SandboxErrorFromUtil && error.code === 'SANDBOX_LIMITS',
  )
})

test('an unknown profile value is a typed error that names the accepted ones', () => {
  // F5: `browser: 'chromium'` used to throw a bare TypeError from inside the
  // fingerprint builder ('Cannot read properties of undefined (reading
  // versions)'), which reads as an internal fault instead of a usage error.
  for (const [option, value, expected] of [
    ['browser', 'chromium', /profile\.browser must be one of chrome, edge, firefox/],
    ['os', 'solaris', /profile\.os must be one of windows, macos, linux/],
    ['locale', 'xx-YY', /profile\.locale must be one of/],
  ]) {
    assert.throws(
      () => createProfile({ [option]: value }),
      (error) => {
        assert.equal(error.name, 'SandboxError')
        assert.equal(error.code, 'SANDBOX_PROFILE')
        assert.match(error.message, expected)
        assert.equal(error.details.field, option)
        assert.equal(error.details.value, value)
        return true
      },
      `${option}: ${value}`,
    )
  }
  assert.throws(
    () => new TracelessSandbox({ logLevel: 'silent', profile: { browser: 'chromium' } }),
    (error) => error.code === 'SANDBOX_PROFILE' && /chrome, edge, firefox/.test(error.message),
  )
  // Valid aliases keep working, and a non-string is the same usage error.
  assert.equal(createProfile({ browser: 'firefox', os: 'linux', locale: 'en-GB' }).browser, 'firefox')
  assert.equal(createProfile({ browser: 'edge' }).browserName, 'Edge')
  assert.throws(() => createProfile({ browser: 42 }), /profile\.browser must be one of/)
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

/**
 * Interruption leak (cross-runtime): every sandbox shares one QuickJS WASM
 * module, so two concurrent runs interleave at the `await` points of the run
 * preamble. Before the fix the *normal* run's runtime was created before the
 * timeout run monopolised the thread for `limits.timeoutMs`; when it resumed,
 * its host-time budget — measured with `Date.now()` from runtime creation — was
 * already expired, so it interrupted itself on its first guest statement, and
 * the abandoned evaluation made `runtime.dispose()` abort the engine with
 * `list_empty(&rt->gc_obj_list)`. The interrupting run disposed cleanly, which
 * hid the coupling. Seed `0x5eed` reproduces it on every run; guest execution is
 * now queued, so the two runs behave like the sequential equivalent.
 */
test('a concurrent timeout neither corrupts nor interrupts the other run', async () => {
  const printed = []
  const restoreEngine = captureEngineOutput(printed)
  const mk = () =>
    TracelessSandbox.create({
      seed: 0x5eed,
      logLevel: 'silent',
      env: { strict: true },
      limits: { timeoutMs: 400 },
    })
  const timed = await mk()
  const normal = await mk()
  try {
    const [timeoutRun, normalRun] = await Promise.all([
      timed.run('while (true) {}'),
      normal.run('globalThis.__m = 1; typeof window;'),
    ])

    // The timeout is still classified, and its own runtime still disposes.
    assert.equal(timeoutRun.ok, false)
    assert.equal(timeoutRun.timedOut, true)
    assert.deepEqual(timeoutRun.limitsHit, ['timeout'])
    assert.deepEqual(timeoutRun.disposal, { ok: true, errors: [] })

    // The queued run is untouched by the interruption: no self-interrupt (its
    // budget never ran out while another run held the thread), the right
    // result, and a clean teardown instead of the leaked-handle abort.
    assert.equal(normalRun.ok, true, JSON.stringify(normalRun.error))
    assert.equal(normalRun.result.value, 'object')
    assert.deepEqual(normalRun.limitsHit, [])
    assert.equal(normalRun.runtime.reason, null, `interrupted: ${JSON.stringify(normalRun.runtime)}`)
    assert.deepEqual(normalRun.disposal, { ok: true, errors: [] })

    // Both sandboxes stay usable, in either order.
    for (const sb of [timed, normal]) {
      const again = await sb.run('1+1')
      assert.equal(again.ok, true, JSON.stringify(again.error))
      assert.equal(again.result.value, 2)
      assert.deepEqual(again.disposal, { ok: true, errors: [] })
    }
  } finally {
    restoreEngine()
    timed.dispose()
    normal.dispose()
  }

  assert.deepEqual(
    printed.filter((chunk) => /Aborted/i.test(chunk)),
    [],
    `engine abort printed to stderr: ${printed.join('')}`,
  )
})

/**
 * The four samples of `examples/works/30-sandbox-farm/app.mjs --self-test`.
 * They are copied instead of imported so this suite does not depend on the
 * example file, but the mix is the same: a network/storage sample, a benign
 * sample, a spinner that must be interrupted and an isolation probe. The
 * spinner is listed first so that all three pool workers start in the same
 * tick: the interrupted run then monopolises the thread while the other two
 * are mid-preamble, which is the interleaving that used to leak (the farm's
 * `--self-test` shape with a two-sandbox pool).
 */
const FARM_SAMPLES = [
  { name: 'spin.js', source: 'while (true) {}' },
  {
    name: 'malicious.js',
    source:
      'fetch(atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3Q=")).catch(function(){}); localStorage.setItem("x", "1");',
  },
  { name: 'benign.js', source: 'var a = 1 + 2; console.log(a);' },
  { name: 'isolation.js', source: 'globalThis.__farmMarker = 1; typeof window;' },
]

/**
 * A pool is the shape that broke: N sandboxes all reaching for the one shared
 * WASM module at once. That is now a queue (one guest run at a time per
 * process), so every sample must behave exactly as it does sequentially.
 */
test('a three-sandbox pool runs the farm samples without a leak', async () => {
  const printed = []
  const restoreEngine = captureEngineOutput(printed)
  const pool = await Promise.all(
    Array.from({ length: 3 }, () =>
      TracelessSandbox.create({
        seed: 0x5eed,
        logLevel: 'silent',
        env: { strict: true },
        limits: { timeoutMs: 400 },
      }),
    ),
  )
  const results = new Array(FARM_SAMPLES.length)
  try {
    let next = 0
    await Promise.all(
      pool.map(async (sb) => {
        for (let index = next++; index < FARM_SAMPLES.length; index = next++) {
          results[index] = await sb.run(FARM_SAMPLES[index].source, {
            filename: `https://cdn.example.test/farm/${index}.js`,
          })
        }
      }),
    )

    results.forEach((run, index) => {
      const { name } = FARM_SAMPLES[index]
      // Every run in the pool, interrupted or not, disposes its own runtime:
      // before the fix the two runs queued around the spinner aborted the engine.
      assert.equal(run.disposal.ok, true, `${name}: ${JSON.stringify(run.disposal)}`)
      if (name === 'spin.js') {
        assert.equal(run.ok, false)
        assert.deepEqual(run.limitsHit, ['timeout'], `${name}: ${JSON.stringify(run.limitsHit)}`)
        assert.equal(run.timedOut, true)
      } else {
        assert.equal(run.ok, true, `${name}: ${JSON.stringify(run.error)}`)
        assert.deepEqual(run.limitsHit, [], `${name}: ${JSON.stringify(run.limitsHit)}`)
      }
    })
    // The interrupted run did not disturb the run that was queued behind it.
    assert.equal(results[3].result.value, 'object', JSON.stringify(results[3].result))

    // Per-run isolation survives the queue: the pool sandbox that ran
    // `isolation.js` starts the next sample from pristine globals.
    const fresh = await pool[0].run('typeof globalThis.__farmMarker')
    assert.equal(fresh.ok, true, JSON.stringify(fresh.error))
    assert.equal(fresh.result.value, 'undefined')
    assert.deepEqual(fresh.disposal, { ok: true, errors: [] })
  } finally {
    restoreEngine()
    for (const sb of pool) sb.dispose()
  }

  assert.deepEqual(
    printed.filter((chunk) => /Aborted/i.test(chunk)),
    [],
    `engine abort printed to stderr: ${printed.join('')}`,
  )
})

// ---- host bridge contract -------------------------------------------------
//
// The bridge is the only sanctioned handle surface for environment modules, so
// its argument readers, conversions and teardown are tested directly instead of
// only through the modules that happen to call them.

/** Install a host function on the guest global under a probe name. */
function installProbe(harness, name, value) {
  harness.bridge.install(harness.bridge.global, name, value, {
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

test('bridge.fn keeps guest-visible name, arity and primitive returns', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const returns = ['text', 42, true, null, undefined, 7n, { a: 1 }, [1, 2]]
    installProbe(harness, 'probeReturns', harness.bridge.fn('probeReturns', 1, ({ args }) => {
      const index = harness.bridge.int(args, 0, 0)
      return returns[index]
    }))
    installProbe(harness, 'probeArity', harness.bridge.fn('probeArity', 20, () => 1))
    // Every arity has its own shaped trampoline; the guest must always see the
    // requested length (and 8 is the documented clamp).
    for (let arity = 0; arity <= 8; arity += 1) {
      installProbe(harness, `probeA${arity}`, harness.bridge.fn(`probeA${arity}`, arity, () => arity))
    }

    const result = harness.run(`(function(){
      var out = [];
      for (var i = 0; i < 8; i += 1) { var value = probeReturns(i); out.push(typeof value === 'bigint' ? String(value) : value); }
      out.push(probeReturns.length, probeReturns.name, probeArity.length);
      for (var j = 0; j <= 8; j += 1) out.push(globalThis['probeA' + j].length, globalThis['probeA' + j]());
      return JSON.stringify(out);
    })()`)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.deepEqual(JSON.parse(result.value), [
      'text',
      42,
      true,
      null,
      null,
      '7',
      { a: 1 },
      [1, 2],
      1,
      'probeReturns',
      8,
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
    ])
  } finally {
    harness.dispose()
  }
})

test('bridge.fn converts a thrown host error into a sanitised guest error', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const thrown = harness.bridge.fn('probeThrows', 0, () => {
      throw new RangeError('host detail at /Users/somewhere/tools/sandbox/env/x.js:12')
    })
    const boxed = harness.bridge.fn('probeThrowsValue', 0, () => {
      // A non-Error throw must still reach the guest as an Error.
      // eslint-disable-next-line no-throw-literal
      throw 'plain string'
    })
    installProbe(harness, 'probeThrows', thrown)
    installProbe(harness, 'probeThrowsValue', boxed)
    const result = harness.run(`(function(){
      var out = [];
      try { probeThrows(); } catch (error) { out.push(error.name, error.message, /tools/.test(error.message)); }
      try { probeThrowsValue(); } catch (error) { out.push(error.name, error.message); }
      return out;
    })()`)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.deepEqual(result.value, ['RangeError', 'host detail at :12', false, 'Error', 'plain string'])
    assert.equal(harness.bridge.stats.errors, 2)
  } finally {
    harness.dispose()
  }
})

test('bridge argument readers fall back on non-handles and wrong types', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge, ctx } = harness
    // Plain JS values are not handles: every reader returns its fallback.
    assert.equal(bridge.str(['x'], 0, 'fallback'), 'fallback')
    assert.equal(bridge.num([7], 0, -1), -1)
    assert.equal(bridge.int(['7'], 0, 3), 3)
    assert.equal(bridge.bool(['yes'], 0, true), true)
    assert.equal(bridge.value([], 0), undefined)
    assert.deepEqual(bridge.list(undefined, 10), [])
    assert.equal(bridge.fromGuest('raw'), 'raw', 'non-handles pass through')

    const numbers = ctx.evalCode('[1, 2, 3]')
    const symbols = ctx.evalCode('Symbol("probe")')
    assert.equal(bridge.str([numbers.value], 0, 'fallback'), 'fallback', 'a number is not a string')
    assert.equal(bridge.num([symbols.value], 0, 7), 7, 'a symbol is not a number')
    assert.equal(bridge.bool([symbols.value], 0, true), true)
    assert.equal(bridge.value([symbols.value], 0).toString(), 'Symbol(probe)', 'a symbol is described, never dereferenced')
    assert.deepEqual(bridge.list(numbers.value, 2), [1, 2], 'list honours the limit')
    assert.deepEqual(bridge.list(symbols.value), [], 'a non-indexable handle yields an empty list')
    const stale = ctx.evalCode('[1, 2]').value
    stale.dispose()
    assert.deepEqual(bridge.list(stale), [], 'a released handle yields an empty list instead of throwing')
    assert.equal(bridge.int([ctx.newNumber(Number.NaN)], 0, 4), 4, 'a non-finite number falls back')
    assert.deepEqual(bridge.list(numbers.value), [1, 2, 3])
    numbers.value.dispose()
    symbols.value.dispose()
  } finally {
    harness.dispose()
  }
})

test('bridge.fromGuest describes promises, functions and depth instead of dereferencing', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge, ctx } = harness
    const fulfilled = ctx.evalCode('Promise.resolve(7)')
    const rejected = ctx.evalCode('Promise.reject(new Error("nope"))')
    const fn = ctx.evalCode('function probe() {}; probe')
    assert.deepEqual(bridge.fromGuest(fulfilled.value), { __type: 'promise', state: 'fulfilled' })
    assert.deepEqual(bridge.fromGuest(rejected.value), { __type: 'promise', state: 'rejected' })
    assert.deepEqual(bridge.fromGuest(fn.value), { __type: 'function' })
    assert.equal(bridge.fromGuest(fulfilled.value, 5), '[depth]')
    for (const handle of [fulfilled.value, rejected.value, fn.value]) handle.dispose()
  } finally {
    harness.dispose()
  }
})

test('bridge.toGuest converts every supported shape and refuses host functions', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge, ctx } = harness
    const handle = ctx.evalCode('({ keep: 1 })').value
    assert.equal(bridge.toGuest(handle), handle, 'a handle is passed through unchanged')
    handle.dispose()

    installProbe(harness, 'probeObject', bridge.toGuest({
      text: 'a',
      number: 1,
      bool: false,
      big: 2n,
      bytes: new Uint8Array([1, 2, 3]),
      list: [1, { nested: 'x' }],
      skipped: undefined,
    }))
    const result = harness.run(`(function(){
      return JSON.stringify([
        probeObject.text,
        probeObject.number,
        probeObject.bool,
        String(probeObject.big),
        Array.from(new Uint8Array(probeObject.bytes)),
        probeObject.list[1].nested,
        'skipped' in probeObject,
        typeof probeObject,
      ]);
    })()`)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.deepEqual(JSON.parse(result.value), ['a', 1, false, '2', [1, 2, 3], 'x', false, 'object'])
    assert.throws(() => bridge.toGuest(() => {}), /refuses to convert a host function/)
    assert.equal(bridge.toGuest(Symbol('x')), ctx.undefined, 'unsupported types become undefined')
  } finally {
    harness.dispose()
  }
})

test('bridge property helpers set, read and build guest values', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge } = harness
    installProbe(harness, 'probeTarget', bridge.obj({ a: 1, b: undefined, nested: { n: 2 } }))
    installProbe(harness, 'probeList', bridge.arr([1, 'two', true]))
    const target = harness.ctx.evalCode('probeTarget')

    bridge.set(target.value, 'added', 3)
    assert.equal(bridge.get(target.value, 'added'), 3)
    const snapshot = harness.run(`(function(){
      return [probeTarget.a, 'b' in probeTarget, probeTarget.nested.n, probeTarget.added, probeList.length, probeList[1]];
    })()`)
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot.error))
    assert.deepEqual(snapshot.value, [1, false, 2, 3, 3, 'two'])

    target.value.dispose()
    assert.equal(bridge.get(harness.ctx.global, 'probeTarget').a, 1)
  } finally {
    harness.dispose()
  }
})

test('per-call value builders die with the call; install-time values do not', async () => {
  // Ownership audit: `obj()`/`arr()`/`toGuest()` used to register every value
  // in the bridge-wide `owned` set, so a sample that built a throwaway object
  // per call retained one host handle per call until teardown (20k calls grew
  // the host heap by tens of MB). Per-call values now join the call bag.
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge, ctx } = harness
    const installedObject = bridge.obj({ a: 1 })
    const installedArray = bridge.arr([1, 2])
    const perCall = []
    installProbe(
      harness,
      'probeOwnership',
      bridge.fn('probeOwnership', 0, ({ bag }) => {
        perCall.push(bridge.obj({ x: 1 }), bridge.arr([1, 2, 3]), bridge.toGuest('text'))
        return bag.keep(bridge.toGuest({ returned: true }))
      }),
    )

    const run = harness.run('var out = probeOwnership(); [out.returned, typeof out]')
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.value, [true, 'object'])
    assert.equal(perCall.length, 3)
    assert.deepEqual(
      perCall.map((handle) => handle.alive),
      [false, false, false],
      'temporaries must be released when the call returns',
    )
    // A value the guest received is owned by the guest from then on.
    assert.equal(harness.run('out.returned').value, true)
    assert.equal(installedObject.alive, true, 'install-time objects live until teardown')
    assert.equal(installedArray.alive, true)
    const disposal = harness.dispose()
    assert.equal(disposal.ok, true, 'no handle may be leaked')
    assert.equal(disposal.leaked, false)
  } finally {
    harness.dispose()
  }
})

test('a 20k-call builder loop stays on a memory plateau', async () => {
  // Regression guard for the retention above: with per-call values owned by the
  // bridge, 20k calls retained ~30 MB of host heap and 60k retained ~78 MB. The
  // fixed version plateaus at well under a megabyte; the bound is generous so
  // the assertion reports retention, not allocator noise.
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge } = harness
    installProbe(
      harness,
      'probePlateau',
      bridge.fn('probePlateau', 0, ({ bag }) => {
        bridge.obj({ a: 1, b: 'two', c: [1, 2, 3] })
        bridge.arr([1, 'two', { three: 3 }])
        return bag.keep(bridge.toGuest({ d: 4 }))
      }),
    )

    const heap = forcedHeap()
    const before = heap()
    const wave = (calls) => {
      const run = harness.run(`
        var sink = 0;
        for (var i = 0; i < ${calls}; i += 1) { sink += probePlateau().d; }
        sink
      `)
      assert.equal(run.ok, true, JSON.stringify(run.error))
      assert.equal(run.value, calls * 4)
      return heap()
    }

    const first = wave(20_000)
    const second = wave(20_000)
    assert.ok(first - before < 12 * 1024 * 1024, `20k calls retained ${((first - before) / 1048576).toFixed(1)} MB`)
    assert.ok(second - first < 6 * 1024 * 1024, `the next 20k calls retained ${((second - first) / 1048576).toFixed(1)} MB`)
  } finally {
    const disposal = harness.dispose()
    assert.equal(disposal.ok, true)
  }
})

test('bridge stats count the calls, errors and conversions that happened', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge } = harness
    installProbe(harness, 'probeStats', bridge.fn('probeStats', 1, ({ args }) => {
      if (bridge.num(args, 0, 0) < 0) throw new Error('negative')
      return { echoed: bridge.num(args, 0, 0) }
    }))
    const before = { ...bridge.stats }
    assert.equal(harness.run('probeStats(7).echoed').value, 7)
    assert.equal(harness.run('try { probeStats(-1) } catch (error) { error.message }').value, 'negative')
    assert.equal(bridge.stats.calls, before.calls + 2)
    assert.equal(bridge.stats.errors, before.errors + 1)
    assert.ok(
      bridge.stats.conversions > before.conversions,
      'conversions counts the toGuest conversions a call performed',
    )
  } finally {
    harness.dispose()
  }
})

/**
 * Heap reader that forces a collection first, so a test can assert retention
 * rather than pending garbage.
 * @returns {() => number} current host heap in bytes
 */
function forcedHeap() {
  v8.setFlagsFromString('--expose-gc')
  const collect = vm.runInNewContext('gc')
  return () => {
    collect()
    return process.memoryUsage().heapUsed
  }
}

test('bridge.install and bridge.accessor surface descriptor failures', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge, ctx } = harness
    const frozen = ctx.evalCode('Object.freeze({ a: 1 })')
    assert.throws(() => bridge.install(frozen.value, 'b', 2), /install\(b\) failed: object is not extensible/)
    assert.throws(
      () => bridge.accessor(frozen.value, 'c', { get: () => ctx.undefined }),
      /accessor\(c\) failed: object is not extensible/,
    )
    frozen.value.dispose()

    const target = ctx.evalCode('globalThis.__probeSlot = {}')
    let stored = 0
    bridge.accessor(target.value, 'slot', {
      get: () => ctx.newNumber(stored),
      set: ({ args }) => {
        stored = bridge.num(args, 0, 0)
        return ctx.undefined
      },
    })
    const observed = harness.run('__probeSlot.slot = 5; __probeSlot.slot')
    assert.equal(observed.ok, true, JSON.stringify(observed.error))
    assert.equal(observed.value, 5)
    assert.equal(stored, 5, 'the host setter received the guest value')
    const descriptor = harness.run(`(function(){
      var found = Object.getOwnPropertyDescriptor(__probeSlot, 'slot');
      return [typeof found.get, found.get.name, typeof found.set, found.set.name, found.enumerable, found.configurable];
    })()`)
    assert.equal(descriptor.ok, true, JSON.stringify(descriptor.error))
    assert.deepEqual(descriptor.value, ['function', 'get', 'function', 'set', true, true])
    target.value.dispose()
  } finally {
    harness.dispose()
  }
})

test('bridge.evalInGuest reports values and errors as plain objects', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge } = harness
    assert.deepEqual(bridge.evalInGuest('1 + 1', 'probe.js'), { ok: true, value: 2 })
    const failed = bridge.evalInGuest('missingIdentifiersAllTheWay()')
    assert.equal(failed.ok, false)
    assert.match(String(failed.error?.message ?? ''), /missingIdentifiersAllTheWay/)
  } finally {
    harness.dispose()
  }
})

test('bridge.deferred releases its host handles once the promise has settled', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const { bridge } = harness
    const resolved = bridge.deferred()
    resolved.resolve('payload')
    harness.jobs()
    // The bridge-level invariant: resolving does not throw and the promise is
    // reported as settled by fromGuest, without consuming it.
    assert.deepEqual(bridge.fromGuest(resolved.handle), { __type: 'promise', state: 'fulfilled' })
    // The host copy cannot be freed before the trampoline duplicates a returned
    // handle, so it is retired and released on the next bridge entry.
    assert.equal(resolved.handle.alive, true, 'a settled deferred keeps its handle for the current call')
    installProbe(harness, 'probeNextCall', bridge.fn('probeNextCall', 0, () => 1))
    assert.equal(harness.run('probeNextCall()').value, 1)
    assert.equal(resolved.handle.alive, false, 'the retired handle is released on the next call')

    const rejected = bridge.deferred()
    rejected.reject('why')
    harness.jobs()
    assert.deepEqual(bridge.fromGuest(rejected.handle), { __type: 'promise', state: 'rejected' })

    const disposed = bridge.deferred()
    disposed.dispose()
    // A second teardown pass must not throw even though the promise is gone.
    bridge.disposeAll()
    disposed.dispose.bind(disposed)
    assert.equal(harness.dispose().ok, true, 'an unsettled promise is released at teardown')
  } finally {
    harness.dispose()
  }
})

test('bridge teardown isolates throwing disposers behind the logger', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const warnings = []
    const bridge = createHostBridge({
      ctx: harness.ctx,
      runtime: harness.runtime,
      logger: { warn: (payload, message) => warnings.push({ payload, message }) },
    })
    const sample = harness.ctx.evalCode('1')
    assert.equal(bridge.adopt(sample.value, 'plain'), sample.value, 'a bridge without stealth returns the handle')
    sample.value.dispose()
    const order = []
    bridge.onDispose(() => order.push('first'))
    bridge.onDispose(() => {
      throw new Error('disposer boom')
    })
    bridge.onDispose(() => order.push('third'))
    bridge.disposeAll()

    assert.deepEqual(order, ['third', 'first'])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].payload.err, 'disposer boom')
    assert.equal(warnings[0].message, 'bridge disposer failed')
    assert.equal(bridge.stats.calls, 0)

    // A bridge without a trace recorder swallows emit() and still reports IOCs
    // through the same no-op path.
    assert.doesNotThrow(() => bridge.emit('api', 'before', { api: 'probe' }))
    assert.doesNotThrow(() => bridge.reportIOC('domain', 'c2.example.test'))

    // A trace sink that throws must never reach the guest.
    const hostile = createHostBridge({
      ctx: harness.ctx,
      runtime: harness.runtime,
      trace: { emit() { throw new Error('trace exploded') } },
    })
    assert.doesNotThrow(() => hostile.emit('api', 'before', { api: 'probe' }))
    assert.doesNotThrow(() => hostile.reportIOC('domain', 'c2.example.test'))
    hostile.disposeAll()
  } finally {
    harness.dispose()
  }
})

test('bridge.nativeConstructor rejects invalid generated source', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    const bridge = createHostBridge({ ctx: harness.ctx, runtime: harness.runtime })
    assert.throws(
      () => bridge.nativeConstructor({ name: 'Not-A-Name', arity: 0, body: '' }),
      /nativeConstructor Not-A-Name failed to compile/,
    )
    bridge.disposeAll()
  } finally {
    harness.dispose()
  }
})
