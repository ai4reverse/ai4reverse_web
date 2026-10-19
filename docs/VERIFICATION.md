# Verification record

This file records how each requirement of the objective was verified, with the
authoritative command and outcome. It is regenerated at the end of the build and
kept under version control so the evidence is reviewable without rerunning
history.

## Environment

- Node.js v24.19.0 (contract requires >= 22.18), pnpm 12.14.
- Dependency set: `quickjs-emscripten@0.32.0`, `@babel/{parser,traverse,generator,types,template}@8.x`,
  `pino@10`, `pino-pretty@13`, `z3-solver@5` (available; not required at runtime
  by the default pipeline).
- No network access is required or performed by the platform or its tests.

## Full suite

```
$ pnpm test
ℹ tests 361
ℹ pass 361
ℹ fail 0
ℹ duration_ms 43550
```

Test files (30) cover: sandbox core, traceless detection corpus, invocation,
instrumentation, hooks, logging, 11 restoration passes + pipeline, JSVMP
builder/analyzer/trace, IOC/report, analysis end-to-end, CLI, every environment
module (time/dom/intl/network/misc/canvas) and a strict full-surface integration
test.

## Requirement → implementation → evidence

| Requirement | Implementation | Evidence (command) |
| --- | --- | --- |
| Sandbox built on quickjs-emscripten | `tools/sandbox/runtime.js`, `sandbox.js` | `node --test tests/sandbox-core.test.js` — 14/14 |
| Traceless base: isolation, no detection, no info collection, no honeypots/booby traps | `tools/sandbox/{sandbox,profile,integrity,limits,clock}.js`, `tools/sandbox/env/*` (24 modules), `tools/sandbox/env/anti-fingerprint.js` | `node --test tests/traceless.test.js` — 11/11; `tests/env-surface.test.js` — 8/8 |
| Fresh state per run (no cross-sample residue) | `sandbox.run()` creates runtime + context; full handle disposal | `sandbox-core` isolation + disposal assertions; `run.disposal.ok` |
| Traceless invocation | `tools/invocation/{invoke,stealth}.js` | `node --test tests/invocation.test.js` — 8/8 |
| Traceless Code/API/Exception/AST instrumentation | `tools/instrumentation/{code,api,exception,ast,index}.js` | `node --test tests/instrumentation.test.js` — 10/10; byte-identical `toString` assertion in `traceless` |
| JSVMP interpreter instrumentation | `tools/instrumentation/jsvmp.js` + `tools/jsvmp/*` | `node --test tests/jsvmp-trace.test.js` — 4/4 (319 opcode events, 14 opcodes, obfuscated VM) |
| Traceless Code/API/Exception/AST hooks | `tools/hook/{hookbus,code-hook,api-hook,exception-hook,ast-hook,index}.js` | `node --test tests/hook.test.js` — 11/11; sandbox-level hook assertions in `instrumentation.test.js` |
| Babel code restoration (unified parse/transform/generate) | `tools/restore/{parse,generate,pass-context,index}.js`, `passes/` (11 passes) | `node --test tests/restore-*.test.js tests/restore-pipeline.test.js` — 14 files/32+ tests, semantics-preservation by execution |
| Logging with pino / pino-pretty | `tools/logging/logger.js` | `node --test tests/logging.test.js` — 6/6; `node tools/cli.js passes --pretty` renders via pino-pretty |
| Final implementation under `tools/` | 83 JS modules | `find tools -name '*.js' | wc -l` = 83 |
| Tests under `tests/` | 30 test files + harness | `find tests -name '*.test.js' | wc -l` = 30 |
| Composable auxiliary analysis | `tools/analysis/*` (IOC, report, behaviour, artifacts, stages, orchestrator), CLI, hooks, passes | `node --test tests/analysis-e2e.test.js tests/cli.test.js` — 11/11 |
| Runnable examples / ecosystem docs | `examples/*.js` (11 samples), `examples/*.mjs` (4 demos), `examples/build-jsvmp-sample.mjs`, `examples/cli-usage.sh`, `examples/README.md` | `node --test tests/examples.test.js` — 10/10 (all samples execute; all demos and the CLI cookbook run) |
| Hardened national JS-SDK | `examples/national-sdk/` (signing, fingerprint, white-box crypto, JSVMP, zero-trust guard, build pipeline, server verifier, docs) | `node --test tests/national-sdk.test.js` — 13/13; `node examples/national-sdk/verify.mjs` — 37/37 |
| Many subagents used | Parallel workers for env modules, restoration passes, JSVMP, IOC/report, plus research + review + audit agents | session history; artefacts summarised in "Review" below |

## CLI evidence

```
$ node tools/cli.js analyze examples/sample-loader.js --json | jq '.verdict.level, .static.iocs.urls[0].value'
"suspicious"
"https://c2.example.test/beacon"

$ node tools/cli.js restore examples/sample-loader.js | head -3
<decoded source; string array and hex escapes removed>

$ node tools/cli.js run examples/benign.js --json | jq '.ok, .result.value'
true
55

$ node tools/cli.js passes --json | jq 'length'
11
```

## Tracelessness probes (from `tests/traceless.test.js`)

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
| `Object.getOwnPropertySymbols(document)` / `Object.assign({}, document)` symbols | `[]`; instrumentation and state symbols are registered `ai4r.*` and filtered |
| `Object.prototype.toString.call(div/body/canvas)` | `[object HTMLDivElement]` / `[object HTMLBodyElement]` / canvas interface |
| Chrome/Firefox-specific surfaces | `connection`, `getBattery`, `console.memory`, `webkitAudioContext`, `deviceMemory` only on Chromium; `oscpu`/`buildID` only on Gecko; `msCrypto` absent |
| `new Date(0).getTimezoneOffset()` vs anchor offset | DST-correct per instant (New York 300 in January, 240 in October; London BST in October) |
| `Date.parse('2026-10-19T15:20:00')` (no zone) | profile-local per ES2020, not host timezone |
| `localStorage` over-quota write / ``estimate().usage`` | `QuotaExceededError` at 5 MiB; usage reflects real bytes |
| `queueMicrotask` vs `Promise.then` FIFO | promise job first |
| `performance.mark()` | returns `undefined`; entry retrievable via `getEntriesByType('mark')` |
| `new TextDecoder('bogus')` | `RangeError` |
| `matchMedia('(min-width: 1px)')` | `true` for the profile viewport |

## Known residuals (documented, tested where possible)

- QuickJS is not V8; engine-specific behaviour (some APIs, stack columns) differs.
  Line numbers are preserved by splicing; columns shift.
- `document`/`navigator` carry own `Symbol.toStringTag`/`constructor` brand
  properties (filtered from symbol enumeration) because re-parenting would drop
  DOM methods.
- No real rendering/layout; canvas/WebGL/audio are deterministic profile values.
- IndexedDB is a stub that reports `NotSupportedError`.
- Virtual time uses a fixed UTC offset (no DST transitions).
- Wrapped platform APIs that throw synchronously keep name/message but the stack
  starts at the wrapper call site.

## Review and re-validation

Five independent read-only agents reviewed: (1) core sandbox/invocation/
instrumentation for leaks, semantic changes and detection tells; (2) restoration
and JSVMP for semantics-changing transforms; (3) environment fidelity; (4)
analysis/report/CLI/logging for IOC quality and contract stability; (5) an
evidence auditor mapping every requirement to code and executed tests. Findings
and dispositions are recorded in `docs/DESIGN-REVIEW.md`; all blocker/high
findings were fixed and the full suite was rerun.

## Final audit (post-review)

Executed after all review dispositions, on the authoritative tree:

```
$ pnpm test
ℹ tests 361
ℹ pass 361
ℹ fail 0
```

Strict full-environment audit (`env: {strict:true}`):

| Check | Result |
| --- | --- |
| Declared env modules / installed / missing | 24 / 24 / 0 |
| Registered restoration passes | 11 |
| Hook phases declared / global wildcard dispatch | 20 / 2 dispatches |
| JSVMP: detection / opcodes / traced opcode events | detected / 14 / 319 |
| `Object.keys(navigator|screen|document).length` | 0 / 0 / 0 |
| `Object.getOwnPropertySymbols(document).length` | 0 |
| `typeof Intl|URL|XMLHttpRequest|fetch|WebSocket|HTMLCanvasElement|AudioContext` | object/function/function/function/function/function/function |
| `localStorage instanceof Storage` | true |
| `Object.prototype.toString.call(window)` | `[object Window]` |
| Integrity intact / disposal ok | true / true |

Examples evidence:

```
$ node --test tests/examples.test.js
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

All 11 samples analyse cleanly, including `anti-analysis.js` (sandbox reports no
findings), `jsvmp-sample.js` (14 opcodes, traced dispatch), `eval-chain.js` and
`staged-payload.js` (decoded artifacts), `network-c2.js` (mocked `net` events and
IOCs). Four programmatic demos and `examples/cli-usage.sh` run offline.

CLI evidence (stdout parseable with logs on stderr, plain and `--pretty`):

```
$ node tools/cli.js analyze examples/sample-loader.js --json | jq
{verdict:{score:60,level:"malicious"}, static:{iocs:{urls:3}}, artifacts:[4], …}
$ node tools/cli.js analyze examples/benign.js --json | jq .verdict
{score:6,level:"benign",…}
$ node tools/cli.js restore examples/sample-loader.js | head
<decoded endpoint + config; string array removed>
$ node tools/cli.js run examples/benign.js --json | jq '.ok,.disposal.ok'
true
true
```
