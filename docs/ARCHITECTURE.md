# Architecture

This document describes how the platform is put together, why the layering is
what it is, and where to extend it.

## 1. Layers

```
tools/
├── index.js                  public barrel (68 exports)
├── cli.js                    analyze | restore | run | passes | version
│
├── logging/logger.js         pino + pino-pretty, redaction, event sink
│
├── util/                     seedable PRNG, hashes, handle bag, typed errors
│
├── sandbox/
│   ├── sandbox.js            TracelessSandbox: one fresh runtime per run
│   ├── runtime.js            QuickJS module (memoised), limits, interrupt handler
│   ├── bridge.js             the only sanctioned handle API for env modules
│   ├── profile.js            seeded, coherent browser fingerprint
│   ├── clock.js              virtual clock + timer queue
│   ├── limits.js             normalized resource limits
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

## 1.2 Guest runs are serialized; a poisoned module is quarantined

All sandboxes in a process share one QuickJS WASM module (memoised in
`tools/sandbox/runtime.js`) and a module executes one guest at a time. Guest code
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
   recorded, never thrown at the host.
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

## 4. Handle lifetime discipline

quickjs-emscripten aborts the WASM module on `runtime.dispose()` if any handle is
still alive. The platform therefore routes every creation through:

- `HandleBag` (per host-callback temporary, disposed LIFO even on throw),
- the bridge's internal `owned` set + `disposeAll()` (long-lived handles created
  by `fn`/`obj`/`arr`/`install`/`nativeConstructor`, disposed once at teardown),
- per-run teardown callbacks registered with `bridge.onDispose` (timers, deferred
  promises, store handles),
- explicit owners in `instrumentation/api.js` and `invoke.js`.

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

## 7. Determinism

Given the same seed, source and options, these are byte-identical across runs:
profile values, virtual timestamps, `Math.random`/crypto outputs, timer
durations, trace event order and payloads, report JSON (except `wall`,
`startedAt`, `durationMs`). Tests assert the observable subset.
