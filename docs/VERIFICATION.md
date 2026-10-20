# Verification record

This file records how each requirement of the objective was verified, with the
authoritative command and outcome. It is regenerated at the end of each wave and
kept under version control so the evidence is reviewable without rerunning
history.

**Measurement basis.** Every number below was produced on commit **`7c1df9c`**
(`fix(hook): accept array-form registrations and reject malformed ones`), the
last commit of the `tools/` alignment wave, from a pristine export of that
commit:

```bash
git archive 7c1df9c | tar -x -C /tmp/v && ln -s "$PWD/node_modules" /tmp/v/node_modules
cd /tmp/v && node --test --test-concurrency=1 $(git -C "$OLDPWD" ls-files 'tests/*.test.js')
```

No working-tree or later-commit file can influence these numbers, and a pinned
commit never moves, so they stay reproducible. Commits that land after `7c1df9c`
add example corpora under `examples/` (`products`, `works`, `suite`, `mega`) with
their own test files; those corpora are not described here and are excluded from
every count in this file.

## Environment

- Node.js v24.19.0 (contract requires >= 24.18), pnpm 12.14.
- Dependency set: `quickjs-emscripten@0.32.0`,
  `@babel/{parser,traverse,generator,types,template}@8.x`, `pino@10`,
  `pino-pretty@13`. `z3-solver` was removed from `package.json` **and** the
  lockfile:

  ```
  $ grep -c z3-solver pnpm-lock.yaml
  0
  ```

- No network access is required or performed by the platform or its tests.

## Full suite

```
$ node --test --test-concurrency=1 $(git ls-files 'tests/*.test.js')   # commit 7c1df9c
ℹ tests 612
ℹ suites 0
ℹ pass 612
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 57872.820208
```

The 612 tests are exactly the 42 committed `tests/*.test.js` files
(`git ls-files 'tests/*.test.js' | wc -l` → 42). The captured log contains **0**
lines matching `Aborted(` — no engine heap assertion escapes from any stack,
timer or promise-job breach (section "Sandbox resilience evidence"). The zero is
what makes the claim checkable: both stack shapes, the timer path and the
promise-job path classify *and* tear down without printing an engine assertion.

### Coverage

Coverage is recorded on **two scopes**, because the review baseline was measured
on `tools/` while `examples/` holds sample code that the tests execute rather
than assert on.

```
$ node --test --test-concurrency=1 --experimental-test-coverage $(git ls-files 'tests/*.test.js')
ℹ tests 612
ℹ pass 612
ℹ fail 0
ℹ all files                |  90.32 |    78.88 |   86.92 |

$ node --test --test-concurrency=1 --experimental-test-coverage \
    --test-coverage-exclude='examples/**' $(git ls-files 'tests/*.test.js')
ℹ tests 612
ℹ pass 612
ℹ fail 0
ℹ all files                        |  92.99 |    82.68 |   90.62 |
```

| Metric | Whole tree | `tools/` scope | Review baseline (`docs/EVALUATION-TOOLS.md`) | `tools/` vs baseline |
| --- | --- | --- | --- | --- |
| Lines | 90.32 % | **92.99 %** | 88.08 % | **+4.91** |
| Branches | 78.88 % | **82.68 %** | 75.26 % | **+7.42** |
| Functions | 86.92 % | **90.62 %** | 80.33 % | **+10.29** |

**The review baseline is applied to the `tools/` scope**, because that is the
scope it was measured on (`--test-coverage-exclude='examples/**'`) and
`examples/` is outside `tools/`. That scope clears all three metrics. The
whole-tree scope also clears it on all three; it is reported so a reader can see
the effect of the committed example code without re-basing the gate.

## Test files (42) and observed counts

`node --test --test-concurrency=1 tests/<file>` per file, run on commit
`7c1df9c`:

| File | Tests | File | Tests |
| --- | --- | --- | --- |
| `analysis-e2e` | 14 | `jsvmp-analyze` | 6 |
| `api-instrumentation` | 3 | `jsvmp-builder` | 9 |
| `api-surface` | 9 | `jsvmp-trace` | 7 |
| `cli` | 30 | `logging` | 6 |
| `determinism` | 2 | `national-sdk` | 13 |
| `env-anti-fingerprint` | 10 | `report` | 15 |
| `env-canvas` | 32 | `resilience` | 23 |
| `env-dom` | 16 | `restore-accuracy` | 10 |
| `env-encoding` | 12 | `restore-anti-analysis` | 12 |
| `env-fidelity` | 16 | `restore-control-flow` | 16 |
| `env-intl` | 12 | `restore-fold` | 24 |
| `env-misc` | 19 | `restore-pipeline` | 17 |
| `env-network` | 18 | `restore-string-array` | 17 |
| `env-observers` | 14 | `restore-strings` | 14 |
| `env-storage` | 1 | `restore-unwrap` | 37 |
| `env-surface` | 18 | `sandbox-core` | 44 |
| `env-time` | 15 | `timers` | 7 |
| `examples` | 12 | `trace-budget` | 9 |
| `hook` | 22 | `traceless` | 16 |
| `instrumentation` | 11 | `types` | 6 |
| `invocation` | 10 | `ioc` | 8 |

Sum: **612 tests across 42 files**, the same total the suite reports.

Test files are the regression layer for every finding in this document: the
alignment lanes added `resilience` (D1/D2), `determinism` (D3),
`trace-budget` (D4), `restore-accuracy` (D5), `env-fidelity` (D6 probes in a real
sandbox), `api-instrumentation` (wrapped-descriptor and timer-release fixes),
`api-surface` (D10 export surface, kept-and-used names) and `types` (D9.4
declarations). The follow-up coverage round added `env-observers` (`8473a6a`,
`335c2d0`), `env-encoding` and `env-anti-fingerprint` (`b28db87`), and extended
`env-canvas`, `hook`, `sandbox-core`, `resilience`, `env-misc` and the
`restore-*` files (`758e225`/`06e099c`/`d145be9`/`b28db87`). The final wave lifted
`resilience` to 23, `sandbox-core` to 44, `report` to 15, `trace-budget` to 9,
`hook` to 22, `env-fidelity` to 16 and `analysis-e2e` to 14 ("Final wave evidence"
below).

## Requirement → implementation → evidence

| Requirement | Implementation | Evidence (command) |
| --- | --- | --- |
| Sandbox built on quickjs-emscripten | `tools/sandbox/runtime.js`, `sandbox.js` | `node --test tests/sandbox-core.test.js` — 44/44 |
| Traceless base: isolation, no detection, no info collection, no honeypots/booby traps | `tools/sandbox/{sandbox,profile,integrity,limits,clock}.js`, `tools/sandbox/env/*` (28 modules), `tools/sandbox/env/anti-fingerprint.js` | `node --test tests/traceless.test.js` — 16/16; `tests/env-surface.test.js` — 18/18 |
| Fresh state per run (no cross-sample residue) | `sandbox.run()` creates runtime + context; full handle disposal; one guest run at a time per process | `sandbox-core` isolation + disposal assertions; `run.disposal.ok`; `resilience` — 23/23 |
| Traceless invocation | `tools/invocation/{invoke,stealth}.js` | `node --test tests/invocation.test.js` — 10/10 |
| Traceless Code/API/Exception/AST instrumentation | `tools/instrumentation/{code,api,exception,ast,index}.js` | `node --test tests/instrumentation.test.js` — 11/11; `api-instrumentation` — 3/3; byte-identical `toString` assertion in `traceless` |
| JSVMP interpreter instrumentation | `tools/instrumentation/jsvmp.js` + `tools/jsvmp/*` | `node --test tests/jsvmp-trace.test.js` — 7/7 (319 opcode events, 14 distinct opcodes, obfuscated VM traces identically) |
| Traceless Code/API/Exception/AST hooks | `tools/hook/{hookbus,code-hook,api-hook,exception-hook,ast-hook,index}.js` | `node --test tests/hook.test.js` — 22/22; `trace-budget` — 9/9 |
| Babel code restoration (unified parse/transform/generate), output validated | `tools/restore/{parse,generate,pass-context,index}.js`, `passes/` (11 passes) | `node --test tests/restore-*.test.js` — 8 files / 147 tests, semantics preservation by execution, `outputValid` fallback |
| Pass `changed` is evidence-bound and the pipeline is a fixed point | `tools/restore/pass-context.js` (`compareGeneratedText`), `passes/{strings,jsfuck}.js` | `restore-accuracy` 10/10; second application reports `changed:false` on all 11 committed `examples/*.js` |
| Logging with pino / pino-pretty | `tools/logging/logger.js` | `node --test tests/logging.test.js` — 6/6; `node tools/cli.js passes --pretty` renders via pino-pretty |
| Final implementation under `tools/` | 91 JS modules / 35 118 lines | `find tools -name '*.js' \| wc -l` = 91; `find tools -name '*.js' -exec cat {} + \| wc -l` = 35118 |
| Tests under `tests/` | 42 test files + `tests/helpers/` | `git ls-files 'tests/*.test.js' \| wc -l` = 42 |
| Public surface | 68 exports from `tools/index.js`; 11 `exports` subpaths with `types` | `node -e "import('./tools/index.js').then(m=>console.log(Object.keys(m).length))"` → 68; `types` — 6/6 |
| Composable auxiliary analysis | `tools/analysis/*` (IOC, report, behaviour, artifacts, stages, orchestrator), CLI, hooks, passes | `node --test tests/analysis-e2e.test.js tests/cli.test.js` — 44/44 |
| CLI contract: strict validation, exit codes, stdout purity | `tools/cli.js` | `node --test tests/cli.test.js` — 30/30 |
| Environment fidelity (D6 surfaces) | `tools/sandbox/env/*`: DOM hierarchy, `dom-parser`, `eventsource`, `url`, `blob`, `navigator`, `globals` (WebAssembly + isolation triple) | `env-fidelity` 16/16, `env-dom` 16/16, `env-surface` 18/18, `env-misc` 19/19, `env-observers` 14/14, `env-encoding` 12/12, `env-canvas` 32/32, `env-network` 18/18 |
| Deterministic runs | seeded profile/clock/PRNG; `anti-fingerprint` reports a count, never a handle address | `determinism` 2/2 (identical dynamic events after removing `wall`; identical report after removing timing) |
| Runnable examples / ecosystem docs | `examples/*.js` (11 samples), `examples/*.mjs` (4 demos), `examples/build-jsvmp-sample.mjs`, `examples/cli-usage.sh`, `examples/README.md` | `node --test tests/examples.test.js` — 12/12 (all samples execute; all demos and the CLI cookbook run); `bash examples/cli-usage.sh` → exit 0 |
| Hardened national JS-SDK | `examples/national-sdk/` (signing, fingerprint, white-box crypto, JSVMP, zero-trust guard, build pipeline, server verifier, docs) | `node --test tests/national-sdk.test.js` — 13/13; `node examples/national-sdk/verify.mjs` — 37/37 |
| Many subagents used | Parallel workers for env modules, restoration passes, JSVMP, IOC/report, plus research + review + audit agents | session history; artefacts summarised in "Review and re-validation" below |

## CLI evidence

```
$ node tools/cli.js analyze examples/sample-loader.js --json
verdict.level = "suspicious", verdict.score = 54, 8 weighted reasons,
3 URL IOCs, 4 artifacts, 133 trace events (71 of them platform events)

$ node tools/cli.js restore examples/sample-loader.js | head -3
<decoded source; string array and hex escapes removed>

$ node tools/cli.js run examples/benign.js --json
ok = true, result = {"type":"undefined"}, disposal = {"ok":true,"errors":[]}

$ node tools/cli.js passes --json
11 passes: strings:30 constant-fold:35 member-fold:40 string-array:50
jsfuck:55 proxy-unwrap:60 dead-code:65 control-flow:70 anti-analysis:75
eval-unwrap:80 rename:90   (rename: deferred true, the rest deferred false)
```

`examples/benign.js` is an IIFE that logs `sum 55`; the script's own result is
`undefined`, so `run.result` is `{"type":"undefined"}`. The synthetic
`globalThis.out = 6 * 7; out` sample in `tests/cli.test.js` is the one whose
`result.value` is 42. The sample-loader verdict is 8 reasons / 54 points instead
of 9 / 60 because the platform's own installation events no longer score as
sample DOM behaviour ("Final wave evidence").

`--json` keeps stdout pure JSON (logs go to fd 2), `--out -` writes the result to
stdout, `--arg` parses JSON-or-string, and every invalid option value is a usage
error: **exit 2, message on stderr, empty stdout**. `tests/cli.test.js` (30/30)
exercises **39** invalid invocations through its `assertUsageError` helper
(6 unknown options, 7 malformed seeds, 6 malformed rounds values, 3 unknown pass
ids, 4 invalid levels, 3 `--out` failures, `--events --json`, 3 missing inputs,
6 malformed numeric limits) plus **4** `assert.rejects` cases (unknown command,
missing file, malformed `--profile`, empty file) — 43 invalid invocations in
total. Exit codes: `0` success, `1` analysis/run failure, `2` usage error.

## Sandbox resilience evidence

```
12 × function f(n){return f(n+1)} f(0), then a normal run (one process):
every stack run: limitsHit ["stack"], stackExhaustion true, error.stack ""
                 disposal {ok:false, leaked:true, stage:'runtime', skipped:true}
normal run:      ok true, value 2, disposal {ok:true, errors:[]}
$ grep -c Aborted  →  0
```

- A stack breach is classified from the **engine signal only**, never from a
  dumped guest name or message. Two engine shapes exist and both go through one
  record builder (`invoke.js` `stackBreachOutcome`):
  1. a host `RangeError` thrown out of `evalCode`, `callFunction` or
     `executePendingJobs` (`runtime.js` `isHostStackExhaustion`);
  2. the same overflow at a **host-callback boundary**, where the
     quickjs-emscripten trampoline rethrows it into the guest as an `Error` —
     shape-identical to `throw new RangeError('Maximum call stack size exceeded')`.
     This shape is certified by a host-side counter the guest cannot write
     (`runtime.stackSignals()`, incremented by `guardHostStackExhaustion`) and
     read around the branch that ran (`invoke.js` `noteHostStack`).
- Guest-side evidence exists for one case only: interpreter recursion from a
  reduced `limits.stackBytes`, which no host throw announces. There the verdict
  is `stealth.isIntrinsicStackError(handle)`, prototype **identity** against the
  engine's captured `InternalError.prototype`, and it refuses to certify while
  that constructor is guest-reachable. `env/stack.js` re-owns the wrapper
  prototype so a Firefox profile keeps a faithful (but unforgeable)
  `InternalError`; if the wrapper cannot be installed and the intrinsic is
  exposed, the module calls `stealth.revokeStackEvidence()` and guest dumps stop
  certifying for the rest of the run. The host witness is unaffected.
- **A classified run looks the same whichever shape happened**:
  `error.stack === ''` (the frame list grows with recursion depth, so keeping it
  would make two runs disagree), `limitsHit: ['stack']`, `stackExhaustion: true`
  and `disposal { ok:false, leaked:true, stage:'runtime', skipped:true }`. 40
  consecutive recursion runs in the **full** environment produce exactly one
  distinct record (`tests/resilience.test.js`, "40 consecutive recursion runs in
  the full environment classify identically"), and the follow-up `1+1` returns
  `ok:true` with a clean disposal.
- **A swallowed overflow still classifies.** If guest code catches the converted
  error (`try { recurse() } catch {}`), the script itself succeeds — the run is
  `ok:true` with `limitsHit: ['stack']`, the runtime is still abandoned and the
  record keeps the same shape. The host witness survives the guest `catch`; a
  message test would not.
- **Forgery does not classify.** Measured on this tree: a thrown
  `{name:'InternalError',message:'Maximum call stack size exceeded'}`, a renamed
  `Error`, a plain `Error('stack overflow')`, and `new InternalError(...)` under
  a Firefox profile in a reduced environment (where the constructor is reachable)
  all report `limitsHit: []`, `stackExhaustion: false` and
  `disposal {ok:true, errors:[]}` with no module swap
  (`tests/resilience.test.js`, `tests/sandbox-core.test.js`).
- The same breach inside a timer or promise callback is classified and recorded
  in `run.settle.stackExhaustion` with `settle.error.origin`
  (`timer` / `promise-job`); `run.ok` stays `true` for the script itself and
  `run.disposal` still reports the leak. Every callback shape in
  `EVENT_LOOP_DEFORMATIONS` is covered, each followed by a clean `1+1`.
- **Cost of the classification**: each abandoned runtime keeps its module heap
  until the quarantined module is collected — measured **21.7 MB RSS per breach**
  over six breaches on this host (~17 MB in the final-audit measurement), while
  the process keeps analysing. The trade is deliberately "stay correct and keep
  working" over "restart the process".
- Initialisation failures are `SandboxError` with `code: 'SANDBOX_INIT'` (or
  `SANDBOX_RUN` after acquisition), a non-empty message and the original error as
  `cause`; no unhandled rejection.
- Concurrent `run()` calls are **queued** (one guest run per process), so a
  timeout in one run can no longer interrupt a neighbour parked at an `await`.

## Tracelessness probes (from `tests/traceless.test.js`, 16/16)

| Probe | Guaranteed result |
| --- | --- |
| `f.toString()` after statement/function/eval instrumentation | byte-identical original source |
| `Function.prototype.toString.toString()` | exactly `function toString() { [native code] }` (V8 single-line format) |
| `Object.getOwnPropertyNames(globalThis)` filtered for `_$`, `ai4r`, `__q` | `[]` |
| `Object.getOwnPropertySymbols(globalThis)` / `Reflect.ownKeys` symbols | `[]` (channel and Window tag filtered) |
| `process`/`require`/`Buffer`/`module`/`spawn`/`Deno`/`Bun` | all `undefined` |
| honeypot globals (`_phantom`, `callPhantom`, `__nightmare`, `domAutomation`, `$cdc_*`) | absent |
| `Object.prototype.toString.call(window)` | `[object Window]` |
| `window.constructor.name`, `Object.getPrototypeOf(window) === Window.prototype` | `Window`, `true` |
| `new Error().stack` / caught engine error stack | real script URL + line:column; no `<eval>`, no host paths, no `ai4r-internal` |
| `Date.prototype.getHours.toString()`, `Math.random.toString()`, `Error.toString()` | `[native code]` |
| `new Date(epoch).getHours()/getTimezoneOffset()` vs profile timezone | consistent |
| `Date.now()` vs `performance.timeOrigin + performance.now()` | agree within 2 ms |
| `Math.random()` across two sandboxes with same seed | identical |
| Global count `Object.getOwnPropertyNames(globalThis).length` | plausible (40–400) |
| `Object.keys(navigator/screen/location/history/performance/crypto/document).length` | `0` (WebIDL prototypes, not own properties) |
| `Object.keys(document.createElement(tag)).length` / own symbols | `0` / `[]` for every tag interface |
| `Object.getOwnPropertySymbols(document)` / `Object.assign({}, document)` symbols | `[]`; instrumentation and state symbols are registered `ai4r.*` and filtered |
| `Object.prototype.toString.call(div/body/canvas)` | `[object HTMLDivElement]` / `[object HTMLBodyElement]` / canvas interface |
| `div instanceof HTMLElement` / `instanceof Element` / `instanceof Node` | `true` / `true` / `true`; prototype chain `HTMLDivElement > HTMLElement > Element > Node > EventTarget` |
| Chrome/Firefox-specific surfaces | `connection`, `getBattery`, `console.memory`, `webkitAudioContext`, `deviceMemory` only on Chromium; `oscpu`/`buildID` only on Gecko; `msCrypto` absent |
| `new Date(0).getTimezoneOffset()` vs anchor offset | DST-correct per instant from host ICU tzdata (New York 300 in January, 240 in July; London −60 in July). `tools/util/timezone.js` `timezoneOffsetMinutesAt` |
| `Date.parse('2026-10-19T15:20:00')` (no zone) | profile-local per ES2020, not host timezone |
| `localStorage` over-quota write / ``estimate().usage`` | `QuotaExceededError` at 5 MiB; usage reflects real bytes |
| `queueMicrotask` vs `Promise.then` FIFO | promise job first |
| `performance.mark()` | returns `undefined`; entry retrievable via `getEntriesByType('mark')` |
| `new TextDecoder('bogus')` | `RangeError` |
| `matchMedia('(min-width: 1px)')` | `true` for the profile viewport |
| `Object.keys(WebAssembly)` after 54 wrapped platform methods | `[]` (wrappers keep the original descriptor) |
| `run.profile.consistency` | `{ok:true, problems:[], checked:20}` |

## Known residuals (documented, tested where possible)

- QuickJS is not V8: engine-specific behaviour (some APIs, stack columns) differs.
  Line numbers are preserved by splicing; columns shift.
- `document`/`navigator` carry own `Symbol.toStringTag`/`constructor` brand
  properties (filtered from symbol enumeration) because re-parenting would drop
  DOM methods.
- No real rendering/layout; canvas/WebGL/audio are deterministic profile values.
- `crypto.subtle` is a partial WebCrypto implementation. At the pinned commit it
  exposes `digest` and `generateKey` (the measured surface); later commits add
  `importKey`/`exportKey` and AES `encrypt`/`decrypt`. Signing (HMAC, RSA/ECDSA),
  `deriveKey`/`deriveBits` and `wrapKey` are absent in both.
- `IndexedDB` is a stub: `open`/`deleteDatabase` return a request whose
  `onerror` fires `NotSupportedError` on the virtual clock; no storage happens.
- `WebAssembly` execution is unsupported: the surface is a coherent stub, so a
  sample that hides logic in WASM cannot run it.
- `DOMParser` is bounded (65 536 input characters, 512 nodes, 32 levels) and has
  no HTML5 insertion-mode algorithm.
- The DOM hierarchy installs `Node`/`Element`/`EventTarget`/`DocumentFragment`/
  `Text`/`Comment`/`CharacterData`/`NodeList`/`HTMLCollection`/`DOMTokenList`/
  `CSSStyleDeclaration`/`DocumentType`; `Attr`, `Range` and `ShadowRoot` are
  still `undefined`, and `DocumentType` is never instantiated (`new` throws
  `TypeError`; `document.implementation.createDocumentType()` returns an object
  that is not `instanceof DocumentType`).
- Stack-breach classification is **intrinsic** on the guest-side path:
  `stealth.isIntrinsicStackError()` requires the engine's captured
  `InternalError.prototype` in the thrown value's prototype chain and refuses to
  certify while that constructor is guest-reachable (or after
  `revokeStackEvidence()`), so a forged record, a renamed `Error`, a plain
  `Error('stack overflow')` and a prototype stand-in do not classify. The one
  residual needs a **reduced** `limits.stackBytes` (interpreter check instead of
  the WASM native stack) plus a guest that catches a genuine overflow and reuses
  its prototype; it costs an abandoned runtime for a run that already breached
  the stack.
- Host memory keeps the abandoned module heap after each stack breach until the
  quarantined module is collected: measured 21.7 MB RSS per breach over six
  breaches (~17 MB in `FINAL-C`).
- `new ImageData(w, h)` installs a real `data` view, but the shared class factory
  cannot see `arguments.length`, so `new ImageData(2)` reports the height rule
  instead of Chrome's "2 arguments required" `TypeError`.
- One guest run at a time per process: real parallelism needs separate worker
  processes.
- Wrapped platform APIs that throw synchronously keep name/message but the stack
  starts at the wrapper call site.
- `restore()` returns generated text with no trailing newline; a file produced by
  redirecting stdout therefore re-reports `changed:true` with zero changed
  passes. `--out` files are exact and round-trip with `changed:false`.

## Review and re-validation

Five independent read-only agents reviewed the platform: (1) core sandbox/
invocation/instrumentation for leaks, semantic changes and detection tells; (2)
restoration and JSVMP for semantics-changing transforms; (3) environment
fidelity; (4) analysis/report/CLI/logging for IOC quality and contract
stability; (5) an evidence auditor mapping every requirement to code and
executed tests. A sixth, evidence-based review of `tools/` produced the `D1`–`D12`
alignment targets in `docs/EVALUATION-TOOLS.md`; four independent auditors then
re-checked the aligned tree, and a final audit round re-checked the result.
Findings and dispositions are recorded in `docs/DESIGN-REVIEW.md`; the alignment
outcome is the matrices below.

## Final audit (post-review)

Executed after all review dispositions, on the pinned tree:

```
$ node --test --test-concurrency=1 $(git ls-files 'tests/*.test.js')   # commit 7c1df9c
ℹ tests 612
ℹ pass 612
ℹ fail 0
```

Strict full-environment audit (`env: {strict:true}`):

| Check | Result |
| --- | --- |
| Declared env modules / installed / missing | **28 / 28 / 0** (`complete: true`) |
| Registered restoration passes | 11 (deferred: `rename`) |
| Hook phases declared / global wildcard dispatch | **21** / 2 dispatches |
| JSVMP: detection / opcodes / traced opcode events | detected / 14 / 319 |
| `Object.keys(navigator\|screen\|document\|WebAssembly).length` | 0 / 0 / 0 / 0 |
| `Object.getOwnPropertySymbols(document).length` | 0 |
| `typeof Intl\|URL\|XMLHttpRequest\|fetch\|WebSocket\|HTMLCanvasElement\|AudioContext\|DOMParser\|XMLSerializer\|EventSource\|WebAssembly\|HTMLElement` | all `object`/`function` |
| `run.profile.consistency` | `{ok:true, problems:[], checked:20}` |
| `localStorage instanceof Storage` | true |
| `Object.prototype.toString.call(window)` | `[object Window]` |
| Integrity intact / disposal ok | true / true |

## Disposition matrix

`Dn` ids come from `docs/EVALUATION-TOOLS.md`; the audit findings (`N1`, `F1`–`F5`,
`R*`, the handle-lifetime findings `L1`–`L5` of the follow-up wave and the final
audit's `F-B3`/`F-B4`, `F1`–`F9`) come from `.pi/audits/*.md` and
`docs/DESIGN-REVIEW.md`. "Fixed" always names the commit that changed the code
and the test that keeps it fixed.

### D1–D12

| Id | Severity | Status | Evidence |
| --- | --- | --- | --- |
| D1 runtime/module poisoning | S1 | **Fixed** | `7836126` quarantine + `loadQuickJS` re-acquire; `9e9f3cf`/`94b1638` abandon from the engine marker only; `5ef930e` adds the host-callback witness and one record for both engine shapes; `markModuleUnhealthy` stays internal. `tests/resilience.test.js` 23/23 ("12 consecutive stack overflows…", "40 consecutive recursion runs in the full environment classify identically", "a Firefox profile cannot forge engine exhaustion in the full environment"), `tests/sandbox-core.test.js` 44/44. 12-run reproducer: `disposal {ok:false, leaked:true, stage:'runtime', skipped:true}`, then a normal run `ok:true`, `0` `Aborted` lines. Cost: 21.7 MB RSS per breach (measured). |
| D2 guarded acquisition + typed errors | S1 | **Fixed** | `75eb922` acquisition inside the guarded region; `sandbox.js` wraps escaping errors as `SandboxError` (`SANDBOX_INIT`/`SANDBOX_RUN`, `cause`, non-empty message). `tests/resilience.test.js` init-failure and post-acquisition cases; no unhandled rejection. |
| D3 `moved` is a count | S2 | **Fixed** | `2ecd382` `bridge.num([call.value],0)` + clamp (0…1000). `tests/determinism.test.js` 2/2: `moved` integer, `0 < moved < 10000`, identical dynamic events across same-seed runs. Pre-fix it reported a handle address (~4.7e7). Measured `moved = 202` on `examples/network-c2.js`. |
| D4 trace/hook budget | S2 | **Fixed** | `3118a60` unlistened phases are not traced or counted; `code:step` is declared and dispatchable but never traced; `4ad8c42` keeps hook trace events inside the trace schema (`phase: emit\|transform`, hook phase in `hook`), validates `kind` in every mode, and bounds errors by **200 entries and 64 KiB** (2 KiB per message) with `errorsTruncated`. `tests/trace-budget.test.js` 9/9: 20-iteration loop → `byKind.hook = 2`, `code = 45`. |
| D5 restoration accuracy + output validation | S2 | **Fixed** | `a8b7e85` `changed` = generated-text change (`compareGeneratedText`); `9578faf` `validateOutput`/`outputValid`/`outputError` + input fallback. `tests/restore-accuracy.test.js` 10/10: 0/11 pipeline and 0/121 per-pass fixed-point failures; `validateOutput('function (')` false. |
| D6 missing/incoherent browser surfaces | S1 | **Fixed** (docs half included) | `26ff5cb` WebAssembly stub + isolation triple; `7896d0b` HTMLElement/tag interfaces/customElements; `24d4670` DOMParser/XMLSerializer/EventSource; `d9a3d60`/`479d758` real prototype chains and XMLDocument; `736e177` `Object.keys(element).length === 0`; `b28cba4`/`c41a172` `checked` derived (20); `5e40603` brands `[object DOMParser]`/`[object XMLSerializer]`/`[object EventSource]` and exposes `CustomElementRegistry`. `env-surface` 18/18, `env-fidelity` 16/16, `env-dom` 16/16. Documentation: `README.md` "Known limitations", `docs/SECURITY-MODEL.md` WASM/`SharedArrayBuffer` sections. |
| D7 CLI contract | S2 | **Fixed** | `09eae89` closed-set validation, `--out` write failures as usage errors; `faa0cb1` matrix tests. `tests/cli.test.js` 30/30: **39** invalid invocations through `assertUsageError` (+4 `assert.rejects` cases) → exit 2, stderr message, empty stdout; `--out -` writes to stdout; `--json` stdout stays pure. |
| D8 docs/contracts drift | S3 | **Fixed** | This alignment: `CONTRACTS.md` written against `tools/sandbox/bridge.js`, `tools/instrumentation/trace.js`, `tools/hook/hookbus.js`, `tools/sandbox/env/index.js`, `tools/restore/*`; every count in this file regenerated from a pinned commit; `DESIGN-REVIEW.md` Review 6 and Review 7; `SECURITY-MODEL.md`, `README.md`, `API.md`, `ARCHITECTURE.md`, `REPORT-SCHEMA.md` corrected. |
| D9 packaging/metadata | S3 | **Fixed** | `207e170` LICENSE (ISC) + `files` whitelist + subpath `exports`; `6319a5a` z3-solver removed from `package.json` and lockfile; `3334341` `types/*.d.ts`. `git ls-files -s tools/cli.js` → `100755`; `npm pack --dry-run` → **114 files** (91 tools + 9 docs + 11 types + `README.md` + `LICENSE` + `package.json`), only `tools/ docs/ types/ README.md LICENSE package.json`; `tests/types.test.js` 6/6. |
| D10 dead exports/stubs | S3 | **Fixed** | `a57c785`, `c63f8bb`, `ff1732a`, `6187217`, `e98353e`, `7d43028`, `7d17a65` (internal `symbolKey` helper and write-only `functionDepth` counter): the eight dead exports are gone, `TRACE_PHASES`/`resetQuickJS`/`restoreCode`/`scopeLogger` kept with a consumer or test. `tests/api-surface.test.js` 9/9 pins both the removals and the kept names. |
| D11 `env/misc.js` split | S3 | **Fixed** | `62c130d` split into `url`/`blob`/`navigator`/`platform-kit` (+ `dom-parser`, `eventsource` later). `ENV_MODULE_IDS` = 28, install order = `(order,id)`, zero `requires` violations, 28/28 strict install. Strictness by entry point: `installEnvironment()` defaults to `strict: true` and a missing requirement is a loud `SandboxError`; `TracelessSandbox.create({ env })` defaults to `strict: false`, which installs what resolves and leaves the rest `undefined` (documented in `README.md`). |
| D12 minor quality faults | S3 | **Fixed** | `b126492`/`6187217`: `meta.deferred` declared (`rename`) and consumed by `isDeferredPass`; `bridge.fn` indentation fixed; `bridge.call` and `adoptPrototype` removed. `restore-accuracy` asserts the deferral; CLI lists `deferred` per pass. |

### Audit findings

| Finding | Status | Evidence |
| --- | --- | --- |
| N1 (AUDIT-A) a sample-forged "stack overflow" message abandoned a healthy runtime | **Closed** | `94b1638` stopped classifying on the message alone; `829b1f4` replaced the dumped-name test with **intrinsic identity**; `5ef930e` added the host-callback witness so the converted engine shape is classified too. Measured on this tree: `throw {name:'InternalError',message:'Maximum call stack size exceeded'}`, a renamed `Error`, a plain `Error('stack overflow')`, and `new InternalError(...)` under a Firefox profile (reduced environment) all report `limitsHit: []`, `stackExhaustion: false`, `disposal {ok:true, errors:[]}`. **Narrow residual** (documented in `README.md` and `docs/SECURITY-MODEL.md`): at a reduced `limits.stackBytes` a guest that first causes a *genuine* overflow, catches it and reuses the caught error's prototype can forge the second classification; at the default 1 MB limit no guest-reachable prototype exists. `tests/resilience.test.js` 23/23. |
| F-B3 (AUDIT-FINAL-B) the forgery defence was defeated by the `stack` env module (Firefox) | **Fixed** | `env/stack.js` gives the `InternalError` wrapper its own prototype with the same own properties and the same `[[Prototype]]`, so the intrinsic prototype is unreachable while the surface stays faithful; if the wrapper cannot be installed, `stealth.revokeStackEvidence()` withdraws guest-dump certification for the run. `tests/resilience.test.js` "a Firefox profile cannot forge engine exhaustion in the full environment"; the regression test now installs the full environment (`env: {strict:true}`), not a reduced one. |
| F-B4 (AUDIT-FINAL-B) stack breaches were not always classified in the full environment | **Fixed** | `5ef930e` records the engine signal host-side before the trampoline converts it (`guardHostStackExhaustion` → `runtime.stackSignals()`); `invoke.js` reads the counter around the branch and builds one normalised record. 40 consecutive runs produce one distinct record and every run reports `error.stack === ''`. |
| F1 (FINAL-C) stack classification and reports were nondeterministic in the full environment | **Fixed** | Same commits. Two same-seed reports agree, and the 40-run loop asserts a single JSON shape for `{ok, limitsHit, error, disposal}`. |
| F2 (FINAL-C) three `[object Object]` brands and a missing `CustomElementRegistry` | **Fixed** | `5e40603`: `[object DOMParser]`, `[object XMLSerializer]`, `[object EventSource]`, and `CustomElementRegistry` is a global (enumerable false, native-looking source). `tests/env-fidelity.test.js` 16/16, `tests/env-surface.test.js` 18/18. Documented deviation: `customElements instanceof CustomElementRegistry` is still `false`. |
| F3 (FINAL-C) a strict recorder rejected the hook phases a bus forwards | **Fixed** | `4ad8c42`: hook events use trace phases `emit`/`transform` with the hook phase in the `hook` field, and `kind` is validated in every mode. `trace-budget` "hook trace events use a declared trace phase…" and "an unknown trace kind is rejected without strict phase validation". |
| F4 (FINAL-C) the removed `classifyLimit` deep-module export had no recorded reason | **Accepted** | It stays internal to `invoke.js`; behaviour is covered end-to-end by the classification tests, and `tests/api-surface.test.js` pins the exported surface. |
| F5 (FINAL-C) each breach costs host RSS forever | **Accepted + documented** | Measured 21.7 MB RSS per breach over six breaches (~17 MB in `FINAL-C`); the module is quarantined and recompiled, and `README.md`/`docs/SECURITY-MODEL.md` state the cost and recommend worker processes for long batches. |
| F1 (FINAL-D) the verdict scored the platform's own actions as sample behaviour | **Fixed** | `127ac98`: `behavior.js` attributes events (`eventOrigin`) and report scoring filters platform events, exposing `dynamic.behavior.counts.platform`. `report` "platform-emitted events never score as sample behaviour", "guest-originated DOM behaviour still scores", "platform policy mocks are not counted as anti-analysis". Measured effect: `examples/sample-loader.js` 60 malicious → 54 suspicious (71 of 133 events are platform events), `examples/benign.js` 6 → 0. |
| F2 (FINAL-D) per-call guest objects were retained until teardown | **Fixed** | `eca5305` releases the call bag with the call; `sandbox-core` "per-call value builders die with the call" and "a 20k-call builder loop stays on a memory plateau"; `bridge.deferred` releases host handles at settle. Residual documented: no host-heap cap. |
| F3 (FINAL-D) hook errors were size-unbounded and dropped from the report | **Fixed** | `4ad8c42` caps by count **and** characters (200 / 64 KiB, 2 KiB per message); `127ac98` carries the newest 50 into `hooks.errors` with `hooks.errorsTruncated`. `trace-budget` + `report` cover both. |
| F4 (FINAL-D) "a subset install either works or fails loudly" was false with defaults | **Fixed (doc)** | `README.md` and `ARCHITECTURE.md` now state the two defaults: `installEnvironment` `strict: true`, `TracelessSandbox.create({ env })` `strict: false`. Behaviour unchanged. |
| F5 (FINAL-D) invalid `profile`/`limits` options were not validated | **Fixed** | `9112141`: `requireEntry` throws `SandboxError` `SANDBOX_PROFILE` naming the accepted values; `normalizeLimits` defaults to `strict: true` and throws `SandboxError` `SANDBOX_LIMITS`, with `strict: false` warning through the logger instead. `sandbox-core` covers both. |
| F6 (FINAL-D) a malformed hook registration was silently discarded | **Fixed** | `7c1df9c`: `registerHooks` accepts the descriptor and the `[phase, handler, options?]` tuple forms, and throws `HookError` for anything else. `hook` 22/22. |
| F7 (FINAL-D) dead internal helpers and write-only counters | **Fixed** | `7d17a65` removed `symbolKey`, `functionDepth`, `previousName`. `bridge.stats` counters stay: they are typed public API and asserted by "bridge stats count the calls, errors and conversions that happened". |
| F8 (FINAL-D) a restoration failure was invisible in the report | **Fixed** | `127ac98`: `orchestrator.js` copies the pipeline error into `static.restoration.error`, `report.js` normalises it and Markdown prints `**Restoration error:**`. `report` "a restoration failure is preserved in the report". |
| F9 (FINAL-D) trace truncation was invisible and `tracing.dropped` understated it | **Fixed** | `127ac98`: the orchestrator derives `truncated`/`truncatedBy` (`code-budget` from the `code` budget or its marker, `event-limit` from dropped events) whether or not the marker survived the retained window; `7692660` labels the Markdown line with the cause. `report` "tracing carries an explicit, bounded truncation flag". |
| Observer entries were built inside the `observe()` bridge call, so the call bag freed them before delivery | **Fixed** | `8473a6a` queues plain record descriptors and builds entries at delivery time, and dups the observer instance so the callback's second argument outlives `init()`. Pre-fix, any property read of a delivered entry raised `QuickJSUseAfterFree`. `tests/env-observers.test.js` 14/14. |
| Observer target duplicates were kept past delivery | **Fixed** | `335c2d0` releases the `observe()`/`observeAll` target duplicate once the entry has copied it; `env-observers` asserts the harness disposal record stays `{ok:true, errors:[]}`. |
| Canvas handles that outlive the bridge call leaked (engine abort on dispose) | **Fixed** | `4201ae9`: `FontFaceSet.add` stored `face.dup()` with no owner, and `toBlob`/`img.src` handed a duplicate to a virtual-clock task that a short run never reached. `canvas.js` now keeps one `retain()` teardown set plus `release()` for early frees. `tests/env-canvas.test.js` 32/32 (`4201ae9`, `74c6eae`, `e655f0b`, `cde1fec`). |
| `new ImageData(w, h)` had no guest `data` view; `getLineDash()` returned a fresh empty array every call | **Fixed** | `74c6eae` installs one own `Uint8ClampedArray` over a guest `ArrayBuffer` (transparent black payload, Chrome dimension rules, 64 MiB ceiling) and stores the dash list on the context so `save()`/`restore()` carry it. Deviations kept and documented: `new ImageData(2)` reports the height rule instead of Chrome's arity `TypeError`; `getImageData` refuses a >4 MiB source with `RangeError`. |
| Dead microtask queue: `timers.js` kept a `microtasks` array and a `drainMicrotasks` hook that nothing ever fed | **Fixed** | `9122627`/`3013295` removed the array, the hook, its teardown loop and the caller's drain. Microtasks are the engine's promise jobs (`executePendingJobs`). `tests/timers.test.js` 7/7 asserts the FIFO order and that the module exposes no `drainMicrotasks`. |
| The suite printed `Aborted(…)` on stack-overflow runs | **Fixed** | `335c2d0` (observer duplicates) completed the handle-lifetime work, so the pinned run reports **612 pass / 0 fail** with **0** lines matching `Aborted(`; `5ef930e` keeps it at zero for the converted shape. `tests/resilience.test.js` and `tests/sandbox-core.test.js` capture engine output and fail on any assertion line. |
| F2 (AUDIT-D) fixed per-run cost from per-run guest-source compiles | **Accepted** | No latency criterion exists; `restore` 200 KB is unchanged. Measured on this tree: 34.4 ms against 26.0 ms for a `1+1` create+run+dispose cycle (median of 9, `1b0f2c7` vs `7c1df9c`), i.e. ~30 %. Recorded in `README.md` → Known limitations. |
| F3 (AUDIT-D) `_w6-fidelity-notes.md` stale (element own keys, wrapped-descriptor bug) | **Fixed** | Content folded into `README.md`/`SECURITY-MODEL.md` with the measured values (`Object.keys(div) = 0`, `Object.keys(WebAssembly) = 0`), then the file was deleted. |
| F4 (AUDIT-D) half-built DOM interface hierarchy | **Fixed** | `d9a3d60` builds real prototype chains. Measured in a strict run: `div instanceof Node/Element/HTMLElement` all true; chain `HTMLDivElement > HTMLElement > Element > Node > EventTarget`. Residual: `Attr`, `Range`, `ShadowRoot` absent (documented). |
| F1 (AUDIT-D) `tests/examples.test.js` narrowed to regular files | **Accepted** | The assertion documents regular sample files; a directory under `examples/` is a suite root, not a sample, and is not required to carry an `examples/README.md` row. Regular files are still fully covered. |
| Cross-runtime interruption leak (timeout while another run was parked at an `await`) | **Fixed** | `d7dc371` serializes guest runs on the shared WASM module (`withGuestRunLock`); concurrent callers queue, never reject. |
| AUDIT-B observations: top-level `changed` for a trailing newline; `validateOutput` sourceType is advisory | **Accepted** | Both documented in `README.md` (Known limitations) and `docs/API.md` (serialization note). |
| AUDIT-C observation: 14 DOM interface globals missing and undocumented | **Fixed** (mostly) | 12 of them are now installed (`d9a3d60`/`479d758`); `Attr`/`Range`/`ShadowRoot` remain and are listed as limitations. |
| F-B1/F-B2 and FINAL-A F1–F21 (documented counts measured on a dirty tree) | **Fixed** | This file, `README.md`, `DESIGN-REVIEW.md` and `EVALUATION-TOOLS.md` are pinned to `7c1df9c` with the command for each figure; corpus claims, `600/46`, `result.value = 55`, `21 invalid invocations`, `5/5` types, `47 commits` and the `136`-event trace tail are gone. |
| Coverage gate: `tools/` scope 92.99 / 82.68 / 90.62 vs baseline 88.08 / 75.26 / 80.33 | **Closed** | All three metrics are above the review baseline on the scope the baseline was measured on (`--test-coverage-exclude='examples/**'`): +4.91 lines, +7.42 branches, +10.29 functions. The whole-tree scope (90.32 / 78.88 / 86.92) is also above it; it is reported for completeness and the gate stays on the `tools/` scope it was defined on. Mechanism: the coverage round `758e225`/`06e099c`/`d145be9`/`b28db87` plus `8473a6a`/`4201ae9`/`74c6eae` added `env-observers`, `env-encoding`, `env-anti-fingerprint` and extended `env-canvas`, `hook`, `sandbox-core`, `resilience`, `env-misc`, `restore-*`. |

## Follow-up alignment wave (after Review 6)

Sixteen commits landed after the Review 6 documentation refresh
(`a8e4965..3013295`) and closed the handle-lifetime findings:

| Commit | Change | Regression |
| --- | --- | --- |
| `8473a6a` | Observer entries get an owned lifetime (records queued as descriptors, entries built at delivery, observer instance duped) | `tests/env-observers.test.js` (14) |
| `335c2d0` | Observer target duplicates released after delivery | `env-observers` disposal record |
| `4201ae9` | Canvas handles that outlive the bridge call are retained and released (`FontFaceSet.add`, `toBlob`, `img.src`) | `env-canvas` 32/32 |
| `74c6eae` | `new ImageData` gets its own `data` view and Chrome's dimension rules; `getLineDash` is tracked through `save()`/`restore()` | `env-canvas` |
| `829b1f4` | Stack exhaustion classified by **intrinsic identity**, not the dumped name | `resilience` + `sandbox-core` |
| `d593cff` | Forged records and reduced-`stackBytes` classification covered | `resilience` |
| `28d3fbf` | `Stealth.isIntrinsicStackError` declared in `types/` | `types` 6/6 |
| `9122627` / `3013295` | Dead microtask queue, hook and drain removed (microtasks are engine promise jobs) | `timers` 7/7 |
| `06e099c`, `758e225`, `d145be9`, `b28db87` | Coverage round: hook lifecycle/introspection, host-bridge contract, eval-unwrap/fold edges, codecs + hardening + dialogs + canvas surface | `hook`, `sandbox-core`, `restore-*` (147), `env-encoding` 12, `env-anti-fingerprint` 10 |

Result: **612 tests / 42 files, 0 failures, 0 `Aborted(` lines**, `tools/`-scope
coverage above the review baseline on all three metrics, and no unfixed
handle-lifetime finding.

## Final wave evidence (wave 11)

The wave that closed the final audits (`5ef930e` … `7c1df9c`, ten commits) changed
behaviour as well as counts. Each row names the check that keeps it.

| Change | Commit | Test |
| --- | --- | --- |
| Stack exhaustion: host-callback witness + one normalised record for both engine shapes | `5ef930e` | `resilience` 23/23, `sandbox-core` 44/44 |
| Full-environment determinism, forgery and reduced-limit coverage | `bc7d50f` | 40 consecutive runs → one record; every `EVENT_LOOP_DEFORMATIONS` shape |
| Per-call bridge ownership; deferred resolvers released at settle | `eca5305` | "per-call value builders die with the call", "a 20k-call builder loop stays on a memory plateau", "bridge.deferred releases its host handles once the promise has settled" |
| Hook trace phase inside the schema; `kind` validated in every mode; error ring bounded by 200 **and** 64 KiB | `4ad8c42` | `trace-budget` 9/9 |
| Dead `symbolKey` helper and write-only `functionDepth` counter removed | `7d17a65` | `instrumentation` 11/11 |
| Report attribution (`behavior.counts.platform`), `static.restoration.error`, bounded `hooks.errors`, `tracing.truncated`/`truncatedBy` | `127ac98` | `report` 15/15, `analysis-e2e` 14/14 |
| "Trace truncated" Markdown line labelled with its cause | `7692660` | `report` + `analysis-e2e` |
| `DOMParser`/`XMLSerializer`/`EventSource` brands, `CustomElementRegistry` global | `5e40603` | `env-fidelity` 16/16, `env-surface` 18/18 |
| Unknown `profile`/`limits` options are typed `SandboxError`s (`SANDBOX_PROFILE`, `SANDBOX_LIMITS`); `normalizeLimits(input, {strict:false})` warns instead | `9112141` | "a mistyped limit option is a usage error, not a silent default", "an unknown profile value is a typed error that names the accepted ones" |
| `registerHooks` accepts tuple and list forms and rejects malformed registrations | `7c1df9c` | `hook` 22/22 |

Measured consequences on the pinned tree (commands in the sections above):

- `analyze examples/sample-loader.js` → score **54** / `suspicious` with **8**
  reasons instead of 60 / `malicious` with 9, because **71** of its 133 trace
  events are platform events and no longer score as sample DOM behaviour.
- `analyze examples/benign.js` → score **0** / `benign` (previously 6).
- `run --events examples/sample-loader.js` → **132** events.
- `TracelessSandbox` with `env: { only: ['misc'] }` (default `strict: false`) still
  runs, with `URL` `undefined` in the guest; the same options with
  `strict: true` throw
  `SandboxError: environment module "misc" missing requirement globals`.

## Examples evidence

```
$ node --test tests/examples.test.js
ℹ tests 12
ℹ pass 12
ℹ fail 0

$ bash examples/cli-usage.sh ; echo $?
0

$ node examples/national-sdk/verify.mjs | tail -2
37/37 checks passed
sandbox: 341 trace events, disposal {"ok":true,"errors":[]}
```

All 11 committed samples analyse cleanly, including `anti-analysis.js` (sandbox
reports no findings), `jsvmp-sample.js` (14 opcodes, traced dispatch),
`eval-chain.js` and `staged-payload.js` (decoded artifacts), `network-c2.js`
(mocked `net` events and IOCs). Four programmatic demos and
`examples/cli-usage.sh` run offline.

CLI evidence (stdout parseable with logs on stderr, plain and `--pretty`):

```
$ node tools/cli.js analyze examples/sample-loader.js --json | jq .verdict
{score:54,level:"suspicious",confidence:0.91,families:["c2","evasion","network","obfuscation","persistence"]}
$ node tools/cli.js analyze examples/benign.js --json | jq .verdict
{score:0,level:"benign",…}
$ node tools/cli.js restore examples/sample-loader.js | head
<decoded endpoint + config; string array removed>
$ node tools/cli.js run examples/benign.js --json | jq '.ok,.result,.disposal'
true
{"type":"undefined"}
{"ok":true,"errors":[]}
```

Example corpora that are not tracked at the pinned commit (`examples/products`,
`examples/works`, `examples/suite`, `examples/mega`) and their contract tests are
outside this record: no table above counts them and no number above depends on
them.
