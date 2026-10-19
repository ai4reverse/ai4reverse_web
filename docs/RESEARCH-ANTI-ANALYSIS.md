# Anti-Analysis in Malicious JavaScript: What Real Droppers Check, and What a Traceless Sandbox Must Emulate

Scope: this brief covers client-side JavaScript loaders, droppers and challenge scripts that decide *whether to run at all* based on the runtime they observe. It maps each detection family to the observable that betrays a fake environment and to a concrete sandbox requirement. It closes with a P0/P1/P2 checklist keyed to the intended module paths (`tools/sandbox/env/*.js`, `tools/invocation/stealth.js`, `tools/sandbox/integrity.js`, `tools/instrumentation/*.js`).

Labels: **[direct]** = stated by the cited source; **[interp]** = my reading of source code or spec behaviour; **[inference]** = my engineering conclusion for this platform.

---

## 0. The decision function being defended against

Malware does not "detect sandboxes" as a goal; it computes a boolean and branches. The branch is asymmetric: a false "analysis" verdict costs the attacker nothing (serve a 404, sleep 30 minutes, return benign filler), while a false "clean" verdict on a real analyst host costs a burned campaign. Therefore **one leaked signal is enough to end a run** — partial stealth has the same value as none.

Three consequences drive the requirements below:

1. **Negative capability beats fabrication.** Every API the sandbox invents is a new surface where implementation must match a specific browser build. Absence is only safe if the claimed profile genuinely lacks the API.
2. **The environment is one fingerprint, not a bag of values.** UA, `navigator.platform`, `userAgentData`, screen geometry, timezone, `Intl` defaults, WebGL vendor/renderer, font metrics and feature availability are mutually constrained. Hardcoding each surface independently is the most common way fake environments fail.
3. **Semantics leak as loudly as values.** Whether a property is an accessor on a prototype or a data property on an instance, whether `toString()` yields `[native code]`, whether `stack` has column numbers, whether an error's frame count is 4 or 5 — these are engine-shape facts that a value-only emulator gets wrong.

---

## 1. Headless / automation detection

**Description.** The oldest and still most common family: cheap property probes for WebDriver and for Chromium's automation surface. `navigator.webdriver` is `true` under `--enable-automation`, `--headless`, or `--remote-debugging-port=0` [direct, MDN]. The classic catalogue (headless UA containing `Headless`, empty `navigator.plugins`/`mimeTypes`, missing `window.chrome`, contradictory permission state, zero `outerWidth`/`outerHeight`, empty `navigator.languages`, zero `navigator.connection.rtt`, zero `MouseEvent.movementX`) is maintained in [infosimples/detect-headless](https://github.com/infosimples/detect-headless).

A second, sharper class targets the protocol rather than the browser: Chrome's `Runtime.enable` causes `Runtime.consoleAPICalled`, and delivering that event requires V8 to *serialize* the logged object — which invokes in-page getters. DataDome's published probe installs a getter on `Error.prototype.stack` and calls `console.debug(e)`; the getter firing proves an automation client is attached [direct, [DataDome](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/), [Rebrowser](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)].

```js
// composite headless probe (values omitted here are the real payload)
const bad = [];
if (navigator.webdriver) bad.push('webdriver');
if (!navigator.plugins || navigator.plugins.length === 0) bad.push('plugins');
if (!window.chrome || !window.chrome.runtime) bad.push('chrome.runtime');
if (outerWidth === 0 || outerHeight === 0) bad.push('outer');
if (!navigator.languages || !navigator.languages.length) bad.push('languages');
```

```js
// CDP attachment probe: the getter only runs if something serializes the object
let hit = false;
const e = new Error();
Object.defineProperty(e, 'stack', { get() { hit = true; return ''; } });
console.debug(e);
if (hit) { /* automation client attached */ }
```

```js
// permission cross-check: two code paths must agree
const viaApi = (await navigator.permissions.query({ name: 'notifications' })).state;
// real browser: Notification.permission === 'denied' implies viaApi === 'denied'
if (Notification.permission === 'denied' && viaApi === 'prompt') { /* headless */ }
```

**Exact observable that reveals a fake.** Not the values — the *descriptors*. In a real browser `webdriver`, `plugins`, `languages` and `hardwareConcurrency` are accessors on `Navigator.prototype`; an emulator that assigns them produces `navigator.hasOwnProperty('webdriver') === true` and `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver') === undefined`. CreepJS documents exactly this class of tell for `hardwareConcurrency`: the native descriptor lookup returns `undefined`, and any `defineProperty` on the instance leaves a detectable residue [direct, [creepjs discussion #149](https://github.com/abrahamjuliot/creepjs/discussions/149)]. Second observable: `Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get.toString()` must be `function get webdriver() { [native code] }`.

**Sandbox requirement.**
- *Emulate, correctly shaped:* WebDriver-relevant properties as **accessors on the prototype**, with the engine's native-function stringification, non-enumerable, `configurable: true`, getter name `get webdriver`.
- *Leave absent:* every CDP artefact. There must be no console-to-host serialization path, no `console.debug` side effect on object graphs, no `Runtime.*` equivalent. If the host bridge logs guest objects, it must snapshot primitives only.
- *Consistency invariant:* `Notification.permission`, `navigator.permissions.query({name:'notifications'})`, `window.chrome` presence, plugin/mimeType counts, and `outerWidth/Height` are all functions of the single profile, not independent constants.

---

## 2. VM / emulator detection (engine identity)

**Description.** This family attacks the *language implementation*, and it is the hardest to satisfy for a QuickJS-based sandbox because it compares against V8 grammar rather than against values.

(a) **`Function.prototype.toString` brand.** Built-ins stringify to a *native function string* — `function someName() { [native code] }` — while user functions return the exact source text segment [direct, [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/toString)]. TC39's implementation-hiding proposal documents why the marker is load-bearing: source visibility is treated as an information leak [direct, [tc39/proposal-function-implementation-hiding](https://github.com/tc39/proposal-function-implementation-hiding)].

```js
Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL);
// real: "function toDataURL() { [native code] }"
// JS reimplementation: "function toDataURL() { return this._impl.toDataURL(); }"
```

(b) **Global-object recovery.** `Function('return this')()` must be the same object as `window`, `globalThis`, `self` and `this` at top level; the standard variant `(function(){return this}).constructor('return this')()` bypasses a shadowed global name. In a realm with eval disabled this throws, which is itself a verdict.

(c) **Stack shape.** V8 frames carry column numbers (`at f (file.js:1:2)`) and the string is headed by `Error: message`; engines differ, and the format is not standardised [direct, [MDN Error.stack](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/stack)]. Detection code turns this into a *count assertion*:

```js
Error.stackTraceLimit = 10;
try { Array.prototype.join.apply(); } catch (e) {
  return e.stack.split('\n').length !== 4;   // exact frame count expected
}
```
[direct, [TamperDetectJS index.html](https://github.com/hrt/TamperDetectJS/blob/main/index.html)]

(d) **Timing.** `debugger` is a no-op without an attached debugger, so `performance.now()` before/after it is a DevTools oracle (threshold ~100 ms); a subtler variant watches inter-invocation deltas of a `setInterval` and gates on `document.hasFocus()` to exclude tab throttling [direct, [USENIX Sec '21, Musch & Johns](https://www.usenix.org/system/files/sec21-musch.pdf), techniques MONBREAK / NEWBREAK]. Busy-loop calibration (e.g. 1e6 iterations must take >0.5 ms and <20 ms) is used to separate JIT-compiled V8 from interpreters and from emulators with different timer resolution [interp].

(e) **Intrinsic integrity.** Descriptor flags, `Object.getOwnPropertyNames(Function.prototype)`, `Object.prototype.toString.call(x)` brand strings, and the strict-mode poison pills: `Function.prototype.caller` / `.arguments` throw `TypeError` for strict functions and for natives [direct, [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Deprecated_caller_or_arguments_usage)].

(f) **Cross-realm identity.** A same-origin iframe gets its own intrinsics, so `iframe.contentWindow.Array !== Array` and `iframe.contentWindow.Array.isArray([]) && !([] instanceof iframe.contentWindow.Array)` both hold in a browser [interp — standard realm semantics; see [MDN instanceof](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof)]. An emulator with a single realm returns the browser-impossible `true` for the second expression.

```js
const w = document.createElement('iframe'); document.body.appendChild(w);
const A = w.contentWindow.Array;
[[] instanceof A, A === Array];      // browser: [true, false]; single-realm fake: [false, true] or [true, true]
```

**Exact observable.** `Function.prototype.toString.call(someBuiltin) === 'function name() { [native code] }'` fails first and cheapest; then `e.stack.split('\n').length`; then `[] instanceof iframeArray`. Any one of these is decisive on its own.

**Sandbox requirement.**
- *Emulate:* a native-brand layer where every builtin the guest can reach stringifies to the exact engine grammar, with the getter/setter naming convention (`get x()`/`set x()`), for `Function.prototype.toString` *and* for `Object.getOwnPropertyDescriptor(...).get.toString()`. Fresh realm per iframe with independent intrinsics.
- *Leave absent:* `Error.captureStackTrace` and `Error.stackTraceLimit` only if the claimed engine lacks them — but if the profile claims Chrome, they must exist and behave (limit truncation, `prepareStackTrace` hook).
- *Consistency invariant:* stack grammar, frame counts, and `toString` grammar are produced by one formatter keyed to the claimed browser build; timing resolution matches the claimed engine; busy-loop cost is within the claimed engine's band.

---

## 3. Fingerprint coherence

**Description.** Rather than one probe, this is the cross-product of cheap contradictions. Malware rarely needs canvas hashing to catch an emulator; the cheap set is enough:

| Surface A | Surface B | Contradiction that convicts |
|---|---|---|
| `navigator.userAgent` (`Windows NT 10.0`) | `navigator.platform` (`Linux x86_64`) | OS mismatch |
| `navigator.userAgentData.platform` | `navigator.platform` | Chromium's own two answers disagree |
| `screen.width/height` | `window.outerWidth/outerHeight`, `devicePixelRatio` | 0-size window, DPR 1 on a claimed Retina display |
| `Date.prototype.getTimezoneOffset()` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | offset ≠ zone (e.g. offset 0 with `America/New_York`) |
| `navigator.language` | `Intl.NumberFormat().resolvedOptions().locale` | `en-US` vs `en`/`und` |
| claimed GPU vendor | `WEBGL_debug_renderer_info` `UNMASKED_RENDERER_WEBGL` | software rasteriser behind a desktop UA |
| claimed OS | `document.fonts.check('12px "Segoe UI"')`, text-metric widths | font set of a different OS |

The WebGL case is well documented: headless Chrome without a GPU falls back to SwiftShader and reports `Google SwiftShader` / `ANGLE (Google, Vulkan ... SwiftShader)` through `UNMASKED_VENDOR_WEBGL`/`UNMASKED_RENDERER_WEBGL`, which is an immediate mismatch against any consumer-GPU claim [direct, [Chromium issue 40277080](https://issues.chromium.org/issues/40277080); [interp] the vendor string naming convention]. Canvas/WebGL pixel hashing as a *coherence* signal (not just an ID) follows the original canvas-fingerprinting work [direct, [Pixel Perfect, W2SP '12](https://www.ieee-security.org/TC/W2SP/2012/papers/w2sp12-final4.pdf)].

Also in this family: capability-shape contradictions. `navigator.getBattery` exists only in secure contexts in Chromium and is absent in Firefox [direct, [Chrome 103 deprecations](https://developer.chrome.com/blog/deps-rems-103), [MDN getBattery](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getBattery)]; `navigator.connection`, `speechSynthesis.getVoices()`, `DeviceOrientationEvent`, `TouchEvent` and `RTCPeerConnection` have Chromium-specific shapes that Akamai's sensor probes directly [direct, [azerpas/detect-headless](https://github.com/azerpas/detect-headless) reproduces the bmak.js probe list]. `hardwareConcurrency` returning `0` or `undefined` is a classic VM tell.

**Exact observable.** A derived value disagreeing with another derived value. The conviction is not "this value is unusual" but "these two values cannot both be true in one browser".

**Sandbox requirement.**
- *Emulate:* one `profile` record (UA, UA-CH brands, platform, screen, DPR, tz, locale, GPU strings, font set, feature flags) from which **every** surface is computed. Never hardcode two surfaces independently.
- *Leave absent:* APIs not in the profile's feature set; do not ship `navigator.connection` on a Firefox profile, do not ship `getBattery` on a non-secure context.
- *Consistency invariant:* an assertion suite that fails the build when any pair in the table above disagrees, plus determinism: canvas/audio/WebGL hashes stable within a profile and different across profiles.

---

## 4. Honeypot / analysis-farm detection

**Description.** Farms and honeyclients leak *host* artefacts into the page, and malware enumerates for them. The list is not folklore; it is in shipping sensor code: `_phantom`, `callPhantom`, `domAutomation`, `$cdc_asdjflasutopfhvcZLmcfl_`, `document.documentElement.getAttribute('webdriver'|'driver'|'selenium')`, `window.Buffer`, `window.spawn`, `window.ActiveXObject`, `window.opera`, `window.emit` [direct, [azerpas/detect-headless](https://github.com/azerpas/detect-headless)]. Nightmare's `__nightmare`, Playwright's `__pwInitScripts`/`__playwright__binding__`, and Selenium's `_Selenium_IDE_Recorder`/`__webdriver_evaluate` belong to the same enumeration; the merged-name scan plus a prefix scan over `Object.keys(window)` for `cdc_`, `$cdc_`, `puppeteer_` is the standard shape [interp from the same catalogue].

Monkeypatch detection is the second prong, and it is where naive "stealth scripts" die:

```js
// identity vs pristine reference from a throwaway realm
const iframe = document.createElement('iframe');
document.body.appendChild(iframe);
iframe.contentWindow.fetch === window.fetch;   // false => window.fetch was patched

// recursive brand check: toString must itself be native
Array.prototype.join.toString.toString() === 'function toString() { [native code] }';
Array.prototype.join.toString.name.includes('bind');        // bind-wrapped fake
Object.getOwnPropertyDescriptor(Array.prototype.join, 'toString') !== undefined;
'prototype' in Array.prototype.join;                        // JS functions have one, natives don't
```
[direct, [TamperDetectJS](https://github.com/hrt/TamperDetectJS/blob/main/index.html); [mmazzarolo](https://mmazzarolo.com/blog/2022-07-30-checking-if-a-javascript-native-function-was-monkey-patched/) documents the bind/Proxy escape hatches and the strict-reference countermeasure]

Third prong: instrumentation via caller introspection. `arguments.callee.caller` (sloppy mode only), `fn.caller`, and stack depth deltas detect a wrapper sitting between the probe and the builtin.

**Exact observable.** Presence of a global that no browser defines; identity inequality against a pristine realm; a JS function where the engine should have a native (`'prototype' in fn`); an extra stack frame between two adjacent calls.

**Sandbox requirement.**
- *Emulate:* a browser-accurate, **closed** global surface: exact key set and enumeration order, no host names (`Buffer`, `process`, `require`, `module`, `spawn`, `global`, `__dirname`). Remove `documentElement` attributes; no `window.external` unless the profile is old IE.
- *Leave absent:* `_phantom`, `callPhantom`, `__nightmare`, `domAutomation*`, all driver-prefixed names. There is no reason for our runtime to define any of them, so this is a boot-time deny-list scan, not emulation.
- *Consistency invariant:* every guest-visible builtin is engine-level (native brand), never a JS wrapper or Proxy; hooks live below the language. A wrapper is not "undetectable if well written" — the stack-frame and `prototype` checks above catch every JS-level wrapper.

---

## 5. Evasion of instrumented runtimes

**Description.** The strongest in-the-wild example is documented in the Akamai XP1M teardown: the script **reads its own text via `Function.prototype.toString()`**, takes a MurmurHash3 over a ~30 KB slice, and **uses that hash to key the decoder** for every string and constant. Reformat, rename, or inject one byte inside the hashed function and the codec yields wrong strings; since some decoded strings are used as *method selectors*, the next call throws `TypeError: ... is not a function`. The author confirms the same failure by pretty-printing and loading in a stock browser [direct, [akamai-xp1m-teardown](https://onewinged-shunkaido.github.io/akamai-xp1m-teardown/#25-the-decoder-is-keyed-to-a-hash-of-the-scripts-own-text)].

Related evasions:

- **Eval/wrapper frames in stacks.** Generated wrappers appear as `at eval (eval at <anonymous> (file.js:1:1), <anonymous>:1:1)`; probes that stringify an error and look for `eval`, `apply`, or a missing native signature catch them (TamperDetectJS `check_stack_3`, `check_stack_4_toString`).
- **`Error.prepareStackTrace`.** V8's CallSite API exposes `getFileName`, `getLineNumber`, `getEvalOrigin`, `isNative`, `getFunction`; a detector can use it to identify synthetic frames and to reach the *function object* behind a frame [interp; the API is V8-specific].
- **Proxy traps.** The ECMAScript design deliberately declines to provide `isProxy`, on transparent-virtualization grounds [direct, [TC39 reflection API design note](https://archives.ecma-international.org/2012/TC39/tc39-2012-007.pdf)]. Transparent from the object's own perspective — but not from the stack: a proxy that wraps a native still produces frames and, on some paths, a `Proxy.toString` frame [direct, TamperDetectJS stack checks]. Node additionally exposes `util.types.isProxy`; that must never be reachable from guest code.
- **Interceptor detection by reference.** Holding the original function reference before any other script runs and comparing later defeats every `toString` trick, because Proxy cannot trap `===` [direct, mmazzarolo].

**Exact observable.** `Function.prototype.toString` of the target's own function returning anything other than the delivered bytes; a stack frame inside the sandbox between guest frames; `Function.prototype.toString` of a builtin returning source text instead of `[native code]`.

**Sandbox requirement.**
- *Invariant (hard):* **the guest executes the pristine, unmodified bytes**; any transformation used for analysis (Babel deobfuscation, JSVMP rewriting) is applied to a *copy* and never to the text the guest can stringify. If the pipeline must rewrite before execution, `Function.prototype.toString` must be answered from the original source buffer, keyed by function identity — and that mapping must survive `bind`/closure creation.
- *Emulate:* a stack formatter with no sandbox-originated frames; `Error.prepareStackTrace` (if the profile claims V8) returning CallSites with plausible `getFileName`/`getEvalOrigin`, and `isNative()` true for natives.
- *Leave absent:* any guest-visible hook object, `util.types`, and any JS-level Proxy wrapper around a builtin.
- *Consistency invariant:* `toString(fn)` byte-equals the delivered script slice for every function created from it; instrumentation must be provably invisible under the TamperDetectJS check set.

---

## 6. JSVMP in the wild

**Description.** Two dispatch architectures show up in commercial protections and, increasingly, in loaders.

**Register machine (Kasada-style, `ips.js`).** A `var n = [1, {h,M,$,g,j,O}, …]` state array where slot 0 is the instruction pointer; opcodes are multi-byte with inline operands; opcode 50 defines a bytecode function (and sets `length`/`name` via `Object.defineProperty`), opcode 23 calls it, 48/49 return, `0x27`/`0x28` are conditional jumps that write the instruction pointer into `state[0]`. Call/return is implemented by *overwriting the VM state object*, with `arguments` used as the argument vector [direct, [sneakerdev, part 2](https://www.sneakerdev.com/blog/devirtualizing-nikecoms-bot-protection-part-2)].

**Stack machine (Akamai V3, XP1M).** An operand stack on the VM instance, a constant array, and a dispatch loop over decoded opcodes; every primitive operation funnels through a single one-line helper (`X(a,b)=a+b`, `B2 = nB.apply(this[p8].J, sj.reverse())` for CALL), so a breakpoint lands on the helper definition rather than the logical operation [direct, akamai teardown §2.1–2.4].

```js
// canonical dispatch shape (either architecture)
while (running) {
  var op = code[pc];                    // often: code[pc] ^ prevOp  (chained decoding)
  switch (decode(op)) {
    case 0x17: /* JUMP IF FALSE: pc = code[++pc] or fallthrough */ break;
    case 0x2a: /* CALL: argcv = stack.pop(); fn = stack.pop(); ... */ break;
    ...
  }
}
```

**Opcode encoding, in the wild.** Bytecode is an encrypted number array with a length-derived splice of the string section (`stringIndex = bc[len-1] ^ len`) [direct, Kasada]; constants are packed as bit-strings and rebuilt as IEEE-754 by a hand-rolled float reader, avoiding `DataView`/`Float64Array` entirely [direct, Akamai]; per-build handler shuffling and per-build identifier rotation (`UF(); PIC(); xWC();` init triplet) make static matching useless across builds [direct, Akamai §2.1, §6].

**Why tracing must not alter stack or scope.** Three independent reasons, all observable by the target:
1. The VM's own control flow reads `arguments`, `this`, and `Function.prototype.length/name` (Kasada's function-definition opcode writes both). A JS wrapper changes `arguments` identity and breaks `new (Function.bind.apply(t, r))`-style construction (Kasada opcode 24).
2. Integrity checks read `Error().stack` and `Function.prototype.toString` of interpreter internals; an inserted frame or a monkeypatched `toString` is the detection, and (per Akamai) the failed hash silently produces wrong *method selectors*.
3. Timing: a trace sink per instruction shifts the deltas that the payload measures and reports (Akamai ships `Date.now()` deltas across deferred phases as sensor fields).

**What a devirtualizer recovers from dispatch traces.** Per-instruction records `(pc, raw opcode, decoded op, operand reads, stack/register state before-after, branch taken)` are sufficient to recover: handler semantics (a generic helper becomes legible once you see it at each call site), function boundaries and the branch graph (recursive traversal), the constant/string table, and finally lifted IR → pseudocode. Kasada's disassembler recovers 186,690 of 187,426 instructions this way, leaving only unreachable bloat [direct, sneakerdev].

**Sandbox requirement.**
- *Emulate:* nothing here — JSVMP is not an environment check.
- *Leave absent:* any guest-visible trace buffer, counter, or object retained across steps.
- *Invariants:* (i) tracing hooks sit at the engine/handler boundary, never as guest JS wrappers, so no frame is added; (ii) the tracer never calls back into guest code mid-step (re-entering the dispatcher corrupts VM state); (iii) guest handles are released each step and the clock is frozen during tracing so per-instruction overhead is not observable; (iv) the trace schema is replayable, so semantic recovery can be done offline (static re-derivation) rather than by a second instrumented run.

---

## 7. Prioritised checklist

**P0 — a leak here ends every run.**

| # | Requirement | Module |
|---|---|---|
| P0.1 | Single profile record is the only source of UA/UA-CH/platform/screen/DPR/tz/locale/GPU/fonts/features; all surfaces derived | `tools/sandbox/env/profile.js`, `tools/sandbox/env/index.js` |
| P0.2 | Closed global surface: exact key set + enumeration order, zero host leakage (`Buffer`, `process`, `require`, `module`, `spawn`, `global`), no `documentElement` driver attributes | `tools/sandbox/env/globals.js`, `tools/sandbox/integrity.js` |
| P0.3 | Native brand: every guest-visible builtin is engine-level and stringifies to `function name() { [native code] }`; descriptors live on prototypes, never instances | `tools/sandbox/integrity.js`, `tools/sandbox/env/native-brand.js` |
| P0.4 | Stack fidelity: one formatter reproduces the claimed engine's grammar (header, columns, frame count, `stackTraceLimit`, `prepareStackTrace`), with no sandbox frames | `tools/sandbox/env/stack.js` (via `integrity.js`) |
| P0.5 | Pristine-source execution: guests stringify the delivered bytes; instrumentation never rewrites executed text; hooks sit below the language | `tools/instrumentation/loader.js`, `tools/sandbox/integrity.js` |
| P0.6 | No JS wrappers/Proxies around guest-visible builtins; `fn.caller`/`fn.arguments` poison-pill behaviour preserved | `tools/instrumentation/hooks.js`, `tools/invocation/stealth.js` |
| P0.7 | Absence policy + feature gating: unimplemented WebGL/audio/RTC/battery/connection/speech APIs are absent *and* the profile does not claim them | `tools/sandbox/env/features.js` |
| P0.8 | Deterministic virtual clock + PRNG with claimed timer resolution; no debugger pauses; busy-loop cost inside the claimed engine band | `tools/sandbox/env/time.js`, `tools/invocation/stealth.js` |
| P0.9 | Differential gate: detector corpus (TamperDetectJS checks, detect-headless probes, CDP getter probe, creepjs-style descriptor checks) must produce zero divergences against a captured real-browser baseline | `tests/` (harness consuming `integrity.js`) |

**P1 — needed for any target that fingerprints beyond the cheap set.**

| # | Requirement | Module |
|---|---|---|
| P1.1 | Fresh realm per iframe: independent intrinsics, cross-realm `instanceof` false, pristine reference available for lie detection | `tools/sandbox/env/realm.js` |
| P1.2 | Async-surface coherence: `permissions.query` vs `Notification.permission` vs `localStorage`/`indexedDB` presence | `tools/sandbox/env/permissions.js` |
| P1.3 | Deterministic canvas/WebGL/audio hashes derived from profile, stable per profile, distinct across profiles; GPU strings never software-rasteriser strings when a discrete GPU is claimed | `tools/sandbox/env/canvas.js`, `env/webgl.js`, `env/audio.js` |
| P1.4 | Font enumeration and text metrics consistent with the claimed OS (including `document.fonts.check`) | `tools/sandbox/env/fonts.js` |
| P1.5 | Probe-observation channel: record *which* properties are read in what order, without getters that change descriptor shape or timing | `tools/sandbox/integrity.js`, `tools/instrumentation/observer.js` |
| P1.6 | JSVMP dispatch trace: engine-level, frame-free, replayable; no guest re-entry during a step | `tools/instrumentation/dispatch-trace.js`, `tools/jsvmp/*` |
| P1.7 | `Error.prepareStackTrace` CallSite surface with plausible `getFileName`/`getEvalOrigin`/`isNative` | `tools/sandbox/env/stack.js` |

**P2 — behavioural and long-tail.**

| # | Requirement | Module |
|---|---|---|
| P2.1 | Behavioural surface: nonzero pointer deltas, `document.hasFocus()`, rAF cadence, `isTrusted` events, visibility state | `tools/invocation/stealth.js` |
| P2.2 | Farm-honeypot coherence: `navigator.plugins` shape, `window.chrome.runtime` presence, `window.external` only for legacy profiles | `tools/sandbox/env/globals.js` |
| P2.3 | Host-bridge hygiene: no object serialization on any guest console call; bridge errors must not surface as guest frames | `tools/invocation/stealth.js`, `tools/sandbox/integrity.js` |
| P2.4 | Per-build recalibration tooling: capture real browser surfaces, diff against sandbox, update profile fixtures | `tools/sandbox/env/profile.js`, `tests/fixtures` |

---

## Contradictions and uncertainties

- **Plugins/mimeTypes.** The classic claim "headless has zero plugins" is stale for modern Chrome, which ships bundled PDF-viewer entries in headful builds. The safe requirement is not "zero" or "five" but "the count and entries match the captured build" — recorded, not asserted from a blog post.
- **`navigator.getBattery`.** Chromium removed it only on insecure origins (Chrome 99/103 deprecations), not platform-wide; Firefox never shipped it. Emulating it unconditionally is a tell.
- **Stack-format citations.** MDN states the format is implementation-specific; exact frame counts in TamperDetectJS are *Chromium-specific assertions*. Any sandbox stack formatter must be calibrated against a capture, not against the check code.
- **QuickJS specifics.** I could not retrieve QuickJS source in this session to quote its `Error.stack` and native-`toString` grammar; the claim that a stock QuickJS stack (`at <eval> (...)` frames without column numbers) differs from V8 is therefore **[inference]**, high prior but unverified here. Treat P0.4 as requiring an empirical capture before it is considered satisfied.

## Missing evidence

- No verified count/order baseline for `Object.keys(window)` in the target browser build (needed for P0.2).
- No measured busy-loop timing band for V8 vs QuickJS on this hardware (needed for P0.8).
- SocGholish's specific fingerprint gates (screen size, hover, mouse movement) are reported by vendor advisories [e.g. [Eventus advisory](https://advisory.eventussecurity.com/advisory/socgholish-fake-update-supply-chain-enables-ransomware-access/)] rather than by a published sample analysis I could read in full; treat as corroboration, not as a specification.
- No public, verifiable source for how common JSVMP is in *malicious* (vs anti-bot) loaders specifically; the two authoritative architectures I could document are commercial anti-bot sensors.

## Sources

- Kept: MDN `Navigator.webdriver` (https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver) — normative conditions for the flag.
- Kept: Rebrowser, Runtime.enable detection (https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries) — mechanism + why JS-level patches fail.
- Kept: DataDome, CDP signal (https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/) — origin of the getter-serialization probe.
- Kept: USENIX Security '21, Musch & Johns (https://www.usenix.org/system/files/sec21-musch.pdf) — peer-reviewed catalogue of `debugger`/timing DevTools oracles, prevalence data.
- Kept: hrt/TamperDetectJS (https://github.com/hrt/TamperDetectJS) — executable list of monkeypatch/proxy tells incl. exact stack-count assertions.
- Kept: mmazzarolo (https://mmazzarolo.com/blog/2022-07-30-checking-if-a-javascript-native-function-was-monkey-patched/) — toString/bind/Proxy escapes and the reference-equality counter.
- Kept: azerpas/detect-headless (https://github.com/azerpas/detect-headless) — Akamai bmak.js probe list (host globals, documentElement attributes, feature probes).
- Kept: infosimples/detect-headless (https://github.com/infosimples/detect-headless) — headless property checklist incl. permissions contradiction.
- Kept: akamai-xp1m-teardown (https://onewinged-shunkaido.github.io/akamai-xp1m-teardown/) — self-`toString`+MurmurHash decoder keying, generic-helper dispatch, out-of-band analysis argument.
- Kept: sneakerdev Kasada devirtualization pt.2 (https://www.sneakerdev.com/blog/devirtualizing-nikecoms-bot-protection-part-2) — concrete register-VM opcode semantics and disassembly coverage numbers.
- Kept: MDN `Function.prototype.toString` — native function string grammar.
- Kept: TC39 reflection API design note (https://archives.ecma-international.org/2012/TC39/tc39-2012-007.pdf) — why `isProxy` does not exist.
- Kept: Chromium issue 40277080 (https://issues.chromium.org/issues/40277080) — SwiftShader WebGL fallback.
- Kept: MDN deprecated `caller`/`arguments` — poison-pill semantics.
- Deprioritized: several SEO-styled "browser check" sites (creepjs clones, cdpfleet, liaris, clearcote, kitsune, ipasis) — useful vocabulary, no primary evidence; replaced with the detector source and vendor writeups above.
- Deprioritized: `feder-cr/invisible_playwright` wiki — accurate-sounding but a secondary restatement of creepjs/Rebrowser; used only for cross-checking phrasing.

## Next steps

1. Capture a real Chrome (this platform's target build) surface dump: `Object.keys(window)` order, descriptor table for `Navigator.prototype`/`Function.prototype`, `Error.stack` samples at three depths, native `toString` strings — freeze as fixtures for P0.2–P0.4.
2. Measure QuickJS `Error.stack` and native `toString` output directly to convert the P0.4 inference into evidence.
3. Measure busy-loop and timer-resolution bands on V8 vs QuickJS for the P0.8 band.
4. Run TamperDetectJS plus the CDP getter probe against the sandbox as the P0.9 gate, and record the first divergence as the burn-down list.
