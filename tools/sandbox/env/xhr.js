/**
 * `XMLHttpRequest`.
 *
 * Real droppers branch on the transport's *behaviour*, not just its presence:
 * `onreadystatechange` must fire in order, `status` must be `0` for a network
 * failure and set for a served response, `responseType` must transform the
 * body, and everything must be asynchronous. The class is therefore implemented
 * as guest code (private per-instance state, listener list, event objects) that
 * reaches the host only through injected bindings: response delivery, virtual
 * timers, tracing and byte decoding. Time comes from `bridge.clock`, so a test
 * advances the clock and observes the exact browser event sequence.
 */

import { HandleBag } from '../../util/disposable.js'
import {
  adoptGuestSurface,
  BODY_HELPERS_SOURCE,
  createGuestModule,
  createSurfaceBindings,
  EVENT_TARGET_SOURCE,
  ensureNetwork,
  networkResultForGuest,
} from './network.js'

export const meta = { id: 'xhr', order: 80, requires: ['globals'] }

export function install(bridge) {
  const { ctx } = bridge
  const network = ensureNetwork(bridge)

  /** @type {Map<number, {callback: object|null}>} in-flight deliveries */
  const inFlight = new Map()

  const bindings = {
    ...createSurfaceBindings(bridge),

    __send: bridge.fn('__send', 2, ({ args }) => {
      const spec = bridge.value(args, 0) ?? {}
      const callback = args[1]
      const entry = {
        callback: callback && ctx.typeof(callback) === 'function' ? callback.dup() : null,
      }
      const { id } = network.dispatch(spec, (result) => {
        const pendingEntry = inFlight.get(id)
        inFlight.delete(id)
        if (!pendingEntry?.callback) return
        const bag = new HandleBag()
        try {
          const call = ctx.callFunction(pendingEntry.callback, ctx.undefined, [
            bag.add(bridge.toGuest(networkResultForGuest(result))),
          ])
          if (call.error) {
            const dumped = bridge.fromGuest(call.error)
            call.error.dispose()
            bridge.emit('exception', 'uncaught', { origin: 'xhr', error: dumped })
          } else {
            call.value.dispose()
          }
        } finally {
          pendingEntry.callback.dispose()
          bag.dispose()
        }
      })
      inFlight.set(id, entry)
      return ctx.newNumber(id)
    }),

    __abort: bridge.fn('__abort', 1, ({ args }) => {
      const id = bridge.num(args, 0, 0)
      const entry = inFlight.get(id)
      if (entry) {
        inFlight.delete(id)
        entry.callback?.dispose()
      }
      return network.cancel(id) ? ctx.true : ctx.false
    }),
  }

  /** Call a guest installer and surface its failure as a host error. */
  const applyGuest = (fnHandle, argHandle, label) => {
    const call = ctx.callFunction(fnHandle, ctx.undefined, [argHandle])
    if (call.error) {
      const dumped = bridge.fromGuest(call.error)
      call.error.dispose()
      throw new Error(`${label} surface installation failed: ${dumped?.message ?? dumped}`)
    }
    call.value.dispose()
  }

  const guest = createGuestModule(bridge, XHR_SOURCE, bindings)
  try {
    const init = ctx.getProp(guest, 'init')
    const installSurface = ctx.getProp(guest, 'install')
    const installConstants = ctx.getProp(guest, 'installConstants')
    const ctor = bridge.nativeConstructor({
      name: 'XMLHttpRequest',
      bindings: { __init: init },
      body:
        'if (!(this instanceof XMLHttpRequest)) {\n' +
        '  throw new TypeError("Failed to construct \'XMLHttpRequest\': Please use the \'new\' operator, this DOM object constructor cannot be called as a function.");\n' +
        '}\n__init(self);',
    })
    init.dispose()

    const prototype = ctx.getProp(ctor, 'prototype')
    applyGuest(installSurface, prototype, 'XMLHttpRequest')
    applyGuest(installConstants, ctor, 'XMLHttpRequest')
    prototype.dispose()
    installSurface.dispose()
    installConstants.dispose()

    bridge.install(bridge.global, 'XMLHttpRequest', ctor, {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    adoptGuestSurface(bridge, ctor)
    ctor.dispose()

    const uploadCtor = ctx.getProp(guest, 'XMLHttpRequestUpload')
    bridge.adopt(uploadCtor, 'XMLHttpRequestUpload')
    adoptGuestSurface(bridge, uploadCtor)
    uploadCtor.dispose()
  } finally {
    guest.dispose()
  }

  bridge.onDispose(() => {
    for (const entry of inFlight.values()) entry.callback?.dispose()
    inFlight.clear()
  })
}

const XHR_SOURCE = `(function(host) {
  var __send = host.__send;
  var __abort = host.__abort;
  var __schedule = host.__schedule;
  var __cancel = host.__cancel;
  var __emit = host.__emit;
  var __now = host.__now;
  var __decode = host.__decode;
  var __uncaught = host.__uncaught;
${EVENT_TARGET_SOURCE}${BODY_HELPERS_SOURCE}
  var SLOT = Symbol.for('ai4r.xhr.slot');
  var UNSENT = 0;
  var OPENED = 1;
  var HEADERS_RECEIVED = 2;
  var LOADING = 3;
  var DONE = 4;
  var RESPONSE_TYPES = ['', 'text', 'json', 'arraybuffer', 'blob'];

  function domError(name, message) {
    var error = new Error(message);
    error.name = name;
    return error;
  }

  function stateOf(instance) {
    var state = instance[SLOT];
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function headerPairs(headers) {
    var pairs = [];
    if (!headers) return pairs;
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key)) pairs.push([key, headers[key]]);
    }
    return pairs;
  }

  function responseHeaderText(state) {
    var text = '';
    for (var index = 0; index < state.responseHeaders.length; index += 1) {
      text += state.responseHeaders[index][0] + ': ' + state.responseHeaders[index][1] + '\\r\\n';
    }
    return text;
  }

  function responseHeaderValue(state, name) {
    var key = String(name).toLowerCase();
    for (var index = 0; index < state.responseHeaders.length; index += 1) {
      if (String(state.responseHeaders[index][0]).toLowerCase() === key) return state.responseHeaders[index][1];
    }
    return null;
  }

  function buildResponse(state, result) {
    var type = state.responseType;
    if (type === '' || type === 'text') return state.responseText;
    if (type === 'json') {
      try {
        return JSON.parse(state.responseText);
      } catch (error) {
        return null;
      }
    }
    if (type === 'arraybuffer') return bytesOf(result.bodyBinary).buffer;
    if (type === 'blob') return makeBlob(bytesOf(result.bodyBinary), responseHeaderValue(state, 'content-type') || '');
    return state.responseText;
  }

  function resetResponse(state) {
    state.status = 0;
    state.statusText = '';
    state.responseHeaders = [];
    state.responseText = '';
    state.response = state.responseType === '' || state.responseType === 'text' ? '' : null;
    state.responseURL = '';
  }

  function complete(state, result) {
    if (state.done) return;
    state.done = true;
    if (state.timeoutTimerId) {
      __cancel(state.timeoutTimerId);
      state.timeoutTimerId = 0;
    }
    if (!result.ok) {
      resetResponse(state);
      state.readyState = DONE;
      fire(state, 'readystatechange');
      fire(state, 'error');
      fire(state, 'loadend');
      return;
    }
    state.status = result.status;
    state.statusText = result.statusText || '';
    state.responseHeaders = headerPairs(result.headers);
    state.responseURL = result.url || state.url;
    state.readyState = HEADERS_RECEIVED;
    fire(state, 'readystatechange');
    state.responseText = typeof result.bodyText === 'string' ? result.bodyText : '';
    state.readyState = LOADING;
    fire(state, 'readystatechange');
    fire(state, 'progress', {
      lengthComputable: true,
      loaded: state.responseText.length,
      total: state.responseText.length
    });
    state.response = buildResponse(state, result);
    state.readyState = DONE;
    fire(state, 'readystatechange');
    fire(state, 'load');
    fire(state, 'loadend');
  }

  function failWithTimeout(state) {
    state.timeoutTimerId = 0;
    if (state.done) return;
    if (state.requestId) __abort(state.requestId);
    state.requestId = 0;
    state.done = true;
    resetResponse(state);
    state.readyState = DONE;
    __emit({ api: 'XMLHttpRequest.timeout', url: state.url, timeout: state.timeout });
    fire(state, 'readystatechange');
    fire(state, 'timeout');
    fire(state, 'loadend');
  }

  function openImpl(a0, a1, a2) {
    var state = stateOf(this);
    state.method = String(a0).toUpperCase();
    state.url = String(a1);
    state.async = a2 === undefined ? true : Boolean(a2);
    state.requestHeaders = [];
    state.responseHeaders = [];
    state.requestId = 0;
    state.sent = false;
    state.done = false;
    if (state.timeoutTimerId) {
      __cancel(state.timeoutTimerId);
      state.timeoutTimerId = 0;
    }
    resetResponse(state);
    state.readyState = OPENED;
    __emit({ api: 'XMLHttpRequest.open', method: state.method, url: state.url, async: state.async });
    fire(state, 'readystatechange');
  }

  function setRequestHeaderImpl(name, value) {
    var state = stateOf(this);
    if (state.readyState !== OPENED || state.sent) {
      throw domError('InvalidStateError', "Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.");
    }
    var key = String(name);
    var text = String(value);
    for (var index = 0; index < state.requestHeaders.length; index += 1) {
      if (String(state.requestHeaders[index][0]).toLowerCase() === key.toLowerCase()) {
        state.requestHeaders[index][1] = state.requestHeaders[index][1] + ', ' + text;
        return;
      }
    }
    state.requestHeaders.push([key, text]);
  }

  function sendImpl(a0) {
    var state = stateOf(this);
    if (state.readyState !== OPENED || state.sent) {
      throw domError('InvalidStateError', "Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.");
    }
    var body = a0 === undefined || a0 === null ? '' : String(a0);
    state.sent = true;
    state.done = false;
    __emit({ api: 'XMLHttpRequest.send', method: state.method, url: state.url, bodyLength: body.length });
    // The guest owns timeout semantics: it fires a timeout event instead of a
    // transport error, so it never asks the network service to race it.
    state.requestId = __send(
      {
        method: state.method,
        url: state.url,
        headers: state.requestHeaders,
        body: body
      },
      function deliver(result) {
        complete(state, result);
      }
    );
    if (state.timeout > 0) {
      state.timeoutTimerId = __schedule(state.timeout, function ontimeout() {
        failWithTimeout(state);
      });
    }
  }

  function abortImpl() {
    var state = stateOf(this);
    if (state.timeoutTimerId) {
      __cancel(state.timeoutTimerId);
      state.timeoutTimerId = 0;
    }
    if (state.requestId && !state.done) __abort(state.requestId);
    state.requestId = 0;
    if (!state.sent || state.done) {
      state.sent = false;
      return;
    }
    state.done = true;
    state.sent = false;
    resetResponse(state);
    state.readyState = DONE;
    __emit({ api: 'XMLHttpRequest.abort', url: state.url });
    fire(state, 'readystatechange');
    fire(state, 'abort');
    fire(state, 'loadend');
    state.readyState = UNSENT;
  }

  function getAllResponseHeadersImpl() {
    var state = stateOf(this);
    if (state.readyState < HEADERS_RECEIVED) return '';
    return responseHeaderText(state);
  }

  function getResponseHeaderImpl(name) {
    var state = stateOf(this);
    if (state.readyState < HEADERS_RECEIVED) return null;
    return responseHeaderValue(state, name);
  }

  function overrideMimeTypeImpl(mime) {
    var state = stateOf(this);
    if (state.readyState === LOADING || state.readyState === DONE) {
      throw domError('InvalidStateError', "Failed to execute 'overrideMimeType' on 'XMLHttpRequest': MimeType cannot be overridden when the state is LOADING or DONE.");
    }
    __emit({ api: 'XMLHttpRequest.overrideMimeType', url: state.url, mimeType: String(mime) });
  }

  function getReadyState() {
    return stateOf(this).readyState;
  }

  function getStatus() {
    return stateOf(this).status;
  }

  function getStatusText() {
    return stateOf(this).statusText;
  }

  function getResponseType() {
    return stateOf(this).responseType;
  }

  function setResponseType(value) {
    var state = stateOf(this);
    if (state.readyState === LOADING || state.readyState === DONE) {
      throw domError('InvalidStateError', "Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.");
    }
    var type = String(value);
    if (RESPONSE_TYPES.indexOf(type) === -1) return;
    if (state.responseType === type) return;
    state.responseType = type;
    state.responseText = '';
    state.response = type === '' || type === 'text' ? '' : null;
  }

  function getResponseText() {
    var state = stateOf(this);
    if (state.responseType !== '' && state.responseType !== 'text') {
      throw domError('InvalidStateError', "Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '" + state.responseType + "').");
    }
    return state.responseText;
  }

  function getResponse() {
    var state = stateOf(this);
    if (state.responseType === '' || state.responseType === 'text') return state.responseText;
    return state.readyState === DONE ? state.response : null;
  }

  function getResponseURL() {
    return stateOf(this).responseURL;
  }

  function getTimeout() {
    return stateOf(this).timeout;
  }

  function setTimeout_(value) {
    var state = stateOf(this);
    var next = Number(value);
    state.timeout = Number.isFinite(next) && next > 0 ? next : 0;
  }

  function getWithCredentials() {
    return stateOf(this).withCredentials;
  }

  function setWithCredentials(value) {
    var state = stateOf(this);
    if (state.readyState !== UNSENT && state.readyState !== OPENED) {
      throw domError('InvalidStateError', "Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.");
    }
    if (state.sent) {
      throw domError('InvalidStateError', "Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.");
    }
    state.withCredentials = Boolean(value);
  }

  function getUpload() {
    return stateOf(this).upload;
  }

  function getOnreadystatechange() {
    return handlerOf(this, 'readystatechange');
  }

  function setOnreadystatechange(value) {
    setHandlerFor(this, 'readystatechange', value);
  }

  function getOnload() {
    return handlerOf(this, 'load');
  }

  function setOnload(value) {
    setHandlerFor(this, 'load', value);
  }

  function getOnloadend() {
    return handlerOf(this, 'loadend');
  }

  function setOnloadend(value) {
    setHandlerFor(this, 'loadend', value);
  }

  function getOnerror() {
    return handlerOf(this, 'error');
  }

  function setOnerror(value) {
    setHandlerFor(this, 'error', value);
  }

  function getOntimeout() {
    return handlerOf(this, 'timeout');
  }

  function setOntimeout(value) {
    setHandlerFor(this, 'timeout', value);
  }

  function getOnabort() {
    return handlerOf(this, 'abort');
  }

  function setOnabort(value) {
    setHandlerFor(this, 'abort', value);
  }

  function getOnprogress() {
    return handlerOf(this, 'progress');
  }

  function setOnprogress(value) {
    setHandlerFor(this, 'progress', value);
  }

  function XMLHttpRequestUpload() {
    if (!(this instanceof XMLHttpRequestUpload)) {
      throw new TypeError("Failed to construct 'XMLHttpRequestUpload': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    Object.defineProperty(this, SLOT, { value: newTarget(this), writable: false, enumerable: false, configurable: false });
  }

  XMLHttpRequestUpload.prototype.addEventListener = function addEventListener(type, callback) {
    return addListenerImpl.call(this, type, callback);
  };
  XMLHttpRequestUpload.prototype.removeEventListener = function removeEventListener(type, callback) {
    return removeListenerImpl.call(this, type, callback);
  };
  XMLHttpRequestUpload.prototype.dispatchEvent = function dispatchEvent(event) {
    return dispatchEventImpl.call(this, event);
  };

  function initXhr(self) {
    var state = newTarget(self);
    state.readyState = UNSENT;
    state.status = 0;
    state.statusText = '';
    state.responseType = '';
    state.responseText = '';
    state.response = '';
    state.responseURL = '';
    state.responseHeaders = [];
    state.requestHeaders = [];
    state.timeout = 0;
    state.timeoutTimerId = 0;
    state.withCredentials = false;
    state.method = 'GET';
    state.url = '';
    state.async = true;
    state.requestId = 0;
    state.sent = false;
    state.done = false;
    Object.defineProperty(self, SLOT, { value: state, writable: false, enumerable: false, configurable: false });
    state.upload = new XMLHttpRequestUpload();
    return state;
  }

  function defineConstants(target) {
    var names = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
    var values = [UNSENT, OPENED, HEADERS_RECEIVED, LOADING, DONE];
    for (var index = 0; index < names.length; index += 1) {
      Object.defineProperty(target, names[index], {
        value: values[index],
        writable: false,
        enumerable: true,
        configurable: false
      });
    }
  }

  function installXhrSurface(proto) {
    proto.open = function open(a0, a1, a2) {
      return openImpl.call(this, a0, a1, a2);
    };
    proto.send = function send(body) {
      return sendImpl.call(this, body);
    };
    proto.abort = function abort() {
      return abortImpl.call(this);
    };
    proto.setRequestHeader = function setRequestHeader(name, value) {
      return setRequestHeaderImpl.call(this, name, value);
    };
    proto.getResponseHeader = function getResponseHeader(name) {
      return getResponseHeaderImpl.call(this, name);
    };
    proto.getAllResponseHeaders = function getAllResponseHeaders() {
      return getAllResponseHeadersImpl.call(this);
    };
    proto.overrideMimeType = function overrideMimeType(mime) {
      return overrideMimeTypeImpl.call(this, mime);
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

    defineProperty_('readyState', { get: getReadyState, enumerable: true, configurable: true });
    defineProperty_('status', { get: getStatus, enumerable: true, configurable: true });
    defineProperty_('statusText', { get: getStatusText, enumerable: true, configurable: true });
    defineProperty_('responseType', { get: getResponseType, set: setResponseType, enumerable: true, configurable: true });
    defineProperty_('responseText', { get: getResponseText, enumerable: true, configurable: true });
    defineProperty_('response', { get: getResponse, enumerable: true, configurable: true });
    defineProperty_('responseURL', { get: getResponseURL, enumerable: true, configurable: true });
    defineProperty_('timeout', { get: getTimeout, set: setTimeout_, enumerable: true, configurable: true });
    defineProperty_('withCredentials', { get: getWithCredentials, set: setWithCredentials, enumerable: true, configurable: true });
    defineProperty_('upload', { get: getUpload, enumerable: true, configurable: true });
    defineProperty_('onreadystatechange', { get: getOnreadystatechange, set: setOnreadystatechange, enumerable: true, configurable: true });
    defineProperty_('onload', { get: getOnload, set: setOnload, enumerable: true, configurable: true });
    defineProperty_('onloadend', { get: getOnloadend, set: setOnloadend, enumerable: true, configurable: true });
    defineProperty_('onerror', { get: getOnerror, set: setOnerror, enumerable: true, configurable: true });
    defineProperty_('ontimeout', { get: getOntimeout, set: setOntimeout, enumerable: true, configurable: true });
    defineProperty_('onabort', { get: getOnabort, set: setOnabort, enumerable: true, configurable: true });
    defineProperty_('onprogress', { get: getOnprogress, set: setOnprogress, enumerable: true, configurable: true });

    defineConstants(proto);
  }

  return {
    init: initXhr,
    install: installXhrSurface,
    installConstants: defineConstants,
    XMLHttpRequestUpload: XMLHttpRequestUpload
  };
})`
