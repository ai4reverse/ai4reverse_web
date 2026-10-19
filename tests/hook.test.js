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
