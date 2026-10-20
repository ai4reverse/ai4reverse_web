import { createHarness } from '../../helpers/harness.js'
import { ENV_MODULE_IDS } from '../../../tools/sandbox/env/index.js'

const h = await createHarness({ modules: ENV_MODULE_IDS, limits: { timeoutMs: 10000 } })

const sync = h.run(`
const out = {};
const dv = new DataView(new ArrayBuffer(8));
crypto.getRandomValues(dv);
out.dataViewAllZero = Array.from(new Uint8Array(dv.buffer)).every(function (b) { return b === 0 });
out.dataViewBytes = Array.from(new Uint8Array(dv.buffer));
const u32 = new Uint32Array(4);
crypto.getRandomValues(u32);
out.u32 = Array.from(u32);
const u8 = new Uint8Array(8);
crypto.getRandomValues(u8);
out.u8 = Array.from(u8);
try { crypto.getRandomValues(new Uint32Array(16385)); out.u32Quota = 'no-error'; } catch (e) { out.u32Quota = String(e.name) }
JSON.stringify(out)
`)
console.log('getRandomValues', JSON.stringify(sync))

const digest = h.run(`
globalThis.__digest = null;
globalThis.__err = null;
const buf = new Uint8Array(16);
for (var i = 0; i < 16; i++) buf[i] = i;
crypto.subtle.digest('SHA-256', new Uint8Array(buf.buffer, 4, 4)).then(function (d) {
  globalThis.__digest = Array.from(new Uint8Array(d));
}, function (e) { globalThis.__err = String(e && e.name) + ':' + String(e && e.message) });
'digest-queued'
`)
console.log('digest-run', JSON.stringify(digest))
h.jobs(200)
console.log('digest-result', JSON.stringify(h.run(`JSON.stringify({ digest: globalThis.__digest, err: globalThis.__err })`)))

const aad = h.run(`
globalThis.__aad = null;
const keyBytes = new Uint8Array(16);
crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']).then(function (key) {
  const iv = new Uint8Array(12);
  const data = new Uint8Array(0);
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: new Uint8Array([1,2,3,4]), tagLength: 96 }, key, data)
    .then(function (ct) { globalThis.__aad = { ok: true, len: new Uint8Array(ct).length, bytes: Array.from(new Uint8Array(ct).slice(0,4)) } },
          function (e) { globalThis.__aad = { ok: false, err: String(e && e.name) + ':' + String(e && e.message) } });
});
'queued'
`)
console.log('aad-run', JSON.stringify(aad))
h.jobs(300)
console.log('aad-result', JSON.stringify(h.run(`JSON.stringify(globalThis.__aad)`)))
