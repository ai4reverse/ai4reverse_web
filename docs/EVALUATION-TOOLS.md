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

---

# Alignment outcome

Recorded 2026-10-19. Everything above this line is the review as written; this
section is the outcome and does not rewrite the findings.

- Commit range: `1b0f2c7..7c1df9c` — 91 commits, of which `c8300ff` is this
  document, `7836126..d7dc371` are the alignment itself, and `5ef930e..7c1df9c`
  are the final wave appended below.
- Method: one writer per area (`tools/sandbox`, `tools/hook`,
  `tools/restore`, `tools/cli`, packaging/types, and this documentation lane),
  each with a targeted test file; then four independent, read-only auditors
  (`.pi/audits/AUDIT-{A,B,C,D}-*.md`) reproduced every original reproducer on a
  pristine export of the committed tree.
- Disposition detail (commit + regression test per item) lives in
  `docs/DESIGN-REVIEW.md` → "Review 6"; the commands and counts live in
  `docs/VERIFICATION.md`.

## Where the review's proposal and the code differ

The review proposed contract names; the alignment followed the code, not the
proposal. Differences to know when reading `docs/CONTRACTS.md`:

- The bridge does **not** have `call(...)` (it was dead surface, removed under
  D10) or `define(handle, props)`; use `install(target, key, value, flags)` or
  `obj(properties)`. Its reader helpers are `str(args, i)`, `num(args, i)`,
  `int`, `bool`, `value`, `list(handle, limit)` — argument-indexed, not
  value-taking — plus the `undefined`/`null` getters.
- The trace recorder also accepts `actor` and `strict`, and exposes `clear()`,
  `dropped` and `seq`.
- `HOOK_PHASES` has 21 entries (including `code:step`, `ast:node` and
  `lifecycle:*`); `code:step` is dispatchable but never traced, and `ast:*` /
  `jsvmp:*` hook phases are not re-traced because they own trace kinds.
- The env graph has 28 modules, not 24, and `platform-kit` is not a module.
- `rename` is deferred through `meta.deferred`, not through a hard-coded id.

## Per-`Dn` status

| Id | Severity | Status | Acceptance evidence |
| --- | --- | --- | --- |
| D1 | S1 | **Fixed** | 12 consecutive stack overflows then a normal `ok:true` run; every breach reports `disposal {ok:false, leaked:true, stage:'runtime', skipped:true}`; the module is quarantined and recompiled; no `Aborted(` line. Both engine shapes (host throw, and the trampoline's guest conversion at a host callback) produce the same record through a host-side witness, and 40 consecutive full-environment runs yield exactly one record (final wave; see the last section). |
| D2 | S1 | **Fixed** | Acquisition inside the guarded region; escaping failures are `SandboxError` with `code: SANDBOX_INIT\|SANDBOX_RUN`, non-empty message, `cause`; no unhandled rejection. |
| D3 | S2 | **Fixed** | `moved` is a clamped integer (202 on `examples/network-c2.js`), never a handle address; same-seed dynamic events are byte-identical after removing `wall`. |
| D4 | S2 | **Fixed** | 20-iteration loop: 2 hook events, 45 code events (was 48/45); strict bus accepts every declared phase, rejects typos; 1 000 throwing hooks leave 200 bounded errors (64 KiB total, 2 KiB per message) with `errorsTruncated`; hook trace events use trace phase `emit`/`transform` with the hook phase in `hook`. |
| D5 | S2 | **Fixed** | Both reproducers report `changed:false` on re-application; 0/11 pipeline and 0/121 per-pass fixed-point failures; `validateOutput('function (') === false`; invalid generated output falls back to the input with `outputValid:false`. |
| D6 | S1 | **Fixed** | WebAssembly stub, isolation triple with the invariant in `consistencyReport()` (20 checks), `HTMLElement` + 39 tag interfaces + `customElements`, bounded `DOMParser`/`XMLSerializer`, `EventSource` on the virtual network, `Object.keys(element).length === 0`. The final wave added the `[object DOMParser]`/`[object XMLSerializer]`/`[object EventSource]` brands and the global `CustomElementRegistry`. The documentation half (README/SECURITY-MODEL) is delivered. |
| D7 | S2 | **Fixed** | All three reproducers now exit 2 with a message on stderr and empty stdout; **39** invalid invocations through `assertUsageError` (+4 `assert.rejects` cases) covered; valid invocations, stdout purity and `--out -` unchanged. |
| D8 | S3 | **Fixed** | `CONTRACTS.md` rewritten against the code (bridge method-by-method, trace recorder, hook bus, env graph, pass contract), every count in `VERIFICATION.md` regenerated, `DESIGN-REVIEW.md` Review 6 + this outcome, `SECURITY-MODEL.md`/`README.md`/`API.md`/`ARCHITECTURE.md` corrected, `_w6-fidelity-notes.md` folded in and deleted. |
| D9 | S3 | **Fixed** | ISC `LICENSE`, `files` whitelist (114-file tarball — 91 tools, 9 docs, 11 types, `README.md`, `LICENSE`, `package.json` — only `tools/ docs/ types/ README.md LICENSE package.json`), 11 subpath `exports` that all import at runtime, `types/*.d.ts` covering every runtime export, `100755` `tools/cli.js`, no `z3-solver` in `package.json` or `pnpm-lock.yaml`. |
| D10 | S3 | **Fixed** | The eight dead names are gone (absence pinned by `tests/api-surface.test.js`, which also asserts the 68-name barrel); `TRACE_PHASES`, `resetQuickJS`, `restoreCode`, `scopeLogger` are kept because they gained a consumer/test. The final wave removed the last internal dead helpers (`symbolKey`, `functionDepth`, `previousName`). |
| D11 | S3 | **Fixed** | One surface per module (`url`, `blob`, `navigator`, non-module `platform-kit`); `ENV_MODULE_IDS` = 28 = install order; zero `requires` violations; 28/28 strict install; subset selection fails loudly instead of dropping a surface. |
| D12 | S3 | **Fixed** | `meta.deferred` declared (`rename`) and consumed by `isDeferredPass`, exposed by `passes --json`; `bridge.fn` indentation fixed; `bridge.call`/`adoptPrototype` removed. |

## Accepted limitations (unchanged from the list above, now documented)

QuickJS ≠ V8, deterministic canvas/WebGL/audio, `IndexedDB` stub,
`crypto.subtle` digest (+ `generateKey`) only, no WASM execution, bounded
`DOMParser`. Added by the alignment: `Attr`/`Range`/`ShadowRoot` absent,
`DocumentType` never instantiated, one guest run per process, per-run cost
~30 %, and both coverage scopes recorded. Each is stated in `README.md` →
"Known limitations" (and, where it is a security boundary, in
`docs/SECURITY-MODEL.md`).

Withdrawn by the final wave: "a guest-set `name:'InternalError'` still classifies
as a stack breach" is **no longer true** — classification is prototype identity
against a prototype the guest cannot reach, and a forged name, a renamed `Error`,
a plain `Error('stack overflow')` and `new InternalError(...)` under Firefox all
stay ordinary exceptions. What replaced it is a narrower residual (reduced
`limits.stackBytes` plus reuse of a prototype read off a real overflow) and a
new accepted cost (host RSS per breach).

## Audit verdicts

| Auditor | Scope | Verdict | Note |
| --- | --- | --- | --- |
| AUDIT-A | D1, D2, D3 | **PASS** (after N1) | Criteria reproduced; N1 (sample-forged "stack overflow" abandoned a healthy runtime) found and fixed by `94b1638`, whose residual is documented. |
| AUDIT-B | D4, D5, D7 | **PASS** | Both D5 reproducers, the full CLI matrix and the trace budget reproduced; two non-blocking notes (`changed` and a trailing newline; advisory `sourceType`) documented. |
| AUDIT-C | D6, D9, D10, D11, D12 | **PASS** on substance | D9/D10/D11/D12 clean; D6's five behavioural criteria hold, its documentation criterion is what this alignment delivers; F4 (missing DOM base interfaces) found and fixed. |
| AUDIT-D | D8 + regression sweep | **FAIL on D8 only** | D8 was the only unmet criterion (no docs/contract update in the range) and is closed by this alignment; no handle leak, no new nondeterminism and no new detection tell was introduced, no barrel export was lost. F1 (a narrowed examples assertion), F2 (+28 % per-run cost) recorded; F3/F4/F5 fixed. |

## Final gates

1. `node --test --test-concurrency=1 $(git ls-files 'tests/*.test.js')` →
   **612 tests, 612 pass, 0 fail** (42 files, 57.9 s) on the pinned tree.
2. `node --test --test-concurrency=1 --experimental-test-coverage $(git ls-files 'tests/*.test.js')`
   → lines **90.32 %**, branches **78.88 %**, functions **86.92 %**; with
   `--test-coverage-exclude='examples/**'` → **92.99 / 82.68 / 90.62**. Both
   scopes are above the review baseline (88.08 / 75.26 / 80.33); the gate is
   applied to the `tools/` scope it was measured on.
3. Every `Dn` has an automated check that fails on the pre-fix code: AUDIT-A/B
   demonstrated the failures on `git archive <fix>^` trees (D1/D2 6 failures,
   D3 2, D4 5, D5 5 + 2 mutation runs, D7 6).
4. `node tools/cli.js analyze examples/sample-loader.js --json` → verdict
   `malicious` (60) with IOCs and artifacts; `restore` returns the decoded source;
   `run examples/benign.js --json` → `ok:true`; `passes --json` → 11.
5. Four independent auditors reproduced the original reproducers on the aligned
   tree; their reports are under `.pi/audits/`.

## Final gate (last alignment wave)

Appended, not a rewrite: the gates above were the alignment wave's own record.
This section is the state of the same acceptance criteria after the follow-up
coverage and handle-lifetime wave (`a8e4965..3013295`, 16 commits).

1. **Suite.** `node --test --test-concurrency=1 $(git ls-files 'tests/*.test.js')`
   → **612 tests, 612 pass, 0 fail** across **42 test files** on commit
   `7c1df9c`, and the captured log contains **0** lines matching `Aborted(` —
   the engine heap assertion no longer escapes on any stack, timer or
   promise-job path (`335c2d0`, `8473a6a`, `4201ae9`).
2. **Coverage, both scopes.**

   ```
   $ node --test --test-concurrency=1 --experimental-test-coverage $(git ls-files 'tests/*.test.js')
   ℹ all files                |  90.32 |    78.88 |   86.92 |
   $ node --test --test-concurrency=1 --experimental-test-coverage \
       --test-coverage-exclude='examples/**' $(git ls-files 'tests/*.test.js')
   ℹ all files                        |  92.99 |    82.68 |   90.62 |
   ```

   | Scope | Lines | Branches | Functions |
   | --- | --- | --- | --- |
   | whole committed tree (includes `examples/`) | 90.32 % | 78.88 % | 86.92 % |
   | `tools/` only | **92.99 %** | **82.68 %** | **90.62 %** |

   **The gate is applied to the `tools/` scope**, because the baseline
   (88.08 / 75.26 / 80.33) was measured there and `examples/` is outside
   `tools/`. That scope is above the baseline on all three metrics (+4.91 /
   +7.42 / +10.29). The whole-tree scope is above the baseline as well and is
   recorded, not re-based.
3. **Reproducers.** `node tools/cli.js analyze examples/sample-loader.js` →
   score 54 / `suspicious`, 8 weighted reasons, 3 URL IOCs, 2 decoded payloads
   (the score dropped from 60 when platform-emitted events stopped scoring as
   sample behaviour); `restore` prints the decoded stage-2 source;
   `run --events` emits **132** trace events, including the mocked beacon as
   `net after` with `net::ERR_NAME_NOT_RESOLVED`.
4. **Audit re-run plan.** The four read-only auditors re-run their original
   reproducers against this tree (AUDIT-A: D1–D3 + forged-`InternalError`
   matrix, AUDIT-B: D4/D5/D7, AUDIT-C: D6 + packaging, AUDIT-D: D8 claim sweep)
   plus the five new handle-lifetime findings L1–L5 recorded in
   `docs/DESIGN-REVIEW.md` → Review 6. Auditors never fix; findings go back to a
   repair lane and then to a re-audit, and `docs/VERIFICATION.md` carries the
   numbers each audit is checked against.

## Final gate (wave 11 — after the final audit round)

Appended again, not a rewrite. A third round of independent auditors
(`FINAL-A-docs-truth`, `AUDIT-FINAL-B-gates`, `FINAL-C-regression-sweep`,
`FINAL-D-fresh-review`) re-ran everything above on a pristine export and found
four blocking defects plus a documentation failure. The wave `5ef930e..7c1df9c`
closed them; this section is the state after that wave, measured on commit
`7c1df9c` (every count in this section is reproducible by exporting that commit,
as `docs/VERIFICATION.md` shows).

1. **Suite.** `node --test --test-concurrency=1 $(git ls-files 'tests/*.test.js')`
   → **612 tests, 612 pass, 0 fail**, 42 test files, 57.9 s, and **0** lines
   matching `Aborted(`. The zero is the point: both engine shapes of a stack
   breach (host throw, and the trampoline's conversion at a host callback),
   plus the timer and promise-job paths, classify *and* tear down without an
   engine assertion.
2. **Coverage, both scopes.** `tools/` scope **92.99 / 82.68 / 90.62** against
   the review baseline 88.08 / 75.26 / 80.33 (+4.91 / +7.42 / +10.29); whole
   committed tree **90.32 / 78.88 / 86.92**. The gate stays on the `tools/`
   scope it was defined on.
3. **Reproducers.** `analyze examples/sample-loader.js` → 54 / `suspicious`, 8
   reasons, 3 URL IOCs, 4 artifacts; `restore` prints the decoded stage-2
   source; `run --events` → 132 events; `passes --json` → 11 (deferred:
   `rename`); `analyze examples/benign.js` → 0 / `benign`; `run
   examples/benign.js` → `ok:true`, `result {"type":"undefined"}`; `node
   examples/national-sdk/verify.mjs` → 37/37; `bash examples/cli-usage.sh` → 0.
4. **Do not count what is not in the pinned commit.** Example corpora under
   `examples/{products,works,suite,mega}` were never tracked at `7c1df9c`. Later
   commits add them with their own tests; they are outside every figure in this
   document.

### Findings and dispositions

| Id | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| FINAL-A F1–F21 | Doc | Counts and gates had been measured on a working tree that contained untracked example corpora: 600 tests / 46 files, both coverage scopes, `result.value = 55` for `run examples/benign.js`, `21` invalid CLI invocations, `types.test.js` 5/5, `1b0f2c7..HEAD` 47 commits, a `136`-event trace tail, and four corpora documented as shipped features. | **Fixed**: every figure regenerated from `git archive 7c1df9c` and pinned to that commit in `README.md`, `docs/VERIFICATION.md`, `docs/DESIGN-REVIEW.md` and this file; corpus claims and their table rows removed; the remaining corpus mentions state that they are outside the pinned measurement. Corpus numbers are not replaced with *their* numbers — those trees are simply not part of this record. |
| F-B1 | S2 | Documented suite/coverage totals and four gate commands did not reproduce from the committed tree. | **Fixed** by the same re-pinning; gates now name commands that work on the pinned export. |
| F-B2 | S2 | Committed gate commands referenced paths that were not tracked. | **Fixed**: those commands are gone; the demo list is the committed sample set plus `examples/national-sdk/verify.mjs` and `examples/cli-usage.sh`. |
| F-B3 | S2 | The N1 forgery defence was defeated by the `stack` env module: the Firefox `InternalError` wrapper's prototype *was* the intrinsic, so `new InternalError(...)` passed the reachability test and forced a quarantine (and a module recompile) per run. | **Fixed** `5ef930e`. `env/stack.js` gives the wrapper a fresh prototype with the same own properties and the same `[[Prototype]]`, so the intrinsic stays unreachable while the surface stays faithful; if the wrapper cannot be installed, the module calls `stealth.revokeStackEvidence()` and guest-dump certification is withdrawn for the run (the host witness is unaffected). Regression: "a Firefox profile cannot forge engine exhaustion in the full environment" installs the **full** environment (`env: {strict:true}`), which is what the original test missed. |
| F-B4 | S2 | Breaches were classified in only some runs: when the host stack gave out inside a host callback, quickjs-emscripten converted the overflow into a guest `Error`, and the run reported `limitsHit: []` with a clean disposal (1–5 of 12 documented runs). | **Fixed** `5ef930e`. `runtime.js` `guardHostStackExhaustion` records the engine signal host-side (a counter no guest value can write), `invoke.js` reads the counter around the branch that ran, and both shapes go through one record builder: `error.stack === ''`, `limitsHit: ['stack']`, `stackExhaustion: true`, `disposal {ok:false, leaked:true, stage:'runtime', skipped:true}`. 40 consecutive runs in the full environment produce exactly one record; a guest that *swallows* the converted overflow still returns `ok:true` with `limitsHit: ['stack']`. |
| FINAL-C F1 | S2 | Consequence: stack runs were classified nondeterministically (~5 % lost the marker) and 7/20 same-seed reports differed. | **Fixed** by the same commit; the 40-run loop asserts a single JSON shape for `{ok, limitsHit, error, disposal}`. |
| FINAL-C F2 | S2 | `DOMParser`, `XMLSerializer` and `EventSource` branded as `[object Object]`; `typeof CustomElementRegistry === 'undefined'` (three one-line tells plus an undocumented global). | **Fixed** `5e40603`: the three brands are real and `CustomElementRegistry` is a global with a native-looking source. `env-fidelity` 16/16, `env-surface` 18/18. Documented deviation: `customElements instanceof CustomElementRegistry` is still `false`. |
| FINAL-C F3 | S3 | `createTraceRecorder({strict:true})` + a hook bus threw `unknown trace phase: run|init|dispose`; non-strict recorders stopped validating `kind`. | **Fixed** `4ad8c42`: hook events use trace phases `emit`/`transform` with the hook phase in the `hook` field, and `kind` is validated in every mode (a code-level constant, never guest data). |
| FINAL-C F4 | S3 | `classifyLimit` lost its deep-module export without a stated reason. | **Accepted**: internal to `invoke.js`; the behaviour is covered end-to-end and the exported surface is pinned by `tests/api-surface.test.js`. |
| FINAL-C F5 | S3 (note) | Each breach costs ~17 MB RSS permanently (module quarantine). | **Accepted and documented**: measured 21.7 MB per breach over six breaches here; `README.md` and `docs/SECURITY-MODEL.md` state the cost and recommend worker processes for long batches. |
| FINAL-D D4 (F3) | S3 | Hook errors were count-bounded but size-unbounded (~838 MB measured), `errorsTruncated` never reached a run record, and the report dropped `hooks.errors`. | **Fixed** `4ad8c42` + `127ac98`: 200 entries **and** 64 KiB total (2 KiB per message); the report keeps the newest 50 with `hooks.errorsTruncated` and prints a Markdown line. |
| FINAL-D D8 (F3/F4) | — | `REPORT-SCHEMA.md` promised `hooks.errors` the report did not carry, and `README.md` claimed a subset install always fails loudly. | **Fixed (doc + code)**: the report now carries the field, and both `README.md` and `ARCHITECTURE.md` state the two strictness defaults (`installEnvironment` `strict: true`; `TracelessSandbox.create({env})` `strict: false`). |
| FINAL-D D10 (F7) | S3 | Internal dead code survived the D10 sweep: `symbolKey`, `functionDepth`, `previousName`; `bridge.stats` counters were write-only. | **Fixed (mostly)** `7d17a65`: the three dead internals are gone. `bridge.stats` is kept: it is typed public API (`types/ai4reverse.d.ts`) and asserted by "bridge stats count the calls, errors and conversions that happened". |
| FINAL-D D11 (F4) | S2 | The "subset selection never silently drops a declared surface" claim held only with `strict: true`. | **Fixed (doc)**: defaults documented; behaviour unchanged. |
| FINAL-D F1 (new S2) | S2 | The verdict scored the platform's own installation events: every sample gained `DYNAMIC_DOM`, and `alert(1)` additionally gained an `anti-analysis` family. | **Fixed** `127ac98`: `behavior.js` attributes every event (`eventOrigin`), report scoring filters platform events, and `dynamic.behavior.counts.platform` reports them. Measured effect on the pinned tree: `examples/sample-loader.js` 60 → 54 (71 of 133 events are platform events), `examples/benign.js` 6 → 0. |
| FINAL-D F2 (new S2) | S2 | Per-call guest objects were retained until run teardown, so guest call counts grew host heap past `memoryBytes` (+159 MB for 20 000 calls, 649 MB / timeout at 200 000). | **Fixed** `eca5305`: per-call values live in a bag released when the call returns, `bridge.fn` transfers the returned handle through the trampoline, long-lived handles are bridge-owned and freed once, and `bridge.deferred` releases its host handles at settle (or the next call). Regression: "per-call value builders die with the call" and "a 20k-call builder loop stays on a memory plateau". Residual documented: no host-heap cap. |
| FINAL-D F3 (new S3) | S3 | See D4 (F3) above. | **Fixed**. |
| FINAL-D F5 (new S3) | S3 | An unknown `profile.browser` threw a bare `TypeError`; unknown `limits` keys were silently ignored. | **Fixed** `9112141`: `SandboxError` with `code: SANDBOX_PROFILE` naming the accepted values, and `SANDBOX_LIMITS` for limit typos; `normalizeLimits(input, {strict:false})` keeps the lenient path and warns per ignored entry. |
| FINAL-D F6 (new S3) | S3 | A malformed hook registration was silently discarded; `[phase, handler]` registered nothing, so a hook meant to block a behaviour never ran. | **Fixed** `7c1df9c`: `registerHooks` accepts the descriptor form and the `[phase, handler, options?]` tuple form (list or single) and throws `HookError` for anything malformed. |
| FINAL-D F8 (new S3) | S3 | A restoration failure was indistinguishable from "nothing to restore" in the report. | **Fixed** `127ac98`: `static.restoration.error` carries the message and Markdown prints `**Restoration error:**`. |
| FINAL-D F9 (new S3) | S3 | Trace truncation was invisible and `tracing.dropped` understated a hard 20 000-observation cap by three orders of magnitude. | **Fixed** `127ac98` + `7692660`: `tracing.truncated`/`truncatedBy` are derived from the run record (`code-budget`, `event-limit`), so they survive the marker being evicted from the retained window, and the Markdown line names the cause. |
