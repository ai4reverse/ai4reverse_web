# Design review record

Five independent read-only reviews were run against the finished tree. The
reviewers had no shell tool, so their findings were derived from source reading
and each carried a reproducer; every reproducer below was executed by the
supervisor, fixed where needed, and turned into a regression test. After all
dispositions the full suite is green: **600 tests, 0 failures**; a sixth,
evidence-based review of `tools/` and its subsequent alignment are recorded as
Review 6 below.

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
| 2.1 | P1 | `eval-unwrap` parsed eval bodies with tolerant flags, splicing `return`/`await`/`super` out of illegal bodies and emitting non-parsing code. | **Fixed**: eval bodies parse with `allowReturnOutsideFunction:false` (Function bodies allow return but reject await/super/new.target), and the pipeline re-parses its own output (`validateOutput`) and returns the input when it does not parse (see Review 6 → D5). Regression: "eval bodies with illegal return/await/super are never spliced". |
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
ℹ tests 484
ℹ pass 484
ℹ fail 0
```

CLI re-validated on `examples/sample-loader.js` and `examples/benign.js`
(verdict, IOCs, artifacts, stdout purity, exit codes). The probe scripts used by
reviewers were executed before implementing each fix; the regression suite now
covers every fixed finding.

## Review 6 — `tools/` evaluation alignment (D1–D12)

A sixth review (`docs/EVALUATION-TOOLS.md`) re-read `tools/` against executed
evidence and produced twelve alignment targets, `D1`–`D12`, with acceptance
criteria. The implementation was aligned lane by lane (`git log --oneline
c8300ff..d7dc371`), then four independent, read-only auditors re-checked the
resulting tree (`.pi/audits/AUDIT-{A,B,C,D}-*.md`). This section is the
disposition record; `docs/VERIFICATION.md` carries the numbers and the commands
that produce them.

Legend as above, plus **Accepted** = documented limitation with the reason
recorded in `README.md` ("Known limitations") or `docs/SECURITY-MODEL.md`.

| Id | Severity | Finding (short) | Disposition | Evidence |
| --- | --- | --- | --- | --- |
| D1 | S1 | A stack overflow leaked the shared WASM heap and poisoned the module for the process. | **Fixed** | `7836126` quarantines a module whose disposal failed and re-acquires a healthy one; `9e9f3cf` **abandons** the runtime on a stack breach instead of disposing it; `94b1638` classifies the breach from the engine signal only. `tests/resilience.test.js` 15/15 (12 consecutive overflows, then `ok:true`), `tests/sandbox-core.test.js` 20/20, `0` `Aborted` lines. |
| D2 | S1 | Acquisition failures escaped as `QuickJSUnwrapError` and leaked the runtime. | **Fixed** | `75eb922` moves runtime/context/stealth/bridge acquisition inside the guarded region; `sandbox.js` wraps every escaping error in `SandboxError` with `code: SANDBOX_INIT\|SANDBOX_RUN`, a non-empty message and `cause`. `tests/resilience.test.js` init-failure, post-acquisition and "no unhandled rejection" cases. |
| D3 | S2 | `anti-fingerprint.prototypified` reported a handle address (e.g. 47 242 776) instead of a count, breaking determinism. | **Fixed** | `2ecd382` reads the count with `bridge.num` and clamps to 0…1000. `tests/determinism.test.js` 2/2: `moved` is an integer in `(0, 10000)` and identical across same-seed runs; `examples/network-c2.js` produces byte-identical dynamic events after removing `wall`. |
| D4 | S2 | No-op hook phases flooded the trace budget (`hook` 48 vs `code` 45 in a 20-iteration loop) and hook errors were unbounded. | **Fixed** | `3118a60`: unlistened phases are neither traced nor counted, `code:step` is declared and dispatchable but never traced, errors kept to the newest 200 with `errorsTruncated`. `tests/trace-budget.test.js` 5/5 (`byKind.hook = 2`, `code = 45`; strict bus accepts every declared phase, rejects typos). |
| D5 | S2 | Pass `changed` was not evidence-bound (a byte-identical rewrite still reported a change) and generated output was never re-parsed. | **Fixed** | `a8b7e85` compares generated text (`compareGeneratedText`) before claiming a change; `9578faf` re-parses the output strictly and returns the input with `outputValid:false`/`outputError`/a note instead of unparseable code, plus the exported `validateOutput`. `tests/restore-accuracy.test.js` 10/10 (0/11 pipeline and 0/121 per-pass fixed-point failures). |
| D6 | S1 | Missing or incoherent browser surfaces: no `WebAssembly`, no `SharedArrayBuffer`/`Atomics` policy, no `HTMLElement` hierarchy, no `customElements`, no `DOMParser`/`EventSource`, and element own properties were enumerable. | **Fixed** | `26ff5cb` (WebAssembly stub + isolation triple), `7896d0b` (HTMLElement, 39 tag interfaces, customElements), `24d4670` (bounded DOMParser/XMLSerializer, EventSource on the virtual network), `736e177` (`Object.keys(div).length === 0`), `d9a3d60`/`479d758` (real prototype chains, XMLDocument), `c5eaf6c` (wrappers keep descriptors, so `Object.keys(WebAssembly) === []`), `b28cba4`/`c41a172` (`consistencyReport().checked` derived → 20). `env-fidelity` 15/15, `env-surface` 18/18, `env-dom` 16/16, `env-misc` 13/13. |
| D7 | S2 | The CLI silently succeeded on typos and invalid values (`--rounds abc`, `--passes bogus`, `--nonsense` all exited 0). | **Fixed** | `09eae89` makes every closed-set option a usage error and `--out` write failures exit 2; `faa0cb1` pins the matrix. `tests/cli.test.js` 30/30: 21 invalid invocations → exit 2, message on stderr, empty stdout; valid invocations unchanged; `--json` stdout pure; `--out -` writes to stdout. |
| D8 | S3 | Documentation and contracts had drifted from the code (bridge signatures, trace options, 24 vs 28 env modules, 361 vs 441 tests, `z3-solver`, DST residual, no `Dn` dispositions). | **Fixed** | This review's alignment commit rewrites `docs/CONTRACTS.md` against `bridge.js`/`trace.js`/`hookbus.js`/`env/index.js`/`restore/index.js`, regenerates every count in `docs/VERIFICATION.md` (484 tests, 28 modules, 68 barrel exports, 43 test files, coverage row — superseded by the last wave: 600 tests, 46 files), corrects `README.md`/`API.md`/`ARCHITECTURE.md`/`SECURITY-MODEL.md`, and appends the disposition matrix. |
| D9 | S3 | No `LICENSE`, no `files` whitelist, no subpath `exports`, `z3-solver` unused but lockfile-pinned, no type declarations, `tools/cli.js` not executable. | **Fixed** | `207e170` (ISC LICENSE, `files`, 11 subpath `exports`), `6319a5a` (z3 removed from `package.json` and `pnpm-lock.yaml`), `3334341` (`types/*.d.ts`). `git ls-files -s tools/cli.js` → `100755`; `npm pack --dry-run` → **114 files** (91 tools + 9 docs + 11 types + `README.md` + `LICENSE` + `package.json`), only `tools/ docs/ types/ README.md LICENSE package.json`; `tests/types.test.js` 5/5. |
| D10 | S3 | Dead exports and stubs (`PASS_BY_ID`, `isPrimitiveLiteral`, `literalValue`, `parseExpression`, `parseFirstSuccessful`, `summarizeValue`, `adoptPrototype`, `nativeTextForFor`, `bridge.call`, `LimitationError`, `PassError`). | **Fixed** | `a57c785`, `c63f8bb`, `ff1732a`, `6187217`, `e98353e`: all removed; `TRACE_PHASES`, `resetQuickJS`, `restoreCode`, `scopeLogger` kept **because** they gained a consumer or a test. `tests/api-surface.test.js` 9/9 pins the removals (as absence assertions) and the kept names. |
| D11 | S3 | `env/misc.js` (2 282 lines) owned several surfaces, so subset selection silently lost `URL`/`Blob`/navigator capabilities. | **Fixed** | `62c130d` splits `url`, `blob`, `navigator` and the shared `platform-kit` (a non-module), followed by `dom-parser` and `eventsource`. `ENV_MODULE_IDS` = 28 = the `(order,id)` install order, zero `requires` violations, 28/28 strict install, and an unsatisfied requirement is a loud `SandboxError` instead of a silent drop. |
| D12 | S3 | `rename` deferral was implicit, and `bridge.fn` had a misaligned `catch`/`finally`. | **Fixed** | `b126492` declares `meta.deferred` and `isDeferredPass` consumes it (id fallback for old passes); `6187217` fixes the indentation and removes `bridge.call`/`adoptPrototype`. CLI `passes --json` reports `deferred` per pass; `tests/restore-accuracy.test.js` asserts the deferral behaviour. |

### Post-review findings raised by the auditors

| # | Source | Finding | Disposition |
| --- | --- | --- | --- |
| N1 | AUDIT-A | A sample could forge a "leak": `throw new Error('stack overflow')` matched a message regex, so a perfectly healthy runtime was abandoned and the module recompiled. | **Closed.** `94b1638` dropped the message test (classification then required a host-thrown `RangeError` out of `evalCode`/`callFunction`/`executePendingJobs`, or QuickJS's own `InternalError` name), and `829b1f4` replaced the remaining **name** test with **intrinsic identity**: `stealth.install()` captures the engine's `InternalError.prototype` before `env/globals.js` removes the binding, `stealth.isIntrinsicStackError(handle)` requires that prototype in the thrown value's chain, and it refuses to certify while the constructor is still guest-reachable (Firefox profile). Measured on this tree: `{name:'InternalError',…}`, a renamed `Error` and `new InternalError(...)` under a Firefox profile all report `limitsHit: []`, `stackExhaustion: false`, `disposal {ok:true, errors:[]}`, no module swap. **Residual narrowed** (documented in `README.md` and `docs/SECURITY-MODEL.md`): only a reduced `limits.stackBytes` — where the interpreter's own check fires instead of the WASM native stack — combined with a guest that catches the *genuine* overflow and reuses its prototype can forge the second classification, costing one abandoned runtime for a run that already breached the stack. `tests/resilience.test.js` 18/18 (`d593cff`). |
| F4 | AUDIT-D | Half-built interface hierarchy: `HTMLElement` and the tag interfaces existed, but `Node`, `Element`, `EventTarget`, `DocumentFragment`, `Text`, `Comment` were `undefined`, so `div instanceof Node` threw. | **Fixed** by `d9a3d60` (real prototype chains) and `479d758` (XML documents are real `XMLDocument` instances). Measured in a strict run: `div instanceof Node/Element/HTMLElement` → `true/true/true`, chain `HTMLDivElement > HTMLElement > Element > Node > EventTarget`. **Residual**: `Attr`, `Range`, `ShadowRoot` are still absent and are listed as limitations. This also resolves the "no `HTMLElement` globals" part of finding 3.22. |
| — | AUDIT-D | Cross-runtime interruption leak: a run that timed out while another run was parked at an `await` left guest objects on the neighbour's GC list, so the neighbour's `runtime.dispose()` aborted the WASM engine and quarantined the module for every later run. | **Fixed** by `d7dc371`: guest runs are serialized process-wide (`withGuestRunLock`), so a timeout can never interrupt a suspended neighbour. Concurrent callers queue (they are never rejected) and each still gets a fresh runtime and context. |
| F2 | AUDIT-D | Fixed per-run cost grew ~28 % (25.7 → 33.0 ms for `1+1`; 55.8 → 66.4 ms for a 1000-statement run) because `installEnvironment` now compiles extra guest source per run and `api.js` evaluates a descriptor factory per run. | **Accepted**: no acceptance criterion names a latency budget, the cost is per run (not per statement), `restore` of 200 KB is unchanged, and the trade was measurement fidelity for time. Documented in `README.md` → Known limitations. |
| F1 | AUDIT-D | `tests/examples.test.js` narrowed "every entry in `examples/` is documented" to "every regular file", so a new *directory* is no longer caught. | **Accepted** (and owned by the examples lane): the directory now holds documented sub-suites, and `examples/README.md` names each one; regular files are still covered. Recorded in `docs/VERIFICATION.md`. |
| N1 (B) | AUDIT-B | `restore()` does not append a trailing newline, so a file produced by redirecting stdout re-reports `changed:true` with zero changed passes. | **Accepted**: `passes[].changed` — the criterion — stays accurate, `--out` files round-trip with `changed:false`, and the effect is cosmetic (the verdict weight uses pass-level counts). Documented in `README.md` and `docs/API.md`. |
| N2 (B) | AUDIT-B | `validateOutput(code, {sourceType})` is advisory: the parser falls back to the other source type and `allowReturnOutsideFunction` defaults to true. | **Accepted**: generated text that fails *both* grammars is still rejected, which is the guarantee that matters ("never return code that does not parse"). Documented in `docs/API.md`. |
| L1 | coverage round | Observer entries were built inside the `observe()` bridge call, so the per-call `HandleBag` freed them before delivery: `takeRecords()` and the callback both handed the guest dead handles (`QuickJSUseAfterFree` on any property read). | **Fixed** by `8473a6a`: queue plain record descriptors, build the entry at delivery time, and dup the observer instance so the callback's second argument outlives `init()`. New `tests/env-observers.test.js` (14 tests). |
| L2 | coverage round | `observe()`/`observeAll()` kept a target duplicate after delivery, so the runtime could not be torn down. | **Fixed** by `335c2d0`: the duplicate is released once the entry has copied the target; the env harness asserts `disposal {ok:true, errors:[]}`. |
| L3 | coverage round | Real platform leaks in the canvas module: `FontFaceSet.add` stored `face.dup()` with no owner, and `toBlob`/`img.src` handed a duplicate to a virtual-clock task that a short run never reached — so `runtime.dispose()` aborted the engine (`list_empty(&rt->gc_obj_list)`) and quarantined the module. A legitimate `document.fonts.add()` sample reported `disposal {ok:false, leaked:true}`. | **Fixed** by `4201ae9`: one `retain()` teardown set for the module plus `release()` for early frees; scheduled handles are retained before the task is queued, so teardown is the backstop. `env-canvas` 32/32. |
| L4 | coverage round | `new ImageData(w, h)` attached host state but no guest `data`, so `image.data` was `undefined` where `getImageData().data` was not — a one-read detection tell. `getLineDash()` returned a fresh empty array each call. | **Fixed** by `74c6eae`: one own `Uint8ClampedArray` over a guest `ArrayBuffer` (transparent-black payload, Chrome dimension rules, 64 MiB ceiling), and the dash list is stored on the context and carried by `save()`/`restore()`. One deviation documented: `new ImageData(2)` reports the height rule instead of Chrome's arity `TypeError`, because the shared class factory cannot see `arguments.length`. |
| L5 | coverage round | `timers.js` kept a `microtasks` array and a `drainMicrotasks` hook that nothing ever fed; the drain walked an always-empty array, reading as coverage of a path that does not exist. | **Fixed** by `9122627`/`3013295`: array, hook, teardown loop and the caller's drain removed (microtasks are the engine's promise jobs). `timers` 7/7 pins the FIFO order and the absence of the hook. |

### Accepted limitations recorded by this review

These are the limits a reader must know about; each is stated in `README.md`
("Known limitations"), `docs/SECURITY-MODEL.md` or both.

- QuickJS is not V8: some engine behaviour and stack column numbers differ.
- WASM execution is unsupported. The `WebAssembly` surface is a coherent stub
  (`validate()` → `false`, `compile`/`instantiate` reject with a browser-shaped
  `CompileError`, `Memory`/`Table`/`Global` are functional), so a sample cannot
  execute hidden WASM — and cannot conclude from the surface that it is not in a
  browser.
- `SharedArrayBuffer` exists exactly when `crossOriginIsolated` is true (and then
  only over `https`). `Atomics` is a single-threaded shim: there is one guest
  thread, `wait` never blocks, `notify` returns 0.
- `DOMParser` is bounded (65 536 characters, 512 nodes, 32 levels) and has no
  HTML5 insertion-mode algorithm, no namespaces and a CSS-subset selector engine.
- Per-tag `instanceof` is answered structurally for the tags the canvas module
  owns; interface constructors carry an own `Symbol.hasInstance` a browser does
  not have.
- `customElements.upgrade` re-parents and calls the constructor with the element
  as `this`, so an ES `class` body cannot run; `document.createElement` does not
  auto-upgrade.
- `Attr`, `Range`, `ShadowRoot` are `undefined`; `DocumentType` exists but is
  never instantiated.
- `crypto.subtle` covers `digest` and `generateKey`; AES/HMAC and `importKey` are
  absent. `IndexedDB` is a stub that fires `NotSupportedError` on the virtual
  clock.
- Canvas/WebGL/audio are deterministic profile values, not renderers.
- One guest run at a time per process; real parallelism needs worker processes.
- Per-run cost is ~28 % above the pre-alignment tree (finding F2 above).
- Coverage is reported on two scopes: the `tools/` scope (`--test-coverage-exclude='examples/**'`,
  93.02 % lines / 83.05 % branches / 91.48 % functions) is the one the review
  baseline (88.08 / 75.26 / 80.33) was measured on, and it is above that baseline
  on all three metrics. The whole-tree scope (97.22 / 74.41 / 90.43) is lower on
  branches because `examples/` adds sample code the tests execute rather than
  assert on; it is recorded as an accepted, documented gap, not a re-based gate.

### Re-validation after Review 6

```
$ node --test --test-concurrency=1 tests/*.test.js
ℹ tests 600
ℹ pass 600
ℹ fail 0
ℹ duration_ms 80256.719

$ grep -c 'Aborted(' <captured log>   # engine heap assertions
0
```

46 test files, 0 failures, **0 engine aborts**: the last wave closed the remaining
handle-lifetime leaks (L1–L5 above), so the suite is now quiet on stderr as well
as green. Coverage, on the two recorded scopes:

| Scope | Lines | Branches | Functions | vs baseline (88.08 / 75.26 / 80.33) |
| --- | --- | --- | --- | --- |
| whole tree | 97.22 % | 74.41 % | 90.43 % | branches below — accepted (example suites) |
| `tools/` only | **93.02 %** | **83.05 %** | **91.48 %** | **above on all three** (the gate scope) |

Four independent auditors reproduced the original `Dn` reproducers on the
aligned tree: AUDIT-A (D1–D3) **PASS** with N1 fixed afterwards, AUDIT-B (D4, D5,
D7) **PASS**, AUDIT-C (D6, D9–D12) **PASS** on substance (its documentation half
is what this alignment delivers), AUDIT-D (D8 + regression sweep) **FAIL** on
D8 only — the blocking item this alignment closes — with no correctness
regression in `tools/`.
