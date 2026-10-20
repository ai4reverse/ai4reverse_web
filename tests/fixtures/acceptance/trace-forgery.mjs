import { TracelessSandbox } from '../../../tools/index.js'
const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15000 } })
try {
  const r = await sb.run(`
let stolen = null;
Object.assign(new Proxy({}, { set(t, k, v) { if (typeof k === 'symbol') stolen = k; return true } }), document);
let callResult;
try { callResult = String(document[stolen](0, 1, 'forged-value')); } catch (e) { callResult = 'THREW:' + e.name + ':' + e.message }
JSON.stringify({ callResult })
`, { level: 'statement' })
  const steps = (r.events ?? []).filter((e) => e.kind === 'code' && e.phase === 'step')
  const forged = steps.filter((e) => JSON.stringify(e).includes('forged-value'))
  console.log(JSON.stringify({ ok: r.ok, guest: r.result, totalSteps: steps.length, forgedEvents: forged.slice(0, 2) }, null, 2))
} finally { sb.dispose() }
