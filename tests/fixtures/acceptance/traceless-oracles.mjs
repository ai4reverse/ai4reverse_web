import { TracelessSandbox } from '../../../tools/index.js'

const sb = await TracelessSandbox.create({ logLevel: 'silent', limits: { timeoutMs: 15000 } })
try {
  const r = await sb.run(`
const out = {};
let stolen = null;
Object.assign(new Proxy({}, { set(t, k, v) { if (typeof k === 'symbol') stolen = k; return true } }), document);
out.stolenSymbolType = stolen === null ? 'none' : 'symbol';
out.stolenKey = stolen === null ? null : Symbol.keyFor(stolen);
out.channelType = stolen === null ? 'n/a' : typeof document[stolen];
out.channelDescriptor = stolen === null ? null : (function () {
  const d = Object.getOwnPropertyDescriptor(document, stolen);
  return d ? { enumerable: d.enumerable, configurable: d.configurable, writable: d.writable, valueType: typeof d.value } : null;
})();
// line drift: what line does a nested throw report?
function inner() {
  throw new Error('line-probe');
}
try { inner(); } catch (e) { out.reportedLine = (String(e.stack).match(/:(\d+):\d+/) || [])[1] || null; }
out.ownSymbols = Object.getOwnPropertySymbols(document).length;
JSON.stringify(out)
`, { level: 'statement' })
  console.log(JSON.stringify({ ok: r.ok, error: r.error, guest: r.result }, null, 2))

  const off = await sb.run(`
const out = {};
function inner() {
  throw new Error('line-probe');
}
try { inner(); } catch (e) { out.reportedLine = (String(e.stack).match(/:(\\d+):\\d+/) || [])[1] || null; }
out.now = performance.now();
JSON.stringify(out)
`, { level: 'off' })
  console.log(JSON.stringify({ levelOff: off.result }, null, 2))

  const on = await sb.run(`
const out = {};
for (let i = 0; i < 50; i++) { Math.max(i, 1) }
out.now = performance.now();
out.dateDelta = Date.now();
JSON.stringify(out)
`, { level: 'statement' })
  console.log(JSON.stringify({ levelStatement: on.result }, null, 2))
} finally {
  sb.dispose()
}
