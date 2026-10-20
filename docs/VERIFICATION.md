# Verification record

This file records how each requirement of the objective was verified, with the
authoritative command and outcome. It is regenerated at the end of the build and
kept under version control so the evidence is reviewable without rerunning
history.

Every number below was produced by the command named next to it, on the tree at
the commit that last touched this file. Nothing here is copied from an earlier
revision of the document.

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
$ node --test --test-concurrency=1 tests/*.test.js
ℹ tests 600
ℹ suites 0
ℹ pass 600
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 80256.719
```

`pnpm test` runs exactly that command. The captured log contains **0** lines
matching `Aborted(` — that is, no engine heap assertion escapes from any stack,
timer or promise-job breach (section "Sandbox resilience evidence").

### Coverage

Coverage is recorded on **two scopes**, because the review baseline was measured
on `tools/` while `examples/` now holds large example suites that the tests
execute rather than assert on.

```
$ node --test --test-concurrency=1 --experimental-test-coverage tests/*.test.js
ℹ tests 600
ℹ pass 600
ℹ fail 0
ℹ all files                               |  97.22 |    74.41 |   90.43 |

$ node --test --test-concurrency=1 --experimental-test-coverage \
    --test-coverage-exclude='examples/**' tests/*.test.js
ℹ tests 600
ℹ pass 600
ℹ fail 0
ℹ all files                               |  93.02 |    83.05 |   91.48 |
```

| Metric | Whole tree | `tools/` scope | Review baseline (`docs/EVALUATION-TOOLS.md`) | `tools/` vs baseline |
| --- | --- | --- | --- | --- |
| Lines | 97.22 % | **93.02 %** | 88.08 % | **+4.94** |
| Branches | 74.41 % | **83.05 %** | 75.26 % | **+7.79** |
| Functions | 90.43 % | **91.48 %** | 80.33 % | **+11.15** |

**The review gate is applied to the `tools/` scope** (L8 acceptance criterion
`lines >= 88 / branches >= 75 / functions >= 80`), because `examples/` is outside
`tools/` and its works are evidence fixtures, not platform code. That scope is
above the baseline on all three metrics — branches by 7.79 points, where the
previous refresh was 1.7 points below it. The whole-tree scope is reported for
completeness: its branch figure (74.41 %) is dominated by example code that is
executed, not asserted, and is an accepted, documented gap rather than a
re-based gate (`README.md` → "Known limitations").

## Test files (46) and observed counts

`node --test --test-concurrency=1 tests/<file>` per file, run on the same tree:

| File | Tests | File | Tests |
| --- | --- | --- | --- |
| `analysis-e2e` | 8 | `jsvmp-analyze` | 6 |
| `api-instrumentation` | 3 | `jsvmp-builder` | 9 |
| `api-surface` | 9 | `jsvmp-trace` | 7 |
| `cli` | 30 | `logging` | 6 |
| `determinism` | 2 | `national-sdk` | 13 |
| `env-anti-fingerprint` | 10 | `report` | 7 |
| `env-canvas` | 32 | `resilience` | 18 |
| `env-dom` | 16 | `restore-accuracy` | 10 |
| `env-encoding` | 12 | `restore-anti-analysis` | 12 |
| `env-fidelity` | 15 | `restore-control-flow` | 16 |
| `env-intl` | 12 | `restore-fold` | 24 |
| `env-misc` | 19 | `restore-pipeline` | 17 |
| `env-network` | 18 | `restore-string-array` | 17 |
| `env-observers` | 14 | `restore-strings` | 14 |
| `env-storage` | 1 | `restore-unwrap` | 37 |
| `env-surface` | 18 | `sandbox-core` | 36 |
| `env-time` | 15 | `timers` | 7 |
| `examples` | 12 | `trace-budget` | 5 |
| `examples-mega` | 4 | `traceless` | 16 |
| `examples-products` | 6 | `types` | 6 |
| `examples-suite` | 6 | `hook` | 20 |
| `examples-works` | 6 | `instrumentation` | 11 |
| `ioc` | 8 | `invocation` | 10 |

Sum: **600 tests across 46 files** — the same total the suite reports
(`node --test --test-concurrency=1 tests/<file>.test.js` per row).

Test files are the regression layer for every finding in this document: the
alignment lanes added `resilience` (D1/D2), `determinism` (D3),
`trace-budget` (D4), `restore-accuracy` (D5), `env-fidelity` (D6 probes in a real
sandbox), `api-instrumentation` (wrapped-descriptor and timer-release fixes),
`api-surface` (D10 export surface, kept-and-used names) and `types` (D9.4
declarations). The last alignment wave added `env-observers` (`8473a6a`,
`335c2d0`), `env-encoding` and `env-anti-fingerprint` (`b28db87`), and extended
`env-canvas` (32), `hook` (20), `sandbox-core` (36), `resilience` (18),
`env-misc` (19) and the `restore-*` files for the coverage round
(`758e225`/`06e099c`/`d145be9`/`b28db87`). The `examples-{products,works,suite,mega}`
contract suites belong to the examples lane and are counted here because they run
in the same command.

## Requirement → implementation → evidence

| Requirement | Implementation | Evidence (command) |
| --- | --- | --- |
| Sandbox built on quickjs-emscripten | `tools/sandbox/runtime.js`, `sandbox.js` | `node --test tests/sandbox-core.test.js` — 36/36 |
| Traceless base: isolation, no detection, no info collection, no honeypots/booby traps | `tools/sandbox/{sandbox,profile,integrity,limits,clock}.js`, `tools/sandbox/env/*` (28 modules), `tools/sandbox/env/anti-fingerprint.js` | `node --test tests/traceless.test.js` — 16/16; `tests/env-surface.test.js` — 18/18 |
| Fresh state per run (no cross-sample residue) | `sandbox.run()` creates runtime + context; full handle disposal; one guest run at a time per process | `sandbox-core` isolation + disposal assertions; `run.disposal.ok`; `resilience` — 18/18 |
| Traceless invocation | `tools/invocation/{invoke,stealth}.js` | `node --test tests/invocation.test.js` — 10/10 |
| Traceless Code/API/Exception/AST instrumentation | `tools/instrumentation/{code,api,exception,ast,index}.js` | `node --test tests/instrumentation.test.js` — 11/11; `api-instrumentation` — 3/3; byte-identical `toString` assertion in `traceless` |
| JSVMP interpreter instrumentation | `tools/instrumentation/jsvmp.js` + `tools/jsvmp/*` | `node --test tests/jsvmp-trace.test.js` — 7/7 (319 opcode events, 14 distinct opcodes, obfuscated VM traces identically) |
| Traceless Code/API/Exception/AST hooks | `tools/hook/{hookbus,code-hook,api-hook,exception-hook,ast-hook,index}.js` | `node --test tests/hook.test.js` — 20/20; `trace-budget` — 5/5 |
| Babel code restoration (unified parse/transform/generate), output validated | `tools/restore/{parse,generate,pass-context,index}.js`, `passes/` (11 passes) | `node --test tests/restore-*.test.js` — 8 files / 147 tests, semantics preservation by execution, `outputValid` fallback |
| Pass `changed` is evidence-bound and the pipeline is a fixed point | `tools/restore/pass-context.js` (`compareGeneratedText`), `passes/{strings,jsfuck}.js` | `restore-accuracy` 10/10; second application reports `changed:false` on all 11 `examples/*.js` |
| Logging with pino / pino-pretty | `tools/logging/logger.js` | `node --test tests/logging.test.js` — 6/6; `node tools/cli.js passes --pretty` renders via pino-pretty |
| Final implementation under `tools/` | 91 JS modules / 34 377 lines | `find tools -name '*.js' \| wc -l` = 91; `find tools -name '*.js' -exec cat {} + \| wc -l` = 34377 |
| Tests under `tests/` | 46 test files + `tests/helpers/` | `ls tests/*.test.js \| wc -l` = 46 |
| Public surface | 68 exports from `tools/index.js`; 11 `exports` subpaths with `types` | `node -e "import('./tools/index.js').then(m=>console.log(Object.keys(m).length))"` → 68; `types` — 6/6 |
| Composable auxiliary analysis | `tools/analysis/*` (IOC, report, behaviour, artifacts, stages, orchestrator), CLI, hooks, passes | `node --test tests/analysis-e2e.test.js tests/cli.test.js` — 38/38 |
| CLI contract: strict validation, exit codes, stdout purity | `tools/cli.js` | `node --test tests/cli.test.js` — 30/30 |
| Environment fidelity (D6 surfaces) | `tools/sandbox/env/*`: DOM hierarchy, `dom-parser`, `eventsource`, `url`, `blob`, `navigator`, `globals` (WebAssembly + isolation triple) | `env-fidelity` 15/15, `env-dom` 16/16, `env-surface` 18/18, `env-misc` 19/19, `env-observers` 14/14, `env-encoding` 12/12, `env-canvas` 32/32, `env-network` 18/18 |
| Deterministic runs | seeded profile/clock/PRNG; `anti-fingerprint` reports a count, never a handle address | `determinism` 2/2 (identical dynamic events after removing `wall`; identical report after removing timing) |
| Runnable examples / ecosystem docs | `examples/*.js` (11 samples), `examples/*.mjs` (4 demos), `examples/build-jsvmp-sample.mjs`, `examples/cli-usage.sh`, `examples/README.md` | `node --test tests/examples.test.js` — 12/12 (all samples execute; all demos and the CLI cookbook run); `bash examples/cli-usage.sh` → exit 0 |
| Hardened national JS-SDK | `examples/national-sdk/` (signing, fingerprint, white-box crypto, JSVMP, zero-trust guard, build pipeline, server verifier, docs) | `node --test tests/national-sdk.test.js` — 13/13; `node examples/national-sdk/verify.mjs` — 37/37 |
| Many subagents used | Parallel workers for env modules, restoration passes, JSVMP, IOC/report, plus research + review + audit agents | session history; artefacts summarised in "Review" below |

## CLI evidence

```
$ node tools/cli.js analyze examples/sample-loader.js --json
verdict.level = "malicious", verdict.score = 60, 3 URL IOCs, 4 artifacts

$ node tools/cli.js restore examples/sample-loader.js | head -3
<decoded source; string array and hex escapes removed>

$ node tools/cli.js run examples/benign.js --json
ok = true, result.value = 55, disposal.ok = true

$ node tools/cli.js passes --json
11 passes: strings:30 constant-fold:35 member-fold:40 string-array:50
jsfuck:55 proxy-unwrap:60 dead-code:65 control-flow:70 anti-analysis:75
eval-unwrap:80 rename:90   (rename: deferred true, the rest deferred false)
```

`--json` keeps stdout pure JSON (logs go to fd 2), `--out -` writes the result to
stdout, `--arg` parses JSON-or-string, and every invalid option value is a usage
error: **exit 2, message on stderr, empty stdout** (21 invalid invocations in
`tests/cli.test.js`). Exit codes: `0` success, `1` analysis/run failure, `2`
usage error.

## Sandbox resilience evidence

```
12 × function f(n){return f(n+1)} f(0), then a normal run (one process):
every stack run: limitsHit ["stack"], stackExhaustion true,
                 disposal {ok:false, leaked:true, stage:'runtime', skipped:true}
normal run:      ok true, value 2, disposal {ok:true, errors:[]}
$ grep -c Aborted  →  0
```

- A stack breach is classified from the **engine signal only**, never from a
  dumped guest name or message: the host-thrown `RangeError` ("Maximum call stack
  size exceeded") out of `evalCode`, `callFunction` or `executePendingJobs`
  (`runtime.js` `isHostStackExhaustion`), or — for interpreter recursion, which
  QuickJS raises as its own `InternalError` — intrinsic identity through
  `stealth.isIntrinsicStackError(handle)`, which requires the engine's captured
  `InternalError.prototype` in the thrown value's chain and refuses to certify
  while that constructor is guest-reachable. Ordering: that pair →
  `invoke.js` `stackExhaustion` → `sandbox.js` abandon decision. The runtime is
  then **abandoned** (never disposed), the WASM module is quarantined and the
  next run recompiles it.
- The same breach inside a timer or promise callback is classified and recorded
  in `run.settle.stackExhaustion`; `run.ok` stays `true` for the script itself
  and `run.disposal` still reports the leak.
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
- `crypto.subtle` exposes `digest` and `generateKey`; AES/HMAC/`importKey` are not
  implemented.
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
- Stack-breach classification is **intrinsic**: `stealth.isIntrinsicStackError()`
  requires the engine's captured `InternalError.prototype` in the thrown value's
  prototype chain and refuses to certify while that constructor is
  guest-reachable, so a forged record, a renamed `Error` and a prototype
  stand-in no longer classify. The one residual needs a **reduced**
  `limits.stackBytes` (interpreter check instead of the WASM native stack) plus a
  guest that catches a genuine overflow and reuses its prototype; it costs an
  abandoned runtime for a run that already breached the stack.
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
re-checked the aligned tree. Findings and dispositions are recorded in
`docs/DESIGN-REVIEW.md`; the alignment outcome is the matrix below.

## Final audit (post-review)

Executed after all review dispositions, on the authoritative tree:

```
$ node --test --test-concurrency=1 tests/*.test.js
ℹ tests 600
ℹ pass 600
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
`R*`, plus the handle-lifetime findings `L1`–`L5` of the last alignment wave) come
from `.pi/audits/AUDIT-{A,B,C,D}-*.md` and `docs/DESIGN-REVIEW.md`. "Fixed" always
names the commit that changed the code and the test that keeps it fixed.

### D1–D12

| Id | Severity | Status | Evidence |
| --- | --- | --- | --- |
| D1 runtime/module poisoning | S1 | **Fixed** | `7836126` quarantine + `loadQuickJS` re-acquire; `9e9f3cf`/`94b1638` abandon from the engine marker only; `markModuleUnhealthy` stays internal. `tests/resilience.test.js` 18/18 ("12 consecutive stack overflows…", "a failed disposal quarantines the module…"), `tests/sandbox-core.test.js` 36/36. 12-run reproducer: `disposal {ok:false, leaked:true, stage:'runtime', skipped:true}`, then a normal run `ok:true`, `0` `Aborted` lines. |
| D2 guarded acquisition + typed errors | S1 | **Fixed** | `75eb922` acquisition inside the guarded region; `sandbox.js` wraps escaping errors as `SandboxError` (`SANDBOX_INIT`/`SANDBOX_RUN`, `cause`, non-empty message). `tests/resilience.test.js` init-failure and post-acquisition cases; no unhandled rejection. |
| D3 `moved` is a count | S2 | **Fixed** | `2ecd382` `bridge.num([call.value],0)` + clamp (0…1000). `tests/determinism.test.js` 2/2: `moved` integer, `0 < moved < 10000`, identical dynamic events across same-seed runs. Pre-fix it reported a handle address (~4.7e7). |
| D4 trace/hook budget | S2 | **Fixed** | `3118a60` unlistened phases are not traced or counted, `code:step` declared and untraced, errors bounded at 200 + `errorsTruncated`. `tests/trace-budget.test.js` 5/5: 20-iteration loop → `byKind.hook = 2`, `code = 45`. |
| D5 restoration accuracy + output validation | S2 | **Fixed** | `a8b7e85` `changed` = generated-text change (`compareGeneratedText`); `9578faf` `validateOutput`/`outputValid`/`outputError` + input fallback. `tests/restore-accuracy.test.js` 10/10: 0/11 pipeline and 0/121 per-pass fixed-point failures; `validateOutput('function (')` false. |
| D6 missing/incoherent browser surfaces | S1 | **Fixed** (docs half included) | `26ff5cb` WebAssembly stub + isolation triple; `7896d0b` HTMLElement/tag interfaces/customElements; `24d4670` DOMParser/XMLSerializer/EventSource; `d9a3d60`/`479d758` real prototype chains and XMLDocument; `736e177` `Object.keys(element).length === 0`; `b28cba4`/`c41a172` `checked` derived (20). `env-surface` 18/18, `env-fidelity` 15/15, `env-dom` 16/16. Documentation: `README.md` "Known limitations", `docs/SECURITY-MODEL.md` WASM/`SharedArrayBuffer` sections. |
| D7 CLI contract | S2 | **Fixed** | `09eae89` closed-set validation, `--out` write failures as usage errors; `faa0cb1` matrix tests. `tests/cli.test.js` 30/30: 21 invalid invocations → exit 2, stderr message, empty stdout; `--out -` writes to stdout; `--json` stdout stays pure. |
| D8 docs/contracts drift | S3 | **Fixed** (this file) | This alignment commit: `CONTRACTS.md` rewritten against `tools/sandbox/bridge.js`, `tools/instrumentation/trace.js`, `tools/hook/hookbus.js`, `tools/sandbox/env/index.js`, `tools/restore/*`; counts regenerated; `DESIGN-REVIEW.md` Review 6; `SECURITY-MODEL.md`, `README.md`, `API.md`, `ARCHITECTURE.md` corrected. |
| D9 packaging/metadata | S3 | **Fixed** | `207e170` LICENSE (ISC) + `files` whitelist + subpath `exports`; `6319a5a` z3-solver removed from `package.json` and lockfile; `3334341` `types/*.d.ts`. `git ls-files -s tools/cli.js` → `100755`; `npm pack --dry-run` → **114 files** (91 tools + 9 docs + 11 types + `README.md` + `LICENSE` + `package.json`), only `tools/ docs/ types/ README.md LICENSE package.json`; `tests/types.test.js` 6/6. |
| D10 dead exports/stubs | S3 | **Fixed** | `a57c785`, `c63f8bb`, `ff1732a`, `6187217`, `e98353e`, `7d43028`: the eight dead names are gone, `TRACE_PHASES`/`resetQuickJS`/`restoreCode`/`scopeLogger` kept with a consumer or test. `tests/api-surface.test.js` 9/9 pins both the removals and the kept names. |
| D11 `env/misc.js` split | S3 | **Fixed** | `62c130d` split into `url`/`blob`/`navigator`/`platform-kit` (+ `dom-parser`, `eventsource` later). `ENV_MODULE_IDS` = 28, install order = `(order,id)`, zero `requires` violations, 28/28 strict install, a missing requirement is a loud `SandboxError`. |
| D12 minor quality faults | S3 | **Fixed** | `b126492`/`6187217`: `meta.deferred` declared (`rename`) and consumed by `isDeferredPass`; `bridge.fn` indentation fixed; `bridge.call` and `adoptPrototype` removed. `restore-accuracy` asserts the deferral; CLI lists `deferred` per pass. |

### Audit findings

| Finding | Status | Evidence |
| --- | --- | --- |
| N1 (AUDIT-A) a sample-forged "stack overflow" message abandoned a healthy runtime | **Closed** | `94b1638` stopped classifying on the message alone; `829b1f4` closed the remaining forgery by replacing the dumped-name test with **intrinsic identity**. `stealth.install()` captures the engine's `InternalError.prototype` before `env/globals.js` removes the binding, and `stealth.isIntrinsicStackError(handle)` answers from the live handle: the prototype chain must contain that captured prototype, and the probe refuses to certify while the constructor is still guest-reachable (Firefox profile). Measured on this tree: `throw {name:'InternalError',message:'Maximum call stack size exceeded'}`, a renamed `Error`, and `new InternalError(...)` under a Firefox profile all report `limitsHit: []`, `stackExhaustion: false`, `disposal {ok:true, errors:[]}`. **Narrow residual** (documented in `README.md` and `docs/SECURITY-MODEL.md`): at a reduced `limits.stackBytes` a guest that first causes a *genuine* overflow, catches it and reuses the caught error's prototype can forge the second classification; at the default 1 MB limit no guest-reachable prototype exists. `tests/resilience.test.js` 18/18 pins all four cases (`829b1f4`, `d593cff`). |
| Observer entries were built inside the `observe()` bridge call, so the call bag freed them before delivery | **Fixed** | `8473a6a` queues plain record descriptors and builds entries at delivery time, and dups the observer instance so the callback's second argument outlives `init()`. Pre-fix, any property read of a delivered entry raised `QuickJSUseAfterFree`. `tests/env-observers.test.js` 14/14 (new file). |
| Observer target duplicates were kept past delivery | **Fixed** | `335c2d0` releases the `observe()`/`observeAll` target duplicate once the entry has copied it; `env-observers` asserts the harness disposal record stays `{ok:true, errors:[]}`. |
| Canvas handles that outlive the bridge call leaked (engine abort on dispose) | **Fixed** | `4201ae9`: `FontFaceSet.add` stored `face.dup()` with no owner, and `toBlob`/`img.src` handed a duplicate to a virtual-clock task that a short run never reached. `canvas.js` now keeps one `retain()` teardown set plus `release()` for early frees. A real `document.fonts.add()` sample reported `disposal {ok:false, leaked:true}` and printed `Aborted(…)`; it now tears down cleanly. `tests/env-canvas.test.js` 32/32 (`4201ae9`, `74c6eae`, `e655f0b`, `cde1fec`). |
| `new ImageData(w, h)` had no guest `data` view; `getLineDash()` returned a fresh empty array every call | **Fixed** | `74c6eae` installs one own `Uint8ClampedArray` over a guest `ArrayBuffer` (transparent black payload, Chrome dimension rules, 64 MiB ceiling) and stores the dash list on the context so `save()`/`restore()` carry it. Deviation kept and documented: `new ImageData(2)` reports the height rule instead of Chrome's arity `TypeError`. |
| Dead microtask queue: `timers.js` kept a `microtasks` array and a `drainMicrotasks` hook that nothing ever fed | **Fixed** | `9122627`/`3013295` removed the array, the hook, its teardown loop and the caller's drain. Microtasks are the engine's promise jobs (`executePendingJobs`). `tests/timers.test.js` 7/7 asserts the FIFO order and that the module exposes no `drainMicrotasks`. |
| The suite printed `Aborted(…)` on stack-overflow runs | **Fixed** | `335c2d0` (observer duplicates) completed the handle-lifetime work, so `node --test --test-concurrency=1 tests/*.test.js` now reports **600 pass / 0 fail** with **0** lines matching `Aborted(` in the captured log; `tests/resilience.test.js` and `tests/sandbox-core.test.js` capture engine output and fail on any assertion line. |
| F2 (AUDIT-D) fixed per-run cost +28 % from per-run guest-source compiles | **Accepted** | No latency criterion exists; `restore` 200 KB is unchanged. Recorded in `README.md` → Known limitations. |
| F3 (AUDIT-D) `_w6-fidelity-notes.md` stale (element own keys, wrapped-descriptor bug) | **Fixed** | Content folded into `README.md`/`SECURITY-MODEL.md` with the measured values (`Object.keys(div) = 0`, `Object.keys(WebAssembly) = 0`), then the file was deleted. |
| F4 (AUDIT-D) half-built DOM interface hierarchy | **Fixed** | `d9a3d60` builds real prototype chains. Measured in a strict run: `div instanceof Node/Element/HTMLElement` all true; chain `HTMLDivElement > HTMLElement > Element > Node > EventTarget`. Residual: `Attr`, `Range`, `ShadowRoot` absent (documented). |
| F1 (AUDIT-D) `tests/examples.test.js` narrowed to regular files | **Accepted** | Directory coverage is lost by design (the examples directory now contains sub-suites documented in `examples/README.md`); files are still covered. Test file owned by the examples lane. |
| Cross-runtime interruption leak (timeout while another run was parked at an `await`) | **Fixed** | `d7dc371` serializes guest runs on the shared WASM module (`withGuestRunLock`); concurrent callers queue, never reject. |
| AUDIT-B observations: top-level `changed` for a trailing newline; `validateOutput` sourceType is advisory | **Accepted** | Both documented in `README.md` (Known limitations) and `docs/API.md` (serialization note). |
| AUDIT-C observation: 14 DOM interface globals missing and undocumented | **Fixed** (mostly) | 12 of them are now installed (`d9a3d60`/`479d758`); `Attr`/`Range`/`ShadowRoot` remain and are listed as limitations. |
| Coverage gate: `tools/` scope 93.02 / 83.05 / 91.48 vs baseline 88.08 / 75.26 / 80.33 | **Closed** | All three metrics are above the review baseline on the scope the baseline was measured on (`--test-coverage-exclude='examples/**'`): +4.94 lines, +7.79 branches, +11.15 functions. The previous refresh's 1.7-point branch deficit is gone. The whole-tree scope (97.22 / 74.41 / 90.43) is recorded for completeness only: `examples/` is outside `tools/` and its works are evidence fixtures, so the gate is not applied there (accepted, documented gap). Mechanism: the coverage round `758e225`/`06e099c`/`d145be9`/`b28db87` plus `8473a6a`/`4201ae9`/`74c6eae` added `env-observers`, `env-encoding`, `env-anti-fingerprint` and extended `env-canvas`, `hook`, `sandbox-core`, `resilience`, `env-misc`, `restore-*`. |

## Last alignment wave (after Review 6)

Sixteen commits landed after the Review 6 documentation refresh
(`a8e4965..3013295`) and are the state this file measures:

| Commit | Change | Regression |
| --- | --- | --- |
| `8473a6a` | Observer entries get an owned lifetime (records queued as descriptors, entries built at delivery, observer instance duped) | `tests/env-observers.test.js` (14) |
| `335c2d0` | Observer target duplicates released after delivery | `env-observers` disposal record |
| `4201ae9` | Canvas handles that outlive the bridge call are retained and released (`FontFaceSet.add`, `toBlob`, `img.src`) | `env-canvas` 32/32 |
| `74c6eae` | `new ImageData` gets its own `data` view and Chrome's dimension rules; `getLineDash` is tracked through `save()`/`restore()` | `env-canvas` |
| `829b1f4` | Stack exhaustion classified by **intrinsic identity**, not the dumped name | `resilience` + `sandbox-core` |
| `d593cff` | Forged records and reduced-`stackBytes` classification covered | `resilience` 18/18 |
| `28d3fbf` | `Stealth.isIntrinsicStackError` declared in `types/` | `types` 6/6 |
| `9122627` / `3013295` | Dead microtask queue, hook and drain removed (microtasks are engine promise jobs) | `timers` 7/7 |
| `06e099c`, `758e225`, `d145be9`, `b28db87` | Coverage round: hook lifecycle/introspection, host-bridge contract, eval-unwrap/fold edges, codecs + hardening + dialogs + canvas surface | `hook` 20, `sandbox-core` 36, `restore-*` 147, `env-encoding` 12, `env-anti-fingerprint` 10 |

Result: **600 tests / 46 files, 0 failures, 0 `Aborted(` lines**, `tools/`-scope
coverage above the review baseline on all three metrics, and no unfixed
handle-lifetime finding.

## Examples evidence

```
$ node --test tests/examples.test.js
ℹ tests 12
ℹ pass 12
ℹ fail 0

$ node examples/products/run-all.mjs
50/50 products satisfied their expectations

$ node --test tests/examples-products.test.js
ℹ tests 6
ℹ pass 6
ℹ fail 0

$ node examples/works/run-all.mjs
30/30 works verified

$ node --test tests/examples-works.test.js
ℹ tests 6
ℹ pass 6
ℹ fail 0

$ node examples/suite/run-all.mjs
30/30 works verified | effective code 562.8KB (raw 684.7KB)

$ node --test tests/examples-suite.test.js
ℹ tests 6
ℹ pass 6
ℹ fail 0

$ node examples/mega/run-all.mjs
18/18 works verified | effective 70.32MB (raw 70.47MB)

$ node --test tests/examples-mega.test.js
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

Suite II (built by six parallel subagents) contributes 10 JS security SDKs
(each with >=5 assertions in `verify.mjs`), 12 sandbox-analysed virus samples
with declared contracts, and 8 applications with `--self-test`. Its runner
computes effective code as source with block/line comments and blank lines
stripped, and **fails the run below 100KB**; the current suite measures
**562.8KB effective / 684.7KB raw**, with every package >=2.5KB to prevent stubs.

MEGA (built by six parallel subagents) contributes **18 single-file works** —
8 virus samples, 8 JS security SDKs and 2 applications — with exactly one
JavaScript file per work and no imports, modules or libraries. The runner
rejects `require`/`import`/`export`/`module.exports`/AMD/`node:`/WASM loading,
rejects subdirectories and extra code files, executes every work and reads its
`MEGA METRICS`, and enforces **≥2.8MB effective code per work** plus
**≥50MB effective across the suite**. The current run verifies **18/18,
70.32MB effective / 70.47MB raw**, with every work >=3.50MB, white-box >=3,
custom ciphers >=3, encodings >=3, `jsvmpOps` 90,046–696,903, `envChecks`
64–240, `documentAll:true` and anti-debug >=5. `tests/examples-mega.test.js`
independently recomputes the 50MB total, checks single-file purity/type mix,
index coverage and the JSON gate.

Works suite: 10 JS security SDKs (each with >=5 assertions in its own
`verify.mjs`), 12 virus samples analysed in the strict sandbox against declared
contracts (verdict/score/IOCs/artifacts/techniques/trace kinds/JSVMP/integrity/
disposal), and 8 complete applications validated via `--self-test`. The runner
fails on any drift and reports 30/30.

Product suite: 50 packages (37 commercial, 13 military; 20 CRITICAL, 25 HIGH,
5 MEDIUM) in 50 distinct categories, each with a machine-validated expectation
contract (verdict level, minimum score, IOC categories, artifact kinds,
technique labels, trace kinds, optional JSVMP detection and mock network
routes). The runner analyses every sample in the strict sandbox and fails on any
drift.

All 11 samples analyse cleanly, including `anti-analysis.js` (sandbox reports no
findings), `jsvmp-sample.js` (14 opcodes, traced dispatch), `eval-chain.js` and
`staged-payload.js` (decoded artifacts), `network-c2.js` (mocked `net` events and
IOCs). Four programmatic demos and `examples/cli-usage.sh` run offline.

CLI evidence (stdout parseable with logs on stderr, plain and `--pretty`):

```
$ node tools/cli.js analyze examples/sample-loader.js --json | jq .verdict
{score:60,level:"malicious",…}
$ node tools/cli.js analyze examples/benign.js --json | jq .verdict
{score:6,level:"benign",…}
$ node tools/cli.js restore examples/sample-loader.js | head
<decoded endpoint + config; string array removed>
$ node tools/cli.js run examples/benign.js --json | jq '.ok,.disposal.ok'
true
true
```

## MEGA requirement → evidence

| Requirement | Evidence (authoritative) |
| --- | --- |
| ≥50MB effective code (comments/blank lines stripped) | `node examples/mega/run-all.mjs` → `18/18 works verified | effective 70.32MB (raw 70.47MB)`; `tests/examples-mega.test.js` independently recomputes the total and asserts ≥50,000,000 bytes |
| Pure JS, no libraries, no package/module split | runner + test reject `require(`, `import`, `export`, `module.exports`, AMD `define`, `node:` and WASM loading; exactly one `.js` file per work; no subdirectories or extra code files |
| Per-work substance (no stubs) | runner enforces ≥2.8MB effective per work; measured minimum is 3.50MB (works 07–09) |
| Black-hole obfuscation + fortress JSVMP | every `work.json` declares `blackhole/fortressJsvmp/dynamic/polymorphic/adversarial: true`; every runtime prints `jsvmpOps` 90,046–696,903 and executes its self-test |
| Dynamic implicit white-box + mutated ciphers + custom encodings + mixed encryption | runner checks per-work manifest minima `whitebox>=3`, `customCiphers>=3`, `encodings>=3`, `mixed:true`; metrics confirm 3/3/3 (01–03 and 10–12 use 4 custom ciphers/encodings); self-tests round-trip mixed pipelines |
| Rendering-engine-level detection incl `document.all` | metrics report `envChecks` 64–240 and `documentAll:true`; probe matrices cover HTMLDDA `typeof`/falsy/`length`/`item`/`namedItem`, CSS, WebGL, canvas, fonts, iframe realms, layout, audio/media/permissions, screen/DPR, matchMedia, Intl, storage, workers, WASM availability |
