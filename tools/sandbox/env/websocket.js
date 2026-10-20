/**
 * `WebSocket`.
 *
 * WebSocket is the highest-value channel in a dropper: a live C2 socket. The
 * sandbox must never open one, but the guest must still see the lifecycle it
 * branches on — CONNECTING, an `open` event a few milliseconds later, a message
 * when the analysis setup supplies one, and otherwise an `error` followed by
 * `close(1006)` exactly like a refused connection. All timings come from the
 * seeded virtual clock, so a run is reproducible and costs no host time.
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

export const meta = { id: 'websocket', order: 86, requires: ['globals'] }

/** Seeded latency bands, in virtual milliseconds. */
export const WEBSOCKET_TIMING_MS = Object.freeze({
  open: { min: 5, max: 20 },
  failure: { min: 50, max: 150 },
})

export function install(bridge) {
  const { ctx } = bridge
  const network = ensureNetwork(bridge)
  const rng = createSeededRandom(`${bridge.profile?.seed ?? 'network'}::websocket`)

  const bindings = {
    ...createSurfaceBindings(bridge),

    /**
     * Resolve the socket's URL synchronously through the network service: a
     * registered handler or route answers with a body, the policy decides the
     * rest. Nothing is dialled.
     */
    __connect: bridge.fn('__connect', 2, ({ args }) => {
      const url = bridge.str(args, 0, '')
      const protocols = bridge.str(args, 1, '')
      const headers = { upgrade: 'websocket', connection: 'Upgrade' }
      if (protocols) headers['sec-websocket-protocol'] = protocols
      const result = network.computeResult({ method: 'GET', url, headers })
      bridge.emit('api', 'before', { api: 'WebSocket.connect', url, protocols })
      return bridge.toGuest(networkResultForGuest(result))
    }),

    /** Seeded latency draw, so every socket transition is deterministic. */
    __delay: bridge.fn('__delay', 2, ({ args }) => {
      const min = bridge.int(args, 0, 0)
      const max = bridge.int(args, 1, min)
      return ctx.newNumber(rng.int(Math.min(min, max), Math.max(min, max)))
    }),
  }

  const guest = createGuestModule(bridge, WEBSOCKET_SOURCE, bindings)
  try {
    const ctor = ctx.getProp(guest, 'WebSocket')
    bridge.install(bridge.global, 'WebSocket', ctor, {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    bridge.adopt(ctor, 'WebSocket')
    adoptGuestSurface(bridge, ctor)
    ctor.dispose()
  } finally {
    guest.dispose()
  }
}

const WEBSOCKET_SOURCE = `(function(host) {
  var __emit = host.__emit;
  var __now = host.__now;
  var __schedule = host.__schedule;
  var __cancel = host.__cancel;
  var __uncaught = host.__uncaught;
  var __connect = host.__connect;
  var __delay = host.__delay;
${EVENT_TARGET_SOURCE}
  var SLOT = Symbol.for('ai4r.websocket.slot');
  var CONNECTING = 0;
  var OPEN = 1;
  var CLOSING = 2;
  var CLOSED = 3;
  var TOKEN = /^[A-Za-z0-9!#$%&'*+.^_|~-]+$/;

  function stateOf(instance) {
    var state = instance[SLOT];
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function domError(name, message) {
    var error = new Error(message);
    error.name = name;
    return error;
  }

  function originOf(url) {
    var match = /^(wss?|https?):\\/\\/([^/?#]+)/i.exec(url);
    if (!match) return '';
    var scheme = match[1].toLowerCase();
    return (scheme === 'wss' || scheme === 'https' ? 'https' : 'http') + '://' + match[2];
  }

  function closeCodeAllowed(code) {
    return code === 1000 || (code >= 3000 && code <= 4999);
  }

  function cancelTimers(state) {
    var keys = ['openTimerId', 'failureTimerId', 'messageTimerId', 'closeTimerId'];
    for (var index = 0; index < keys.length; index += 1) {
      if (state[keys[index]]) {
        __cancel(state[keys[index]]);
        state[keys[index]] = 0;
      }
    }
  }

  function finishClose(state, code, reason, wasClean) {
    state.readyState = CLOSED;
    fire(state, 'close', { code: code, reason: reason, wasClean: wasClean });
    __emit({ api: 'WebSocket.close', url: state.url, code: code, reason: reason, wasClean: wasClean });
  }

  function start(state) {
    state.openTimerId = __schedule(__delay(${WEBSOCKET_TIMING_MS.open.min}, ${WEBSOCKET_TIMING_MS.open.max}), function onOpen() {
      state.openTimerId = 0;
      if (state.readyState !== CONNECTING) return;
      state.readyState = OPEN;
      __emit({ api: 'WebSocket.open', url: state.url, protocol: state.protocol });
      fire(state, 'open');
      var session = state.session || {};
      if (session.ok && session.fromMock) {
        var messageDelay = session.durationMs > 0 ? session.durationMs : __delay(5, 20);
        state.messageTimerId = __schedule(messageDelay, function onMessage() {
          state.messageTimerId = 0;
          if (state.readyState !== OPEN) return;
          fire(state, 'message', {
            data: typeof session.bodyText === 'string' ? session.bodyText : '',
            origin: originOf(state.url),
            lastEventId: '',
            ports: []
          });
        });
        return;
      }
      state.failureTimerId = __schedule(__delay(${WEBSOCKET_TIMING_MS.failure.min}, ${WEBSOCKET_TIMING_MS.failure.max}), function onFailure() {
        state.failureTimerId = 0;
        if (state.readyState !== OPEN) return;
        state.readyState = CLOSING;
        __emit({ api: 'WebSocket.error', url: state.url, error: session.error || 'net::ERR_CONNECTION_CLOSED' });
        fire(state, 'error', { message: '', error: session.error || 'net::ERR_CONNECTION_CLOSED' });
        finishClose(state, 1006, '', false);
      });
    });
  }

  function WebSocket(url, protocols) {
    if (!(this instanceof WebSocket)) {
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    var text = String(url);
    if (!/^(wss?|https?):\\/\\//i.test(text)) {
      throw new SyntaxError("Failed to construct 'WebSocket': The URL '" + text + "' is invalid.");
    }
    var requested = [];
    if (typeof protocols === 'string') {
      requested.push(protocols);
    } else if (protocols && typeof protocols.length === 'number') {
      for (var index = 0; index < protocols.length; index += 1) requested.push(String(protocols[index]));
    }
    var state = newTarget(this);
    state.readyState = CONNECTING;
    state.url = text;
    state.protocol = requested.length > 0 && TOKEN.test(requested[0]) ? requested[0] : '';
    state.extensions = '';
    state.bufferedAmount = 0;
    state.binaryType = 'blob';
    state.openTimerId = 0;
    state.failureTimerId = 0;
    state.messageTimerId = 0;
    state.closeTimerId = 0;
    Object.defineProperty(this, SLOT, { value: state, writable: false, enumerable: false, configurable: false });
    state.session = __connect(text, requested.join(', '));
    start(state);
  }

  function sendImpl(data) {
    var state = stateOf(this);
    if (state.readyState !== OPEN) {
      throw domError('InvalidStateError', "Failed to execute 'send' on 'WebSocket': The connection is not open.");
    }
    var text = typeof data === 'string' ? data : data === undefined || data === null ? '' : '[binary]';
    __emit({ api: 'WebSocket.send', url: state.url, length: text.length, data: text.slice(0, 2048) });
  }

  function closeImpl(code, reason) {
    var state = stateOf(this);
    var closeCode = code === undefined ? 1005 : Math.trunc(Number(code));
    if (code !== undefined && !closeCodeAllowed(closeCode)) {
      throw domError('InvalidAccessError', "Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. " + closeCode + " is neither.");
    }
    var text = reason === undefined ? '' : String(reason);
    if (text.length > 123) {
      throw new SyntaxError("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.");
    }
    if (state.readyState === CLOSING || state.readyState === CLOSED) return;
    cancelTimers(state);
    if (state.readyState === CONNECTING) {
      state.readyState = CLOSING;
      state.closeTimerId = __schedule(__delay(${WEBSOCKET_TIMING_MS.open.min}, ${WEBSOCKET_TIMING_MS.open.max}), function onAborted() {
        state.closeTimerId = 0;
        finishClose(state, 1006, '', false);
      });
      return;
    }
    state.readyState = CLOSING;
    state.closeTimerId = __schedule(__delay(${WEBSOCKET_TIMING_MS.open.min}, ${WEBSOCKET_TIMING_MS.open.max}), function onClosed() {
      state.closeTimerId = 0;
      finishClose(state, closeCode === 1005 ? 1000 : closeCode, text, true);
    });
  }

  function getUrl() {
    return stateOf(this).url;
  }

  function getReadyState() {
    return stateOf(this).readyState;
  }

  function getProtocol() {
    return stateOf(this).protocol;
  }

  function getExtensions() {
    return stateOf(this).extensions;
  }

  function getBufferedAmount() {
    return stateOf(this).bufferedAmount;
  }

  function getBinaryType() {
    return stateOf(this).binaryType;
  }

  function setBinaryType(value) {
    var state = stateOf(this);
    var text = String(value);
    if (text === 'blob' || text === 'arraybuffer') state.binaryType = text;
  }

  function getOnopen() {
    return handlerOf(this, 'open');
  }

  function setOnopen(value) {
    setHandlerFor(this, 'open', value);
  }

  function getOnmessage() {
    return handlerOf(this, 'message');
  }

  function setOnmessage(value) {
    setHandlerFor(this, 'message', value);
  }

  function getOnerror() {
    return handlerOf(this, 'error');
  }

  function setOnerror(value) {
    setHandlerFor(this, 'error', value);
  }

  function getOnclose() {
    return handlerOf(this, 'close');
  }

  function setOnclose(value) {
    setHandlerFor(this, 'close', value);
  }

  var proto = WebSocket.prototype;
  proto.send = function send(data) {
    return sendImpl.call(this, data);
  };
  proto.close = function close(code, reason) {
    return closeImpl.call(this, code, reason);
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
  defineProperty_('protocol', { get: getProtocol, enumerable: true, configurable: true });
  defineProperty_('extensions', { get: getExtensions, enumerable: true, configurable: true });
  defineProperty_('bufferedAmount', { get: getBufferedAmount, enumerable: true, configurable: true });
  defineProperty_('binaryType', { get: getBinaryType, set: setBinaryType, enumerable: true, configurable: true });
  defineProperty_('onopen', { get: getOnopen, set: setOnopen, enumerable: true, configurable: true });
  defineProperty_('onmessage', { get: getOnmessage, set: setOnmessage, enumerable: true, configurable: true });
  defineProperty_('onerror', { get: getOnerror, set: setOnerror, enumerable: true, configurable: true });
  defineProperty_('onclose', { get: getOnclose, set: setOnclose, enumerable: true, configurable: true });

  function defineConstants(target) {
    var names = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    var values = [CONNECTING, OPEN, CLOSING, CLOSED];
    for (var index = 0; index < names.length; index += 1) {
      Object.defineProperty(target, names[index], {
        value: values[index],
        writable: false,
        enumerable: true,
        configurable: false
      });
    }
  }

  defineConstants(WebSocket);
  defineConstants(proto);

  return { WebSocket: WebSocket };
})`
