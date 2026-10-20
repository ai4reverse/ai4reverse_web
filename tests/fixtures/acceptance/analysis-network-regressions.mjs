import { extractIOCs } from '../../../tools/analysis/ioc.js'
import { buildReport, renderMarkdown } from '../../../tools/analysis/report.js'
import { TracelessSandbox } from '../../../tools/index.js'

const out = {}

// 1. global candidate budget starvation
{
  const filler = Array.from({ length: 2100 }, (_, i) => `host${i}.com`).join(' ')
  const btc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
  const iocs = extractIOCs(`${filler} ${btc}`)
  const clean = extractIOCs(`hello ${btc}`)
  out.budgetStarvation = {
    walletsWithFiller: iocs.wallets?.length ?? null,
    walletsClean: clean.wallets?.length ?? null,
    meta: iocs.meta ?? null,
  }
}

// 2. markdown injection through dynamic result preview
{
  const report = buildReport({
    meta: { runId: 'x', startedAt: new Date(0).toISOString(), durationMs: 1, seed: 1 },
    sample: { name: 's.js', size: 10, sha256: 'x', sourceUrl: null, sourceType: 'script', truncated: false },
    static: {},
    dynamic: {
      ok: true,
      result: { type: 'string', value: '![x](https://attacker.example/t)', preview: '![x](https://attacker.example/t)' },
      events: [],
      counts: { byKind: {}, total: 0 },
      behavior: {},
    },
    tracing: {},
    hooks: {},
    artifacts: {},
    integrity: { intact: true, drift: [] },
    recommendations: [],
  })
  const md = renderMarkdown(report)
  out.markdownInjection = {
    containsRawImage: md.includes('![x](https://attacker.example/t)'),
    line: md.split('\n').find((l) => l.includes('attacker.example')) ?? null,
  }
}

// 3. timer cap refusal during a fetch dispatch
{
  const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { maxTimers: 1, timeoutMs: 5000 } })
  try {
    const r = await sb.run(`
      setTimeout(function () {}, 1000);
      fetch('https://c2.example/x').then(function () {}, function () {});
      1
    `)
    out.timerCapFetch = {
      ok: r.ok,
      limitsHit: r.limitsHit,
      net: (r.events ?? []).filter((e) => e.kind === 'net').length,
      ioc: (r.events ?? []).filter((e) => e.kind === 'ioc').length,
      droppedTimers: r.clock?.droppedTimers ?? null,
      clockStats: r.clock ?? null,
      settle: r.settle ?? null,
    }
  } finally {
    sb.dispose()
  }
}

console.log(JSON.stringify(out, null, 2))
