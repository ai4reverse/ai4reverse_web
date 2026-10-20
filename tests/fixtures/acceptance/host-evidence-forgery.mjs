import { TracelessSandbox } from '../../../tools/index.js'
const sb = await TracelessSandbox.create({ limits: { timeoutMs: 15000 } })
const r = await sb.run(`
  const c = new AbortController();
  c.abort({ name: 'RangeError', message: 'Maximum call stack size exceeded' });
  try { c.signal.throwIfAborted(); } catch (e) { /* swallow */ }
  42
`)
console.log(JSON.stringify({
  ok: r.ok,
  result: r.result,
  disposal: r.disposal,
  limitsHit: r.limitsHit,
  stackExhaustion: r.stackExhaustion,
  error: r.error,
}))
sb.dispose()
