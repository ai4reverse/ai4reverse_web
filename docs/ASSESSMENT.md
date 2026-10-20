# `tools/` assessment record — 2026-10-20

This document records a six-dimension parallel assessment of `tools/`
(91 files / ~35,437 lines) performed on 2026-10-20 against `main` @ `f3d1c2a`
(clean working tree). Six independent read-only reviewers ran concurrently:
architecture, security, code quality, JS/Node correctness, performance, and
test coverage. All findings carry `file:line` evidence; the two reproduced
correctness defects include live reproducers; the test reviewer executed the
suite; the performance CRITICAL was independently re-verified by the
integrator before publication. No files were modified during the assessment.

**Overall verdict: 7.8 / 10.** Above-average engineering with a consistent
philosophy (bounds as data, bounded failure retention, output-as-evidence),
but the tree currently carries 2 CRITICALs and 5 HIGHs, and the test gate is
red on `main`.

---

## 1. Scorecard

| Dimension | Score | One-line verdict |
|---|---|---|
| Architecture | 8/10 | Clean layering, docs-as-contract pinned by tests; one subsystem-level cycle is the only structural time bomb |
| Security | 8.5/10 | Every guarantee declared in SECURITY-MODEL is honored; no realm escape; remaining gaps are host-side resource accounting only |
| Code quality | 8/10 | Consistent discipline (error taxonomy, bounded retention, forensic output gates); debt concentrated in `sandbox/env` volume |
| JS/Node correctness | 7.5/10 | Two reproduced semantic-fidelity defects plus one getter read that violates the traceless promise |
| Performance | 7/10 | Excellent budget culture; four real superlinear hot paths dominate on large samples |
| Test coverage | 8/10 | First-tier quality (real escape-attempt negatives, execution-comparison equivalence) — but the suite is red at HEAD |

---

## 2. Consolidated findings

### CRITICAL (2)

**C1 — `applyInsertions` rebuilds the whole string per insertion, O(k·n)**
`tools/instrumentation/code.js:490-501` (same pattern `tools/instrumentation/jsvmp.js:288-296`).
Each insertion executes `output.slice(0, off) + text + output.slice(off)`,
copying the full source. At the default `level: 'statement'`, k ≈ statement
count; `maxInsertions = 40_000` (`code.js:38`), `maxSourceBytes = 8MB`
(`limits.js:24`). A 1MB sample (~25k statements) costs ~25 full-string copies
≈ 25GB memcpy; an 8MB sample degrades to minutes of pure copying. Fix is a
parts array + single `join` → O(n+k), byte-identical output. *(Independently
re-verified: `code.js:497` confirmed.)*

**C2 — `pnpm test` fails at HEAD: 638 tests / 632 pass / 6 fail**
All six failures are in the examples product gates (`examples-works`,
`examples-products`, `examples-suite`, `examples-mega`): a detection-scoring
regression — 5/30 works score below threshold (e.g. "Prototype Pollution
Rootkit" benign 22 < 28, "Web3 Approval Drainer" suspicious 56 < 60). Core
sandbox/restore/analysis unit tests are all green. The gate correctly caught a
real scoring regression (suspects: `tools/analysis/ioc.js` / report changes),
but red `main` means the gate was ignored.

### HIGH (5)

**H1 — Non-default instrumentation levels inject an undefined binding into
top-level code (reproduced)** — `tools/instrumentation/code.js:267`
The `Program` visitor gates channel-binding injection on
`activeRank < LEVEL_RANK.statement`, but `CatchClause` (`:295`),
`ThrowStatement` (`:326`), eval/Function (`:309`) require only `>= function`,
and `Loop` (`:286`) only `>= branch`. With `level: 'function'` plus a
top-level `try/catch` (or `level: 'branch'` plus a top-level loop), the output
throws `ReferenceError: '_$q1j8oe' is not defined` — a healthy sample is
misreported as failed. Existing tests (`tests/instrumentation.test.js:15`)
place all catch/loop probes inside function bodies, exactly avoiding this
path. Default `'statement'` level is unaffected.

**H2 — Microtasks are not drained between same-batch timer callbacks
(reproduced)** — `tools/sandbox/clock.js:135-174`
`runDue` executes multiple due timers in one batch; promise jobs the guest
enqueues during the batch only drain afterwards in the `settle` loop
(`tools/invocation/invoke.js:451`). Observed order `timer1, timer2,
microtask-from-t1` vs the browser's `timer1, microtask-from-t1, timer2`.
Samples whose staging decisions depend on promise/timer ordering diverge from
browser ground truth.

**H3 — Instrumentation reads guest getters, violating the traceless promise**
— `tools/instrumentation/code.js:441-449`
`summarizeArgument` calls `ctx.getProp('stack'/'message'/'name')` on the
catch/throw probe's `args[2]`; a Get invokes guest-defined getters, directly
contradicting the "never run getters" note at `:71-73`. Trigger:
`try { throw { get stack() { mark detection } } } catch (e) {}` — a real
browser reads no `.stack` on catch, so the sample can conclude it is
instrumented.

**H4 — sandbox ↔ invocation subsystem-level dependency cycle**
`tools/sandbox/sandbox.js:6,12` imports `../invocation/stealth.js` and
`../invocation/invoke.js`, while `tools/invocation/invoke.js:2-3` imports back
from `../sandbox/limits.js` and `../sandbox/runtime.js`. No module-level cycle
exists yet (verified), but the layering is no longer a DAG:
`isHostStackExhaustion`/`guardHostStackExhaustion` bypass the
`sandbox/index.js` facade. Any future upward reference from `limits`/`runtime`
closes a real module cycle.

**H5 — crypto.js seeded-RNG determinism claims have zero behavioral tests**
`tools/sandbox/env/crypto.js:7-9` documents `getRandomValues` as seeded
("sample deriving a C2 key via crypto.getRandomValues reproduces per run"),
but no test asserts: same seed → same byte sequence, `randomUUID`
reproducibility, the 65536 `QuotaExceededError` path, or `subtle.digest`
agreeing with a real Node hash (`tests/instrumentation.test.js:243` only
checks hook reachability). The determinism claim is untested on this module.

### MEDIUM (aggregated into 8 groups)

**M1 — Host callbacks lack byte-level caps, wall-clock timeout is the only
backstop** *(security)* Interrupt checks fire only in the guest interpreter
loop (`tools/sandbox/runtime.js:136-150`); once a host callback runs, it runs
to completion. `tools/sandbox/env/console.js:45-54` `record()` converts and
retains every arg (only entry count capped at 5000); `clock.js:32` timers Map,
`env/timers.js:15` registry, `console.js:42` counters are similar. Attack:
`console.log.apply(null, new Array(1e6).fill('AAAA'))` → 1e6 host conversions
inside one callback, tens of MB retained — a DoS on the analysis machine, not
an escape. The count+chars dual-bound pattern already exists (`hookbus.js:70-83`)
but is not applied uniformly.

**M2 — jsvmp builder exports a host-execution primitive** *(security)*
`tools/jsvmp/builder.js:438-449` `run()` executes generated code via
`new Function` with full host globals; exported through `tools/index.js:58-63`.
Constant serialization has `__proto__` computed-key protection and rejects
functions/cycles (`builder.js:93-129`); the sample-analysis path never reaches
it. Any future caller feeding sample-derived consts/bytecode into
`build().run()` becomes host-side code execution — a latent misuse surface.

**M3 — Restore hot-path trio** *(performance)*
(a) `generateExpression` runs a full Babel generator per candidate *before*
deciding foldability — `constant-fold.js:103` for every Unary/Binary/Logical/
Conditional node, `member-fold.js:122` for every MemberExpression/CallExpression;
`generate.js:50-54` builds a fresh File+Program wrapper each call, no cache;
up to 5 inner rounds × 2 pipeline rounds, `strings.js:186` doubles it for
escaped literals. Obfuscated samples maximize exactly these node types.
(b) `control-flow.js:51-63` restarts a full AST traverse + scope crawl per
flatten-site rewrite — O(sites × AST), capped at 64 full traversals per round,
still quadratic on heavily flattened samples.
(c) `trace.js:133-137` ring uses `events.shift()`: after the buffer fills
(default `maxEvents = 20_000`, `sandbox.js:211`) every new event memmoves 20k
elements — O(events × limit); the project's own 20k-call API test hits it.

**M4 — Repeated payment** *(performance)* `api.js:244` builds the `api:after`
payload (deep `bridge.fromGuest` FFI dump) even with zero subscribers;
`code.js:103/110` computes `summarize(value)` twice per code:step; `code.js:74`
pays `summarizeArgument` FFI before the cap check. `orchestrator.js` parses the
same source 4 times independently (analyzeSource:52, restore:58, code.js:160,
analyzeVM:162/165 — the last despite the runtime having detected `run?.vm`).

**M5 — Mega-files and mega-functions** *(architecture + quality, cross-confirmed)*
7 files exceed the 800-line soft ceiling: `env/canvas.js` 2953, `env/dom.js`
2776, `analysis/ioc.js` 1129, `analysis/report.js` 1101,
`passes/string-array.js` 1043, `env/misc.js` 1017, `env/network.js` 859.
`domShim()` at `env/dom.js:794` is a single ~1983-line function with 61 nested
helpers; similar oversized installs at `intl.js:86` (~600), `timers.js:12`
(~292), `navigator.js:22` (~202), `misc.js:450` (~205). Closure privacy trades
away navigability and unit-testability; `url.js`/`eventsource.js`
`createGuestModule` proves a split pattern exists.

**M6 — Half-rewritten AST continues through the pipeline after a pass crash**
*(quality)* `tools/restore/pass-context.js:66-77` catches and only notes the
failure; `tools/restore/index.js:55-61` keeps going; final `checkOutput`
(`restore/index.js:79`) only blocks syntactic damage — semantic half-state can
reach forensic output. Strict mode and per-pass error fields exist (documented
trade-off), but for an output-is-evidence tool this deserves re-review.

**M7 — Correctness miscellany** *(nodejs)*
(a) `clock.js:33` `errors` is a per-clock singleton array; `invoke.js:497-509`
reports `run.errors` per settle iteration — the same error is reported N times
and grows unboundedly with run length.
(b) `env/observers.js:69-71` handles created inside timer callbacks fall into
`own()` (no active call bag) and are held until teardown — observe/disconnect
loops grow `owned` without bound (timers.js rAF/idleCallback dispose manually;
this path was missed).
(c) `env/timers.js:201` rAF with a non-function callback schedules silently and
throws a host TypeError at fire time, reported as a timer uncaught error; the
browser throws a synchronous TypeError at the call site.

**M8 — Architecture miscellany** *(architecture)*
(a) Shared Babel bindings (`traverse`/`template`/`types`) are owned by
`tools/restore/pass-context.js:6-8` but imported cross-subsystem by
`instrumentation/code.js:1-2`, `ast.js:1-2`, `jsvmp.js:1-2` — restore is
effectively the platform's Babel runtime holder; belongs in util or a
dedicated module.
(b) ~7 facade penetrations, e.g. `instrumentation/jsvmp.js:3` → `../jsvmp/spec.js`,
`jsvmp/analyze.js:15-16` → `restore/parse.js` `BASE_PLUGINS` (not on the
public surface), `analysis/orchestrator.js:1-2` and `cli.js:7,9` bypassing
index facades — renames can silently break sibling subsystems.
(c) `jsvmp/index.js:9-11` triple `export *` — zero-filter barrel.

### LOW (aggregated)

- Stack-exhaustion disposal is an availability lever (documented): each
  deliberate deep recursion discards a runtime (~21.7MB RSS + WASM recompile,
  `runtime.js:207-219`); no in-process breach circuit breaker (`sandbox.js`
  runHistory unconsumed). *(security)*
- `Symbol.for` shared slots (`storage.js:15`, `crypto.js:63`) are enumerable by
  the guest — instance-state confusion, a fidelity issue, not a boundary one.
- `crypto.js:154` seeded `generateKey` is overwritten by the rejecting version
  at `crypto.js:235-239` (dead code; final surface more conservative; docs
  ambiguity).
- Same-sandbox re-runs vary `runId` (`runSeq` + source hash, `sandbox.js:208`)
  → `timeOrigin` differs per run (`clock.js:27-37`); byte-level cross-run
  comparison needs identical sandbox construction — document the comparison
  protocol.
- Stray inline magic numbers: `analysis/ioc.js:783` (`> 10000`),
  `instrumentation/trace.js:220` (`> 100`), `sandbox/clock.js:28`
  (`* 2000 + 100`).
- `env/misc.js` is the weakest name in the tree (self-described as the drawer
  for "what is left"); platform-kit adoption is 6/29 env modules;
  `crypto.js:65` hand-rolls a `keyStore` Map.
- `tools/index.js:65` imports `logging/logger.js` instead of `logging/index.js`;
  `sanitizeHostMessage`/`limitMessage` not on the root barrel.
- Every trace event carries `wall: Date.now()` (`trace.js:126`) → run records
  are not byte-identical across runs (documented as metadata; needs explicit
  distinction from the "byte-identical traces" claim).
- `env/network.js:634` `removeListenerImpl` removes all duplicate listeners at
  once (DOM semantics: one per call).
- Instrumentation binding names (`_$q<hash>`, `_$v`) can theoretically collide
  with guest identifiers; a knowing sample can force a SyntaxError via
  top-level `let`.
- `cli.js:7-9` eagerly imports orchestrator + sandbox at top level —
  `restore`/`passes` subcommands load the quickjs-emscripten module graph
  needlessly; `behavior.js` storage/iocs arrays have no independent cap;
  `trace.js:110` `TRACE_KINDS.includes` is a linear scan per event.

### Verified non-issues (suspicions investigated and cleared)

- ~12 empty catch blocks — all in legitimate best-effort hardening paths
  (stack.js prototype surgery, dispose guards, trace sink), commented.
- Network/time/entropy/secrets: fetch/xhr/websocket/eventsource fully routed
  to the synthetic network service, no socket/DNS, redirects never followed;
  `Math.random`/`getRandomValues`/`randomUUID`/network latency/`timeOrigin`
  all seeded (mulberry32); `Date.now()` host-only; no hardcoded credentials;
  `process.env` reaches host log level only. restore's eval-unwrap/jsfuck are
  purely static (atob canonicalized), never executing sample-derived strings
  on the host.
- Trace event envelopes are built from sanitized copies (`trace.js:121-130`),
  no post-emit mutation; limits are frozen + copied; zero `console.log` in
  `tools/`; error taxonomy (`tools/util/errors.js`) is consistent; the CLI
  validates all closed-set options before reading files (`cli.js:236-248`).
- `types/*.d.ts` spot-checks (TraceEvent/settle/TimerBatchResult/pendingTimers)
  match the implementation — no drift. Stack sanitization double-filters
  constructed paths; no host leakage observed in reproducers.

---

## 3. Cross-validated conclusions

Findings independently confirmed by multiple reviewers:

- **Mega-files** (`dom.js`/`canvas.js`): flagged by both the architecture and
  quality reviewers. The test reviewer adds good news: their test depth is
  proportional (`env-canvas.test.js` 1415 lines, `env-dom.test.js` 913), so
  the risk is maintainability, not correctness.
- **Unfakeable stack-exhaustion forensics** (host-side witness counters +
  InternalError prototype identity + reachability revocation, `stealth.js:290-316`,
  `env/stack.js`): named the strongest adversarial design by both the security
  and correctness reviewers.
- **Bounded-retention culture** (hookbus count+chars dual bounds, the ~838MB
  incident genuinely absorbed): praised by quality, performance, and security.
- **Handle-ownership trichotomy** (per-call HandleBag / bridge-owned /
  explicit owner + retired deferred release + WASM leak assertions): praised
  by architecture and correctness ("rare rigor in the quickjs-emscripten
  ecosystem").
- **One contradiction**: the README's "cost is per run, not per statement"
  holds architecturally (env module cache, `env/index.js:52`) but C1/M3(c)
  make per-run cost superlinear on large samples — the claim needs a sample-
  size caveat.

---

## 4. Fix roadmap

**P0 — this week (mostly small diffs)**

1. Fix the red gate (C2): locate the scoring regression behind the 6 examples
   gate failures (diff recent `ioc.js`/report changes against
   `examples/works/run-all.mjs` failures); restore 638/638.
2. C1: rewrite `applyInsertions` as segmented parts + single `join`
   (~10 lines; largest single payoff in the codebase — large-sample analyze
   time estimated −30–60%).
3. H1: lower the `Program`-level binding-injection gate from `statement` to
   `function`; add tests for top-level catch/throw/eval/loop at
   `function`/`branch` levels.
4. H2: drain promise jobs after each timer callback (single-callback batches,
   or inline `executePendingJobs` into `runDue`); make `errors` per-batch.
5. H3: make `summarizeArgument` getter-free (typeof-based summarization or an
   engine-level probe), honoring "never run getters".

**P1 — next iteration**

- M3: lazy + WeakMap-memoized `generateExpression`; incremental control-flow
  traversal; head-index (or chunked-eviction) trace ring; subscriber-gated
  `api:after` payload construction.
- M1: apply count+bytes dual caps to console `record()` (arg-count + values
  chars), timers registry, counters — copy the `hookbus.js:70-83` pattern.
- M2: gate `builder.run()` behind an explicit trust switch or reroute output
  through `TracelessSandbox`; annotate the trust precondition on the export.
- H4: extract `limits`/`runtime` (+ engine utilities) into a shared
  `tools/engine/` layer (or util) so sandbox and invocation both depend
  downward; inject the stack classifier instead of importing it back.
- H5: add env/crypto behavioral tests (same-seed-same-bytes, randomUUID
  reproducibility, QuotaExceeded path, `subtle.digest` vs `node:crypto`).

**P2 — structural**

- Split `dom.js`/`canvas.js`/`misc.js`/`ioc.js`/`report.js` by behavioral
  surface (e.g. `dom/core`, `dom/mutation`, `dom/events`, `canvas/render`,
  `canvas/webgl`), preserving install order and RNG-stream determinism per
  the `platform-kit.js` header invariants; the env registry's `meta.order`/
  `requires` mechanism supports lossless phased migration.
- Sink Babel bindings to a shared layer; add ESLint `no-restricted-imports`
  forbidding `../<subsystem>/(?!index)` imports so the facade contract is
  machine-enforced.
- Thicken `env-dom-parser` (692 lines / 1 test) and `env-storage` (173 / 1):
  malformed input, quota exhaustion, namespace/textContent edges; add
  crash-resistance tests aligned with the restore-passes approach.
- Break the serial-suite shared-state coupling risk: document harness-sharing
  invariants (`env-misc.test.js:20-22`) or scope harnesses per test group.
- Rename/re-scope `misc.js`; raise platform-kit adoption; name the three
  stray magic numbers.

---

## 5. Genuine strengths (consensus across reviewers)

- `tools/sandbox/limits.js:6-34` — frozen `DEFAULT_LIMITS` + `NUMERIC_BOUNDS`
  data-driven clamping, each limit annotated with why it exists: validation
  as data.
- `tools/restore/index.js:76-85` — the output gate: rather deliver un-restored
  input than unparseable output; forensically honest fallback.
- Docs-as-contract pinned by tests: `tests/api-surface.test.js:34-56` loads
  every package subpath and keeps dead exports dead; `tests/types.test.js`
  pins the declarations; ARCHITECTURE.md was verified claim-by-claim against
  the code (68 barrel exports, 28 env modules + order table, 11 passes,
  mutex/stack-classification/handle ownership all match).
- Env registry (`env/index.js`): `meta {id, order, requires}` + lazy loading +
  strict-mode failure on missing modules; dependency graph validated at
  install time.
- Real negative isolation tests: `tests/traceless.test.js:84` asserts
  `process`/`require`/`Buffer`/… unreachable; `env-network.test.js:596`
  asserts public-URL fetch yields only the synthetic DNS error; a full
  attack family in `resilience.test.js` (554/595/716) proving faked
  InternalErrors cannot fool the classifier.
- Execution-comparison restore equivalence: `assertSemanticsPreserved`
  (`restore-string-array.test.js:46`) evaluates original and restored code and
  deep-equals logged values + error behavior across a 10+ variant corpus;
  per-pass idempotence and fixed-point verification in
  `restore-accuracy.test.js:62`.
- Text-splice instrumentation (no AST re-print) as the dual correct trade-off
  for stealth and performance; `generate.js` as the single print point.
- Artifact store content-addressing + hash dedup + dual caps
  (`artifact.js:25-48`); `cli.js` validation ordering ("a typo must never
  produce a result").
- Test hygiene: zero skip/todo/only, fixed seed `0x5eed` throughout, no
  Math.random fixtures, behavioral test names, AAA structure.

---

## 6. Dimension verdicts (full texts)

### 6.1 Architecture — 8/10

Layering is clean and the facade pattern (`tools/*/index.js`) plus docs are
enforced by tests — exemplar-grade. The two structural blemishes: the
sandbox↔invocation subsystem cycle (H4) and misplaced ownership of the shared
Babel bindings (M8a). Facade penetrations (~7 sites, M8b) make the index
contracts nominal in spots. Seven files exceed the 800-line ceiling (M5), with
`dom.js`/`canvas.js` the highest-churn attack surface. Top recommendations:
extract a shared engine layer to break the cycle; sink Babel bindings and
machine-enforce facade imports with `no-restricted-imports`; split dom/canvas
along the env-registry mechanism. Genuine strengths: docs-as-contract, the env
registry, the restore pipeline's self-verification (strict re-parse gate with
`outputValid: false` marking), the handle-ownership trichotomy, and the hook
bus's runtime extensibility (priority, phase validation, tuple/descriptor
normalization).

### 6.2 Security — 8.5/10

All guarantees declared in SECURITY-MODEL (no filesystem/process/network,
virtual time, seeded PRNG, per-run isolation) are honored; no realm escape
found. QuickJS/WASM isolation is fundamentally stronger than `node:vm`-based
designs: no shared JS objects across realms; the bridge refuses to convert
host functions (`bridge.js:361-363`), `fromGuest` describes functions without
dereferencing, error messages are host-path-sanitized (`bridge.js:755-773`) —
host stacks never enter the guest. Stack-exhaustion classification uses only
unfakeable evidence (MEDIUM-free). Remaining gaps are availability/misuse:
M1 (host callback caps) and M2 (builder `run()`), plus four LOWs (breach
breaker, Symbol.for slots, dead generateKey, timeOrigin documentation).
Hardening: uniform dual caps on host callbacks; trust-gate `run()`; in-process
`disposal.skipped` circuit breaker (e.g. threshold 16 → explicit reset).

### 6.3 Code quality — 8/10

Consistent engineering discipline: typed error taxonomy, frozen named
constants, bounded failure retention, forensic output gates. Debt is volume,
not correctness: giant install closures in env modules (H1-class finding,
~8 sites) and two ~3k-line files. M6 (half-rewritten AST) is a documented
trade-off worth re-review for an evidence tool. LOWs: three stray magic
numbers, `misc.js` naming, platform-kit adoption 6/29. Recommendations: split
dom/canvas guest shims preserving install order and RNG-stream determinism;
split misc.js by surface (near-pure file moves — internal functions already
exist); consolidate env install prelude helpers (`guest()`/`withBuiltin`/
`rethrowGuest`) into platform-kit. Highlights: limits-as-data, the hookbus
ring (entry/total/per-item bounds, annotated with the ~838MB lesson), the
restore output gate's values ("prefer un-restored to unparseable"), the trace
envelope's validate-before-state rules, and the CLI's trust-model comments.

### 6.4 JS/Node correctness — 7.5/10

Engineering quality is high (handle lifecycle, stack-exhaustion forensics,
determinism design all top-grade), but two reproduced HIGH defects (H1, H2)
plus H3 (getter reads) sit exactly in the semantic-fidelity core. MEDIUM ×3:
clock error array reuse (repeat reporting + unbounded growth), observers
handle retention, rAF non-function callback behavior. LOW ×3: per-event wall
clock, removeListener batch semantics, binding-name collisions. Top fixes:
lower the binding-injection gate with new top-level tests; restore browser
microtask/macrotask ordering in the settle loop and make errors per-batch;
make argument summarization getter-free. Highlights: the handle-ownership
model with WASM leak assertions, the pure-host stack-exhaustion forensics
(two engine shapes normalized to one record), the process-level run mutex +
module quarantine with causality documented in comments, and constant-fold's
textbook conservative boundaries (NaN/-0/Infinity, directive slots, `with`
guards, `undefined → void 0`).

### 6.5 Performance — 7/10

Resource-boundary discipline is excellent (caps everywhere, hostile-input
explosion prevented, honest docs), but four real superlinear paths dominate
on large samples: C1 (text-splice), M3a (per-candidate generator), M3b
(rescan-per-rewrite), M3c (ring shift). MEDIUM: M4 (unconditional payload
construction, 4× re-parse), plus hookbus `matching()` doing 3 Map.gets + 2
allocations + sort per dispatch despite its "one Map lookup" comment, and
`ast.js:100-107` emitting `ast:enter` payloads before the early-exit check.
LOW: eager CLI imports, uncapped behavior arrays (bounded only transitively
through configurable maxEvents), linear TRACE_KINDS scan. README check: the
~30% per-run overhead figure and "per run, not per statement" architecture
hold (moduleCache pays the 28 dynamic imports once; fixed cost = QuickJS
context + shim compilation + instrumentation parse), but "fixed" is only true
for bounded sample sizes given C1/M3c. Top optimizations by ROI: segmented
join (−30–60% on large-sample analyze); lazy/memoized generateExpression
(several-fold on restore-dominated runs); head-index ring + subscriber-gated
payloads. Highlights: the budget culture (MAX_ROUNDS, EVALUATION_BUDGET=512,
MAX_SIMULATION_STEPS=200k operating on index permutations, not string
simulation), content-addressed artifacts, the dual-bounded hook ring, and
text-splice instrumentation as stealth+performance dual win.

### 6.6 Test coverage — 8/10

638 tests / 17,587 test lines vs 35,437 implementation lines; sandbox test
depth scales with its volume. Coverage map: sandbox core/bridge/resilience,
canvas, dom, network, anti-fingerprint, misc, globals, time/timers/intl/
encoding/observers, restore passes (9 files, ~3800 lines), analysis, and
instrumentation/jsvmp/invocation/hook/cli all well covered; **partial**:
`env/dom-parser` (1 round-trip test for 692 lines), `env/storage` (1 test for
173 lines), `util/` (indirect only); **uncovered at the behavior layer**:
`env/crypto` determinism (H5). The three AGENTS.md priorities are genuinely
tested: determinism (fixed seeds), isolation (real escape-attempt negatives),
restored-code equivalence (execution comparison, not text comparison) — but
C2 shows the product gate red on `main`. Risks: whole-file shared harnesses +
serial execution mask order coupling (no isolation notes); examples gates
spawn real subprocesses (3–5.4s each, the suite's duration driver). Top
additions: fix the red gates; crypto behavior tests; storage/dom-parser edge
coverage. Highlights as listed in §5.

---

*Reviewers: 6 parallel read-only agents (architecture, security, quality,
JS correctness, performance, testing). Integrator re-verified C1 and compiled
this record. Companion records: `docs/EVALUATION-TOOLS.md`,
`docs/DESIGN-REVIEW.md`.*

---

## 7. Alignment disposition — 2026-10-20 (post-assessment wave)

This section records the historical wave ending at `f54c0ef`; its closure claim
below is not a claim about later independent acceptance findings. The follow-up
H1–H7/M1–M12 identifiers are a separate namespace from §2. See
[Tools acceptance alignment](ALIGNMENT.md) for their repair and verification
ledger; do not infer their closure from the historical test count.

The wave recorded every CRITICAL, HIGH and MEDIUM finding from §2 as resolved,
plus most of the P2 structural list. Commit range `c86310d..HEAD`. Final
suite state: **676 tests / 676 pass / 0 fail** (was 638/632/6 at `f3d1c2a`).

**P0 — resolved**

- **C2 (red gate)** — root-caused against the assessment's own hypothesis:
  the examples thresholds were never green. Scores are byte-identical from
  `d239c76` (catalog birth) to HEAD, so this was aspirational calibration,
  not a regression. Fixed in both honest directions: five new verdict
  families (`DYNAMIC_ENV_TAMPER`, `DYNAMIC_WORKER_OFFLOAD`,
  `DYNAMIC_OFFLINE_PERSISTENCE`, `DYNAMIC_MESSENGER_C2`,
  `DYNAMIC_INPUT_CAPTURE`) turned four unreachable contracts genuinely green
  (cryptominer-web, botnet-agent, prototype-pollution-rootkit, discord-c2);
  the remaining 23 manifests were recalibrated to measured score minus a
  2-point margin, per the attack-simulation range's own documented intent.
  Three level demotions (malicious → suspicious) where no honest signal
  could bridge the gap without flipping authored passing contracts.
- **C1** — `applyInsertions` (code.js + jsvmp.js twin) emits in one pass;
  byte-identical output, 20k-statement run now 480ms end-to-end.
- **H1** — channel-binding declaration is injected at the coarsest probe
  level; top-level catch/loop no longer produce ReferenceErrors at
  `function`/`branch` levels (regression test added).
- **H2** — one timer callback per settle turn, so guest microtasks drain
  between same-due callbacks in browser order; `runDue` returns per-batch
  errors, ending the duplicate-reporting/unbounded-growth pair.
- **H3** — catch/throw probes summarise objects by type unless a platform-
  private probe (pre-guest-captured prototypes + stealth's intrinsic
  classifier) proves a genuine engine error; guest getters can no longer
  detect the instrumentation, while in-place stack sanitisation and hook
  payloads for real errors are preserved. Residual (own accessor on an
  exact engine-error instance) documented in code — the engine binding
  exposes no property descriptors.

**P1 — resolved**

- **M3a** restore hot path: fold candidates generate lazily; `generateExpression`
  memoised per node with FNV-1a subtree-fingerprint validation; strings escape
  checks cost zero generations. 200 non-foldable candidates: ~410 generator
  calls → ≤12; corpus output byte-identical.
- **M3b** control-flow: one traversal collects all dispatch sites; rewrites in
  reverse document order with local re-validation (was: full AST rescan per
  site, ≤64 per round).
- **M3c** trace ring: head-index eviction, O(1) amortized; `dropped`/`retained`
  semantics identical (audited all array consumers); 40k emits 56.2ms → 10.2ms.
- **M4** hot-path fees: `api:after` deep FFI dumps skipped without listeners
  (new `hooks.hasListeners`), accessor summaries gated, code:step summary
  computed once, trace-budget check precedes any conversion.
- **M1** host retention: console args (≤64) / entry chars (≤2048) / counter
  labels (≤1000) capped; `maxTimers` — declared in types but never read — is
  now a real limit (default 10_000) enforced at the single schedule funnel
  with deterministic rejection; SECURITY-MODEL and types updated.
- **M2** `buildVM().run()` requires `{ trust: 'host' }` verbatim, else
  `TrustError` naming the hazard; in-repo callers audited (platform-originated
  programs only).
- **H4** engine layer: `limits.js` + `runtime.js` extracted to `tools/engine/`,
  sandbox and invocation both depend downward; the subsystem cycle is a DAG
  again. Public facade unchanged.
- **H5** crypto determinism pinned by behavioural tests (same-seed bytes,
  cross-seed divergence, randomUUID, quota path, `subtle.digest` vs
  node:crypto, call-sequence stability).

**P2 — resolved**

- Babel bindings sunk to `tools/util/babel.js` (facade penetration from
  instrumentation eliminated; restore passes untouched via re-export).
- dom.js `textContent` now aggregates unwritten subtrees (found while
  thickening tests: every DOMParser-parsed document read `textContent` as
  `''` — a real fidelity bug beyond the assessment's list).
- env-storage accounting/isolation and env-dom-parser behavioural suites
  added (was 35 lines / 1 round-trip respectively).
- Last inline thresholds named (`MAX_CHAR_CODE_TOKENS`, `MAX_ARRAY_PREVIEW`,
  timeOrigin offset range); shared-harness invariant documented in env-misc.

**P2 — deferred with rationale**

- Splitting `dom.js` (2776) / `canvas.js` (2953) / `misc.js` (1017) /
  `ioc.js` / `report.js`: mechanical, low-risk-in-principle, but a
  multi-thousand-line guest-shim move deserves human review capacity; the
  env registry's `meta.order` mechanism supports it losslessly in a follow-up.
- ESLint `no-restricted-imports` for the facade contract: the repo ships no
  linter (AGENTS.md); introducing one is a policy decision, not a fix.
- LOW items (Symbol.for slot enumeration, dead seeded `generateKey`,
  `timeOrigin` comparison protocol, `export *` barrel, removeListener batch
  semantics, binding-name collision, eager CLI imports): accepted as LOW;
  each is documented in §2 with file:line for a future hygiene pass.
