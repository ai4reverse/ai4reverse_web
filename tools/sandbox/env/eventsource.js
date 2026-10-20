/**
 * `EventSource` (server-sent events).
 *
 * A dropper that waits for a command channel often opens an `EventSource` to a
 * gate script and treats each `data:` line as a task. The sandbox must never
 * touch the network, but the guest has to observe the real lifecycle: a
 * `CONNECTING` object, an `open` event, one `message` per `data:` block, and the
 * browser's reconnect behaviour (`error`, then a retry on the virtual clock).
 *
 * Every byte comes from the virtual network service (`bridge.network`), so:
 *  - the request is recorded as an `api` + `net` trace event and as a URL IOC,
 *  - `Last-Event-ID` is sent on reconnect exactly like a browser,
 *  - `retry:` from the server changes the reconnect delay,
 *  - all timing is virtual and seeded, so a run stays reproducible and free.
 */

import {
  adoptGuestSurface,
  createGuestModule,
  createSurfaceBindings,
  ensureNetwork,
  EVENT_TARGET_SOURCE,
  networkResultForGuest,
} from './network.js'
import { createSeededRandom } from '../../util/random.js'
import { createKit } from './platform-kit.js'

export const meta = { id: 'eventsource', order: 85, requires: ['globals', 'network'] }

/** Seeded band for the "response arrives" delay (matches network latency). */
export const EVENTSOURCE_TIMING_MS = Object.freeze({ min: 40, max: 120 })

/** Spec default when the server never sends a `retry:` field. */
export const EVENTSOURCE_RETRY_MS = 3000

export function install(bridge) {
  const { ctx } = bridge
  const network = ensureNetwork(bridge)
  const rng = createSeededRandom(`${bridge.profile?.seed ?? 'network'}::eventsource`)

  const bindings = {
    ...createSurfaceBindings(bridge),

    /**
     * Resolve the stream request synchronously through the network service.
     * Nothing is dialled; the trace records the attempt and the answer.
     */
    __connect: bridge.fn('__connect', 2, ({ args }) => {
      const url = bridge.str(args, 0, '')
      const lastEventId = bridge.str(args, 1, '')
      const headers = { accept: 'text/event-stream', 'cache-control': 'no-cache' }
      if (lastEventId) headers['last-event-id'] = lastEventId
      bridge.emit('api', 'before', { api: 'EventSource.connect', url, lastEventId })
      const result = network.computeResult({ method: 'GET', url, headers })
      return bridge.toGuest(networkResultForGuest(result))
    }),

    /** Seeded latency draw so every connection settles deterministically. */
    __delay: bridge.fn('__delay', 2, ({ args }) => {
      const min = bridge.int(args, 0, 0)
      const max = bridge.int(args, 1, min)
      return ctx.newNumber(rng.int(Math.min(min, max), Math.max(min, max)))
    }),
  }

  const guest = createGuestModule(bridge, EVENTSOURCE_SOURCE, bindings)
  const kit = createKit(bridge)
  try {
    const ctor = ctx.getProp(guest, 'EventSource')
    // Blink brands the interface and its prototype: without the tag,
    // `Object.prototype.toString.call(new EventSource(url))` is `[object
    // Object]` where a browser answers `[object EventSource]`.
    kit.setToStringTag(ctor, 'EventSource')
    bridge.install(bridge.global, 'EventSource', ctor, {
      enumerable: false,
      configurable: true,
      writable: true,
    })
    bridge.adopt(ctor, 'EventSource')
    adoptGuestSurface(bridge, ctor)
    ctor.dispose()
  } finally {
    guest.dispose()
  }
  bridge.emit('sandbox', 'emit', { event: 'env.eventsource-installed' })
}

const EVENTSOURCE_SOURCE = `(function (host) {
  var __emit = host.__emit;
  var __now = host.__now;
  var __schedule = host.__schedule;
  var __cancel = host.__cancel;
  var __uncaught = host.__uncaught;
  var __connect = host.__connect;
  var __delay = host.__delay;
${EVENT_TARGET_SOURCE}
  var SLOT = Symbol.for('ai4r.eventsource.slot');
  var CONNECTING = 0;
  var OPEN = 1;
  var CLOSED = 2;
  var DEFAULT_RETRY_MS = ${EVENTSOURCE_RETRY_MS};
  var LATENCY_MIN = ${EVENTSOURCE_TIMING_MS.min};
  var LATENCY_MAX = ${EVENTSOURCE_TIMING_MS.max};

  function stateOf(instance) {
    var state = instance[SLOT];
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function originOf(url) {
    var match = /^(https?):\\/\\/([^/?#]+)/i.exec(url);
    return match ? match[1].toLowerCase() + '://' + match[2] : '';
  }

  function cancelTimer(state) {
    if (state.timerId) {
      __cancel(state.timerId);
      state.timerId = 0;
    }
  }

  function schedule(state, delay, callback) {
    cancelTimer(state);
    state.timerId = __schedule(delay, callback);
  }

  function reconnect(state) {
    if (state.readyState === CLOSED) return;
    state.readyState = CONNECTING;
    __emit({ api: 'EventSource.reconnect', url: state.url, retryMs: state.retryMs });
    schedule(state, state.retryMs, function onRetry() {
      state.timerId = 0;
      connect(state);
    });
  }

  function failConnection(state, reason) {
    cancelTimer(state);
    state.readyState = CLOSED;
    __emit({ api: 'EventSource.error', url: state.url, error: reason });
    fire(state, 'error', { message: '', error: reason });
    __emit({ api: 'EventSource.close', url: state.url, readyState: CLOSED, failed: true });
  }

  // Server-sent events wire format: blank line separated blocks of field lines.
  function dispatchStream(state, body) {
    var blocks = String(body).split(/\\r?\\n\\r?\\n/);
    for (var blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      var lines = blocks[blockIndex].split(/\\r?\\n/);
      var data = [];
      var type = 'message';
      var id = null;
      var retry = null;
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index];
        if (line === '' || line.charAt(0) === ':') continue;
        var colon = line.indexOf(':');
        var field = colon < 0 ? line : line.slice(0, colon);
        var value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.charAt(0) === ' ') value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') type = value === '' ? 'message' : value;
        else if (field === 'id') id = value;
        else if (field === 'retry') {
          var parsed = parseInt(value, 10);
          if (isFinite(parsed) && parsed >= 0) retry = parsed;
        }
      }
      if (id !== null && id.indexOf('\\u0000') < 0 && id !== '') state.lastEventId = id;
      if (retry !== null) state.retryMs = retry;
      if (data.length === 0) continue;
      var payload = data.join('\\n');
      __emit({
        api: 'EventSource.message',
        url: state.url,
        type: type,
        lastEventId: state.lastEventId,
        length: payload.length,
        data: payload.slice(0, 2048)
      });
      fire(state, type, { data: payload, origin: originOf(state.url), lastEventId: state.lastEventId });
    }
  }

  function openStream(state, session) {
    if (state.readyState === CLOSED) return;
    state.readyState = OPEN;
    __emit({ api: 'EventSource.open', url: state.url, status: session.status });
    fire(state, 'open');
    dispatchStream(state, session.bodyText || '');
    // The mock response body ends the stream immediately; a browser would see
    // the connection drop and reconnect with the last event id.
    reconnect(state);
  }

  function connect(state) {
    if (state.readyState === CLOSED) return;
    var session = __connect(state.url, state.lastEventId);
    if (!session.ok) {
      // Transport failure: the object stays CONNECTING and retries, which is
      // what a browser does for a resolver/connection error.
      __emit({
        api: 'EventSource.error',
        url: state.url,
        error: session.error || 'net::ERR_FAILED',
        retrying: true
      });
      fire(state, 'error', { message: '', error: session.error || 'net::ERR_FAILED' });
      reconnect(state);
      return;
    }
    if (session.status !== 200) {
      failConnection(state, 'net::ERR_HTTP_' + session.status);
      return;
    }
    var headers = session.headers || {};
    var contentType = String(headers['content-type'] || 'text/event-stream');
    if (contentType.indexOf('text/event-stream') < 0) {
      failConnection(state, 'net::ERR_INVALID_CONTENT_TYPE');
      return;
    }
    schedule(state, __delay(LATENCY_MIN, LATENCY_MAX), function onOpen() {
      state.timerId = 0;
      openStream(state, session);
    });
  }

  function EventSource(url, options) {
    if (!(this instanceof EventSource)) {
      throw new TypeError("Failed to construct 'EventSource': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    if (url === undefined) {
      throw new TypeError("Failed to construct 'EventSource': 1 argument required, but only 0 present.");
    }
    var text = String(url);
    var base = typeof location === 'object' && location && location.href ? location.href : undefined;
    var absolute = text;
    try {
      if (typeof URL === 'function') absolute = new URL(text, base).href;
    } catch (error) {
      throw new SyntaxError("Failed to construct 'EventSource': The URL '" + text + "' is invalid.");
    }
    if (!/^https?:\\/\\//i.test(absolute)) {
      throw new SyntaxError("Failed to construct 'EventSource': The URL '" + text + "' has an unsupported scheme.");
    }
    var state = newTarget(this);
    state.url = absolute;
    state.readyState = CONNECTING;
    state.withCredentials = Boolean(options && options.withCredentials);
    state.lastEventId = '';
    state.retryMs = DEFAULT_RETRY_MS;
    state.timerId = 0;
    Object.defineProperty(this, SLOT, { value: state, writable: false, enumerable: false, configurable: false });
    __emit({ api: 'EventSource.constructor', url: absolute, withCredentials: state.withCredentials });
    connect(state);
  }

  function closeImpl() {
    var state = stateOf(this);
    if (state.readyState === CLOSED) return;
    cancelTimer(state);
    state.readyState = CLOSED;
    __emit({ api: 'EventSource.close', url: state.url, readyState: CLOSED });
  }

  function getUrl() { return stateOf(this).url; }
  function getReadyState() { return stateOf(this).readyState; }
  function getWithCredentials() { return stateOf(this).withCredentials; }
  function getOnopen() { return handlerOf(this, 'open'); }
  function setOnopen(value) { setHandlerFor(this, 'open', value); }
  function getOnmessage() { return handlerOf(this, 'message'); }
  function setOnmessage(value) { setHandlerFor(this, 'message', value); }
  function getOnerror() { return handlerOf(this, 'error'); }
  function setOnerror(value) { setHandlerFor(this, 'error', value); }

  var proto = EventSource.prototype;
  proto.close = function close() {
    return closeImpl.call(this);
  };
  proto.addEventListener = function addEventListener(type, callback) {
    return addListenerImpl.call(this, type, callback);
  };
  proto.removeEventListener = function removeEventListener(type, callback) {
    return removeListenerImpl.call(this, type, callback);
  };
  proto.dispatchEvent = function dispatchEvent(event) {
    return dispatchEventImpl.call(this, event);
  };

  function defineProperty_(key, descriptor) {
    Object.defineProperty(proto, key, descriptor);
  }
  defineProperty_('url', { get: getUrl, enumerable: true, configurable: true });
  defineProperty_('readyState', { get: getReadyState, enumerable: true, configurable: true });
  defineProperty_('withCredentials', { get: getWithCredentials, enumerable: true, configurable: true });
  defineProperty_('onopen', { get: getOnopen, set: setOnopen, enumerable: true, configurable: true });
  defineProperty_('onmessage', { get: getOnmessage, set: setOnmessage, enumerable: true, configurable: true });
  defineProperty_('onerror', { get: getOnerror, set: setOnerror, enumerable: true, configurable: true });

  function defineConstants(target) {
    var names = ['CONNECTING', 'OPEN', 'CLOSED'];
    var values = [CONNECTING, OPEN, CLOSED];
    for (var index = 0; index < names.length; index += 1) {
      Object.defineProperty(target, names[index], {
        value: values[index],
        writable: false,
        enumerable: true,
        configurable: false
      });
    }
  }
  defineConstants(EventSource);
  defineConstants(proto);

  return { EventSource: EventSource };
})`
