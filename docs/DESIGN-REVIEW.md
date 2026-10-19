# Design review record

Five independent read-only reviews were run against the finished tree. The
reviewers had no shell tool, so their findings were derived from source reading
and each carried a reproducer; every reproducer below was executed by the
supervisor, fixed where needed, and turned into a regression test. After all
dispositions the full suite is green: **361 tests, 0 failures**.

Legend: **Fixed** = code changed and a regression test covers it; **Accepted** =
documented limitation in README ("Known limitations") with the reason recorded.

## Review 1 — core sandbox / invocation / instrumentation / hooks

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1.1 | Blocker | `normalizeReturn` returned a bag-owned primitive handle, so the interpreter read a disposed value (`getSelection().toString()` etc.). | **Fixed** in `bridge.js`: primitives transfer out of the bag with `bag.keep`. Regression: "host callbacks may return plain primitives without use-after-free". |
| 1.2 | High | Splice after a semicolon-less directive prologue (`function f(){"use strict"⏎…}`) produced a SyntaxError. | **Fixed**: injected declarations/try-open are newline-prefixed (inside markers, so masking is unaffected). Regression: "a directive prologue without a semicolon still compiles". |
| 1.3 | High | Instrumentation channel was reachable via symbol enumeration on `document`. | **Fixed**: symbols are registered `ai4r.channel.*`, the anti-fingerprint filter hides every `ai4r.*` symbol on any target (including spread/`Object.assign` copies), and `Object.getOwnPropertyDescriptors` / `Reflect.ownKeys` are filtered. Regression: "document symbol enumeration is empty under the full environment" + platform-keys test. |
| 1.4 | Medium | Handle leaks in `api.js` key strings, `code.js` document handle (else branch), `bridge.setFunctionLength`, and a swallowed runtime-dispose failure. | **Fixed**: all temporaries disposed; `runtime.dispose()` returns `{ok,error}` and the sandbox records a failed disposal. |
| 1.5 | Medium | Guest-visible time advanced per interrupt, making it host-speed dependent. | **Fixed**: interrupts no longer advance the clock; the code channel calls `clock.tick(0.01)` per traced statement, so virtual time is a deterministic function of executed statements. `level:'off'` runs therefore observe a frozen clock (documented). |
| 1.6 | Medium | `code:before` was emitted twice (object payload + string pipeline). | **Fixed**: the instrumentation pipeline is the sole owner; the duplicate emit was removed. |
| 1.7 | Medium | `eval()` argument was round-tripped through the host, changing non-string argument identity. | **Fixed**: the channel returns the original handle and only summarises primitives/errors without dumping arbitrary objects. Regression: "direct eval preserves non-string argument identity". |
| 1.8 | Medium | Global `'*'` wildcard phase was rejected at registration. | **Fixed**: `normalizePhase('*')` accepted; regression test. |
| 1.9 | Low | `settle.pendingTimers` reported 0 when the timers module was excluded. | **Fixed**: falls back to `clock.pending()`. |
| 1.10 | Low | Injected binding name was a fixed `_$q`, readable by guest `eval`. | **Fixed**: binding derives from the run nonce (`_$q<base36 hash>`); regression test. |
| 1.11 | Low | Every wrapped-API argument was eagerly dumped (getter side effects, O(size)). | **Fixed**: only primitives are read; objects are described by type. |
| 1.12 | Low | `documentHandle` leaked in the no-document branch. | **Fixed** with `try/finally`. |

## Review 2 — restoration passes and JSVMP

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 2.1 | P1 | `eval-unwrap` parsed eval bodies with tolerant flags, splicing `return`/`await`/`super` out of illegal bodies and emitting non-parsing code. | **Fixed**: eval bodies parse with `allowReturnOutsideFunction:false` (Function bodies allow return but reject await/super/new.target), and the generated output is re-parsed by the pipeline. Regression: "eval bodies with illegal return/await/super are never spliced". |
| 2.2 | P1 | JSVMP instrumentation corrupted braceless dispatch loops, threw without an enclosing function binding, and destroyed directive prologues. | **Fixed**: `locateInterpreter` requires block bodies and computes post-directive offsets; `instrumentDispatch` refuses (unchanged source, `skipped` stats) without a function-scoped binding, newline-prefixes the binding, and counts only probes actually inserted. Regressions: "dispatch instrumentation tolerates empty/fall-through case labels" (now asserts refusal), "braceless dispatch loops are never spliced into". |
| 2.3 | P1 | Four passes could materialise `'use strict'` into a directive prologue (proxy-unwrap, jsfuck, dead-code, eval-unwrap decoders). | **Fixed**: shared `isDirectiveSlot` applied at all four sites. Regression: "passes never materialise a directive prologue" (four reproducers). |
| 2.4 | P1 | `rename` never ran when selected alone because it was deferred to a round that early-break skipped. | **Fixed**: the pipeline runs a deferred rename if it never ran. Regression: "rename runs even when it is the only selected pass". |
| 2.5 | P2 | Fold passes treated `with` scopes as unshadowed. | **Fixed**: `inWithScope` guards in strings/member-fold/constant-fold/eval-unwrap. Regression: "with-scope folds are refused". |
| 2.6 | P2 | `string-array` inlined reads that execute before the declaration. | **Fixed**: `isBeforeDeclaration` guard in both inliners. Regression: "string-array does not inline reads before the declaration". |
| 2.7 | P2 | `jsfuck` threw on assignment/update/delete targets, aborting the whole pass. | **Fixed**: mutation-target guard. Regression: "jsfuck leaves assignment targets alone and still folds siblings". |
| 2.8 | P2 | `analyzeVM` misclassified ordinary `switch` tables in loops as JSVMPs. | **Fixed**: detection now requires interpreter evidence (bytecode/stack/pc) plus an indexed discriminant. Regression: "ordinary switch tables in loops are not misclassified as VMs". |
| 2.9 | P2 | `jsfuck` had no evaluation budget. | **Fixed**: per-run node budget (20 000). |
| 2.10 | P2 | `instrumentDispatch` reported the declared case count even when the `analyzeVM` shape produced no probes. | **Fixed**: normalised case shape, counts inserted probes, refuses safely when no numeric body offset exists. |

## Review 3 — environment fidelity

P1 findings all fixed; P2 findings either fixed or explicitly accepted.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 3.1 | P1 | Platform objects exposed own enumerable state (`Object.keys(navigator).length ~30`, etc.). | **Fixed**: `prototypifySurfaces()` moves configurable own properties to a fresh prototype layer; API wrappers install on the owning prototype. Regression: "platform objects expose WebIDL-shaped own-property surfaces" (all counts 0). |
| 3.2 | P1 | `document`/`navigator` carried own brand symbol/constructor. | **Fixed**: brands live on an inserted prototype layer; `Object.getOwnPropertySymbols(document) === []`, `document.hasOwnProperty('constructor') === false`. |
| 3.3 | P1 | Per-instance state symbols were unregistered and enumerable. | **Fixed**: XHR/Fetch/WebSocket/canvas/storage use `Symbol.for('ai4r.*')`, hidden by the filter. Regression asserts `[]` symbols on XHR and canvas contexts. |
| 3.4 | P1 | Most platform objects had no `Object.prototype.toString` brand; elements reported `[object Object]`. | **Fixed**: brands for Screen/Location/History/Performance/Crypto/Navigator/HTMLDocument and per-tag element brands with `constructor` getters (HTMLDivElement, HTMLBodyElement, HTMLCanvasElement, …). |
| 3.5 | P1 | Chrome-only surfaces shipped on Firefox profiles and vice versa. | **Fixed**: `connection`/`getBattery`/`console.memory`/`webkitAudioContext`/`deviceMemory` gated to Chromium; `oscpu`/`buildID` gated to Gecko; service workers enabled for both; `msCrypto` removed. Regression: "browser-specific surfaces follow the claimed engine". |
| 3.6 | P1 | Offset-less date strings were parsed in the host timezone, not the profile timezone. | **Fixed**: constructor/`Date.parse` route offset-less ISO strings through profile-local arithmetic. Regression: DST test asserts `new Date('2026-10-19T15:20:00')` → 19:20Z for New York. |
| 3.7 | P1 | Fixed UTC offset paired with DST-aware ICU zone names produced impossible strings. | **Fixed**: offsets are computed per instant from host ICU tzdata (`tools/util/timezone.js`); `getTimezoneOffset`, local fields, `toString` label and zone name now agree across DST (New York 240/300; London BST). |
| 3.8 | P1 | WebGL `VENDOR`/`RENDERER` returned the unmasked profile strings. | **Fixed**: masked `WebKit`/`WebKit WebGL`; profile values only via `WEBGL_debug_renderer_info`; tests assert masked ≠ unmasked. |
| 3.9 | P1 | `document.lastModified` used locale display formatting. | **Fixed**: profile `lastModified` in the browser's fixed `MM/DD/YYYY HH:mm:ss` format. |
| 3.10 | P2 | `PermissionStatus.state` could be `'default'`. | **Fixed**: mapped to `'prompt'`. |
| 3.11 | P2 | Battery fields were mutually impossible. | **Fixed**: `charging ? 0 : Infinity` / `charging ? Infinity : dischargingTime`. |
| 3.12 | P2 | Storage quota counted keys, `estimate().usage` was constant 0. | **Fixed**: 5 MiB byte quota and live usage; regression in `tests/env-storage.test.js`. |
| 3.13 | P2 | Observers fire a synthetic entry with no mutation. | **Accepted** (documented): real DOM mutation plumbing would couple the observer module to every DOM mutator; delivered entries are coherent and bounded. |
| 3.14 | P2 | `document.fonts.check()` always true. | **Fixed**: checks the profile font set; unknown families return false. |
| 3.15 | P2 | `performance.mark()` returned an object and entries were unreachable. | **Fixed**: returns `undefined`, entries stored and retrievable. |
| 3.16 | P2 | `matchMedia` always false. | **Fixed**: width/height bounds, orientation, colour-scheme and reduced-motion evaluated. |
| 3.17 | P2 | `queueMicrotask` drained before promise jobs (inverted FIFO). | **Fixed**: enqueued through the guest promise queue. Regression: "queueMicrotask preserves promise-job FIFO order". |
| 3.18 | P2 | At-target capture listeners ran before earlier bubble listeners. | **Accepted**: matches the DOM spec's capture-then-target ordering; reviewer's Chrome observation was not reproduced. |
| 3.19 | P2 | `msCrypto` present. | **Fixed** (removed). |
| 3.20 | P2 | `TextDecoder` did not validate labels. | **Fixed**: Node validates, invalid labels throw `RangeError`. |
| 3.21 | P2 | `crypto.subtle` was partial. | **Accepted** (documented): `digest` is real (samples hash for keys/self-checks); AES/HMAC operations are not implemented and are reported as absent capabilities. |
| 3.22 | P2 | Canvas/img/audio elements lack full Node/Element methods; no `HTMLElement` globals. | **Accepted** (documented): tag brands and constructors exist; element factories are independent of the DOM node model. |
| 3.23 | P2 | `toBlob`/`res.blob()` produce plain objects. | **Accepted** (documented). |
| 3.24 | P2 | `structuredClone` collapses guest classes. | **Accepted** (documented). |
| 3.25 | P2 | Mobile profile mixed Pixel UA with iPhone metrics. | **Fixed**: Pixel-class 412×915 @2.625. |
| 3.26 | P2 | Media device labels were Windows-specific on every OS. | **Fixed**: per-OS labels. |
| 3.27 | P2 | `screenY` placed the window below the work area. | **Fixed**: 0 outside macOS. |

## Review 4 — analysis / report / CLI / logging

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 4.1 | P1 | CLI logs went to stdout (fd 1), breaking `--json` pipelines. | **Fixed**: CLI logger destination is fd 2 (plain and pretty); regression "cli keeps stdout parseable while logging to stderr". |
| 4.2 | P1 | Trace payload key `kind` overwrote the envelope, so hook IOCs were invisible. | **Fixed**: envelope is applied after the payload; `code-hook` uses `iocKind`; network payload uses `stage`. |
| 4.3 | P1 | Member accesses scored as suspicious-TLD domains (`window.top`, `document.body.style`). | **Fixed**: literal/comment mask + URL-context/standalone rules + JS object-head deny list. |
| 4.4 | P1 | IOC truncation flag was dropped by `mergeIocs`, and `sample.truncated` was hardcoded false. | **Fixed**: `merged.meta.truncated` propagates to `sample.truncated`. |
| 4.5 | P1 | `reducedBy` was a 0..1 fraction where the schema says bytes. | **Fixed**: bytes (and byte-based sizes); regression asserts > 1. |
| 4.6 | P2 | `maxIocBytes` was a dead option. | **Fixed**: maps to `maxLength`. |
| 4.7 | P2 | Report dropped artifact provenance. | **Fixed**: artifacts carry `source` (and `count` when > 1); regression. |
| 4.8 | P2 | `mergeIocs` injected undocumented `sources` everywhere. | **Fixed**: only when a value has ≥2 sources; regression. |
| 4.9 | P2 | Markdown escaping allowed HTML/link injection. | **Fixed**: `&`, `<`, `>`, backticks and brackets escaped. |
| 4.10 | P2 | Markdown rendered `[object Object]` for the failure path. | **Fixed**: dynamic errors are coerced to strings. |
| 4.11 | P2 | Exported `inferKillChain` was not composable with `summarizeBehavior`. | **Fixed**: accepts `apis` as well as `ranked`. |
| 4.12 | P2 | Malformed arguments/files exited 1 with stack traces. | **Fixed**: all parse/read/JSON/numeric failures become `UsageError` (exit 2). Regression: missing file, bad `--profile`, empty file. |
| 4.13 | P2 | `--events` ignored `--out` and mixed with `--json`. | **Fixed**: events go through the output sink; `--events --json` is a usage error. |
| 4.14 | P2 | `bin` symlink made the installed CLI a silent no-op. | **Fixed**: entry detection resolves the real path. |
| 4.15 | P2 | Restored-code comparison re-used the caller's sandbox and lost options. | **Fixed**: always a dedicated fresh sandbox with the same options/network/hooks, disposed in `finally`. |
| 4.16 | P2 | `analyzeSample` never disposed the sandbox it created. | **Fixed**: disposed after the dynamic/restored runs when the caller supplied none. |
| 4.17 | P2 | `base64` category kept undecoded alphanumeric runs. | **Fixed**: requires a successful decode or `+`/`/`/`=`. |
| 4.18 | P2 | Redaction depth-limited and one dead path. | **Fixed**: added `*.*.cookie/token/…`, `set-cookie`, `apiKey`, `session`, `jwt`. |
| 4.19 | P2 | Static IOCs were never extracted from restored code. | **Fixed**: restored source contributes IOCs tagged `source:'restored'`; regression. |
| 4.20 | P2 | Empty source crashed with a stack trace. | **Fixed**: usage error (exit 2). |

## Review 5 — evidence audit

The auditor worked statically (no shell) and correctly flagged that execution
evidence was missing at review time. Its material findings were addressed:

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 5.1 | P0 | No throw-site exception channel (`exception:throw`/`reportThrown` dead). | **Fixed**: `ThrowStatement` instrumentation + `reportThrown`; tests cover throw+catch hooks and `code:error`. |
| 5.2 | P0 | "295 tests, 0 failures" unproven. | **Fixed**: authoritative `pnpm test` → 336/336, recorded in `docs/VERIFICATION.md`. |
| 5.3 | P1 | Default API-hook observers unreachable for clipboard/media/beacon/subtle. | **Fixed**: those APIs are wrapped; regression "sensitive APIs reach api:before hooks". |
| 5.4 | P1 | `ast:transform` had no call site; `ast:enter` handler was a no-op. | **Fixed**: `restore()` runs `ast:transform` before passes; `ast:enter` counts identifiers/calls/members; tests added. |
| 5.5 | P2 | Empty-case JSVMP insertion could be a syntax error. | **Fixed** + regression. |
| 5.6 | P2 | Symbol leak via spread was unproven. | **Fixed/proven**: `Object.assign`/spread symbol probes are empty. |
| 5.7 | P3 | No test that entry-point stacks lack host frames. | **Fixed**: regression test. |

## Re-validation

```
$ pnpm test
ℹ tests 361
ℹ pass 361
ℹ fail 0
```

CLI re-validated on `examples/sample-loader.js` and `examples/benign.js`
(verdict, IOCs, artifacts, stdout purity, exit codes). The probe scripts used by
reviewers were executed before implementing each fix; the regression suite now
covers every fixed finding.
