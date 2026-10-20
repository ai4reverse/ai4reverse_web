import test from 'node:test'
import assert from 'node:assert/strict'
import { createHookBus } from '../tools/hook/hookbus.js'
import { createDefaultHooks, registerHooks } from '../tools/hook/index.js'
import { createTraceRecorder } from '../tools/instrumentation/trace.js'

test('hooks run in priority order and support once/off', async () => {
  const bus = createHookBus()
  const order = []
  bus.on('code:before', () => order.push('low'), { priority: 1 })
  bus.on('code:before', () => order.push('high'), { priority: 10 })
  bus.on('code:before', () => order.push('once'), { priority: 5, once: true, id: 'once' })
  bus.emit('code:before', {})
  bus.emit('code:before', {})
  assert.deepEqual(order, ['high', 'once', 'low', 'high', 'low'])
})

test('pipeline transforms source and records which hooks changed it', async () => {
  const bus = createHookBus()
  bus.on('code:before', (source) => `${source}\n// appended`, { id: 'append' })
  bus.on('code:before', (source) => (source.includes('forbidden') ? source.replace('forbidden', 'allowed') : undefined), { id: 'replace' })
  const result = bus.pipeline('code:before', 'var forbidden = 1')
  assert.equal(result.changed, true)
  assert.match(result.value, /var allowed = 1/)
  assert.match(result.value, /\/\/ appended/)
  assert.deepEqual(result.steps.map((step) => step.id).sort(), ['append', 'replace'])
})

test('dispatch supports block, replace-args, stop and false', async () => {
  const bus = createHookBus()
  bus.on('api:before', (payload) => (payload.api === 'fetch' ? { block: { ok: false } } : undefined), { priority: 10 })
  bus.on('api:before', (payload) => (payload.api === 'localStorage.setItem' ? { args: ['k', 'v2'] } : undefined), { priority: 10 })
  bus.on('api:before', (payload) => (payload.api === 'window.alert' ? false : undefined), { priority: 5 })

  const blocked = bus.dispatch('api:before', { api: 'fetch' })
  assert.equal(blocked.blocked, true)
  assert.deepEqual(blocked.value, { ok: false })

  const rewritten = bus.dispatch('api:before', { api: 'localStorage.setItem' })
  assert.deepEqual(rewritten.args, ['k', 'v2'])

  const stopped = bus.dispatch('api:before', { api: 'window.alert' })
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.blocked, false)
})

test('hook failures are isolated and reported', async () => {
  const bus = createHookBus({ logger: { warn() {} } })
  let ran = false
  bus.on('api:before', () => {
    throw new Error('broken hook')
  }, { id: 'broken', priority: 100 })
  bus.on('api:before', () => {
    ran = true
  }, { id: 'healthy', priority: 1 })
  bus.dispatch('api:before', { api: 'x' })
  assert.equal(ran, true)
  const stats = bus.stats()
  assert.equal(stats.errors.length, 1)
  assert.equal(stats.errors[0].hook, 'broken')
})

test('describe exposes traceless declarations for auditing', () => {
  const bus = createHookBus()
  bus.on('api:before', () => undefined, {
    id: 'declared',
    owner: 'tests',
    traceless: { addsGlobals: false, preservesIdentity: true, preservesStack: true, consistentAnswers: true },
  })
  const described = bus.describe()
  assert.equal(described.length, 1)
  assert.equal(described[0].owner, 'tests')
  assert.equal(described[0].traceless.preservesIdentity, true)
})

test('default hooks suppress dialogs and popups tracelessly', async () => {
  const trace = createTraceRecorder()
  const defaults = createDefaultHooks({ trace })
  const bus = createHookBus({ trace })
  registerHooks(bus, defaults.registrations)

  assert.deepEqual(bus.dispatch('api:before', { api: 'window.alert', args: ['hi'] }).value, undefined)
  assert.equal(bus.dispatch('api:before', { api: 'window.confirm' }).value, false)
  assert.equal(bus.dispatch('api:before', { api: 'window.prompt' }).value, null)
  assert.equal(bus.dispatch('api:before', { api: 'window.open', args: ['https://popup.test'] }).value, null)
  const fired = defaults.api.fired.map((entry) => entry.api)
  assert.ok(fired.includes('window.alert'))
  assert.ok(fired.includes('window.open'))
  assert.ok(trace.events.some((event) => event.kind === 'api' && event.mock === true))
})

test('code hooks detect anti-analysis patterns without rewriting source', async () => {
  const trace = createTraceRecorder()
  const defaults = createDefaultHooks({ trace })
  const bus = createHookBus({ trace })
  registerHooks(bus, defaults.registrations)
  const source = 'debugger; if (navigator.webdriver) { throw new Error("bot") }'
  const result = bus.pipeline('code:before', source)
  assert.equal(result.value, source)
  assert.equal(result.changed, false)
  const patterns = trace.events.filter((event) => event.event === 'suspicious-pattern').map((event) => event.rule)
  assert.ok(patterns.includes('debugger-statement'), JSON.stringify(patterns))
  assert.ok(patterns.includes('webdriver-check'), JSON.stringify(patterns))
})

test('exception hooks fire on uncaught errors', async () => {
  const trace = createTraceRecorder()
  const seen = []
  const defaults = createDefaultHooks({ trace, onUncaught: (payload) => seen.push(payload.origin) })
  const bus = createHookBus({ trace })
  registerHooks(bus, defaults.registrations)
  bus.emit('exception:uncaught', { origin: 'eval', error: { name: 'Error', message: 'boom' } })
  assert.deepEqual(seen, ['eval'])
  assert.ok(trace.events.some((event) => event.kind === 'exception' && event.event === 'uncaught'))
})

test('unknown phases are rejected in strict mode', () => {
  const bus = createHookBus({ strict: true })
  assert.throws(() => bus.on('nonsense', () => {}), /domain:event/)
  assert.throws(() => bus.on('not-a-phase', () => {}), /domain:event/)
})

test('the global wildcard phase is registrable and receives every event', () => {
  const bus = createHookBus()
  const seen = []
  assert.doesNotThrow(() => bus.on('*', (payload, context) => seen.push(context.phase)))
  bus.dispatch('api:before', { api: 'x' })
  bus.emit('exception:uncaught', { origin: 'eval' })
  assert.deepEqual(seen, ['api:before', 'exception:uncaught'])
})

test('wildcard phases receive every event in their domain', () => {
  const bus = createHookBus()
  const phases = []
  bus.on('api:*', (payload, context) => phases.push(context.phase))
  bus.dispatch('api:before', { api: 'x' })
  bus.emit('api:after', { api: 'x' })
  assert.deepEqual(phases, ['api:before', 'api:after'])
})

test('AST hooks count calls, members and interesting identifiers', async () => {
  const { analyzeSource } = await import('../tools/instrumentation/ast.js')
  const { createAstHooks, astHookStats } = await import('../tools/hook/ast-hook.js')
  const trace = createTraceRecorder()
  const bus = createHookBus({ trace })
  const astHooks = createAstHooks({ trace })
  registerHooks(bus, astHooks)
  const analysis = analyzeSource('document.cookie = "x"; eval("1+1"); fetch("/api")', {
    hooks: bus,
    trace,
  })
  assert.equal(analysis.ok, true)
  const stats = astHookStats(astHooks.state)
  assert.ok(stats.nodes > 5)
  assert.equal(stats.truncated, false)
  assert.ok(stats.callSites >= 2)
  assert.ok(stats.memberExpressions >= 1)
  assert.ok(stats.apiIdentifiers.eval >= 1)
  assert.ok(stats.apiIdentifiers.fetch >= 1)
})

// ---- lifecycle and introspection -----------------------------------------

test('off/clear/setEnabled/has keep the registry observable', () => {
  const bus = createHookBus()
  const removed = bus.on('api:before', () => undefined, { id: 'first', owner: 'alpha' })
  bus.on('api:before', () => undefined, { id: 'second', owner: 'beta' })
  bus.on('code:before', () => undefined, { id: 'third', owner: 'alpha' })

  assert.equal(bus.has('api:before'), true)
  assert.equal(bus.has('api:after'), false, 'an unregistered phase has no hooks')
  assert.equal(bus.off('missing-id'), false, 'off() reports an unknown id')
  assert.equal(removed(), true)
  assert.equal(bus.has('api:before'), true, 'the second hook still listens')
  assert.equal(bus.off('second'), true)
  assert.equal(bus.has('api:before'), false, 'the phase is gone once its last hook is removed')

  bus.on('api:before', () => undefined, { id: 'fourth', owner: 'beta' })
  bus.clear('alpha')
  assert.deepEqual(bus.stats().byPhase, Object.fromEntries([['api:before', 1]]))
  assert.deepEqual(bus.describe().map((entry) => entry.id), ['fourth'])

  bus.clear()
  assert.deepEqual(bus.stats().byPhase, {})
  assert.deepEqual(bus.describe(), [])
})

test('setEnabled disables a hook without unregistering it', () => {
  const bus = createHookBus()
  let calls = 0
  bus.on('api:before', () => {
    calls += 1
    return { block: 'muted' }
  }, { id: 'toggle', priority: 5 })

  assert.equal(bus.setEnabled('toggle', false), true)
  assert.equal(bus.has('api:before'), false, 'a disabled hook is not a listener')
  const muted = bus.dispatch('api:before', { api: 'fetch' })
  assert.equal(muted.blocked, false, 'a disabled hook never runs')
  assert.equal(calls, 0)
  assert.equal(bus.describe()[0].enabled, false, 'describe still reports the registration')

  assert.equal(bus.setEnabled('toggle', true), true)
  const live = bus.dispatch('api:before', { api: 'fetch' })
  assert.equal(live.blocked, true)
  assert.equal(calls, 1)
  assert.equal(bus.setEnabled('nope', false), false, 'an unknown id cannot be toggled')
})

test('wildcard registrations answer has() for their domain and the global bus', () => {
  const bus = createHookBus()
  bus.on('api:*', () => undefined, { id: 'domain' })
  bus.on('*', () => undefined, { id: 'global' })
  assert.equal(bus.has('api:after'), true)
  assert.equal(bus.has('exception:uncaught'), true, 'the global wildcard matches every phase')
  assert.deepEqual(bus.stats().byPhase, { 'api:*': 1, '*': 1 })
})

test('pipeline rejects phases that are not transforms', () => {
  const bus = createHookBus()
  assert.throws(() => bus.pipeline('api:after', 'x'), (error) => {
    assert.equal(error.name, 'HookError')
    assert.match(error.message, /not a transform phase/)
    assert.deepEqual(error.details.mutating.sort(), ['api:before', 'ast:node', 'ast:transform', 'code:before'])
    return true
  })
  assert.throws(() => bus.pipeline('exception:uncaught', 'x'), /not a transform phase/)
  assert.doesNotThrow(() => bus.pipeline('api:before', 'x'))
})

test('pipeline accepts domain wildcards and honours stop', () => {
  const bus = createHookBus()
  const seen = []
  bus.on('code:*', (source) => {
    seen.push(source)
    return `${source}/*first*/`
  }, { id: 'wild-1', priority: 10 })
  bus.on('code:before', (source) => ({ stop: true, source }), { id: 'stopper', priority: 5 })
  bus.on('code:before', () => assert.fail('the stop must end the pipeline'), { id: 'never', priority: 1 })

  const result = bus.pipeline('code:before', 'var x = 1')
  assert.equal(result.changed, true)
  assert.deepEqual(seen, ['var x = 1'])
  assert.deepEqual(result.steps.map((step) => step.id), ['wild-1', 'stopper'])
  assert.equal(result.value.stop, true)
})

test('pipeline records no-change steps, once removal and failures', () => {
  const logger = { warnings: [], warn(payload) { this.warnings.push(payload) } }
  const bus = createHookBus({ logger, record: false })
  bus.on('ast:transform', () => undefined, { id: 'noop' })
  bus.on('ast:transform', () => {
    throw new Error('transform exploded')
  }, { id: 'explodes' })
  bus.on('ast:transform', (value) => value, { id: 'same-value', once: true })

  const result = bus.pipeline('ast:transform', 'unchanged')
  assert.equal(result.value, 'unchanged')
  assert.equal(result.changed, false)
  assert.deepEqual(result.steps.map((step) => step.changed), [false, true])
  assert.deepEqual(bus.describe().map((entry) => entry.id), ['noop', 'explodes'], 'the once hook is gone')
  assert.equal(bus.stats().dispatches, 1)

  const stats = bus.stats()
  assert.equal(stats.errors.length, 1)
  assert.equal(stats.errors[0].message, 'transform exploded')
  assert.equal(stats.errors[0].phase, 'ast:transform')
  assert.equal(logger.warnings.length, 1)
  assert.equal(logger.warnings[0].hook.phase, 'ast:transform')
})

test('emit stops at a handler that returns stop and honours once', () => {
  const bus = createHookBus({ record: false })
  const order = []
  bus.on('lifecycle:run', () => ({ stop: true }), { id: 'stopper', priority: 10, once: true })
  bus.on('lifecycle:run', () => order.push('after'), { id: 'after', priority: 1 })

  const first = bus.emit('lifecycle:run', { run: 1 })
  assert.deepEqual(first.results.map((entry) => entry.id), ['stopper'])
  assert.deepEqual(order, [], 'stop prevents the lower-priority handler')
  bus.emit('lifecycle:run', { run: 2 })
  assert.deepEqual(order, ['after'], 'the once handler fired only once')
})

test('trace recording follows record/recordPhases/phase policy', () => {
  const makeTrace = () => createTraceRecorder()

  const silenced = makeTrace()
  const quiet = createHookBus({ trace: silenced, record: false })
  quiet.on('api:before', () => undefined)
  quiet.emit('api:before', { api: 'x' })
  quiet.dispatch('api:before', { api: 'x' })
  assert.equal(silenced.events.length, 0, 'record:false writes no hook events')

  const allowListed = makeTrace()
  const allowBus = createHookBus({ trace: allowListed, recordPhases: ['ast:'] })
  allowBus.on('ast:node', () => undefined)
  allowBus.on('api:before', () => undefined)
  allowBus.emit('ast:node', {})
  allowBus.emit('api:before', { api: 'x' })
  // The trace phase is the transport (`emit`), which is one of the declared
  // TRACE_PHASES; the hook phase travels in `hook`. Forwarding the hook
  // sub-phase used to break a strict recorder on `lifecycle:run`.
  assert.deepEqual(
    allowListed.events.map((event) => ({ phase: event.phase, hook: event.hook })),
    [{ phase: 'emit', hook: 'ast:node' }],
    'only the allow-listed prefix is recorded',
  )

  const defaultTrace = makeTrace()
  const bus = createHookBus({ trace: defaultTrace })
  bus.on('jsvmp:step', () => undefined)
  bus.on('lifecycle:run', () => undefined)
  bus.emit('jsvmp:step', {})
  bus.emit('lifecycle:run', {})
  assert.equal(defaultTrace.events.length, 1, 'jsvmp phases stay out of the trace')
  assert.equal(defaultTrace.events[0].kind, 'hook')
})

test('registerHooks accepts tuple and list shapes instead of dropping them', () => {
  // F6: `[['code:after', fn]]` (a natural guess) used to register nothing, so a
  // hook meant to block a behaviour never ran and only an odd count hinted at
  // it.
  const bus = createHookBus({ record: false })
  const seen = []
  const ids = registerHooks(bus, [
    ['code:after', (source) => seen.push(source)],
    ['code:before', (source) => source, { id: 'before', priority: 5 }],
    [['api:after', () => seen.push('nested')]],
    { phase: 'exception:uncaught', handler: () => seen.push('object'), id: 'object' },
  ])
  assert.deepEqual(ids, ['anonymous', 'before', 'anonymous', 'object'])
  assert.equal(bus.describe().length, 4)
  assert.deepEqual(
    bus.describe().map((entry) => entry.phase).sort(),
    ['api:after', 'code:after', 'code:before', 'exception:uncaught'],
  )
  bus.emit('code:after', 'src')
  bus.emit('api:after', { api: 'x' })
  bus.emit('exception:uncaught', { error: 'x' })
  assert.deepEqual(seen, ['src', 'nested', 'object'])
  assert.equal(bus.describe().find((entry) => entry.id === 'before').priority, 5)
})

test('registerHooks rejects a malformed registration instead of skipping it', () => {
  const bus = createHookBus({ record: false })
  const cases = [
    [['code:after', 'not a function'], /hook tuple must be \[phase, handler/],
    [[['code:after']], /must be an object or a \[phase, handler\] tuple/],
    [{ phase: 'code:after' }, /has no handler function/],
    [{ handler: () => undefined }, /has no phase/],
    ['code:after', /must be an object or a \[phase, handler\] tuple/],
    [{ phase: 'code:after', handler: () => undefined }, /unknown hook phase/, { strict: true, phase: 'bogus:phase' }],
  ]
  for (const [registration, message, options] of cases) {
    const target = options ? createHookBus({ record: false, strict: options.strict }) : bus
    const entry = options ? { phase: options.phase, handler: () => undefined } : registration
    assert.throws(
      () => registerHooks(target, [entry]),
      (error) => {
        assert.equal(error.name, 'HookError')
        assert.equal(error.code, 'HOOK_ERROR')
        assert.match(error.message, message)
        return true
      },
      JSON.stringify(entry),
    )
  }
  // A strict bus still validates the phase it is given, and nothing was
  // registered by the failed calls.
  assert.equal(bus.describe().length, 0)
  // Absent/empty lists are not errors.
  assert.deepEqual(registerHooks(bus, undefined), [])
  assert.deepEqual(registerHooks(bus, []), [])
})
