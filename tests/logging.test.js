import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger, createMemoryDestination, createEventSink, scopeLogger, redactPaths } from '../tools/logging/logger.js'
import { createTraceRecorder } from '../tools/instrumentation/trace.js'

test('memory destination captures JSON log lines', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'debug', destination })
  logger.info({ marker: 1 }, 'hello')
  logger.debug('debug line')
  const records = destination.records()
  assert.equal(records.length, 2)
  assert.equal(records[0].msg, 'hello')
  assert.equal(records[0].marker, 1)
  assert.equal(records[0].level, 'info')
})

test('level filtering suppresses lower levels', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'warn', destination })
  logger.info('suppressed')
  logger.warn('kept')
  assert.deepEqual(destination.records().map((record) => record.msg), ['kept'])
})

test('sensitive fields are redacted', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'info', destination })
  logger.info({ cookie: 'session=abc', password: 'hunter2', nested: { token: 't' } }, 'auth')
  const record = destination.records()[0]
  assert.equal(record.cookie, '[redacted]')
  assert.equal(record.password, '[redacted]')
  assert.equal(record.nested.token, '[redacted]')
  assert.ok(redactPaths.includes('cookie'))
})

test('redacts canonical header spellings at every supported depth', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'info', destination })
  const headerNames = ['Set-Cookie', 'setCookie', 'set-cookie', 'x-api-key', 'X-Api-Key', 'Proxy-Authorization']
  const headers = Object.fromEntries(headerNames.map((name) => [name, `value-of-${name}`]))
  logger.info({
    headers,
    nested: { headers: { 'Set-Cookie': 'nested-cookie', 'X-Api-Key': 'nested-key' } },
  }, 'headers')
  const record = destination.records()[0]
  for (const name of headerNames) {
    assert.equal(record.headers[name], '[redacted]', `top-level headers.${name}`)
  }
  assert.equal(record.nested.headers['Set-Cookie'], '[redacted]', 'nested Set-Cookie')
  assert.equal(record.nested.headers['X-Api-Key'], '[redacted]', 'nested X-Api-Key')
})

test('redacts snake_case credential fields at every supported depth', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'info', destination })
  const credentialNames = ['access_token', 'refresh_token', 'api_key', 'credential', 'credentials']
  const topLevel = Object.fromEntries(credentialNames.map((name) => [name, `value-of-${name}`]))
  const nested = Object.fromEntries(credentialNames.map((name) => [name, `nested-${name}`]))
  const deep = Object.fromEntries(credentialNames.map((name) => [name, `deep-${name}`]))
  logger.info({ ...topLevel, nested, deep: { deepest: deep } }, 'credentials')
  const record = destination.records()[0]
  for (const name of credentialNames) {
    assert.equal(record[name], '[redacted]', `top-level ${name}`)
    assert.equal(record.nested[name], '[redacted]', `nested ${name}`)
    assert.equal(record.deep.deepest[name], '[redacted]', `deep ${name}`)
  }
})

test('event sink writes greppable trace messages and counts kinds', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'trace', destination })
  const sink = createEventSink({ logger, level: 'trace' })
  const trace = createTraceRecorder({ sink })
  trace.emit('api', 'before', { api: 'fetch' })
  trace.emit('code', 'step', { event: 'statement' })
  const messages = destination.records().map((record) => record.msg)
  assert.ok(messages.includes('trace.api.before'), messages.join(','))
  assert.ok(messages.includes('trace.code.step'), messages.join(','))
  assert.deepEqual(sink.counts(), { api: 1, code: 1 })
})

test('scoped child logger carries run bindings', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'info', destination })
  const scoped = scopeLogger(logger, { runId: 'run-1' })
  scoped.info('started')
  const record = destination.records()[0]
  assert.equal(record.runId, 'run-1')
  assert.equal(record.msg, 'started')
})

test('logger never throws on unserialisable or circular payloads', () => {
  const destination = createMemoryDestination()
  const logger = createLogger({ level: 'info', destination })
  const circular = { name: 'x' }
  circular.self = circular
  assert.doesNotThrow(() => logger.info({ circular }, 'circular'))
  assert.equal(destination.records().length, 1)
})
