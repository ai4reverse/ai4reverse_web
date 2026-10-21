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
                    │
                    ├──► constraint solving (z3): opaque predicates, unreachable arms,
                    │    sat models, equivalence and normal forms
                    └──► taint analysis (Circle-IR): sources, sinks, sanitizers and flow paths
```

## Highlights

| Requirement | Where | Evidence |
| --- | --- | --- |
| Traceless sandbox | `tools/sandbox/` | `tests/sandbox-core.test.js`, `tests/traceless.test.js` |
| Traceless invocation | `tools/invocation/` | `tests/invocation.test.js` |
| Traceless instrumentation (Code/API/Exception/AST/JSVMP) | `tools/instrumentation/` | `tests/instrumentation.test.js`, `tests/jsvmp-trace.test.js` |
| Traceless hooks (Code/API/Exception/AST) | `tools/hook/` | `tests/hook.test.js` |
| Code restoration with Babel | `tools/restore/` | `tests/restore-*.test.js`, `tests/restore-pipeline.test.js` |
| Static taint analysis (Circle-IR): sources, sinks, sanitizers, propagation paths | `tools/taint/` | `tests/taint.test.js`, `tests/taint-cli.test.js`, `docs/TAINT.md` |
| Constraint solving (z3): opaque predicates, unreachable arms, models, equivalence | `tools/constraint/` | `tests/constraint.test.js`, `docs/CONSTRAINT.md` |
| Logging (pino / pino-pretty) | `tools/logging/` | `tests/logging.test.js` |
| Browser-grade environment, 28 modules (documented limits, no WASM execution) | `tools/sandbox/env/` | `tests/env-*.test.js`, `tests/env-surface.test.js`, `tests/env-fidelity.test.js` |
| Hardened national JS-SDK (SM2/SM3/SM4 signing, device fingerprint, white-box crypto, JSVMP, zero-trust guard) | `examples/national-sdk/` | `tests/national-sdk.test.js`, `examples/national-sdk/verify.mjs` |

**612 tests across 42 test files, 0 failures** on commit `7c1df9c`, the
`tools/` alignment commit these counts are pinned to:

```bash
node --test --test-concurrency=1 $(git ls-files 'tests/*.test.js')
ℹ tests 612   ℹ pass 612   ℹ fail 0
```

Coverage is recorded on two scopes (`--experimental-test-coverage`): **90.32 %
lines / 78.88 % branches / 86.92 % functions** over the whole committed tree,
and **92.99 / 82.68 / 90.62** over `tools/` only
(`--test-coverage-exclude='examples/**'`). The review baseline
(88.08 / 75.26 / 80.33) was measured on the `tools/` scope; that scope clears it
on all three metrics, and the whole-tree scope is above it as well. The suite
also asserts that no engine `Aborted(` assertion line reaches stderr: one line of
hostile recursion cannot disable the process, and the record says what happened.
The hardened SDK example contributes 13 end-to-end tests and a 37-check
revalidation matrix.

Every number in this README is produced by a command named in
`docs/VERIFICATION.md` and pinned to that commit, so it stays reproducible after
later commits land. Example corpora that are not tracked at `7c1df9c`
(`examples/products`, `examples/works`, `examples/suite`, `examples/mega`) are
outside that measurement: they are not described here and are excluded from
every historical count in this file. Current contract corrections from the
2026-10-20 acceptance alignment supersede the older behavior descriptions for
resource attribution, trace snapshots, environment status and public API shapes;
see `docs/ALIGNMENT.md` for current verification. Other pinned measurements remain
historical, including the explicitly dated AES `crypto.subtle` evidence.

## Quick start

```bash
pnpm install                # Node >= 24.18 (needs @babel/* 8, pino, quickjs-emscripten)
pnpm test                   # current serial suite; historical count below is pinned
pnpm test:types             # strict NodeNext public-consumer compilation

# Full analysis (static + dynamic + report)
node tools/cli.js analyze examples/sample-loader.js

# Machine-readable report
node tools/cli.js analyze examples/sample-loader.js --json | jq '.verdict'

# Restored source
node tools/cli.js restore examples/sample-loader.js

# Raw dynamic run with the trace stream
node tools/cli.js run examples/sample-loader.js --events

# z3 constraint/opaque-predicate analysis (JSON with --json)
node tools/cli.js constraint examples/sample-loader.js

# Static taint evidence (no sample execution)
node tools/cli.js taint examples/sample-loader.js --json
node examples/taint-demo.mjs

# Every committed example, sample and demo
bash examples/cli-usage.sh
node examples/api-usage.mjs
node examples/hooks-demo.mjs
node examples/restore-demo.mjs
node examples/jsvmp-demo.mjs
node examples/constraint-demo.mjs

# Hardened SDK: build, demo, full revalidation matrix
node examples/national-sdk/build/build-sdk.mjs --seeds 1001-1003
node examples/national-sdk/demo.mjs
node examples/national-sdk/verify.mjs
```

`examples/README.md` maps each committed sample to its obfuscation technique and
the behaviour the platform should report (verdict, IOCs, artifacts, restored
code, JSVMP opcode trace). `tests/examples.test.js` keeps that documentation and
the sample contracts honest: every committed sample executes, and every `.mjs`
demo plus `examples/cli-usage.sh` run offline.

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

`analyzeSample()` includes bounded Circle-IR taint evidence under
`report.static.taint` by default. Use `taint:false` or CLI `analyze --no-taint`
to disable it. The standalone `analyzeTaint()` API is exported from the root,
`/analysis` and `/taint`; it never executes sample code. See
[`docs/TAINT.md`](docs/TAINT.md) for options, custom patterns, resource limits
and precision caveats. Static flows are evidence, not execution or safety proofs.

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
   process, so a timeout can never interrupt a run parked at an `await`. Handle
   lifetime is a first-class invariant for platform surfaces too: observer
   entries are built at delivery time and their target duplicates released after
   use, and canvas handles that outlive the bridge call (`FontFaceSet` faces,
   `toBlob` and `img.src` tasks) are retained and released, so a legitimate
   sample cannot trip the engine's leak assertion.

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
they are not modules. A subset install (`env: { only: [...] }`) is validated
against `requires`, but strictness differs by entry point:
`installEnvironment(bridge, { strict: true })` — the library default — throws a
`SandboxError` on an unmet edge, while
`TracelessSandbox.create({ env: { only } })` defaults to `strict: false` and
attempts installation even when a dependency is absent. Each unmet edge is
recorded in `missing` as `{ id, reason }` and makes `complete: false`; continued
execution is not a claim that every requested dependency is present. Pass
`env: { strict: true }` when missing dependencies must fail the run. The run
record reports `environment: { installed, missing, requested, tookMs, complete }`.

Notable surfaces: `DOMParser`/`XMLSerializer` brand as `[object DOMParser]` /
`[object XMLSerializer]`, `EventSource` as `[object EventSource]`, and
`CustomElementRegistry` is a real global (`customElements` is instance-shaped but
not `instanceof` it).

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
transformed code in plain Node (`tests/restore-*.test.js`, 8 files / 147 tests).

## Constraint solving (z3)

`tools/constraint/` is a static, z3-backed analyzer. The lazy WASM loader keeps
`z3-solver` out of the startup path for callers that never use it.

- **Opaque predicates.** `if`, ternary, loop and logical conditions are
  translated to z3 terms. A condition is `always-true` when `unsat(not P)` and
  `always-false` when `unsat(P)`.
- **Path feasibility.** `if` arms are checked against their enclosing path
  conditions (outer `if`/ternary polarity, short-circuit facts, loop guards), so
  a dead arm is reported with the path that proves it.
- **Models.** `solveConstraints(['x * 2 === 42'])` returns `{status: 'sat',
  model: {x: 21}}`; unsat constraints return no model.
- **Equivalence/normal forms.** `proveEquivalent()` checks
  `unsat(left !== right)`; `simplifyExpression()` returns z3's SMT normal form
  and the equivalence query that verified it.

The default domain is the **exact** JS fragment: bitwise operators (through
signed 32-bit vectors over primitive values; object `ToPrimitive` calls are not
modelled), boolean structure, `typeof`, comparisons of exact values. Integer
arithmetic is an explicit assumption, because a JS number can be
fractional, `NaN`, `Infinity` or rounded above 2^53. `x !== x` is therefore not
claimed always-false; `x + 1 > x` is proven only with
`assumeIntegers: true`, and every finding reports the assumption it used.
Unsupported constructs become uninterpreted leaves, so the analyzer says
`unknown`/`unsupported` instead of guessing. See `docs/CONSTRAINT.md`.

`analyzeSample()` runs the component by default (`constraints: false` disables
it) and exposes the normalized evidence under `report.static.constraint` plus a
`## Constraint solving` Markdown section. Findings are evidence, not verdict
weights; they do not silently move a product's pinned score.

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
node tools/cli.js analyze <file> [options]
node tools/cli.js restore <file> [options] [--passes ids] [--exclude ids] [--rounds 1-5]
node tools/cli.js run <file> [--json|--out path] [--events]
node tools/cli.js constraint <file> [--json|--out path] [--timeout ms]
                                  [--assume-integers|--assume-int32]
node tools/cli.js passes [--json]
node tools/cli.js version

shared options:
  --json | --out <path|-> | --seed N | --timeout ms | --virtual-ms ms
  --level off|function|branch|statement | --no-dynamic | --no-restore
  --run-restored | --source-url url | --entry fn | --arg JSON|string
  --profile JSON | --mocks JSON | --log-level L | --pretty
```

The option parser is shared by `analyze`, `restore` and `run`, so `restore` also
accepts `--json`, `--seed`, `--out` and `--level`; `--passes`, `--exclude` and
`--rounds` are restore-specific and `--events` is run-specific.

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
types, README.md, LICENSE]`, ISC `LICENSE`, and 13 `exports` subpaths
(`.`, `./sandbox`, `./instrumentation`, `./hook`, `./restore`, `./analysis`,
`./jsvmp`, `./constraint`, `./taint`, `./logging`, `./invocation`, `./util`,
`./cli`) each with its own `types/*.d.ts`. The entry barrel exports **78** names.
`restoreCode` is a root-entry convenience API; `restoreWithPass` is exported
both from the root barrel and from `./restore`. `validateOutput` and
`isDeferredPass` are on `./restore` only.

## Report

`analyzeSample()` returns a stable JSON report (schema:
`docs/REPORT-SCHEMA.md`) and a Markdown rendering: verdict with traceable
weights, sample hash, static facts/obfuscation indicators/techniques, IOCs
(static + decoded + dynamic), behaviour (API/network/storage/DOM/timers/
exceptions/kill-chain), staged-payload artifacts, JSVMP trace summary, hook
audit, integrity drift and recommended next steps.

Evidence the report keeps:

- **Attribution.** Trace events the platform emits while it builds the
  environment (`document.installed`, `api.wrapped`, ...) are counted as
  `dynamic.behavior.counts.platform` and never feed a behavioural reason, so a
  sample cannot borrow suspicion from the sandbox's own setup. `dynamic.counts`
  keeps the raw per-kind totals.
- **Truncation.** `tracing.truncated` / `tracing.truncatedBy` (`code-budget`,
  `event-limit`) stay true even when the `code:trace-truncated` marker fell out
  of the retained window, and Markdown prints a `**Trace truncated:**` line.
- **Restoration failure.** `static.restoration.error` records that the pipeline
  threw (with the message), so a bail-out is no longer indistinguishable from
  "nothing to restore"; Markdown prints `**Restoration error:**`.
- **Hook failures.** `hooks.errors` keeps the newest 50 failing hooks (each
  `{hook, phase, message}`) plus `hooks.errorsTruncated`.
- **Constraint evidence.** `static.constraint` keeps z3's opaque predicates,
  unreachable arms and normal forms with their proof kind, exactness and
  assumptions; `truncated` says a candidate or time bound was hit. Markdown
  prints a `## Constraint solving` section.

All five are Markdown-visible: `Platform events (not sample behaviour)`,
`Trace truncated`, `Restoration error`, `Hook errors`, `Constraint solving`.

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
- Fixed per-run cost is ~30 % above the pre-alignment tree (`1b0f2c7`): a
  create + run + dispose cycle of `1+1` measured 34.4 ms against 26.0 ms (median
  of 9 runs each on one host; earlier measurements on this tree ranged 26-33 %,
  and `docs/EVALUATION-TOOLS.md` recorded 28 %).
  The cost is per run, not per statement, because each run compiles the
  environment's guest sources; `restore` is unchanged.
- Stack breaches are expensive in host memory: each abandoned runtime keeps its
  WASM module's heap until the quarantined module is collected. Measured here,
  six consecutive breaches added **21.7 MB RSS** (~17 MB in the final-audit
  measurement), and the process keeps working (`1+1` still returns `ok:true`).
  That is the price of continuing in the same process instead of restarting it;
  a long batch of hostile samples should use worker processes per batch.
- Host heap is not covered by `limits.memoryBytes`. Values a host callback
  creates are released when the call returns (per-call bag), long-lived handles
  are bridge-owned and freed once at teardown, a handle returned by `bridge.fn`
  is transferred by the trampoline instead of duplicated, and a deferred promise
  releases its record when it settles (on the next bridge entry) or at teardown
  when it never settles. A 20 000-call
  loop therefore stays on a plateau (`tests/sandbox-core.test.js`), but there is
  no host-heap cap: a sample that makes orders of magnitude more host calls is
  bounded by the timeout, not by `memoryBytes`.

**Concurrency**

- One guest run at a time per process: concurrent `run()` calls queue. Real
  parallelism needs separate worker processes, one WASM module each. A `run()`
  started from inside a hook, an env callback or guest code deadlocks on the
  queue — do not do it.
- A stack-limit breach (main script, timer or promise callback) leaves the
  runtime unreleasable. It is abandoned and the module recompiled; the record
  states it as `disposal { ok:false, leaked:true, stage:'runtime', skipped:true }`.
- Stack-breach classification is **intrinsic, not name-based**: a forged
  `{ name:'InternalError', message:'Maximum call stack size exceeded' }`, a
  renamed `Error`, a plain `Error('stack overflow')` and a prototype stand-in are
  all **not** classified — each reports `limitsHit: []` with a healthy
  `disposal { ok:true, errors:[] }`. Two engine shapes exist and both classify
  identically: a host `RangeError` thrown out of `evalCode`/`callFunction`/
  `executePendingJobs`, and the same overflow converted at a host-callback
  boundary into a guest `Error`. The second shape is certified by a host-side
  counter the guest cannot write (`runtime.stackSignals()`), which is also why a
  guest that *swallows* the converted overflow still returns `ok:true` with
  `limitsHit: ['stack']`. Intrinsic-shaped guest errors provide a fallback for
  interpreter stack and allocation/size failures, after real host stack and
  interrupt evidence are considered. This is not an unforgeable allocator
  witness: a guest that catches a genuine engine `InternalError` can retain and
  reuse its prototype. A real OOM may expose it even with default `stackBytes`,
  so the residual is not limited to the previously measured reduced-stack case.
  Ordinary guest-created errors and copied names/messages are not engine
  evidence. Guest callback errors retain their guest identity rather than
  becoming host stack signals. See `docs/SECURITY-MODEL.md` for the precise
  fallback, abandoned-runtime behavior and deployment limits.

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
- Per-tag interfaces are **minimal**: 39 tag interfaces exist (40 `HTML*Element`
  globals including `HTMLElement`) and `instanceof` works (structurally for the
  four tags the canvas module owns), but each interface carries only the members
  the shim defines. Interface constructors have an own `Symbol.hasInstance` a
  browser does not have, and `customElements` is an instance-shaped object that is
  not `instanceof CustomElementRegistry` even though the constructor is global.
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
- `crypto.subtle` is a **partial** WebCrypto implementation: `digest`,
  `generateKey`, `importKey`/`exportKey` and AES `encrypt`/`decrypt` exist at
  `HEAD`; signing (`HMAC`, RSA/ECDSA), `deriveKey`/`deriveBits` and `wrapKey` are
  absent and reported as such. At the pinned commit the surface was `digest` and
  `generateKey` only; the AES operations landed after it.
- Canvas, WebGL, audio and font surfaces return **deterministic profile values**,
  not pixels: there is no layout or rendering engine, and
  `getBoundingClientRect` returns profile-derived geometry. `new ImageData(w, h)`
  does install a real own `Uint8ClampedArray` `data` view (transparent black,
  Chrome's dimension rules, 64 MiB ceiling) and `getLineDash` is tracked through
  `save()`/`restore()`, but the shared class factory cannot see
  `arguments.length`, so `new ImageData(2)` reports the height rule instead of
  Chrome's "2 arguments required" `TypeError`. `getImageData` refuses a source
  larger than 4 MiB with a `RangeError` instead of allocating it.
- `EventSource` reconnects on the virtual clock for as long as the run's
  virtual-time budget allows (the mock body ends immediately), bounded by
  `maxVirtualMs`/`maxTimerCallbacks` rather than by `EventSource` itself.
- Hook failures are evidence with a budget: the bus keeps the newest 200
  failures, capped at 64 KiB of message text (2 KiB per message) and sets
  `errorsTruncated` when it drops anything; the report keeps the newest 50 and
  says so in Markdown. A sample cannot grow the sandbox by making every hook
  throw.
- `restore()` returns generated text without a trailing newline, so a file
  produced by redirecting stdout re-reports `changed:true` with zero changed
  passes. `--out` files are exact and round-trip with `changed:false`.

**Documentation and coverage**

- Coverage is recorded on two scopes. On the `tools/` scope
  (`--test-coverage-exclude='examples/**'`, the scope the review baseline
  88.08 / 75.26 / 80.33 was measured on) this tree measures **92.99 % lines /
  82.68 % branches / 90.62 % functions** — above the baseline on all three
  metrics. The whole committed tree measures 90.32 / 78.88 / 86.92, also above
  it. Both commands are recorded in `docs/VERIFICATION.md`.

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
- `docs/CONSTRAINT.md` — soundness model, translation fragment, API, budgets and
  known limits of the z3 component.
- `docs/REPORT-SCHEMA.md` — report shape.
- `docs/VERIFICATION.md` — every number in this README, with the command that
  produced it, plus the `D1`–`D12` disposition matrix.
- `docs/DESIGN-REVIEW.md` — the seven review passes and their dispositions.
- `docs/EVALUATION-TOOLS.md` — the `tools/` evaluation record and targets.
- `docs/RESEARCH-ANTI-ANALYSIS.md` — researched detection techniques and the
  P0/P1/P2 requirements they impose.
