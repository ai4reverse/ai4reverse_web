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
| Guest ↔ network | No socket API is reachable. `fetch`/XHR/WebSocket are synthetic services driven by the virtual clock; policies are `deny` (default), `empty`, `echo`, or explicit routes. Every request is a trace event + IOC. |
| CPU | Interrupt handler enforces a host deadline (default 5 s) and a virtual-time budget (default 60 s). Infinite loops are interrupted and classified. |
| Memory | `setMemoryLimit` (default 64 MB) and `setMaxStackSize` (default 1 MB); breaches become structured limit results. |
| Event volume | Trace ring buffer limit; instrumentation event budget; console buffer cap; artifact size/count caps. |
| State leakage between samples | A fresh runtime and context per run; every handle disposed; intrinsic snapshot before/after proves no cross-run residue. |

The sandbox is *not* a kernel-level isolation boundary. QuickJS/WASM has a strong
track record, but a WASM engine escape is a host compromise. Run the platform in
a container/VM when analysing untrusted samples at scale, and never mount
secrets into that environment.

## Threat model for the analysed code

The sample is assumed to:

- probe the environment for VM/automation/analysis tells;
- attempt to detect instrumentation via source text, function identity, stack
  shape or timing;
- pollute prototypes, replace intrinsics, or install hooks of its own;
- allocate aggressively or spin forever;
- exfiltrate data through any reachable channel (all channels are mocked and
  recorded, none reach the network).

Countermeasures are described in README ("Traceless design") and verified by
`tests/traceless.test.js`, which encodes probes from real loaders
(`docs/RESEARCH-ANTI-ANALYSIS.md`).

## Handle lifetime as a safety property

A leaked quickjs handle aborts the WASM module. The platform treats disposal as a
correctness invariant:

- per-callback `HandleBag` disposal (LIFO, exception-safe);
- bridge-owned handles disposed at teardown;
- `run.disposal.ok` asserted in tests;
- the WASM leak assertion (`list_empty(&rt->gc_obj_list)`) is treated as a bug,
  not noise.

## Data handling

- Traces contain sample-derived strings (decoded payloads, console output,
  storage values, URLs). Treat logs and reports as **live malware artifacts**.
- pino redaction covers cookies, tokens, passwords and authorization headers.
  Sample-derived payloads are intentionally not redacted: they are evidence.
- Artifacts are content-addressed (SHA-256) and bounded (4 MB/artifact, 200
  artifacts). Nothing is written to disk unless the caller/CLI asks for `--out`.

## Logging safety

Logging is pino-only, structured, and never blocks analysis: a throwing log sink
is swallowed, a throwing hook is recorded and skipped. The CLI keeps results on
stdout and diagnostics on stderr so pipelines are safe.

## Ethical use

Only analyse samples you are authorised to handle. Extracted payloads, C2 URLs
and credentials are evidence; do not contact infrastructure or reuse recovered
material without authorization. The platform never performs real network
requests by design, including from the CLI.
