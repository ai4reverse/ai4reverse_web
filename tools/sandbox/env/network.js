import { createSeededRandom } from '../../util/random.js'

/**
 * Virtual network.
 *
 * A malicious loader decides what to do next from HTTP responses: a 404 means
 * "not targeted", a 200 means "deliver stage 2". The sandbox must therefore
 * answer requests *asynchronously, deterministically and offline*: every request
 * is served from a registered handler, a route table or the default policy, and
 * the response arrives after a seeded virtual delay. No socket is ever opened —
 * an analysis run must not contact attacker infrastructure, and a repeat run
 * must produce byte-identical traces.
 *
 * `bridge.network` is the only network entry point. The browser-facing surfaces
 * (`xhr.js`, `fetch.js`, `websocket.js`) translate guest calls into
 * `network.request(spec)`; an analysis orchestrator programs the same service
 * through `registerHandler`, `setPolicy` and `setRoutes`.
 */

export const meta = { id: 'network', order: 82, requires: ['globals'] }

/** Behaviour applied when neither a handler nor a route matches. */
export const NETWORK_POLICIES = Object.freeze(['deny', 'empty', 'echo'])

/** Seeded latency band for a served response, in virtual milliseconds. */
export const NETWORK_LATENCY_MS = Object.freeze({ min: 40, max: 120 })

/** Canonical reason phrases; `statusText` must not be invented at call sites. */
const STATUS_TEXT = Object.freeze({
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
})

/** Default-offline failure code: a resolver failure, not a refused connection. */
const DENY_ERROR = 'net::ERR_NAME_NOT_RESOLVED'

/** Failure code when a caller-declared timeout expires before the response. */
const TIMEOUT_ERROR = 'net::ERR_TIMED_OUT'

/**
 * @typedef {object} NetworkRequest
 * @property {string} method upper-case method
 * @property {string} url absolute URL, resolved against the profile document
 * @property {Record<string, string>} headers lower-case header names
 * @property {string} body request body as text
 * @property {number} timeoutMs caller-declared timeout (0 = none); the service
 *   answers with `net::ERR_TIMED_OUT` when the response would arrive later.
 *   Surfaces that fire their own `timeout` event (XHR) leave it at 0.
 */

/**
 * @typedef {object} NetworkResult
 * @property {boolean} ok transport succeeded (`error` is empty)
 * @property {number} status HTTP status (0 for transport failures)
 * @property {string} statusText reason phrase
 * @property {Record<string, string>} headers lower-case header names
 * @property {string} bodyText response body decoded as UTF-8
 * @property {Uint8Array} bodyBytes raw response bytes
 * @property {string} error transport error code (empty on success)
 * @property {boolean} fromMock response came from a handler or a route
 * @property {number} durationMs virtual round-trip time
 * @property {string} url resolved request URL (responses report `url`)
 */

/**
 * Create the network service and install it as `bridge.network`.
 * Idempotent: `xhr.js`/`fetch.js`/`websocket.js` also call this, so the
 * browser surfaces keep working when they are installed on their own.
 *
 * @param {object} bridge host bridge
 * @param {{policy?: 'deny'|'empty'|'echo', seed?: string|number}} [options]
 */
export function ensureNetwork(bridge, options = {}) {
  if (bridge.network) return bridge.network
  const service = createNetworkService({ ...options, bridge })
  bridge.network = service
  bridge.onDispose(() => service.dispose())
  return service
}

export function install(bridge) {
  ensureNetwork(bridge)
}

/**
 * Build the network service.
 *
 * @param {object} options
 * @param {object} options.bridge host bridge (clock, profile, trace are used)
 * @param {'deny'|'empty'|'echo'} [options.policy] default response behaviour
 * @param {string|number} [options.seed] latency-model seed (default: profile seed)
 */
export function createNetworkService(options = {}) {
  const { bridge, policy = 'deny', seed } = options
  const clock = bridge.clock
  const rng = createSeededRandom(`${seed ?? bridge.profile?.seed ?? 'network'}::network`)

  let currentPolicy = normalizePolicy(policy)
  /** @type {Array<(request: NetworkRequest) => NetworkResult|object|null>} */
  const handlers = []
  /** @type {Array<{match: string|RegExp|Function, response: object}>} */
  let routes = []
  /** @type {Map<number, {timerId: number, onResult: ((result: NetworkResult) => void)|undefined}>} */
  const pending = new Map()
  let sequence = 0
  let requestCount = 0
  let bytesServed = 0

  const service = {
    get policy() {
      return currentPolicy
    },

    /** Replace the default response policy. */
    setPolicy(next) {
      currentPolicy = normalizePolicy(next)
      bridge.emit('sandbox', 'emit', { event: 'network.policy', policy: currentPolicy })
      return currentPolicy
    },

    /**
     * Register a response handler. The first handler returning a non-null
     * response wins; handlers are consulted before routes and the policy.
     * @param {(request: NetworkRequest) => object|null} fn
     * @returns {() => void} unregister
     */
    registerHandler(fn) {
      if (typeof fn !== 'function') throw new TypeError('registerHandler expects a function')
      handlers.push(fn)
      return () => {
        const index = handlers.indexOf(fn)
        if (index >= 0) handlers.splice(index, 1)
      }
    },

    /**
     * Install a route table. `match` is a substring, a RegExp tested against the
     * URL, or a predicate receiving the request. Routes are consulted after
     * registered handlers and before the policy.
     * @param {Array<{match: string|RegExp|Function, response: object}>} list
     */
    setRoutes(list) {
      if (!Array.isArray(list)) throw new TypeError('setRoutes expects an array')
      routes = list.map((route) => {
        if (!route || route.match === undefined) throw new TypeError('route requires a match')
        if (route.response === undefined) throw new TypeError('route requires a response')
        return { match: route.match, response: route.response }
      })
      return routes.length
    },

    /**
     * Resolve a request synchronously, without scheduling. Used by the WebSocket
     * surface (a connect attempt has no body round-trip) and by analysis code.
     */
    computeResult(spec) {
      const request = normalizeRequest(spec, bridge.profile)
      const { result } = buildPlan(request)
      requestCount += 1
      bridge.reportIOC('url', request.url)
      emitResult(request, result)
      return result
    },

    /**
     * Serve a request after the seeded virtual delay.
     * @param {object} spec `{method, url, headers, body, timeoutMs}`
     * @param {(result: NetworkResult) => void} [onResult]
     * @returns {{id: number, delayMs: number}} handle for `cancel()`
     */
    dispatch(spec, onResult) {
      const request = normalizeRequest(spec, bridge.profile)
      const plan = buildPlan(request)
      const timedOut = request.timeoutMs > 0 && request.timeoutMs < plan.delayMs
      const result = timedOut ? timedOutResult(request) : plan.result
      const delayMs = timedOut ? request.timeoutMs : plan.delayMs
      sequence += 1
      const id = sequence
      requestCount += 1
      bridge.reportIOC('url', request.url)
      const timerId = clock.schedule({
        delay: delayMs,
        interval: false,
        fn: () => {
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          emitResult(request, result)
          try {
            entry.onResult?.(result)
          } catch (error) {
            bridge.emit('net', 'error', {
              url: request.url,
              stage: 'delivery',
              error: error?.message ?? String(error),
            })
          }
        },
      })
      pending.set(id, { timerId, onResult })
      return { id, delayMs }
    },

    /**
     * Serve a request and settle a host promise on the virtual clock.
     * @param {object} spec
     * @returns {Promise<NetworkResult>}
     */
    request(spec) {
      return new Promise((resolve) => {
        service.dispatch(spec, resolve)
      })
    },

    /** Drop a scheduled request; its result is never delivered. */
    cancel(id) {
      const entry = pending.get(id)
      if (!entry) return false
      pending.delete(id)
      clock.cancel(entry.timerId)
      return true
    },

    stats() {
      return {
        policy: currentPolicy,
        requests: requestCount,
        pending: pending.size,
        handlers: handlers.length,
        routes: routes.length,
        bytesServed,
      }
    },

    dispose() {
      for (const entry of pending.values()) clock.cancel(entry.timerId)
      pending.clear()
      handlers.length = 0
      routes = []
    },
  }

  /**
   * Decide the response and the virtual delay for one request.
   * @param {NetworkRequest} request
   * @returns {{result: NetworkResult, delayMs: number}}
   */
  function buildPlan(request) {
    for (const handler of handlers) {
      let raw
      try {
        raw = handler({ ...request })
      } catch (error) {
        bridge.emit('net', 'error', {
          url: request.url,
          stage: 'handler',
          error: error?.message ?? String(error),
        })
        return planned(failedResult(request, 'net::ERR_FAILED'))
      }
      if (raw) return planned(responseOf(raw, request, true))
    }
    for (const route of routes) {
      if (routeMatches(route.match, request)) return planned(responseOf(route.response, request, true))
    }
    if (currentPolicy === 'echo') {
      return planned(
        responseOf(
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: JSON.stringify({ method: request.method, url: request.url, body: request.body }),
          },
          request,
          false,
        ),
      )
    }
    if (currentPolicy === 'empty') return planned(responseOf({ status: 204 }, request, false))
    return planned(failedResult(request, DENY_ERROR))
  }

  /**
   * Pin the round-trip time: an explicit `durationMs` from a handler wins,
   * otherwise the seeded latency model decides.
   * @param {NetworkResult} result mutated in place
   * @returns {{result: NetworkResult, delayMs: number}}
   */
  function planned(result) {
    const delayMs = Number.isFinite(result.durationMs) ? result.durationMs : nextLatency()
    result.durationMs = delayMs
    return { result, delayMs }
  }

  function nextLatency() {
    return rng.int(NETWORK_LATENCY_MS.min, NETWORK_LATENCY_MS.max)
  }

  function failedResult(request, error) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      bodyText: '',
      bodyBytes: new Uint8Array(0),
      error,
      fromMock: false,
      durationMs: NaN,
      url: request.url,
    }
  }

  function timedOutResult(request) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      bodyText: '',
      bodyBytes: new Uint8Array(0),
      error: TIMEOUT_ERROR,
      fromMock: false,
      durationMs: request.timeoutMs,
      url: request.url,
    }
  }

  function emitResult(request, result) {
    bytesServed += result.bodyBytes.length
    bridge.emit('net', 'after', {
      method: request.method,
      url: request.url,
      status: result.status,
      ok: result.ok,
      error: result.error,
      durationMs: result.durationMs,
      bodyLength: result.bodyBytes.length,
      fromMock: result.fromMock,
    })
  }

  return service
}

/**
 * Compile a guest factory and call it with the host bindings injected.
 *
 * The network surfaces are written as guest code (private per-instance state in
 * closures, event dispatch, promise plumbing) and reach the host only through
 * the injected bindings, which keeps every host handle explicit. The factory
 * receives a single `host` object, so a missing binding fails immediately
 * instead of shifting positional arguments.
 *
 * @param {object} bridge
 * @param {string} source guest expression `(function(host){ ... })`
 * @param {Record<string, object|unknown>} [bindings] handles or plain values
 * @returns {object} owned handle to the factory result
 */
export function createGuestModule(bridge, source, bindings = {}) {
  const { ctx } = bridge
  const compiled = ctx.unwrapResult(ctx.evalCode(String(source), 'ai4r-internal:network'))
  const host = bridge.obj(bindings)
  try {
    const call = ctx.callFunction(compiled, ctx.undefined, [host])
    if (call.error) {
      const dumped = bridge.fromGuest(call.error)
      call.error.dispose()
      throw new Error(`network guest module failed: ${dumped?.message ?? dumped}`)
    }
    return call.value
  } finally {
    compiled.dispose()
    host.dispose()
  }
}

/**
 * Host bindings shared by every guest network surface: tracing, the virtual
 * clock, one-shot guest callbacks and text/byte conversion.
 *
 * Scheduled callbacks are tracked so a cancelled timer releases its duplicated
 * guest function, and every open one is released at teardown.
 *
 * @param {object} bridge
 * @returns {{__emit: object, __now: object, __schedule: object, __cancel: object, __uncaught: object, __encode: object, __decode: object}}
 */
export function createSurfaceBindings(bridge) {
  const { ctx, clock } = bridge
  /** @type {Map<number, object>} timer id -> guest callback handle */
  const scheduled = new Map()

  const callGuestOnce = (handle) => {
    try {
      const call = ctx.callFunction(handle, ctx.undefined)
      if (call.error) {
        const dumped = bridge.fromGuest(call.error)
        call.error.dispose()
        bridge.emit('exception', 'uncaught', { origin: 'network', error: dumped })
      } else {
        call.value.dispose()
      }
    } finally {
      handle.dispose()
    }
  }

  const __schedule = bridge.fn('__schedule', 2, ({ args }) => {
    const delay = bridge.num(args, 0, 0)
    const callback = args[1]
    const handle = callback && ctx.typeof(callback) === 'function' ? callback.dup() : null
    const timerId = clock.schedule({
      delay,
      interval: false,
      fn: () => {
        const pending = scheduled.get(timerId)
        scheduled.delete(timerId)
        if (pending) callGuestOnce(pending)
      },
    })
    if (handle) {
      if (timerId === 0) handle.dispose()
      else scheduled.set(timerId, handle)
    }
    return ctx.newNumber(timerId)
  })

  bridge.onDispose(() => {
    for (const handle of scheduled.values()) {
      try {
        handle.dispose()
      } catch {
        /* already gone */
      }
    }
    scheduled.clear()
  })

  return {
    __emit: bridge.fn('__emit', 1, ({ args }) => {
      const payload = bridge.value(args, 0)
      if (payload && typeof payload === 'object') bridge.emit('api', 'before', payload)
      return ctx.undefined
    }),
    __now: bridge.fn('__now', 0, () => ctx.newNumber(clock.performanceNow())),
    __schedule,
    __cancel: bridge.fn('__cancel', 1, ({ args }) => {
      const id = bridge.num(args, 0, 0)
      const handle = scheduled.get(id)
      if (handle) {
        scheduled.delete(id)
        handle.dispose()
      }
      return clock.cancel(id) ? ctx.true : ctx.false
    }),
    __uncaught: bridge.fn('__uncaught', 1, ({ args }) => {
      bridge.emit('exception', 'uncaught', { origin: 'network', error: bridge.fromGuest(args[0]) })
      return ctx.undefined
    }),
    __encode: bridge.fn('__encode', 1, ({ args }) =>
      ctx.newString(Buffer.from(bridge.str(args, 0, ''), 'utf8').toString('latin1')),
    ),
    __decode: bridge.fn('__decode', 1, ({ args }) => {
      const bytes = readArrayBufferBytes(ctx, args[0])
      return ctx.newString(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'))
    }),
  }
}

/**
 * Rename and register every method and accessor reachable from a guest
 * constructor as native: `fn.name` becomes the WebIDL member name and
 * `Function.prototype.toString` (including
 * `Object.getOwnPropertyDescriptor(...).get.toString()`) reports `[native code]`
 * instead of the shim source. Without this the surface is trivially detectable.
 *
 * @param {object} bridge
 * @param {object} ctorHandle guest constructor
 */
export function adoptGuestSurface(bridge, ctorHandle) {
  const { ctx, stealth } = bridge
  if (!stealth || !ctorHandle) return
  const inspect = ctx.unwrapResult(
    ctx.evalCode(
      `(function(ctor) {
        function rename(fn, name) {
          if (typeof fn !== 'function') return;
          try {
            Object.defineProperty(fn, 'name', { value: name, configurable: true });
          } catch (error) {
            /* function names are configurable in every engine we emulate */
          }
        }
        var out = [];
        var proto = ctor.prototype;
        if (proto) {
          Object.getOwnPropertyNames(proto).forEach(function(key) {
            if (key === 'constructor') return;
            var descriptor = Object.getOwnPropertyDescriptor(proto, key);
            if (descriptor.get) {
              rename(descriptor.get, 'get ' + key);
              out.push(['get ' + key, descriptor.get]);
              if (descriptor.set) {
                rename(descriptor.set, 'set ' + key);
                out.push(['set ' + key, descriptor.set]);
              }
            } else if (typeof descriptor.value === 'function') {
              rename(descriptor.value, key);
              out.push([key, descriptor.value]);
            }
          });
        }
        return out;
      })`,
      'ai4r-internal:network',
    ),
  )
  try {
    const call = ctx.callFunction(inspect, ctx.undefined, [ctorHandle])
    if (call.error) {
      call.error.dispose()
      return
    }
    const list = call.value
    const lengthHandle = ctx.getProp(list, 'length')
    const length = ctx.getNumber(lengthHandle)
    lengthHandle.dispose()
    for (let index = 0; index < length; index += 1) {
      const pair = ctx.getProp(list, index)
      const nameHandle = ctx.getProp(pair, 0)
      const name = ctx.getString(nameHandle)
      nameHandle.dispose()
      const fnHandle = ctx.getProp(pair, 1)
      bridge.adopt(fnHandle, name)
      fnHandle.dispose()
      pair.dispose()
    }
    list.dispose()
  } finally {
    inspect.dispose()
  }
}

/**
 * Guest event-target helpers shared by `xhr.js` and `websocket.js`: private
 * listener lists, DOM-shaped event objects, exception isolation between
 * listeners, and the `on<type>` handler slot that keeps registration order.
 * The guest code that includes this snippet must have `__now` and `__uncaught`
 * bindings in scope.
 */
export const EVENT_TARGET_SOURCE = `
  function newTarget(instance) {
    return { instance: instance, listeners: Object.create(null), handlers: Object.create(null) };
  }

  function makeEvent(target, type, extra) {
    var event = {
      type: type,
      target: target.instance,
      currentTarget: target.instance,
      srcElement: target.instance,
      bubbles: false,
      cancelable: false,
      composed: false,
      defaultPrevented: false,
      eventPhase: 2,
      isTrusted: true,
      timeStamp: __now()
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) event[key] = extra[key];
      }
    }
    event.preventDefault = function preventDefault() {};
    event.stopPropagation = function stopPropagation() {};
    event.stopImmediatePropagation = function stopImmediatePropagation() {};
    return event;
  }

  function notify(target, event) {
    var listeners = target.listeners[event.type];
    if (!listeners || listeners.length === 0) return;
    var snapshot = listeners.slice();
    for (var index = 0; index < snapshot.length; index += 1) {
      var callback = snapshot[index].fn;
      if (typeof callback !== 'function') continue;
      try {
        callback.call(target.instance, event);
      } catch (error) {
        __uncaught(error);
      }
    }
  }

  function fire(target, type, extra) {
    notify(target, makeEvent(target, type, extra));
  }

  function addListenerImpl(type, callback) {
    var target = stateOf(this);
    var key = String(type);
    if (!target.listeners[key]) target.listeners[key] = [];
    target.listeners[key].push({ kind: 'listener', fn: callback });
  }

  function removeListenerImpl(type, callback) {
    var target = stateOf(this);
    var listeners = target.listeners[String(type)];
    if (!listeners) return;
    for (var index = listeners.length - 1; index >= 0; index -= 1) {
      if (listeners[index].fn === callback) listeners.splice(index, 1);
    }
  }

  function dispatchEventImpl(event) {
    var target = stateOf(this);
    if (!event || typeof event.type !== 'string') {
      throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
    }
    if (event.target === undefined || event.target === null) event.target = target.instance;
    if (event.currentTarget === undefined || event.currentTarget === null) event.currentTarget = target.instance;
    notify(target, event);
    return true;
  }

  function handlerOf(instance, type) {
    var handler = stateOf(instance).handlers[type];
    return typeof handler === 'function' ? handler : null;
  }

  function setHandlerFor(instance, type, value) {
    var target = stateOf(instance);
    var listeners = target.listeners[type] || (target.listeners[type] = []);
    var slot = null;
    for (var index = 0; index < listeners.length; index += 1) {
      if (listeners[index].kind === 'handler') {
        slot = listeners[index];
        break;
      }
    }
    if (!slot) {
      slot = { kind: 'handler', fn: null };
      listeners.push(slot);
    }
    var handler = typeof value === 'function' ? value : null;
    slot.fn = handler;
    target.handlers[type] = handler;
  }
`

/**
 * Guest helpers shared by the body-carrying surfaces (`xhr.js`, `fetch.js`):
 * rebuild raw bytes from the latin-1 body string and expose the Blob-shaped
 * body object used until a DOM module owns the real `Blob`. The guest code that
 * includes this snippet must have a `__decode(arrayBuffer)` binding in scope.
 */
export const BODY_HELPERS_SOURCE = `
  function bytesOf(binary) {
    var view = new Uint8Array(binary ? binary.length : 0);
    for (var index = 0; index < view.length; index += 1) view[index] = binary.charCodeAt(index) & 255;
    return view;
  }

  function makeBlob(view, type) {
    var blob = {
      size: view.length,
      type: type || ''
    };
    blob.slice = function slice(start, end) {
      return makeBlob(view.slice(start, end), blob.type);
    };
    blob.text = function text() {
      return Promise.resolve(__decode(view.buffer));
    };
    blob.arrayBuffer = function arrayBuffer() {
      return Promise.resolve(view.buffer.slice(0));
    };
    return blob;
  }
`

/**
 * Read a guest `ArrayBuffer`/typed-array handle as host bytes.
 * @param {object} ctx QuickJSContext
 * @param {object} handle guest handle (owned by the caller)
 * @returns {Uint8Array}
 */
export function readArrayBufferBytes(ctx, handle) {
  if (!handle) return new Uint8Array(0)
  try {
    const buffer = ctx.getArrayBuffer(handle)
    const copy = new Uint8Array(buffer.value.slice(0))
    buffer.dispose()
    return copy
  } catch {
    return new Uint8Array(0)
  }
}

/**
 * Serialise a result for the guest.
 *
 * Byte bodies cross as a latin-1 string rather than an `ArrayBuffer`: an
 * ArrayBuffer passed as a host-to-guest argument leaks a quickjs handle (the
 * runtime aborts at teardown), and guest code rebuilds the bytes from the
 * string in a handful of instructions anyway.
 *
 * @param {NetworkResult} result
 * @returns {object} guest-safe result (`bodyBinary` is latin-1 of `bodyBytes`)
 */
export function networkResultForGuest(result) {
  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    bodyText: result.bodyText,
    bodyBinary: Buffer.from(result.bodyBytes).toString('latin1'),
    error: result.error,
    fromMock: result.fromMock,
    durationMs: result.durationMs,
    url: result.url,
  }
}

/** Resolve a request URL against the profile document, like a browser would. */
export function resolveNetworkUrl(url, base) {
  const text = String(url ?? '')
  try {
    return base ? new URL(text, base).href : new URL(text).href
  } catch {
    return text
  }
}

function routeMatches(match, request) {
  if (typeof match === 'string') return match.length > 0 && request.url.includes(match)
  if (match instanceof RegExp) return match.test(request.url)
  if (typeof match === 'function') return Boolean(match(request))
  return false
}

function normalizePolicy(policy) {
  const value = String(policy ?? '')
  if (!NETWORK_POLICIES.includes(value)) {
    throw new TypeError(`unknown network policy "${value}"; expected one of ${NETWORK_POLICIES.join(', ')}`)
  }
  return value
}

/**
 * @param {object} spec
 * @param {object} [profile]
 * @returns {NetworkRequest}
 */
function normalizeRequest(spec = {}, profile) {
  const method = String(spec.method ?? 'GET').toUpperCase()
  const url = resolveNetworkUrl(spec.url ?? '', profile?.href)
  const body =
    spec.body === undefined || spec.body === null
      ? ''
      : typeof spec.body === 'string'
        ? spec.body
        : String(spec.body)
  const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.max(0, Math.trunc(spec.timeoutMs)) : 0
  return { method, url, headers: normalizeHeaders(spec.headers), body, timeoutMs }
}

/** Normalise `{name: value}`, `[[name, value]]` or `Headers`-like input. */
function normalizeHeaders(input) {
  const headers = {}
  if (!input) return headers
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (!Array.isArray(pair) || pair.length < 2) continue
      appendHeader(headers, pair[0], pair[1])
    }
    return headers
  }
  if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) appendHeader(headers, name, value)
  }
  return headers
}

function appendHeader(headers, name, value) {
  if (value === undefined || value === null) return
  const key = String(name).toLowerCase()
  const text = String(value)
  headers[key] = headers[key] === undefined ? text : `${headers[key]}, ${text}`
}

/**
 * Turn a handler/route response into the full result shape.
 * @param {object} raw
 * @param {NetworkRequest} request
 * @param {boolean} fromMock
 * @returns {NetworkResult}
 */
function responseOf(raw, request, fromMock) {
  const error = raw.error ? String(raw.error) : ''
  const status = Number.isFinite(raw.status) ? Math.trunc(raw.status) : error ? 0 : 200
  const bodyBytes =
    typeof raw.bodyText === 'string' && raw.bodyBytes === undefined
      ? toBytes(undefined, raw.bodyText)
      : toBytes(raw.bodyBytes, '')
  const bodyText = typeof raw.bodyText === 'string' ? raw.bodyText : bytesToText(bodyBytes)
  const ok = error ? false : raw.ok === undefined ? true : Boolean(raw.ok)
  const statusText = typeof raw.statusText === 'string' ? raw.statusText : (STATUS_TEXT[status] ?? '')
  return {
    ok,
    status,
    statusText,
    headers: normalizeHeaders(raw.headers),
    bodyText,
    bodyBytes,
    error,
    fromMock,
    durationMs: Number.isFinite(raw.durationMs) ? Math.max(0, Math.trunc(raw.durationMs)) : NaN,
    url: typeof raw.url === 'string' ? raw.url : request.url,
  }
}

function toBytes(input, fallbackText) {
  if (input instanceof Uint8Array) return new Uint8Array(input)
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0))
  if (Array.isArray(input)) return Uint8Array.from(input)
  if (typeof input === 'string') return new Uint8Array(Buffer.from(input, 'utf8'))
  return new Uint8Array(Buffer.from(fallbackText ?? '', 'utf8'))
}

function bytesToText(bytes) {
  if (!bytes || bytes.length === 0) return ''
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
}
