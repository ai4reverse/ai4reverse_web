import { createHookBus } from '../../../tools/hook/hookbus.js'
import { createTraceRecorder } from '../../../tools/instrumentation/trace.js'

const out = {}

// 1. wildcard phase double-match
{
  const bus = createHookBus({})
  let calls = 0
  bus.on('code:*', (s) => { calls += 1; return s + '/*x*/' })
  const res = bus.pipeline('code:*', 'a')
  out.wildcard = { value: res.value, steps: res.steps?.length, calls }
}

// 2. once + throwing handler
{
  const bus = createHookBus({})
  let ran = 0
  bus.on('api:before', () => { ran += 1; throw new Error('boom') }, { once: true })
  bus.dispatch('api:before', {})
  bus.dispatch('api:before', {})
  out.onceThrow = { ran, errors: bus.stats().errors.length, described: bus.describe().length }
}

// 3. throwing logger
{
  const bus = createHookBus({ logger: { warn() { throw new Error('log-boom') } } })
  bus.on('api:before', () => { throw new Error('handler-boom') })
  try {
    bus.dispatch('api:before', {})
    out.throwingLogger = { threw: false }
  } catch (e) {
    out.throwingLogger = { threw: true, message: String(e && e.message) }
  }
}

// 4. grandchild trace kind
{
  const tr = createTraceRecorder({})
  try {
    const ev = tr.child('hook').child('net').emit('emit', { a: 1 })
    out.grandchild = { threw: false, kind: ev && ev.kind }
  } catch (e) {
    out.grandchild = { threw: true, message: String(e && e.message) }
  }
}

console.log(JSON.stringify(out, null, 2))
