import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { install as installAntiFingerprint, meta as antiFingerprintMeta } from '../tools/sandbox/env/anti-fingerprint.js'
import { install as installNavigator } from '../tools/sandbox/env/navigator.js'

/**
 * Anti-fingerprint hardening.
 *
 * The module removes host globals, repairs the Window prototype chain and gives
 * platform objects browser-shaped brands. The tests assert what a sample can
 * *observe* after the repair (own keys, descriptors, `instanceof`, brands) and
 * that a degraded installation reports itself through the trace instead of
 * throwing into the guest.
 */

const MODULES = [
  'globals',
  'console',
  'timers',
  'dom',
  'dom-parser',
  'canvas',
  'navigator',
  'screen',
  'location',
  'performance',
  'crypto',
  'storage',
  'misc',
  'anti-fingerprint',
]

async function fingerprintHarness(options = {}) {
  return createHarness({ modules: MODULES, ...options })
}

/** Evaluate guest source and fail the test when it throws. */
function runGuest(harness, source) {
  const result = harness.run(source)
  assert.equal(result.ok, true, `guest threw: ${JSON.stringify(result.error)}`)
  return result.value
}

/** All trace events with the given `event` name. */
function eventsNamed(trace, name) {
  return trace.events.filter((event) => event.event === name)
}

/**
 * A bridge whose `ctx.evalCode`/`ctx.callFunction` can be poisoned for chosen
 * sources, so the degraded installation paths are reachable without breaking the
 * real engine. Everything else forwards to the production bridge.
 */
function poisoningBridge(bridge, poison) {
  const realCtx = bridge.ctx
  const boxedError = () => realCtx.evalCode('new TypeError("blocked by the test")').value
  const proxyCtx = new Proxy(realCtx, {
    get(target, key) {
      if (key === 'evalCode') {
        return (source, filename) => {
          if (poison.evalCode?.(String(source), String(filename ?? ''))) return { error: boxedError() }
          return target.evalCode(source, filename)
        }
      }
      if (key === 'callFunction') {
        return (fn, thisHandle, args) => {
          if (poison.callFunction?.(args)) return { error: boxedError() }
          return target.callFunction(fn, thisHandle, args)
        }
      }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...bridge, ctx: proxyCtx }
}

test('meta declares the anti-fingerprint module contract', () => {
  assert.equal(antiFingerprintMeta.id, 'anti-fingerprint')
  assert.equal(antiFingerprintMeta.order, 130)
  assert.deepEqual([...antiFingerprintMeta.requires], ['globals'])
})

test('installation removes honeypots and records what it saw', async () => {
  const harness = await fingerprintHarness({ modules: ['globals', 'console', 'timers'] })
  try {
    runGuest(harness, `globalThis.spawn = 1; globalThis.__nightmare = 'farm'; globalThis.__selenium_evaluate = 1;`)
    installAntiFingerprint(harness.bridge)

    const record = harness.bridge.antiFingerprint
    assert.deepEqual(record.honeypotsPresent.sort(), ['__nightmare', '__selenium_evaluate'])
    assert.ok(record.removed.includes('spawn'), JSON.stringify(record.removed))
    assert.ok(record.removed.includes('__nightmare'))
    assert.deepEqual(record.checks.hostLeaks, [])
    assert.equal(record.checks.hasEval, true)
    assert.equal(typeof record.checks.globalKeys, 'number')

    // Without a DOM module the hierarchy repair is skipped and reported.
    const skipped = eventsNamed(harness.trace, 'anti-fingerprint.elements-skipped')
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0].reason, 'no-dom-module')
    assert.equal(runGuest(harness, `typeof spawn + ':' + typeof __nightmare`), 'undefined:undefined')
    assert.equal(eventsNamed(harness.trace, 'anti-fingerprint.checked').length, 1)
  } finally {
    harness.dispose()
  }
})

test('platform surfaces stop leaking own properties and report the moved count', async () => {
  const harness = await fingerprintHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `JSON.stringify({
          navigatorOwn: Object.keys(navigator).length,
          userAgentOwn: navigator.hasOwnProperty('userAgent'),
          screenOwn: Object.keys(screen).length,
          locationOwn: Object.keys(location).length,
          ownNames: Object.getOwnPropertyNames(navigator).length,
          userAgent: typeof navigator.userAgent,
          width: screen.width,
          href: location.href,
          document: typeof document,
        })`,
      ),
    )
    assert.deepEqual(value, {
      navigatorOwn: 0,
      userAgentOwn: false,
      screenOwn: 0,
      locationOwn: 0,
      ownNames: 0,
      userAgent: 'string',
      width: harness.profile.screen.width,
      href: harness.profile.origin + '/',
      document: 'object',
    })

    const prototypified = eventsNamed(harness.trace, 'anti-fingerprint.prototypified')
    assert.equal(prototypified.length, 1)
    assert.ok(prototypified[0].moved > 0, JSON.stringify(prototypified[0]))
    assert.ok(prototypified[0].moved < 10000)
    assert.equal(eventsNamed(harness.trace, 'anti-fingerprint.branded').length, 1)
    assert.equal(eventsNamed(harness.trace, 'anti-fingerprint.symbols-hidden').length, 1)
  } finally {
    harness.dispose()
  }
})

test('platform objects carry browser brands and constructor links', async () => {
  const harness = await fingerprintHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `JSON.stringify({
          navigator: Object.prototype.toString.call(navigator),
          navigatorCtor: navigator.constructor.name,
          navigatorIsInstance: Object.getPrototypeOf(navigator).constructor === navigator.constructor,
          screen: Object.prototype.toString.call(screen),
          location: Object.prototype.toString.call(location),
          performance: Object.prototype.toString.call(performance),
          crypto: Object.prototype.toString.call(crypto),
          console: Object.prototype.toString.call(console),
          document: Object.prototype.toString.call(document),
          documentCtor: document.constructor.name,
          documentIsHtmlDocument: document instanceof HTMLDocument,
        })`,
      ),
    )
    assert.equal(value.navigator, '[object Navigator]')
    assert.equal(value.navigatorCtor, 'Navigator')
    assert.equal(value.navigatorIsInstance, true, 'the brand layer keeps a coherent constructor link')
    assert.equal(value.screen, '[object Screen]')
    assert.equal(value.location, '[object Location]')
    assert.equal(value.performance, '[object Performance]')
    assert.equal(value.crypto, '[object Crypto]')
    assert.equal(value.console, '[object console]')
    assert.equal(value.document, '[object HTMLDocument]')
    assert.equal(value.documentCtor, 'HTMLDocument')
    assert.equal(value.documentIsHtmlDocument, true)
  } finally {
    harness.dispose()
  }
})

test('the DOM interface hierarchy is grafted, never invented', async () => {
  const harness = await fingerprintHarness()
  try {
    const branded = eventsNamed(harness.trace, 'anti-fingerprint.elements-branded')
    assert.equal(branded.length, 1)
    assert.ok(Array.isArray(branded[0].grafted), JSON.stringify(branded[0]))
    assert.ok(
      branded[0].grafted.includes('HTMLCanvasElement'),
      `canvas interfaces are grafted onto HTMLElement: ${JSON.stringify(branded[0])}`,
    )

    const lineage = runGuest(
      harness,
      `(function () {
        var canvas = document.createElement('canvas');
        var parsed = document.implementation.createHTMLDocument('probe');
        return [
          canvas instanceof HTMLCanvasElement,
          canvas instanceof HTMLElement,
          canvas instanceof Element,
          canvas instanceof Node,
          canvas instanceof EventTarget,
          parsed instanceof Document,
          parsed instanceof HTMLDocument,
          document instanceof HTMLDocument,
          canvas.style instanceof CSSStyleDeclaration,
        ];
      })()`,
    )
    assert.deepEqual(lineage, [true, true, true, true, true, true, true, true, true])
  } finally {
    harness.dispose()
  }
})

test('customElements validates names, constructors and upgrades', async () => {
  const harness = await fingerprintHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var out = {};
          function Ctor() { this.upgraded = true; this.touched = (this.touched || 0) + 1; }
          customElements.define('x-probe', Ctor);
          out.get = customElements.get('x-probe') === Ctor;
          out.missing = customElements.get('x-absent') === undefined;
          var element = document.createElement('x-probe');
          customElements.upgrade(element);
          out.upgraded = element.upgraded === true;
          out.instance = element instanceof Ctor;
          var errors = [];
          function capture(fn) { try { fn(); errors.push('no-throw'); } catch (error) { errors.push(error.name); } }
          capture(function () { customElements.define('bad', Ctor) });
          capture(function () { customElements.define('annotation-xml', Ctor) });
          capture(function () { customElements.define('x-probe', Ctor) });
          capture(function () { customElements.define('x-ctor', 'not a constructor') });
          out.errors = errors;
          out.tag = Object.prototype.toString.call(customElements);
          out.globalRegistry = globalThis.customElements === customElements;
          out.registryOnDocument = typeof document.customElements;
          return JSON.stringify(out);
        })()`,
      ),
    )
    assert.deepEqual(value.errors, ['SyntaxError', 'SyntaxError', 'NotSupportedError', 'TypeError'])
    assert.equal(value.get, true)
    assert.equal(value.missing, true)
    assert.equal(value.upgraded, true)
    assert.equal(value.instance, true)
    assert.equal(value.tag, '[object CustomElementRegistry]')
    assert.equal(value.globalRegistry, true)
    assert.equal(value.registryOnDocument, 'undefined', 'document.customElements is not a browser API')
  } finally {
    harness.dispose()
  }
})

test('whenDefined settles when the element is defined later', async () => {
  const harness = await fingerprintHarness()
  try {
    runGuest(
      harness,
      `globalThis.__defined = 'pending';
       customElements.whenDefined('x-later').then(function (ctor) { __defined = typeof ctor; });
       customElements.whenDefined('x-later').then(function (ctor) { __defined = __defined + ':' + (typeof ctor); });
       var rejected = 'pending';
       customElements.whenDefined('invalid').then(null, function (error) { rejected = error.name; });
       globalThis.__rejected = function () { return rejected; };
       0`,
    )
    harness.jobs()
    assert.equal(runGuest(harness, '__defined'), 'pending', 'an undefined element stays pending')
    assert.equal(runGuest(harness, '__rejected()'), 'SyntaxError', 'an invalid name rejects')

    runGuest(harness, `function Later() {} customElements.define('x-later', Later); 0`)
    harness.jobs()
    assert.equal(runGuest(harness, '__defined'), 'function:function')
    assert.equal(runGuest(harness, '__rejected()'), 'SyntaxError')
  } finally {
    harness.dispose()
  }
})

test('a webdriver-true profile is reported as an installation error', async () => {
  const harness = await createHarness({ modules: ['globals', 'storage'] })
  try {
    // The profile builder always sets `webdriver: false`; the verification step
    // exists for an inconsistent installation, so the profile is forced here.
    harness.profile.webdriver = true
    installNavigator(harness.bridge)
    assert.equal(runGuest(harness, 'navigator.webdriver'), true)
    installAntiFingerprint(harness.bridge)
    const failures = harness.trace.events.filter((event) => event.event === 'anti-fingerprint.webdriver-true')
    assert.equal(failures.length, 1)
    assert.equal(harness.bridge.antiFingerprint.checks.webdriver, true)
    assert.equal(eventsNamed(harness.trace, 'anti-fingerprint.checked')[0].webdriver, true)
  } finally {
    harness.dispose()
  }
})

test('a rejected engine snippet is reported instead of thrown', async () => {
  const harness = await createHarness({ modules: ['globals', 'console', 'timers'] })
  let disposal
  try {
    assert.equal(harness.bridge.antiFingerprint, undefined)

    // The inspection snippet is rejected: the module reports and returns.
    const before = harness.trace.events.length
    const poisoned = poisoningBridge(harness.bridge, {
      evalCode: (source, filename) => filename.includes('ai4r-internal:anti-fingerprint'),
    })
    assert.doesNotThrow(() => installAntiFingerprint(poisoned))
    const failures = harness.trace.events
      .slice(before)
      .filter((event) => event.event === 'anti-fingerprint.failed')
    assert.equal(failures.length, 1)
    assert.match(String(failures[0].error?.message ?? failures[0].error), /blocked by the test/)
    assert.equal(harness.bridge.antiFingerprint, undefined, 'no record is published for a failed install')

    // The same happens when the guest rejects the inspection *call*.
    const beforeCall = harness.trace.events.length
    const callPoisoned = poisoningBridge(harness.bridge, { callFunction: () => true })
    assert.doesNotThrow(() => installAntiFingerprint(callPoisoned))
    const callFailures = harness.trace.events
      .slice(beforeCall)
      .filter((event) => event.event === 'anti-fingerprint.failed')
    assert.equal(callFailures.length, 1)
    assert.equal(harness.bridge.antiFingerprint, undefined)
  } finally {
    disposal = harness.dispose()
  }
  // The rejected snippets hand back error handles; a degraded install must still
  // release every handle it took, or the engine aborts on teardown.
  assert.equal(disposal.leaked, false, 'a rejected snippet must not leak a handle')
})

test('degraded hardening reports the failed stage and never claims success', async () => {
  // Each case gets a fresh, un-hardened context so the runs cannot observe each
  // other's repairs.
  const plainModules = MODULES.filter((id) => id !== 'anti-fingerprint')
  const cases = [
    {
      label: 'prototypify helper',
      poison: { evalCode: (source, filename) => filename.includes('ai4r-internal:prototypify') },
      present: ['anti-fingerprint.symbols-hidden', 'anti-fingerprint.branded', 'anti-fingerprint.elements-branded'],
      absent: ['anti-fingerprint.prototypified'],
    },
    {
      label: 'brand factory',
      poison: { evalCode: (source, filename) => filename === 'ai4r-internal:brand' },
      present: ['anti-fingerprint.prototypified', 'anti-fingerprint.symbols-hidden', 'anti-fingerprint.elements-branded'],
      absent: ['anti-fingerprint.branded'],
    },
    {
      label: 'symbol tag lookup',
      poison: { evalCode: (source) => String(source).includes('Symbol.toStringTag') },
      present: ['anti-fingerprint.prototypified', 'anti-fingerprint.elements-failed'],
      absent: ['anti-fingerprint.symbols-hidden', 'anti-fingerprint.branded'],
    },
    {
      label: 'DOM interface install',
      poison: { evalCode: (source, filename) => filename.includes('ai4r-internal:dom-interfaces') },
      present: ['anti-fingerprint.prototypified', 'anti-fingerprint.symbols-hidden', 'anti-fingerprint.branded'],
      absent: ['anti-fingerprint.elements-branded'],
    },
  ]

  for (const testCase of cases) {
    const harness = await createHarness({ modules: plainModules })
    let disposal
    try {
      assert.doesNotThrow(() => installAntiFingerprint(poisoningBridge(harness.bridge, testCase.poison)), testCase.label)
      const names = harness.trace.events.filter((event) => String(event.event).startsWith('anti-fingerprint.')).map((event) => event.event)
      for (const expected of testCase.present) {
        assert.ok(names.includes(expected), `${testCase.label}: ${expected} missing from ${JSON.stringify(names)}`)
      }
      for (const unexpected of testCase.absent) {
        assert.ok(!names.includes(unexpected), `${testCase.label}: ${unexpected} must not be claimed`)
      }
      assert.ok(names.includes('anti-fingerprint.checked'), `${testCase.label}: the install still completes`)
      const failed = harness.trace.events.filter((event) => event.event === 'anti-fingerprint.elements-failed')
      if (testCase.present.includes('anti-fingerprint.elements-failed')) {
        assert.equal(failed.length, 1, testCase.label)
        assert.equal(failed[0].stage, 'compile')
      }
      // The prototypify stage reports the real count when it ran at all.
      const moved = harness.trace.events.filter((event) => event.event === 'anti-fingerprint.prototypified')
      for (const event of moved) assert.ok(event.moved > 0 && event.moved < 10000, JSON.stringify(event))
    } finally {
      disposal = harness.dispose()
    }
    // A degraded stage must not leave the failed snippet's handles alive: the
    // engine aborts (and quarantines the WASM module) if it does.
    assert.equal(disposal.leaked, false, `${testCase.label}: degraded install leaked a handle`)
  }
})
