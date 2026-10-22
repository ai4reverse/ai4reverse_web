# Architecture

This document describes how the platform is put together, why the layering is
what it is, and where to extend it.

## 1. Layers

```
tools/
├── index.js                  public barrel (78 exports)
├── cli.js                    analyze | restore | run | constraint | taint | passes | version
│
├── logging/logger.js         pino + pino-pretty, redaction, event sink
│
├── util/                     seedable PRNG, hashes, handle bag, typed errors
│
├── engine/
│   ├── runtime.js            QuickJS module (memoised), limits, interrupt handler
│   └── limits.js             normalized resource limits
│
├── sandbox/
│   ├── sandbox.js            TracelessSandbox: one fresh runtime per run
│   ├── bridge.js             the only sanctioned handle API for env modules
│   ├── profile.js            seeded, coherent browser fingerprint
│   ├── clock.js              virtual clock + timer queue
│   ├── integrity.js          intrinsic snapshot / diff
│   └── env/                  28 platform-surface modules (+ loader + platform-kit)
│
├── invocation/
│   ├── stealth.js            native branding, marker masking, stack sanitiser,
│   │                         intrinsic stack-error probe
│   └── invoke.js             script/module/entry invocation, event-loop settle
│
├── instrumentation/
│   ├── trace.js              deterministic structured event recorder
│   ├── code.js               text-splicing statement/function/eval instrumentation
│   ├── api.js                host-API wrapping with hook dispatch (native brand)
│   ├── exception.js          uncaught/caught/promise-job funnel
│   ├── ast.js                static facts + ast:* hook phases
│   ├── jsvmp.js              dispatch-loop detection/instrumentation/summary
│   └── index.js              composition facade
│
├── hook/
│   ├── hookbus.js            phases, priorities, dispatch/pipeline, isolation
│   ├── code-hook.js          anti-analysis pattern detection, static IOC tap
│   ├── api-hook.js           traceless mocks + sensitive-API observation
│   ├── exception-hook.js     uncaught/caught callbacks
│   ├── ast-hook.js           node counters
│   └── index.js              default hook set + registration
│
├── restore/                  one parse → pass chain → one generate
│   ├── parse.js generate.js pass-context.js index.js
│   └── passes/               11 conservative, idempotent passes
│
├── jsvmp/
│   ├── spec.js               opcode table + assembler + semantics
│   ├── builder.js            runnable (obfuscatable) JSVMP source generator
│   └── analyze.js            dispatch/handler/const-pool recovery
│
├── constraint/               z3-backed static constraint solving
│   ├── z3.js                 lazy WASM load, private contexts
│   ├── translate.js          Babel AST → z3 terms, exactness/purity tracking
│   ├── solve.js              sat/model, validity, equivalence, simplification
│   ├── analyze.js            opaque predicates, path feasibility, budgets
│   ├── limits.js             candidate/time/size bounds
│   └── render.js             human-readable projection
│
├── taint/                    bounded static Circle-IR analysis
│   ├── analyze.js             source/options validation, Worker deadline/lifecycle
│   ├── worker.js              isolated engine + parser ownership
│   ├── config.js              per-request source/sink/sanitizer configuration
│   ├── report.js              bounded taint IR projection, truncation evidence
│   └── limits.js render.js    budgets and Markdown evidence
│
└── analysis/
    ├── ioc.js                static/decoded/dynamic IOC extraction
    ├── report.js             report builder + weighted verdict + Markdown
    ├── behavior.js           trace → API/network/storage/DOM/kill-chain
    ├── artifact.js           content-addressed payload store
    ├── stage.js              staged-payload extraction (eval/atob/network/console)
    └── orchestrator.js       the composed pipeline
```

## 1.1 Environment module map

`tools/sandbox/env/` holds 30 files: `index.js` (the loader), `platform-kit.js`
(the shared helper layer — **not** a module: it exports `createKit` only) and 28
modules installed in `meta.order`:

```
 10 globals          20 console          25 time            27 stack
 28 random           30 dom              32 dom-parser      45 screen
 50 location         55 storage          58 navigator       65 timers
 70 encoding         75 performance      80 crypto          80 xhr
 82 network          84 fetch            85 eventsource     86 websocket
 88 url              92 blob            100 misc           105 canvas
108 observers       110 intl             115 chrome          130 anti-fingerprint
```

`ENV_MODULE_IDS` is exactly that list (28 ids). Sorting is `(order, id)`, so the
only tie — `crypto` and `xhr` at 80 — is deterministic. Every `requires` names a
module installed strictly earlier; a subset install either satisfies the graph or
throws `SandboxError` in strict mode, it never drops a surface silently.
`url` owns `URL`/`URLSearchParams`/legacy `webkitURL`/`external`, `blob` owns
`Blob`/`File`/`FormData`, `navigator` owns `navigator` plus permissions/
connection/battery/mediaDevices/plugins/storage, `dom-parser` owns `DOMParser`/
`XMLSerializer`, `eventsource` owns `EventSource`, and `misc` owns what is left
(`AbortController`, Notification, Worker, BroadcastChannel,
`RTCPeerConnection`, `structuredClone`, the `indexedDB`/`caches` stubs, …).

URL-bearing browser default actions are captured, never performed: an
`<a href>`/`<area href>` click and `HTMLFormElement.submit()`/`requestSubmit()`
resolve the target against the live document URL, emit one `net` request and an
IOC, and leave `document.URL`/`location.href` unchanged. An empty form action
submits to the document URL, relative targets resolve against it, non-http(s)
schemes are recorded as blocked (an anchor with no `href` sends nothing), and
`preventDefault()` cancels the click action. The
`encoding` module and `Blob.text()` move text as UTF-16 code units joined in
4,096-unit chunks, so codec payloads are not capped by QuickJS's call-argument
limit and embedded NULs survive.

## 1.2 Guest runs are serialized; a poisoned module is quarantined

All sandboxes in a process share one QuickJS WASM module (memoised in
`tools/engine/runtime.js`) and a module executes one guest at a time. Guest code
runs synchronously, so a second `run()` is suspended at its first `await`; a
host-time budget measured from runtime creation would then expire on the first
statement after the neighbour released the thread, abort the evaluation and leave
guest objects on that runtime's GC list. `TracelessSandbox.run()` therefore
appends its whole body to a promise-chain mutex (`withGuestRunLock`) — one guest
run at a time per process, queued callers never rejected, separate worker
processes for real parallelism.

`runtime.js` also tracks module health: a runtime whose `dispose()` aborts marks
its module unhealthy (`markModuleUnhealthy`, internal), and `loadQuickJS()`
returns a *healthy* module, creating a new one (and replacing the memoised
promise) when the current module is quarantined. A stack-limit breach does not
even attempt the dispose: the runtime is abandoned (`runtimeHandle.abandon()`),
the module is quarantined, and the run record says
`disposal { ok:false, leaked:true, stage:'runtime', skipped:true }`.

### 1.3 One stack classification, two engine shapes

QuickJS produces the same overflow in two shapes, and the difference is invisible
from the guest's side:

1. **Host throw.** The WASM native stack gives out inside `evalCode`,
   `callFunction` or `executePendingJobs` and a host `RangeError` escapes the
   trampoline. `runtime.js` `isHostStackExhaustion` recognises it.
2. **Converted guest error.** The same overflow happens inside a host callback.
   quickjs-emscripten catches the host exception and rethrows it into the guest
   as `ctx.newError(...)` — an `Error` that is shape-identical to
   `throw new RangeError('Maximum call stack size exceeded')`. No host throw
   reaches the invoker, so a message test would either miss it (F-B4) or accept
   a forgery (N1).

The platform therefore records the signal **host-side, before the conversion**:
`runtime.js` `guardHostStackExhaustion` increments a counter
(`runtime.stackSignals()`) that no guest value can write, and `invoke.js` reads
it around the branch it just ran (`noteHostStack`). Both shapes then go through
one record builder (`stackBreachOutcome`), so a run record cannot reveal which
shape happened: `error.stack === ''` (the frame list grows with recursion depth),
`limitsHit: ['stack']`, `stackExhaustion: true` and the abandoned-runtime
disposal.

The guest-side fallback handles intrinsic-shaped engine errors without a host
witness, including reduced-stack recursion and allocation/size failures. It uses
prototype **identity** against `InternalError.prototype`, captured in
`stealth.install()` before any env module runs. `env/stack.js` gives its wrapper
a fresh prototype so Firefox keeps a faithful constructor without exposing the
intrinsic; failure to install the wrapper revokes this fallback. Real host stack
evidence wins, then host interrupt reasons, then intrinsic-shaped subtypes.

This fallback is not an unforgeable allocator witness: catching a genuine engine
error can expose a reusable prototype, including OOM at default stack size. The
residual scope and deployment boundaries are documented in `SECURITY-MODEL.md`.
Guest callback errors stay guest handles rather than being recreated as host
errors with attacker-selected engine wording.

Two consequences worth knowing:

- A guest that **swallows** the converted overflow still classifies: the run is
  `ok:true` with `limitsHit: ['stack']`, because the counter moved.
- Each breach costs host memory: the abandoned module's heap stays until the
  quarantined module is collected (measured ~17–22 MB RSS per breach). The run
  record states the leak; the process keeps analysing with a fresh module.

## 2. One dynamic run, step by step

`TracelessSandbox.run(source, options)`:

1. **Clock and trace.** A per-run virtual clock (seeded by run id) and a trace
   recorder limited by `limits.maxEvents`.
2. **Hook bus.** A fresh bus with the default registrations (code/api/exception/
   ast) plus caller registrations. Every registration declares its traceless
   footprint.
3. **Runtime.** A new `QuickJSRuntime` with memory/stack limits and an interrupt
   handler that enforces the host timeout and the virtual-time budget. Interrupts
   never advance the clock (that is the code channel's job), so guest-observed
   time is a deterministic function of executed statements.
4. **Context + stealth.** `Function.prototype.toString` is replaced by a native
   masker before any other code runs, and the engine's `InternalError` is captured
   before an env module can delete it — that captured prototype is what classifies
   a genuine stack breach later (`stealth.isIntrinsicStackError`). Shim sources
   registered later are mapped to `[native code]`.
5. **Bridge.** Owns handle lifetime: host functions (`fn`), objects (`obj`),
   deep conversion (`toGuest`/`fromGuest`), promises (`deferred`), accessors, and
   a teardown list. Every handle it creates is disposed once.
6. **Environment.** `installEnvironment()` loads modules by order and validates
   `requires`. Strict mode is used by the integration test: a missing module
   fails the run instead of silently degrading fidelity.
7. **Instrumentation.** Code channel is created (a host function under a
   run-unique registered symbol on `document`), platform APIs are wrapped, and
   the integrity baseline is captured *after* all platform mutations so drift
   only reflects sample behaviour.
8. **Invocation.** `code:before` hooks may rewrite source; static analysis and
   JSVMP detection run; JSVMP dispatch instrumentation is spliced first, then
   statement/function instrumentation; the source is evaluated as a global
   script with a realistic filename. Optional entry call goes through the guest
   function.
9. **Settlement.** Promise jobs (`executePendingJobs`, which is also where
   `queueMicrotask` lands — there is no separate microtask queue) → virtual timers
   (`clock.runDue`), until idle or a cap is reached. Timer/callback errors are
   recorded, never thrown at the host. Each callback runs inside a host-stack
   window, so the counter in section 1.3 attributes a converted overflow to the
   callback that caused it (`settle.error.origin`).
10. **Integrity + record.** A second intrinsic snapshot is diffed. The run record
    contains result/error/limits, events, facts, VM info, hook audit, integrity,
    console/behaviour inputs, and disposal status.
11. **Disposal.** instrumentation → bridge → stealth → context → runtime →
    clock, each stage in its own `try/catch`, errors recorded as
    `{ stage, message }`. A failed disposal is reported
    (`disposal.ok === false`, `leaked`, `stage`); a stack breach skips the runtime
    stage entirely (`skipped: true`) because it was abandoned. Any *non-stack*
    WASM leak assertion is a platform bug. Handles that outlive their bridge call
    are owned rather than borrowed: the canvas module retains duplicated faces and
    scheduled task handles and releases them, and the observers module builds
    delivery-time entries from queued descriptors instead of keeping call-bag
    handles.

## 3. Trace event schema

```jsonc
{
  "seq": 42,                  // monotonic per recorder
  "t": 1792394400123,         // virtual epoch ms (deterministic)
  "wall": 1792395737000,      // host wall clock (metadata)
  "kind": "code",             // sandbox|code|api|exception|ast|jsvmp|dom|net|
                              // storage|timer|eval|hook|ioc|restore
  "phase": "step",            // emit|before|after|invoke|enter|exit|step|
                              // transform|skip|error|throw|catch|uncaught
  "actor": "sandbox",
  "event": "statement",       // code/exception payload discriminator
  "line": 12, "column": 4,    // source position of the instrumentation site
  "api": "window.fetch",      // api/dom/storage/timer payloads
  "url": "https://…",         // net payload
  "error": { "name": "...", "message": "...", "stack": "..." }
}
```

Payloads are bounded (strings 2 KB, arrays 100 items) so a malicious sample
cannot exhaust host memory through traces.

### 3.1 Attribution: the platform's own events are not sample behaviour

Building the environment emits trace events (`document.installed`,
`api.wrapped`, storage probes, …) whose payloads look exactly like a sample's.
`tools/analysis/behavior.js` therefore attributes every event
(`eventOrigin`): guest-originated events feed the behaviour counters, the
platform's own do not. Report scoring filters platform events as well, so a
sample cannot gain a `DYNAMIC_DOM` reason from the sandbox's setup, and
`dynamic.behavior.counts.platform` states how many events were excluded.
Measured effect on `examples/sample-loader.js`: 71 of 133 events are platform
events, and its verdict is 54 / `suspicious` instead of 60 / `malicious`.

## 4. Handle lifetime discipline

quickjs-emscripten aborts the WASM module on `runtime.dispose()` if any handle is
still alive. The platform therefore routes every creation through:

- `HandleBag` (per host-callback temporary, disposed LIFO even on throw),
- the bridge's internal `owned` set + `disposeAll()` (long-lived handles created
  by `fn`/`obj`/`arr`/`install`/`nativeConstructor`, disposed once at teardown),
- per-run teardown callbacks registered with `bridge.onDispose` (timers, deferred
  promises, store handles),
- explicit owners in `instrumentation/api.js` and `invoke.js`.

Three owners, and every handle belongs to exactly one (`docs/CONTRACTS.md`
"Handle ownership"):

| Owner | Lifetime |
| --- | --- |
| per-call `HandleBag` | one host callback; disposed in `finally`, even on throw |
| bridge `owned` set | install-time values from `fn`/`obj`/`arr`/`install`/`nativeConstructor`; disposed once in `disposeAll()` |
| explicit owner in module state | a `dup()` with a `retain()`/`release()` pair (`canvas.js`, `observers.js`) |

Two transfer rules keep that honest: `bridge.fn`'s trampoline hands a returned
handle to the guest instead of duplicating it (so returning a bag-owned value is
safe), and `bridge.deferred` releases its record when the promise settles — on
the next bridge entry, once the trampoline has duplicated the value — or at
teardown for a promise that never settles. That is what makes a 20 000-call
builder loop plateau instead of growing host memory (FINAL-D F2).

`run.disposal.ok` is asserted in tests; a leak surfaces as a failed run
(`{ ok:false, leaked:true, stage }`) rather than a mysterious process abort. The
single sanctioned exception is a stack-limit breach, where the runtime cannot be
released at all and is abandoned instead (section 1.2).

## 5. Extension points

- **New platform surface:** add `tools/sandbox/env/<id>.js` with
  `meta = {id, order, requires}` + `install(bridge)`, append the id to
  `ENV_MODULE_IDS`, and add a test using `tests/helpers/harness.js`. Use only
  bridge helpers; derive every fingerprintable value from `bridge.profile`.
- **New restoration pass:** add `tools/restore/passes/<id>.js` with the documented
  contract, import it in `passes/index.js`, and test with original-vs-transformed
  execution.
- **New hook:** register `{phase, handler, priority, owner, traceless}` on a bus.
  Phases are in `HOOK_PHASES`; `api:before` may block/rewrite, `code:before` and
  `ast:transform` are transform pipelines.
- **New analysis section:** add a module under `tools/analysis/`, wire it in
  `orchestrator.js`, and extend `docs/REPORT-SCHEMA.md` (keep the shape
  additive).
- **New constraint theory:** extend `tools/constraint/translate.js` and set
  `exact`/`pure` honestly; a term that only holds under the integer model must
  stay `exact:false`. Add a regression in `tests/constraint.test.js`.
- **New JSVMP shape:** extend `tools/jsvmp/spec.js` semantics and
  `detectDispatch()` heuristics; the instrumentation only needs case offsets.

## 6. Why the restoration pipeline does not execute samples

Restoration is static: it must be safe on a live sample and must not change
behaviour. The dynamic run always executes the original bytes. `runRestored`
optionally executes restored code in a *second* fresh sandbox for comparison,
never in place of the original.

The pipeline is one parse → pass chain → one generate, and it validates its own
output: `restore()` re-parses the generated text strictly
(`errorRecovery: false`, both source types, see `validateOutput`) and, if that
fails, returns the **input** source with `outputValid: false`,
`outputError: { message }`, `map: null` and a note on the pipeline report. A pass
may be wrong; the pipeline may not hand back code that does not parse. `changed`
is likewise evidence-bound: it is `outputValid && (a pass changed the generated
text || generated text !== input)`, and a pass may only claim a change when
`compareGeneratedText` reports different text. `rename` declares
`meta.deferred` and runs once, in the final round.

## 7. Constraint solving

`tools/constraint/` answers four questions statically: is a condition constant,
is an `if` arm reachable, what input satisfies a conjunction, and are two
expressions equivalent? It never executes the sample.

The pipeline is one parse → candidate collection → AST→z3 translation → bounded
solver queries:

- **Candidates.** `if`/ternary/loop tests and logical expressions, deduplicated
  by source span. `enclosingConditions()` walks outward to the nearest function
  boundary, adding `if`/ternary polarity, short-circuit facts and loop guards.
- **Translation.** `translate.js` models bitwise operators through signed
  32-bit vectors (exact for every JS value), boolean structure, `typeof` and
  comparisons of exact values. Integer arithmetic is an `Int` model and carries
  `exact:false` unless the caller sets `assumeIntegers`.
- **Proofs.** `unsat(not P)` means always-true; `unsat(P)` means always-false.
  A branch is unreachable when its path conjunction is `unsat`. `unknown` from a
  timeout is counted, never treated as a proof.
- **Fresh names.** Atoms are unique for the lifetime of a context. Per-call
  `b0`/`eq0` names would conflate unrelated path conditions and could produce a
  false `unsat`.
- **Integration.** `analyzeSample()` runs the analyzer by default and writes
  `report.static.constraint` plus a Markdown section. Findings are evidence, not
  verdict weights. `constraints:false` keeps a stable disabled shape.
- **Limits.** `CONSTRAINT_LIMITS` bounds candidates, branches, path depth,
  expression depth/nodes, per-query time and total solver time; a tripped bound
  sets `truncated` and a note.

Soundness is a contract, not a comment: `exact`, `nanSafe`, `integral` and
`pure` are tracked per term, and the tests pin the `NaN` reflexivity
counterexample and the integer-assumption gate. The full model is in
`docs/CONSTRAINT.md`.

## 8. Taint analysis

`tools/taint/` adapts Circle-IR sources, sinks, sanitizers, flow paths and
interprocedural metadata. Each call parses the original source in a fresh
Worker; it does not execute code or resolve sample imports. Worker termination
enforces a wall deadline even while the engine is synchronous. Source size,
line layout (Circle-IR blanks lines over 10,000 code units), V8 old-generation
heap and retained evidence are bounded independently.
`analyzeSample()` enables it by default and publishes `static.taint` with
deterministic timing metadata (`elapsedMs:0`); `taint:false` skips it. Failures
do not prevent other stages, add an analyst recommendation, and findings do not
change verdict weights.
See [TAINT.md](TAINT.md) for precision and resource-boundary limitations.

## 9. Determinism

Given the same seed, source and options, and a run that finishes inside the host
wall deadline, these are byte-identical across runs: profile values, virtual
timestamps, `Math.random`/crypto outputs, timer durations, trace event order and
payloads, and report JSON once the host measurements listed below are removed.
The rendered Markdown contains no host measurements, so two completed runs can
be compared directly. Tests assert the observable subset.

Host time is recorded, not simulated. Normalise it before comparing two reports:

- every trace event's `wall`;
- `meta.startedAt` and `meta.durationMs`;
- `dynamic.durationMs`;
- every `static.restoration.passes[].durationMs`.

The host wall deadline (`limits.timeoutMs`, default 5000 ms) is a safety
backstop, not a deterministic budget. The virtual-time budget is the primary
bound and is a function of executed statements; if it alone ends the run, the
outcome stays deterministic. If the host wall clock expires first, `runtime.js`
sets `provisional: true` on the run. The report exposes that as
`dynamic.provisional` and sets `dynamic.eventsTruncated: true`: the events
observed up to an interruption depend on host speed and JIT warmth, so a
provisional run is not expected to match another run. Provisional runs are also
excluded from `DYNAMIC_LIMITS` scoring, so host speed cannot move the verdict.
Treat the pair as "not comparable", not as a defect.

`dynamic.eventsTruncated` also reports retention loss, independently of
`provisional`: the retained `dynamic.events` slice is smaller than the observed
trace when `maxRetainedEvents` (default 5000) cuts it, when `keepTrace:false`
discards a non-empty trace, or when the recorder reached its own
`limits.maxEvents` cap and counted drops. `dynamic.counts.total` and `byKind` still describe the observed
trace. `tracing.truncated`/`tracing.truncatedBy` state the separate code-step
and recorder budgets even when the `code:trace-truncated` marker itself was
evicted. Strip the timing fields above; everything else must reproduce
byte-for-byte.
