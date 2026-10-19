import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

/**
 * API instrumentation must not change the *shape* of the platform objects it
 * wraps (R1.1).
 *
 * The instrumenter replaces platform methods with host wrappers. Installing a
 * wrapper as an enumerable own property is observable: Chromium reports
 * `Object.keys(WebAssembly) === []`, so a wrapper would make the sandbox's
 * `Object.keys(WebAssembly)` `['compile','instantiate','validate']` — a
 * one-line environment check that unmasked the sandbox. The wrapper therefore
 * copies the original property descriptor (`enumerable`, `configurable`,
 * `writable`) from the object that owns the property.
 *
 * Every probe runs in a real sandbox; the negative control disables API
 * instrumentation so the shim's own shape and the instrumented shape must agree.
 */

const PROFILE = { locale: 'zh-CN', os: 'windows', browser: 'chrome' }

/** Full-environment sandbox. */
async function sandbox() {
  return TracelessSandbox.create({ logLevel: 'silent', env: { strict: true }, profile: PROFILE })
}

/** Run a probe and return its JSON result plus the run record. */
async function probe(sb, source, runOptions = {}) {
  const run = await sb.run(source, { level: 'off', ...runOptions })
  assert.equal(run.ok, true, JSON.stringify(run.error))
  return { value: JSON.parse(run.result.preview), run }
}

test('wrapped platform members keep their original descriptors', async () => {
  const sb = await sandbox()
  try {
    const { value, run } = await probe(
      sb,
      `(function () {
        function ownDescriptor(target, key) {
          var current = target;
          while (current) {
            var descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor) return descriptor;
            current = Object.getPrototypeOf(current);
          }
          return null;
        }
        var wasm = ownDescriptor(WebAssembly, 'validate');
        return JSON.stringify({
          wasmKeys: Object.keys(WebAssembly),
          wasmNames: Object.getOwnPropertyNames(WebAssembly).sort(),
          wasmEnumerable: wasm ? wasm.enumerable : 'missing',
          wasmWritable: wasm ? wasm.writable : 'missing',
          wasmConfigurable: wasm ? wasm.configurable : 'missing',
          navigatorKeys: Object.keys(navigator).length,
          documentKeys: Object.keys(document).length,
          historyKeys: Object.keys(history).length,
          locationKeys: Object.keys(location).length,
          wasmNative: String(WebAssembly.validate).includes('native code'),
          pushNative: String(history.pushState).includes('native code')
        });
      })()`,
    )
    assert.deepEqual(value.wasmKeys, [], 'a wrapper must not add enumerable keys to WebAssembly')
    // The members are still there — only their enumerability changed back.
    assert.deepEqual(value.wasmNames, [
      'CompileError',
      'Global',
      'Instance',
      'LinkError',
      'Memory',
      'Module',
      'RuntimeError',
      'Table',
      'compile',
      'instantiate',
      'instantiateStreaming',
      'validate',
    ])
    assert.equal(value.wasmEnumerable, false)
    assert.equal(value.wasmWritable, true)
    assert.equal(value.wasmConfigurable, true)
    assert.equal(value.navigatorKeys, 0)
    assert.equal(value.documentKeys, 0)
    assert.equal(value.historyKeys, 0)
    assert.equal(value.locationKeys, 0)
    assert.equal(value.wasmNative, true)
    assert.equal(value.pushNative, true)
    // The run really was instrumented: without wrappers the test is vacuous.
    const api = run.instrumentation.describe.api
    assert.ok(api.targets >= 40, JSON.stringify(api))
    assert.equal(api.wrapped, api.targets, JSON.stringify(api))
    assert.ok(api.targets > 0)
  } finally {
    sb.dispose()
  }
})

test('wrapped methods, getters and accessors still behave', async () => {
  const sb = await sandbox()
  try {
    const { value, run } = await probe(
      sb,
      `(function () {
        var out = {
          userAgent: navigator.userAgent,
          userAgentType: typeof navigator.userAgent,
          wasmValidate: WebAssembly.validate(new Uint8Array([0, 1, 2])),
          created: document.createElement('div').tagName,
          cookie: (function () { document.cookie = 'probe=1'; return document.cookie })()
        };
        history.pushState({ page: 2 }, '', '/wrapped');
        out.pathname = location.pathname;
        out.href = location.href;
        out.cookieGetterNative = (function () {
          var current = document;
          while (current) {
            var descriptor = Object.getOwnPropertyDescriptor(current, 'cookie');
            if (descriptor && descriptor.get) return String(descriptor.get).includes('native code');
            current = Object.getPrototypeOf(current);
          }
          return false;
        })();
        return JSON.stringify(out);
      })()`,
    )
    assert.match(value.userAgent, /Windows NT 10\.0|Macintosh|Linux/)
    assert.equal(value.userAgentType, 'string')
    assert.equal(value.wasmValidate, false)
    assert.equal(value.created, 'DIV')
    assert.equal(value.cookie, 'probe=1')
    assert.equal(value.pathname, '/wrapped')
    assert.match(value.href, /\/wrapped$/)
    assert.equal(value.cookieGetterNative, true, 'a wrapped accessor must report native code')
    assert.ok(run.instrumentation.describe.api.calls > 0, 'no wrapped API was actually called')
  } finally {
    sb.dispose()
  }
})

test('the instrumented shape equals the uninstrumented shape', async () => {
  const sb = await sandbox()
  try {
    const source = `(function () {
      var names = ['WebAssembly', 'navigator', 'document', 'history', 'location'];
      var out = {};
      for (var index = 0; index < names.length; index += 1) {
        var target = globalThis[names[index]];
        out[names[index]] = { keys: Object.keys(target).length, names: Object.getOwnPropertyNames(target).length };
      }
      out.wasmStatics = Object.getOwnPropertyNames(WebAssembly)
        .filter(function (key) { return typeof WebAssembly[key] === 'function' })
        .map(function (key) { return key + ':' + Object.getOwnPropertyDescriptor(WebAssembly, key).enumerable })
        .sort();
      var cookie = (function () {
        var current = document;
        while (current) {
          var descriptor = Object.getOwnPropertyDescriptor(current, 'cookie');
          if (descriptor) return descriptor;
          current = Object.getPrototypeOf(current);
        }
        return null;
      })();
      out.cookieShape = cookie ? ('get' in cookie ? 'accessor' : 'data') + ':' + cookie.enumerable : 'missing';
      return JSON.stringify(out);
    })()`
    const instrumented = await probe(sb, source)
    const plain = await probe(sb, source, { instrumentation: { api: false } })
    assert.deepEqual(instrumented.value, plain.value)
    assert.equal(instrumented.value.cookieShape, 'accessor:false')
    assert.ok(
      instrumented.value.wasmStatics.every((entry) => entry.endsWith(':false')),
      JSON.stringify(instrumented.value.wasmStatics),
    )
  } finally {
    sb.dispose()
  }
})
