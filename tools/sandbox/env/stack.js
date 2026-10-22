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
 *
 * One constructor is deliberately not identity-shared: `InternalError` is the
 * class QuickJS uses for its own stack overflow, so a wrapper built on the
 * intrinsic prototype would let a sample forge engine exhaustion with
 * `new InternalError('stack overflow')` (`tools/invocation/stealth.js` decides
 * that classification by prototype identity). The wrapper therefore owns a
 * fresh prototype with the same own properties and the same `[[Prototype]]`
 * (`Error.prototype`, exactly as in Firefox), which keeps every faithful
 * surface while making the intrinsic prototype unreachable.
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
      var setProto = Object.setPrototypeOf;
      var getProto = Object.getPrototypeOf;
      var ownNames = Object.getOwnPropertyNames;
      var ownDescriptor = Object.getOwnPropertyDescriptor;
      var define = Object.defineProperty;
      var create = Object.create;
      var reflectConstruct = Reflect.construct;

      function wrap(name, Orig, arity, reown) {
        if (typeof Orig !== 'function') return null;
        // Every wrapper used to share one function body, and the stealth
        // adoption table is keyed by normalised source text, so each
        // registration overwrote the previous one: every constructor then
        // reported the last-installed name (function URIError() ...).
        // Interpolating the name gives each wrapper distinct source, hence its
        // own adoption key. The body still closes over the wrapper's scope.
        var Wrapped = eval(
          '(function ' + name + '(message, options) {' +
          'var newTarget = new.target;' +
          'var error;' +
          // V8 constructs through new.target, so a subclass (including
          // Reflect.construct) gets an instance whose prototype is the
          // subclass's prototype. Constructing with new Orig() instead would
          // hand back Error.prototype and break instanceof MyError. Reflect
          // is captured now, before guest code can replace it.
          'if (newTarget !== undefined) {' +
          'error = reflectConstruct(Orig, arguments.length > 0 ? [message, options] : [], newTarget);' +
          '} else {' +
          'error = arguments.length > 0 ? new Orig(message, options) : new Orig();' +
          '}' +
          // The engine constructor always stamps a prototype, so a re-owned
          // wrapper has to move a plain (or intrinsic-fallback) instance onto
          // the fresh one — that is what keeps the intrinsic prototype out of
          // guest reach. A subclass target keeps its own prototype. setProto
          // and getProto are captured before guest code can replace them.
          'if (reown && getProto(error) === Orig.prototype) {' +
          'try { setProto(error, Wrapped.prototype); } catch (e) {}' +
          '}' +
          'try {' +
          'if (error && typeof error.stack === "string") error.stack = sanitize(error.stack);' +
          '} catch (e) {}' +
          'return error;' +
          '})'
        );
        // V8 defines every error constructor's prototype as a non-writable,
        // non-configurable own property.
        define(Wrapped, 'prototype', {
          value: reown ? reownPrototype(Orig, Wrapped) : Orig.prototype,
          writable: false,
          enumerable: false,
          configurable: false
        });
        try {
          define(Wrapped.prototype, 'constructor', {
            value: Wrapped, writable: true, enumerable: false, configurable: true
          });
        } catch (e) {}
        if (reown) {
          // A real engine error still carries the intrinsic prototype, and a
          // sample that catches one reads its constructor from there. Point that
          // at the wrapper too, so the intrinsic constructor stays unreachable
          // (and error.constructor keeps answering the global constructor).
          try {
            define(Orig.prototype, 'constructor', {
              value: Wrapped, writable: true, enumerable: false, configurable: true
            });
          } catch (e) {}
        }
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

      // A wrapper normally reuses the engine prototype, so every identity check
      // a sample can run stays true.  That is wrong for one constructor only:
      // QuickJS builds its *own* stack overflow with the intrinsic
      // InternalError.prototype, so a sample holding that same prototype could
      // forge engine exhaustion.  A fresh prototype — same own properties, same
      // [[Prototype]] (Error.prototype, exactly as in Firefox) — keeps every
      // faithful surface and makes the intrinsic prototype unreachable, so the
      // stealth probe can trust an InternalError's identity again.
      function reownPrototype(Orig, Wrapped) {
        var source = Orig.prototype;
        var fresh = create(getProto(source));
        var keys = ownNames(source);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i] === 'constructor') continue;
          try {
            var descriptor = ownDescriptor(source, keys[i]);
            if (descriptor) define(fresh, keys[i], descriptor);
          } catch (e) {}
        }
        return fresh;
      }

      function wrapAggregate(Orig) {
        if (typeof Orig !== 'function') return null;
        function AggregateError(errors, message, options) {
          // Like the Error wrappers, construct through new.target so a
          // subclass keeps its own prototype.
          var error = new.target !== undefined
            ? reflectConstruct(Orig, [errors, message, options], new.target)
            : new Orig(errors, message, options);
          try {
            if (error && typeof error.stack === 'string') error.stack = sanitize(error.stack);
          } catch (e) {}
          return error;
        }
        // Match V8's non-writable, non-configurable prototype descriptor.
        define(AggregateError, 'prototype', {
          value: Orig.prototype,
          writable: false,
          enumerable: false,
          configurable: false
        });
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
      // InternalError is the engine's stack-overflow class (see engine/runtime.js), so
      // it is the one constructor whose prototype must not be shared.
      out.InternalError = typeof global.InternalError === 'function'
        ? wrap('InternalError', global.InternalError, global.InternalError.length, true)
        : null;
      var names = ['EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];
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
  const installedNames = new Set()
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
    installedNames.add(name)
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

  // The wrapper above gives InternalError its own prototype, which is what keeps
  // the engine's stack-overflow class out of a sample's reach (see the guest
  // code and `revokeStackEvidence`). If that wrapper is missing — an engine
  // without the constructor, or a shim call that failed — the global binding is
  // the *intrinsic* one and a sample can build a prototype-identical forgery, so
  // the stealth probe must stop certifying from guest dumps for this run. The
  // host-throw witness is unaffected: no guest value takes part in it.
  if (!installedNames.has('InternalError')) {
    const present = ctx.evalCode('typeof globalThis.InternalError === "function"', 'ai4r-internal:stack-shim')
    let exposed = false
    if (present.error) {
      present.error.dispose()
    } else {
      exposed = ctx.dump(present.value) === true
      present.value.dispose()
    }
    if (exposed) bridge.stealth?.revokeStackEvidence?.('InternalError prototype exposed unwrapped')
  }

  bridge.emit('sandbox', 'emit', { event: 'stack.virtualized', installed, browser: profile.browser })
}
