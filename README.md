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
| Full browser environment | `tools/sandbox/env/` | `tests/env-*.test.js`, `tests/env-surface.test.js` |
| Hardened national JS-SDK (SM2/SM3/SM4 signing, device fingerprint, white-box crypto, JSVMP, zero-trust guard) | `examples/national-sdk/` | `tests/national-sdk.test.js`, `examples/national-sdk/verify.mjs` |

**361 tests, 0 failures** (`pnpm test`). The hardened SDK example contributes
13 end-to-end tests and a 37-check revalidation matrix.

## Quick start

```bash
pnpm install                # Node >= 22.18 (needs @babel/* 8, pino, quickjs-emscripten)
pnpm test                   # 361 tests

# Full analysis (static + dynamic + report)
node tools/cli.js analyze examples/sample-loader.js

# Machine-readable report
node tools/cli.js analyze examples/sample-loader.js --json | jq '.verdict'

# Restored source
node tools/cli.js restore examples/sample-loader.js

# Raw dynamic run with the trace stream
node tools/cli.js run examples/sample-loader.js --events

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
JSVMP opcode trace). `tests/examples.test.js` runs all samples and demos so the
documentation cannot drift.

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
   samples. Handles are disposed in LIFO order; the WASM runtime's own leak
   assertion (`list_empty(rt->gc_obj_list)`) is treated as a test failure signal.

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

`tools/sandbox/env/` implements 24 modules, installed in dependency order:

`globals`, `console`, `time` (virtual `Date` + offsets), `stack` (Error shims +
stack sanitiser), `random`, `dom` (Document/elements/events/cookies),
`navigator`, `screen`, `location`+`history`, `storage` (real `Storage` class),
`timers`, `encoding` (`atob`/`btoa`/`TextEncoder`/`TextDecoder`),
`performance`, `crypto`, `network` (policy service + trace/IOC capture),
`xhr`, `fetch`, `websocket`, `observers` (Mutation/Intersection/Resize,
`MessageChannel`), `misc` (`URL`, `URLSearchParams`, `Blob`, `File`,
`FormData`, `AbortController`, permissions, battery, mediaDevices, clipboard,
geolocation, Notification, Worker, BroadcastChannel, RTCPeerConnection,
structuredClone, …), `intl` (host-ICU-backed `Intl` + locale methods),
`chrome` (window.chrome for Chromium profiles), `canvas` (2D/WebGL/audio/font
fingerprints), `anti-fingerprint`.

Network is **fully mocked**: policies `deny` (realistic `net::ERR_*` failure),
`empty` (204) or `echo`; handler/routing hooks can return synthetic responses.
No socket, file or process access exists inside the sandbox.

## Restoration passes

`tools/restore/` uses one Babel AST, one pass registry and one generator:
`strings`, `constant-fold`, `member-fold`, `string-array`, `jsfuck`,
`proxy-unwrap`, `dead-code`, `control-flow` (flattening removal),
`anti-analysis` (safe anti-debug removals + observation notes), `eval-unwrap`,
`rename`. Every pass is conservative: when semantics cannot be proven, the node
is left alone and a note is recorded. Passes are idempotent and unit-tested by
executing original vs transformed code in plain Node.

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

## Report

`analyzeSample()` returns a stable JSON report (schema:
`docs/REPORT-SCHEMA.md`) and a Markdown rendering: verdict with traceable
weights, sample hash, static facts/obfuscation indicators/techniques, IOCs
(static + decoded + dynamic), behaviour (API/network/storage/DOM/timers/
exceptions/kill-chain), staged-payload artifacts, JSVMP trace summary, hook
audit, integrity drift and recommended next steps.

## Known limitations (honest list)

- QuickJS is not V8: engine-level differences remain (some APIs absent by
  design, `Intl` is host-ICU-backed rather than engine-native, exact stack
  column numbers shift under instrumentation while line numbers are preserved).
- No real layout/rendering: `getBoundingClientRect`, canvas and WebGL return
  deterministic profile-derived values, not pixels.
- IndexedDB is a stub that reports `NotSupportedError`; `RTCPeerConnection` is
  feature-complete enough for probes but opens no media.
- Virtual time is fixed-offset (DST-free) by design; use a different profile or
  extend `tools/sandbox/env/time.js` for DST-sensitive samples.
- Wrapped APIs that throw synchronously re-throw with the same name/message but
  the stack originates at the wrapper call site (documented in
  `tools/instrumentation/api.js`).
- Malware that performs heavy self-checksumming of *all* its source spans may
  still observe line-preserving but column-shifted stacks; this is the main
  residual tell and is covered by tests that pin down what is guaranteed.

## Safety

This is defensive tooling. Samples execute with no network, no filesystem, no
process access, bounded memory/CPU and a fully virtual environment. Do not
weaken those limits to run untrusted code outside the sandbox, and treat
extracted payloads as live malware.

## Documentation

- `docs/ARCHITECTURE.md` — module map, dataflow, event schema, extension points.
- `docs/CONTRACTS.md` — contracts for env modules, restore passes, hooks, JSVMP.
- `docs/SECURITY-MODEL.md` — isolation and threat model.
- `docs/API.md` — public API cookbook.
- `docs/REPORT-SCHEMA.md` — report shape.
- `docs/RESEARCH-ANTI-ANALYSIS.md` — researched detection techniques and the
  P0/P1/P2 requirements they impose.
