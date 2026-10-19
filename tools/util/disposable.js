/**
 * Handle lifetime helpers for quickjs-emscripten.
 *
 * quickjs-emscripten aborts the WASM module when a runtime is disposed while
 * handles are still alive (`list_empty(&rt->gc_obj_list)`). A malware sandbox
 * allocates thousands of handles, so every code path that creates one must go
 * through these helpers. `withHandles` guarantees LIFO disposal even on throw.
 */

/**
 * Run `fn` with a disposable bag. All handles added to the bag are disposed
 * when `fn` returns or throws. Returned handles must be transferred out with
 * `bag.keep(handle)` before returning them to the caller.
 *
 * @template T
 * @param {(bag: HandleBag) => T} fn
 * @returns {T}
 */
export function withHandles(fn) {
  const bag = new HandleBag()
  try {
    return fn(bag)
  } finally {
    bag.dispose()
  }
}

export class HandleBag {
  constructor() {
    /** @type {Array<{dispose: () => void}>} */
    this.handles = []
    this.disposed = false
  }

  /**
   * Track a handle; returns it unchanged for fluent use.
   * @template {{dispose: () => void}} H
   * @param {H} handle
   * @returns {H}
   */
  add(handle) {
    if (handle && typeof handle.dispose === 'function') this.handles.push(handle)
    return handle
  }

  /**
   * Stop tracking a handle so the caller owns it.
   * @template {{dispose: () => void}} H
   * @param {H} handle
   * @returns {H}
   */
  keep(handle) {
    const index = this.handles.indexOf(handle)
    if (index >= 0) this.handles.splice(index, 1)
    return handle
  }

  /** Track many handles at once. */
  addAll(handles) {
    for (const handle of handles) this.add(handle)
    return handles
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (let i = this.handles.length - 1; i >= 0; i -= 1) {
      const handle = this.handles[i]
      try {
        handle.dispose()
      } catch {
        /* a double dispose must never mask the original error */
      }
    }
    this.handles.length = 0
  }
}

/**
 * Dispose an arbitrary mix of handles, lifetimes and scopes.
 * @param {...unknown} values
 */
export function disposeAll(...values) {
  for (const value of values) {
    if (value && typeof value.dispose === 'function' && !value.disposed) {
      try {
        value.dispose()
      } catch {
        /* ignore */
      }
    }
  }
}
