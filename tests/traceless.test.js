import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

/**
 * Detection-corpus test: these are the probes real loaders use to decide
 * whether they are inside a VM, a headless browser or an analysis farm. Each
 * assertion corresponds to a technique documented in
 * docs/RESEARCH-ANTI-ANALYSIS.md.
 */

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'navigator', 'screen', 'performance', 'anti-fingerprint']

async function withSandbox(fn, options = {}) {
  const sb = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    ...options,
  })
  try {
    return await fn(sb)
  } finally {
    sb.dispose()
  }
}

test('instrumented function source is byte-identical to the original', async () => {
  const source = 'function add(a, b) { var total = a + b; return total * 2 }\nadd.toString()'
  const original = 'function add(a, b) { var total = a + b; return total * 2 }'
  await withSandbox(async (sb) => {
    const run = await sb.run(source)
    assert.equal(run.ok, true)
    assert.equal(run.result.value, original)
  })
})

test('Function.prototype.toString itself is indistinguishable from native', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      ({
        self: Function.prototype.toString.toString(),
        selfName: Function.prototype.toString.name,
        selfLength: Function.prototype.toString.length,
        native: /native code/.test(Function.prototype.toString.toString()),
        fnName: (function named() {}).toString(),
        bound: (function f() {}).bind(null).toString(),
        arrow: ((x) => x * 2).toString(),
        asyncFn: (async function g() {}).toString()
      })
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    assert.equal(value.self, 'function toString() { [native code] }')
    assert.equal(value.selfName, 'toString')
    assert.equal(value.selfLength, 0)
    assert.equal(value.native, true)
    assert.equal(value.fnName, 'function named() {}')
    assert.match(value.bound, /native code/)
    assert.equal(value.arrow, '(x) => x * 2')
    assert.equal(value.asyncFn, 'async function g() {}')
  })
})

test('no instrumentation channel leaks through global or document enumeration', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      (function () {
        var names = Object.getOwnPropertyNames(globalThis);
        var suspiciousNames = names.filter(function (k) { return /_\\$|ai4r|channel|__q|trace|_hook/i.test(k) });
        var symbols = Object.getOwnPropertySymbols(globalThis).map(String);
        var keys = Reflect.ownKeys(globalThis).filter(function (k) { return typeof k === 'symbol' }).map(String);
        return { suspiciousNames: suspiciousNames, symbols: symbols, keys: keys, count: names.length };
      })()
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    assert.deepEqual(value.suspiciousNames, [])
    assert.deepEqual(value.symbols, [])
    assert.deepEqual(value.keys, [])
    assert.ok(value.count > 40 && value.count < 400, `implausible global count ${value.count}`)
  })
})

test('host runtime globals are absent and Page identity is browser-shaped', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      ({
        leaks: ['process','require','Buffer','module','exports','global','__dirname','__filename','spawn','Deno','Bun']
          .filter(function (k) { return typeof globalThis[k] !== 'undefined' }),
        windowIsGlobal: window === globalThis,
        tag: Object.prototype.toString.call(window),
        ctor: window.constructor && window.constructor.name,
        proto: Object.getPrototypeOf(window) === Window.prototype,
        webdriver: navigator.webdriver,
        platformConsistent: navigator.userAgent.indexOf('Windows NT') !== -1 ? navigator.platform === 'Win32' : true
      })
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    assert.deepEqual(value.leaks, [])
    assert.equal(value.windowIsGlobal, true)
    assert.equal(value.tag, '[object Window]')
    assert.equal(value.ctor, 'Window')
    assert.equal(value.proto, true)
    assert.equal(value.webdriver, false)
    assert.equal(value.platformConsistent, true)
  })
})

test('guest-visible stacks contain no eval marker, host path or internal frame', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(
      `
      var caught = (function inner() { try { null.x } catch (e) { return e.stack } })();
      var constructed = new Error('boom').stack;
      ({ caught: caught, constructed: constructed })
    `,
      { filename: 'https://cdn.example.test/assets/main.4f19.js' },
    )
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    for (const stack of [value.caught, value.constructed]) {
      assert.doesNotMatch(stack, /<eval>/)
      assert.doesNotMatch(stack, /ai4r-internal/)
      assert.doesNotMatch(stack, /node_modules|\/Users\/|file:\/\//)
      assert.match(stack, /https:\/\/cdn\.example\.test\/assets\/main\.4f19\.js:\d+:\d+/)
    }
  })
})

test('Date is virtual, timezone-consistent and still an engine Date', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      (function () {
        var epoch = 1792394400000;
        var d = new Date(epoch);
        var before = Date.now();
        var spin = 0;
        for (var i = 0; i < 200000; i++) spin += i;
        var after = Date.now();
        return {
          hours: d.getHours(),
          offset: d.getTimezoneOffset(),
          iso: d.toISOString(),
          instanceofDate: d instanceof Date,
          dateTag: Object.prototype.toString.call(d),
          getTimeNative: /native code/.test(Date.prototype.getTime.toString()),
          advanced: after - before,
          timeOriginDelta: Math.abs((Date.now() - performance.timeOrigin) - performance.now()),
          parsed: Date.parse('2026-10-19T07:20:00.000Z'),
          utc: Date.UTC(2026, 9, 19, 7, 20)
        };
      })()
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    const localMinutes = ((7 * 60 + 20 - value.offset) % 1440 + 1440) % 1440
    assert.equal(value.hours, Math.floor(localMinutes / 60))
    assert.equal(value.iso, '2026-10-19T07:20:00.000Z')
    assert.equal(value.instanceofDate, true)
    assert.equal(value.dateTag, '[object Date]')
    assert.equal(value.getTimeNative, true)
    assert.ok(value.advanced >= 0 && value.advanced < 5000, `implausible clock advance ${value.advanced}`)
    assert.ok(value.timeOriginDelta < 2, `Date/performance clocks disagree by ${value.timeOriginDelta}ms`)
    assert.equal(value.parsed, 1792394400000)
    assert.equal(value.utc, 1792394400000)
  }, { profile: { locale: 'zh-CN', os: 'windows', browser: 'chrome' } })
})

test('debugger statements do not pause and timing stays plausible', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      (function () {
        var start = performance.now();
        debugger;
        var middle = performance.now();
        try { while (false) {} } catch (e) {}
        return { delta: middle - start, monotonic: performance.now() >= middle };
      })()
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    assert.ok(value.delta >= 0 && value.delta < 1000, `debugger stalled ${value.delta}ms`)
    assert.equal(value.monotonic, true)
  })
})

test('native shims used for platform surfaces report [native code]', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      ({
        date: Date.prototype.getHours.toString(),
        random: Math.random.toString(),
        error: Error.toString(),
        errorGetter: (function () { try { null.x } catch (e) { return e.constructor.toString() } })(),
        getOwnPropertySymbols: Object.getOwnPropertySymbols.toString(),
        ownKeys: Reflect.ownKeys.toString(),
        windowName: navigator.userAgent,
        navigatorProto: typeof Navigator,
      })
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    for (const key of ['date', 'random', 'error', 'errorGetter', 'getOwnPropertySymbols', 'ownKeys']) {
      assert.match(String(value[key]), /native code/, `${key} leaks shim source: ${value[key]}`)
    }
    assert.match(value.windowName, /Windows NT 10\.0|Macintosh|Linux/)
  }, { profile: { locale: 'zh-CN', os: 'windows', browser: 'chrome' } })
})

test('analysis run leaves no intrinsic drift of its own', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run('var a = 1; function f() { return a } f()')
    assert.equal(run.integrity.intact, true, JSON.stringify(run.integrity.intrinsicDrift))
    assert.deepEqual(run.disposal, { ok: true, errors: [] })
    assert.equal(run.stealth.masked >= 0, true)
  })
})

test('eval, Function and timer string callbacks are traced without changing semantics', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run(`
      globalThis.__out = [];
      eval('__out.push("eval:" + (1 + 1))');
      var f = Function('a', 'return a * 3');
      __out.push('fn:' + f(4));
      setTimeout('__out.push("timer-string")', 10);
      var g = function () { return 'g' };
      __out.push('g:' + g());
    `)
    assert.equal(run.ok, true)
    const evalEvents = (run.events ?? []).filter((event) => event.kind === 'code' && event.event === 'eval')
    const fnEvents = (run.events ?? []).filter((event) => event.kind === 'code' && event.event === 'Function')
    assert.ok(evalEvents.length >= 1, 'eval call site not traced')
    assert.ok(fnEvents.length >= 1, 'Function constructor call site not traced')
    assert.equal(run.settle.timerCallbacks >= 1, true, JSON.stringify(run.settle))
  })
})

test('profile fingerprint is stable for a seed and changes with another seed', async () => {
  const snapshot = async (seed) =>
    withSandbox(
      async (sb) => {
        const run = await sb.run(
          `({ ua: navigator.userAgent, platform: navigator.platform, tz: new Date(0).getTimezoneOffset(), lang: navigator.language, screen: [screen.width, screen.height, devicePixelRatio], hc: navigator.hardwareConcurrency })`,
        )
        return JSON.parse(run.result.preview)
      },
      { seed },
    )
  const a = await snapshot(7)
  const b = await snapshot(7)
  assert.deepEqual(a, b)
  const c = await snapshot(8)
  assert.notDeepEqual(a, c)
})

test('host callbacks may return plain primitives without use-after-free', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: true } })
  try {
    const run = await sb.run('({ selection: document.getSelection().toString(), type: typeof document.getSelection().toString() })')
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.equal(value.selection, '')
    assert.equal(value.type, 'string')
    assert.equal(run.disposal.ok, true, JSON.stringify(run.disposal))
  } finally {
    sb.dispose()
  }
})

test('a directive prologue without a semicolon still compiles', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run('function f(){"use strict"\nreturn 41 + 1}\nf()')
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 42)
    const top = await sb.run('"use strict"\n1 + 1')
    assert.equal(top.ok, true, JSON.stringify(top.error))
    assert.equal(top.result.value, 2)
  })
})

test('direct eval preserves non-string argument identity', async () => {
  await withSandbox(async (sb) => {
    const run = await sb.run('var f = function () {}; eval(f) === f')
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, true)
  })
})

test('the instrumentation binding name is not a guessable identifier', async () => {
  await withSandbox(async (sb) => {
    const probe = await sb.run("(function(){ return [typeof _$q, eval('typeof _$q')] })()")
    assert.equal(probe.ok, true, JSON.stringify(probe.error))
    assert.deepEqual(probe.result.preview ? JSON.parse(probe.result.preview) : null, ['undefined', 'undefined'])
  })
})

test('document symbol enumeration is empty under the full environment', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: true } })
  try {
    const run = await sb.run(`
      ({
        doc: Object.getOwnPropertySymbols(document).map(String),
        assigned: Object.getOwnPropertySymbols(Object.assign({}, document)).map(String),
        keys: Reflect.ownKeys(document).filter(function (k) { return typeof k === 'symbol' }).map(String)
      })
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const value = JSON.parse(run.result.preview)
    assert.deepEqual(value.doc, [])
    assert.deepEqual(value.assigned, [])
    assert.deepEqual(value.keys, [])
  } finally {
    sb.dispose()
  }
})
