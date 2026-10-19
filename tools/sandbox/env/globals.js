/**
 * Global object surface: `window`, `self`, `top`, `parent`, `frames` and the
 * Window prototype chain.
 *
 * Real browsers expose `window` as a `Window` instance whose prototype is
 * `Window.prototype`; samples do check `window.constructor.name`,
 * `Object.prototype.toString.call(window)` and `window instanceof Window`.
 * QuickJS's global object is a plain object, so we graft a `Window` prototype
 * onto it in the guest. The shim is registered as native source, therefore
 * `Window.toString()` and `Window.prototype.constructor` look like built-ins.
 */

export const meta = { id: 'globals', order: 10, requires: [] }

export function install(bridge) {
  const { ctx, profile, stealth } = bridge
  const global = bridge.global
  const hidden = { enumerable: false, configurable: true, writable: false }
  const accessorFlags = { enumerable: true, configurable: true }

  // `window` and its aliases. In a browser these are non-configurable own
  // accessors of the global object.
  for (const key of ['window', 'self', 'top', 'parent', 'frames']) {
    bridge.install(global, key, global, hidden)
  }

  bridge.install(global, 'globalThis', global, hidden)

  // Chrome and Edge have no `InternalError`; only Firefox (and old SpiderMonkey)
  // ships one. QuickJS does, so it must be removed for a Chromium profile even
  // when the `stack` module is not installed: `InternalError` is the name the
  // engine uses for its own stack overflow (see `runtime.js`), so leaving the
  // guest constructor in place would let a sample forge that classification
  // from a reduced environment. A Firefox profile keeps it, because there it is
  // a real part of the surface.
  if (profile.browser !== 'firefox') {
    const removedInternalError = ctx.evalCode('delete globalThis.InternalError', 'ai4r-internal:globals')
    if (removedInternalError.error) removedInternalError.error.dispose()
    else removedInternalError.value.dispose()
  }

  // Window state.
  bridge.install(global, 'name', '', { enumerable: true, configurable: true, writable: true })
  bridge.install(global, 'closed', false, hidden)
  bridge.install(global, 'opener', null, hidden)
  bridge.install(global, 'frameElement', null, hidden)
  bridge.install(global, 'length', 0, hidden)
  bridge.install(global, 'isSecureContext', true, hidden)
  bridge.install(global, 'crossOriginIsolated', profile.crossOriginIsolated === true, hidden)
  bridge.install(global, 'origin', profile.origin, hidden)
  bridge.install(global, 'event', undefined, hidden)
  bridge.install(global, 'clientInformation', undefined, hidden)

  // Viewport / geometry. These must agree with `screen` and `devicePixelRatio`.
  for (const [key, value] of Object.entries({
    devicePixelRatio: profile.screen.devicePixelRatio,
    innerWidth: profile.window.innerWidth,
    innerHeight: profile.window.innerHeight,
    outerWidth: profile.window.outerWidth,
    outerHeight: profile.window.outerHeight,
    screenX: profile.window.screenX,
    screenY: profile.window.screenY,
    screenLeft: profile.window.screenX,
    screenTop: profile.window.screenY,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
  })) {
    bridge.install(global, key, value, { enumerable: true, configurable: true, writable: false })
  }

  // Window methods that have no interesting behaviour but whose absence is a
  // VM tell.
  const noop = (name, length = 0) => bridge.fn(name, length, () => ctx.undefined)
  for (const name of ['focus', 'blur', 'close', 'stop', 'print']) {
    bridge.install(global, name, noop(name), { enumerable: true, configurable: true, writable: true })
  }

  bridge.install(
    global,
    'alert',
    bridge.fn('alert', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'window.alert', message: bridge.str(args, 0) })
      clockTick(bridge)
      return ctx.undefined
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'confirm',
    bridge.fn('confirm', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'window.confirm', message: bridge.str(args, 0) })
      clockTick(bridge)
      return ctx.false
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'prompt',
    bridge.fn('prompt', 2, ({ args }) => {
      bridge.emit('api', 'before', { api: 'window.prompt', message: bridge.str(args, 0) })
      clockTick(bridge)
      return ctx.null
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'open',
    bridge.fn('open', 3, ({ args }) => {
      const url = bridge.str(args, 0)
      bridge.emit('api', 'before', { api: 'window.open', url })
      if (url) bridge.reportIOC('url', url)
      clockTick(bridge)
      return ctx.null
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  for (const [name, arity] of [
    ['scrollTo', 2],
    ['scrollBy', 2],
    ['moveTo', 2],
    ['resizeTo', 2],
    ['postMessage', 2],
  ]) {
    bridge.install(global, name, noop(name, arity), { enumerable: true, configurable: true, writable: true })
  }

  bridge.install(
    global,
    'matchMedia',
    bridge.fn('matchMedia', 1, ({ args }) => {
      const media = bridge.str(args, 0)
      bridge.emit('api', 'before', { api: 'window.matchMedia', media })
      const list = bridge.obj({
        matches: evaluateMediaQuery(media, profile),
        media,
        onchange: null,
      })
      bridge.install(list, 'addListener', bridge.fn('addListener', 1, () => ctx.undefined), hidden)
      bridge.install(list, 'removeListener', bridge.fn('removeListener', 1, () => ctx.undefined), hidden)
      bridge.install(list, 'addEventListener', bridge.fn('addEventListener', 2, () => ctx.undefined), hidden)
      bridge.install(list, 'removeEventListener', bridge.fn('removeEventListener', 2, () => ctx.undefined), hidden)
      bridge.install(list, 'dispatchEvent', bridge.fn('dispatchEvent', 1, () => ctx.true), hidden)
      return list
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  bridge.install(
    global,
    'getSelection',
    bridge.fn('getSelection', 0, () => {
      const selection = bridge.obj({
        anchorNode: null,
        anchorOffset: 0,
        focusNode: null,
        focusOffset: 0,
        isCollapsed: true,
        rangeCount: 0,
        type: 'None',
      })
      bridge.install(selection, 'toString', bridge.fn('toString', 0, () => bridge.str([], 0, '')), hidden)
      bridge.install(selection, 'removeAllRanges', bridge.fn('removeAllRanges', 0, () => ctx.undefined), hidden)
      return selection
    }),
    { enumerable: true, configurable: true, writable: true },
  )

  // Window prototype chain, so `window instanceof Window` and
  // `Object.prototype.toString.call(window) === '[object Window]'` hold.
  if (stealth) {
    const Window = stealth.evalShim(
      `(function(){
        function Window() {}
        var proto = Window.prototype;
        Object.defineProperty(proto, Symbol.toStringTag, { value: 'Window', configurable: true });
        Object.setPrototypeOf(globalThis, proto);
        return Window;
      })()`,
      'Window',
    )
    bridge.install(global, 'Window', Window, { enumerable: false, configurable: true, writable: true })
    Window.dispose()
    // QuickJS tags its global object as `[object global]`; browsers report
    // `[object Window]`. An own Symbol.toStringTag on the global object yields
    // the browser string without touching Object.prototype.toString.
    const tag = ctx.evalCode(
      "Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window', configurable: true })",
      'ai4r-internal:window-tag',
    )
    if (tag.error) tag.error.dispose()
    else tag.value.dispose()
  }

  installIsolationTriple(bridge)
  installWebAssembly(bridge)
}

/**
 * `SharedArrayBuffer` / `Atomics` / `crossOriginIsolated` as one coherent triple.
 *
 * Chromium only exposes `SharedArrayBuffer` (and therefore `Atomics`) behind
 * cross-origin isolation. QuickJS ships both unconditionally — constructing a
 * `SharedArrayBuffer` while `crossOriginIsolated === false` is an impossible
 * combination and a single-line detection tell, so the default profile removes
 * the constructor. A profile that opts in (`crossOriginIsolated: true`) keeps the
 * native buffer and gains a single-threaded `Atomics` shim, because QuickJS has
 * no `Atomics` of its own.
 *
 * @param {object} bridge
 */
function installIsolationTriple(bridge) {
  const { ctx, profile } = bridge
  if (!profile.crossOriginIsolated) {
    // `delete` is enough: both globals are configurable in the QuickJS context.
    const removed = ctx.evalCode(
      "(function () { try { delete globalThis.SharedArrayBuffer } catch (e) {} try { delete globalThis.Atomics } catch (e) {} return typeof globalThis.SharedArrayBuffer === 'undefined' })()",
      'ai4r-internal:isolation',
    )
    if (removed.error) removed.error.dispose()
    else removed.value.dispose()
    return
  }

  const compiled = ctx.evalCode(ATOMICS_SOURCE, 'ai4r-internal:atomics')
  if (compiled.error) {
    const dumped = bridge.fromGuest(compiled.error)
    compiled.error.dispose()
    throw new Error(`Atomics shim failed to compile: ${dumped?.message ?? dumped}`)
  }
  const atomics = compiled.value
  try {
    for (const name of ATOMICS_MEMBERS) {
      const member = ctx.getProp(atomics, name)
      bridge.adopt(member, name)
      member.dispose()
    }
    bridge.install(bridge.global, 'Atomics', atomics, {
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } finally {
    atomics.dispose()
  }
  bridge.emit('sandbox', 'emit', { event: 'env.atomics-installed' })
}

/**
 * A coherent `WebAssembly` surface.
 *
 * The sandbox cannot execute WASM (the sample's `wasm` module would be foreign
 * code the instrumentation cannot see), but `typeof WebAssembly === 'undefined'`
 * is itself a tell and seven analysis modules probe it. The surface is therefore
 * a browser-shaped stub: every constructor and static method exists, validation
 * answers `false`, and compilation rejects with a `CompileError` whose message
 * has the browser's shape. Nothing is ever executed.
 *
 * @param {object} bridge
 */
function installWebAssembly(bridge) {
  const { ctx } = bridge
  const compiled = ctx.evalCode(WEBASSEMBLY_SOURCE, 'ai4r-internal:webassembly')
  if (compiled.error) {
    const dumped = bridge.fromGuest(compiled.error)
    compiled.error.dispose()
    throw new Error(`WebAssembly shim failed to compile: ${dumped?.message ?? dumped}`)
  }
  const webAssembly = compiled.value
  try {
    for (const name of WEBASSEMBLY_MEMBERS) {
      const member = ctx.getProp(webAssembly, name)
      bridge.adopt(member, name)
      member.dispose()
    }
    bridge.install(bridge.global, 'WebAssembly', webAssembly, {
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } finally {
    webAssembly.dispose()
  }
  bridge.emit('sandbox', 'emit', { event: 'env.webassembly-stub' })
}

function clockTick(bridge) {
  bridge.clock?.tick?.(1)
}

/**
 * Minimal but honest media-query evaluation for the queries samples actually
 * ask: width/height bounds, orientation, prefers-color-scheme and
 * prefers-reduced-motion. Comma-separated alternatives match if any matches.
 * @param {string} query
 * @param {object} profile
 */
function evaluateMediaQuery(query, profile) {
  const alternatives = String(query ?? '').split(',')
  for (const alternative of alternatives) {
    if (matchesSingleQuery(alternative.trim(), profile)) return true
  }
  return false
}

function matchesSingleQuery(query, profile) {
  if (!query) return false
  const width = profile.window.innerWidth
  const height = profile.window.innerHeight
  const rules = query.matchAll(/\(([^)]+)\)/g)
  let sawRule = false
  for (const match of rules) {
    sawRule = true
    const rule = match[1].trim().toLowerCase()
    const numeric = /^(min|max)-(width|height)\s*:\s*(-?[\d.]+)px$/.exec(rule)
    if (numeric) {
      const value = Number(numeric[3])
      const actual = numeric[2] === 'width' ? width : height
      if (numeric[1] === 'min' && actual < value) return false
      if (numeric[1] === 'max' && actual > value) return false
      continue
    }
    const orientation = /^orientation\s*:\s*(portrait|landscape)$/.exec(rule)
    if (orientation) {
      const actual = height >= width ? 'portrait' : 'landscape'
      if (orientation[1] !== actual) return false
      continue
    }
    const scheme = /^prefers-color-scheme\s*:\s*(dark|light)$/.exec(rule)
    if (scheme) {
      if (scheme[1] !== 'light') return false
      continue
    }
    const motion = /^prefers-reduced-motion\s*:\s*(no-preference|reduce)$/.exec(rule)
    if (motion) {
      if (motion[1] !== 'no-preference') return false
      continue
    }
    return false
  }
  return sawRule ? true : false
}

/** Members adopted as native-looking guest functions. */
const ATOMICS_MEMBERS = Object.freeze([
  'load',
  'store',
  'add',
  'sub',
  'and',
  'or',
  'xor',
  'exchange',
  'compareExchange',
  'wait',
  'waitAsync',
  'notify',
  'isLockFree',
])

/**
 * Single-threaded `Atomics`.
 *
 * The sandbox has exactly one thread of guest execution, so atomicity is free:
 * every operation is a plain read-modify-write on an integer typed array. `wait`
 * can never block (nothing else could store), therefore it reports what the
 * spec mandates for a value mismatch or an expired timeout. This is a *shim*,
 * not a lock implementation, and `_w6-fidelity-notes.md` says so.
 */
const ATOMICS_SOURCE = `(function () {
  var object = {};
  Object.defineProperty(object, Symbol.toStringTag, { value: 'Atomics', enumerable: false, configurable: true });
  var INTEGER_VIEWS = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
  function checkView(view, method) {
    for (var index = 0; index < INTEGER_VIEWS.length; index += 1) {
      if (view instanceof INTEGER_VIEWS[index]) return;
    }
    throw new TypeError('Atomics.' + method + ': First argument must be an integer typed array');
  }
  function checkIndex(view, value, method) {
    var index = Math.trunc(Number(value));
    if (!(index >= 0 && index < view.length)) {
      throw new RangeError('Atomics.' + method + ': Invalid atomic access index');
    }
    return index;
  }
  function define(name, fn) {
    Object.defineProperty(object, name, { value: fn, writable: true, enumerable: false, configurable: true });
  }
  define('load', function load(view, index) {
    checkView(view, 'load');
    return view[checkIndex(view, index, 'load')];
  });
  define('store', function store(view, index, value) {
    checkView(view, 'store');
    view[checkIndex(view, index, 'store')] = value;
    return value;
  });
  define('add', function add(view, index, value) {
    checkView(view, 'add');
    var at = checkIndex(view, index, 'add');
    var previous = view[at];
    view[at] = previous + value;
    return previous;
  });
  define('sub', function sub(view, index, value) {
    checkView(view, 'sub');
    var at = checkIndex(view, index, 'sub');
    var previous = view[at];
    view[at] = previous - value;
    return previous;
  });
  define('and', function and(view, index, value) {
    checkView(view, 'and');
    var at = checkIndex(view, index, 'and');
    var previous = view[at];
    view[at] = previous & value;
    return previous;
  });
  define('or', function or(view, index, value) {
    checkView(view, 'or');
    var at = checkIndex(view, index, 'or');
    var previous = view[at];
    view[at] = previous | value;
    return previous;
  });
  define('xor', function xor(view, index, value) {
    checkView(view, 'xor');
    var at = checkIndex(view, index, 'xor');
    var previous = view[at];
    view[at] = previous ^ value;
    return previous;
  });
  define('exchange', function exchange(view, index, value) {
    checkView(view, 'exchange');
    var at = checkIndex(view, index, 'exchange');
    var previous = view[at];
    view[at] = value;
    return previous;
  });
  define('compareExchange', function compareExchange(view, index, expected, replacement) {
    checkView(view, 'compareExchange');
    var at = checkIndex(view, index, 'compareExchange');
    var previous = view[at];
    if (previous === expected) view[at] = replacement;
    return previous;
  });
  function waitResult(view, index, value, method) {
    checkView(view, method);
    var at = checkIndex(view, index, method);
    return view[at] !== value ? 'not-equal' : 'timed-out';
  }
  define('wait', function wait(view, index, value) {
    return waitResult(view, index, value, 'wait');
  });
  define('waitAsync', function waitAsync(view, index, value) {
    return Promise.resolve(waitResult(view, index, value, 'waitAsync'));
  });
  define('notify', function notify(view) {
    checkView(view, 'notify');
    return 0;
  });
  define('isLockFree', function isLockFree(size) {
    var bytes = Math.trunc(Number(size));
    return bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8;
  });
  return object;
})()`

/** Members adopted as native-looking guest functions. */
const WEBASSEMBLY_MEMBERS = Object.freeze([
  'Module',
  'Instance',
  'Memory',
  'Table',
  'Global',
  'CompileError',
  'LinkError',
  'RuntimeError',
  'validate',
  'compile',
  'instantiate',
  'instantiateStreaming',
])

/**
 * Browser-shaped `WebAssembly` stub. See `installWebAssembly` for the policy.
 *
 * Determinism: every message is derived from the supplied bytes, never from the
 * host, so two same-seed runs produce identical errors.
 */
const WEBASSEMBLY_SOURCE = `(function () {
  var PAGE = 65536;
  var MAX_PAGES = 16;
  var MAX_TABLE = 1000;
  function buildError(ctor, name, message) {
    var error = new Error(message === undefined ? '' : String(message));
    Object.setPrototypeOf(error, ctor.prototype);
    return error;
  }
  function setupError(ctor, name) {
    ctor.prototype = Object.create(Error.prototype);
    Object.defineProperty(ctor.prototype, 'constructor', { value: ctor, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(ctor.prototype, 'name', { value: name, writable: true, enumerable: false, configurable: true });
  }
  // Each error class is written out separately: the stealth masker keys native
  // text by the exact function source, so a shared factory would map all three
  // classes onto the last registered name.
  function CompileError(message) {
    if (!(this instanceof CompileError)) throw new TypeError("Class constructor CompileError cannot be invoked without 'new'");
    return buildError(CompileError, 'CompileError', message);
  }
  setupError(CompileError, 'CompileError');
  function LinkError(message) {
    if (!(this instanceof LinkError)) throw new TypeError("Class constructor LinkError cannot be invoked without 'new'");
    return buildError(LinkError, 'LinkError', message);
  }
  setupError(LinkError, 'LinkError');
  function RuntimeError(message) {
    if (!(this instanceof RuntimeError)) throw new TypeError("Class constructor RuntimeError cannot be invoked without 'new'");
    return buildError(RuntimeError, 'RuntimeError', message);
  }
  setupError(RuntimeError, 'RuntimeError');

  function isBufferSource(value) {
    if (value === null || typeof value !== 'object') return false;
    if (value instanceof ArrayBuffer) return true;
    return ArrayBuffer.isView(value);
  }
  function bytesOf(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  function hex2(byte) {
    return (byte < 16 ? '0' : '') + byte.toString(16);
  }
  function magicOf(bytes) {
    if (bytes.length < 4) return 'unexpected end';
    return hex2(bytes[0]) + ' ' + hex2(bytes[1]) + ' ' + hex2(bytes[2]) + ' ' + hex2(bytes[3]);
  }
  function compileFailure(value, label) {
    return new CompileError(label + ': expected magic word 00 61 73 6d, found ' + magicOf(bytesOf(value)) + ' @+0');
  }

  function validate(value) {
    if (!isBufferSource(value)) throw new TypeError('WebAssembly.validate(): Argument 0 is not a BufferSource');
    return false;
  }
  function compile(value) {
    if (!isBufferSource(value)) {
      return Promise.reject(new TypeError('WebAssembly.compile(): Argument 0 is not a BufferSource'));
    }
    return Promise.reject(compileFailure(value, 'WebAssembly.compile()'));
  }
  function instantiate(value) {
    if (!isBufferSource(value)) {
      return Promise.reject(new TypeError('WebAssembly.instantiate(): Argument 0 must be a BufferSource or a WebAssembly.Module object'));
    }
    return Promise.reject(compileFailure(value, 'WebAssembly.instantiate()'));
  }
  function instantiateStreaming(source) {
    var isResponse = Boolean(source) && typeof source === 'object' &&
      typeof source.arrayBuffer === 'function' && typeof source.status === 'number';
    if (!isResponse) {
      return Promise.reject(new TypeError("Failed to execute 'instantiateStreaming' on 'WebAssembly': Argument 0 is not a Response"));
    }
    return Promise.reject(new CompileError('WebAssembly.instantiateStreaming(): Compiling wasm failed: the response is not a valid WebAssembly module'));
  }

  function Module(value) {
    if (!(this instanceof Module)) {
      throw new TypeError("Failed to construct 'WebAssembly.Module': Please use the 'new' operator");
    }
    if (!isBufferSource(value)) throw new TypeError('WebAssembly.Module(): Argument 0 must be a buffer source');
    throw compileFailure(value, 'WebAssembly.Module()');
  }
  Module.exports = function exports(object) {
    throw new TypeError('WebAssembly.Module.exports(): Argument 0 must be a WebAssembly.Module object');
  };
  Module.imports = function imports(object) {
    throw new TypeError('WebAssembly.Module.imports(): Argument 0 must be a WebAssembly.Module object');
  };
  Module.customSections = function customSections(object) {
    throw new TypeError('WebAssembly.Module.customSections(): Argument 0 must be a WebAssembly.Module object');
  };
  function Instance(object) {
    if (!(this instanceof Instance)) {
      throw new TypeError("Failed to construct 'WebAssembly.Instance': Please use the 'new' operator");
    }
    throw new TypeError('WebAssembly.Instance(): Argument 0 must be a WebAssembly.Module object');
  }
  function Memory(descriptor) {
    if (!(this instanceof Memory)) {
      throw new TypeError("Failed to construct 'WebAssembly.Memory': Please use the 'new' operator");
    }
    if (!descriptor || typeof descriptor !== 'object') {
      throw new TypeError('WebAssembly.Memory(): Argument 0 must be a WebAssembly.MemoryDescriptor');
    }
    var pages = Math.trunc(Number(descriptor.initial === undefined ? 0 : descriptor.initial));
    if (!(pages >= 0)) throw new RangeError("WebAssembly.Memory(): Property 'initial' is out of range");
    if (pages > MAX_PAGES) pages = MAX_PAGES;
    var buffer = new ArrayBuffer(pages * PAGE);
    Object.defineProperty(this, 'buffer', {
      get: function () { return buffer; },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(this, 'grow', {
      value: function grow(delta) {
        var step = Math.trunc(Number(delta));
        if (!(step >= 0)) throw new RangeError('WebAssembly.Memory.grow(): Delta must be a positive integer');
        if (pages + step > MAX_PAGES) throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
        var previous = pages;
        var grown = new ArrayBuffer((pages + step) * PAGE);
        new Uint8Array(grown).set(new Uint8Array(buffer));
        buffer = grown;
        pages += step;
        return previous;
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  function Table(descriptor) {
    if (!(this instanceof Table)) {
      throw new TypeError("Failed to construct 'WebAssembly.Table': Please use the 'new' operator");
    }
    if (!descriptor || typeof descriptor !== 'object') {
      throw new TypeError('WebAssembly.Table(): Argument 0 must be a WebAssembly.TableDescriptor');
    }
    var initial = Math.trunc(Number(descriptor.initial === undefined ? 0 : descriptor.initial));
    var length = initial > 0 ? Math.min(initial, MAX_TABLE) : 0;
    Object.defineProperty(this, 'length', { get: function () { return length; }, enumerable: true, configurable: true });
    Object.defineProperty(this, 'element', {
      value: String(descriptor.element === undefined ? 'anyfunc' : descriptor.element),
      writable: false,
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(this, 'get', {
      value: function get() { return null; },
      writable: true,
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(this, 'set', {
      value: function set() {
        throw new TypeError('WebAssembly.Table.set(): Argument 1 is not a WebAssembly function');
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(this, 'grow', {
      value: function grow(delta) {
        var previous = length;
        var step = Math.trunc(Number(delta));
        length = Math.min(previous + (step > 0 ? step : 0), MAX_TABLE);
        return previous;
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  function Global(descriptor) {
    if (!(this instanceof Global)) {
      throw new TypeError("Failed to construct 'WebAssembly.Global': Please use the 'new' operator");
    }
    if (!descriptor || typeof descriptor !== 'object' || descriptor.value === undefined) {
      throw new TypeError('WebAssembly.Global(): Argument 0 must be a WebAssembly.GlobalDescriptor');
    }
    var current = descriptor.value;
    var mutable = descriptor.mutable === true;
    Object.defineProperty(this, 'value', {
      get: function () { return current; },
      set: function (next) {
        if (!mutable) throw new TypeError('WebAssembly.Global.value: The global is immutable');
        current = next;
      },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(this, 'valueOf', {
      value: function valueOf() { return current; },
      writable: true,
      enumerable: false,
      configurable: true
    });
  }

  var WebAssembly = {};
  Object.defineProperty(WebAssembly, Symbol.toStringTag, { value: 'WebAssembly', enumerable: false, configurable: true });
  function defineMember(name, value) {
    Object.defineProperty(WebAssembly, name, { value: value, writable: true, enumerable: false, configurable: true });
  }
  defineMember('Module', Module);
  defineMember('Instance', Instance);
  defineMember('Memory', Memory);
  defineMember('Table', Table);
  defineMember('Global', Global);
  defineMember('CompileError', CompileError);
  defineMember('LinkError', LinkError);
  defineMember('RuntimeError', RuntimeError);
  defineMember('validate', validate);
  defineMember('compile', compile);
  defineMember('instantiate', instantiate);
  defineMember('instantiateStreaming', instantiateStreaming);
  return WebAssembly;
})()`
