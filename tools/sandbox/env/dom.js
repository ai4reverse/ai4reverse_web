/**
 * DOM surface: events, `document`, elements and the cookie jar.
 *
 * Malicious JavaScript uses the DOM as an execution and storage channel: it
 * creates `<script>`/`<iframe>`/`<img>` elements, registers `load`/`error`
 * listeners, reads and writes `document.cookie`, parks stage-2 payloads in
 * elements and probes `document.visibilityState` before beaconing. A missing or
 * inert DOM is one of the loudest sandbox tells, so this module provides a
 * coherent, deterministic document whose event plumbing actually fires.
 *
 * Implementation shape:
 *  - The bulk of the model is a guest-side shim (`domShim`) injected into
 *    QuickJS, so instances, prototypes and closures live in the guest realm.
 *  - Guest-visible event constructors are built with `bridge.nativeConstructor`
 *    so `new Event('x') instanceof Event` holds and `toString()` reports
 *    `[native code]`.
 *  - Everything the platform must observe (clock reads, trace events, listener
 *    errors) is a native host function on the `host` hook object. Document and
 *    element methods are registered as native source through `bridge.adopt`.
 *
 * The document is not a parser: `write`/`writeln` are recorded, never executed.
 */

export const meta = { id: 'dom', order: 30, requires: ['globals'] }

/** Trace kinds the guest shim is allowed to emit (everything else is dropped). */
const GUEST_TRACE_KINDS = new Set(['api', 'dom'])

/** Payload caps: traces are forensic evidence, not a copy of the payload. */
const WRITE_TRACE_LIMIT = 2048
const COOKIE_TRACE_LIMIT = 2048

export function install(bridge) {
  const { ctx, profile } = bridge

  /** Virtual clock read; the sandbox clock is the only time source. */
  const clockNow = () => bridge.clock?.now?.() ?? profile.epoch
  /** Live document URL; `location` (order 50) publishes `bridge.currentUrl`. */
  const currentUrl = () => (typeof bridge.currentUrl === 'function' ? bridge.currentUrl() : profile.href)

  const owned = []
  const keep = (handle) => {
    owned.push(handle)
    return handle
  }
  bridge.onDispose(() => {
    while (owned.length > 0) {
      const handle = owned.pop()
      try {
        handle.dispose()
      } catch {
        /* a partially installed module may have released it already */
      }
    }
  })

  const pageUrl = parseUrl(currentUrl(), profile.href)
  const secureContext = pageUrl.protocol === 'https:'

  const shim = createShim(bridge, keep)
  // Expose the element/node prototypes so later environment modules and the
  // anti-fingerprint branding layer can attach interface brands without
  // touching the DOM shim's internals.
  for (const [key, name] of [['elementProto', 'elementPrototype'], ['nodeProto', 'nodePrototype'], ['documentProto', 'documentPrototype']]) {
    const prototypeHandle = ctx.getProp(shim, key)
    if (prototypeHandle && !prototypeHandle.disposed) {
      bridge[name] = prototypeHandle
      bridge.onDispose(() => {
        try {
          prototypeHandle.dispose()
        } catch {
          /* already gone */
        }
      })
    }
  }
  const shimValue = (key) => keep(ctx.getProp(shim, key))

  // ---- event constructors ------------------------------------------------
  const eventInits = shimValue('eventInits')
  const initEventFields = keep(ctx.getProp(eventInits, 'event'))
  const initCustomEventFields = keep(ctx.getProp(eventInits, 'customEvent'))
  const initMouseEventFields = keep(ctx.getProp(eventInits, 'mouseEvent'))
  const initKeyboardEventFields = keep(ctx.getProp(eventInits, 'keyboardEvent'))
  const initMessageEventFields = keep(ctx.getProp(eventInits, 'messageEvent'))
  const initErrorEventFields = keep(ctx.getProp(eventInits, 'errorEvent'))
  const initRejectionEventFields = keep(ctx.getProp(eventInits, 'promiseRejectionEvent'))

  const constructors = {
    Event: bridge.nativeConstructor({
      name: 'Event',
      arity: 2,
      bindings: { initFields: initEventFields },
      body: 'initFields(self, a0, a1);',
    }),
    CustomEvent: bridge.nativeConstructor({
      name: 'CustomEvent',
      arity: 2,
      bindings: { initFields: initCustomEventFields },
      body: 'initFields(self, a0, a1);',
    }),
    MouseEvent: bridge.nativeConstructor({
      name: 'MouseEvent',
      arity: 2,
      bindings: { initFields: initMouseEventFields },
      body: 'initFields(self, a0, a1);',
    }),
    KeyboardEvent: bridge.nativeConstructor({
      name: 'KeyboardEvent',
      arity: 2,
      bindings: { initFields: initKeyboardEventFields },
      body: 'initFields(self, a0, a1);',
    }),
    MessageEvent: bridge.nativeConstructor({
      name: 'MessageEvent',
      arity: 2,
      bindings: { initFields: initMessageEventFields },
      body: 'initFields(self, a0, a1);',
    }),
    ErrorEvent: bridge.nativeConstructor({
      name: 'ErrorEvent',
      arity: 2,
      bindings: { initFields: initErrorEventFields },
      body: 'initFields(self, a0, a1);',
    }),
    PromiseRejectionEvent: bridge.nativeConstructor({
      name: 'PromiseRejectionEvent',
      arity: 2,
      bindings: { initFields: initRejectionEventFields },
      body: 'initFields(self, a0, a1);',
    }),
  }

  const eventMethods = shimValue('eventMethods')
  const eventPrototypeMethods = [
    'preventDefault',
    'stopPropagation',
    'stopImmediatePropagation',
    'composedPath',
    'initEvent',
    'initCustomEvent',
    'initMouseEvent',
    'getModifierState',
  ]
  const methodFlags = { enumerable: false, configurable: true, writable: true }
  const prototypes = {}
  for (const [name, ctor] of Object.entries(constructors)) {
    const prototype = keep(ctx.getProp(ctor, 'prototype'))
    prototypes[name] = prototype
    for (const methodName of eventPrototypeMethods) {
      const method = keep(ctx.getProp(eventMethods, methodName))
      bridge.install(prototype, methodName, method, methodFlags)
      bridge.adopt(method, methodName)
    }
  }

  // `new MouseEvent(...) instanceof Event` must hold for every subtype.
  const setPrototypeOf = keep(
    ctx.unwrapResult(ctx.evalCode('(function(target, proto){ return Object.setPrototypeOf(target, proto) })')),
  )
  for (const name of Object.keys(constructors)) {
    if (name === 'Event') continue
    const call = ctx.callFunction(setPrototypeOf, ctx.undefined, [prototypes[name], prototypes.Event])
    if (call.error) call.error.dispose()
    else call.value.dispose()
  }

  for (const [name, ctor] of Object.entries(constructors)) {
    bridge.install(bridge.global, name, ctor, { enumerable: false, configurable: true, writable: true })
  }

  // The shim's element factories need the constructors for `element.click()`
  // and `document.createEvent()`.
  const setEventConstructors = keep(ctx.getProp(shim, 'setEventConstructors'))
  const constructorTable = bridge.obj(constructors)
  const bound = ctx.callFunction(setEventConstructors, ctx.undefined, [constructorTable])
  if (bound.error) bound.error.dispose()
  else bound.value.dispose()

  // ---- window event target ----------------------------------------------
  const eventTargetMethods = shimValue('eventTargetMethods')
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
    const method = keep(ctx.getProp(eventTargetMethods, name))
    bridge.install(bridge.global, name, method, methodFlags)
    bridge.adopt(method, name)
  }

  const installHandlerProperties = keep(ctx.getProp(shim, 'installHandlerProperties'))
  const handlerInstall = ctx.callFunction(installHandlerProperties, ctx.undefined, [bridge.global])
  if (handlerInstall.error) handlerInstall.error.dispose()
  else handlerInstall.value.dispose()

  const getComputedStyle = keep(ctx.getProp(shim, 'getComputedStyle'))
  bridge.install(bridge.global, 'getComputedStyle', getComputedStyle, methodFlags)
  bridge.adopt(getComputedStyle, 'getComputedStyle')

  // ---- document ----------------------------------------------------------
  const createDocument = keep(ctx.getProp(shim, 'createDocument'))
  const documentConfig = bridge.toGuest({
    readyState: 'complete',
    referrer: profile.referrer ?? '',
    domain: pageUrl.hostname,
    visibilityState: profile.visibilityState ?? 'visible',
    hidden: profile.hidden === true,
    lastModified: profile.lastModified ?? profile.localeDateFormat ?? '',
    hasFocus: profile.hasFocus !== false,
    scriptUrl: currentUrl(),
    // The entry script is evaluated as an external resource, so the tag has a
    // `src` and an empty body, exactly like a `<script src>` bootstrap.
    scriptText: '',
  })
  const created = ctx.callFunction(createDocument, ctx.undefined, [documentConfig])
  if (created.error) {
    const dumped = bridge.fromGuest(created.error)
    created.error.dispose()
    throw new Error(`dom shim could not create document: ${dumped?.message ?? dumped}`)
  }
  const document = keep(created.value)
  bridge.install(document, 'defaultView', bridge.global, methodFlags)

  const installDocumentHandlers = ctx.callFunction(installHandlerProperties, ctx.undefined, [document])
  if (installDocumentHandlers.error) installDocumentHandlers.error.dispose()
  else installDocumentHandlers.value.dispose()

  installDocumentApi(bridge, {
    document,
    shim,
    keep,
    clockNow,
    currentUrl,
    pageUrl,
    secureContext,
  })

  // `on<type>` accessors are JS closures; register their sources as native so
  // `Function.prototype.toString` does not reveal an interpreted environment.
  adoptHandlerAccessors(bridge, shim)
  // IDL attribute accessors are closures for the same reason.
  adoptHandlerAccessors(bridge, shim, 'listAttributeAccessors')

  bridge.install(bridge.global, 'document', document, {
    enumerable: true,
    configurable: true,
    writable: false,
  })

  // ---- hooks for the rest of the environment ----------------------------
  const dispatchInGuest = keep(ctx.getProp(shim, 'dispatchEvent'))
  /**
   * Dispatch a guest event on a guest target (window, document or element).
   * @param {object} target guest handle
   * @param {object} event guest handle
   * @returns {boolean} false when a listener cancelled the event
   */
  bridge.dispatchEvent = (target, event) => {
    if (!target || !event) return false
    const call = ctx.callFunction(dispatchInGuest, ctx.undefined, [target, event])
    if (call.error) {
      call.error.dispose()
      bridge.emit('exception', 'error', { origin: 'env', api: 'bridge.dispatchEvent' })
      return false
    }
    const cancelled = ctx.dump(call.value) === false
    call.value.dispose()
    return !cancelled
  }

  // Element factories let other environment modules (canvas, media, fonts)
  // supply richer element objects for their own tag. The map is owned by
  // whoever registers first; entries are `(options) => guestHandle | undefined`
  // where `options` is the second argument of `document.createElement`.
  if (!bridge.elementFactories) bridge.elementFactories = new Map()

  // Adopt the remaining method tables so every DOM method reports native code.
  const listTableKeys = keep(ctx.getProp(shim, 'listTableKeys'))
  for (const tableName of [
    'eventTargetMethods',
    'nodeMethods',
    'elementMethods',
    'documentMethods',
    'styleMethods',
    'classListMethods',
    'collectionMethods',
  ]) {
    const table = ctx.getProp(shim, tableName)
    adoptTable(bridge, listTableKeys, table)
    table.dispose()
  }
}

/**
 * Install the host-backed part of the document: `createElement` (which consults
 * `bridge.elementFactories` first), the cookie jar and the write APIs.
 *
 * @param {object} bridge
 * @param {object} context
 */
function installDocumentApi(bridge, context) {
  const { ctx } = bridge
  const { document, shim, keep, clockNow, currentUrl, pageUrl, secureContext } = context
  const shimCreateElement = keep(ctx.getProp(shim, 'createElement'))
  const methodFlags = { enumerable: false, configurable: true, writable: true }

  bridge.install(
    document,
    'createElement',
    bridge.fn('createElement', 2, ({ args }) => {
      const tag = bridge.str(args, 0, 'div').toLowerCase()
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
        throw namedError(
          'InvalidCharacterError',
          `Failed to execute 'createElement' on 'Document': The tag name provided ('${tag}') is not a valid name.`,
        )
      }
      const factory = bridge.elementFactories.get(tag)
      if (typeof factory === 'function') {
        const hasOptions = args.length > 1 && args[1] !== undefined && ctx.typeof(args[1]) === 'object'
        const options = hasOptions ? args[1] : ctx.newObject()
        let produced
        try {
          produced = factory(options)
        } finally {
          if (!hasOptions) options.dispose()
        }
        if (produced) return produced
      }
      bridge.emit('api', 'before', { api: 'document.createElement', tag })
      const call = ctx.callFunction(shimCreateElement, ctx.undefined, [bridge.toGuest(tag)])
      if (call.error) {
        const dumped = bridge.fromGuest(call.error)
        call.error.dispose()
        throw new Error(dumped?.message ?? 'createElement failed')
      }
      return call.value
    }),
    methodFlags,
  )

  const cookieJar = createCookieJar({ bridge, clockNow, pageUrl, secureContext })
  bridge.accessor(document, 'cookie', {
    enumerable: false,
    get: () => ctx.newString(cookieJar.read()),
    set: ({ args }) => cookieJar.write(bridge.value(args, 0)),
  })

  bridge.accessor(document, 'URL', { enumerable: false, get: () => ctx.newString(currentUrl()) })
  bridge.accessor(document, 'documentURI', { enumerable: false, get: () => ctx.newString(currentUrl()) })

  for (const [name, arity] of [
    ['write', 1],
    ['writeln', 1],
  ]) {
    bridge.install(
      document,
      name,
      bridge.fn(name, arity, ({ args }) => {
        const parts = []
        for (let index = 0; index < args.length; index += 1) parts.push(bridge.str(args, index, ''))
        const text = parts.join('')
        bridge.emit('dom', 'before', {
          api: `document.${name}`,
          length: text.length,
          text: text.slice(0, WRITE_TRACE_LIMIT),
        })
        bridge.clock?.tick?.(1)
        return ctx.undefined
      }),
      methodFlags,
    )
  }

  // `open`/`close` are recorded only: the document is never re-parsed.
  bridge.install(
    document,
    'open',
    bridge.fn('open', 0, () => {
      bridge.emit('dom', 'before', { api: 'document.open' })
      // The handle is duplicated: the callback's return value is disposed by
      // the QuickJS binding once it has been handed to the guest.
      return document.dup()
    }),
    methodFlags,
  )

  bridge.install(
    document,
    'close',
    bridge.fn('close', 0, () => {
      bridge.emit('dom', 'before', { api: 'document.close' })
      return ctx.undefined
    }),
    methodFlags,
  )

  bridge.emit('dom', 'emit', { api: 'document.installed', url: currentUrl(), domain: pageUrl.hostname })
}

/**
 * Cookie jar for `document.cookie`.
 *
 * Attributes are parsed and honoured where they change what a page can observe:
 * `Secure` cookies never exist on an http profile, `HttpOnly` is not settable
 * from script (the flag is stripped, the cookie is kept), `Path`/`Domain` gate
 * visibility, `Expires`/`Max-Age` delete. Every read and write is traced because
 * cookies are the most common exfiltration and C2-config channel.
 *
 * @param {object} options
 */
function createCookieJar({ bridge, clockNow, pageUrl, secureContext }) {
  /** @type {Map<string, {name:string, value:string, domain:string, path:string, expires:number|null, secure:boolean}>} */
  const jar = new Map()
  const keyOf = (cookie) => `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`

  const domainMatches = (host, cookieDomain) =>
    host === cookieDomain || host.endsWith(`.${cookieDomain}`)
  const pathMatches = (pathname, cookiePath) =>
    pathname === cookiePath || pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)

  const write = (raw) => {
    const input = String(raw ?? '')
    if (input === '') return
    const separator = input.indexOf(';')
    const pair = (separator < 0 ? input : input.slice(0, separator)).trim()
    const equals = pair.indexOf('=')
    const name = equals > 0 ? pair.slice(0, equals).trim() : ''
    if (!name) {
      bridge.emit('storage', 'enter', { api: 'document.cookie', action: 'ignore', reason: 'invalid-name' })
      return
    }
    const cookie = {
      name,
      value: pair.slice(equals + 1).trim(),
      domain: pageUrl.hostname,
      path: defaultCookiePath(pageUrl.pathname),
      expires: null,
      secure: false,
    }
    let httpOnly = false
    if (separator >= 0) {
      for (const part of input.slice(separator + 1).split(';')) {
        const trimmed = part.trim()
        if (trimmed === '') continue
        const split = trimmed.indexOf('=')
        const attribute = (split < 0 ? trimmed : trimmed.slice(0, split)).trim().toLowerCase()
        const attributeValue = split < 0 ? '' : trimmed.slice(split + 1).trim()
        if (attribute === 'expires') {
          const parsed = Date.parse(attributeValue)
          if (Number.isFinite(parsed)) cookie.expires = parsed
        } else if (attribute === 'max-age') {
          const seconds = Number.parseInt(attributeValue, 10)
          if (Number.isFinite(seconds)) cookie.expires = clockNow() + seconds * 1000
        } else if (attribute === 'path') {
          if (attributeValue.startsWith('/')) cookie.path = attributeValue
        } else if (attribute === 'domain') {
          const domain = attributeValue.replace(/^\./, '').toLowerCase()
          if (domain) cookie.domain = domain
        } else if (attribute === 'secure') {
          cookie.secure = true
        } else if (attribute === 'httponly') {
          httpOnly = true
        }
      }
    }

    if (cookie.expires !== null && cookie.expires <= clockNow()) {
      jar.delete(keyOf(cookie))
      bridge.emit('storage', 'enter', { api: 'document.cookie', action: 'expire', name })
      return
    }
    if (!domainMatches(pageUrl.hostname, cookie.domain)) {
      bridge.emit('storage', 'enter', {
        api: 'document.cookie',
        action: 'ignore',
        reason: 'domain',
        name,
        domain: cookie.domain,
      })
      return
    }
    if (cookie.secure && !secureContext) {
      bridge.emit('storage', 'enter', {
        api: 'document.cookie',
        action: 'ignore',
        reason: 'secure-context',
        name,
        secureContext,
      })
      return
    }

    jar.set(keyOf(cookie), cookie)
    bridge.emit('storage', 'enter', {
      api: 'document.cookie',
      action: 'set',
      name,
      value: cookie.value.slice(0, COOKIE_TRACE_LIMIT),
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnlyIgnored: httpOnly,
      expires: cookie.expires,
    })
    bridge.clock?.tick?.(1)
  }

  const read = () => {
    const now = clockNow()
    const pairs = []
    for (const [key, cookie] of jar) {
      if (cookie.expires !== null && cookie.expires <= now) {
        jar.delete(key)
        continue
      }
      if (cookie.secure && !secureContext) continue
      if (!domainMatches(pageUrl.hostname, cookie.domain)) continue
      if (!pathMatches(pageUrl.pathname, cookie.path)) continue
      pairs.push(`${cookie.name}=${cookie.value}`)
    }
    bridge.emit('storage', 'enter', {
      api: 'document.cookie',
      action: 'get',
      count: pairs.length,
      names: pairs.slice(0, 50).map((pair) => pair.slice(0, pair.indexOf('='))),
    })
    return pairs.join('; ')
  }

  return { read, write, jar }
}

/**
 * Adopt guest accessor closures as native sources.
 * @param {object} bridge
 * @param {object} shim namespace handle
 * @param {string} [listName] shim member returning the accessor array
 */
function adoptHandlerAccessors(bridge, shim, listName = 'listHandlerAccessors') {
  const { ctx } = bridge
  const listAccessors = ctx.getProp(shim, listName)
  try {
    const call = ctx.callFunction(listAccessors, ctx.undefined, [])
    if (call.error) {
      call.error.dispose()
      return
    }
    const lengthHandle = ctx.getProp(call.value, 'length')
    const count = ctx.dump(lengthHandle)
    lengthHandle.dispose()
    for (let index = 0; index < count; index += 1) {
      const accessor = ctx.getProp(call.value, index)
      bridge.adopt(accessor)
      accessor.dispose()
    }
    call.value.dispose()
  } finally {
    listAccessors.dispose()
  }
}

/**
 * Register every function of a guest method table as native source.
 * @param {object} bridge
 * @param {object} listKeysHandle guest `listTableKeys` helper
 * @param {object} tableHandle
 */
function adoptTable(bridge, listKeysHandle, tableHandle) {
  const { ctx } = bridge
  const call = ctx.callFunction(listKeysHandle, ctx.undefined, [tableHandle])
  if (call.error) {
    call.error.dispose()
    return
  }
  const names = ctx.dump(call.value) ?? []
  call.value.dispose()
  for (const name of names) {
    const method = ctx.getProp(tableHandle, name)
    bridge.adopt(method, name)
    method.dispose()
  }
}

/**
 * Guest source of the WebIDL own-property transform.
 *
 * Chromium keeps IDL attributes on the interface prototype and the instance
 * owns nothing, which is what a fingerprint probe reads:
 * `Object.keys(document.createElement('div')).length === 0`. The DOM shim gets
 * that shape with attribute accessors on its own prototypes (see
 * `installAttributeTable`), but the canvas module builds its element classes
 * separately and hangs three expandos (`style`, `dataset`, `ownerDocument`) on
 * the instance. This transform gives those instances the same shape: it inserts
 * one prototype layer **per object** (the descriptors keep their values, so
 * per-instance state survives), moves every configurable own property there and
 * re-parents the object onto it. Reads, writes, `instanceof`, brands and
 * `for...in` are unchanged; only `Object.keys`/`hasOwnProperty`
 * /`getOwnPropertyNames` start matching the platform. Non-configurable own
 * properties stay put, which is the `Object.getOwnPropertyNames` contract the
 * D6 probe checks.
 */
const WEBIDL_SHAPE_SOURCE = `(function (target) {
  if (!target || typeof target !== 'object') return target;
  var names = Object.getOwnPropertyNames(target);
  if (names.length === 0) return target;
  var holder = Object.create(Object.getPrototypeOf(target));
  for (var index = 0; index < names.length; index += 1) {
    var descriptor = Object.getOwnPropertyDescriptor(target, names[index]);
    if (!descriptor || !descriptor.configurable) continue;
    Object.defineProperty(holder, names[index], descriptor);
    delete target[names[index]];
  }
  Object.setPrototypeOf(target, holder);
  return target;
})`

/**
 * Compile (once per bridge) the WebIDL own-property transform and return the
 * guest function handle. Used by the canvas element factory so canvas/media
 * instances match the DOM shim's elements.
 *
 * @param {object} bridge
 * @returns {object|null} guest function handle, or null when it cannot compile
 */
export function elementPrototypifier(bridge) {
  if (bridge.elementPrototypifier) return bridge.elementPrototypifier
  const { ctx } = bridge
  const compiled = ctx.evalCode(WEBIDL_SHAPE_SOURCE, 'ai4r-internal:webidl-shape')
  if (compiled.error) {
    compiled.error.dispose()
    return null
  }
  const handle = compiled.value
  bridge.elementPrototypifier = handle
  bridge.onDispose?.(() => {
    try {
      handle.dispose()
    } catch {
      /* already released with the context */
    }
  })
  return handle
}

/**
 * Evaluate the guest-side DOM shim and return its namespace object.
 * @param {object} bridge
 * @param {(handle: object) => object} keep
 */
function createShim(bridge, keep) {
  const { ctx } = bridge
  /** Host hooks: the only channel from the guest model back to the sandbox. */
  const hooks = bridge.obj({
    // Returns a handle, never a plain number: `bridge.fn` disposes every
    // primitive it converts before quickjs-emscripten duplicates the result.
    now: bridge.fn('now', 0, () => ctx.newNumber(bridge.clock?.performanceNow?.() ?? 0)),
    trace: bridge.fn('trace', 3, ({ args }) => {
      const kind = bridge.str(args, 0, '')
      if (!GUEST_TRACE_KINDS.has(kind)) return ctx.undefined
      const payload = bridge.value(args, 2)
      bridge.emit(kind, bridge.str(args, 1, 'emit'), payload && typeof payload === 'object' ? payload : {})
      return ctx.undefined
    }),
    listenerError: bridge.fn('listenerError', 5, ({ args }) => {
      const stack = bridge.str(args, 4, '')
      bridge.emit('exception', 'error', {
        origin: 'listener',
        listenerPhase: bridge.str(args, 1, 'bubble'),
        eventType: bridge.str(args, 0, ''),
        name: bridge.str(args, 2, 'Error'),
        message: bridge.str(args, 3, ''),
        stack: bridge.stealth?.sanitizeStack ? bridge.stealth.sanitizeStack(stack) : stack,
      })
      bridge.clock?.tick?.(1)
      return ctx.undefined
    }),
  })

  const compiled = ctx.evalCode(`(${domShim.toString()})`, 'ai4r-internal:shim')
  if (compiled.error) {
    const dumped = bridge.fromGuest(compiled.error)
    compiled.error.dispose()
    throw new Error(`dom shim failed to compile: ${dumped?.message ?? dumped}`)
  }
  const factory = compiled.value
  const call = ctx.callFunction(factory, ctx.undefined, [hooks])
  factory.dispose()
  if (call.error) {
    const dumped = bridge.fromGuest(call.error)
    call.error.dispose()
    throw new Error(`dom shim failed: ${dumped?.message ?? dumped}`)
  }
  return keep(call.value)
}

/**
 * @param {string} href
 * @param {string} fallback
 */
function parseUrl(href, fallback) {
  try {
    return new URL(href)
  } catch {
    return new URL(fallback)
  }
}

/** @param {string} pathname */
function defaultCookiePath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/'
  const index = pathname.lastIndexOf('/')
  return index <= 0 ? '/' : pathname.slice(0, index)
}

/**
 * @param {string} name DOMException-ish name
 * @param {string} message
 */
function namedError(name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

/**
 * Guest-side DOM model. Never executed on the host: `install()` injects its
 * source into QuickJS, so every object it creates belongs to the guest realm.
 * It must not reference module scope — `host` is the only bridge back.
 *
 * @param {{now: Function, trace: Function, listenerError: Function}} host
 * @returns {object} namespace consumed by `install()`
 */
function domShim(host) {
  'use strict'

  /** @type {WeakMap<object, object[]>} EventTarget -> listener records */
  var listeners = new WeakMap()
  /** @type {WeakMap<object, object>} node -> mutable node state */
  var nodeStates = new WeakMap()
  /** @type {WeakMap<object, object>} CSSStyleDeclaration -> style state */
  var styleStates = new WeakMap()
  /** @type {WeakMap<object, object>} DOMTokenList -> owning element */
  var classStates = new WeakMap()
  /** @type {WeakMap<object, object[]>} live NodeList-ish collections */
  var collectionStates = new WeakMap()

  var constructors = Object.create(null)
  var ownerDocument = null
  var documentHasFocus = true
  var handlerAccessors = []

  var HANDLER_TYPES = [
    'abort',
    'animationend',
    'animationstart',
    'beforeunload',
    'blur',
    'change',
    'click',
    'contextmenu',
    'copy',
    'cut',
    'dblclick',
    'drag',
    'dragend',
    'dragenter',
    'dragleave',
    'dragover',
    'dragstart',
    'drop',
    'error',
    'focus',
    'hashchange',
    'input',
    'invalid',
    'keydown',
    'keypress',
    'keyup',
    'load',
    'message',
    'mousedown',
    'mouseenter',
    'mouseleave',
    'mousemove',
    'mouseout',
    'mouseover',
    'mouseup',
    'offline',
    'online',
    'pagehide',
    'pageshow',
    'paste',
    'pointercancel',
    'pointerdown',
    'pointermove',
    'pointerup',
    'popstate',
    'readystatechange',
    'reset',
    'resize',
    'scroll',
    'select',
    'storage',
    'submit',
    'touchend',
    'touchmove',
    'touchstart',
    'transitionend',
    'unhandledrejection',
    'unload',
    'visibilitychange',
    'wheel',
  ]

  var EVENT_CONSTRUCTOR_ALIASES = {
    event: 'Event',
    events: 'Event',
    htmlevents: 'Event',
    uievent: 'Event',
    uievents: 'Event',
    customevent: 'CustomEvent',
    customevents: 'CustomEvent',
    mouseevent: 'MouseEvent',
    mouseevents: 'MouseEvent',
    keyboardevent: 'KeyboardEvent',
    keyboardevents: 'KeyboardEvent',
    messageevent: 'MessageEvent',
    messageevents: 'MessageEvent',
    errorevent: 'ErrorEvent',
    errorevents: 'ErrorEvent',
    promiserejectionevent: 'PromiseRejectionEvent',
  }

  var COMPUTED_DEFAULTS = {
    display: 'block',
    position: 'static',
    visibility: 'visible',
    opacity: '1',
    'z-index': 'auto',
    color: 'rgb(0, 0, 0)',
    'background-color': 'rgba(0, 0, 0, 0)',
    'font-family': 'Arial',
    'font-size': '16px',
    'font-weight': '400',
    'line-height': 'normal',
    overflow: 'visible',
    'pointer-events': 'auto',
    transform: 'none',
    top: 'auto',
    left: 'auto',
    cursor: 'auto',
    'user-select': 'auto',
    'box-sizing': 'content-box',
  }

  var REFLECTED_ATTRIBUTES = {
    alt: 'alt',
    class: 'className',
    dir: 'dir',
    height: 'height',
    href: 'href',
    id: 'id',
    lang: 'lang',
    name: 'name',
    placeholder: 'placeholder',
    rel: 'rel',
    src: 'src',
    target: 'target',
    title: 'title',
    type: 'type',
    value: 'value',
    width: 'width',
  }

  // ---------------------------------------------------------------- helpers
  function defineValue(object, key, value) {
    Object.defineProperty(object, key, { value: value, writable: true, enumerable: true, configurable: true })
  }

  function defineHidden(object, key, value) {
    Object.defineProperty(object, key, { value: value, writable: true, enumerable: false, configurable: true })
  }

  function defineAccessor(object, key, get, set) {
    Object.defineProperty(object, key, { get: get, set: set, enumerable: false, configurable: true })
  }

  function installMethodTable(prototype, table) {
    for (var key in table) {
      if (!Object.prototype.hasOwnProperty.call(table, key)) continue
      defineHidden(prototype, key, table[key])
    }
  }

  function installAccessorTable(prototype, table) {
    var keys = Object.keys(table)
    for (var i = 0; i < keys.length; i += 1) {
      var entry = table[keys[i]]
      defineAccessor(prototype, keys[i], entry.get, entry.set)
    }
  }

  // -------------------------------------------------------- IDL attributes
  // Chromium keeps every IDL attribute on the interface prototype and the data
  // in an internal slot, so `Object.keys(document.createElement('div'))` is 0,
  // `hasOwnProperty('style')` is false and a write never adds an own property
  // (a detector differentiates a data-property shim exactly that way). The shim
  // therefore installs attribute accessors on `nodeProto`/`elementProto` and
  // keeps the values in the per-node state bag (`state.values`). The bag is
  // keyed by the instance, so `Object.setPrototypeOf` (custom-element upgrade)
  // cannot drop the values and `Object.getOwnPropertyNames(node)` stays empty.
  var NODE_ATTRIBUTE_NAMES = [
    'nodeType', 'nodeName', 'nodeValue', 'ownerDocument',
    'parentNode', 'parentElement', 'childNodes', 'children',
    'firstChild', 'lastChild', 'nextSibling', 'previousSibling',
    'textContent',
  ]
  var ELEMENT_ATTRIBUTE_NAMES = [
    'localName', 'namespaceURI', 'tagName',
    'id', 'className', 'title', 'lang', 'dir', 'hidden',
    'src', 'href', 'rel', 'type', 'name', 'value', 'alt', 'target', 'placeholder',
    'width', 'height',
    'innerText', 'innerHTML', 'outerHTML', 'outerText',
    'dataset', 'style', 'classList',
    'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent',
    'clientWidth', 'clientHeight', 'clientTop', 'clientLeft',
    'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft',
  ]
  var CHARACTER_DATA_ATTRIBUTE_NAMES = ['data', 'length']
  var attributeAccessors = []

  /** Internal-slot bag of the nearest node in the receiver's prototype chain. */
  function bagFor(receiver) {
    var current = receiver
    while (current !== null && (typeof current === 'object' || typeof current === 'function')) {
      var state = nodeStates.get(current)
      if (state) {
        if (!state.values) state.values = Object.create(null)
        return state.values
      }
      current = Object.getPrototypeOf(current)
    }
    return null
  }

  /**
   * One accessor pair per attribute. The generated source embeds the key
   * literal: the stealth masker keys native text by source text, so a shared
   * closure would make every getter stringify with the same name.
   */
  function makeAttributeAccessor(key, kind) {
    var source =
      kind === 'get'
        ? 'return function () { var bag = bagFor(this); return bag ? bag["' + key + '"] : undefined }'
        : 'return function (value) { var bag = bagFor(this); if (bag) bag["' + key + '"] = value }'
    var accessor = new Function('bagFor', source)(bagFor)
    Object.defineProperty(accessor, 'name', {
      value: (kind === 'get' ? 'get ' : 'set ') + key,
      configurable: true,
    })
    return accessor
  }

  function installAttributeTable(prototype, names) {
    for (var index = 0; index < names.length; index += 1) {
      var key = names[index]
      var getter = makeAttributeAccessor(key, 'get')
      var setter = makeAttributeAccessor(key, 'set')
      Object.defineProperty(prototype, key, { get: getter, set: setter, enumerable: true, configurable: true })
      attributeAccessors.push(getter, setter)
    }
  }

  function stringOf(value) {
    return value === undefined || value === null ? '' : String(value)
  }

  function numberOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback
  }

  function optionOf(init, key, fallback) {
    return init && typeof init === 'object' && init[key] !== undefined ? init[key] : fallback
  }

  function targetName(target) {
    if (target === null || target === undefined) return ''
    if (target === globalThis) return 'window'
    var type = target.nodeType
    if (type === 9) return '#document'
    if (type === 1) return String(target.tagName || 'element')
    if (type === 11) return '#document-fragment'
    if (type === 3) return '#text'
    if (type === 8) return '#comment'
    return 'target'
  }

  // ----------------------------------------------------------------- events
  function baseEvent(self, type, init) {
    var options = init && typeof init === 'object' ? init : {}
    defineValue(self, 'type', type === undefined ? '' : String(type))
    defineValue(self, 'bubbles', options.bubbles === true)
    defineValue(self, 'cancelable', options.cancelable === true)
    defineValue(self, 'composed', options.composed === true)
    defineValue(self, 'target', null)
    defineValue(self, 'srcElement', null)
    defineValue(self, 'currentTarget', null)
    defineValue(self, 'eventPhase', 0)
    defineValue(self, 'defaultPrevented', false)
    defineValue(self, 'isTrusted', false)
    defineValue(self, 'timeStamp', host.now())
    defineValue(self, 'returnValue', true)
    defineValue(self, 'cancelBubble', false)
    defineHidden(self, '__stop', false)
    defineHidden(self, '__stopImmediate', false)
  }

  function modifierFields(self, options) {
    defineValue(self, 'ctrlKey', options.ctrlKey === true)
    defineValue(self, 'shiftKey', options.shiftKey === true)
    defineValue(self, 'altKey', options.altKey === true)
    defineValue(self, 'metaKey', options.metaKey === true)
  }

  function keyCodeFor(key) {
    if (typeof key !== 'string' || key.length !== 1) return 0
    return key.toUpperCase().charCodeAt(0)
  }

  var eventInits = {
    event: function initEventFields(self, type, init) {
      baseEvent(self, type, init)
    },
    customEvent: function initCustomEventFields(self, type, init) {
      baseEvent(self, type, init)
      defineValue(self, 'detail', optionOf(init, 'detail', null))
    },
    mouseEvent: function initMouseEventFields(self, type, init) {
      baseEvent(self, type, init)
      var options = init && typeof init === 'object' ? init : {}
      var clientX = numberOr(options.clientX, 0)
      var clientY = numberOr(options.clientY, 0)
      defineValue(self, 'detail', numberOr(options.detail, 0))
      defineValue(self, 'screenX', numberOr(options.screenX, 0))
      defineValue(self, 'screenY', numberOr(options.screenY, 0))
      defineValue(self, 'clientX', clientX)
      defineValue(self, 'clientY', clientY)
      defineValue(self, 'pageX', numberOr(options.pageX, clientX))
      defineValue(self, 'pageY', numberOr(options.pageY, clientY))
      defineValue(self, 'offsetX', numberOr(options.offsetX, 0))
      defineValue(self, 'offsetY', numberOr(options.offsetY, 0))
      defineValue(self, 'movementX', numberOr(options.movementX, 0))
      defineValue(self, 'movementY', numberOr(options.movementY, 0))
      defineValue(self, 'button', numberOr(options.button, 0))
      defineValue(self, 'buttons', numberOr(options.buttons, 0))
      defineValue(self, 'which', numberOr(options.which, 1))
      defineValue(self, 'relatedTarget', optionOf(init, 'relatedTarget', null))
      modifierFields(self, options)
    },
    keyboardEvent: function initKeyboardEventFields(self, type, init) {
      baseEvent(self, type, init)
      var options = init && typeof init === 'object' ? init : {}
      var key = stringOf(options.key)
      var keyCode = numberOr(options.keyCode, keyCodeFor(key))
      defineValue(self, 'key', key)
      defineValue(self, 'code', stringOf(options.code))
      defineValue(self, 'location', numberOr(options.location, 0))
      defineValue(self, 'repeat', options.repeat === true)
      defineValue(self, 'isComposing', options.isComposing === true)
      defineValue(self, 'keyCode', keyCode)
      defineValue(self, 'charCode', numberOr(options.charCode, 0))
      defineValue(self, 'which', numberOr(options.which, keyCode))
      modifierFields(self, options)
    },
    messageEvent: function initMessageEventFields(self, type, init) {
      baseEvent(self, type, init)
      defineValue(self, 'data', optionOf(init, 'data', null))
      defineValue(self, 'origin', stringOf(optionOf(init, 'origin', '')))
      defineValue(self, 'lastEventId', stringOf(optionOf(init, 'lastEventId', '')))
      defineValue(self, 'source', optionOf(init, 'source', null))
      defineValue(self, 'ports', optionOf(init, 'ports', []))
    },
    errorEvent: function initErrorEventFields(self, type, init) {
      baseEvent(self, type, init)
      defineValue(self, 'message', stringOf(optionOf(init, 'message', '')))
      defineValue(self, 'filename', stringOf(optionOf(init, 'filename', '')))
      defineValue(self, 'lineno', numberOr(optionOf(init, 'lineno', 0), 0))
      defineValue(self, 'colno', numberOr(optionOf(init, 'colno', 0), 0))
      defineValue(self, 'error', optionOf(init, 'error', null))
    },
    promiseRejectionEvent: function initPromiseRejectionEventFields(self, type, init) {
      baseEvent(self, type, init)
      defineValue(self, 'promise', optionOf(init, 'promise', null))
      defineValue(self, 'reason', optionOf(init, 'reason', undefined))
    },
  }

  var eventMethods = {
    preventDefault: function preventDefault() {
      if (this.cancelable === true) {
        this.defaultPrevented = true
        this.returnValue = false
      }
    },
    stopPropagation: function stopPropagation() {
      this.__stop = true
      this.cancelBubble = true
    },
    stopImmediatePropagation: function stopImmediatePropagation() {
      this.__stop = true
      this.__stopImmediate = true
      this.cancelBubble = true
    },
    composedPath: function composedPath() {
      return this.target === null || this.target === undefined ? [] : [this.target]
    },
    initEvent: function initEvent(type, bubbles, cancelable) {
      this.type = stringOf(type)
      this.bubbles = bubbles === true
      this.cancelable = cancelable === true
      this.defaultPrevented = false
    },
    initCustomEvent: function initCustomEvent(type, bubbles, cancelable, detail) {
      this.type = stringOf(type)
      this.bubbles = bubbles === true
      this.cancelable = cancelable === true
      this.detail = detail === undefined ? null : detail
    },
    initMouseEvent: function initMouseEvent(type, bubbles, cancelable, view, detail, screenX, screenY, clientX, clientY) {
      this.type = stringOf(type)
      this.bubbles = bubbles === true
      this.cancelable = cancelable === true
      this.detail = numberOr(detail, 0)
      this.screenX = numberOr(screenX, 0)
      this.screenY = numberOr(screenY, 0)
      this.clientX = numberOr(clientX, 0)
      this.clientY = numberOr(clientY, 0)
      return view
    },
    getModifierState: function getModifierState(key) {
      if (key === 'Control') return this.ctrlKey === true
      if (key === 'Shift') return this.shiftKey === true
      if (key === 'Alt') return this.altKey === true
      if (key === 'Meta') return this.metaKey === true
      return false
    },
  }

  // --------------------------------------------------------- EventTarget API
  function listenerListOf(target) {
    var list = listeners.get(target)
    if (!list) {
      list = []
      listeners.set(target, list)
    }
    return list
  }

  function removeListenerRecord(target, record) {
    var list = listeners.get(target)
    if (!list) return
    var index = list.indexOf(record)
    if (index >= 0) list.splice(index, 1)
  }

  function reportListenerError(phase, event, error) {
    var name = 'Error'
    var message = ''
    var stack = ''
    if (error !== null && typeof error === 'object') {
      name = error.name === undefined ? 'Error' : String(error.name)
      message = error.message === undefined ? '' : String(error.message)
      stack = typeof error.stack === 'string' ? error.stack : ''
    } else {
      message = stringOf(error)
    }
    try {
      host.listenerError(stringOf(event.type), phase, name, message, stack)
    } catch (suppressed) {
      // Reporting must never disturb the dispatch that triggered it.
      void suppressed
    }
  }

  function invokeListener(target, event, record, state) {
    var listener = record.listener
    try {
      if (typeof listener === 'function') listener.call(target, event)
      else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event)
    } catch (error) {
      reportListenerError(record.capture ? 'capture' : 'bubble', event, error)
    }
    if (event.__stopImmediate === true) state.immediate = true
  }

  function dispatchEventOn(target, event) {
    if (event === null || typeof event !== 'object' || event.type === undefined) {
      throw new TypeError(
        "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.",
      )
    }
    var list = listeners.get(target)
    var snapshot = list ? list.slice() : []
    var state = { immediate: false }
    var typeName = stringOf(event.type)
    event.target = target
    event.srcElement = target
    event.currentTarget = target
    event.eventPhase = 2
    // A single target has two passes: capture listeners, then bubble listeners.
    for (var pass = 0; pass < 2; pass += 1) {
      var capture = pass === 0
      for (var index = 0; index < snapshot.length; index += 1) {
        if (state.immediate) break
        var record = snapshot[index]
        if (record.capture !== capture) continue
        if (record.type !== typeName) continue
        if (list && list.indexOf(record) < 0) continue
        if (record.once) removeListenerRecord(target, record)
        invokeListener(target, event, record, state)
      }
    }
    if (!state.immediate) {
      var handler = target['on' + typeName]
      if (typeof handler === 'function') {
        try {
          handler.call(target, event)
        } catch (error) {
          reportListenerError('handler', event, error)
        }
      }
    }
    event.eventPhase = 0
    event.currentTarget = null
    host.trace('dom', 'emit', {
      event: 'dispatch',
      target: targetName(target),
      type: typeName,
      listeners: snapshot.length,
      defaultPrevented: event.defaultPrevented === true,
    })
    return event.defaultPrevented === true ? false : true
  }

  var eventTargetMethods = {
    addEventListener: function addEventListener(type, listener, options) {
      var target = this
      if (listener === null || listener === undefined) return
      var capture = false
      var once = false
      var passive = false
      if (typeof options === 'boolean') capture = options
      else if (options && typeof options === 'object') {
        capture = options.capture === true
        once = options.once === true
        passive = options.passive === true
      }
      var list = listenerListOf(target)
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].listener === listener && list[index].capture === capture) return
      }
      var typeName = stringOf(type)
      list.push({ type: typeName, listener: listener, capture: capture, once: once, passive: passive })
      host.trace('api', 'before', {
        api: 'EventTarget.addEventListener',
        target: targetName(target),
        type: typeName,
        capture: capture,
      })
    },
    removeEventListener: function removeEventListener(type, listener, options) {
      var target = this
      var capture = typeof options === 'boolean' ? options : Boolean(options && options.capture === true)
      var list = listeners.get(target)
      if (!list) return
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].listener === listener && list[index].capture === capture) {
          list.splice(index, 1)
          host.trace('api', 'before', {
            api: 'EventTarget.removeEventListener',
            target: targetName(target),
            type: stringOf(type),
            capture: capture,
          })
          return
        }
      }
    },
    dispatchEvent: function dispatchEvent(event) {
      return dispatchEventOn(this, event)
    },
  }

  // ------------------------------------------------------------ node model
  function createNodeState(tag) {
    return { tag: tag, attrs: Object.create(null), childNodes: [], children: [], parent: null }
  }

  function refreshChildren(node) {
    var state = nodeStates.get(node)
    if (!state) return
    state.children.length = 0
    for (var index = 0; index < state.childNodes.length; index += 1) {
      if (state.childNodes[index].nodeType === 1) state.children.push(state.childNodes[index])
    }
    node.firstChild = state.childNodes.length > 0 ? state.childNodes[0] : null
    node.lastChild = state.childNodes.length > 0 ? state.childNodes[state.childNodes.length - 1] : null
    for (var position = 0; position < state.childNodes.length; position += 1) {
      var child = state.childNodes[position]
      child.previousSibling = position > 0 ? state.childNodes[position - 1] : null
      child.nextSibling = position + 1 < state.childNodes.length ? state.childNodes[position + 1] : null
    }
  }

  function detachNode(node) {
    var state = nodeStates.get(node)
    if (!state || !state.parent) return
    var parent = state.parent
    var parentState = nodeStates.get(parent)
    if (parentState) {
      var index = parentState.childNodes.indexOf(node)
      if (index >= 0) parentState.childNodes.splice(index, 1)
    }
    state.parent = null
    node.parentNode = null
    node.parentElement = null
    refreshChildren(parent)
  }

  function insertNode(parent, node, reference) {
    var parentState = nodeStates.get(parent)
    if (!parentState) return node
    if (node === null || typeof node !== 'object' || node.nodeType === undefined) {
      throw new TypeError(
        "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
      )
    }
    if (reference === node) reference = null
    detachNode(node)
    var index = parentState.childNodes.length
    if (reference !== null && reference !== undefined) {
      index = parentState.childNodes.indexOf(reference)
      if (index < 0) {
        throw new Error(
          "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
        )
      }
    }
    parentState.childNodes.splice(index, 0, node)
    var state = nodeStates.get(node)
    if (state) state.parent = parent
    node.parentNode = parent
    node.parentElement = parent.nodeType === 1 ? parent : null
    refreshChildren(parent)
    return node
  }

  function removeNodeFrom(parent, child) {
    var state = nodeStates.get(parent)
    if (!state) return child
    var index = state.childNodes.indexOf(child)
    if (index < 0) {
      throw new Error(
        "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      )
    }
    state.childNodes.splice(index, 1)
    var childState = nodeStates.get(child)
    if (childState) childState.parent = null
    child.parentNode = null
    child.parentElement = null
    refreshChildren(parent)
    return child
  }

  var nodeMethods = {
    appendChild: function appendChild(node) {
      return insertNode(this, node, null)
    },
    insertBefore: function insertBefore(node, reference) {
      return insertNode(this, node, reference === undefined ? null : reference)
    },
    removeChild: function removeChild(node) {
      return removeNodeFrom(this, node)
    },
    replaceChild: function replaceChild(node, replaced) {
      if (replaced === null || replaced === undefined) return insertNode(this, node, null)
      insertNode(this, node, replaced)
      return removeNodeFrom(this, replaced)
    },
    append: function append() {
      for (var index = 0; index < arguments.length; index += 1) {
        var item = arguments[index]
        insertNode(this, typeof item === 'string' ? makeTextNode(item) : item, null)
      }
    },
    remove: function remove() {
      detachNode(this)
    },
    contains: function contains(node) {
      var current = node
      while (current) {
        if (current === this) return true
        current = current.parentNode
      }
      return false
    },
    hasChildNodes: function hasChildNodes() {
      var state = nodeStates.get(this)
      return Boolean(state) && state.childNodes.length > 0
    },
    cloneNode: function cloneNode(deep) {
      var copy = cloneShallow(this)
      if (deep === true && copy) {
        for (var index = 0; index < this.childNodes.length; index += 1) {
          insertNode(copy, this.childNodes[index].cloneNode(true), null)
        }
      }
      return copy
    },
    getElementsByTagName: function getElementsByTagName() {
      return makeCollection()
    },
    getElementsByClassName: function getElementsByClassName() {
      return makeCollection()
    },
    querySelector: function querySelector() {
      return null
    },
    querySelectorAll: function querySelectorAll() {
      return makeCollection()
    },
  }

  function cloneShallow(node) {
    var type = node.nodeType
    if (type === 1) {
      var element = makeElement(node.localName)
      element.id = stringOf(node.id)
      element.className = stringOf(node.className)
      element.textContent = stringOf(node.textContent)
      element.innerHTML = stringOf(node.innerHTML)
      element.innerText = stringOf(node.innerText)
      if (node.style) element.style.cssText = node.style.cssText
      var names = Object.keys(nodeStates.get(node).attrs)
      for (var index = 0; index < names.length; index += 1) {
        element.setAttribute(names[index], nodeStates.get(node).attrs[names[index]])
      }
      return element
    }
    if (type === 3) return makeTextNode(node.data)
    if (type === 8) return makeCommentNode(node.data)
    if (type === 11) return makeFragment()
    return null
  }

  // --------------------------------------------------------- element model
  function boxForElement(element) {
    var tag = stringOf(element.localName || element.tagName).toLowerCase()
    var hash = 0
    for (var index = 0; index < tag.length; index += 1) hash = (hash * 31 + tag.charCodeAt(index)) % 100003
    var width = 80 + (hash % 320)
    var height = 16 + (hash % 48)
    return { width: width, height: height, top: 100 + (hash % 400), left: 8 + (hash % 100) }
  }

  function makeElement(tagName) {
    var tag = stringOf(tagName).toLowerCase() || 'div'
    var element = Object.create(elementProto)
    var state = createNodeState(tag)
    nodeStates.set(element, state)
    var box = boxForElement({ localName: tag })
    // Initial attribute values live in the internal slot; see `bagFor` for why
    // the instance itself owns nothing.
    state.values = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      localName: tag,
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      nodeValue: null,
      ownerDocument: ownerDocument,
      parentNode: null,
      parentElement: null,
      childNodes: state.childNodes,
      children: state.children,
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
      id: '',
      className: '',
      title: '',
      lang: '',
      dir: '',
      hidden: false,
      src: '',
      href: '',
      rel: '',
      type: '',
      name: '',
      value: '',
      alt: '',
      target: '',
      placeholder: '',
      width: 0,
      height: 0,
      textContent: '',
      innerText: '',
      innerHTML: '',
      outerHTML: '',
      outerText: '',
      dataset: {},
      style: makeStyle(element, null),
      classList: makeClassList(element),
      offsetWidth: box.width,
      offsetHeight: box.height,
      offsetTop: box.top,
      offsetLeft: box.left,
      offsetParent: null,
      clientWidth: box.width - 2,
      clientHeight: box.height - 2,
      clientTop: 0,
      clientLeft: 0,
      scrollWidth: box.width,
      scrollHeight: box.height,
      scrollTop: 0,
      scrollLeft: 0,
    }
    return element
  }

  function reflectAttribute(element, key, value) {
    if (key === 'style') {
      if (element.style) element.style.cssText = value
      return
    }
    var property = REFLECTED_ATTRIBUTES[key]
    if (property) element[property] = value
  }

  var elementMethods = {
    setAttribute: function setAttribute(name, value) {
      var state = nodeStates.get(this)
      if (!state) return
      var key = stringOf(name).toLowerCase()
      var text = stringOf(value)
      state.attrs[key] = text
      reflectAttribute(this, key, text)
    },
    setAttributeNS: function setAttributeNS(namespace, name, value) {
      this.setAttribute(name, value)
    },
    getAttribute: function getAttribute(name) {
      var state = nodeStates.get(this)
      if (!state) return null
      var key = stringOf(name).toLowerCase()
      if (key === 'id') return this.id === '' ? null : stringOf(this.id)
      if (key === 'class') return this.className === '' ? null : stringOf(this.className)
      if (key === 'style') return this.style.cssText === '' ? null : this.style.cssText
      return Object.prototype.hasOwnProperty.call(state.attrs, key) ? state.attrs[key] : null
    },
    getAttributeNS: function getAttributeNS(namespace, name) {
      return this.getAttribute(name)
    },
    removeAttribute: function removeAttribute(name) {
      var state = nodeStates.get(this)
      if (!state) return
      var key = stringOf(name).toLowerCase()
      delete state.attrs[key]
      reflectAttribute(this, key, '')
      if (key === 'style' && this.style) this.style.cssText = ''
    },
    hasAttribute: function hasAttribute(name) {
      return this.getAttribute(name) !== null
    },
    toggleAttribute: function toggleAttribute(name, force) {
      var present = this.getAttribute(name) !== null
      var next = force === undefined ? !present : force === true
      if (next && !present) this.setAttribute(name, '')
      else if (!next && present) this.removeAttribute(name)
      return next
    },
    getAttributeNames: function getAttributeNames() {
      var state = nodeStates.get(this)
      if (!state) return []
      var names = Object.keys(state.attrs)
      if (this.id !== '' && names.indexOf('id') < 0) names.push('id')
      if (this.className !== '' && names.indexOf('class') < 0) names.push('class')
      return names
    },
    focus: function focus() {
      if (ownerDocument) ownerDocument.activeElement = this
    },
    blur: function blur() {
      if (ownerDocument && ownerDocument.activeElement === this) ownerDocument.activeElement = ownerDocument.body
    },
    click: function click() {
      var MouseEventCtor = constructors.MouseEvent
      var event
      if (typeof MouseEventCtor === 'function') {
        event = new MouseEventCtor('click', { bubbles: true, cancelable: true, composed: true, detail: 1 })
      } else {
        event = {
          type: 'click',
          bubbles: true,
          cancelable: true,
          target: null,
          currentTarget: null,
          defaultPrevented: false,
          __stop: false,
          __stopImmediate: false,
        }
      }
      dispatchEventOn(this, event)
    },
    getBoundingClientRect: function getBoundingClientRect() {
      var box = boxForElement(this)
      var right = box.left + box.width
      var bottom = box.top + box.height
      return {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        top: box.top,
        left: box.left,
        right: right,
        bottom: bottom,
        toJSON: function toJSON() {
          return {
            x: box.left,
            y: box.top,
            width: box.width,
            height: box.height,
            top: box.top,
            left: box.left,
            right: right,
            bottom: bottom,
          }
        },
      }
    },
    getClientRects: function getClientRects() {
      return [this.getBoundingClientRect()]
    },
    scrollIntoView: function scrollIntoView() {},
    matches: function matches(selector) {
      var value = stringOf(selector).toLowerCase()
      return value === '*' || value === stringOf(this.localName).toLowerCase()
    },
    closest: function closest(selector) {
      var current = this
      while (current && current.nodeType === 1) {
        if (current.matches(selector)) return current
        current = current.parentNode
      }
      return null
    },
  }

  // ----------------------------------------------------------------- styles
  function serializeStyle(state) {
    var names = Object.keys(state.props)
    if (names.length === 0) return ''
    var parts = []
    for (var index = 0; index < names.length; index += 1) {
      var entry = state.props[names[index]]
      parts.push(names[index] + ': ' + entry.value + (entry.priority === 'important' ? ' !important' : ''))
    }
    return parts.join('; ') + ';'
  }

  function parseStyleText(state, text) {
    state.props = Object.create(null)
    var declarations = stringOf(text).split(';')
    for (var index = 0; index < declarations.length; index += 1) {
      var declaration = declarations[index]
      var colon = declaration.indexOf(':')
      if (colon < 0) continue
      var name = declaration.slice(0, colon).trim()
      var value = declaration.slice(colon + 1).trim()
      if (!name || !value) continue
      var priority = ''
      if (/!\s*important$/i.test(value)) {
        priority = 'important'
        value = value.replace(/!\s*important$/i, '').trim()
      }
      state.props[name] = { value: value, priority: priority }
    }
    state.text = serializeStyle(state)
  }

  function makeStyle(owner, defaults) {
    var style = Object.create(styleProto)
    styleStates.set(style, { owner: owner, props: Object.create(null), defaults: defaults || null, text: '' })
    return style
  }

  var styleMethods = {
    setProperty: function setProperty(name, value, priority) {
      var state = styleStates.get(this)
      if (!state) return
      var key = stringOf(name)
      var text = stringOf(value)
      if (text === '') delete state.props[key]
      else state.props[key] = { value: text, priority: stringOf(priority).toLowerCase() === 'important' ? 'important' : '' }
      state.text = serializeStyle(state)
    },
    getPropertyValue: function getPropertyValue(name) {
      var state = styleStates.get(this)
      if (!state) return ''
      var key = stringOf(name)
      var entry = state.props[key]
      if (entry) return entry.value
      if (state.defaults && Object.prototype.hasOwnProperty.call(state.defaults, key)) return state.defaults[key]
      return ''
    },
    getPropertyPriority: function getPropertyPriority(name) {
      var state = styleStates.get(this)
      if (!state) return ''
      var entry = state.props[stringOf(name)]
      return entry ? entry.priority : ''
    },
    removeProperty: function removeProperty(name) {
      var state = styleStates.get(this)
      if (!state) return ''
      var key = stringOf(name)
      var entry = state.props[key]
      if (!entry) return ''
      delete state.props[key]
      state.text = serializeStyle(state)
      return entry.value
    },
    item: function item(index) {
      var state = styleStates.get(this)
      if (!state) return ''
      var names = Object.keys(state.props)
      return names[index] === undefined ? '' : names[index]
    },
  }

  var styleAccessors = {
    cssText: {
      get: function getCssText() {
        var state = styleStates.get(this)
        return state ? state.text : ''
      },
      set: function setCssText(value) {
        var state = styleStates.get(this)
        if (state) parseStyleText(state, value)
      },
    },
    length: {
      get: function getStyleLength() {
        var state = styleStates.get(this)
        return state ? Object.keys(state.props).length : 0
      },
    },
  }

  // ---------------------------------------------------------------- classList
  function makeClassList(element) {
    var list = Object.create(classListProto)
    classStates.set(list, element)
    return list
  }

  function classTokens(element) {
    var parts = stringOf(element.className).split(/\s+/)
    var tokens = []
    for (var index = 0; index < parts.length; index += 1) {
      if (parts[index]) tokens.push(parts[index])
    }
    return tokens
  }

  function writeClassTokens(element, tokens) {
    var value = tokens.join(' ')
    element.className = value
    var state = nodeStates.get(element)
    if (!state) return
    if (value === '') delete state.attrs['class']
    else state.attrs['class'] = value
  }

  var classListMethods = {
    add: function add() {
      var element = classStates.get(this)
      if (!element) return
      var tokens = classTokens(element)
      for (var index = 0; index < arguments.length; index += 1) {
        var token = stringOf(arguments[index])
        if (token === '' || token.indexOf(' ') >= 0) {
          throw new Error(
            "Failed to execute 'add' on 'DOMTokenList': The token provided must not be empty.",
          )
        }
        if (tokens.indexOf(token) < 0) tokens.push(token)
      }
      writeClassTokens(element, tokens)
    },
    remove: function remove() {
      var element = classStates.get(this)
      if (!element) return
      var tokens = classTokens(element)
      for (var index = 0; index < arguments.length; index += 1) {
        var position = tokens.indexOf(stringOf(arguments[index]))
        if (position >= 0) tokens.splice(position, 1)
      }
      writeClassTokens(element, tokens)
    },
    toggle: function toggle(token, force) {
      var element = classStates.get(this)
      if (!element) return false
      var value = stringOf(token)
      var tokens = classTokens(element)
      var position = tokens.indexOf(value)
      var next = force === undefined ? position < 0 : force === true
      if (next && position < 0) tokens.push(value)
      else if (!next && position >= 0) tokens.splice(position, 1)
      writeClassTokens(element, tokens)
      return next
    },
    contains: function contains(token) {
      var element = classStates.get(this)
      return Boolean(element) && classTokens(element).indexOf(stringOf(token)) >= 0
    },
    replace: function replace(token, replacement) {
      var element = classStates.get(this)
      if (!element) return false
      var tokens = classTokens(element)
      var position = tokens.indexOf(stringOf(token))
      if (position < 0) return false
      tokens[position] = stringOf(replacement)
      writeClassTokens(element, tokens)
      return true
    },
    item: function item(index) {
      var element = classStates.get(this)
      if (!element) return null
      var tokens = classTokens(element)
      return tokens[index] === undefined ? null : tokens[index]
    },
    supports: function supports() {
      return true
    },
    forEach: function forEach(callback) {
      var element = classStates.get(this)
      if (!element || typeof callback !== 'function') return
      var tokens = classTokens(element)
      for (var index = 0; index < tokens.length; index += 1) callback(tokens[index], index, this)
    },
    toString: function toString() {
      var element = classStates.get(this)
      return element ? classTokens(element).join(' ') : ''
    },
  }

  var classListAccessors = {
    value: {
      get: function getClassListValue() {
        var element = classStates.get(this)
        return element ? classTokens(element).join(' ') : ''
      },
      set: function setClassListValue(value) {
        var element = classStates.get(this)
        if (element) writeClassTokens(element, stringOf(value).split(/\s+/))
      },
    },
    length: {
      get: function getClassListLength() {
        var element = classStates.get(this)
        return element ? classTokens(element).length : 0
      },
    },
  }

  // ------------------------------------------------------------ collections
  function makeCollection() {
    var collection = Object.create(collectionProto)
    collectionStates.set(collection, [])
    return collection
  }

  var collectionMethods = {
    item: function item(index) {
      var items = collectionStates.get(this)
      return items && items[index] !== undefined ? items[index] : null
    },
    namedItem: function namedItem(name) {
      var items = collectionStates.get(this) || []
      for (var index = 0; index < items.length; index += 1) {
        if (items[index].id === name || items[index].name === name) return items[index]
      }
      return null
    },
    forEach: function forEach(callback) {
      var items = collectionStates.get(this) || []
      if (typeof callback !== 'function') return
      for (var index = 0; index < items.length; index += 1) callback(items[index], index, this)
    },
    entries: function entries() {
      return [][Symbol.iterator]()
    },
    keys: function keys() {
      return [][Symbol.iterator]()
    },
    values: function values() {
      return [][Symbol.iterator]()
    },
  }

  var collectionAccessors = {
    length: {
      get: function getCollectionLength() {
        var items = collectionStates.get(this)
        return items ? items.length : 0
      },
    },
  }

  // --------------------------------------------------------------- document
  function makeSelection() {
    var selection = {}
    defineValue(selection, 'type', 'None')
    defineValue(selection, 'isCollapsed', true)
    defineValue(selection, 'rangeCount', 0)
    defineValue(selection, 'anchorNode', null)
    defineValue(selection, 'anchorOffset', 0)
    defineValue(selection, 'focusNode', null)
    defineValue(selection, 'focusOffset', 0)
    defineValue(selection, 'baseNode', null)
    defineValue(selection, 'extentNode', null)
    defineHidden(selection, 'toString', function toString() {
      return ''
    })
    defineHidden(selection, 'removeAllRanges', function removeAllRanges() {})
    defineHidden(selection, 'addRange', function addRange(range) {
      return range
    })
    defineHidden(selection, 'empty', function empty() {})
    defineHidden(selection, 'collapseToStart', function collapseToStart() {})
    defineHidden(selection, 'getRangeAt', function getRangeAt() {
      throw new Error('Failed to execute \'getRangeAt\' on \'Selection\': index out of range.')
    })
    return selection
  }

  var documentMethods = {
    getElementById: function getElementById() {
      return null
    },
    getElementsByName: function getElementsByName() {
      return makeCollection()
    },
    getElementsByTagName: function getElementsByTagName() {
      return makeCollection()
    },
    getElementsByTagNameNS: function getElementsByTagNameNS() {
      return makeCollection()
    },
    getElementsByClassName: function getElementsByClassName() {
      return makeCollection()
    },
    querySelector: function querySelector() {
      return null
    },
    querySelectorAll: function querySelectorAll() {
      return makeCollection()
    },
    createTextNode: function createTextNode(data) {
      return makeTextNode(data)
    },
    createComment: function createComment(data) {
      return makeCommentNode(data)
    },
    createDocumentFragment: function createDocumentFragment() {
      return makeFragment()
    },
    createEvent: function createEvent(kind) {
      var name = EVENT_CONSTRUCTOR_ALIASES[stringOf(kind).toLowerCase()] || 'Event'
      var Ctor = constructors[name]
      if (typeof Ctor !== 'function') return null
      return new Ctor()
    },
    hasFocus: function hasFocus() {
      return documentHasFocus
    },
    execCommand: function execCommand() {
      return false
    },
    queryCommandSupported: function queryCommandSupported() {
      return false
    },
    getSelection: function getSelection() {
      return makeSelection()
    },
    elementFromPoint: function elementFromPoint() {
      return null
    },
    elementsFromPoint: function elementsFromPoint() {
      return []
    },
  }

  function installHandlerProperties(target) {
    var values = Object.create(null)
    var accessors = []
    for (var index = 0; index < HANDLER_TYPES.length; index += 1) {
      var type = HANDLER_TYPES[index]
      var getter = makeHandlerAccessor(type, values, 'get')
      var setter = makeHandlerAccessor(type, values, 'set')
      defineAccessor(target, 'on' + type, getter, setter)
      accessors.push(getter, setter)
    }
    for (var position = 0; position < accessors.length; position += 1) handlerAccessors.push(accessors[position])
    return accessors
  }

  /**
   * One accessor pair per event type, each with its own source text: the
   * stealth masker keys native sources by source text, so a shared closure
   * would make every `on<type>` getter stringify with the same name.
   */
  function makeHandlerAccessor(type, values, kind) {
    var factory =
      kind === 'get'
        ? new Function('values', 'return function () { return values["' + type + '"] || null }')
        : new Function(
            'values',
            'return function (handler) { values["' + type + '"] = typeof handler === "function" ? handler : null }',
          )
    var accessor = factory(values)
    Object.defineProperty(accessor, 'name', {
      value: (kind === 'get' ? 'get on' : 'set on') + type,
      configurable: true,
    })
    return accessor
  }

  function createDocument(config) {
    var settings = config && typeof config === 'object' ? config : {}
    var document = Object.create(documentProto)
    var state = createNodeState('#document')
    nodeStates.set(document, state)
    ownerDocument = document
    defineValue(document, 'nodeType', 9)
    defineValue(document, 'nodeName', '#document')
    defineValue(document, 'nodeValue', null)
    defineValue(document, 'ownerDocument', null)
    defineValue(document, 'childNodes', state.childNodes)
    defineValue(document, 'children', state.children)
    defineValue(document, 'firstChild', null)
    defineValue(document, 'lastChild', null)
    defineValue(document, 'nextSibling', null)
    defineValue(document, 'previousSibling', null)
    defineValue(document, 'parentNode', null)
    defineValue(document, 'parentElement', null)
    defineValue(document, 'readyState', stringOf(settings.readyState) || 'complete')
    defineValue(document, 'referrer', stringOf(settings.referrer))
    defineValue(document, 'domain', stringOf(settings.domain))
    defineValue(document, 'characterSet', 'UTF-8')
    defineValue(document, 'charset', 'UTF-8')
    defineValue(document, 'inputEncoding', 'UTF-8')
    defineValue(document, 'contentType', 'text/html')
    defineValue(document, 'compatMode', 'CSS1Compat')
    defineValue(document, 'visibilityState', stringOf(settings.visibilityState) || 'visible')
    defineValue(document, 'hidden', settings.hidden === true)
    defineValue(document, 'lastModified', stringOf(settings.lastModified))
    defineValue(document, 'title', stringOf(settings.title))
    defineValue(document, 'dir', '')
    defineValue(document, 'designMode', 'off')
    defineValue(document, 'defaultView', null)
    defineValue(document, 'implementation', {
      createHTMLDocument: function createHTMLDocument() {
        return createDocument(settings)
      },
      createDocumentType: function createDocumentType() {
        return null
      },
      hasFeature: function hasFeature() {
        return true
      },
    })
    var html = makeElement('html')
    var head = makeElement('head')
    var body = makeElement('body')
    insertNode(html, head, null)
    insertNode(html, body, null)
    insertNode(document, html, null)
    defineValue(document, 'documentElement', html)
    defineValue(document, 'head', head)
    defineValue(document, 'body', body)
    defineValue(document, 'activeElement', body)
    var collections = ['scripts', 'forms', 'images', 'links', 'anchors', 'embeds', 'plugins', 'applets', 'all', 'styleSheets']
    for (var index = 0; index < collections.length; index += 1) defineValue(document, collections[index], makeCollection())
    documentHasFocus = settings.hasFocus !== false
    var currentScript = makeElement('script')
    currentScript.src = stringOf(settings.scriptUrl)
    currentScript.type = 'text/javascript'
    currentScript.textContent = stringOf(settings.scriptText)
    defineValue(document, 'currentScript', currentScript)
    installHandlerProperties(document)
    return document
  }

  function getComputedStyle(element, pseudo) {
    void pseudo
    var defaults = Object.create(null)
    var keys = Object.keys(COMPUTED_DEFAULTS)
    for (var index = 0; index < keys.length; index += 1) defaults[keys[index]] = COMPUTED_DEFAULTS[keys[index]]
    if (element && element.nodeType === 1) {
      var box = boxForElement(element)
      defaults.width = box.width + 'px'
      defaults.height = box.height + 'px'
    }
    var style = makeStyle(element, defaults)
    var target = styleStates.get(style)
    var source = element && element.style ? styleStates.get(element.style) : null
    if (source) {
      var names = Object.keys(source.props)
      for (var position = 0; position < names.length; position += 1) {
        target.props[names[position]] = source.props[names[position]]
      }
      target.text = serializeStyle(target)
    }
    return style
  }

  // ------------------------------------------------------- node constructors
  function makeCharacterData(nodeType, nodeName, data) {
    var node = Object.create(nodeProto)
    var state = createNodeState(nodeName)
    nodeStates.set(node, state)
    var text = stringOf(data)
    state.values = {
      nodeType: nodeType,
      nodeName: nodeName,
      nodeValue: text,
      data: text,
      length: text.length,
      textContent: text,
      ownerDocument: ownerDocument,
      parentNode: null,
      parentElement: null,
      childNodes: state.childNodes,
      children: state.children,
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
    }
    return node
  }

  function makeTextNode(data) {
    return makeCharacterData(3, '#text', data)
  }

  function makeCommentNode(data) {
    return makeCharacterData(8, '#comment', data)
  }

  function makeFragment() {
    var node = Object.create(nodeProto)
    var state = createNodeState('#document-fragment')
    nodeStates.set(node, state)
    state.values = {
      nodeType: 11,
      nodeName: '#document-fragment',
      nodeValue: null,
      ownerDocument: ownerDocument,
      parentNode: null,
      parentElement: null,
      childNodes: state.childNodes,
      children: state.children,
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
      textContent: '',
    }
    return node
  }

  // ------------------------------------------------------------ proto wiring
  var nodeProto = {}
  installMethodTable(nodeProto, eventTargetMethods)
  installMethodTable(nodeProto, nodeMethods)
  installAttributeTable(nodeProto, NODE_ATTRIBUTE_NAMES)
  installAttributeTable(nodeProto, CHARACTER_DATA_ATTRIBUTE_NAMES)

  var elementProto = Object.create(nodeProto)
  installMethodTable(elementProto, elementMethods)
  installAttributeTable(elementProto, ELEMENT_ATTRIBUTE_NAMES)

  var documentProto = Object.create(nodeProto)
  installMethodTable(documentProto, documentMethods)

  var styleProto = {}
  installMethodTable(styleProto, styleMethods)
  installAccessorTable(styleProto, styleAccessors)

  var classListProto = {}
  installMethodTable(classListProto, classListMethods)
  installAccessorTable(classListProto, classListAccessors)

  var collectionProto = {}
  installMethodTable(collectionProto, collectionMethods)
  installAccessorTable(collectionProto, collectionAccessors)
  defineHidden(collectionProto, Symbol.iterator, function iterator() {
    return [][Symbol.iterator]()
  })

  return {
    createDocument: createDocument,
    createElement: function createElement(tagName) {
      return makeElement(tagName)
    },
    dispatchEvent: function dispatchEvent(target, event) {
      return dispatchEventOn(target, event)
    },
    setEventConstructors: function setEventConstructors(table) {
      constructors = table
    },
    installHandlerProperties: installHandlerProperties,
    listHandlerAccessors: function listHandlerAccessors() {
      return handlerAccessors
    },
    listAttributeAccessors: function listAttributeAccessors() {
      return attributeAccessors
    },
    listTableKeys: function listTableKeys(table) {
      return Object.keys(table)
    },
    getComputedStyle: getComputedStyle,
    eventMethods: eventMethods,
    eventInits: eventInits,
    eventTargetMethods: eventTargetMethods,
    nodeMethods: nodeMethods,
    elementMethods: elementMethods,
    documentMethods: documentMethods,
    elementProto: elementProto,
    nodeProto: nodeProto,
    documentProto: documentProto,
    styleMethods: styleMethods,
    classListMethods: classListMethods,
    collectionMethods: collectionMethods,
  }
}
