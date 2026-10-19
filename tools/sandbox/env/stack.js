/**
 * Stack-trace fidelity.
 *
 * QuickJS top-level frames are named `<eval>` and host paths can leak into
 * messages. Both are a well-known VM tell: real V8 stacks start with
 * `at https://host/app.js:1:1`. This module replaces the global error
 * constructors with guest wrappers that construct the *original* error object
 * (so `instanceof`, prototype identity, `name`, `message` and engine semantics
 * are unchanged) and then rewrite only the `stack` string through the stealth
 * sanitiser: strip the `<eval>` frame marker, collapse host paths, drop internal
 * `ai4r-internal:` frames.
 *
 * Engine-generated errors (e.g. `null.x` → TypeError) bypass the constructor;
 * the AST catch instrumentation sanitises those in place before guest code can
 * read them, and the host boundary sanitises uncaught ones.
 */

export const meta = { id: 'stack', order: 27, requires: ['globals'] }

export function install(bridge) {
  const { ctx, stealth, profile } = bridge
  if (!stealth) return

  const sanitizeStack = bridge.fn('sanitizeStack', 1, ({ args }) => {
    const raw = bridge.str(args, 0, '')
    return ctx.newString(stealth.sanitizeStack(raw))
  })

  const factory = ctx.evalCode(
    `(function (OrigError, sanitize) {
      var global = globalThis;

      function wrap(name, Orig, arity) {
        if (typeof Orig !== 'function') return null;
        function Wrapped(message, options) {
          var error = arguments.length > 0 ? new Orig(message, options) : new Orig();
          try {
            if (error && typeof error.stack === 'string') error.stack = sanitize(error.stack);
          } catch (e) {}
          return error;
        }
        Wrapped.prototype = Orig.prototype;
        try {
          Object.defineProperty(Orig.prototype, 'constructor', {
            value: Wrapped, writable: true, enumerable: false, configurable: true
          });
        } catch (e) {}
        try { Object.defineProperty(Wrapped, 'name', { value: name, configurable: true }); } catch (e) {}
        try { Object.defineProperty(Wrapped, 'length', { value: arity, configurable: true }); } catch (e) {}
        // Copy engine statics (stackTraceLimit, captureStackTrace where present).
        var statics = Object.getOwnPropertyNames(Orig);
        for (var i = 0; i < statics.length; i++) {
          var key = statics[i];
          if (key === 'prototype' || key === 'name' || key === 'length' || key === 'arguments' || key === 'caller') continue;
          try { Wrapped[key] = Orig[key]; } catch (e) {}
        }
        return Wrapped;
      }

      function wrapAggregate(Orig) {
        if (typeof Orig !== 'function') return null;
        function AggregateError(errors, message, options) {
          var error = new Orig(errors, message, options);
          try {
            if (error && typeof error.stack === 'string') error.stack = sanitize(error.stack);
          } catch (e) {}
          return error;
        }
        AggregateError.prototype = Orig.prototype;
        try {
          Object.defineProperty(Orig.prototype, 'constructor', {
            value: AggregateError, writable: true, enumerable: false, configurable: true
          });
        } catch (e) {}
        try { Object.defineProperty(AggregateError, 'name', { value: 'AggregateError', configurable: true }); } catch (e) {}
        try { Object.defineProperty(AggregateError, 'length', { value: 2, configurable: true }); } catch (e) {}
        return AggregateError;
      }

      var out = {};
      out.Error = wrap('Error', OrigError, 1);
      var names = ['EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'InternalError'];
      for (var i = 0; i < names.length; i++) {
        var original = global[names[i]];
        if (typeof original === 'function') out[names[i]] = wrap(names[i], original, original.length);
      }
      if (typeof global.AggregateError === 'function') out.AggregateError = wrapAggregate(global.AggregateError);
      return out;
    })`,
    'ai4r-internal:stack-shim',
  )

  if (factory.error) {
    const dumped = bridge.fromGuest(factory.error)
    factory.error.dispose()
    bridge.emit('sandbox', 'error', { event: 'stack.shim.failed', error: dumped })
    return
  }

  const originalError = ctx.getProp(ctx.global, 'Error')
  const call = ctx.callFunction(factory.value, ctx.undefined, [originalError, sanitizeStack])
  factory.value.dispose()
  originalError.dispose()
  if (call.error) {
    call.error.dispose()
    bridge.emit('sandbox', 'error', { event: 'stack.shim.call-failed' })
    return
  }

  const wrappers = call.value
  const names = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'InternalError', 'AggregateError']
  let installed = 0
  for (const name of names) {
    const handle = ctx.getProp(wrappers, name)
    if (ctx.typeof(handle) !== 'function') {
      handle.dispose()
      continue
    }
    bridge.adopt(handle, name)
    bridge.install(ctx.global, name, handle, { enumerable: false, configurable: true, writable: true })
    handle.dispose()
    installed += 1
  }
  wrappers.dispose()

  // V8 exposes two non-standard Error statics that samples check. Mirror them
  // on the Error wrapper (subclass constructors do not inherit statics, matching
  // V8, where they live on Error itself).
  const errorWrapper = ctx.getProp(ctx.global, 'Error')
  if (ctx.typeof(errorWrapper) === 'function') {
    const captureFactory = ctx.evalCode(
      `(function (ErrorCtor) {
        return function captureStackTrace(target) {
          try {
            if (target && typeof target === 'object') target.stack = new ErrorCtor().stack;
          } catch (e) {}
        };
      })`,
      'ai4r-internal:stack-shim',
    )
    if (!captureFactory.error) {
      const capture = ctx.callFunction(captureFactory.value, ctx.undefined, [errorWrapper])
      captureFactory.value.dispose()
      if (!capture.error) {
        bridge.adopt(capture.value, 'captureStackTrace')
        bridge.install(errorWrapper, 'captureStackTrace', capture.value, {
          enumerable: false,
          configurable: true,
          writable: true,
        })
        capture.value.dispose()
      } else {
        capture.error.dispose()
      }
    } else {
      captureFactory.error.dispose()
    }
    bridge.install(errorWrapper, 'stackTraceLimit', 10, {
      enumerable: false,
      configurable: true,
      writable: true,
    })
    errorWrapper.dispose()
  }

  // Chrome has no InternalError; Firefox does. Match the claimed browser.
  if (profile.browser === 'chrome' || profile.browser === 'edge') {
    const removed = ctx.evalCode('delete globalThis.InternalError', 'ai4r-internal:stack-shim')
    if (removed.error) removed.error.dispose()
    else removed.value.dispose()
  }

  bridge.emit('sandbox', 'emit', { event: 'stack.virtualized', installed, browser: profile.browser })
}
