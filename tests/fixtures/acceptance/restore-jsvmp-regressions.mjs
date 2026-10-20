import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TracelessSandbox } from '../../../tools/index.js'
import { analyzeVM } from '../../../tools/jsvmp/analyze.js'
import { restore } from '../../../tools/restore/index.js'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const out = {}

// 1. insertion budget splitting a paired splice
{
  const sb = await TracelessSandbox.create({ logLevel: 'silent' })
  try {
    const r = await sb.run(`throw new Error('x')`, { level: 'statement', instrumentation: { code: { maxInsertions: 6 } } })
    out.budget = {
      ok: r.ok,
      limitsHit: r.limitsHit,
      error: r.error,
      truncatedFlag: r.instrumentation?.stats?.['budgetExceeded'] ?? r.instrumentation?.stats ?? null,
      tracing: r.traceStats,
    }
  } finally {
    sb.dispose()
  }
}

// 2. `throw a, b` sequence argument
{
  const sb = await TracelessSandbox.create({ logLevel: 'silent' })
  try {
    const src = `var a = 1, b = 2; var c; try { throw a, b } catch (e) { c = e } c`
    const off = await sb.run(src, { level: 'off' })
    const on = await sb.run(src, { level: 'statement' })
    out.sequenceThrow = { off: off.result, on: on.result, onOk: on.ok, onError: on.error }
  } finally {
    sb.dispose()
  }
}

// 3. level off with a JSVMP sample: trace must be frozen
{
  const src = readFileSync(`${repo}/examples/jsvmp-sample.js`, 'utf8')
  const sb = await TracelessSandbox.create({ logLevel: 'silent' })
  try {
    const r = await sb.run(src, { level: 'off' })
    const steps = (r.events ?? []).filter((e) => e.kind === 'code').length
    out.levelOffJsvmp = { ok: r.ok, virtualMs: r.virtualMs, codeEvents: steps, vm: r.vm?.detected ?? r.vm ?? null }
  } finally {
    sb.dispose()
  }
}

// 4. JSVMP false positive on ordinary loop+switch+array
{
  const src = `
function ordinary(rows) {
  var out = [];
  var index = 0;
  while (rows.length) {
    switch (rows[0]) {
      case 1: out.push(1); break
      case 2: out.push(2); break
      default: rows.shift()
    }
    index++;
  }
  return out;
}
ordinary([1,2,3])
`
  let analysis
  try {
    analysis = analyzeVM(src)
  } catch (e) {
    analysis = { threw: String(e && e.message) }
  }
  out.jsvmpFalsePositive = {
    detected: analysis.detected,
    kind: analysis.kind,
    score: analysis.score ?? analysis.confidence ?? null,
    keys: Object.keys(analysis),
  }
}

// 5. string-array: array read only through a global alias
{
  const src = `var _0xa = ['alpha','bravo','charlie','delta']; window.log(window._0xa[0]);`
  const r = restore(src, { only: ['string-array'], maxRounds: 1 })
  out.stringArrayWindow = { input: src, output: r.code, passes: (r.passes ?? []).map((p) => ({ id: p.id, changed: p.changed, error: p.error ? String(p.error.message ?? p.error) : null })) }
}

// 6. dead-code bigint truthiness
{
  for (const src of [`if (0n) { live() } else { dead() }`, `if (1n) { live() } else { dead() }`]) {
    const r = restore(src, { only: ['dead-code'], maxRounds: 1 })
    out[`bigint:${src}`] = { output: r.code, passes: (r.passes ?? []).map((p) => ({ id: p.id, changed: p.changed, error: p.error ? String(p.error.message ?? p.error) : null })) }
  }
}

console.log(JSON.stringify(out, null, 2))
