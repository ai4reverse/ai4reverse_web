import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { install as installObservers, meta as observersMeta } from '../tools/sandbox/env/observers.js'

/**
 * Observer surfaces (`MutationObserver`, `IntersectionObserver`,
 * `ResizeObserver`).
 *
 * The module delivers exactly one synthetic entry per `observe()` on the next
 * turn of the virtual clock. That is a fidelity compromise, so the tests pin
 * what a sample can actually observe: the entry shape, the delivery turn, the
 * cancellation paths (`unobserve`/`disconnect`/`takeRecords`) and the fact that
 * a throwing callback becomes a trace event instead of a host crash.
 */

async function observerHarness() {
  return createHarness({ modules: ['globals', 'console', 'timers', 'dom', 'observers'] })
}

/** Evaluate guest source and fail the test when it throws. */
function runGuest(harness, source) {
  const result = harness.run(source)
  assert.equal(result.ok, true, `guest threw: ${JSON.stringify(result.error)}`)
  return result.value
}

/** Run the virtual clock so scheduled observer callbacks deliver. */
function deliver(harness, rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    harness.timers()
    harness.jobs()
  }
}

test('meta declares the observer module contract', () => {
  assert.equal(observersMeta.id, 'observers')
  assert.equal(observersMeta.order, 108)
  assert.deepEqual([...observersMeta.requires], ['dom'])
})

test('the three observer constructors are installed and branded', async () => {
  const harness = await observerHarness()
  try {
    const value = runGuest(
      harness,
      `['MutationObserver', 'IntersectionObserver', 'ResizeObserver'].map(function (name) {
        var Ctor = globalThis[name];
        var observer = new Ctor(function () {});
        return [
          typeof Ctor,
          Ctor.name,
          Ctor.length,
          observer.constructor === Ctor,
          Object.prototype.toString.call(observer),
          typeof observer.observe,
          typeof observer.unobserve,
          typeof observer.disconnect,
          typeof observer.takeRecords,
          String(Ctor).indexOf('[native code]') > 0,
        ];
      })`,
    )
    for (const row of value) {
      assert.deepEqual(row, [
        'function',
        'function',
        1,
        true,
        '[object Object]',
        'function',
        'function',
        'function',
        'function',
        true,
      ].map((expected, index) => (index === 1 ? row[1] : expected)))
    }
    assert.deepEqual(value.map((row) => row[1]), ['MutationObserver', 'IntersectionObserver', 'ResizeObserver'])
  } finally {
    harness.dispose()
  }
})

test('MutationObserver delivers one childList record after the clock advances', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__mutation = null;
       globalThis.__target = document.createElement('div');
       globalThis.__observer = new MutationObserver(function (entries, observer) {
         __mutation = {
           count: entries.length,
           type: entries[0].type,
           matchesTarget: entries[0].target === __target,
           added: entries[0].addedNodes.length,
           removed: entries[0].removedNodes.length,
           attributeName: entries[0].attributeName,
           oldValue: entries[0].oldValue,
           sameObserver: observer === __observer,
         };
       });
       __observer.observe(__target, { childList: true, attributes: true });`,
    )
    assert.equal(runGuest(harness, 'String(__mutation)'), 'null', 'nothing is delivered synchronously')

    deliver(harness)
    const value = JSON.parse(runGuest(harness, 'JSON.stringify(__mutation)'))
    assert.deepEqual(value, {
      count: 1,
      type: 'childList',
      matchesTarget: true,
      added: 0,
      removed: 0,
      attributeName: null,
      oldValue: null,
      sameObserver: true,
    })
    assert.equal(
      harness.trace.events.filter((event) => event.kind === 'api' && event.api === 'MutationObserver.observe').length,
      1,
    )
  } finally {
    harness.dispose()
  }
})

test('unobserve, disconnect and takeRecords cancel a pending delivery', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__delivered = 0;
       globalThis.__target = document.createElement('div');
       globalThis.__observed = new MutationObserver(function () { __delivered += 1 });
       globalThis.__taken = new MutationObserver(function () { __delivered += 100 });`,
    )

    // takeRecords() drains the pending record, so the scheduled delivery is empty.
    const taken = runGuest(
      harness,
      `(function () {
        __taken.observe(__target, { childList: true });
        var records = __taken.takeRecords();
        return [records.length, records[0].type, __taken.takeRecords().length];
      })()`,
    )
    assert.deepEqual(taken, [1, 'childList', 0])

    const cancelled = runGuest(
      harness,
      `(function () {
        __observed.observe(__target, { childList: true });
        __observed.disconnect();
        __observed.observe(__target, { childList: true });
        __observed.unobserve(__target);
        return 'scheduled';
      })()`,
    )
    assert.equal(cancelled, 'scheduled')

    deliver(harness)
    assert.equal(runGuest(harness, '__delivered'), 0, 'no cancelled observer delivered a record')
    const apiNames = harness.trace.events
      .filter((event) => event.kind === 'api' && /Observer\.(observe|unobserve)/.test(String(event.api)))
      .map((event) => event.api)
    assert.ok(apiNames.includes('MutationObserver.unobserve'), JSON.stringify(apiNames))
  } finally {
    harness.dispose()
  }
})

test('IntersectionObserver reports an intersecting record and real geometry', async () => {
  const harness = await observerHarness()
  try {
    const value = runGuest(
        harness,
        `globalThis.__entry = null;
         globalThis.__target = document.createElement('div');
         globalThis.__target.style.width = '120px';
         globalThis.__rect = __target.getBoundingClientRect();
         new IntersectionObserver(function (entries) {
           __entry = {
             count: entries.length,
             time: entries[0].time,
             isIntersecting: entries[0].isIntersecting,
             ratio: entries[0].intersectionRatio,
             matchesTarget: entries[0].target === __target,
             boundingWidth: entries[0].boundingClientRect.width,
             intersectionWidth: entries[0].intersectionRect.width,
             rootWidth: entries[0].rootBounds.width,
           };
         }).observe(__target, { threshold: 1 });
         'scheduled'`,
    )
    assert.equal(value, 'scheduled')
    deliver(harness)
    const entry = JSON.parse(runGuest(harness, 'JSON.stringify(__entry)'))
    assert.equal(entry.count, 1)
    assert.equal(entry.isIntersecting, true)
    assert.equal(entry.ratio, 1)
    assert.equal(entry.matchesTarget, true)
    assert.equal(typeof entry.time, 'number')
    // The record reuses the target's own box instead of inventing geometry.
    assert.equal(entry.boundingWidth, runGuest(harness, '__rect.width'))
    assert.deepEqual([entry.intersectionWidth, entry.rootWidth], [entry.boundingWidth, entry.boundingWidth])
    assert.equal(entry.intersectionWidth, entry.boundingWidth)
    assert.equal(entry.rootWidth, entry.boundingWidth)
  } finally {
    harness.dispose()
  }
})

test('ResizeObserver reports content and box sizes', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__entry = null;
       globalThis.__target = document.createElement('div');
       new ResizeObserver(function (entries) {
         var entry = entries[0];
         globalThis.__box = __target.getBoundingClientRect();
         __entry = {
           matchesTarget: entry.target === __target,
           contentWidth: entry.contentRect.width,
           inline: entry.borderBoxSize[0].inlineSize,
           block: entry.contentBoxSize[0].blockSize,
           pixel: entry.devicePixelContentBoxSize[0].inlineSize,
         };
       }).observe(__target);`,
    )
    deliver(harness)
    const entry = JSON.parse(runGuest(harness, 'JSON.stringify(__entry)'))
    assert.deepEqual(entry, {
      matchesTarget: true,
      contentWidth: runGuest(harness, '__box.width'),
      inline: 300,
      block: 150,
      pixel: 300,
    })
  } finally {
    harness.dispose()
  }
})

test('observing a non-element falls back to the profile geometry', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__entry = null;
       new ResizeObserver(function (entries) { __entry = {
         isNull: entries[0].target === null,
         width: entries[0].contentRect.width,
         height: entries[0].contentRect.height,
         right: entries[0].contentRect.right,
       } }).observe({ plain: true });`,
    )
    deliver(harness)
    const entry = JSON.parse(runGuest(harness, 'JSON.stringify(__entry)'))
    assert.deepEqual(entry, { isNull: false, width: 300, height: 150, right: 300 })
    assert.equal(harness.trace.events.some((event) => event.api === 'ResizeObserver.observe'), true)
  } finally {
    harness.dispose()
  }
})

test('a plain-object target is described by tagName when it has one', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__entry = null;
       new MutationObserver(function () {}).observe({ tagName: 'SECTION' });`,
    )
    const event = harness.trace.events.find((entry) => entry.api === 'MutationObserver.observe')
    assert.equal(event.target, 'section', 'a tagName target is described in lower case')

    const nullEvent = (() => {
      runGuest(harness, `new MutationObserver(function () {}).observe();`)
      return harness.trace.events.filter((entry) => entry.api === 'MutationObserver.observe').at(-1)
    })()
    assert.equal(nullEvent.target, null, 'a missing target is reported as null')
  } finally {
    harness.dispose()
  }
})

test('a throwing observer callback is traced and does not break delivery', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__after = 0;
       globalThis.__target = document.createElement('div');
       new MutationObserver(function () { throw new Error('observer exploded') }).observe(__target);
       new MutationObserver(function () { __after += 1 }).observe(__target);`,
    )
    deliver(harness)
    const exceptions = harness.trace.events.filter(
      (event) => event.kind === 'exception' && event.origin === 'observer',
    )
    assert.equal(exceptions.length, 1)
    assert.equal(exceptions[0].observer, 'MutationObserver')
    assert.match(String(exceptions[0].error?.message ?? exceptions[0].error), /observer exploded/)
    assert.equal(runGuest(harness, '__after'), 1, 'the healthy observer still delivered')
  } finally {
    harness.dispose()
  }
})

test('a non-function callback is ignored instead of thrown from', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__target = document.createElement('div');
       new MutationObserver(undefined).observe(__target);`,
    )
    deliver(harness)
    assert.equal(runGuest(harness, '1'), 1)
    assert.equal(
      harness.trace.events.filter((event) => event.kind === 'exception').length,
      0,
      'no exception event for an observer without a callback',
    )
  } finally {
    harness.dispose()
  }
})

test('the module can be installed standalone on a bare bridge', async () => {
  const harness = await createHarness({ modules: ['globals', 'timers', 'dom'] })
  try {
    installObservers(harness.bridge)
    const value = runGuest(harness, `typeof MutationObserver + ':' + new MutationObserver(function () {}).constructor.name`)
    assert.equal(value, 'function:MutationObserver')
  } finally {
    harness.dispose()
  }
})

test('a target whose geometry probe misbehaves falls back to profile geometry', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `globalThis.__entries = [];
       new IntersectionObserver(function (entries) {
         __entries.push([entries[0].boundingClientRect.width, entries[0].boundingClientRect.right]);
       }).observe({ getBoundingClientRect: function () { throw new Error('no layout') } });
       new IntersectionObserver(function (entries) {
         __entries.push([entries[0].intersectionRect.width, entries[0].rootBounds.height]);
       }).observe({ getBoundingClientRect: function () { return 5 } });
       new ResizeObserver(function (entries) {
         __entries.push([entries[0].contentRect.width, entries[0].contentRect.bottom]);
       }).observe({ getBoundingClientRect: 42 });`,
    )
    deliver(harness)
    const entries = JSON.parse(runGuest(harness, 'JSON.stringify(__entries)'))
    assert.deepEqual(entries, [
      [300, 300],
      [300, 150],
      [300, 150],
    ])
  } finally {
    harness.dispose()
  }
})

test('a target whose tagName getter throws is described as unknown', async () => {
  const harness = await observerHarness()
  try {
    runGuest(
      harness,
      `var hostile = {};
       Object.defineProperty(hostile, 'tagName', { get: function () { throw new Error('blocked') } });
       new MutationObserver(function () {}).observe(hostile);
       new MutationObserver(function () {}).unobserve(hostile);`,
    )
    const events = harness.trace.events.filter((event) => /^MutationObserver\./.test(String(event.api)))
    assert.deepEqual(events.map((event) => event.target), ['unknown', 'unknown'])
  } finally {
    harness.dispose()
  }
})
