import { TracelessSandbox } from '../../../tools/index.js'
for (const n of [1,2,3,4,5,6,8,10,12]) {
  const sb = await TracelessSandbox.create({ logLevel: 'silent' })
  try {
    const r = await sb.run(`function f(){ throw new Error('x') } f()`, { level: 'statement', instrumentation: { code: { maxInsertions: n } } })
    const steps = (r.events ?? []).filter((e) => e.kind === 'code' && e.phase === 'step').length
    const syn = (r.events ?? []).filter((e) => String(e.event ?? '').includes('budget') || String(e.message ?? '').includes('SyntaxError'))
    console.log(JSON.stringify({ n, ok: r.ok, errorName: r.error?.name, errorMsg: (r.error?.message ?? '').slice(0, 80), steps, budgetEvents: syn.map((e) => e.event) }))
  } finally { sb.dispose() }
}
