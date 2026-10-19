/**
 * Anti-fingerprint hardening.
 *
 * Complains loudly (and repairs where safe) about anything that would reveal the
 * host runtime to the sample:
 *  - Node/Deno/Bun globals (`process`, `require`, `Buffer`, `module`, `global`,
 *    `__dirname`, `__filename`, `spawn`, ...);
 *  - classic analysis-farm honeypot globals (`_phantom`, `callPhantom`,
 *    `__nightmare`, `domAutomation`, `cdc_*` Selenium/ChromeDriver keys);
 *  - a broken Window prototype chain or a writable `navigator.webdriver`.
 *
 * The sample can observe the result of every check through the trace, and the
 * integration test asserts that `removed` is empty in a correct installation.
 */

const HOST_LEAK_KEYS = [
  'process',
  'require',
  'module',
  'exports',
  'Buffer',
  'global',
  '__dirname',
  '__filename',
  'Deno',
  'Bun',
  'spawn',
  'GLOBAL',
  'root',
  'IntlPolyfill',
  'fetchNode',
]

const HONEYPOT_KEYS = [
  '_phantom',
  'callPhantom',
  '__nightmare',
  'domAutomation',
  'domAutomationController',
  '__webdriver_evaluate',
  '__selenium_evaluate',
  '__driver_evaluate',
  '__webdriver_script_func',
  '_Selenium_IDE_Recorder',
  '_selenium',
  'calledSelenium',
  '__lastWatirAlert',
  '__lastWatirConfirm',
  '__lastWatirPrompt',
  '$cdc_asdjflasutopfhvcZLmcfl_',
  '$chrome_asyncScriptInfo',
  '__$webdriverAsyncExecutor',
  'webdriver',
]

export const meta = { id: 'anti-fingerprint', order: 130, requires: ['globals'] }

/**
 * Sanity bound for a single surface's moved-property count.
 *
 * The count comes from guest code; a sandboxed but arbitrary number must never
 * reach a report unbounded. 1000 own properties per platform object is already
 * far above any real browser surface.
 * @param {unknown} value
 * @returns {number}
 */
function clampCount(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.min(1000, Math.trunc(numeric))
}

/**
 * Move own properties to a fresh prototype layer.
 *
 * WebIDL objects expose attributes and operations on their prototype, not as
 * own properties. `Object.keys(navigator).length === 0`,
 * `navigator.hasOwnProperty('userAgent') === false` and
 * `Object.getOwnPropertyNames(document)` being short are all cheap probes that
 * would otherwise identify the sandbox. This moves every configurable own
 * property to a new prototype inserted above the existing chain, preserving
 * values and descriptors (getters/setters included).
 * @param {object} bridge
 */
function prototypifySurfaces(bridge) {
  const { ctx } = bridge
  const helper = ctx.evalCode(
    `(function (target) {
      if (!target || typeof target !== 'object') return 0;
      var current = Object.getPrototypeOf(target);
      var holder = Object.create(current);
      Object.setPrototypeOf(target, holder);
      var names = Object.getOwnPropertyNames(target);
      var moved = 0;
      for (var i = 0; i < names.length; i++) {
        var descriptor = Object.getOwnPropertyDescriptor(target, names[i]);
        if (!descriptor || !descriptor.configurable) continue;
        try {
          Object.defineProperty(holder, names[i], descriptor);
          delete target[names[i]];
          moved += 1;
        } catch (e) {}
      }
      var symbols = Object.getOwnPropertySymbols(target);
      for (var j = 0; j < symbols.length; j++) {
        var symbolDescriptor = Object.getOwnPropertyDescriptor(target, symbols[j]);
        if (!symbolDescriptor || !symbolDescriptor.configurable) continue;
        try {
          Object.defineProperty(holder, symbols[j], symbolDescriptor);
          delete target[symbols[j]];
        } catch (e) {}
      }
      return moved;
    })`,
    'ai4r-internal:prototypify',
  )
  if (helper.error) {
    helper.error.dispose()
    return
  }
  let moved = 0
  for (const expression of [
    'globalThis.navigator',
    'globalThis.screen',
    'globalThis.location',
    'globalThis.history',
    'globalThis.performance',
    'globalThis.crypto',
    'globalThis.console',
    'globalThis.document',
  ]) {
    const target = ctx.evalCode(expression)
    if (target.error) {
      target.error.dispose()
      continue
    }
    const call = ctx.callFunction(helper.value, ctx.undefined, [target.value])
    target.value.dispose()
    if (call.error) call.error.dispose()
    else {
      // `call.value` is a *handle*: `.value` is a linear-memory address, not the
      // number the guest returned. Reading it as a number put a host pointer
      // into the trace and made two same-seed runs disagree (D3).
      moved += clampCount(bridge.num([call.value], 0))
      call.value?.dispose?.()
    }
  }
  helper.value.dispose()
  bridge.emit('sandbox', 'emit', { event: 'anti-fingerprint.prototypified', moved })
}

/**
 * Give host-created platform objects browser-shaped brands:
 * `Object.prototype.toString.call(document) === '[object HTMLDocument]'`,
 * `document.constructor.name === 'HTMLDocument'`, `[object Navigator]`,
 * `[object Storage]`.
 *
 * navigator and the other host-built objects are re-parented onto a fresh
 * prototype carrying `Symbol.toStringTag` + `constructor` (their previous
 * prototype is `Object.prototype`, so tagging it would affect every object).
 * Storage shares `Storage.prototype`, which is branded in place. `document` is
 * *not* in this list: its brand and constructor come from the DOM interface
 * hierarchy (`HTMLDocument.prototype`), which is the same source `instanceof`
 * uses.
 * @param {object} bridge
 */
function brandObjects(bridge) {
  const { ctx } = bridge
  const factory = ctx.evalCode(
    `(function (objectProto, tagSymbol, makeCtor) {
      return function brand(target, tag, ctorName, usePrototype) {
        if (!target || typeof target !== 'object') return false;
        var holder = target;
        if (usePrototype) {
          // Keep the existing prototype chain (DOM methods live there) and
          // insert one brand layer above it.
          holder = Object.create(Object.getPrototypeOf(target) || objectProto);
          Object.setPrototypeOf(target, holder);
        }
        Object.defineProperty(holder, tagSymbol, { value: tag, configurable: true });
        if (ctorName) {
          Object.defineProperty(holder, 'constructor', {
            value: makeCtor(ctorName), writable: true, enumerable: false, configurable: true
          });
        }
        return true;
      };
    })`,
    'ai4r-internal:brand',
  )
  if (factory.error) {
    factory.error.dispose()
    return
  }
  const tagSymbol = ctx.evalCode('Symbol.toStringTag')
  if (tagSymbol.error) {
    tagSymbol.error.dispose()
    factory.value.dispose()
    return
  }
  const objectProto = ctx.getProp(ctx.global, 'Object')
  const objectProtoValue = ctx.getProp(objectProto, 'prototype')
  const makeCtor = bridge.fn('makeCtor', 1, ({ args }) => {
    const name = String(bridge.str(args, 0, 'Object'))
    const ctor = ctx.newFunctionWithOptions({ name, length: 0, isConstructor: false, fn: () => ctx.undefined })
    bridge.adopt(ctor, name)
    return ctor
  })
  const brand = ctx.callFunction(factory.value, ctx.undefined, [
    objectProtoValue,
    tagSymbol.value,
    makeCtor,
  ])
  factory.value.dispose()
  objectProto.dispose()
  objectProtoValue.dispose()
  tagSymbol.value.dispose()
  if (brand.error) {
    brand.error.dispose()
    return
  }

  const apply = (expression, tag, ctorName, usePrototype) => {
    const target = ctx.evalCode(expression)
    if (target.error) {
      target.error.dispose()
      return
    }
    const call = ctx.callFunction(brand.value, ctx.undefined, [
      target.value,
      ctx.newString(tag),
      ctx.newString(ctorName ?? ''),
      usePrototype ? ctx.true : ctx.false,
    ])
    target.value.dispose()
    if (call.error) {
      call.error.dispose()
      return
    }
    call.value.dispose()
  }

  // `usePrototype` is encoded in the tag string's 4th argument above; the guest
  // factory reads (target, tag, ctorName, usePrototype) and calls makeCtor only
  // when ctorName is non-empty.
  apply('globalThis.navigator', 'Navigator', 'Navigator', true)
  apply('globalThis.screen', 'Screen', 'Screen', true)
  apply('globalThis.location', 'Location', 'Location', true)
  apply('globalThis.history', 'History', 'History', true)
  apply('globalThis.performance', 'Performance', 'Performance', true)
  apply('globalThis.crypto', 'Crypto', 'Crypto', true)
  apply('globalThis.console', 'console', '', false)
  apply('globalThis.Storage && globalThis.Storage.prototype', 'Storage', '', false)
  brand.value.dispose()
  bridge.emit('sandbox', 'emit', { event: 'anti-fingerprint.branded' })
}

/**
 * Reconcile the DOM interface hierarchy with the modules that build their own
 * element and document classes.
 *
 * `dom.js` owns the hierarchy (`EventTarget <- Node <- Element <- HTMLElement
 * <- HTML*Element`, `CharacterData <- Text/Comment`, `Document <- HTMLDocument`)
 * and publishes one interface prototype per class, so `instanceof` is answered
 * by the prototype chain and never by a structural `Symbol.hasInstance` hook:
 * a second source of truth is itself a fingerprint tell.
 *
 * Two modules legitimately own classes the hierarchy also names:
 *  - `canvas` installs `HTMLCanvasElement`/`HTMLImageElement`/
 *    `HTMLAudioElement`/`HTMLVideoElement` with real behaviour. Their identity
 *    must survive, so only the parent link is added and the instance chain reads
 *    exactly like Blink's.
 *  - `dom-parser` installs `Document`/`HTMLDocument`/`XMLDocument` and builds
 *    parsed trees from them. Its shared base prototype is grafted under
 *    `HTMLDocument.prototype` and the hierarchy constructors are elected as the
 *    globals, so `document instanceof Document`, `parsed instanceof Document`
 *    and `parsed instanceof HTMLDocument` all hold.
 *
 * The registry (`customElements`) is guest code as well, because a custom
 * element constructor is a guest value.
 * @param {object} bridge
 */
function reconcileDomInterfaces(bridge) {
  const { ctx } = bridge
  const interfaces = bridge.domInterfaces
  const htmlElementProto = bridge.elementPrototype
  const htmlDocumentProto = bridge.documentPrototype
  // Without the DOM module there is no hierarchy to reconcile; selecting a
  // subset environment is legitimate, so this is not an installation failure.
  if (!interfaces || !htmlElementProto || !htmlDocumentProto) {
    bridge.emit('sandbox', 'error', { event: 'anti-fingerprint.elements-skipped', reason: 'no-dom-module' })
    return
  }

  const styleInterface = ctx.getProp(interfaces, 'CSSStyleDeclaration')
  const styleProto = ctx.getProp(styleInterface, 'prototype')
  styleInterface.dispose()

  const compiled = ctx.evalCode(DOM_INTERFACES_SOURCE, 'ai4r-internal:dom-interfaces')
  if (compiled.error) {
    styleProto.dispose()
    const dumped = bridge.fromGuest(compiled.error)
    compiled.error.dispose()
    bridge.emit('sandbox', 'error', { event: 'anti-fingerprint.elements-failed', stage: 'compile', error: dumped })
    return
  }
  const call = ctx.callFunction(compiled.value, ctx.undefined, [
    interfaces,
    htmlElementProto,
    htmlDocumentProto,
    styleProto,
  ])
  compiled.value.dispose()
  styleProto.dispose()
  if (call.error) {
    const dumped = bridge.fromGuest(call.error)
    call.error.dispose()
    bridge.emit('sandbox', 'error', { event: 'anti-fingerprint.elements-failed', stage: 'install', error: dumped })
    return
  }

  const surface = call.value
  const own = []
  const take = (target, key) => {
    const handle = ctx.getProp(target, key)
    own.push(handle)
    return handle
  }

  const customElements = ctx.getProp(surface, 'customElements')
  try {
    for (const name of ['define', 'get', 'whenDefined', 'upgrade']) {
      const method = ctx.getProp(customElements, name)
      bridge.adopt(method, name)
      method.dispose()
    }
    // `install` reads the value handle and does not take ownership of the
    // lifetime, so the handle is disposed here.
    bridge.install(bridge.global, 'customElements', customElements, {
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } finally {
    customElements.dispose()
  }

  let grafted = []
  try {
    const report = take(surface, 'grafted')
    grafted = JSON.parse(ctx.getString(report)) ?? []
  } catch {
    grafted = []
  }

  bridge.onDispose(() => {
    for (const handle of own) {
      try {
        handle.dispose()
      } catch {
        /* already released with the context */
      }
    }
    own.length = 0
  })
  surface.dispose()
  bridge.emit('sandbox', 'emit', { event: 'anti-fingerprint.elements-branded', grafted })
}

/**
 * Guest half of `reconcileDomInterfaces` plus the `CustomElementRegistry`.
 *
 * Everything is guest code so the closures live in the guest realm and no host
 * state is reachable from a prototype. The hierarchy prototypes are used, never
 * copied: an idempotent `Object.setPrototypeOf` on a foreign class prototype is
 * the only mutation.
 */
const DOM_INTERFACES_SOURCE = `(function (interfaces, htmlElementProto, htmlDocumentProto, styleProto) {
  var GLOBAL = globalThis;
  var grafted = [];

  function chainHas(proto, target) {
    var current = proto;
    while (current) {
      if (current === target) return true;
      current = Object.getPrototypeOf(current);
    }
    return false;
  }
  function defineHidden(target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
  }
  /**
   * Put the hierarchy prototype into the chain of a class another module owns,
   * without disturbing the members that module installed on its own prototype.
   */
  function graft(proto, parent, label) {
    if (!proto || typeof proto !== 'object' || !parent) return false;
    if (chainHas(proto, parent)) return false;
    try {
      Object.setPrototypeOf(proto, parent);
      grafted.push(label);
      return true;
    } catch (error) {
      return false;
    }
  }

  // ---- element interfaces owned by another module (canvas) --------------
  // The class identity stays: its constructor carries the real behaviour and
  // its prototype already holds the interface brand. Only the parent link is
  // added, so the chain is HTMLCanvasElement -> HTMLElement -> Element -> Node
  // -> EventTarget, exactly as the platform builds it.
  var names = Object.keys(interfaces);
  for (var index = 0; index < names.length; index += 1) {
    var name = names[index];
    if (name.slice(0, 4) !== 'HTML' || name.slice(-7) !== 'Element') continue;
    var existing = GLOBAL[name];
    if (typeof existing !== 'function' || existing === interfaces[name]) continue;
    graft(existing.prototype, htmlElementProto, name);
  }

  // ---- Document / HTMLDocument (dom-parser) -----------------------------
  var parsedDocument = typeof GLOBAL.Document === 'function' ? GLOBAL.Document : null;
  var parsedHTMLDocument = typeof GLOBAL.HTMLDocument === 'function' ? GLOBAL.HTMLDocument : null;
  var parsedBase = parsedDocument && parsedDocument !== interfaces.Document ? parsedDocument.prototype : null;
  var parsedHTMLProto = parsedHTMLDocument && parsedHTMLDocument !== interfaces.HTMLDocument
    ? parsedHTMLDocument.prototype
    : null;
  if (parsedBase && typeof parsedBase === 'object' && parsedBase !== Object.prototype) {
    // Parsed documents reach the hierarchy through their shared base prototype.
    // The parser's own members stay nearest to the instance, so tree building
    // keeps working unchanged.
    graft(parsedBase, htmlDocumentProto, 'Document.prototype');
    defineHidden(parsedBase, 'constructor', interfaces.Document);
    if (parsedHTMLProto) defineHidden(parsedHTMLProto, 'constructor', interfaces.HTMLDocument);
    defineHidden(GLOBAL, 'Document', interfaces.Document);
    defineHidden(GLOBAL, 'HTMLDocument', interfaces.HTMLDocument);
  }

  // ---- canvas element styles -------------------------------------------
  // Canvas builds its elements (and their style objects) itself; an instance
  // must still answer instanceof CSSStyleDeclaration.
  try {
    var probe = GLOBAL.document && typeof GLOBAL.document.createElement === 'function'
      ? GLOBAL.document.createElement('canvas')
      : null;
    var canvasStyleProto = probe && probe.style ? Object.getPrototypeOf(probe.style) : null;
    if (canvasStyleProto) graft(canvasStyleProto, styleProto, 'CSSStyleDeclaration');
  } catch (canvasError) {
    // A canvas element factory is optional; the shim element path already
    // carries the interface.
  }

  // ---- CustomElementRegistry -------------------------------------------
  var registry = new Map();
  var waiting = new Map();
  var upgraded = new WeakSet();
  var RESERVED = ['annotation-xml', 'color-profile', 'font-face', 'font-face-src',
    'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph'];
  var VALID_NAME = /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/;

  function named(name, message) {
    var error = new Error(message);
    error.name = name;
    return error;
  }
  function checkName(name, member) {
    var label = "Failed to execute '" + member + "' on 'CustomElementRegistry': ";
    var valid = typeof name === 'string' && VALID_NAME.test(name) && RESERVED.indexOf(name) < 0;
    if (!valid) throw named('SyntaxError', label + '"' + String(name) + '" is not a valid custom element name');
  }
  function upgradeElement(element) {
    if (!element || typeof element !== 'object' || element.nodeType !== 1) return;
    var tag = typeof element.localName === 'string' ? element.localName.toLowerCase() : '';
    var record = registry.get(tag);
    if (!record || upgraded.has(element)) return;
    upgraded.add(element);
    try { Object.setPrototypeOf(element, record.ctor.prototype); } catch (error) {}
    try { record.ctor.call(element); } catch (error) {
      // Class constructors cannot be invoked without the new operator; a real
      // upgrade constructs them; this bounded upgrade keeps the prototype link.
    }
  }
  function collect(root, out) {
    if (!root || typeof root !== 'object' || out.length >= 4096) return out;
    if (root.nodeType === 1) out.push(root);
    var children = root.childNodes;
    if (children && typeof children.length === 'number') {
      for (var index = 0; index < children.length; index += 1) collect(children[index], out);
    }
    return out;
  }

  var customElements = {};
  Object.defineProperty(customElements, Symbol.toStringTag, { value: 'CustomElementRegistry', enumerable: false, configurable: true });
  function method(name, fn) {
    Object.defineProperty(customElements, name, { value: fn, writable: true, enumerable: false, configurable: true });
  }
  method('define', function define(name, ctor) {
    checkName(name, 'define');
    if (typeof ctor !== 'function') {
      throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': parameter 2 is not a constructor.");
    }
    if (registry.has(name)) {
      throw named('NotSupportedError', "Failed to execute 'define' on 'CustomElementRegistry': the name " + JSON.stringify(name) + " has already been used with this registry");
    }
    registry.set(name, { ctor: ctor });
    var pending = waiting.get(name);
    if (pending) {
      waiting.delete(name);
      pending.resolve(ctor);
    }
  });
  method('get', function get(name) {
    var record = typeof name === 'string' ? registry.get(name) : undefined;
    return record ? record.ctor : undefined;
  });
  method('whenDefined', function whenDefined(name) {
    try { checkName(name, 'whenDefined'); } catch (error) { return Promise.reject(error); }
    var record = registry.get(name);
    if (record) return Promise.resolve(record.ctor);
    var pending = waiting.get(name);
    if (!pending) {
      var resolve;
      var promise = new Promise(function (settle) { resolve = settle; });
      pending = { promise: promise, resolve: resolve };
      waiting.set(name, pending);
    }
    return pending.promise;
  });
  method('upgrade', function upgrade(root) {
    var nodes = collect(root, []);
    for (var index = 0; index < nodes.length; index += 1) upgradeElement(nodes[index]);
  });

  return {
    customElements: customElements,
    grafted: JSON.stringify(grafted)
  };
})`

/**
 * The instrumentation channel is stored under a run-unique registered symbol.
 * Symbols never appear in `Object.getOwnPropertyNames` or `for...in`, but
 * `Object.getOwnPropertySymbols`, `Reflect.ownKeys` and
 * `Object.getOwnPropertyDescriptors` would expose it. Patch those three with
 * native-looking guest functions that filter only symbols whose key starts with
 * `ai4r.channel.`. Every other symbol (including `Symbol.toStringTag`) passes
 * through unchanged, so behaviour stays spec-shaped.
 * @param {object} bridge
 */
function hideChannelSymbols(bridge) {
  const { ctx, stealth } = bridge
  const factory = ctx.evalCode(
    `(function (origSymbols, origOwnKeys, origDescriptors) {
      var GLOBAL = globalThis;
      var TAG = Symbol.toStringTag;
      function ours(s, target) {
        // The Window tag is an own symbol on the global object (QuickJS would
        // otherwise report the string global); browsers expose it via
        // Window.prototype, so hide it from enumeration on the global only.
        if (s === TAG && target === GLOBAL) return true;
        try {
          var key = Symbol.keyFor(s);
          return typeof key === 'string' && key.slice(0, 5) === 'ai4r.';
        } catch (e) { return false; }
      }
      function getOwnPropertySymbols(target) {
        var all = origSymbols(target), out = [];
        for (var i = 0; i < all.length; i++) { if (!ours(all[i], target)) out.push(all[i]); }
        return out;
      }
      function ownKeys(target) {
        var all = origOwnKeys(target), out = [];
        for (var i = 0; i < all.length; i++) {
          if (typeof all[i] === 'symbol' && ours(all[i], target)) continue;
          out.push(all[i]);
        }
        return out;
      }
      function getOwnPropertyDescriptors(target) {
        var descriptors = origDescriptors(target);
        if (descriptors) {
          var symbols = origSymbols(target);
          for (var i = 0; i < symbols.length; i++) {
            if (ours(symbols[i], target)) { try { delete descriptors[symbols[i]]; } catch (e) {} }
          }
        }
        return descriptors;
      }
      return {
        getOwnPropertySymbols: getOwnPropertySymbols,
        ownKeys: ownKeys,
        getOwnPropertyDescriptors: getOwnPropertyDescriptors
      };
    })`,
    'ai4r-internal:symbol-filter',
  )
  if (factory.error) {
    factory.error.dispose()
    return
  }
  const objectHandle = ctx.getProp(ctx.global, 'Object')
  const reflectHandle = ctx.getProp(ctx.global, 'Reflect')
  const originals = [
    ctx.getProp(objectHandle, 'getOwnPropertySymbols'),
    ctx.getProp(reflectHandle, 'ownKeys'),
    ctx.getProp(objectHandle, 'getOwnPropertyDescriptors'),
  ]
  const call = ctx.callFunction(factory.value, ctx.undefined, originals)
  factory.value.dispose()
  for (const original of originals) original.dispose()
  if (call.error) {
    call.error.dispose()
    objectHandle.dispose()
    reflectHandle.dispose()
    return
  }
  const patched = call.value
  const install = (target, key) => {
    const fn = ctx.getProp(patched, key)
    bridge.adopt(fn, key)
    bridge.install(target, key, fn, { enumerable: false, configurable: true, writable: true })
    fn.dispose()
  }
  install(objectHandle, 'getOwnPropertySymbols')
  install(reflectHandle, 'ownKeys')
  install(objectHandle, 'getOwnPropertyDescriptors')
  patched.dispose()
  objectHandle.dispose()
  reflectHandle.dispose()
  bridge.emit('sandbox', 'emit', { event: 'anti-fingerprint.symbols-hidden' })
  void stealth
}

export function install(bridge) {
  const { ctx } = bridge
  const removed = []
  const present = []
  const checks = []

  const inspect = ctx.evalCode(
    `(function(leakKeys, honeypotKeys) {
      var out = { removed: [], present: [], checks: {} };
      function drop(key) {
        try { delete globalThis[key]; return !(key in globalThis); } catch (e) { return false; }
      }
      for (var i = 0; i < leakKeys.length; i++) {
        if (leakKeys[i] in globalThis) { if (drop(leakKeys[i])) out.removed.push(leakKeys[i]); }
      }
      for (var j = 0; j < honeypotKeys.length; j++) {
        if (honeypotKeys[j] in globalThis) { out.present.push(honeypotKeys[j]); if (drop(honeypotKeys[j])) out.removed.push(honeypotKeys[j]); }
      }
      out.checks.hostLeaks = leakKeys.filter(function(k) { return k in globalThis; });
      out.checks.windowIsGlobal = (typeof window === 'object' && window === globalThis);
      try {
        out.checks.windowConstructor = String(window.constructor && window.constructor.name);
        out.checks.windowProto = Object.prototype.toString.call(window);
      } catch (e) {
        out.checks.windowConstructor = 'error';
        out.checks.windowProto = 'error';
      }
      try { out.checks.webdriver = (typeof navigator === 'object' && navigator) ? navigator.webdriver : 'no-navigator'; }
      catch (e) { out.checks.webdriver = 'error'; }
      try { out.checks.globalKeys = Object.getOwnPropertyNames(globalThis).length; } catch (e) { out.checks.globalKeys = -1; }
      try { out.checks.hasEval = typeof eval === 'function'; } catch (e) { out.checks.hasEval = false; }
      return JSON.stringify(out);
    })`,
    'ai4r-internal:anti-fingerprint',
  )

  if (inspect.error) {
    const dumped = bridge.fromGuest(inspect.error)
    inspect.error.dispose()
    bridge.emit('sandbox', 'error', { event: 'anti-fingerprint.failed', error: dumped })
    return
  }
  const factory = inspect.value
  const call = ctx.callFunction(factory, ctx.undefined, [
    bridge.toGuest(HOST_LEAK_KEYS),
    bridge.toGuest(HONEYPOT_KEYS),
  ])
  factory.dispose()
  if (call.error) {
    const dumped = bridge.fromGuest(call.error)
    call.error.dispose()
    bridge.emit('sandbox', 'error', { event: 'anti-fingerprint.failed', error: dumped })
    return
  }
  let report = {}
  try {
    report = JSON.parse(ctx.getString(call.value))
  } catch {
    report = {}
  }
  call.value.dispose()

  removed.push(...(report.removed ?? []))
  present.push(...(report.present ?? []))
  checks.push(report.checks ?? {})

  // navigator.webdriver must be false for Chrome/Firefox profiles. The profile
  // already says so; this is a verification, not a mutation.
  if (report.checks?.webdriver === true) {
    bridge.emit('sandbox', 'error', { event: 'anti-fingerprint.webdriver-true' })
  }

  prototypifySurfaces(bridge)
  hideChannelSymbols(bridge)
  brandObjects(bridge)
  reconcileDomInterfaces(bridge)

  bridge.antiFingerprint = {
    removed,
    honeypotsPresent: present,
    checks: report.checks ?? {},
    hostLeakKeys: HOST_LEAK_KEYS,
    honeypotKeys: HONEYPOT_KEYS,
  }

  bridge.emit('sandbox', 'emit', {
    event: 'anti-fingerprint.checked',
    removed: removed.length,
    honeypots: present.length,
    hostLeaks: report.checks?.hostLeaks?.length ?? 0,
    windowConstructor: report.checks?.windowConstructor,
    windowProto: report.checks?.windowProto,
    webdriver: report.checks?.webdriver,
    globalKeys: report.checks?.globalKeys,
  })
}
