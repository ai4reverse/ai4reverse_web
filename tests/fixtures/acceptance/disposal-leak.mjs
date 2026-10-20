import { TracelessSandbox } from '../../../tools/index.js'
const sb = await TracelessSandbox.create({ limits: { timeoutMs: 15000 } })
const r = await sb.run(`
  const img = new Image();
  img.addEventListener('load', function () {});
  img.addEventListener('error', function () {});
  'listener-attached'
`)
console.log(JSON.stringify({ ok: r.ok, result: r.result, disposal: r.disposal, limitsHit: r.limitsHit, stack: r.stackExhaustion }))
sb.dispose()
