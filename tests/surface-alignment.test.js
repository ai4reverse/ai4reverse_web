import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../tools/analysis/orchestrator.js'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { createHookBus, registerHooks } from '../tools/hook/index.js'
import { createLogger, createMemoryDestination } from '../tools/logging/logger.js'

const CLI = fileURLToPath(new URL('../tools/cli.js', import.meta.url))

async function compareRestored(source, options = {}) {
  const result = await analyzeSample(source, { logLevel: 'silent', runRestored: true, level: 'off', ...options })
  assert.equal(result.restoration.changed, true, 'must exercise the restored execution')
  assert.equal(result.run.ok, true, JSON.stringify(result.run.error))
  assert.equal(result.restoredRun?.ok, true, JSON.stringify(result.restoredRun?.error))
  assert.equal(result.run.disposal.ok, true)
  assert.equal(result.restoredRun.disposal.ok, true)
  return result
}

test('M2 restored entry receives the same args, profile, seed and mocks', async () => {
  const result = await compareRestored(`function entry(value) {
    return JSON.stringify([value + (1 + 0), navigator.language, Math.random(), WebAssembly.validate(new Uint8Array([0]))]);
  }`, {
    entry: 'entry', args: [41], seed: 123,
    profile: { locale: 'en-US' }, mocks: [{ api: 'WebAssembly.validate', response: 'synthetic-mock' }],
  })
  assert.deepEqual(JSON.parse(result.run.result.preview).filter((_, index) => index !== 2), [42, 'en-US', 'synthetic-mock'])
  assert.deepEqual(result.restoredRun.result, result.run.result)
  assert.equal(result.report.dynamic.restored.result.preview, result.report.dynamic.result.preview)
})

test('M2 restored run respects the requested code level and keepTrace', async () => {
  const result = await compareRestored('function add(x) { return x + (1 + 0) } add(41)', { keepTrace: false })
  assert.equal(result.run.events, null)
  assert.equal(result.restoredRun.events, null)
  assert.deepEqual(result.restoredRun.result, result.run.result)
  assert.equal(result.restoredRun.traceStats.byKind.code ?? 0, result.run.traceStats.byKind.code ?? 0)
})

test('M2 restored settlement uses the same callback budget', async () => {
  const result = await compareRestored('setTimeout(function () { console.log(1 + 1) }, 10); 2 + 3', {
    settle: { maxTimerCallbacks: 0 },
  })
  assert.equal(result.run.settle.timerCallbacks, 0)
  assert.equal(result.restoredRun.settle.timerCallbacks, 0)
  assert.equal(result.restoredRun.settle.pendingTimers, result.run.settle.pendingTimers)
  assert.deepEqual(result.restoredRun.result, result.run.result)
})

test('M2 restored run preserves explicit module evaluation', async () => {
  const result = await compareRestored('var moduleMode = this === undefined; globalThis.entry = function () { return moduleMode }; var folded = 1 + 1;', {
    type: 'module', entry: 'entry',
  })
  assert.equal(result.run.result.value, true, 'top-level this must use module semantics')
  assert.deepEqual(result.restoredRun.result, result.run.result)
})

test('M3 an ordinary switch loop contributes no JSVMP report evidence', async () => {
  const result = await analyzeSample(`var total = 0;
    for (var i = 0; i < 10; i++) {
      switch (i % 5) {
        case 0: total += 1; break;
        case 1: total += 2; break;
        case 2: total += 3; break;
        case 3: total += 4; break;
        case 4: total += 5; break;
      }
    }
    total`, { logLevel: 'silent' })
  assert.equal(result.run.ok, true, JSON.stringify(result.run.error))
  assert.equal(result.run.result.value, 30)
  assert.equal(result.report.tracing.jsvmp.detected, false)
  assert.equal(result.report.verdict.reasons.some((reason) => reason.code === 'TRACING_JSVMP'), false)
  assert.equal(result.report.verdict.families.includes('obfuscation'), false)
  assert.equal(result.report.verdict.score, 0)
})

for (const field of ['apiKey', 'session', 'jwt', 'Authorization', 'authorization']) {
  test(`M7 default logger redacts ${field} at supported metadata depths`, () => {
    const destination = createMemoryDestination()
    const logger = createLogger({ pretty: false, destination })
    const value = `synthetic-${field}-sentinel`
    const payload = { [field]: value, headers: { [field]: value }, req: { headers: { [field]: value } }, safe: 'visible' }
    logger.info(payload, 'synthetic metadata')
    const [record] = destination.records()
    assert.equal(record[field], '[redacted]')
    assert.equal(record.headers[field], '[redacted]')
    assert.equal(record.req.headers[field], '[redacted]')
    assert.equal(record.safe, 'visible')
    assert.equal(destination.lines.join('').includes(value), false)
    assert.equal(payload[field], value, 'redaction must not change the caller payload')
  })
}

for (const shape of ['tuple', 'tuple-options', 'descriptor', 'set', 'nested']) {
  test(`M8 registerHooks accepts ${shape} registrations`, () => {
    const bus = createHookBus({ strict: true })
    let calls = 0
    const handler = () => { calls += 1 }
    const tuple = ['api:after', handler, { id: 'observed', once: true }]
    const registrations = {
      tuple: tuple.slice(0, 2),
      'tuple-options': tuple,
      descriptor: { phase: 'api:after', handler, id: 'observed', once: true },
      set: { registrations: [tuple] },
      nested: [[{ registrations: [[tuple]] }]],
    }[shape]
    const ids = registerHooks(bus, registrations)
    assert.equal(ids.length, 1)
    bus.emit('api:after')
    assert.equal(calls, 1)
    if (shape !== 'tuple') {
      assert.deepEqual(ids, ['observed'])
      bus.emit('api:after')
      assert.equal(calls, 1, 'tuple options must be retained')
    }
  })
}

test('M8 rejects malformed registration shapes consistently at every nesting depth', () => {
  const invalid = [
    false, 'api:after', { phase: 'api:after' },
    ['api:after', 'not-a-function'], ['api:after', () => {}, 42],
    ['api:after', () => {}, {}, 'extra'], { registrations: 42 },
    { registrations: null }, { registrations: undefined },
  ]
  for (const entry of invalid) {
    for (const registrations of [entry, [entry], { registrations: [entry] }]) {
      assert.throws(() => registerHooks(createHookBus(), registrations), { code: 'HOOK_ERROR' })
    }
  }
  assert.deepEqual(registerHooks(createHookBus(), undefined), [])
  assert.deepEqual(registerHooks(createHookBus(), null), [])
  assert.deepEqual(registerHooks(createHookBus(), [null, undefined]), [])
  assert.deepEqual(registerHooks(createHookBus(), []), [])
})

for (const phase of ['api:after', 'api:*', '*']) {
  test(`M11 hasListeners follows enabled ${phase} dispatch matching`, () => {
    const bus = createHookBus({ strict: true })
    assert.equal(bus.hasListeners('api:after'), false)
    bus.on(phase, () => {}, { id: 'observer', once: true })
    assert.equal(bus.hasListeners('api:after'), true)
    bus.setEnabled('observer', false)
    assert.equal(bus.hasListeners('api:after'), false)
    bus.setEnabled('observer', true)
    bus.emit('api:after')
    assert.equal(bus.hasListeners('api:after'), false)
    assert.throws(() => bus.hasListeners('unknown:phase'), { code: 'HOOK_ERROR' })
  })
}

for (const phase of ['api:*', '*']) {
  test(`M11 real API wrappers emit after events with only ${phase} listeners`, async () => {
    const seen = []
    const sandbox = await TracelessSandbox.create({
      logLevel: 'silent', defaultHooks: false,
      hooks: [{ phase, handler: (payload, context) => {
        if (payload.api === 'WebAssembly.validate') seen.push({ phase: context.phase, result: payload.result })
      } }],
    })
    try {
      const run = await sandbox.run("WebAssembly.validate(new Uint8Array([0]))", { level: 'off' })
      assert.equal(run.ok, true, JSON.stringify(run.error))
      assert.equal(run.disposal.ok, true)
      assert.equal(run.hooks.describe.some((hook) => hook.phase === 'api:after'), false)
      assert.deepEqual(seen.map((event) => event.phase), ['api:before', 'api:after'])
      assert.equal(seen[1].result, false)
    } finally {
      sandbox.dispose()
    }
  })
}

async function runCli(source, args) {
  const directory = await mkdtemp(join(tmpdir(), 'surface-cli-'))
  try {
    const file = join(directory, 'sample.js')
    await writeFile(file, source)
    return spawnSync(process.execPath, [CLI, 'run', file, '--json', '--level', 'off', ...args], { encoding: 'utf8', timeout: 30_000 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('M10 CLI run applies profile and mock options to guest execution', async () => {
  const result = await runCli("JSON.stringify([navigator.language, WebAssembly.validate(new Uint8Array([0]))])", [
    '--profile', '{"locale":"en-US"}', '--mocks', '[{"api":"WebAssembly.validate","response":"synthetic-mock"}]',
  ])
  assert.equal(result.status, 0, result.stderr)
  const run = JSON.parse(result.stdout)
  assert.deepEqual(JSON.parse(run.result.preview), ['en-US', 'synthetic-mock'])
  assert.equal(run.disposal.ok, true)
})

for (const option of ['profile', 'mocks']) {
  test(`M10 CLI run rejects invalid --${option} JSON with usage exit 2`, async () => {
    const result = await runCli('1 + 1', [`--${option}`, '{invalid'])
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`invalid JSON for --${option}`))
  })
}
