/**
 * Virtual timers.
 *
 * Malware uses `setTimeout` for staging delays, debouncing, self-defending
 * loops and beaconing. Timers are driven by the virtual clock: a 5-minute delay
 * costs nothing in host time and is reproducible. Callbacks are invoked as guest
 * functions with the global object as `this`, exactly like browsers.
 */

export const meta = { id: 'timers', order: 65, requires: [] }

export function install(bridge) {
  const { ctx, clock } = bridge
  /** @type {Map<number, {handle?: object, source?: string, interval: boolean, args: unknown[]}>} */
  const registry = new Map()
  /** Timer ids whose callback is currently on the stack. */
  const active = new Set()
  const microtasks = []
  // queueMicrotask must share the promise job queue so FIFO ordering with
  // `Promise.resolve().then(...)` is preserved. This guest helper does the
  // enqueueing inside the engine; the sandbox drains the queue in settle().
  const microtaskHelper = ctx.unwrapResult(
    ctx.evalCode('(function (fn) { Promise.resolve().then(fn) })', 'ai4r-internal:microtask'),
  )
  bridge.onDispose(() => microtaskHelper.dispose())

  const toArgs = (handles, start) => {
    const values = []
    for (let i = start; i < handles.length; i += 1) values.push(bridge.value(handles, i))
    return values
  }

  /**
   * Dispose a callback handle, or defer it while its own call is on the stack.
   * QuickJS corrupts its handle list when a function handle is disposed while
   * the engine is still executing it, so a self-clearing timer may only mark
   * the entry and `finishCallback` completes the disposal afterwards.
   * @param {number} id
   * @param {{handle?: object, pendingDispose?: boolean}} entry
   */
  const releaseHandle = (id, entry) => {
    if (!entry?.handle) return
    if (active.has(id)) {
      entry.pendingDispose = true
      return
    }
    entry.handle.dispose()
    entry.handle = null
  }

  /**
   * Bookkeeping once a callback returned: a one-shot timer is always released
   * (it will never fire again) and a cleared interval finishes its deferred
   * disposal. Both happen after the guest call returned, never inside it.
   * @param {number} id
   * @param {object} entry
   */
  const finishCallback = (id, entry) => {
    active.delete(id)
    if (!entry.interval) {
      if (entry.handle) {
        entry.handle.dispose()
        entry.handle = null
      }
      if (registry.get(id) === entry) registry.delete(id)
    } else if (entry.pendingDispose) {
      releaseHandle(id, entry)
    }
  }

  const invoke = (entry, id) => {
    if (!entry) return
    active.add(id)
    try {
      if (entry.source !== undefined) {
        // Browsers accept a string of code as a timer callback.
        const result = ctx.evalCode(entry.source, 'about:blank')
        if (result.error) {
          const dumped = bridge.fromGuest(result.error)
          result.error.dispose()
          bridge.emit('exception', 'uncaught', { origin: 'timer', timerId: id, error: dumped })
        } else {
          result.value.dispose()
        }
        return
      }
      const argHandles = []
      try {
        for (const value of entry.args) argHandles.push(bridge.toGuest(value))
        const result = ctx.callFunction(entry.handle, bridge.global, argHandles)
        if (result.error) {
          const dumped = bridge.fromGuest(result.error)
          result.error.dispose()
          bridge.emit('exception', 'uncaught', { origin: 'timer', timerId: id, error: dumped })
        } else {
          result.value.dispose()
        }
      } finally {
        for (const handle of argHandles) {
          if (handle && typeof handle.dispose === 'function') handle.dispose()
        }
      }
    } finally {
      finishCallback(id, entry)
    }
  }

  const schedule = (name, interval) =>
    bridge.fn(name, 2, ({ args }) => {
      const callback = args[0]
      const delay = bridge.num(args, 1, 0)
      const callbackType = callback ? ctx.typeof(callback) : 'undefined'
      const id = clock.schedule({
        delay,
        interval,
        fn: () => {
          const entry = registry.get(id)
          if (!entry) return
          invoke(entry, id)
        },
      })

      const entry = {
        interval,
        args: toArgs(args, 2),
        handle: callbackType === 'function' ? callback.dup() : undefined,
        source: callbackType === 'string' ? bridge.str(args, 0) : undefined,
      }
      registry.set(id, entry)

      bridge.emit('timer', 'enter', {
        api: name,
        id,
        delay: Number.isFinite(delay) ? delay : 0,
        interval,
        callbackType,
      })
      bridge.clock.tick(0.05)
      return ctx.newNumber(id)
    })

  bridge.install(bridge.global, 'setTimeout', schedule('setTimeout', false), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(bridge.global, 'setInterval', schedule('setInterval', true), {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  const clear = (name) =>
    bridge.fn(name, 1, ({ args }) => {
      const id = bridge.num(args, 0, 0)
      const entry = registry.get(id)
      if (entry) {
        releaseHandle(id, entry)
        registry.delete(id)
      }
      clock.cancel(id)
      bridge.emit('timer', 'exit', { api: name, id })
      return ctx.undefined
    })

  bridge.install(bridge.global, 'clearTimeout', clear('clearTimeout'), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(bridge.global, 'clearInterval', clear('clearInterval'), {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  bridge.install(
    bridge.global,
    'requestAnimationFrame',
    bridge.fn('requestAnimationFrame', 1, ({ args }) => {
      const callback = args[0]
      const id = clock.schedule({
        delay: 16,
        interval: false,
        fn: () => {
          const entry = registry.get(id)
          if (!entry) return
          active.add(id)
          try {
            const timestamp = clock.performanceNow()
            const argHandle = bridge.toGuest(timestamp)
            const result = ctx.callFunction(entry.handle, bridge.global, [argHandle])
            argHandle.dispose()
            if (result.error) result.error.dispose()
            else result.value.dispose()
          } finally {
            finishCallback(id, entry)
          }
        },
      })
      const entry = { interval: false, args: [], handle: callback?.dup?.(), source: undefined }
      registry.set(id, entry)
      bridge.emit('timer', 'enter', { api: 'requestAnimationFrame', id, delay: 16 })
      return ctx.newNumber(id)
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    bridge.global,
    'cancelAnimationFrame',
    bridge.fn('cancelAnimationFrame', 1, ({ args }) => {
      const id = bridge.num(args, 0, 0)
      const entry = registry.get(id)
      if (entry) {
        releaseHandle(id, entry)
        registry.delete(id)
      }
      clock.cancel(id)
      return ctx.undefined
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    bridge.global,
    'queueMicrotask',
    bridge.fn('queueMicrotask', 1, ({ args }) => {
      const callback = args[0]
      if (callback && ctx.typeof(callback) === 'function') {
        const queued = ctx.callFunction(microtaskHelper, ctx.undefined, [callback])
        if (queued.error) {
          const dumped = bridge.fromGuest(queued.error)
          queued.error.dispose()
          bridge.emit('exception', 'uncaught', { origin: 'microtask', error: dumped })
        } else {
          queued.value.dispose()
        }
      }
      bridge.emit('timer', 'enter', { api: 'queueMicrotask' })
      return ctx.undefined
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    bridge.global,
    'requestIdleCallback',
    bridge.fn('requestIdleCallback', 2, ({ args }) => {
      const callback = args[0]
      const timeout = bridge.num(args, 1, 1) || 1
      const id = clock.schedule({
        delay: Math.min(timeout, 50),
        interval: false,
        fn: () => {
          const entry = registry.get(id)
          if (!entry) return
          active.add(id)
          const deadline = ctx.newObject()
          try {
            ctx.setProp(deadline, 'didTimeout', ctx.true)
            // `timeRemaining` has to be a guest function: `bridge.toGuest`
            // refuses host closures, and a plain `() => 0` used to make every
            // idle callback throw before it ran.
            ctx.setProp(deadline, 'timeRemaining', bridge.fn('timeRemaining', 0, () => ctx.newNumber(0)))
            const result = ctx.callFunction(entry.handle, bridge.global, [deadline])
            if (result.error) result.error.dispose()
            else result.value.dispose()
          } finally {
            deadline.dispose()
            finishCallback(id, entry)
          }
        },
      })
      registry.set(id, { interval: false, args: [], handle: callback?.dup?.() })
      return ctx.newNumber(id)
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    bridge.global,
    'cancelIdleCallback',
    bridge.fn('cancelIdleCallback', 1, ({ args }) => {
      const id = bridge.num(args, 0, 0)
      const entry = registry.get(id)
      if (entry) {
        releaseHandle(id, entry)
        registry.delete(id)
      }
      clock.cancel(id)
      return ctx.undefined
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  /** Drain queued microtasks; called by the sandbox between job batches. */
  bridge.drainMicrotasks = () => {
    while (microtasks.length > 0) {
      const handle = microtasks.shift()
      try {
        const result = ctx.callFunction(handle, ctx.undefined)
        if (result.error) {
          const dumped = bridge.fromGuest(result.error)
          result.error.dispose()
          bridge.emit('exception', 'uncaught', { origin: 'microtask', error: dumped })
        } else {
          result.value.dispose()
        }
      } finally {
        handle.dispose()
      }
    }
  }

  bridge.pendingTimers = () => registry.size

  bridge.onDispose(() => {
    for (const entry of registry.values()) entry.handle?.dispose()
    registry.clear()
    for (const handle of microtasks) handle.dispose()
    microtasks.length = 0
  })
}
