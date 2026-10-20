import { TracelessSandbox } from '../../../tools/index.js'

const sb = await TracelessSandbox.create({ limits: { timeoutMs: 15000 } })
const r = await sb.run(`
const out = {};
out.typeofNavigator = typeof Navigator;
out.typeofScreen = typeof Screen;
out.typeofLocation = typeof Location;
out.navCtorName = navigator.constructor && navigator.constructor.name;
out.navProtoIsCtorProto = (typeof Navigator !== 'undefined') ? (Object.getPrototypeOf(navigator) === Navigator.prototype) : 'no-ctor';
try { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'userAgent'); out.uaDesc = d ? { hasGet: typeof d.get, getName: d.get && d.get.name, writable: d.writable } : null; } catch (e) { out.uaDescErr = String(e && e.message); }
let docHits = 0, winHits = 0;
document.addEventListener('probe', function () { docHits++ });
window.addEventListener('probe', function () { winHits++ });
const el = document.createElement('div'); document.body.appendChild(el);
el.dispatchEvent(new Event('probe', { bubbles: true }));
out.docHits = docHits; out.winHits = winHits;
const c = document.createElement('canvas').getContext('2d');
out.blank = Array.prototype.slice.call(c.getImageData(0, 0, 1, 1).data);
c.fillStyle = '#ff0000'; c.fillRect(0, 0, 1, 1);
out.painted = Array.prototype.slice.call(c.getImageData(0, 0, 1, 1).data);
try { location.href = 'https://evil.example/x'; } catch (e) { out.locSetErr = String(e && e.message) }
out.locationHref = location.href;
out.documentLocationType = typeof document.location;
try { const i = new Image(); i.src = 'https://c2.example/beacon?d=1'; out.imgSrc = i.src; } catch (e) { out.imgErr = String(e && e.message) }
JSON.stringify(out)
`)
const events = r.events ?? []
const imgEvents = events.filter((e) => JSON.stringify(e).includes('img.src'))
const iocs = events.filter((e) => e.kind === 'ioc')
const net = events.filter((e) => e.kind === 'net')
console.log(JSON.stringify({
  ok: r.ok,
  error: r.error,
  guest: r.result ?? null,
  disposal: r.disposal,
  counts: { ioc: iocs.length, net: net.length, imgEvents: imgEvents.length },
  imgEventSample: imgEvents.slice(0, 1),
  iocValues: iocs.slice(0, 5).map((e) => e.value ?? e.ioc ?? e),
}, null, 2))
sb.dispose()
