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
| Event volume | Trace ring buffer limit; instrumentation event budget; console buffer cap; artifact size/count caps; hook error ring (200). |
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

The platform therefore **classifies from the engine signal only** and then
abandons the runtime:

- `tools/sandbox/runtime.js` `isHostStackExhaustion(thrown)` accepts only a
  host-thrown `RangeError`/`Error` carrying the engine's wording;
  `isGuestStackExhaustion(dumped)` accepts only QuickJS's own `InternalError`
  name **with** that wording. No caller may apply the wording test to arbitrary
  guest data.
- `tools/invocation/invoke.js` records the breach as the explicit marker
  `stackExhaustion: true` (also inside a timer or promise callback, where the
  script itself still succeeds and the record appears in `run.settle`).
- `tools/sandbox/sandbox.js` takes the abandon decision from that marker alone:
  it calls `runtimeHandle.abandon()` (which never calls `runtime.dispose()`),
  quarantines the WASM module, and reports
  `disposal { ok:false, leaked:true, stage:'runtime', skipped:true }`.
- `tools/sandbox/runtime.js` `loadQuickJS()` returns a **healthy** module: a
  quarantined module is replaced on the next `run()`, so analysis continues in
  the same process. 12 consecutive stack overflows followed by a normal run is a
  regression test (`tests/resilience.test.js`).

**No engine abort is expected on this path**, and the suite asserts that no
`Aborted(` line reaches stderr from a stack, timer or promise-job breach. The
engine still prints that assertion when a *non-stack* handle leak occurs; that is
the engine's own diagnostic, is converted into `disposal.ok === false`, and is a
platform bug — not a sample-visible signal.

**Residual risk (measured, documented):** the guest name `InternalError` is
writable, so a sample that throws `{ name: 'InternalError', message: 'stack
overflow' }` is classified as a breach and costs one abandoned runtime plus one
WASM recompile. A sample that only throws `Error('stack overflow')` is **not**
classified (`limitsHit: []`, `disposal {ok:true}`). Honest samples cannot produce
a false leak, and memory plateaus rather than growing without bound.

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
  callback;
- bridge-owned handles (created by `fn`/`obj`/`arr`/`install`/`nativeConstructor`)
  disposed once in `disposeAll()`;
- per-run teardown callbacks registered through `bridge.onDispose` (timers,
  deferred promises, store handles), run LIFO, each in its own `try/catch`;
- `run.disposal.ok` asserted in tests; a leak surfaces as a failed run
  (`ok:false`, `leaked:true`, `stage`) rather than a silent process abort.

The one sanctioned exception is a stack-limit breach, described above: there the
runtime cannot be released at all and is abandoned instead.

## Data handling

- Traces contain sample-derived strings (decoded payloads, console output,
  storage values, URLs). Treat logs and reports as **live malware artifacts**.
- pino redaction covers cookies, tokens, passwords, API keys, sessions and
  authorization headers. Sample-derived payloads are intentionally not redacted:
  they are evidence.
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
