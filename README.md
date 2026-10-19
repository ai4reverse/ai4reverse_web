# ai4reverse — traceless malicious JavaScript analysis platform

A complete platform for **auditing, analysing, forensically restoring and
tracing** malicious JavaScript. It runs samples inside a QuickJS
(`quickjs-emscripten`) sandbox that is built to be *traceless*: the sample must
not be able to tell it is being analysed, and the analyst must be able to
reproduce every observation.

```
sample ──► static analysis ──► Babel restoration ──► traceless dynamic run ──► report
             (AST facts,          (11 passes,            (isolated QuickJS,        (verdict, IOCs,
              obfuscation)         unified parse/        browser profile,          behaviour, artifacts,
                                   transform/generate)   trace channel)            opcode trace)
```

## Highlights

| Requirement | Where | Evidence |
| --- | --- | --- |
| Traceless sandbox | `tools/sandbox/` | `tests/sandbox-core.test.js`, `tests/traceless.test.js` |
| Traceless invocation | `tools/invocation/` | `tests/invocation.test.js` |
| Traceless instrumentation (Code/API/Exception/AST/JSVMP) | `tools/instrumentation/` | `tests/instrumentation.test.js`, `tests/jsvmp-trace.test.js` |
| Traceless hooks (Code/API/Exception/AST) | `tools/hook/` | `tests/hook.test.js` |
| Code restoration with Babel | `tools/restore/` | `tests/restore-*.test.js`, `tests/restore-pipeline.test.js` |
| Logging (pino / pino-pretty) | `tools/logging/` | `tests/logging.test.js` |
| Browser-grade environment, 28 modules (documented limits, no WASM execution) | `tools/sandbox/env/` | `tests/env-*.test.js`, `tests/env-surface.test.js`, `tests/env-fidelity.test.js` |
| Hardened national JS-SDK (SM2/SM3/SM4 signing, device fingerprint, white-box crypto, JSVMP, zero-trust guard) | `examples/national-sdk/` | `tests/national-sdk.test.js`, `examples/national-sdk/verify.mjs` |
| 50 commercial/military-grade product examples | `examples/products/` (50 packages + runner + index) | `node examples/products/run-all.mjs` — 50/50; `tests/examples-products.test.js` — 6/6 |
| 30 complete commercial works (10 security SDKs, 12 virus samples, 8 applications) | `examples/works/` (each with manifest, dossier, entrypoint, verification) | `node examples/works/run-all.mjs` — 30/30; `tests/examples-works.test.js` — 6/6 |
| Suite II: 30 further works + 100KB effective-code gate | `examples/suite/` (10 SDKs, 12 virus samples, 8 apps; contract runner measures effective code) | `node examples/suite/run-all.mjs` — 30/30, 562.8KB effective; `tests/examples-suite.test.js` — 6/6 |
| MEGA: 18 pure-JS single-file works, 70.32MB effective code | `examples/mega/` (8 virus samples, 8 security SDKs, 2 apps; one JS file each, no imports/modules) | `node examples/mega/run-all.mjs` — 18/18, 70.32MB effective, ≥50MB gate; `tests/examples-mega.test.js` — 4/4 |

**484 tests across 43 test files, 0 failures** (`pnpm test`), with 96.98 %
line / 88.78 % function coverage (`--experimental-test-coverage`). The hardened
SDK example contributes 13 end-to-end tests and a 37-check revalidation matrix;
the product suite adds 50 complete commercial/military-grade packages with a
contract-checking runner; the MEGA suite adds 18 single-file works whose
effective code (comments and blank lines stripped) totals **70.32MB**, enforced
by a ≥50MB gate.

## Quick start

```bash
pnpm install                # Node >= 24.18 (needs @babel/* 8, pino, quickjs-emscripten)
pnpm test                   # 484 tests

# Full analysis (static + dynamic + report)
node tools/cli.js analyze examples/sample-loader.js

# Machine-readable report
node tools/cli.js analyze examples/sample-loader.js --json | jq '.verdict'

# Restored source
node tools/cli.js restore examples/sample-loader.js

# Raw dynamic run with the trace stream
node tools/cli.js run examples/sample-loader.js --events

# 50-product suite and 30 complete works (SDKs / viruses / apps)
node examples/products/run-all.mjs
node examples/works/run-all.mjs
node examples/suite/run-all.mjs       # includes the ≥100KB effective-code gate
node examples/mega/run-all.mjs        # 18 single-file works, ≥50MB effective-code gate

# Every example, sample and demo
bash examples/cli-usage.sh
node examples/api-usage.mjs
node examples/hooks-demo.mjs
node examples/restore-demo.mjs
node examples/jsvmp-demo.mjs

# Hardened SDK: build, demo, full revalidation matrix
node examples/national-sdk/build/build-sdk.mjs --seeds 1001-1003
node examples/national-sdk/demo.mjs
node examples/national-sdk/verify.mjs
```

`examples/README.md` maps each sample to its obfuscation technique and the
behaviour the platform should report (verdict, IOCs, artifacts, restored code,
JSVMP opcode trace). `examples/products/` adds 50 complete product packages
(banking/web3/ransomware/APT/botnet/adtech/evasion/C2/supply-chain), each with a
manifest contract, README dossier, runnable sample and a runner that validates
the analysis output. `tests/examples.test.js` and
`tests/examples-products.test.js` keep the documentation and contracts honest.
`examples/works/` adds 30 complete works — 10 JS security SDKs, 12 virus
samples and 8 applications — each with a machine-checkable `work.json`, a
Chinese dossier, a runnable entrypoint and its own verification
(`verify.mjs` / sandbox contract / `--self-test`).
`examples/suite/` adds a further 30 works (10 security SDKs, 12 virus samples,
8 applications) with a hard code-volume gate: the runner strips comments and
blank lines, enforces **≥100KB effective code** (currently ~563KB) and fails on
any contract or volume drift.
`examples/mega/` is the volume and protection stress suite: **18 single-file,
100% pure-JavaScript, zero-dependency works** (8 virus samples, 8 security SDKs,
2 applications) with no imports, no modules and no second code file. Each work
embeds black-hole multi-layer obfuscation, a fortress nested JSVMP, ≥3 dynamic
implicit white-box suites, ≥3 mutated/custom ciphers, ≥3 custom encodings with
mixed pipelines, and rendering-engine-level probes including `document.all`.
The runner executes every work, checks its `MEGA METRICS`, and enforces
**≥2.8MB effective code per work and ≥50MB across the suite** (currently
**70.32MB effective / 70.47MB raw**).

`examples/national-sdk/` is the opposite end of the spectrum: a **hardened SDK**
for request signing and device-fingerprint collection. It combines Chinese
national crypto (SM2/SM3/SM4), twelve dynamic implicit white-box suites,
mutated/custom ciphers, hybrid ECDH envelopes, a polymorphic JSVMP, and a
zero-trust 45-signal environment guard that treats `document.all` as a
proof-grade invariant. It builds protected bundles (`dist/nsdk-<seed>.js`),
verifies them on the host and inside the QuickJS sandbox, and includes a
reference server verifier. See `examples/national-sdk/README.md` and run
`node examples/national-sdk/verify.mjs`.

Programmatic use:

```js
import { analyzeSample, TracelessSandbox, restore } from './tools/index.js'

const { report, markdown, artifacts } = await analyzeSample(source, {
  name: 'loader.js',
  sourceUrl: 'https://cdn.example.test/loader.js',
  seed: 0x5eed,
})

const sandbox = await TracelessSandbox.create({ seed: 1 })
const run = await sandbox.run(source, { filename: 'https://cdn.test/app.js' })
console.log(run.ok, run.result, run.traceStats.byKind, run.integrity.intact)
sandbox.dispose()

const restored = restore(source)
console.log(restored.code, restored.passes.filter((p) => p.changed))
```

## Traceless design in one page

The analysed code probes its runtime constantly. Every mechanism below exists
because a naive implementation leaks one of those probes. The test suite encodes
the probe, not the implementation, so regressions are caught as detection.

1. **Fresh runtime per run.** Every `sandbox.run()` creates a new QuickJS runtime
   and context. No state, prototype patch or forged global survives between
   samples. Handles are disposed in LIFO order and a failed teardown is reported
   as `disposal { ok:false, leaked:true, stage }`. A stack-limit breach is the one
   case where the runtime cannot be released at all: it is abandoned, the WASM
   module is quarantined and the next run recompiles it
   (`docs/SECURITY-MODEL.md`). Guest runs are serialized one at a time per
   process, so a timeout can never interrupt a run parked at an `await`.

2. **Coherent seeded profile.** UA, `navigator.platform`, `navigator.userAgentData`,
   screen geometry/DPR, timezone + offset, locale, fonts, WebGL vendor/renderer,
   plugins, storage quota and hardware all derive from one record
   (`tools/sandbox/profile.js`). `consistencyReport()` proves the invariants.

3. **Native-branded platform functions.** Host functions are created with
   `newFunctionWithOptions` plus an explicit `length` descriptor, so
   `name`, `length` and `Function.prototype.toString()` match a real browser, and
   host frames never appear in guest stacks. QuickJS's multi-line native source
   is normalised to V8's exact single-line form
   (`function name() { [native code] }`), because a sample comparing that text
   literally would otherwise detect the engine.

4. **Marker-masked source instrumentation.** Code instrumentation splices trace
   calls into the original text (never regenerates it) inside comment markers.
   `Function.prototype.toString` is replaced by a *native* masker that removes
   exactly those spans; `f.toString()` returns the original bytes, verified
   byte-for-byte in `tests/traceless.test.js`. Guest-side shims (virtual `Date`,
   `Intl`, `Storage`, `MessageChannel`, …) are registered with native-looking
   source so they cannot be fingerprinted.

5. **Hidden trace channel.** The trace sink is a host function reached through a
   run-unique `Symbol.for('ai4r.channel.*')` stored on `document`. It is not a
   named global; symbol/name enumeration is filtered by
   `tools/sandbox/env/anti-fingerprint.js`, so `Object.getOwnPropertyNames`,
   `Object.getOwnPropertySymbols`, `Reflect.ownKeys` and
   `Object.getOwnPropertyDescriptors` show nothing unusual.

6. **Virtual time and entropy.** `Date`, `performance.now()`, timers,
   `Math.random`, `crypto.getRandomValues`/`randomUUID` and `AbortSignal.timeout`
   are driven by a seeded virtual clock and PRNG. Runs are reproducible;
   instrumentation overhead is invisible in guest-observed time.

7. **Sanitised stacks.** QuickJS's `<eval>` top-level frame and host paths are
   stripped from constructors, caught errors (rewritten in place by the AST
   instrumentation before guest code reads them) and uncaught boundaries. Real
   script URLs remain, matching V8's frame grammar.

8. **Absence policy.** Host runtime globals (`process`, `require`, `Buffer`,
   `module`, `spawn`, …) and analysis-farm honeypots (`_phantom`, `callPhantom`,
   `__nightmare`, `domAutomation`, `$cdc_*`, …) are deleted and reported.

9. **Traceless invocation.** Script filename is a realistic CDN/minified URL
   (or the original `sourceUrl`), evaluation is a global-scope script (so `var`,
   `this`, directives behave like a `<script>` tag), and entry-point calls go
   through the guest function with no wrapper frames.

10. **Traceless hooks.** Platform APIs are *host* functions; wrapping them with
    another host function preserves identity, arity, source text and stack shape.
    Mocks answer with profile-consistent values (dialogs suppressed, popups
    blocked, network failures realistic) and every hook must declare its
    footprint (`traceless: {addsGlobals, preservesIdentity, preservesStack,
    consistentAnswers}`).

## Environment surface

`tools/sandbox/env/` implements **28 modules**, installed in `meta.order`
(dependency) order, which is exactly `ENV_MODULE_IDS`:

| order | module | surface |
| --- | --- | --- |
| 10 | `globals` | `window`/`globalThis`, `WebAssembly` stub, isolation triple, host-global removal |
| 20 | `console` | buffered console + trace capture |
| 25 | `time` | virtual `Date`, per-instant timezone offsets (ICU-correct DST) |
| 27 | `stack` | `Error` shims + stack sanitiser |
| 28 | `random` | seeded `Math.random`/`getRandomValues` |
| 30 | `dom` | `Document`, node/element hierarchy, events, cookies, selectors |
| 32 | `dom-parser` | bounded `DOMParser` + `XMLSerializer` |
| 45 | `screen` | screen geometry/DPR |
| 50 | `location` | `location` + `history` |
| 55 | `storage` | real `Storage` class (5 MiB quota) |
| 58 | `navigator` | `navigator` + permissions/connection/battery/mediaDevices/plugins/storage |
| 65 | `timers` | virtual clock timers |
| 70 | `encoding` | `atob`/`btoa`/`TextEncoder`/`TextDecoder` |
| 75 | `performance` | `performance.now`, entries, timeOrigin |
| 80 | `crypto` | `getRandomValues`, `randomUUID`, `subtle.digest`/`generateKey` |
| 80 | `xhr` | `XMLHttpRequest` over the mock network |
| 82 | `network` | policy service + trace/IOC capture |
| 84 | `fetch` | `fetch`/`Response`/`Headers` over the mock network |
| 85 | `eventsource` | `EventSource` (SSE parser, virtual-clock reconnects) |
| 86 | `websocket` | `WebSocket` over the mock network |
| 88 | `url` | `URL`, `URLSearchParams`, legacy `webkitURL`/`external` |
| 92 | `blob` | `Blob`, `File`, `FormData` |
| 100 | `misc` | `AbortController`, Notification, Worker, BroadcastChannel, `RTCPeerConnection`, `structuredClone`, `indexedDB` (stub) / `caches` (in-memory mock), … |
| 105 | `canvas` | 2D/WebGL/audio/font fingerprints (deterministic profile values) |
| 108 | `observers` | Mutation/Intersection/Resize, `MessageChannel` |
| 110 | `intl` | host-ICU-backed `Intl` + locale methods |
| 115 | `chrome` | `window.chrome` for Chromium profiles |
| 130 | `anti-fingerprint` | `HTMLElement`/tag interfaces/`customElements`, symbol and key filtering |

`platform-kit.js` and `index.js` are the shared helper layer and the loader;
they are not modules. A subset install (`env: { only: [...] }`) either works or
fails loudly with a `SandboxError` — a `requires` edge is never silently
dropped.

Network is **fully mocked**: policies `deny` (realistic `net::ERR_*` failure),
`empty` (204) or `echo`; handler/routing hooks can return synthetic responses.
No socket, file or process access exists inside the sandbox.

## Restoration passes

`tools/restore/` uses one Babel AST, one pass registry and one generator:
`strings`, `constant-fold`, `member-fold`, `string-array`, `jsfuck`,
`proxy-unwrap`, `dead-code`, `control-flow` (flattening removal),
`anti-analysis` (safe anti-debug removals + observation notes), `eval-unwrap`,
`rename`. Every pass is conservative: when semantics cannot be proven, the node
is left alone and a note is recorded. A pass reports `changed` only when the
generated text actually differs, so the pipeline is a fixed point
(`restore(restore(x).code).changed === false`), and `rename` runs once, in the
final round, because it declares `meta.deferred`. The generated output is
re-parsed before it is returned: `restore()` exposes `outputValid`,
`outputError` and `notes`, and falls back to the input source rather than hand
back code that does not parse. Passes are unit-tested by executing original vs
transformed code in plain Node (`tests/restore-*.test.js`, 8 files / 119 tests).

## JSVMP support

- `tools/jsvmp/spec.js` — canonical opcode table + assembler.
- `tools/jsvmp/builder.js` — generates runnable, optionally obfuscated
  (XOR/add opcode cipher, encoded const indices, shuffled cases) JSVMP
  interpreters for tests and experiments.
- `tools/jsvmp/analyze.js` — dispatch-loop detection, handler extraction,
  const-pool recovery, obfuscation summary.
- `tools/instrumentation/jsvmp.js` — opcode-level tracing spliced into the
  dispatch loop (traceless, same marker/channel machinery), plus
  `summarizeOpcodeTrace()` for the recovered virtual program.

## Logging

`tools/logging/logger.js` is pino-only: JSON logs with redaction
(cookies/tokens/passwords), optional `pino-pretty` output, scoped child loggers
and an event sink that turns every trace event into a greppable
`trace.<kind>.<phase>` line. `--pretty` / `AI4REVERSE_LOG_LEVEL` control output;
the CLI keeps stdout for results and stderr for diagnostics.

## CLI, packaging and public surface

```
node tools/cli.js analyze <file> [--json|--out path] [--no-dynamic] [--no-restore]
                                [--seed N] [--timeout ms] [--virtual-ms ms]
                                [--level off|function|branch|statement]
                                [--source-url url] [--entry fn] [--arg JSON|string]
                                [--profile JSON] [--mocks JSON] [--log-level L] [--pretty]
node tools/cli.js restore <file>  [--passes ids] [--exclude ids] [--rounds 1-5] [--out path]
node tools/cli.js run <file>      [--json] [--events]
node tools/cli.js passes [--json]
```

Argument parsing is **strict**: an unknown option, a malformed `--seed`, a
`--rounds` outside 1–5, a `--level` outside the four documented values, an
unknown `--passes`/`--exclude` id (the message lists the valid ids) or an
unwritable `--out` is a usage error — exit **2**, message on **stderr**, nothing
on stdout. `--json` stdout stays pure JSON (logs go to fd 2), `--out -` writes the
result to stdout, and `--arg` parses JSON when the value is valid JSON and passes
it as a string otherwise (`--arg 42` is a number, `--arg hello` is `"hello"`).

Exit codes: `0` success, `1` analysis/run failure, `2` usage error.

Packaging (`package.json`): `type: module`, `engines.node >= 24.18`,
`bin: ai4reverse → tools/cli.js` (mode `100755` in git), `files: [tools, docs,
types, README.md, LICENSE]`, ISC `LICENSE`, and 11 `exports` subpaths
(`.`, `./sandbox`, `./instrumentation`, `./hook`, `./restore`, `./analysis`,
`./jsvmp`, `./logging`, `./invocation`, `./util`, `./cli`) each with its own
`types/*.d.ts`. The entry barrel exports **68** names. `restoreCode` and
`restoreWithPass` are exported both from the barrel and from `./restore`;
`validateOutput` and `isDeferredPass` are on `./restore` only.

## Report

`analyzeSample()` returns a stable JSON report (schema:
`docs/REPORT-SCHEMA.md`) and a Markdown rendering: verdict with traceable
weights, sample hash, static facts/obfuscation indicators/techniques, IOCs
(static + decoded + dynamic), behaviour (API/network/storage/DOM/timers/
exceptions/kill-chain), staged-payload artifacts, JSVMP trace summary, hook
audit, integrity drift and recommended next steps.

## Known limitations (honest list)

Every item below is measured on this tree; `docs/VERIFICATION.md` records the
command and the numbers, `docs/SECURITY-MODEL.md` the security reasoning.

**Engine and stack**

- QuickJS is not V8: some APIs are absent by design, `Intl` is host-ICU-backed
  rather than engine-native, and column numbers shift under instrumentation while
  line numbers are preserved. Malware that checksums *all* its source spans may
  still see column-shifted stacks; `tests/traceless.test.js` pins what is
  guaranteed.
- Wrapped APIs that throw synchronously re-throw with the same name/message, but
  the stack originates at the wrapper call site
  (`tools/instrumentation/api.js`).
- Fixed per-run cost is ~28 % above the pre-alignment tree (≈33 ms for `1+1`
  instead of ≈26 ms) because each run compiles the environment's guest sources.
  The cost is per run, not per statement, and `restore` is unchanged.

**Concurrency**

- One guest run at a time per process: concurrent `run()` calls queue. Real
  parallelism needs separate worker processes, one WASM module each. A `run()`
  started from inside a hook, an env callback or guest code deadlocks on the
  queue — do not do it.
- A stack-limit breach (main script, timer or promise callback) leaves the
  runtime unreleasable. It is abandoned and the module recompiled; the record
  states it as `disposal { ok:false, leaked:true, stage:'runtime', skipped:true }`.
- A guest that sets `error.name = 'InternalError'` and a stack-overflow message
  is classified as a breach and costs one abandoned runtime. A guest that merely
  throws `Error('stack overflow')` is not classified.

**Environment (28 modules)**

- **WASM execution is unsupported.** `WebAssembly` is a coherent stub:
  `validate()` → `false`, `compile`/`instantiate` reject with a browser-shaped
  `CompileError`, `Memory` (≤16 pages)/`Table`/`Global` work, no bytecode ever
  runs.
- `SharedArrayBuffer` exists only when `crossOriginIsolated` is true (and then
  only over `https`). `Atomics` is a **single-threaded shim**: there is one guest
  thread, `wait` never blocks (`'not-equal'`/`'timed-out'`), `notify` returns 0.
- `DOMParser` is **bounded**: 65 536 input characters, 512 nodes, 32 levels; no
  HTML5 insertion-mode algorithm (foster parenting, adoption agency, implied
  table sections), no namespaces, a CSS-subset selector engine, and parsed
  `canvas`/`img`/`audio`/`video` tags are plain shim elements.
- Per-tag interfaces are **minimal**: 39 `HTML*Element` constructors exist and
  `instanceof` works (structurally for the four tags the canvas module owns), but
  each interface carries only the members the shim defines. Interface
  constructors have an own `Symbol.hasInstance` a browser does not have.
- `DocumentType` exists but is **never instantiated**: `new DocumentType()`
  throws `TypeError` and `document.implementation.createDocumentType()` returns
  an object that is not `instanceof DocumentType`. `Attr`, `Range` and
  `ShadowRoot` are `undefined`.
- `customElements.upgrade` re-parents and calls the constructor with the element
  as `this`, so an ES `class` body cannot run; `document.createElement` does not
  auto-upgrade; `connectedCallback`/`attributeChangedCallback` are not invoked;
  no shadow DOM.
- `IndexedDB` is a **stub**: `open`/`deleteDatabase` return a request whose
  `onerror` fires `NotSupportedError` on the virtual clock, so a sample that
  branches on IndexedDB availability takes the "blocked storage" path. `caches`
  is an in-memory mock (`open`/`match`/`put`/`delete` resolve; nothing persists
  and nothing touches disk). `RTCPeerConnection` is good enough for probes but
  opens no media.
- `crypto.subtle` covers `digest` and `generateKey` only; AES/HMAC/`importKey`
  are absent and reported as such.
- Canvas, WebGL, audio and font surfaces return **deterministic profile values**,
  not pixels: there is no layout or rendering engine, and
  `getBoundingClientRect` returns profile-derived geometry.
- `EventSource` reconnects on the virtual clock for as long as the run's
  virtual-time budget allows (the mock body ends immediately), bounded by
  `maxVirtualMs`/`maxTimerCallbacks` rather than by `EventSource` itself.
- `restore()` returns generated text without a trailing newline, so a file
  produced by redirecting stdout re-reports `changed:true` with zero changed
  passes. `--out` files are exact and round-trip with `changed:false`.

**Documentation and coverage**

- Branch coverage is 73.56 %, 1.7 points below the review baseline; lines
  (96.98 %) and functions (88.78 %) are above it.

## Safety

This is defensive tooling. Samples execute with no network, no filesystem, no
process access, bounded memory/CPU and a fully virtual environment. Do not
weaken those limits to run untrusted code outside the sandbox, and treat
extracted payloads as live malware.

## Documentation

- `docs/ARCHITECTURE.md` — module map, dataflow, event schema, extension points.
- `docs/CONTRACTS.md` — contracts for the bridge, trace recorder, hook bus, env
  modules, restore passes, JSVMP, logging (method by method).
- `docs/SECURITY-MODEL.md` — isolation, runtime abandonment/quarantine, WASM and
  `SharedArrayBuffer` policy, handle lifetime, threat model.
- `docs/API.md` — public API cookbook (including `validateOutput`, `disposal`
  failure shape, CLI matrix).
- `docs/REPORT-SCHEMA.md` — report shape.
- `docs/VERIFICATION.md` — every number in this README, with the command that
  produced it, plus the `D1`–`D12` disposition matrix.
- `docs/DESIGN-REVIEW.md` — the six review passes and their dispositions.
- `docs/EVALUATION-TOOLS.md` — the `tools/` evaluation record and targets.
- `docs/RESEARCH-ANTI-ANALYSIS.md` — researched detection techniques and the
  P0/P1/P2 requirements they impose.
