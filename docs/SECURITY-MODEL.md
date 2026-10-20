# Security model

## What this tool is for

Defensive analysis of malicious JavaScript: audit, behaviour observation,
deobfuscation, forensic restoration, staged-payload recovery and IOC/tracing
back to infrastructure. It is not an execution service for untrusted code on a
shared host, and it is not a browser.

## Isolation boundary

| Boundary | Mechanism |
| --- | --- |
| Guest ↔ host memory | QuickJS compiled to WebAssembly; no shared JS objects except explicit bridge functions. |
| Guest ↔ filesystem/process | QuickJS has no `require`, `fs`, `process`, `spawn`; the host never exposes one. Anti-fingerprint deletes them if a hook ever injects them. |
| Guest ↔ network | No socket API is reachable. `fetch`/XHR/WebSocket/EventSource are synthetic services driven by the virtual clock; policies are `deny` (default), `empty`, `echo`, or explicit routes. Every request is a trace event + IOC. |
| CPU | Interrupt handler enforces a host deadline (default 5 s) and a virtual-time budget (default 60 s). Infinite loops are interrupted and classified. |
| Memory | `setMemoryLimit` (default 64 MB) and `setMaxStackSize` (default 1 MB); breaches become structured limit results. |
| Event volume | Trace ring buffer limit; instrumentation event budget; console buffer cap, each entry bounded by argument count **and** serialized characters; concurrent-timer cap (`limits.maxTimers`, refused schedules counted in `clock.stats().droppedTimers`); artifact size/count caps; hook error ring (200 entries **and** 64 KiB of message text, 2 KiB per message). |
| State leakage between samples | A **fresh runtime and context per run**; guest execution serialized one run at a time per process; intrinsic snapshot before/after proves no cross-run residue. |

The sandbox is *not* a kernel-level isolation boundary. QuickJS/WASM has a strong
track record, but a WASM engine escape is a host compromise. Run the platform in
a container/VM when analysing untrusted samples at scale, and never mount
secrets into that environment.

## What "fresh runtime per run" is worth

Every `TracelessSandbox.run()` creates a new `QuickJSRuntime` **and** a new
context, installs the environment on it, and tears it down in reverse order
(`instrumentation → bridge → stealth → context → runtime → clock`). Nothing a
sample mutates — a global, a prototype, a pending timer, an intrinsic snapshot —
can reach the next run, because the next run does not share a heap with it.

Two consequences worth stating precisely, because they are what an analyst relies
on:

1. **A failed disposal is reported, not hidden.** A successful teardown keeps the
   `{ ok: true, errors: [] }` shape. A failed one adds fields:
   `{ ok: false, leaked, stage, errors: [{ stage, message }], skipped? }`.
   `leaked: true` means the WASM heap is known to be corrupted (handle leak or
   stack exhaustion) and the module has been quarantined.
2. **A stack-limit breach is not a clean teardown, and the docs say so.** The
   guarantee is *not* "disposal always succeeds". It is: a stack breach leaves
   the runtime unreleasable, and the platform refuses to pretend otherwise —
   see the next section.

## Runtime abandonment and module quarantine

QuickJS throws its stack overflow as a **host** `RangeError`
(`Maximum call stack size exceeded`) out of `evalCode`, `callFunction` or
`executePendingJobs`; for interpreter recursion it raises its own
`InternalError: stack overflow`. Both leave guest objects on the runtime's GC
list, so `runtime.dispose()` would abort the WASM engine and print
`Aborted(Assertion failed: list_empty(&rt->gc_obj_list))` to stderr.

The platform distinguishes host engine signals from guest error values before
classifying a resource limit. A confirmed host stack signal requires abandonment;
timeout/virtual-time reasons come from the host-owned interrupt state. Guest
error text alone cannot establish either kind of evidence. Two stack shapes
exist:

1. **Host throw.** A host `RangeError` escapes `evalCode`, `callFunction` or
   `executePendingJobs`. `runtime.js` `isHostStackExhaustion(thrown)` accepts
   only a host-thrown `RangeError`/`Error` carrying the engine's exact wording.
2. **Converted guest error.** The overflow happens inside a host callback and
   quickjs-emscripten rethrows it into the guest as `ctx.newError(...)`, which is
   shape-identical to `throw new RangeError('Maximum call stack size exceeded')`.
   `guardHostStackExhaustion` increments `runtime.stackSignals()` *before* that
   conversion; the invoker reads the counter around the branch it ran and
   classifies from it. Guest code cannot write this counter, so neither a
   `catch {}` nor a forged message can suppress or fake it.

Everything else about the classification:
- Guest-side evidence is an intrinsic-shaped fallback for interpreter errors
  that do not escape as a host throw (including reduced-stack recursion and
  allocation/size-limit errors).
  `tools/invocation/invoke.js` `isIntrinsicEngineError(stealth, handle)` asks
  `stealth.isIntrinsicStackError(handle)` about the **live guest handle**: the
  thrown value's prototype chain must contain the engine's own
  `InternalError.prototype`, captured in `stealth.install()` *before*
  `env/globals.js` removes the global binding, and the probe refuses to certify
  while that constructor is still guest-reachable. `env/stack.js` keeps the
  constructor faithful but unreachable by giving its wrapper a fresh prototype
  (same own properties, same `[[Prototype]]`, as Firefox has); if the wrapper
  cannot be installed, the module calls `stealth.revokeStackEvidence()` and
  guest-side certification is off for the rest of the run. The host witness is
  never affected. Classification checks host stack evidence first, then the
  host-owned interrupt reason; only then can an intrinsic-shaped error's message
  distinguish stack from allocation/size failure. Plain guest errors with
  matching names or messages remain ordinary exceptions. `memory` includes an
  engine allocation/size rejection such as `string too long`, not proof that
  total host RSS or exactly the configured QuickJS heap cap was exhausted.
- `tools/invocation/invoke.js` records the breach as the explicit marker
  `stackExhaustion: true` (also inside a timer or promise callback, where the
  script itself still succeeds and the record appears in `run.settle`). One
  record builder normalises both shapes: `error.stack === ''` (it would encode
  the recursion depth), the engine's name/message, `limitsHit: ['stack']` and the
  abandoned-runtime disposal. A guest that swallows the converted overflow is
  still `ok:true` **and** `limitsHit: ['stack']`.
- `tools/sandbox/sandbox.js` takes the abandon decision from that marker alone:
  it calls `runtimeHandle.abandon()` (which never calls `runtime.dispose()`),
  quarantines the WASM module, and reports
  `disposal { ok:false, leaked:true, stage:'runtime', skipped:true }`.
- `tools/engine/runtime.js` `loadQuickJS()` returns a **healthy** module: a
  quarantined module is replaced on the next `run()`, so analysis continues in
  the same process. 12 consecutive stack overflows followed by a normal run is a
  regression test (`tests/resilience.test.js`).

**No engine abort is expected on this path**, and the suite asserts that no
`Aborted(` line reaches stderr from a stack, timer or promise-job breach: the
612-test run on the pinned commit prints zero of them (`tests/resilience.test.js`
captures engine output around the overflow, timer and promise cases and fails on
any match). The 40-run full-environment loop is part of that guarantee: every
run classifies, and the follow-up run is clean. The
engine still prints that assertion when a *non-stack* handle leak occurs; that is
the engine's own diagnostic, is converted into `disposal.ok === false`, and is a
platform bug — not a sample-visible signal.

**Residual risk:** intrinsic identity is stronger than a guest-selected name or
message, but it is not an unforgeable allocator-failure witness. The public
QuickJS binding exposes no separate host OOM event. A guest that catches a real
engine `InternalError` can retain its prototype and reuse it on a later value;
changing its message can also affect the memory/stack subtype. A real OOM can
expose that prototype even with the default stack size, so this limitation is
not restricted to reduced `stackBytes`. This broader boundary is a consequence
of the shared engine error prototype, not a claim of a new measured RSS attack.

The previously measured reduced-stack case remains: after genuine interpreter
stack exhaustion at `stackBytes: 64 KiB`, a reused prototype can produce
`limitsHit: ['stack']`, `stackExhaustion: true` and abandoned disposal. Throwing a
plain error after the caught overflow does not acquire that provenance. Ordinary
guest-created `Error` values and copied `{name, message}` objects remain ordinary
exceptions. URLSearchParams/FormData callback errors preserve their guest
handles instead of being recreated as host stack evidence.

**The price of continuing.** A quarantined module keeps its WASM heap until the
engine's module is collected, so each breach costs host memory: measured
**21.7 MB RSS per breach** over six consecutive breaches on one host (~17 MB in
the final-audit measurement). The process keeps working (`1+1` still returns
`ok:true` after them), which is the trade this design makes: a poisoned engine is
replaced, not a whole process restarted. A batch that expects hostile samples
should therefore bound the number of breaches per worker process rather than
process an entire corpus in one.

## Concurrency: one guest run at a time

All sandboxes in a process share one QuickJS WASM module, and a module executes
one guest at a time. Guest code runs synchronously, so a second run is suspended
at its first `await`; its host-time budget is measured from runtime creation. A
run that resumed after a neighbour had monopolised the thread for 400 ms would
find its budget already expired, interrupt itself on its first statement, and
leave guest objects on its own GC list — a leak that looked unrelated to
concurrency (commit `d7dc371`).

The platform therefore **serializes guest runs process-wide**:

- `run()` appends its whole body (module re-acquisition, invocation, settle,
  disposal) to a promise-chain mutex; the next run starts only after the previous
  one has settled.
- Concurrent callers **queue**; they are never rejected. Each queued run still
  gets a fresh runtime, context, profile and clock, so a queued run behaves
  exactly like the sequential equivalent.
- Timeouts and virtual-time interrupts are therefore delivered to a run that
  owns the thread, never to one parked at an `await`. The interrupt is queued by
  the engine's own interrupt handler and classified as `timeout` or
  `virtual-time`; it does not quarantine the module.
- Only guest execution is serialized: `analyze()` and the restoration pipeline
  never touch the module and run freely.
- **Nested runs are unsupported.** A `run()` started from a hook, an env callback
  or guest code waits for the run holding the queue — that is, for itself. Do not
  do it.
- Real parallelism requires **separate worker processes**, one WASM module each.
  A pool inside one process is a queue, not a fan-out.

## WebAssembly

Policy: **WASM execution is unsupported; the surface is a coherent stub.** This
is a deliberate security property, not an omission: a sample that hides its
logic in a WASM payload cannot execute it, and instrumentation that references
`WebAssembly` (`code-hook.js`'s wasm-loader pattern, `ast.js`
`wasmReferences`) still fires on the *reference*.

- `WebAssembly` exists with `Module`, `Instance`, `Memory`, `Table`, `Global`,
  `CompileError`, `LinkError`, `RuntimeError`, `validate`, `compile`,
  `instantiate`, `instantiateStreaming`, and `Module.exports/imports/
  customSections`. All 12 members are non-enumerable, so
  `Object.keys(WebAssembly) === []` like a browser.
- `validate()` always returns `false`; `compile`/`instantiate` reject with a
  `CompileError` whose message has the browser shape (`expected magic word
  00 61 73 6d, found XX XX XX XX @+0`, derived only from the supplied bytes);
  `instantiateStreaming` rejects with a `TypeError` for a non-`Response`.
- `new WebAssembly.Memory({initial})` really allocates an `ArrayBuffer` (capped at
  **16 pages**) and `grow` works up to the same cap; `Table` reports
  `length`/`element` and `get` returns `null`; `Global` stores one value. No
  module is ever instantiated and no bytecode is executed.
- Consequence for the heap: WASM buffers a sample allocates are ordinary guest
  allocations inside the 64 MB QuickJS memory limit, not host heap.

## `SharedArrayBuffer` / `Atomics` policy

A shareable buffer without cross-origin isolation is impossible in a browser, so
the default profile must not expose one — it is a one-line detection tell.

- Default profile: `crossOriginIsolated === false`, and **both**
  `SharedArrayBuffer` and `Atomics` are **deleted** from the guest global
  (`typeof` → `'undefined'`).
- `{ crossOriginIsolated: true }` (via `createProfile` or
  `TracelessSandbox.create({ profile: { crossOriginIsolated: true } })`) keeps
  `SharedArrayBuffer` and installs a **single-threaded** `Atomics` shim.
- `consistencyReport()` enforces the invariant in both directions:
  `Boolean(sharedArrayBuffer) === Boolean(crossOriginIsolated)`, the same for
  `atomics`, and an `https` origin is required when isolation is on. These are
  three of the 20 checks reported as `run.profile.consistency.checked`.
- The `Atomics` shim implements `load store add sub and or xor exchange
  compareExchange wait waitAsync notify isLockFree` with the spec's argument
  validation (`TypeError` for a non-integer typed array, `RangeError` for an
  out-of-range index). **`wait` never blocks** — it returns `'not-equal'` on a
  value mismatch and `'timed-out'` otherwise; `notify` returns `0`; `waitAsync`
  resolves immediately.

**Nothing is ever shared between threads: there is one guest thread.** The shim
is a surface, not a lock implementation, and no data can cross an isolation
boundary through it.

## Threat model for the analysed code

The sample is assumed to:

- probe the environment for VM/automation/analysis tells;
- attempt to detect instrumentation via source text, function identity, stack
  shape or timing;
- pollute prototypes, replace intrinsics, or install hooks of its own;
- allocate aggressively or spin forever, including from a timer or promise
  callback;
- throw errors that *look like* engine limits in the hope of corrupting the
  analyser's own bookkeeping (see "Runtime abandonment" above);
- exfiltrate data through any reachable channel (all channels are mocked and
  recorded, none reach the network).

Countermeasures are described in README ("Traceless design") and verified by
`tests/traceless.test.js`, which encodes probes from real loaders
(`docs/RESEARCH-ANTI-ANALYSIS.md`).

## Handle lifetime as a safety property

quickjs-emscripten aborts the WASM module on `runtime.dispose()` if any handle is
still alive. The platform treats disposal as a correctness invariant:

- per-callback `HandleBag` disposal (LIFO, exception-safe) for every host
  callback: values a call creates die with the call, so a guest cannot grow host
  memory by calling a host API in a loop (a 20 000-call builder loop plateaus;
  `tests/sandbox-core.test.js`);
- bridge-owned handles (created by `fn`/`obj`/`arr`/`install`/`nativeConstructor`)
  disposed once in `disposeAll()`. A handle returned from a host callback is
  transferred to the guest by the trampoline, not duplicated, and a deferred
  promise releases its record when it settles (or at teardown for a promise that
  never settles), so resolver pairs do not accumulate per promise;
- per-run teardown callbacks registered through `bridge.onDispose` (timers,
  deferred promises, store handles), run LIFO, each in its own `try/catch`;
- `run.disposal.ok` asserted in tests; a leak surfaces as a failed run
  (`ok:false`, `leaked:true`, `stage`) rather than a silent process abort.
- a handle that must outlive the bridge call that created it is **owned** and
  released explicitly: `canvas.js` keeps one `retain()` teardown set for
  `FontFaceSet` faces and for handles handed to virtual-clock tasks (`toBlob`,
  `img.src`) and frees them with `release()` once their owner is done, because a
  run that ends before the task runs otherwise leaves the duplicate alive;
  `observers.js` queues plain record descriptors and builds the entry at
  delivery time, then releases the `observe()` target duplicate once the entry
  copied it. Both were real engine aborts found while raising coverage
  (`4201ae9`, `8473a6a`, `335c2d0`).

The one sanctioned exception is a stack-limit breach, described above: there the
runtime cannot be released at all and is abandoned instead.

## Data handling

- Traces contain sample-derived strings (decoded payloads, console output,
  storage values, URLs). Treat logs and reports as **live malware artifacts**.
- pino redaction covers cookies, tokens, passwords, API keys, sessions and
  authorization headers at the explicitly configured paths. Root fields and up
  to two enclosing object levels include `apiKey`, `session`, `jwt`,
  `authorization` and `Authorization`. Paths are case-sensitive and finite-depth,
  not a recursive, case-insensitive secret detector. Configure additional paths
  before logging differently shaped authentication metadata. Sample-derived
  payloads are intentionally not redacted: they are evidence.
- Artifacts are content-addressed (SHA-256) and bounded (4 MB/artifact, 200
  artifacts). Nothing is written to disk unless the caller/CLI asks for `--out`.

## Logging safety

Logging is pino-only, structured, and never blocks analysis: a throwing log sink
is swallowed, a throwing hook is recorded (bounded ring) and skipped, a throwing
trace listener is ignored. The CLI keeps results on stdout and diagnostics on
stderr (fd 2) so pipelines are safe.

## Ethical use

Only analyse samples you are authorised to handle. Extracted payloads, C2 URLs
and credentials are evidence; do not contact infrastructure or reuse recovered
material without authorization. The platform never performs real network
requests by design, including from the CLI.
