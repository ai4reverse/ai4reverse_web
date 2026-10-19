/**
 * `performance` surface.
 *
 * `performance.now()` must be monotonic, sub-millisecond and consistent with
 * `Date.now()` under the same virtual clock. Some loaders compare the two to
 * detect virtualised time; both are derived from one clock here, so the
 * relationship `Date.now() - performance.timeOrigin ≈ performance.now()` holds
 * exactly.
 */

export const meta = { id: 'performance', order: 75, requires: ['globals'] }

export function install(bridge) {
  const { ctx, clock, profile } = bridge
  const performance = bridge.obj()

  bridge.install(performance, 'now', bridge.fn('now', 0, () => ctx.newNumber(clock.performanceNow())), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(performance, 'timeOrigin', ctx.newNumber(clock.timeOrigin), {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  bridge.install(performance, 'onresourcetimingbufferfull', ctx.null, {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  const timing = bridge.obj({
    navigationStart: clock.timeOrigin,
    unloadEventStart: 0,
    unloadEventEnd: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: clock.timeOrigin + 4,
    domainLookupStart: clock.timeOrigin + 6,
    domainLookupEnd: clock.timeOrigin + 18,
    connectStart: clock.timeOrigin + 18,
    connectEnd: clock.timeOrigin + 44,
    secureConnectionStart: clock.timeOrigin + 30,
    requestStart: clock.timeOrigin + 46,
    responseStart: clock.timeOrigin + 78,
    responseEnd: clock.timeOrigin + 132,
    domLoading: clock.timeOrigin + 140,
    domInteractive: clock.timeOrigin + 420,
    domContentLoadedEventStart: clock.timeOrigin + 421,
    domContentLoadedEventEnd: clock.timeOrigin + 430,
    domComplete: clock.timeOrigin + 610,
    loadEventStart: clock.timeOrigin + 611,
    loadEventEnd: clock.timeOrigin + 615,
  })
  bridge.install(performance, 'timing', timing, { enumerable: true, configurable: true, writable: false })
  bridge.install(performance, 'navigation', bridge.obj({
    type: 'navigate',
    redirectCount: 0,
  }), { enumerable: true, configurable: true, writable: false })
  bridge.install(performance, 'memory', bridge.obj({
    jsHeapSizeLimit: 2_174_617_600,
    totalJSHeapSize: 18_345_678,
    usedJSHeapSize: 14_876_543,
  }), { enumerable: true, configurable: true, writable: false })

  // Chrome returns `undefined` from mark/measure and exposes the entries via
  // getEntries*. Keep a bounded, per-run entry list so samples that read their
  // own measurements see them.
  const entries = []
  const recordEntry = (name, entryType, startTime, duration) => {
    if (entries.length >= 2000) entries.shift()
    entries.push({ name: String(name ?? ''), entryType, startTime, duration })
  }
  bridge.install(performance, 'getEntries', bridge.fn('getEntries', 0, () => bridge.arr(entries)), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(performance, 'getEntriesByType', bridge.fn('getEntriesByType', 1, ({ args }) => {
    const type = bridge.str(args, 0, '')
    return bridge.arr(entries.filter((entry) => entry.entryType === type))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(performance, 'getEntriesByName', bridge.fn('getEntriesByName', 1, ({ args }) => {
    const name = bridge.str(args, 0, '')
    return bridge.arr(entries.filter((entry) => entry.name === name))
  }), { enumerable: true, configurable: true, writable: true })
  for (const name of ['clearMarks', 'clearMeasures', 'clearResourceTimings']) {
    bridge.install(performance, name, bridge.fn(name, 1, () => {
      if (name === 'clearMarks') {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index].entryType === 'mark') entries.splice(index, 1)
        }
      } else if (name === 'clearMeasures') {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index].entryType === 'measure') entries.splice(index, 1)
        }
      }
      return ctx.undefined
    }), { enumerable: true, configurable: true, writable: true })
  }

  bridge.install(performance, 'mark', bridge.fn('mark', 2, ({ args }) => {
    const name = bridge.str(args, 0)
    bridge.emit('api', 'before', { api: 'performance.mark', name })
    recordEntry(name, 'mark', clock.performanceNow(), 0)
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(performance, 'measure', bridge.fn('measure', 3, ({ args }) => {
    const name = bridge.str(args, 0)
    bridge.emit('api', 'before', { api: 'performance.measure', name })
    recordEntry(name, 'measure', 0, 0)
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(performance, 'setResourceTimingBufferSize', bridge.fn('setResourceTimingBufferSize', 1, () => ctx.undefined), {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  bridge.install(performance, 'toJSON', bridge.fn('toJSON', 0, () => {
    return bridge.obj({ timeOrigin: clock.timeOrigin })
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(bridge.global, 'performance', performance, {
    enumerable: true,
    configurable: true,
    writable: false,
  })

  // Chrome exposes PerformanceObserver; a plausible no-op implementation is
  // enough for feature checks as long as callbacks never fire unexpectedly.
  const observerProto = bridge.obj({ supportedEntryTypes: bridge.arr(['mark', 'measure', 'navigation', 'resource', 'paint']) })
  const PerformanceObserver = bridge.fn('PerformanceObserver', 1, ({ args }) => {
    const instance = bridge.obj()
    bridge.install(instance, 'observe', bridge.fn('observe', 1, () => ctx.undefined), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    bridge.install(instance, 'disconnect', bridge.fn('disconnect', 0, () => ctx.undefined), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    bridge.install(instance, 'takeRecords', bridge.fn('takeRecords', 0, () => bridge.arr([])), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    void args
    return instance
  }, { isConstructor: true })
  bridge.install(PerformanceObserver, 'prototype', observerProto, {
    enumerable: false,
    configurable: false,
    writable: false,
  })
  bridge.install(PerformanceObserver, 'supportedEntryTypes', bridge.arr(['mark', 'measure', 'navigation', 'resource', 'paint']), {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  bridge.install(bridge.global, 'PerformanceObserver', PerformanceObserver, {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  void profile
}
