/**
 * `fetch`, `Headers`, `Request` and `Response`.
 *
 * Modern loaders prefer `fetch(...).then(r => r.text())`, so the promise must
 * stay pending until the response "arrives" and must settle exactly when the
 * virtual clock says it does. `fetch` returns a host-created guest promise
 * (`bridge.deferred`) that the network service settles after the seeded
 * virtual delay: reject with `TypeError('Failed to fetch')` on a transport
 * failure, resolve with a `Response` when a handler, route or policy answers.
 * The three interface classes live in guest code (per-instance private slots,
 * WebIDL-shaped accessors) and are registered as native so brand checks pass.
 */
import { HandleBag } from '../../util/disposable.js'
import {
  adoptGuestSurface,
  BODY_HELPERS_SOURCE,
  createGuestModule,
  createSurfaceBindings,
  ensureNetwork,
  networkResultForGuest,
  resolveNetworkUrl,
} from './network.js'

export const meta = { id: 'fetch', order: 84, requires: ['globals'] }

export function install(bridge) {
  const { ctx } = bridge
  const network = ensureNetwork(bridge)
  /** Handles retained for the lifetime of the sandbox. */
  const retained = []
  const retain = (handle) => {
    retained.push(handle)
    return handle
  }

  const bindings = {
    ...createSurfaceBindings(bridge),
    __resolve: bridge.fn('__resolve', 1, ({ args }) =>
      ctx.newString(resolveNetworkUrl(bridge.str(args, 0, ''), bridge.profile?.href)),
    ),
  }

  const guest = createGuestModule(bridge, FETCH_SOURCE, bindings)
  const requestSpec = retain(ctx.getProp(guest, 'requestSpec'))
  const createResponse = retain(ctx.getProp(guest, 'createResponse'))
  const makeNetworkError = retain(ctx.getProp(guest, 'makeNetworkError'))

  for (const name of ['Headers', 'Request', 'Response']) {
    const ctor = ctx.getProp(guest, name)
    bridge.install(bridge.global, name, ctor, { enumerable: true, configurable: true, writable: true })
    bridge.adopt(ctor, name)
    adoptGuestSurface(bridge, ctor)
    ctor.dispose()
  }
  guest.dispose()

  const invokeGuest = (fnHandle, argHandles = []) => {
    const call = ctx.callFunction(fnHandle, ctx.undefined, argHandles)
    if (call.error) {
      const error = bridge.fromGuest(call.error)
      call.error.dispose()
      return { ok: false, error }
    }
    return { ok: true, handle: call.value }
  }

  /**
   * Reject a fetch promise with a browser-shaped TypeError.
   * @param {object} deferred
   * @param {string} message
   */
  const rejectFetch = (deferred, message) => {
    const bag = new HandleBag()
    try {
      const created = invokeGuest(makeNetworkError, [bag.add(bridge.toGuest(String(message)))])
      if (!created.ok) return
      deferred.reject(created.handle)
      created.handle.dispose()
    } finally {
      bag.dispose()
    }
  }

  const fetchImpl = bridge.fn('fetch', 1, ({ args }) => {
    const deferred = bridge.deferred()
    const parsed = invokeGuest(requestSpec, [args[0] ?? ctx.undefined, args[1] ?? ctx.undefined])
    if (!parsed.ok) {
      rejectFetch(deferred, parsed.error?.message ?? 'Failed to fetch')
      return deferred.handle
    }
    const spec = bridge.fromGuest(parsed.handle)
    parsed.handle.dispose()
    bridge.emit('api', 'before', {
      api: 'fetch',
      method: spec.method,
      url: spec.url,
      bodyLength: typeof spec.body === 'string' ? spec.body.length : 0,
    })
    network.dispatch(spec, (result) => {
      if (result.error) {
        rejectFetch(deferred, 'Failed to fetch')
        return
      }
      const bag = new HandleBag()
      try {
        const created = invokeGuest(createResponse, [bag.add(bridge.toGuest(networkResultForGuest(result)))])
        if (!created.ok) {
          rejectFetch(deferred, 'Failed to fetch')
          return
        }
        deferred.resolve(created.handle)
        created.handle.dispose()
      } finally {
        bag.dispose()
      }
    })
    return deferred.handle
  })

  bridge.install(bridge.global, 'fetch', fetchImpl, {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  bridge.onDispose(() => {
    for (const handle of retained.splice(0)) {
      try {
        handle.dispose()
      } catch {
        /* already gone */
      }
    }
  })
}

const FETCH_SOURCE = `(function(host) {
  var __emit = host.__emit;
  var __resolve = host.__resolve;
  var __encode = host.__encode;
  var __decode = host.__decode;
${BODY_HELPERS_SOURCE}
  var SLOT = Symbol.for('ai4r.fetch.slot');
  var TOKEN = /^[A-Za-z0-9!#$%&'*+.^_|~-]+$/;

  function slotOf(instance, kind) {
    var slot = instance[SLOT];
    if (!slot || slot.kind !== kind) throw new TypeError('Illegal invocation');
    return slot;
  }

  function assertConstructed(self, ctor, name) {
    if (!(self instanceof ctor)) {
      throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
  }

  function normalizeName(name) {
    var text = String(name);
    if (!TOKEN.test(text)) throw new TypeError("Failed to execute 'Headers': '" + text + "' is not a valid HTTP header field name.");
    return text.toLowerCase();
  }

  function normalizeValue(value) {
    var text = String(value).replace(/^[\\t\\n\\r ]+|[\\t\\n\\r ]+$/g, '');
    if (/[\\0\\r\\n]/.test(text)) {
      throw new TypeError("Failed to execute 'Headers': '" + text + "' is not a valid HTTP header field value.");
    }
    return text;
  }

  function appendHeader(slot, name, value) {
    slot.list.push([normalizeName(name), normalizeValue(value)]);
  }

  function fillHeaders(slot, init) {
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      var source = init[SLOT].list;
      for (var index = 0; index < source.length; index += 1) appendHeader(slot, source[index][0], source[index][1]);
      return;
    }
    if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
      var pairs = [];
      var iterator = init[Symbol.iterator]();
      var step = iterator.next();
      while (!step.done) {
        pairs.push(step.value);
        step = iterator.next();
      }
      for (var pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
        var pair = pairs[pairIndex];
        if (!pair || pair.length !== 2) throw new TypeError("Failed to execute 'Headers': The provided value cannot be converted to a sequence.");
        appendHeader(slot, pair[0], pair[1]);
      }
      return;
    }
    if (typeof init === 'object') {
      for (var key in init) {
        if (Object.prototype.hasOwnProperty.call(init, key)) appendHeader(slot, key, init[key]);
      }
    }
  }

  function headerValues(slot, name) {
    var key = normalizeName(name);
    var values = [];
    for (var index = 0; index < slot.list.length; index += 1) {
      if (slot.list[index][0] === key) values.push(slot.list[index][1]);
    }
    return values;
  }

  function sortedPairs(headers) {
    var slot = slotOf(headers, 'headers');
    var copy = slot.list.slice();
    copy.sort(function compare(a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    return copy;
  }

  function headerPairs(headers) {
    var slot = headers[SLOT];
    var pairs = [];
    for (var index = 0; index < slot.list.length; index += 1) {
      pairs.push([slot.list[index][0], slot.list[index][1]]);
    }
    return pairs;
  }

  function Headers(init) {
    assertConstructed(this, Headers, 'Headers');
    Object.defineProperty(this, SLOT, {
      value: { kind: 'headers', list: [] },
      writable: false,
      enumerable: false,
      configurable: false
    });
    fillHeaders(this[SLOT], init);
  }

  Headers.prototype.append = function append(name, value) {
    appendHeader(slotOf(this, 'headers'), name, value);
  };

  Headers.prototype.delete = function delete_(name) {
    var slot = slotOf(this, 'headers');
    var key = normalizeName(name);
    var kept = [];
    for (var index = 0; index < slot.list.length; index += 1) {
      if (slot.list[index][0] !== key) kept.push(slot.list[index]);
    }
    slot.list = kept;
  };

  Headers.prototype.get = function get(name) {
    var values = headerValues(slotOf(this, 'headers'), name);
    return values.length === 0 ? null : values.join(', ');
  };

  Headers.prototype.has = function has(name) {
    return headerValues(slotOf(this, 'headers'), name).length > 0;
  };

  Headers.prototype.set = function set(name, value) {
    var slot = slotOf(this, 'headers');
    var key = normalizeName(name);
    var text = normalizeValue(value);
    var kept = [];
    for (var index = 0; index < slot.list.length; index += 1) {
      if (slot.list[index][0] !== key) kept.push(slot.list[index]);
    }
    kept.push([key, text]);
    slot.list = kept;
  };

  Headers.prototype.entries = function entries() {
    return sortedPairs(this)[Symbol.iterator]();
  };

  Headers.prototype.keys = function keys() {
    var names = [];
    var pairs = sortedPairs(this);
    for (var index = 0; index < pairs.length; index += 1) names.push(pairs[index][0]);
    return names[Symbol.iterator]();
  };

  Headers.prototype.values = function values() {
    var values = [];
    var pairs = sortedPairs(this);
    for (var index = 0; index < pairs.length; index += 1) values.push(pairs[index][1]);
    return values[Symbol.iterator]();
  };

  Headers.prototype.forEach = function forEach(callback, thisArg) {
    var pairs = sortedPairs(this);
    for (var index = 0; index < pairs.length; index += 1) {
      callback.call(thisArg, pairs[index][1], pairs[index][0], this);
    }
  };

  Headers.prototype.getSetCookie = function getSetCookie() {
    return headerValues(slotOf(this, 'headers'), 'set-cookie');
  };

  function Request(input, init) {
    assertConstructed(this, Request, 'Request');
    var options = init || {};
    var base = input instanceof Request ? input[SLOT] : null;
    if (base === null && input === undefined) {
      throw new TypeError("Failed to construct 'Request': 1 argument required, but only 0 present.");
    }
    var url = base ? base.url : __resolve(String(input));
    var slot = {
      kind: 'request',
      url: url,
      method: String(options.method !== undefined ? options.method : base ? base.method : 'GET').toUpperCase(),
      headers: new Headers(options.headers !== undefined ? options.headers : base ? base.headers : undefined),
      bodyText: options.body === undefined || options.body === null ? '' : String(options.body),
      bodyUsed: false,
      mode: options.mode !== undefined ? String(options.mode) : base ? base.mode : 'cors',
      credentials: options.credentials !== undefined ? String(options.credentials) : base ? base.credentials : 'same-origin',
      cache: options.cache !== undefined ? String(options.cache) : base ? base.cache : 'default',
      redirect: options.redirect !== undefined ? String(options.redirect) : base ? base.redirect : 'follow',
      referrer: 'about:client',
      referrerPolicy: '',
      integrity: '',
      keepalive: false,
      destination: ''
    };
    Object.defineProperty(this, SLOT, { value: slot, writable: false, enumerable: false, configurable: false });
  }

  Request.prototype.clone = function clone() {
    var slot = slotOf(this, 'request');
    var copy = new Request(slot.url, {
      method: slot.method,
      headers: slot.headers,
      body: slot.bodyText,
      mode: slot.mode,
      credentials: slot.credentials,
      cache: slot.cache,
      redirect: slot.redirect
    });
    return copy;
  };

  function Response(body, init) {
    assertConstructed(this, Response, 'Response');
    var options = init || {};
    var status = options.status === undefined ? 200 : Math.trunc(Number(options.status));
    if (!(status >= 200 && status <= 599)) {
      throw new RangeError("Failed to construct 'Response': The status provided (" + status + ") is outside the range [200, 599].");
    }
    var text = body === undefined || body === null ? '' : String(body);
    var slot = {
      kind: 'response',
      status: status,
      statusText: options.statusText === undefined ? '' : String(options.statusText),
      headers: new Headers(options.headers),
      url: options.url === undefined ? '' : String(options.url),
      redirected: false,
      type: 'default',
      bodyUsed: false,
      bodyText: text,
      bodyBinary: __encode(text)
    };
    Object.defineProperty(this, SLOT, { value: slot, writable: false, enumerable: false, configurable: false });
  }

  function consumeBody(instance, api) {
    var slot = slotOf(instance, 'response');
    if (slot.bodyUsed) {
      return { slot: null, failure: Promise.reject(new TypeError("Failed to execute '" + api + "' on 'Response': body stream already read")) };
    }
    slot.bodyUsed = true;
    return { slot: slot, failure: null };
  }

  Response.prototype.text = function text() {
    var result = consumeBody(this, 'text');
    if (result.failure) return result.failure;
    __emit({ api: 'Response.text', status: result.slot.status, url: result.slot.url });
    return Promise.resolve(result.slot.bodyText);
  };

  Response.prototype.json = function json() {
    var result = consumeBody(this, 'json');
    if (result.failure) return result.failure;
    __emit({ api: 'Response.json', status: result.slot.status, url: result.slot.url });
    try {
      return Promise.resolve(JSON.parse(result.slot.bodyText));
    } catch (error) {
      return Promise.reject(new SyntaxError('Unexpected token in JSON'));
    }
  };

  Response.prototype.arrayBuffer = function arrayBuffer() {
    var result = consumeBody(this, 'arrayBuffer');
    if (result.failure) return result.failure;
    __emit({ api: 'Response.arrayBuffer', status: result.slot.status, url: result.slot.url });
    return Promise.resolve(bytesOf(result.slot.bodyBinary).buffer);
  };

  Response.prototype.blob = function blob() {
    var result = consumeBody(this, 'blob');
    if (result.failure) return result.failure;
    __emit({ api: 'Response.blob', status: result.slot.status, url: result.slot.url });
    var type = result.slot.headers.get('content-type') || '';
    return Promise.resolve(makeBlob(bytesOf(result.slot.bodyBinary), type));
  };

  Response.prototype.clone = function clone() {
    var slot = slotOf(this, 'response');
    var copy = new Response(slot.bodyText, {
      status: slot.status,
      statusText: slot.statusText,
      headers: slot.headers
    });
    var copySlot = copy[SLOT];
    copySlot.url = slot.url;
    copySlot.type = slot.type;
    copySlot.redirected = slot.redirected;
    copySlot.bodyBinary = slot.bodyBinary;
    return copy;
  };

  function define(target, key, descriptor) {
    Object.defineProperty(target, key, descriptor);
  }

  define(Headers.prototype, Symbol.iterator, {
    value: Headers.prototype.entries,
    writable: true,
    enumerable: false,
    configurable: true
  });

  function getRequestUrl() {
    return slotOf(this, 'request').url;
  }

  function getRequestMethod() {
    return slotOf(this, 'request').method;
  }

  function getRequestHeaders() {
    return slotOf(this, 'request').headers;
  }

  function getRequestBodyUsed() {
    return slotOf(this, 'request').bodyUsed;
  }

  function getRequestMode() {
    return slotOf(this, 'request').mode;
  }

  function getRequestCredentials() {
    return slotOf(this, 'request').credentials;
  }

  function getRequestCache() {
    return slotOf(this, 'request').cache;
  }

  function getRequestRedirect() {
    return slotOf(this, 'request').redirect;
  }

  function getRequestReferrer() {
    return slotOf(this, 'request').referrer;
  }

  function getRequestReferrerPolicy() {
    return slotOf(this, 'request').referrerPolicy;
  }

  function getRequestIntegrity() {
    return slotOf(this, 'request').integrity;
  }

  function getRequestKeepalive() {
    return slotOf(this, 'request').keepalive;
  }

  function getRequestDestination() {
    return slotOf(this, 'request').destination;
  }

  define(Request.prototype, 'url', { get: getRequestUrl, enumerable: true, configurable: true });
  define(Request.prototype, 'method', { get: getRequestMethod, enumerable: true, configurable: true });
  define(Request.prototype, 'headers', { get: getRequestHeaders, enumerable: true, configurable: true });
  define(Request.prototype, 'bodyUsed', { get: getRequestBodyUsed, enumerable: true, configurable: true });
  define(Request.prototype, 'mode', { get: getRequestMode, enumerable: true, configurable: true });
  define(Request.prototype, 'credentials', { get: getRequestCredentials, enumerable: true, configurable: true });
  define(Request.prototype, 'cache', { get: getRequestCache, enumerable: true, configurable: true });
  define(Request.prototype, 'redirect', { get: getRequestRedirect, enumerable: true, configurable: true });
  define(Request.prototype, 'referrer', { get: getRequestReferrer, enumerable: true, configurable: true });
  define(Request.prototype, 'referrerPolicy', { get: getRequestReferrerPolicy, enumerable: true, configurable: true });
  define(Request.prototype, 'integrity', { get: getRequestIntegrity, enumerable: true, configurable: true });
  define(Request.prototype, 'keepalive', { get: getRequestKeepalive, enumerable: true, configurable: true });
  define(Request.prototype, 'destination', { get: getRequestDestination, enumerable: true, configurable: true });

  function getResponseStatus() {
    return slotOf(this, 'response').status;
  }

  function getResponseStatusText() {
    return slotOf(this, 'response').statusText;
  }

  function getResponseOk() {
    var status = slotOf(this, 'response').status;
    return status >= 200 && status <= 299;
  }

  function getResponseHeaders() {
    return slotOf(this, 'response').headers;
  }

  function getResponseUrl() {
    return slotOf(this, 'response').url;
  }

  function getResponseRedirected() {
    return slotOf(this, 'response').redirected;
  }

  function getResponseType() {
    return slotOf(this, 'response').type;
  }

  function getResponseBodyUsed() {
    return slotOf(this, 'response').bodyUsed;
  }

  define(Response.prototype, 'status', { get: getResponseStatus, enumerable: true, configurable: true });
  define(Response.prototype, 'statusText', { get: getResponseStatusText, enumerable: true, configurable: true });
  define(Response.prototype, 'ok', { get: getResponseOk, enumerable: true, configurable: true });
  define(Response.prototype, 'headers', { get: getResponseHeaders, enumerable: true, configurable: true });
  define(Response.prototype, 'url', { get: getResponseUrl, enumerable: true, configurable: true });
  define(Response.prototype, 'redirected', { get: getResponseRedirected, enumerable: true, configurable: true });
  define(Response.prototype, 'type', { get: getResponseType, enumerable: true, configurable: true });
  define(Response.prototype, 'bodyUsed', { get: getResponseBodyUsed, enumerable: true, configurable: true });

  function requestSpec(input, init) {
    if (input === undefined) {
      throw new TypeError("Failed to execute 'fetch': 1 argument required, but only 0 present.");
    }
    var options = init || {};
    var base = input instanceof Request ? input[SLOT] : null;
    var headers = new Headers(options.headers !== undefined ? options.headers : base ? base.headers : undefined);
    var body = options.body === undefined || options.body === null ? '' : String(options.body);
    return {
      method: String(options.method !== undefined ? options.method : base ? base.method : 'GET').toUpperCase(),
      url: base ? base.url : __resolve(String(input)),
      headers: headerPairs(headers),
      body: body
    };
  }

  function createResponse(result) {
    var response = new Response(result.bodyText, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    });
    var slot = response[SLOT];
    slot.url = result.url || '';
    slot.type = 'basic';
    slot.redirected = false;
    slot.bodyBinary = typeof result.bodyBinary === 'string' ? result.bodyBinary : __encode(slot.bodyText);
    return response;
  }

  function makeNetworkError(message) {
    return new TypeError(message ? String(message) : 'Failed to fetch');
  }

  return {
    Headers: Headers,
    Request: Request,
    Response: Response,
    requestSpec: requestSpec,
    createResponse: createResponse,
    makeNetworkError: makeNetworkError
  };
})`
