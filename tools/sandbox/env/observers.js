/**
 * Observer and messaging surfaces.
 *
 * `MutationObserver`, `IntersectionObserver` and `ResizeObserver` are ordinary
 * browser APIs whose absence is a VM tell. Samples use them for anti-analysis
 * (e.g. "am I being scrolled/rendered?"). `MessageChannel` lives in misc.js
 * because it is a messaging surface, not a rendering observer.
 *
 * Observers here are deliberately benign: they deliver one synthetic, coherent
 * entry after `observe()` (scheduled on the virtual clock) instead of modelling
 * real DOM mutations. That keeps samples that gate on delivery running without
 * pretending the sandbox renders pixels.
 */

export const meta = { id: 'observers', order: 108, requires: ['dom'] }

export function install(bridge) {
  const { ctx, clock } = bridge

  const schedule = (fn) => clock.schedule({ delay: 0, interval: false, fn })

  /**
   * Build an observer class: instances get observe/unobserve/disconnect/
   * takeRecords and a callback that fires once with a synthetic entry list.
   */
  const makeObserver = (name, entryFactory) => {
    const init = bridge.fn('init', 2, ({ args }) => {
      const self = args[0]
      const callback = args[1]
      let callbackHandle = callback && ctx.typeof(callback) === 'function' ? callback.dup() : null
      let pending = []
      bridge.onDispose(() => callbackHandle?.dispose())

      const fire = () => {
        if (!callbackHandle || pending.length === 0) return
        const entries = bridge.arr(pending)
        pending = []
        const result = ctx.callFunction(callbackHandle, ctx.undefined, [entries, self])
        if (result.error) {
          const dumped = bridge.fromGuest(result.error)
          result.error.dispose()
          bridge.emit('exception', 'error', { origin: 'observer', observer: name, error: dumped })
        } else {
          result.value.dispose()
        }
      }

      bridge.install(self, 'observe', bridge.fn('observe', 2, ({ args: observeArgs }) => {
        const target = observeArgs[0]
        const options = bridge.value(observeArgs, 1) ?? {}
        bridge.emit('api', 'before', { api: `${name}.observe`, target: describeTarget(bridge, target) })
        pending.push(entryFactory(bridge, target, options))
        schedule(fire)
        return ctx.undefined
      }), { enumerable: true, configurable: true, writable: true })

      bridge.install(self, 'unobserve', bridge.fn('unobserve', 1, ({ args: unobserveArgs }) => {
        bridge.emit('api', 'before', { api: `${name}.unobserve`, target: describeTarget(bridge, unobserveArgs[0]) })
        pending = []
        return ctx.undefined
      }), { enumerable: true, configurable: true, writable: true })

      bridge.install(self, 'disconnect', bridge.fn('disconnect', 0, () => {
        pending = []
        return ctx.undefined
      }), { enumerable: true, configurable: true, writable: true })

      bridge.install(self, 'takeRecords', bridge.fn('takeRecords', 0, () => {
        const records = bridge.arr(pending)
        pending = []
        return records
      }), { enumerable: true, configurable: true, writable: true })

      return ctx.undefined
    })

    const ctor = bridge.nativeConstructor({
      name,
      arity: 1,
      bindings: { __init: init },
      body: '__init(self, a0);',
    })
    bridge.install(ctx.global, name, ctor, { enumerable: true, configurable: true, writable: true })
    return ctor
  }

  makeObserver('MutationObserver', (bridge, target) =>
    bridge.obj({
      type: 'childList',
      target: target ?? null,
      addedNodes: bridge.arr([]),
      removedNodes: bridge.arr([]),
      attributeName: null,
      oldValue: null,
      previousSibling: null,
      nextSibling: null,
    }),
  )

  makeObserver('IntersectionObserver', (bridge, target) =>
    bridge.obj({
      time: bridge.clock.performanceNow(),
      target: target ?? null,
      isIntersecting: true,
      intersectionRatio: 1,
      boundingClientRect: rectOf(bridge, target),
      intersectionRect: rectOf(bridge, target),
      rootBounds: rectOf(bridge, target),
    }),
  )

  makeObserver('ResizeObserver', (bridge, target) =>
    bridge.obj({
      target: target ?? null,
      contentRect: rectOf(bridge, target),
      borderBoxSize: bridge.arr([{ inlineSize: 300, blockSize: 150 }]),
      contentBoxSize: bridge.arr([{ inlineSize: 300, blockSize: 150 }]),
      devicePixelContentBoxSize: bridge.arr([{ inlineSize: 300, blockSize: 150 }]),
    }),
  )

}

function rectOf(bridge, target) {
  const { ctx } = bridge
  if (target) {
    try {
      const rect = ctx.getProp(target, 'getBoundingClientRect')
      if (ctx.typeof(rect) === 'function') {
        const call = ctx.callFunction(rect, target, [])
        rect.dispose()
        if (!call.error && ctx.typeof(call.value) === 'object') {
          const value = bridge.fromGuest(call.value)
          call.value.dispose()
          if (value && typeof value === 'object') return bridge.obj(value)
        } else {
          call.error?.dispose()
          call.value?.dispose()
        }
      } else {
        rect.dispose()
      }
    } catch {
      /* fall through to profile geometry */
    }
  }
  return bridge.obj({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 300,
    bottom: 150,
    width: 300,
    height: 150,
  })
}

function describeTarget(bridge, target) {
  if (!target) return null
  try {
    const tag = bridge.get(target, 'tagName')
    return tag ? String(tag).toLowerCase() : 'unknown'
  } catch {
    return 'unknown'
  }
}
