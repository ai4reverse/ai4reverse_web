# `tools/` evaluation record and alignment targets

This document records an independent, evidence-based review of `tools/`
(83 files / ~30.7k lines) and defines the acceptance criteria for aligning the
implementation with it. Every finding below was reproduced on the tree at the
time of review; each has a stable id (`Dn`) referenced by `docs/DESIGN-REVIEW.md`
and `docs/VERIFICATION.md` once dispositioned.

Scope: `tools/` and the tests/docs that describe it. `examples/national-sdk/`
is out of scope except where the platform's browser surface is exercised.

## Baseline at review time

| Item | Observed |
| --- | --- |
| Node | v24.19.0 |
| Suite | `node --test --test-concurrency=1 tests/*.test.js` → 361 pass, 0 fail, 43.3 s |
| Coverage | `--experimental-test-coverage`: lines 88.08 %, branches 75.26 %, functions 80.33 % |
| Exports | 67 from `tools/index.js`; 157 named exports inside `tools/` |
| Performance | analyze 1 KB sample 117 ms; static 200 KB 73 ms; restore 200 KB 300 ms; 1000-statement run 33 ms |
| Tree state | clean (`git status` empty) |

## Severity model

- **S1** — breaks batch analysis or silently corrupts evidence; must be fixed.
- **S2** — wrong/misleading observation, or a one-line detection tell; must be fixed.
- **S3** — contract, packaging or hygiene drift; must be fixed or explicitly accepted in docs.

---

## D1 (S1) — A stack overflow leaks the shared WASM heap and poisons the module

**Reproducer**

```js
const sb = await TracelessSandbox.create({ logLevel: 'silent' })
for (let i = 1; i <= 12; i++) await sb.run('function f(n){return f(n+1)} f(0)')
```

**Observed** — each run leaks roughly 18 MB RSS. The 11th run throws
`QuickJSUnwrapError` with an empty message; every later run in that process
fails. A minimal script that uses only quickjs-emscripten reproduces the
underlying `Aborted(Assertion failed: list_empty(&rt->gc_obj_list))`, so the
leak is engine-inherent after stack exhaustion — but the platform keeps using
the poisoned module.

**Why it matters** — one line of hostile recursion disables analysis for the
rest of the process. It contradicts `docs/SECURITY-MODEL.md` ("the WASM leak
assertion is treated as a bug, not noise") and the README claim that disposal is
verified by that assertion. `tests/sandbox-core.test.js` (stack case) does not
assert `run.disposal`, so the leak is invisible to CI while printing `Aborted`
to stderr on every suite run.

**Acceptance criteria**

1. A runtime whose disposal fails is quarantined; the next `run()` recreates the
   QuickJS module and succeeds.
2. 12 consecutive stack-overflow runs followed by a normal run all return a
   result; the normal run is `ok === true`.
3. The stack-overflow run exposes the leak: `disposal.ok === false` and an
   explicit leak marker (for example `disposal.leaked === true`), while keeping
   `limitsHit` containing `stack`.
4. A regression test encodes criteria 1–3.
5. Docs state the isolation guarantee precisely (fresh runtime per run; module
   recreation after engine abort).

## D2 (S1) — Run initialisation sits outside `try/finally`

**Reproducer** — after the module is poisoned (D1), `sb.run('1+1')` throws
`QuickJSUnwrapError` with `message === ''` and `code === undefined`; the freshly
created runtime and context are never disposed.

**Cause** — `tools/sandbox/sandbox.js:139-171`: `createRuntime`, `newContext`,
`createStealth`, `stealth.install()` and `createHostBridge` all run before the
`try` that owns disposal.

**Acceptance criteria**

1. Runtime, context, stealth and bridge are acquired inside the guarded region
   and disposed in `finally` even when acquisition itself throws.
2. Any escaping failure is a `SandboxError` with a non-empty message, a `code`
   (`SANDBOX_INIT` or similar) and the original error as `cause`.
3. A test forces an initialisation failure (for example by making
   `newRuntime` throw once) and asserts the error contract plus a successful
   subsequent run.

## D3 (S2) — `anti-fingerprint.prototypified.moved` records a WASM pointer

**Reproducer**

```js
// tools/sandbox/env/anti-fingerprint.js:126
moved += Number(call.value?.value ?? 0)
```

For a guest `42`, `handle.value` is `5372376` (linear-memory address) while
`ctx.dump(handle)` is `42`. Two same-seed analyses report `moved` as
`51294320` and `46797320`, so the trace and report are not reproducible and a
host heap offset is written into evidence.

**Acceptance criteria**

1. `moved` is the real count (`getNumber`/`bridge.num`), bounded and positive on
   a normal run.
2. A determinism test asserts that two same-seed `analyzeSample` runs produce
   identical dynamic events after removing `wall` (and identical reports after
   removing durations/startedAt).
3. No trace payload contains a raw handle pointer.

## D4 (S2) — Trace budget is diluted by no-op hook events

**Reproducer** — a 20-iteration loop yields 45 `code` events and 48 `hook`
events, most of them `{ phase: 'code:step', hook: 'code:step' }`, emitted even
with zero registrations (`code.js:108` emits unconditionally,
`hookbus.js:73/213` only filters `ast:`/`jsvmp:`). `code:step` is absent from
`HOOK_PHASES`; `createHookBus({ strict: true }).emit('code:step')` throws.
`errors` in the hook bus grows without bound.

**Acceptance criteria**

1. `emit()` does not record or dispatch when no enabled registration matches,
   and `shouldRecord` excludes high-frequency `code:step`.
2. Every phase the platform emits is declared in `HOOK_PHASES`; a strict bus
   accepts `code:step` and still rejects unknown phases.
3. Hook error storage is bounded and reports truncation.
4. A test asserts a loop-heavy run has few `hook` events while `code` events are
   retained, and that the trace budget keeps real evidence.

## D5 (S2) — Pass `changed` is not evidence-bound; generated output is not validated

**Reproducer**

```js
const a = restore(src, { only: ['strings'], maxRounds: 1 })  // examples/sample-loader.js
const b = restore(a.code, { only: ['strings'], maxRounds: 1 })
// a.code === b.code → true, yet b.passes[0].changed === true
```

`jsfuck` shows the same behaviour. `changed` feeds the `STATIC_RESTORATION`
verdict weight and `stopOnNoChange`. All 11 passes declare `idempotent: true`,
but at least `strings` and `jsfuck` are not fixed points. `restore()` never
re-parses its own generated output, although `docs/DESIGN-REVIEW.md` 2.1 claims
it does.

**Acceptance criteria**

1. `passes[].changed` is true only when the pass actually changed generated
   output; a second application to already-restored code reports `changed:false`
   (pipeline fixed point) for every example and every pass.
2. `restore()` validates its generated output by re-parsing it and reports the
   result (`outputValid`); an invalid generation falls back to the input source
   with an explicit note instead of returning broken code.
3. Metadata matches behaviour: `idempotent` is only true when criterion 1 holds.
4. Tests: per-pass idempotence over `examples/*.js`, `changed` accuracy, and
   output validation.

## D6 (S2) — Missing or incoherent browser surfaces are one-line detection tells

Probe results (`seed = 0x5eed`, Chromium profile):

| Probe | Sandbox | Real Chromium |
| --- | --- | --- |
| `typeof WebAssembly` | `undefined` | `object` |
| `typeof Atomics` | `undefined` | `object` |
| `typeof SharedArrayBuffer` | `function` | only when `crossOriginIsolated === true` |
| `crossOriginIsolated` | `false` | `false` |
| `typeof HTMLElement` / `customElements` | `undefined` | `function` |
| `typeof DOMParser` / `XMLSerializer` / `EventSource` | `undefined` | `function` |

`WebAssembly` is referenced by seven modules (`integrity.js:43`, `ast.js:54`,
`ast.js:277`, `api.js:363-365`, `code-hook.js:19`) but never provided — this is an
omission, not a documented trade-off. `SharedArrayBuffer` present with
`crossOriginIsolated === false` and no `Atomics` is an impossible combination.

**Acceptance criteria**

1. A coherent `WebAssembly` surface exists (constructors + `compile`/`instantiate`
   /`validate` with browser-shaped failure) or the platform documents an explicit
   CSP-style policy; either way the README claim "full browser environment" is
   qualified.
2. `SharedArrayBuffer`, `Atomics` and `crossOriginIsolated` are mutually
   coherent and the invariant is part of `consistencyReport()`.
3. `HTMLElement` and the per-tag interfaces exist and `document.createElement(tag)
   instanceof HTMLElement` holds; `customElements` exposes a working registry.
4. `DOMParser`/`XMLSerializer` have a bounded, documented implementation;
   `EventSource` is a working mock driven by the virtual network.
5. `tests/env-surface.test.js` asserts each new surface and the coherence
   invariant; missing capabilities are listed in README "Known limitations".

## D7 (S2) — The CLI silently succeeds on typos and invalid values

**Reproducer**

```bash
node tools/cli.js restore examples/sample-loader.js --rounds abc    # exit 0, unmodified output
node tools/cli.js restore examples/sample-loader.js --passes bogus  # exit 0, unmodified output
node tools/cli.js analyze examples/benign.js --nonsense             # exit 0, flag ignored
```

**Acceptance criteria**

1. Unknown options, malformed numbers, unknown pass ids and invalid `--level`
   are usage errors: stderr message, exit code 2, no result on stdout.
2. `--seed`, `--rounds` and `--out` failures follow the same contract.
3. Valid invocations, stdout purity and existing exit codes are unchanged; tests
   cover both sides.

## D8 (S3) — Documentation and contracts drifted from the code

Confirmed mismatches:

| Document | Claim | Code |
| --- | --- | --- |
| `CONTRACTS.md` | bridge `str(s) num(n) bool(b) undef() null_() bigint(n) define()` | `str(args, i)`, `num(args, i)`, `undefined`/`null` getters, `install`, `accessor`, `toGuest`, `fromGuest`, `obj`, `arr`, `list`, `value`, `call`, `evalInGuest`, `deferred`, `emit`, `reportIOC`, `onDispose`, `disposeAll` |
| `CONTRACTS.md` | `createTraceRecorder({ logger, clock, limit })` | options are `limit`, `clock`, `sink`, `actor`, `strict` |
| `DESIGN-REVIEW.md` 2.1 | generated output is re-parsed | not implemented (D5) |
| `VERIFICATION.md` | `sandbox-core` 14/14 | 15/15 |
| `VERIFICATION.md` | "virtual time uses a fixed UTC offset (no DST)" | DST-correct via ICU (`util/timezone.js`) |
| `API.md` | exports `scopeLogger` | absent from `tools/index.js` |
| `VERIFICATION.md` | z3-solver "available; not required" | never imported anywhere |
| `CONTRACTS.md` | navigator `order: 20` | order 40 |

**Acceptance criteria**

1. `CONTRACTS.md` matches the implemented bridge/trace/hook/env/pass contracts
   method by method.
2. `VERIFICATION.md` counts, residuals and evidence commands match a fresh run
   of the suite, and no residual contradicts a fixed finding.
3. `DESIGN-REVIEW.md` gains a new review section that dispositions D1–D12 with
   evidence and does not restate claims the code does not implement.
4. `API.md`, `ARCHITECTURE.md`, `README.md` and `SECURITY-MODEL.md` agree with
   the code, including the new env modules, test counts, CLI strictness and the
   accepted limitations.

## D9 (S3) — Packaging and repository metadata gaps

No `LICENSE` file despite `"license": "ISC"`; empty `author`; no `files`
whitelist; `exports` lacks `./logging`, `./invocation`, `./util`, `./cli`;
`tools/cli.js` is mode 0644 although it is a `bin`; no type declarations or
`jsconfig`; no lint/format/CI configuration; `z3-solver` is a 34 MB unused
dependency; `src/` is an empty directory.

**Acceptance criteria**

1. `LICENSE` exists and matches `package.json`; `files` whitelist added; every
   documented submodule is importable through `exports`.
2. `tools/cli.js` is executable in git (`100755`).
3. Unused dependency removed from `package.json` and the lockfile.
4. Either JSDoc-driven type checking (for example `jsconfig.json` with
   `checkJs`) or `.d.ts` declarations exist for the public API.

## D10 (S3) — Dead exports and stubs

Twelve exports are never referenced: `LimitationError`, `PassError`,
`PASS_BY_ID`, `TRACE_PHASES`, `isPrimitiveLiteral`, `literalValue`,
`parseExpression`, `parseFirstSuccessful`, `summarizeValue`, `restoreCode`,
`resetQuickJS` (test-only), `bridge.call`. `bridge.js` has a no-op
`adoptPrototype`, a `nativeTextForFor` typo and an indentation fault.

**Acceptance criteria**

1. Every remaining export is used or documented as public with a test.
2. Dead helpers and the no-op stub are removed; names are correct.

## D11 (S3) — `env/misc.js` violates the one-surface rule and hides dependencies

`misc.js` is 2,282 lines and owns roughly fifteen platform surfaces; it augments
`navigator` while declaring `requires: ['globals']`, so selecting `misc` alone
silently loses those augmentations. `dom.js` embeds ~1,430 lines of guest source
that host tooling cannot lint or cover.

**Acceptance criteria**

1. URL/URLSearchParams and the Blob/File/FormData family live in their own env
   modules; navigator augmentations live in `navigator.js`; shared helpers live
   in a non-module support file.
2. `ENV_MODULE_IDS` and every `meta.requires` describe the real dependency
   graph; selecting a subset never silently drops a declared surface.
3. Behavior is unchanged: existing env tests pass with only module lists
   updated where a surface moved.

## D12 (S3) — Minor quality faults

`restore/index.js` hard-codes the deferred `rename` pass in the orchestrator
instead of pass metadata; `bridge.fn` has a mis-indented catch block; the
`domShim` guest source is undocumented as such in coverage terms.

**Acceptance criteria**

1. Deferral is declared by pass metadata (`meta.deferred`) or removed.
2. Formatting/indentation faults in touched files are fixed.

---

## Accepted limitations (allowed only if documented and tested where possible)

- QuickJS is not V8: some engine behaviour and stack columns differ.
- Canvas/WebGL/audio are deterministic profile values, not renderers.
- IndexedDB is a stub; `crypto.subtle` covers `digest` only.
- WASM execution is unsupported (surface may be a coherent stub).
- `DOMParser` parsing is bounded (no full HTML5 tree construction).

## Verification gates for alignment

1. `pnpm test` — full suite green, no test asserting a leaked runtime as success.
2. `node --test --test-concurrency=1 --experimental-test-coverage tests/*.test.js`
   — coverage recorded and not below the review baseline (88 % lines / 75 %
   branches) after new tests.
3. Each `Dn` has at least one automated check that fails before the fix and
   passes after.
4. Demo commands: `node tools/cli.js analyze examples/sample-loader.js --json`,
   `node tools/cli.js restore examples/sample-loader.js`, `node tools/cli.js run
   examples/benign.js --json` behave as documented.
5. An independent auditor (fresh context, read-only) reproduces the original
   reproducers and confirms they now behave as specified.
