import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as api from '../tools/index.js'
import * as logging from '../tools/logging/index.js'
import * as invocation from '../tools/invocation/index.js'
import * as util from '../tools/util/index.js'
import { ENV_MODULE_IDS, loadEnvModule } from '../tools/sandbox/env/index.js'
import * as trace from '../tools/instrumentation/trace.js'
import * as parseModule from '../tools/restore/parse.js'
import * as passes from '../tools/restore/passes/index.js'
import * as bridgeModule from '../tools/sandbox/bridge.js'
import * as errors from '../tools/util/errors.js'
import { createHarness } from './helpers/harness.js'
import { createHookBus } from '../tools/hook/index.js'
import { createLogger, createMemoryDestination } from '../tools/logging/logger.js'
import { restore, restoreWithPass } from '../tools/restore/index.js'

/**
 * Packaging and dead-surface contract (docs/EVALUATION-TOOLS.md D9, D10).
 *
 * Two things are pinned here:
 *  1. every `exports` subpath of package.json resolves to a module that
 *     actually loads, so a publisher cannot ship a broken map;
 *  2. the exports the review found dead stay dead, and the ones kept on
 *     purpose are exercised (D10: "used or documented as public with a test").
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('every exports subpath resolves to an importable module', async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  const entries = Object.entries(pkg.exports)
  assert.ok(entries.length >= 11, `expected the documented subpaths, saw ${entries.length}`)

  for (const [subpath, entry] of entries) {
    // D9.4 added declarations: each entry is now a conditions object whose
    // runtime target is the `import` condition (the `types` condition is a
    // `.d.ts` and is checked by tests/types.test.js).
    assert.equal(typeof entry, 'object', `exports["${subpath}"] must be a conditions object`)
    assert.equal(typeof entry.import, 'string', `exports["${subpath}"] must keep an import path`)
    const file = resolve(ROOT, entry.import)
    const loaded = await import(file)
    assert.ok(Object.keys(loaded).length > 0, `exports["${subpath}"] (${entry.import}) exports nothing`)
  }

  // The subpath name must match the file it points at, otherwise the map is a
  // roadmap to the wrong surface.
  assert.deepEqual(
    entries.filter(([subpath]) => subpath !== '.').map(([subpath]) => subpath),
    ['./sandbox', './instrumentation', './hook', './restore', './analysis', './jsvmp', './logging', './invocation', './util', './cli'],
  )
})

test('the published file set is whitelisted', async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  // `types` ships with the package: the declarations are the D9.4 contract.
  assert.deepEqual(pkg.files, ['tools', 'docs', 'types', 'README.md', 'LICENSE'])
  assert.equal(pkg.license, 'ISC')
  assert.match(pkg.author, /\S/)
  const licence = await readFile(resolve(ROOT, 'LICENSE'), 'utf8')
  assert.match(licence, /^ISC License\n/)
  assert.match(licence, /Permission to use, copy, modify/)
})

test('the subpath barrels re-export the modules they name', () => {
  assert.equal(typeof logging.createLogger, 'function')
  assert.equal(typeof logging.scopeLogger, 'function')
  assert.equal(typeof invocation.createInvoker, 'function')
  assert.equal(typeof invocation.createStealth, 'function')
  assert.equal(typeof util.createSeededRandom, 'function')
  assert.equal(typeof util.SandboxError, 'function')
  assert.equal(util.SandboxError, errors.SandboxError)
})

test('restoreCode stays the public convenience alias of restore', () => {
  const source = "var _0xabc = '\\x68\\x69'; console.log(_0xabc);"
  const direct = restore(source, { only: ['strings'], maxRounds: 1 })
  const alias = api.restoreCode(source, { only: ['strings'], maxRounds: 1 })
  assert.equal(alias.code, direct.code)
  assert.equal(alias.selection.length, 1)
  assert.equal(alias.outputValid, true)
  assert.equal(typeof restoreWithPass, 'function')
})

const PUBLIC_RUN_OPTIONS = {
  logLevel: 'silent',
  restore: false,
  instrumentation: { enabled: false },
}

for (const method of ['run', 'analyze']) {
  for (const outcome of [
    { label: 'successful execution', source: '21 * 2', ok: true },
    { label: 'a guest exception', source: 'throw new Error("public API guest failure")', ok: false },
  ]) {
    test(`root ${method} disposes its own sandbox after ${outcome.label}`, async (t) => {
      const dispose = t.mock.method(api.TracelessSandbox.prototype, 'dispose')

      const output = await api[method](outcome.source, PUBLIC_RUN_OPTIONS)
      const run = method === 'analyze' ? output.run : output

      assert.equal(run.ok, outcome.ok)
      if (outcome.ok) assert.equal(run.result.value, 42)
      else assert.equal(run.error.message, 'public API guest failure')
      assert.deepEqual(run.disposal, { ok: true, errors: [] })
      assert.equal(dispose.mock.callCount(), 1)
      assert.equal(dispose.mock.calls[0].this.disposed, true)
      if (method === 'analyze') {
        assert.equal(output.report.dynamic.ok, outcome.ok)
        assert.equal(output.report.dynamic.error, outcome.ok ? null : run.error.message)
        assert.ok(output.markdown.length > 0)
      }
    })
  }

  test(`root ${method} reports sandbox acquisition failure without disposing an unacquired resource`, async (t) => {
    const sentinel = new errors.SandboxError('public API acquisition failure', { code: 'SANDBOX_INIT' })
    const create = t.mock.method(api.TracelessSandbox, 'create', async () => { throw sentinel })
    const dispose = t.mock.method(api.TracelessSandbox.prototype, 'dispose')

    if (method === 'run') {
      await assert.rejects(() => api.run('42', PUBLIC_RUN_OPTIONS), (error) => error === sentinel)
    } else {
      const output = await api.analyze('42', PUBLIC_RUN_OPTIONS)
      assert.equal(output.run, null)
      assert.equal(output.report.dynamic.ok, false)
      assert.equal(output.report.dynamic.error, sentinel.message)
    }
    assert.equal(create.mock.callCount(), 1)
    assert.equal(dispose.mock.callCount(), 0)
  })

  test(`root ${method} cleans up its owned sandbox when run rejects`, async (t) => {
    const sentinel = new errors.SandboxError('public API host failure', { code: 'SANDBOX_RUN' })
    t.mock.method(api.TracelessSandbox.prototype, 'run', async () => { throw sentinel })
    const dispose = t.mock.method(api.TracelessSandbox.prototype, 'dispose')

    if (method === 'run') {
      await assert.rejects(() => api.run('42', PUBLIC_RUN_OPTIONS), (error) => error === sentinel)
    } else {
      const output = await api.analyze('42', PUBLIC_RUN_OPTIONS)
      assert.equal(output.run, null)
      assert.equal(output.report.dynamic.ok, false)
      assert.equal(output.report.dynamic.error, sentinel.message)
    }
    assert.equal(dispose.mock.callCount(), 1)
    assert.equal(dispose.mock.calls[0].this.disposed, true)
  })

  test(`root ${method} preserves a caller-owned sandbox after success and guest failure`, async (t) => {
    const sandbox = await api.TracelessSandbox.create(PUBLIC_RUN_OPTIONS)
    const dispose = t.mock.method(sandbox, 'dispose')
    try {
      const options = { ...PUBLIC_RUN_OPTIONS, sandbox }
      const success = await api[method]('6 * 7', options)
      const failure = await api[method]('throw new Error("caller guest failure")', options)
      const runs = method === 'analyze' ? [success.run, failure.run] : [success, failure]

      assert.equal(runs[0].result.value, 42)
      assert.equal(runs[1].ok, false)
      assert.equal(runs[1].error.message, 'caller guest failure')
      assert.equal(dispose.mock.callCount(), 0)
      assert.equal(sandbox.disposed, false)
      const recovered = await sandbox.run('7')
      assert.equal(recovered.result.value, 7)
      assert.deepEqual(recovered.disposal, { ok: true, errors: [] })
    } finally {
      sandbox.dispose()
    }
  })

  test(`root ${method} does not dispose a caller-owned sandbox when run rejects`, async (t) => {
    const sentinel = new errors.SandboxError('caller-owned run rejected')
    const sandbox = {
      run: t.mock.fn(async () => { throw sentinel }),
      dispose: t.mock.fn(),
    }
    const options = { ...PUBLIC_RUN_OPTIONS, sandbox }

    if (method === 'run') {
      await assert.rejects(() => api.run('42', options), (error) => error === sentinel)
    } else {
      const output = await api.analyze('42', options)
      assert.equal(output.run, null)
      assert.equal(output.report.dynamic.ok, false)
      assert.equal(output.report.dynamic.error, sentinel.message)
    }
    assert.equal(sandbox.run.mock.callCount(), 1)
    assert.equal(sandbox.run.mock.calls[0].arguments[0], '42')
    assert.equal(sandbox.dispose.mock.callCount(), 0)
  })
}

test('root analyze rejects absent source before creating a sandbox', async (t) => {
  const create = t.mock.method(api.TracelessSandbox, 'create')
  for (const source of [undefined, null, '']) {
    await assert.rejects(() => api.analyze(source), /requires a non-empty source string/)
  }
  assert.equal(create.mock.callCount(), 0)
})

test('root analyze static-only mode never runs or disposes a supplied sandbox', async (t) => {
  const sandbox = { run: t.mock.fn(), dispose: t.mock.fn() }
  const output = await api.analyze('21 * 2', { ...PUBLIC_RUN_OPTIONS, dynamic: false, sandbox })
  assert.equal(output.run, null)
  assert.equal(output.report.static.parse.ok, true)
  assert.equal(output.report.tracing.enabled, false)
  assert.equal(sandbox.run.mock.callCount(), 0)
  assert.equal(sandbox.dispose.mock.callCount(), 0)
})

test('scopeLogger is exported from the entry point and binds its scope', () => {
  assert.equal(typeof api.scopeLogger, 'function')
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'info', destination })
  const scoped = api.scopeLogger(logger, { runId: 'run-d10' })
  scoped.info({ marker: 7 }, 'scoped')
  const record = destination.records().at(-1)
  assert.equal(record.runId, 'run-d10')
  assert.equal(record.marker, 7)
  assert.equal(record.msg, 'scoped')
  assert.equal(typeof scoped.child({ phase: 'x' }).warn, 'function')
})

test('every error class that remains is thrown by a real path', () => {
  const sandboxError = new errors.SandboxError('boom')
  assert.ok(sandboxError instanceof errors.AnalyzerError)
  assert.ok(sandboxError instanceof Error)
  assert.equal(sandboxError.code, 'SANDBOX_ERROR')
  assert.equal(sandboxError.name, 'SandboxError')

  assert.throws(
    () => parseModule.parse('function ('),
    (error) => error instanceof errors.ParseError && error.code === 'PARSE_ERROR' && error.message.length > 0,
  )

  const bus = createHookBus({ strict: true, trace: trace.createTraceRecorder() })
  assert.throws(
    () => bus.emit('bogus:phase'),
    (error) => error instanceof errors.HookError && error.code === 'HOOK_ERROR',
  )

  assert.throws(
    () => api.buildVM(api.buildSampleProgram()).run({}),
    (error) => error instanceof errors.TrustError && error.code === 'TRUST_ERROR',
  )
})

test('the D10 dead surface is gone, not merely unused', async () => {
  // Modules: the exports the review listed are deleted.
  assert.equal('PASS_BY_ID' in passes, false)
  assert.equal('parseExpression' in parseModule, false)
  assert.equal('parseFirstSuccessful' in parseModule, false)
  assert.equal('summarizeValue' in trace, false)
  assert.equal('LimitationError' in errors, false)
  assert.equal('PassError' in errors, false)

  // The entry point never re-exported them, and must not start.
  for (const name of ['PASS_BY_ID', 'parseExpression', 'parseFirstSuccessful', 'summarizeValue']) {
    assert.equal(name in api, false, `tools/index.js must not export ${name}`)
  }

  // The bridge stub and the typo are gone; `fn` is still the way to make one.
  const harness = await createHarness()
  try {
    assert.equal('call' in harness.bridge, false)
    assert.equal(typeof harness.bridge.fn, 'function')
  } finally {
    harness.dispose()
  }
  assert.equal('adoptPrototype' in bridgeModule, false)
  assert.equal('nativeTextForFor' in bridgeModule, false)
})

test('TRACE_PHASES documents exactly the phases the platform emits', () => {
  const recorder = trace.createTraceRecorder({ strict: true })
  // Every declared phase is accepted; the trace budget test proves the
  // platform only emits these.
  for (const phase of trace.TRACE_PHASES) {
    const event = recorder.emit('api', phase, { api: 'probe' })
    assert.equal(event.phase, phase)
  }
  assert.throws(() => recorder.emit('api', 'bogus', {}), /unknown trace phase: bogus/)
  assert.throws(() => recorder.emit('bogus', 'emit', {}), /unknown trace kind: bogus/)
  // A rejected emit must not advance the sequence.
  assert.equal(recorder.seq, trace.TRACE_PHASES.length)
})

test('the environment module graph is ordered, closed and one-surface-per-module', async () => {
  // D11: ENV_MODULE_IDS and every meta.requires must describe the real
  // dependency graph. `installEnvironment` installs in `meta.order` order, so a
  // `requires` that names a later module fails in strict mode; the id list is
  // kept in that same order so a reader can see the graph.
  const orders = []
  const seen = new Set()
  for (const id of ENV_MODULE_IDS) {
    const entry = await loadEnvModule(id)
    assert.equal(entry.meta.id, id)
    assert.ok(entry.meta.order >= (orders.at(-1) ?? -Infinity), `${id} is out of install order`)
    orders.push(entry.meta.order)
    for (const requirement of entry.meta.requires ?? []) {
      assert.ok(seen.has(requirement), `${id} requires ${requirement}, which is not installed before it`)
      assert.ok(ENV_MODULE_IDS.includes(requirement), `${id} requires undeclared module ${requirement}`)
    }
    seen.add(id)
  }

  // The surfaces that used to hide inside misc.js are their own modules now,
  // and the support kit is not a module.
  for (const id of ['url', 'blob', 'navigator', 'misc']) assert.ok(ENV_MODULE_IDS.includes(id))
  assert.equal(ENV_MODULE_IDS.includes('platform-kit'), false)
  const misc = await loadEnvModule('misc')
  assert.deepEqual([...misc.meta.requires], ['globals', 'navigator'])
  const navigator = await loadEnvModule('navigator')
  assert.deepEqual([...navigator.meta.requires], ['globals', 'storage'])
})
