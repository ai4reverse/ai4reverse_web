import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'
import { createProfile, consistencyReport } from '../tools/sandbox/profile.js'

/**
 * D6 — environment fidelity.
 *
 * Every probe in this file runs inside a real `TracelessSandbox` with the full
 * environment in strict mode. Each test names the browser-observable surface a
 * detector would read, so a regression here is a regression in deniability, not
 * just in code coverage.
 */

const CHROME = { locale: 'zh-CN', os: 'windows', browser: 'chrome' }
const ISOLATED = { ...CHROME, crossOriginIsolated: true }

/** Create a full-environment sandbox. */
async function sandbox(profile = CHROME) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: true },
    profile,
  })
}

/** Evaluate one probe script and parse its JSON result. */
async function probe(sb, source, runOptions = {}) {
  const run = await sb.run(source, { level: 'off', ...runOptions })
  assert.equal(run.ok, true, JSON.stringify(run.error))
  return { value: JSON.parse(run.result.preview), run }
}

/** Trace entries emitted by `console.log` in the guest. */
function consoleLogs(run) {
  return (run.events ?? [])
    .filter((event) => event.kind === 'api' && event.api === 'console.log')
    .map((event) => String(event.text))
}

test('SharedArrayBuffer, Atomics and crossOriginIsolated are one coherent triple', async () => {
  const sb = await sandbox()
  try {
    const { value, run } = await probe(
      sb,
      `({
        sharedArrayBuffer: typeof SharedArrayBuffer,
        atomics: typeof Atomics,
        crossOriginIsolated,
        hasAtomicsOwn: Object.getOwnPropertyNames(globalThis).includes('Atomics')
      })`,
    )
    assert.equal(value.sharedArrayBuffer, 'undefined', 'a non-isolated page must not expose SharedArrayBuffer')
    assert.equal(value.atomics, 'undefined', 'Atomics without SharedArrayBuffer is an impossible combination')
    assert.equal(value.crossOriginIsolated, false)
    assert.equal(value.hasAtomicsOwn, false)
    assert.equal(run.profile.consistency.ok, true, JSON.stringify(run.profile.consistency.problems))
  } finally {
    sb.dispose()
  }
})

test('an isolated profile keeps SharedArrayBuffer and gains a single-threaded Atomics', async () => {
  const sb = await sandbox(ISOLATED)
  try {
    const { value, run } = await probe(
      sb,
      `(function () {
        var view = new Int32Array(new SharedArrayBuffer(64));
        var out = {
          sharedArrayBuffer: typeof SharedArrayBuffer,
          atomics: typeof Atomics,
          crossOriginIsolated,
          brand: Object.prototype.toString.call(Atomics),
          bufferSize: view.buffer.byteLength,
          store: Atomics.store(view, 0, 5),
          load: Atomics.load(view, 0),
          add: [Atomics.add(view, 0, 3), Atomics.load(view, 0)],
          sub: [Atomics.sub(view, 0, 1), Atomics.load(view, 0)],
          bitwise: [Atomics.and(view, 0, 6), Atomics.or(view, 0, 1), Atomics.xor(view, 0, 3), Atomics.load(view, 0)],
          exchange: [Atomics.exchange(view, 1, 9), Atomics.load(view, 1)],
          compareExchange: [Atomics.compareExchange(view, 1, 9, 4), Atomics.load(view, 1)],
          compareMismatch: Atomics.compareExchange(view, 1, 99, 7),
          waitNotEqual: Atomics.wait(view, 1, 0),
          waitTimedOut: Atomics.wait(view, 1, 4, 0),
          notify: Atomics.notify(view, 1),
          isLockFree: [Atomics.isLockFree(1), Atomics.isLockFree(2), Atomics.isLockFree(4), Atomics.isLockFree(8), Atomics.isLockFree(3)],
          nativeSource: String(Atomics.load).includes('native code')
        };
        try { Atomics.load([], 0) } catch (error) { out.nonTypedArray = error.name }
        try { Atomics.load(view, 99) } catch (error) { out.outOfRange = error.name }
        return JSON.stringify(out);
      })()`,
    )
    assert.equal(value.sharedArrayBuffer, 'function')
    assert.equal(value.atomics, 'object')
    assert.equal(value.crossOriginIsolated, true)
    assert.equal(value.brand, '[object Atomics]')
    assert.equal(value.bufferSize, 64)
    assert.equal(value.store, 5)
    assert.equal(value.load, 5)
    assert.deepEqual(value.add, [5, 8])
    assert.deepEqual(value.sub, [8, 7])
    assert.deepEqual(value.bitwise, [7, 6, 7, 4])
    assert.deepEqual(value.exchange, [0, 9])
    assert.deepEqual(value.compareExchange, [9, 4])
    assert.equal(value.compareMismatch, 4)
    assert.equal(value.waitNotEqual, 'not-equal')
    assert.equal(value.waitTimedOut, 'timed-out')
    assert.equal(value.notify, 0)
    assert.deepEqual(value.isLockFree, [true, true, true, true, false])
    assert.equal(value.nativeSource, true)
    assert.equal(value.nonTypedArray, 'TypeError')
    assert.equal(value.outOfRange, 'RangeError')
    assert.equal(run.profile.consistency.ok, true, JSON.stringify(run.profile.consistency.problems))
  } finally {
    sb.dispose()
  }
})

test('consistencyReport rejects every incoherent isolation combination', () => {
  const isolated = consistencyReport(createProfile({ seed: 7, crossOriginIsolated: true }))
  assert.equal(isolated.ok, true, JSON.stringify(isolated.problems))

  const defaulted = consistencyReport(createProfile({ seed: 7 }))
  assert.equal(defaulted.ok, true, JSON.stringify(defaulted.problems))
  assert.equal(createProfile({ seed: 7 }).crossOriginIsolated, false)

  const bufferWithoutIsolation = { ...createProfile({ seed: 7 }), sharedArrayBuffer: true }
  const problem = consistencyReport(bufferWithoutIsolation)
  assert.equal(problem.ok, false)
  assert.ok(
    problem.problems.some((entry) => /SharedArrayBuffer must exist exactly when crossOriginIsolated/.test(entry)),
    JSON.stringify(problem.problems),
  )

  const atomicsWithoutIsolation = { ...createProfile({ seed: 7 }), atomics: true }
  assert.equal(consistencyReport(atomicsWithoutIsolation).ok, false)

  const isolationWithoutBuffer = { ...createProfile({ seed: 7, crossOriginIsolated: true }), sharedArrayBuffer: false }
  assert.equal(consistencyReport(isolationWithoutBuffer).ok, false)

  const insecureIsolation = {
    ...createProfile({ seed: 7, crossOriginIsolated: true }),
    origin: 'http://www.example-cdn.com',
  }
  assert.ok(
    consistencyReport(insecureIsolation).problems.some((entry) => /secure context/.test(entry)),
    JSON.stringify(consistencyReport(insecureIsolation).problems),
  )
})

test('consistencyReport counts every check it declares, not a literal', () => {
  // Audit: `checked` was a hard-coded 15 while the function evaluated 20
  // invariants, so the analyst-facing report understated its own coverage. The
  // count is now derived from the check list; this test pins the derivation by
  // injecting exactly one incoherence per declared check.
  const base = () => createProfile({ seed: 7, os: 'macos', browser: 'chrome', locale: 'en-US' })
  const clone = (profile) => JSON.parse(JSON.stringify(profile))
  const drift = (profile, patch) => Object.assign(clone(profile), patch)
  const renderer = (profile, value) => {
    const next = clone(profile)
    next.webgl.renderer = value
    return next
  }

  const coherent = consistencyReport(createProfile({ seed: 7 }))
  assert.deepEqual(coherent.problems, [], JSON.stringify(coherent.problems))
  assert.ok(coherent.checked > 0)

  /** @type {Array<{ check: string, profile: object, problems: string[] }>} */
  const faults = [
    {
      check: 'UA platform token',
      profile: drift(base(), { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0' }),
      problems: ['UA missing platform token Macintosh'],
    },
    {
      check: 'windows platform',
      profile: drift(createProfile({ seed: 7, os: 'windows', browser: 'chrome', locale: 'en-US' }), { platform: 'MacIntel' }),
      problems: ['Windows profile must report Win32'],
    },
    { check: 'macOS platform', profile: drift(base(), { platform: 'Win32' }), problems: ['macOS profile must report MacIntel'] },
    {
      check: 'Linux platform',
      profile: drift(createProfile({ seed: 7, os: 'linux', browser: 'chrome', locale: 'en-US' }), { platform: 'Win32' }),
      problems: ['Linux profile must report Linux platform'],
    },
    {
      check: 'mobile UA token',
      profile: drift(base(), {
        mobile: true,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36',
      }),
      problems: ['mobile profile needs a Mobile UA token'],
    },
    { check: 'known locale', profile: drift(base(), { language: 'xx-XX' }), problems: ['unknown locale xx-XX'] },
    {
      check: 'locale timezone',
      profile: drift(base(), { timezone: 'UTC' }),
      problems: ['timezone does not match locale preset'],
    },
    {
      check: 'locale timezone offset',
      profile: drift(base(), { timezoneOffsetMinutes: 300 }),
      problems: ['timezone offset does not match locale preset'],
    },
    {
      check: 'Direct3D renderer',
      profile: renderer(base(), 'ANGLE (NVIDIA, Direct3D11 vs_5_0 ps_5_0)'),
      problems: ['D3D renderer on non-Windows profile'],
    },
    {
      check: 'Metal renderer',
      profile: renderer(createProfile({ seed: 7, os: 'linux', browser: 'chrome', locale: 'en-US' }), 'Apple M3 (Metal)'),
      problems: ['Metal renderer on non-macOS profile'],
    },
    {
      check: 'Mesa renderer',
      profile: renderer(base(), 'ANGLE (Mesa, llvmpipe (LLVM 17.0.6, 256 bits))'),
      problems: ['Mesa renderer on non-Linux profile'],
    },
    {
      check: 'Firefox without userAgentData',
      profile: drift(createProfile({ seed: 7, os: 'macos', browser: 'firefox', locale: 'en-US' }), { userAgentData: { brands: [] } }),
      problems: ['Firefox must not expose userAgentData'],
    },
    {
      check: 'Chromium with userAgentData',
      profile: drift(base(), { userAgentData: null }),
      problems: ['Chromium profile must expose userAgentData'],
    },
    {
      check: 'Firefox without window.chrome',
      profile: drift(createProfile({ seed: 7, os: 'macos', browser: 'firefox', locale: 'en-US' }), { chrome: {} }),
      problems: ['Firefox must not expose window.chrome'],
    },
    {
      check: 'availWidth fits width',
      profile: (() => {
        const next = clone(base())
        next.screen.availWidth = next.screen.width + 1
        return next
      })(),
      problems: ['availWidth cannot exceed width'],
    },
    {
      check: 'positive devicePixelRatio',
      profile: (() => {
        const next = clone(base())
        next.screen.devicePixelRatio = 0
        return next
      })(),
      problems: ['devicePixelRatio must be positive'],
    },
    {
      // An out-of-range offset also breaks the locale preset, so this fault
      // reports two problems: one check each, still one declared check.
      check: 'timezone offset range',
      profile: drift(base(), { timezoneOffsetMinutes: 900 }),
      problems: ['timezone offset does not match locale preset', 'timezone offset out of range'],
    },
    {
      check: 'SharedArrayBuffer isolation',
      profile: drift(base(), { sharedArrayBuffer: true }),
      problems: ['SharedArrayBuffer must exist exactly when crossOriginIsolated is true'],
    },
    {
      check: 'Atomics isolation',
      profile: drift(base(), { atomics: true }),
      problems: ['Atomics must exist exactly when crossOriginIsolated is true'],
    },
    {
      check: 'secure context for isolation',
      profile: drift(
        createProfile({ seed: 7, os: 'macos', browser: 'chrome', locale: 'en-US', crossOriginIsolated: true }),
        { origin: 'http://www.example-cdn.com' },
      ),
      problems: ['crossOriginIsolated requires a secure context'],
    },
  ]

  for (const fault of faults) {
    const report = consistencyReport(fault.profile)
    assert.deepEqual(report.problems, fault.problems, `${fault.check}: ${JSON.stringify(report.problems)}`)
    assert.equal(report.ok, false, fault.check)
    // A failing check must not change the amount of work reported as done.
    assert.equal(report.checked, coherent.checked, fault.check)
  }

  assert.equal(
    coherent.checked,
    faults.length,
    `consistencyReport declares ${coherent.checked} checks but this test exercises ${faults.length}: add the missing fault case`,
  )
})

test('WebAssembly is a coherent browser-shaped surface, not undefined', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        var names = ['Module', 'Instance', 'Memory', 'Table', 'Global', 'CompileError', 'LinkError', 'RuntimeError'];
        var out = {
          type: typeof WebAssembly,
          brand: Object.prototype.toString.call(WebAssembly),
          memberNames: Object.getOwnPropertyNames(WebAssembly).sort(),
          constructors: names.filter(function (name) { return typeof WebAssembly[name] === 'function' }),
          statics: ['validate', 'compile', 'instantiate', 'instantiateStreaming'].filter(function (name) { return typeof WebAssembly[name] === 'function' }),
          nativeCompile: String(WebAssembly.compile).includes('native code'),
          nativeCtor: String(WebAssembly.Module).includes('native code'),
          validateGood: WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
          validateBad: WebAssembly.validate(new Uint8Array(8))
        };
        try { WebAssembly.validate('nope') } catch (error) { out.validateType = error.name }
        try { new WebAssembly.Module(new Uint8Array(4)) } catch (error) {
          out.moduleErrorName = error.name;
          out.moduleIsCompileError = error instanceof WebAssembly.CompileError;
          out.moduleIsError = error instanceof Error;
          out.moduleMessage = error.message;
        }
        try { new WebAssembly.Instance({}) } catch (error) { out.instanceError = error.name }
        var memory = new WebAssembly.Memory({ initial: 1 });
        out.memory = {
          bytes: memory.buffer.byteLength,
          instance: memory instanceof WebAssembly.Memory,
          grown: memory.grow(1),
          after: memory.buffer.byteLength
        };
        var table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
        out.table = { length: table.length, element: table.element, get: table.get(0) };
        var global = new WebAssembly.Global({ value: 7 });
        out.global = { value: global.valueOf(), kind: typeof global };
        return JSON.stringify(out);
      })()`,
    )
    assert.equal(value.type, 'object')
    assert.equal(value.brand, '[object WebAssembly]')
    for (const name of [...value.constructors, ...value.statics]) {
      assert.ok(value.memberNames.includes(name), `WebAssembly.${name} is not an own property`)
    }
    assert.deepEqual(value.constructors, ['Module', 'Instance', 'Memory', 'Table', 'Global', 'CompileError', 'LinkError', 'RuntimeError'])
    assert.deepEqual(value.statics, ['validate', 'compile', 'instantiate', 'instantiateStreaming'])
    assert.equal(value.nativeCompile, true)
    assert.equal(value.nativeCtor, true)
    assert.equal(value.validateGood, false, 'the stub cannot validate WASM, and says so')
    assert.equal(value.validateBad, false)
    assert.equal(value.validateType, 'TypeError')
    assert.equal(value.moduleErrorName, 'CompileError')
    assert.equal(value.moduleIsCompileError, true)
    assert.equal(value.moduleIsError, true)
    assert.match(value.moduleMessage, /^WebAssembly\.Module\(\): expected magic word 00 61 73 6d, found 00 00 00 00 @\+0$/)
    assert.equal(value.instanceError, 'TypeError')
    assert.deepEqual(value.memory, { bytes: 65536, instance: true, grown: 1, after: 131072 })
    assert.deepEqual(value.table, { length: 2, element: 'anyfunc', get: null })
    assert.deepEqual(value.global, { value: 7, kind: 'object' })
  } finally {
    sb.dispose()
  }
})

test('WebAssembly compile, instantiate and instantiateStreaming fail like a browser', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      WebAssembly.compile(new Uint8Array([0, 1, 2, 3])).then(
        function () { console.log('compile:resolved') },
        function (error) {
          console.log('compile:' + error.name + ':' + (error instanceof WebAssembly.CompileError) + ':' + error.message);
        }
      );
      WebAssembly.instantiate(new Uint8Array(2)).then(
        function () { console.log('instantiate:resolved') },
        function (error) { console.log('instantiate:' + error.name) }
      );
      WebAssembly.compile('not a buffer').then(
        function () { console.log('compile-type:resolved') },
        function (error) { console.log('compile-type:' + error.name) }
      );
      WebAssembly.instantiateStreaming({}).then(
        function () { console.log('streaming:resolved') },
        function (error) { console.log('streaming:' + error.name + ':' + /Response/.test(error.message)) }
      );
      `,
      { level: 'off' },
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const logs = consoleLogs(run)
    assert.ok(
      logs.some((line) => /^compile:CompileError:true:WebAssembly\.compile\(\): expected magic word 00 61 73 6d, found 00 01 02 03 @\+0$/.test(line)),
      JSON.stringify(logs),
    )
    assert.ok(logs.includes('instantiate:CompileError'), JSON.stringify(logs))
    assert.ok(logs.includes('compile-type:TypeError'), JSON.stringify(logs))
    assert.ok(logs.includes('streaming:TypeError:true'), JSON.stringify(logs))
  } finally {
    sb.dispose()
  }
})

test('element instances expose a WebIDL own-property surface', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        var BRANDS = {
          div: '[object HTMLDivElement]', span: '[object HTMLSpanElement]', p: '[object HTMLParagraphElement]',
          a: '[object HTMLAnchorElement]', img: '[object HTMLImageElement]', input: '[object HTMLInputElement]',
          canvas: '[object HTMLCanvasElement]', video: '[object HTMLVideoElement]',
          audio: '[object HTMLAudioElement]', script: '[object HTMLScriptElement]', body: '[object HTMLBodyElement]'
        };
        var SHIM_TAGS = ['div', 'span', 'p', 'a', 'input', 'script', 'body'];
        var out = { keys: {}, ownNames: {}, ownSymbols: {}, brands: {}, interfaceInstance: {}, hasOwnStyle: {}, inStyle: {}, accessor: {} };
        var tags = Object.keys(BRANDS);
        for (var index = 0; index < tags.length; index += 1) {
          var tag = tags[index];
          var element = document.createElement(tag);
          out.keys[tag] = Object.keys(element).length;
          out.ownNames[tag] = Object.getOwnPropertyNames(element).length;
          out.ownSymbols[tag] = Object.getOwnPropertySymbols(element).length;
          out.brands[tag] = Object.prototype.toString.call(element);
          out.interfaceInstance[tag] = element instanceof HTMLElement && element instanceof globalThis[BRANDS[tag].slice(8, -1)];
          out.hasOwnStyle[tag] = Object.prototype.hasOwnProperty.call(element, 'style');
          out.inStyle[tag] = 'style' in element && typeof element.style === 'object';
        }
        // IDL attributes are accessors on the interface prototype, not data
        // properties the shim happens to hang on the instance.
        for (var shimIndex = 0; shimIndex < SHIM_TAGS.length; shimIndex += 1) {
          var shimElement = document.createElement(SHIM_TAGS[shimIndex]);
          var current = Object.getPrototypeOf(shimElement);
          var descriptor = null;
          while (current && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(current, 'id');
            current = Object.getPrototypeOf(current);
          }
          out.accessor[SHIM_TAGS[shimIndex]] = Boolean(descriptor && descriptor.get && descriptor.set && descriptor.enumerable);
        }
        // Writes must not resurrect an own property (the tell a data-property
        // shim leaves behind) and reads must see them.
        var probeEl = document.createElement('div');
        probeEl.id = 'written';
        probeEl.className = 'alpha beta';
        probeEl.textContent = 'text';
        probeEl.style.cssText = 'color: red';
        probeEl.setAttribute('data-stage', '2');
        var child = document.createElement('span');
        probeEl.appendChild(child);
        var other = document.createElement('div');
        other.style.cssText = 'color: blue';
        out.afterWrite = {
          keys: Object.keys(probeEl).length,
          ownNames: Object.getOwnPropertyNames(probeEl).length,
          ownSymbols: Object.getOwnPropertySymbols(probeEl).length,
          id: probeEl.id,
          className: probeEl.className,
          classListLength: probeEl.classList.length,
          textContent: probeEl.textContent,
          cssText: probeEl.style.cssText,
          attribute: probeEl.getAttribute('data-stage'),
          childTag: probeEl.firstChild.tagName,
          childParent: probeEl.firstChild.parentNode === probeEl,
          noLeakBetweenInstances: other.style.cssText.indexOf('blue') >= 0 && other.style.cssText !== probeEl.style.cssText && other.id === '',
          styleObjectIsPerInstance: probeEl.style !== other.style && probeEl.dataset !== other.dataset,
          rectHasNumbers: (function () {
            var rect = probeEl.getBoundingClientRect();
            return typeof rect.width === 'number' && typeof rect.height === 'number';
          })(),
          brandStillCorrect: Object.prototype.toString.call(probeEl)
        };
        // A text node keeps its own surface out of the element path (Chromium
        // reports zero own keys there too).
        var text = document.createTextNode('hello');
        out.textNode = { keys: Object.keys(text).length, ownNames: Object.getOwnPropertyNames(text).length, data: text.data };
        return JSON.stringify(out);
      })()`,
    )
    const tags = [
      'div', 'span', 'p', 'a', 'img', 'input', 'canvas', 'video', 'audio', 'script', 'body',
    ]
    for (const tag of tags) {
      assert.equal(value.keys[tag], 0, `${tag}: Object.keys(element) must be empty`)
      assert.equal(value.ownNames[tag], 0, `${tag}: the instance must own no configurable properties`)
      assert.equal(value.ownSymbols[tag], 0, `${tag}: the instance must own no symbols`)
      assert.equal(value.hasOwnStyle[tag], false, `${tag}: hasOwnProperty('style') must be false`)
      assert.equal(value.inStyle[tag], true, `${tag}: 'style' in element must still be true`)
      assert.equal(value.interfaceInstance[tag], true, `${tag}: instanceof HTMLElement/host interface must hold`)
    }
    assert.equal(value.brands.div, '[object HTMLDivElement]')
    assert.equal(value.brands.canvas, '[object HTMLCanvasElement]')
    assert.equal(value.brands.audio, '[object HTMLAudioElement]')
    assert.equal(value.brands.body, '[object HTMLBodyElement]')
    for (const tag of ['div', 'span', 'p', 'a', 'input', 'script', 'body']) {
      assert.equal(value.accessor[tag], true, `${tag}: 'id' must be an enumerable accessor on a prototype`)
    }
    assert.equal(value.afterWrite.keys, 0, 'a write must not create an own property')
    assert.equal(value.afterWrite.ownNames, 0)
    assert.equal(value.afterWrite.ownSymbols, 0)
    assert.equal(value.afterWrite.id, 'written')
    assert.equal(value.afterWrite.className, 'alpha beta')
    assert.equal(value.afterWrite.classListLength, 2)
    assert.equal(value.afterWrite.textContent, 'text')
    assert.equal(value.afterWrite.cssText, 'color: red;')
    assert.equal(value.afterWrite.attribute, '2')
    assert.equal(value.afterWrite.childTag, 'SPAN')
    assert.equal(value.afterWrite.childParent, true)
    assert.equal(value.afterWrite.noLeakBetweenInstances, true, 'elements must not share state')
    assert.equal(value.afterWrite.styleObjectIsPerInstance, true)
    assert.equal(value.afterWrite.rectHasNumbers, true)
    assert.equal(value.afterWrite.brandStillCorrect, '[object HTMLDivElement]')
    assert.deepEqual(value.textNode, { keys: 0, ownNames: 0, data: 'hello' })
  } finally {
    sb.dispose()
  }
})

test('document.createElement results are HTMLElement and per-tag interfaces', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        var div = document.createElement('div');
        var canvas = document.createElement('canvas');
        var image = document.createElement('img');
        var anchor = document.createElement('a');
        var script = document.createElement('script');
        var input = document.createElement('input');
        var body = document.createElement('body');
        var out = {
          required: ['HTMLElement', 'HTMLDivElement', 'HTMLBodyElement', 'HTMLCanvasElement', 'HTMLScriptElement', 'HTMLInputElement', 'HTMLImageElement', 'HTMLAnchorElement']
            .filter(function (name) { return typeof globalThis[name] !== 'function' }),
          divInstance: div instanceof HTMLElement,
          bodyInstance: body instanceof HTMLElement,
          canvasInstance: canvas instanceof HTMLElement,
          imageInstance: image instanceof HTMLElement,
          divIsDiv: div instanceof HTMLDivElement,
          spanIsNotDiv: document.createElement('span') instanceof HTMLDivElement,
          canvasIsCanvas: canvas instanceof HTMLCanvasElement,
          imageIsImage: image instanceof HTMLImageElement,
          anchorIsAnchor: anchor instanceof HTMLAnchorElement,
          scriptIsScript: script instanceof HTMLScriptElement,
          inputIsInput: input instanceof HTMLInputElement,
          notAnElement: 'x' instanceof HTMLElement,
          // The platform puts the tag interface directly above the instance:
          // div -> HTMLDivElement.prototype -> HTMLElement.prototype -> ...
          prototypeChain: Object.getPrototypeOf(div) === HTMLDivElement.prototype,
          parentChain: Object.getPrototypeOf(HTMLDivElement.prototype) === HTMLElement.prototype &&
            Object.getPrototypeOf(HTMLElement.prototype) === Element.prototype &&
            Object.getPrototypeOf(Element.prototype) === Node.prototype &&
            Object.getPrototypeOf(Node.prototype) === EventTarget.prototype,
          prototypeCtor: HTMLElement.prototype.constructor === HTMLElement,
          brand: Object.prototype.toString.call(div),
          bodyBrand: Object.prototype.toString.call(document.body),
          ctorName: div.constructor.name,
          ownSymbols: Object.getOwnPropertySymbols(div).length,
          nativeSource: String(HTMLElement).includes('native code')
        };
        try { new HTMLElement() } catch (error) { out.illegal = error.name + ':' + error.message }
        try { new HTMLDivElement() } catch (error) { out.interfaceIllegal = error.name }
        return JSON.stringify(out);
      })()`,
    )
    assert.deepEqual(value.required, [])
    assert.equal(value.divInstance, true)
    assert.equal(value.bodyInstance, true)
    assert.equal(value.canvasInstance, true, 'canvas elements are produced by another module and must still be HTMLElements')
    assert.equal(value.imageInstance, true)
    assert.equal(value.divIsDiv, true)
    assert.equal(value.spanIsNotDiv, false)
    assert.equal(value.canvasIsCanvas, true)
    assert.equal(value.imageIsImage, true)
    assert.equal(value.anchorIsAnchor, true)
    assert.equal(value.scriptIsScript, true)
    assert.equal(value.inputIsInput, true)
    assert.equal(value.notAnElement, false)
    assert.equal(value.prototypeChain, true, 'the instance prototype must be the tag interface')
    assert.equal(value.parentChain, true, 'each interface must sit on its specified parent interface')
    assert.equal(value.prototypeCtor, true)
    assert.equal(value.brand, '[object HTMLDivElement]', 'the D6 probe brand must not change')
    assert.equal(value.bodyBrand, '[object HTMLBodyElement]')
    assert.equal(value.ctorName, 'HTMLDivElement')
    assert.equal(value.ownSymbols, 0, 'element instances must not grow own symbols')
    assert.equal(value.nativeSource, true)
    assert.equal(value.illegal, 'TypeError:Illegal constructor')
    assert.equal(value.interfaceIllegal, 'TypeError')
  } finally {
    sb.dispose()
  }
})

test('the DOM interface hierarchy is a real prototype chain', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        var REQUIRED = ['EventTarget', 'Node', 'Element', 'CharacterData', 'Text', 'Comment',
          'DocumentFragment', 'DocumentType', 'Document', 'NodeList', 'HTMLCollection',
          'DOMTokenList', 'CSSStyleDeclaration', 'HTMLElement'];
        var out = { missing: REQUIRED.filter(function (name) { return typeof globalThis[name] !== 'function' }) };

        // Every interface sits directly on its specified parent, and the root
        // of every chain is Object.prototype: the chain, not a
        // Symbol.hasInstance hook, answers instanceof.
        function linked(list) {
          for (var index = 0; index < list.length - 1; index += 1) {
            if (Object.getPrototypeOf(list[index].prototype) !== list[index + 1].prototype) return false;
          }
          return Object.getPrototypeOf(list[list.length - 1].prototype) === Object.prototype;
        }
        out.chains = {
          element: linked([HTMLDivElement, HTMLElement, Element, Node, EventTarget]),
          body: linked([HTMLBodyElement, HTMLElement, Element, Node, EventTarget]),
          text: linked([Text, CharacterData, Node, EventTarget]),
          comment: linked([Comment, CharacterData, Node, EventTarget]),
          fragment: linked([DocumentFragment, Node, EventTarget]),
          document: linked([HTMLDocument, Document, Node, EventTarget]),
          nodeList: linked([NodeList]),
          htmlCollection: linked([HTMLCollection]),
          tokenList: linked([DOMTokenList]),
          style: linked([CSSStyleDeclaration])
        };

        var div = document.createElement('div');
        var text = document.createTextNode('x');
        var comment = document.createComment('c');
        var fragment = document.createDocumentFragment();
        var nodeList = document.querySelectorAll('div');
        var collection = document.getElementsByTagName('div');
        var canvas = document.createElement('canvas');
        out.instances = {
          divElement: div instanceof Element,
          divNode: div instanceof Node,
          divEventTarget: div instanceof EventTarget,
          divHTMLElement: div instanceof HTMLElement,
          divDiv: div instanceof HTMLDivElement,
          spanNotDiv: !(document.createElement('span') instanceof HTMLDivElement),
          divNotText: !(div instanceof Text),
          documentDocument: document instanceof Document,
          documentHTMLDocument: document instanceof HTMLDocument,
          documentNode: document instanceof Node,
          documentEventTarget: document instanceof EventTarget,
          bodyHTMLElement: document.body instanceof HTMLElement,
          bodyBody: document.body instanceof HTMLBodyElement,
          textText: text instanceof Text,
          textCharacterData: text instanceof CharacterData,
          textNode: text instanceof Node,
          commentComment: comment instanceof Comment,
          commentCharacterData: comment instanceof CharacterData,
          fragmentFragment: fragment instanceof DocumentFragment,
          fragmentNode: fragment instanceof Node,
          nodeList: nodeList instanceof NodeList,
          collection: collection instanceof HTMLCollection,
          tokenList: div.classList instanceof DOMTokenList,
          style: div.style instanceof CSSStyleDeclaration,
          computedStyle: getComputedStyle(div) instanceof CSSStyleDeclaration,
          canvasHTMLElement: canvas instanceof HTMLElement,
          canvasNode: canvas instanceof Node,
          canvasImageHTMLElement: document.createElement('img') instanceof HTMLElement,
          canvasStyle: canvas.style instanceof CSSStyleDeclaration
        };

        // childNodes/children are live collection instances, not host Arrays:
        // Array.isArray(document.body.childNodes) is a classic sandbox tell.
        var body = document.body;
        var paragraph = document.createElement('p');
        body.appendChild(paragraph);
        out.live = {
          childNodesIsNodeList: body.childNodes instanceof NodeList,
          childrenIsCollection: body.children instanceof HTMLCollection,
          childNodesLength: body.childNodes.length,
          childNodesIndex: body.childNodes[0] === paragraph,
          childrenIndex: body.children[0] === paragraph,
          childNodesNotArray: !Array.isArray(body.childNodes) && !Array.isArray(body.children),
          childNodesItem: body.childNodes.item(0) === paragraph,
          liveAfterInsert: (function () {
            var extra = document.createElement('span');
            body.appendChild(extra);
            var ok = body.childNodes.length === 2 && body.childNodes[1] === extra;
            body.removeChild(extra);
            return ok;
          })(),
          indexRemoved: body.childNodes[1] === undefined && body.childNodes.length === 1
        };

        // Array-like shape of the two collection interfaces.
        out.collections = {
          nodeListLength: typeof nodeList.length,
          nodeListItem: typeof nodeList.item,
          nodeListForEach: typeof nodeList.forEach,
          nodeListIterable: typeof nodeList[Symbol.iterator] === 'function' &&
            Array.from(nodeList).length === nodeList.length,
          collectionItem: typeof collection.item,
          collectionNamedItem: typeof collection.namedItem,
          notArray: !Array.isArray(nodeList) && !Array.isArray(collection)
        };

        out.brands = {
          div: Object.prototype.toString.call(div),
          body: Object.prototype.toString.call(document.body),
          text: Object.prototype.toString.call(text),
          comment: Object.prototype.toString.call(comment),
          fragment: Object.prototype.toString.call(fragment),
          document: Object.prototype.toString.call(document),
          nodeList: Object.prototype.toString.call(nodeList),
          collection: Object.prototype.toString.call(collection),
          tokenList: Object.prototype.toString.call(div.classList),
          style: Object.prototype.toString.call(div.style)
        };
        out.constructors = {
          div: div.constructor.name,
          text: text.constructor.name,
          document: document.constructor.name,
          nodeList: nodeList.constructor.name,
          style: div.style.constructor.name,
          htmlElement: HTMLElement.prototype.constructor === HTMLElement
        };

        // A structural hook would answer instanceof from nodeType/tagName; the
        // interfaces must not define one.
        out.structuralHooks = [EventTarget, Node, Element, HTMLElement, HTMLDivElement, Text,
          Comment, CharacterData, Document, DocumentFragment, NodeList, HTMLCollection]
          .filter(function (ctor) { return Object.getOwnPropertyDescriptor(ctor, Symbol.hasInstance) !== undefined }).length;
        out.illegal = (function () { try { new Element() } catch (error) { return error.name } return 'constructed' })();

        // Instances own nothing; per-instance state stays per instance.
        out.owns = {
          divKeys: Object.keys(div).length,
          divNames: Object.getOwnPropertyNames(div).length,
          divSymbols: Object.getOwnPropertySymbols(div).length,
          textKeys: Object.keys(text).length,
          textSymbols: Object.getOwnPropertySymbols(text).length,
          nodeListKeys: nodeList.length,
          classListKeys: Object.keys(div.classList).length,
          styleKeys: Object.keys(div.style).length
        };
        var first = document.createElement('div');
        var second = document.createElement('div');
        first.id = 'only-first';
        first.style.color = 'red';
        first.classList.add('alpha');
        out.state = {
          idsDiffer: first.id !== second.id,
          stylePerInstance: first.style !== second.style,
          classListPerInstance: first.classList !== second.classList,
          childNodesPerInstance: first.childNodes !== second.childNodes,
          secondClean: second.id === '' && second.classList.length === 0 && second.childNodes.length === 0,
          firstKept: first.id === 'only-first' && first.classList.contains('alpha'),
          prototypeShared: Object.getPrototypeOf(first.style) === Object.getPrototypeOf(second.style)
        };

        // CharacterData/Text operations live on the interfaces, not the nodes.
        var data = document.createTextNode('hello');
        data.appendData('!');
        var tail = data.splitText(2);
        out.characterData = {
          data: data.data,
          length: data.length,
          nodeValue: data.nodeValue,
          tail: tail.data,
          tailIsText: tail instanceof Text,
          appendNative: String(CharacterData.prototype.appendData).includes('native code'),
          splitNative: String(Text.prototype.splitText).includes('native code')
        };
        out.nativeSources = [EventTarget, Node, Element, HTMLElement, HTMLDivElement, Text, Comment,
          CharacterData, Document, DocumentFragment, NodeList, HTMLCollection, DOMTokenList,
          CSSStyleDeclaration]
          .filter(function (ctor) { return !String(ctor).includes('native code') });
        return JSON.stringify(out);
      })()`,
    )
    assert.deepEqual(value.missing, [], 'every DOM interface must be a global')
    for (const [name, ok] of Object.entries(value.chains)) {
      assert.equal(ok, true, `${name}: the interface must sit on its specified parent interface`)
    }
    for (const [name, ok] of Object.entries(value.instances)) {
      assert.equal(ok, true, `${name}: instanceof must hold through the prototype chain`)
    }
    assert.deepEqual(value.live, {
      childNodesIsNodeList: true,
      childrenIsCollection: true,
      childNodesLength: 1,
      childNodesIndex: true,
      childrenIndex: true,
      childNodesNotArray: true,
      childNodesItem: true,
      liveAfterInsert: true,
      indexRemoved: true,
    })
    assert.equal(value.collections.nodeListLength, 'number')
    assert.equal(value.collections.nodeListItem, 'function')
    assert.equal(value.collections.nodeListForEach, 'function')
    assert.equal(value.collections.nodeListIterable, true)
    assert.equal(value.collections.collectionItem, 'function')
    assert.equal(value.collections.collectionNamedItem, 'function')
    assert.equal(value.collections.notArray, true, 'a collection must not be a plain Array')
    assert.deepEqual(value.brands, {
      div: '[object HTMLDivElement]',
      body: '[object HTMLBodyElement]',
      text: '[object Text]',
      comment: '[object Comment]',
      fragment: '[object DocumentFragment]',
      document: '[object HTMLDocument]',
      nodeList: '[object NodeList]',
      collection: '[object HTMLCollection]',
      tokenList: '[object DOMTokenList]',
      style: '[object CSSStyleDeclaration]',
    })
    assert.equal(value.constructors.div, 'HTMLDivElement')
    assert.equal(value.constructors.text, 'Text')
    assert.equal(value.constructors.document, 'HTMLDocument')
    assert.equal(value.constructors.nodeList, 'NodeList')
    assert.equal(value.constructors.style, 'CSSStyleDeclaration')
    assert.equal(value.constructors.htmlElement, true)
    assert.equal(value.structuralHooks, 0, 'instanceof must come from the chain, not a structural hook')
    assert.equal(value.illegal, 'TypeError')
    assert.deepEqual(value.owns, {
      divKeys: 0,
      divNames: 0,
      divSymbols: 0,
      textKeys: 0,
      textSymbols: 0,
      nodeListKeys: 0,
      classListKeys: 0,
      styleKeys: 0,
    })
    assert.deepEqual(value.state, {
      idsDiffer: true,
      stylePerInstance: true,
      classListPerInstance: true,
      childNodesPerInstance: true,
      secondClean: true,
      firstKept: true,
      prototypeShared: true,
    })
    assert.deepEqual(value.characterData, {
      data: 'he',
      length: 2,
      nodeValue: 'he',
      tail: 'llo!',
      tailIsText: true,
      appendNative: true,
      splitNative: true,
    })
    assert.deepEqual(value.nativeSources, [], 'interfaces must stringify as native code')
  } finally {
    sb.dispose()
  }
})

test('customElements is a working registry with browser error names', async () => {
  const sb = await sandbox()
  try {
    const { value, run } = await probe(
      sb,
      `(function () {
        class MyBadge extends HTMLElement {
          constructor() { super(); this.role = 'badge' }
        }
        customElements.define('my-badge', MyBadge);
        var out = {
          type: typeof customElements,
          brand: Object.prototype.toString.call(customElements),
          methods: ['define', 'get', 'whenDefined', 'upgrade'].filter(function (key) { return typeof customElements[key] !== 'function' }),
          get: customElements.get('my-badge') === MyBadge,
          unknown: customElements.get('not-defined'),
          upgradeAvailable: typeof customElements.upgrade
        };
        var fresh = document.createElement('my-badge');
        out.notUpgraded = fresh instanceof MyBadge;
        out.divIsBadge = document.createElement('div') instanceof MyBadge;
        var element = fresh;
        customElements.upgrade(element);
        out.upgraded = element instanceof MyBadge;
        out.upgradedPrototype = Object.getPrototypeOf(element) === MyBadge.prototype;
        out.stillElement = element instanceof HTMLElement;
        try { customElements.define('my-badge', MyBadge) } catch (error) { out.duplicate = error.name }
        try { customElements.define('bogus', MyBadge) } catch (error) { out.invalid = error.name }
        try { customElements.define('Upper-Case', MyBadge) } catch (error) { out.uppercase = error.name }
        try { customElements.define('x-ctor', 'not a constructor') } catch (error) { out.notCtor = error.name }
        customElements.whenDefined('late-widget').then(function (ctor) {
          console.log('whenDefined:' + (ctor === LateWidget));
        });
        class LateWidget extends HTMLElement {}
        customElements.define('late-widget', LateWidget);
        return JSON.stringify(out);
      })()`,
    )
    assert.equal(value.type, 'object')
    assert.equal(value.brand, '[object CustomElementRegistry]')
    assert.deepEqual(value.methods, [])
    assert.equal(value.get, true)
    assert.equal(value.unknown, undefined)
    assert.equal(value.upgradeAvailable, 'function')
    assert.equal(value.notUpgraded, false, 'defining a name must not upgrade existing elements')
    assert.equal(value.divIsBadge, false, 'a user subclass must not match every element')
    assert.equal(value.upgraded, true)
    assert.equal(value.upgradedPrototype, true)
    assert.equal(value.stillElement, true)
    assert.equal(value.duplicate, 'NotSupportedError')
    assert.equal(value.invalid, 'SyntaxError')
    assert.equal(value.uppercase, 'SyntaxError')
    assert.equal(value.notCtor, 'TypeError')
    assert.ok(consoleLogs(run).includes('whenDefined:true'), JSON.stringify(consoleLogs(run)))
  } finally {
    sb.dispose()
  }
})

test('CustomElementRegistry is the registry interface, not a missing global', async () => {
  // Residual (see the lane report): the registry *instance* is built by the
  // anti-fingerprint module, whose guest half creates a plain object, so
  // `customElements instanceof CustomElementRegistry` still answers `false`.
  // Fixing that needs `anti-fingerprint.js`, outside this lane. Everything the
  // interface can own here (identity, members, brand, Illegal constructor,
  // Illegal invocation, delegation to the live singleton) is asserted below.
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        var out = {
          type: typeof CustomElementRegistry,
          nativeSource: String(CustomElementRegistry).includes('native code'),
          length: CustomElementRegistry.length,
          members: Object.getOwnPropertyNames(CustomElementRegistry.prototype),
          protoConstructor: CustomElementRegistry.prototype.constructor === CustomElementRegistry,
          protoBrand: Object.prototype.toString.call(CustomElementRegistry.prototype),
          enumerable: Object.keys(globalThis).indexOf('CustomElementRegistry'),
          descriptor: (function () {
            var d = Object.getOwnPropertyDescriptor(globalThis, 'CustomElementRegistry');
            return { enumerable: d.enumerable, configurable: d.configurable, writable: d.writable };
          })(),
          registryBrand: Object.prototype.toString.call(customElements),
          registryOwnKeys: Object.keys(customElements).length,
          delegatedGet: CustomElementRegistry.prototype.get.call(customElements, 'never-defined'),
          nativeMethod: String(CustomElementRegistry.prototype.get).includes('native code')
        };
        // Calling define through the interface reaches the one registry the page has.
        class ProbeBox extends HTMLElement {}
        CustomElementRegistry.prototype.define.call(customElements, 'probe-box', ProbeBox);
        out.delegatedDefine = customElements.get('probe-box') === ProbeBox;
        try { new CustomElementRegistry() } catch (error) { out.illegalConstructor = error.name + ': ' + error.message }
        try { CustomElementRegistry.prototype.get.call({}, 'probe-box') } catch (error) { out.brandCheck = error.name }
        return JSON.stringify(out);
      })()`,
    )
    assert.equal(value.type, 'function')
    assert.equal(value.nativeSource, true)
    assert.equal(value.length, 0)
    assert.deepEqual(value.members, ['constructor', 'define', 'get', 'whenDefined', 'upgrade'])
    assert.equal(value.protoConstructor, true)
    assert.equal(value.protoBrand, '[object CustomElementRegistry]')
    assert.equal(value.enumerable, -1, 'the interface is a non-enumerable global')
    assert.deepEqual(value.descriptor, { enumerable: false, configurable: true, writable: true })
    assert.equal(value.registryBrand, '[object CustomElementRegistry]')
    assert.equal(value.registryOwnKeys, 0)
    assert.equal(value.delegatedGet, undefined)
    assert.equal(value.delegatedDefine, true)
    assert.equal(value.nativeMethod, true)
    assert.equal(value.illegalConstructor, 'TypeError: Illegal constructor')
    assert.equal(value.brandCheck, 'TypeError')
  } finally {
    sb.dispose()
  }
})

test('DOMParser builds a real tree and XMLSerializer round-trips it', async () => {
  const sb = await sandbox()
  try {
    const { value, run } = await probe(
      sb,
      `(function () {
        var parser = new DOMParser();
        var serializer = new XMLSerializer();
        var markup = '<!doctype html><html><head><title>Hi &amp; bye</title></head>' +
          '<body><div id="app" class="root panel"><p class="msg">hello <b>world</b></p>' +
          '<img src="a.png" alt="x &quot;y&quot;"><!--note--></div></body></html>';
        var doc = parser.parseFromString(markup, 'text/html');
        var xmlDoc = parser.parseFromString('<root a="1"><item>one</item><item>two</item></root>', 'text/xml');
        var out = {
          brand: Object.prototype.toString.call(doc),
          ownKeys: Object.keys(doc).length,
          ownSymbols: Object.getOwnPropertySymbols(doc).length,
          // Blink brands the parser interfaces themselves; a plain [object Object]
          // brand is a direct tell.
          parserBrand: Object.prototype.toString.call(parser),
          serializerBrand: Object.prototype.toString.call(serializer),
          parserProtoBrand: Object.prototype.toString.call(DOMParser.prototype),
          parserOwn: Object.keys(parser).length + Object.getOwnPropertySymbols(parser).length,
          parserIsParser: parser instanceof DOMParser,
          serializerIsSerializer: serializer instanceof XMLSerializer,
          parserConstructorName: parser.constructor.name,
          serializerConstructorName: serializer.constructor.name,
          nodeType: doc.nodeType,
          contentType: doc.contentType,
          documentElement: doc.documentElement.tagName,
          body: doc.body.tagName,
          headChildren: doc.head.children.length,
          title: doc.title,
          byId: doc.getElementById('app').tagName,
          byClass: doc.getElementsByClassName('msg').length,
          byTag: doc.getElementsByTagName('p').length,
          id: doc.querySelector('#app') !== null,
          className: doc.querySelector('.msg') !== null,
          compound: doc.querySelector('div#app.root') !== null,
          compoundMiss: doc.querySelector('div#app.missing'),
          list: doc.querySelectorAll('p, div').length,
          missing: doc.querySelector('#nope'),
          parsedText: doc.querySelector('p').childNodes[1].tagName,
          serializer: new XMLSerializer().serializeToString(doc),
          image: new XMLSerializer().serializeToString(doc.querySelector('img')),
          nativeParser: String(DOMParser).includes('native code'),
          nativeMethod: String(doc.querySelector).includes('native code'),
          nativeGetter: (function () {
            var target = doc;
            while (target) {
              var descriptor = Object.getOwnPropertyDescriptor(target, 'title');
              if (descriptor && descriptor.get) return String(descriptor.get).includes('native code');
              target = Object.getPrototypeOf(target);
            }
            return false;
          })(),
          xmlBrand: Object.prototype.toString.call(xmlDoc),
          xmlRoot: xmlDoc.documentElement.tagName,
          xmlBody: xmlDoc.body,
          xmlTitle: xmlDoc.title,
          xmlItems: xmlDoc.querySelectorAll('item').length,
          xml: new XMLSerializer().serializeToString(xmlDoc)
        };
        try { parser.parseFromString('<x/>', 'text/plain') } catch (error) { out.badType = error.name }
        try { DOMParser() } catch (error) { out.noNew = error.name }
        try { new XMLSerializer().serializeToString('nope') } catch (error) { out.badNode = error.name }
        return JSON.stringify(out);
      })()`,
    )
    assert.equal(value.brand, '[object HTMLDocument]')
    assert.equal(value.ownKeys, 0)
    assert.equal(value.ownSymbols, 0)
    assert.equal(value.parserBrand, '[object DOMParser]')
    assert.equal(value.serializerBrand, '[object XMLSerializer]')
    assert.equal(value.parserProtoBrand, '[object DOMParser]')
    assert.equal(value.parserOwn, 0, 'branding must not add an own property or symbol')
    assert.equal(value.parserIsParser, true)
    assert.equal(value.serializerIsSerializer, true)
    assert.equal(value.parserConstructorName, 'DOMParser')
    assert.equal(value.serializerConstructorName, 'XMLSerializer')
    assert.equal(value.nodeType, 9)
    assert.equal(value.contentType, 'text/html')
    assert.equal(value.documentElement, 'HTML')
    assert.equal(value.body, 'BODY')
    assert.equal(value.headChildren, 1)
    assert.equal(value.title, 'Hi & bye')
    assert.equal(value.byId, 'DIV')
    assert.equal(value.byClass, 1)
    assert.equal(value.byTag, 1)
    assert.equal(value.id, true)
    assert.equal(value.className, true)
    assert.equal(value.compound, true)
    assert.equal(value.compoundMiss, null)
    assert.equal(value.list, 2)
    assert.equal(value.missing, null)
    assert.equal(value.parsedText, 'B')
    assert.equal(
      value.serializer,
      '<html><head><title>Hi &amp; bye</title></head><body><div id="app" class="root panel">' +
        '<p class="msg">hello <b>world</b></p><img src="a.png" alt="x &quot;y&quot;"><!--note--></div></body></html>',
    )
    assert.equal(value.image, '<img src="a.png" alt="x &quot;y&quot;">')
    assert.equal(value.nativeParser, true)
    assert.equal(value.nativeMethod, true)
    assert.equal(value.nativeGetter, true)
    assert.equal(value.xmlBrand, '[object XMLDocument]')
    assert.equal(value.xmlRoot, 'ROOT')
    assert.equal(value.xmlBody, null)
    assert.equal(value.xmlTitle, '')
    assert.equal(value.xmlItems, 2)
    assert.equal(value.xml, '<root a="1"><item>one</item><item>two</item></root>')
    assert.equal(value.badType, 'TypeError')
    assert.equal(value.noNew, 'TypeError')
    assert.equal(value.badNode, 'TypeError')

    const parseEvents = (run.events ?? []).filter((event) => event.kind === 'api' && event.api === 'DOMParser.parseFromString')
    assert.ok(parseEvents.length >= 2, JSON.stringify(parseEvents))
    assert.ok(parseEvents.every((event) => event.truncated === false))
  } finally {
    sb.dispose()
  }
})

test('a parsed XML document is an XMLDocument, an HTML one an HTMLDocument', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        var parser = new DOMParser();
        var html = parser.parseFromString('<html><body><p>x</p></body></html>', 'text/html');
        var xml = parser.parseFromString('<root><item/></root>', 'text/xml');
        var xhtml = parser.parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>', 'application/xhtml+xml');
        return JSON.stringify({
          brands: {
            html: Object.prototype.toString.call(html),
            xml: Object.prototype.toString.call(xml),
            live: Object.prototype.toString.call(document)
          },
          html: {
            isHTML: html instanceof HTMLDocument,
            isNotXML: !(html instanceof XMLDocument),
            isDocument: html instanceof Document,
            ctor: html.constructor === HTMLDocument
          },
          xml: {
            isXML: xml instanceof XMLDocument,
            isNotHTML: !(xml instanceof HTMLDocument),
            isDocument: xml instanceof Document,
            ctor: xml.constructor === XMLDocument,
            query: xml.querySelector('item').tagName
          },
          xhtml: {
            isXML: xhtml instanceof XMLDocument,
            isNotHTML: !(xhtml instanceof HTMLDocument)
          },
          live: {
            isHTML: document instanceof HTMLDocument,
            isNotXML: !(document instanceof XMLDocument),
            isDocument: document instanceof Document
          },
          interfaces: {
            xmlBelowDocument: Object.getPrototypeOf(XMLDocument.prototype) === Document.prototype,
            globalsIntact: String(DOMParser).includes('native code') && String(XMLDocument).includes('native code')
          }
        });
      })()`,
    )
    assert.deepEqual(value.brands, {
      html: '[object HTMLDocument]',
      xml: '[object XMLDocument]',
      live: '[object HTMLDocument]',
    })
    assert.deepEqual(value.html, { isHTML: true, isNotXML: true, isDocument: true, ctor: true })
    assert.deepEqual(value.xml, {
      isXML: true,
      isNotHTML: true,
      isDocument: true,
      ctor: true,
      query: 'ITEM',
    })
    assert.deepEqual(value.xhtml, { isXML: true, isNotHTML: true })
    assert.deepEqual(value.live, { isHTML: true, isNotXML: true, isDocument: true })
    assert.deepEqual(value.interfaces, { xmlBelowDocument: true, globalsIntact: true })
  } finally {
    sb.dispose()
  }
})

test('DOMParser bounds a hostile payload instead of parsing it', async () => {
  const sb = await sandbox()
  try {
    const { value, run } = await probe(
      sb,
      `(function () {
        var huge = '<div>' + 'x'.repeat(200000) + '</div>';
        var deep = '';
        for (var index = 0; index < 200; index += 1) deep += '<div>';
        var doc = new DOMParser().parseFromString(huge + deep, 'text/html');
        return JSON.stringify({
          hasRoot: doc.documentElement !== null,
          bodyChildren: doc.body.children.length
        });
      })()`,
    )
    assert.equal(value.hasRoot, true)
    assert.ok(value.bodyChildren > 0)
    const parseEvents = (run.events ?? []).filter((event) => event.kind === 'api' && event.api === 'DOMParser.parseFromString')
    assert.ok(parseEvents.some((event) => event.truncated === true), 'the bound must be reported in the trace')
  } finally {
    sb.dispose()
  }
})

test('EventSource connects through the virtual network and reconnects on the clock', async () => {
  const sb = await sandbox()
  const route = {
    match: 'events.example.test/stream',
    response: {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      bodyText: 'retry: 500\nid: 1\ndata: hello\nevent: ping\ndata: pong\n\ndata: second\n\n',
    },
  }
  try {
    const run = await sb.run(
      `
      var opens = 0;
      var first = new EventSource('https://events.example.test/stream', { withCredentials: true });
      first.onopen = function () {
        opens += 1;
        console.log('open:' + opens + ':' + first.readyState + ':' + first.withCredentials);
        // The mock stream ends immediately, so the second open proves the
        // reconnect path ran; close there to keep the run bounded.
        if (opens >= 2) {
          first.close();
          console.log('first-closed:' + first.readyState);
        }
      };
      first.onmessage = function (event) {
        console.log('message:' + event.data + ':' + event.lastEventId + ':' + event.origin);
        console.log('legacy:' + (first.onmessage !== null));
      };
      first.addEventListener('ping', function (event) { console.log('ping:' + event.data) });
      var second = new EventSource('https://events.example.test/stream');
      second.onopen = function () {
        console.log('closing:' + second.readyState);
        second.close();
        console.log('closed:' + second.readyState);
      };
      `,
      { level: 'off', network: { routes: [route] } },
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const logs = consoleLogs(run)
    assert.ok(logs.includes('open:1:1:true'), JSON.stringify(logs))
    assert.ok(logs.includes('open:2:1:true'), JSON.stringify(logs))
    assert.ok(logs.includes('first-closed:2'), JSON.stringify(logs))
    assert.ok(logs.includes('ping:hello\npong'), JSON.stringify(logs))
    assert.ok(logs.includes('message:second:1:https://events.example.test'), JSON.stringify(logs))
    assert.ok(logs.includes('closing:1') && logs.includes('closed:2'), JSON.stringify(logs))

    const events = run.events ?? []
    const connectEvents = events.filter((event) => event.kind === 'api' && event.api === 'EventSource.connect')
    assert.ok(connectEvents.length >= 1, JSON.stringify(connectEvents))
    assert.ok(events.some((event) => event.kind === 'api' && event.api === 'EventSource.message' && event.type === 'ping'))
    assert.ok(events.some((event) => event.kind === 'api' && event.api === 'EventSource.reconnect' && event.retryMs === 500))
    assert.ok(events.some((event) => event.kind === 'api' && event.api === 'EventSource.close'))
    const netEvents = events.filter((event) => event.kind === 'net')
    assert.ok(netEvents.length >= 2, 'each connection is a recorded network request')
    assert.ok(netEvents.every((event) => event.status === 200 && /events\.example\.test/.test(String(event.url))))
    assert.ok(events.some((event) => event.kind === 'ioc' && /events\.example\.test/.test(String(event.value))))
  } finally {
    sb.dispose()
  }
})

test('EventSource retries a refused stream and validates its arguments', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      var source = new EventSource('https://refused.example.test/events');
      var errors = 0;
      source.onerror = function () { errors += 1; console.log('error:' + errors + ':' + source.readyState) };
      (function () {
        var out = {};
        out.type = typeof EventSource;
        out.source = String(EventSource).includes('native code');
        out.brand = Object.prototype.toString.call(source);
        out.protoBrand = Object.prototype.toString.call(EventSource.prototype);
        out.own = Object.keys(source).length + Object.getOwnPropertySymbols(source).length;
        out.isEventSource = source instanceof EventSource;
        out.constructorName = source.constructor.name;
        out.constants = [EventSource.CONNECTING, EventSource.OPEN, EventSource.CLOSED];
        out.protoConstants = [EventSource.prototype.CONNECTING, EventSource.prototype.CLOSED];
        out.url = source.url;
        try { new EventSource() } catch (error) { out.missingArgument = error.name }
        try { EventSource('https://a.example.test/') } catch (error) { out.noNew = error.name }
        try { new EventSource('ftp://a.example.test/events') } catch (error) { out.scheme = error.name }
        try { new EventSource('http://[oops') } catch (error) { out.malformed = error.name }
        console.log('probe:' + JSON.stringify(out));
      })();
      `,
      { level: 'off', network: { policy: 'deny' } },
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    const logs = consoleLogs(run)
    const probeLine = logs.find((line) => line.startsWith('probe:'))
    assert.ok(probeLine, JSON.stringify(logs))
    const value = JSON.parse(probeLine.slice('probe:'.length))
    assert.equal(value.type, 'function')
    assert.equal(value.source, true)
    assert.equal(value.brand, '[object EventSource]')
    assert.equal(value.protoBrand, '[object EventSource]')
    assert.equal(value.own, 0, 'the stream state must stay out of the own-property surface')
    assert.equal(value.isEventSource, true)
    assert.equal(value.constructorName, 'EventSource')
    assert.deepEqual(value.constants, [0, 1, 2])
    assert.deepEqual(value.protoConstants, [0, 2])
    assert.equal(value.url, 'https://refused.example.test/events')
    assert.equal(value.missingArgument, 'TypeError')
    assert.equal(value.noNew, 'TypeError')
    assert.equal(value.scheme, 'SyntaxError')
    assert.equal(value.malformed, 'SyntaxError')
    assert.ok(logs.some((line) => /^error:1:0$/.test(line)), 'a transport failure keeps CONNECTING and fires error')

    const events = run.events ?? []
    assert.ok(events.some((event) => event.kind === 'api' && event.api === 'EventSource.error'))
    assert.ok(events.some((event) => event.kind === 'net' && event.status === 0))
    // Close the retry loop deterministically: a second run must not depend on
    // how many retries the virtual clock allowed in this one.
    const reconnectCount = events.filter((event) => event.kind === 'api' && event.api === 'EventSource.reconnect').length
    assert.ok(reconnectCount >= 1, 'a refused stream is retried on the virtual clock')
  } finally {
    sb.dispose()
  }
})

test('each error constructor reports its own native identity and V8 prototype descriptor', async () => {
  const sb = await sandbox()
  try {
    const names = ['Error', 'TypeError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError']
    const { value } = await probe(
      sb,
      `(function () {
        var names = ${JSON.stringify(names)};
        var out = { sources: {}, prototypes: {} };
        for (var i = 0; i < names.length; i++) {
          var name = names[i];
          out.sources[name] = String(globalThis[name]);
          var descriptor = Object.getOwnPropertyDescriptor(globalThis[name], 'prototype');
          out.prototypes[name] = {
            writable: descriptor.writable,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable
          };
        }
        return JSON.stringify(out);
      })()`,
    )
    for (const name of names) {
      // Sharing one wrapper body made every adoption key identical, so the last
      // constructor to install won the mask and every name reported URIError.
      assert.equal(value.sources[name], `function ${name}() { [native code] }`)
      // V8 defines the prototype property as non-writable and non-configurable.
      assert.deepEqual(value.prototypes[name], {
        writable: false,
        enumerable: false,
        configurable: false,
      })
    }
  } finally {
    sb.dispose()
  }
})

test('an error subclass keeps its own prototype, as V8 does', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        class MyError extends Error {
          constructor(message) { super(message); this.name = 'MyError' }
        }
        class MyType extends TypeError {}
        class MyAggregate extends AggregateError {}
        function FnErr() {}

        var direct = new MyError('boom');
        var viaReflect = Reflect.construct(Error, ['made'], MyError);
        var viaFnTarget = Reflect.construct(Error, ['made'], FnErr);
        var plain = new Error('plain');
        var called = Error('called');
        var typeError = new MyType('kind');
        var aggregate = new MyAggregate([], 'many');

        return JSON.stringify({
          instanceOfSubclass: direct instanceof MyError,
          instanceOfError: direct instanceof Error,
          prototypeIsSubclass: Object.getPrototypeOf(direct) === MyError.prototype,
          constructorIsSubclass: direct.constructor === MyError,
          message: direct.message,
          name: direct.name,
          stackIsString: typeof direct.stack === 'string',
          reflectInstanceOf: viaReflect instanceof MyError,
          reflectPrototype: Object.getPrototypeOf(viaReflect) === MyError.prototype,
          reflectMessage: viaReflect.message,
          fnTargetInstanceOf: viaFnTarget instanceof FnErr,
          fnTargetPrototype: Object.getPrototypeOf(viaFnTarget) === FnErr.prototype,
          typeIsSubclass: typeError instanceof MyType,
          typePrototype: Object.getPrototypeOf(typeError) === MyType.prototype,
          typeIsTypeError: typeError instanceof TypeError,
          aggregateIsSubclass: aggregate instanceof MyAggregate,
          aggregateIsAggregate: aggregate instanceof AggregateError,
          aggregatePrototype: Object.getPrototypeOf(aggregate) === MyAggregate.prototype,
          plainPrototype: Object.getPrototypeOf(plain) === Error.prototype,
          calledWithoutNewPrototype: Object.getPrototypeOf(called) === Error.prototype
        });
      })()`,
    )
    assert.equal(value.instanceOfSubclass, true, 'the instance must pass instanceof its subclass')
    assert.equal(value.instanceOfError, true)
    assert.equal(value.prototypeIsSubclass, true, 'the instance prototype must be the subclass prototype')
    assert.equal(value.constructorIsSubclass, true, 'constructor must resolve to the subclass')
    assert.equal(value.message, 'boom', 'the message must survive the subclass path')
    assert.equal(value.name, 'MyError')
    assert.equal(value.stackIsString, true)
    assert.equal(value.reflectInstanceOf, true, 'Reflect.construct must honour newTarget')
    assert.equal(value.reflectPrototype, true)
    assert.equal(value.reflectMessage, 'made')
    assert.equal(value.fnTargetInstanceOf, true)
    assert.equal(value.fnTargetPrototype, true)
    assert.equal(value.typeIsSubclass, true, 'every NativeError must honour subclassing')
    assert.equal(value.typePrototype, true)
    assert.equal(value.typeIsTypeError, true)
    assert.equal(value.aggregateIsSubclass, true, 'AggregateError must honour subclassing')
    assert.equal(value.aggregateIsAggregate, true)
    assert.equal(value.aggregatePrototype, true)
    assert.equal(value.plainPrototype, true, 'plain construction must keep Error.prototype')
    assert.equal(value.calledWithoutNewPrototype, true, 'calling without new must keep Error.prototype')
  } finally {
    sb.dispose()
  }
})

test('guest stacks carry no wrapper, native trampoline or host frame', async () => {
  const sb = await sandbox()
  try {
    const { value } = await probe(
      sb,
      `(function () {
        class MyError extends Error {
          constructor(message) { super(message); this.name = 'MyError' }
        }
        var plain = new Error('plain');
        var typeError = new TypeError('kind');
        var called = Error('called');
        var sub = new MyError('boom');
        var reflected = Reflect.construct(Error, ['made'], MyError);
        return JSON.stringify({
          plain: plain.stack,
          typeError: typeError.stack,
          called: called.stack,
          sub: sub.stack,
          reflected: reflected.stack,
          names: { plain: plain.name, typeError: typeError.name, sub: sub.name },
          subclass: sub instanceof MyError && sub instanceof Error,
          reflectedSubclass: reflected instanceof MyError && reflected instanceof Error
        });
      })()`,
    )
    // The subclass fix routes construction through Reflect.construct inside an
    // eval-generated wrapper. Neither the wrapper frame (`at Error (<input>...)`)
    // nor the `construct (native)` trampoline exists in a real V8 stack, so a
    // sample reading `.stack` could fingerprint the sandbox.
    for (const [label, stack] of Object.entries({
      plain: value.plain,
      typeError: value.typeError,
      called: value.called,
      sub: value.sub,
      reflected: value.reflected,
    })) {
      assert.doesNotMatch(stack, /construct \(native\)/, `${label}: native trampoline frame leaked`)
      assert.doesNotMatch(stack, /<input>/, `${label}: eval-generated wrapper frame leaked`)
      assert.doesNotMatch(stack, /ai4r-internal/, `${label}: internal frame leaked`)
      assert.doesNotMatch(stack, /\/Users\/|file:\/\/|node_modules/, `${label}: host path leaked`)
      assert.doesNotMatch(
        stack,
        /at (?:Error|TypeError|MyError) \((?:native|<input>)/,
        `${label}: error-constructor host frame leaked`,
      )
      // Legitimate guest frames and their file:line:column survive.
      assert.match(stack, /https:\/\/[^\s()]+:\d+:\d+/, `${label}: guest frames were dropped`)
    }
    // A plain error starts at the guest call site, not at a wrapper frame.
    assert.match(value.plain.trim().split('\n')[0], /^\s*at https:\/\/[^\s()]+:\d+:\d+$/)
    assert.equal(value.names.plain, 'Error')
    assert.equal(value.names.typeError, 'TypeError')
    assert.equal(value.names.sub, 'MyError')
    assert.equal(value.subclass, true)
    assert.equal(value.reflectedSubclass, true)
  } finally {
    sb.dispose()
  }
})

test('an injected overlay is real mutation evidence, not payload text', async () => {
  const sb = await sandbox()
  try {
    const markup = '<div id="helios-overlay">SECRET-PAYLOAD</div>'
    const { value, run } = await probe(
      sb,
      `(function () {
        var overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.innerHTML = ${JSON.stringify(markup)};
        overlay.setAttribute('aria-hidden', 'false');
        overlay.classList.add('helios');
        var input = document.createElement('input');
        input.type = 'password';
        overlay.appendChild(input);
        document.body.appendChild(overlay);
        return JSON.stringify({
          ownKeys: Object.keys(overlay).length,
          ownNames: Object.getOwnPropertyNames(overlay).length,
          children: overlay.children.length,
          attached: document.body.contains(overlay)
        });
      })()`,
    )

    // Fidelity first: tracing must not add an own property to an instance.
    assert.equal(value.ownKeys, 0, 'Object.keys(element) stays empty')
    assert.equal(value.ownNames, 0, 'no own property name appears on the element')
    assert.equal(value.children, 1)
    assert.equal(value.attached, true)

    const mutations = (run.events ?? []).filter((event) => event.kind === 'dom' && event.op)
    const ops = mutations.map((event) => event.op)
    for (const op of ['set innerHTML', 'setAttribute', 'classList.add', 'appendChild']) {
      assert.ok(ops.includes(op), `${op} must be recorded: ${ops.join(',')}`)
    }
    const append = mutations.find((event) => event.op === 'appendChild' && event.tag === 'body')
    assert.ok(append, 'the overlay is appended to the body')
    assert.equal(append.child, 'div')
    assert.equal(append.actor, 'sandbox', 'the guest made this change, not the platform')

    // Payload bounds: tag, operation, attribute name and a text length only.
    assert.doesNotMatch(JSON.stringify(mutations), /SECRET-PAYLOAD/, 'page text must not be traced')
    assert.doesNotMatch(JSON.stringify(mutations), /helios-overlay/, 'attribute values are not traced')
    for (const event of mutations) {
      assert.ok(String(event.tag).length > 0 && String(event.tag).length < 32, 'tag names are bounded')
      assert.equal(event.innerHTML, undefined)
      assert.equal(event.value, undefined)
    }

    // Attribution at the sandbox level: an inert run keeps the platform's own
    // installation announcement and collects no mutation evidence at all.
    const inert = await sb.run('var x = 1;', { level: 'off' })
    assert.equal(inert.ok, true)
    assert.deepEqual((inert.events ?? []).filter((event) => event.kind === 'dom' && event.op), [])
    assert.ok((inert.events ?? []).some((event) => event.api === 'document.installed'))
    assert.equal(inert.disposal.ok, true, JSON.stringify(inert.disposal))
  } finally {
    sb.dispose()
  }
})
