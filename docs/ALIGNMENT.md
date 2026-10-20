# Tools acceptance alignment — 2026-10-20

## PRD

Align implementation, regression tests, declarations and current contracts with
the acceptance audit of baseline `f54c0ef`: seven HIGH failure modes and twelve
MEDIUM findings. H2/H3 share a simplification path, so these are not nineteen
independent root causes. Every finding needs an explicit disposition and
executable evidence, not merely a green pre-existing suite. Preserve mocked
networking, isolation, host-trust acknowledgement and documented residual risks.

Non-goals: new runtime architecture, a full browser, removal of known host-heap/
low-stack boundaries, blanket rewrites of owned AST/handle state, or publishing
and committing changes.

## Architecture

Retain ESM layers and public entry points. Reuse Babel, QuickJS, hook matching,
sandbox options and trace primitives. No new runtime dependency. A development
TypeScript compiler supports real consumer checks. One writer owns each domain;
one coordinator owns integration and docs. No stash/checkout in the shared tree.

## System design

- Preserve directives, expression values, receivers and indirect eval. Skip
  transformations whose safety cannot be established. Differential restore tests
  disable instrumentation to isolate transformation behavior.
- Keep guest errors distinct from host engine evidence. Reuse resource
  classification in entry/eval, free rejected callbacks, honor remaining job caps.
- Match restored execution options, wildcard listener gates and registration forms.
- Record dependency degradation structurally while preserving non-strict installs.
- Expose trace.events as a consistent detached array snapshot (shallow events).
- Align declarations with runtime rather than adding phantom APIs. Preserve
  historical docs baselines and add current corrections separately.

## Technical plan

Each defect: RED → minimal GREEN → focused regression. Logs go in independent
$TMPDIR directories. Only bounded benign sandbox samples, synthetic secrets and
fake disposal failures; never execute untrusted samples directly with Node.
Run full serial tests and coverage after parallel implementation integration.

Gates: regressions, full tests, TypeScript consumer compilation, JS syntax,
exports/CLI checks, package contents, independent code/security review. Measure
host line/branch/function coverage against 80%, distinct from QuickJS coverage.
Unexecuted platform matrices and online audits remain explicitly unverified.

## Task list and ownership

| IDs | Owner / exclusive source scope | Required regression | State |
|---|---|---|---|
| H2-H4, M1 | restore: proxy-unwrap.js, eval-unwrap.js | Values, side effects, indirect eval, strict scope, receiver; individual/default passes | fixed; independent review approved |
| H1, M3 | instrumentation: code.js, jsvmp.js, index.js | Strict program/function directives; positive/negative VM detection | fixed; independent review approved |
| H5-H7, M4-M6 | runtime: engine/runtime.js, invocation/invoke.js, sandbox lifecycle/bridge, env url/blob/network/index | Provenance, cleanup, timeout, job cap, fake limit text, dependencies | fixed; security review approved |
| M2, M7-M8, M10-M11 | surface: orchestrator.js, cli.js, hook/*, logging/logger.js | Restored parity, redaction, hook forms, CLI options, wildcard events | fixed; independent review approved |
| M9, M12 | types/trace: types/*, instrumentation/trace.js, package tooling | Real compiler consumers, runtime shapes, snapshots across eviction | fixed; independent review approved |
| Coverage gaps | tests-only owner | Disposal exception chain, GCM decrypt/errors, public API lifecycle | tests added; included in integrated gates |
| Docs/integration | coordinator | Contracts, examples, engine paths, dispositions, full gates/review | complete; final gates passed |

## Verification ledger

Historical baseline: 676 tests passed; host coverage 89.83% lines / 80.74%
branches / 88.52% functions. These are not post-fix results.

- Implementation plan and TDD matrix reviewed before source changes. GitHub
  repo/code search was attempted but authentication/TLS prevented results;
  official documentation and installed Babel/QuickJS/Pino sources were checked.
  No runtime dependency was added for the fixes.
- Restore RED: 43 tests, 6 passed / 37 failed; logs
  `$TMPDIR/restore-alignment.glAG74/red.log`. Separate receiver/tag controls
  expose the existing tagged-template quasi replacement issue; preserve the
  regression rather than weakening the fixture.
- Runtime initial RED: 17 tests, 6 passed / 11 failed;
  `$TMPDIR/runtime-alignment.KLTpoW/red.log`. Final resource validation pending.
- Surface initial corrected RED: 23 tests, 2 passed / 21 failed. Targeted GREEN:
  99/99. Null/undefined compatibility regression then 46/46 across three runs.
  Independent surface review ran 91/91 and approved the specified domain.
  Logs: `$TMPDIR/surface-alignment.ohIQ8K/`.
- Instrumentation initial RED: 49 tests, 17 passed / 32 failed. Independent
  review caught mixed-switch scope pollution after the first fix. Expanded RED:
  61 tests, 58 passed / 3 failed; scope-local correction then 90/90, related
  suites 123/123 across three runs. A lexical outer constant-pool regression
  from this correction is being repaired before closing M3. Logs:
  `$TMPDIR/instrumentation-local-evidence.LYAkiX/`.
- Trace snapshot regressions: three actual RED cases, then the focused trace
  suite GREEN. Real TypeScript consumer compilation is still pending.
- Extra coverage tests: 23 additions for runtime disposal, public API lifecycle
  and GCM success/error paths. Five GCM cases exposed missing rejection messages;
  the assertions are retained and the bridge owner is fixing the implementation.
  Three initial report-error assertions were test mistakes and corrected to the
  existing string contract, not counted as implementation regressions.

Final integrated evidence directory:
`/tmp/claude-501/tools-alignment-verification.UIVqmz/`.
All counts above describe named snapshots/subsets, not final whole-tree gates.

## Finding dispositions

| ID | Resolution | Regression anchor |
|---|---|---|
| H1 | Honor Babel directives and interpreter/hashbang offsets before probes | instrumentation-alignment.test.js strict/ASI/hashbang matrix |
| H2 | Retain sequence tail value and side-effect order | restore-alignment.test.js sequence cases |
| H3 | Preserve indirect eval and reference semantics, including with-environment identifiers | restore-alignment.test.js call/optional/tag/delete/typeof/with cases |
| H4 | Leave direct eval in inherited strict contexts unchanged with a note | restore-alignment.test.js function/module/class/static-block cases |
| H5 | Transfer original guest error handles through bridge callback results | runtime-alignment.test.js forEach identity and module-health cases |
| H6 | Dispose refused network callback handles instead of storing id zero | runtime-alignment.test.js network timer rejection and recovery |
| H7 | Share host-owned interrupt classification for entry/eval/settle, preserving real host stack priority | runtime-alignment.test.js timeout/memory and dual-evidence cases |
| M1 | Do not erase single-element array call receivers | restore-alignment.test.js array receiver cases |
| M2 | Share explicit original/restored run options | surface-alignment.test.js comparison options and returned value |
| M3 | Reuse candidate-local VM evidence; resolve referenced lexical pools without cross-function evidence borrowing | instrumentation-alignment.test.js ordinary/mixed/scope/pool cases |
| M4 | Limit each pending-job batch to the remaining budget | runtime-alignment.test.js job budget boundaries |
| M5 | Reject guest text as limit provenance; narrow intrinsic-shaped subtype fallback | runtime-alignment.test.js fake limit messages and real engine errors |
| M6 | Record each missing dependency and report complete=false while allowing non-strict installation | runtime-alignment.test.js and types.test.js nonempty environment result |
| M7 | Redact explicitly supported credential fields and header spellings | surface-alignment.test.js synthetic values and input preservation |
| M8 | Normalize root tuples, nested lists and hook sets; preserve null/undefined compatibility | surface-alignment.test.js registration shapes |
| M9 | Align artifact, write sink, environment and store shapes; strict compiler consumers for all subpaths | types.test.js and fixtures/types/* |
| M10 | Parse and pass run profile/mocks, reject malformed JSON | surface-alignment.test.js CLI subprocess cases |
| M11 | Match hasListeners with enabled exact/domain/global wildcard dispatch | surface-alignment.test.js actual wrapped API events |
| M12 | Always return a frozen detached array snapshot; document shallow sharing and read cost | trace-budget.test.js snapshot lifetime and readonly consumer cases |

Adjacent defects found while implementing these regressions were also repaired:
static tagged-template quasi replacement, GCM rejection messages lost in generic
Error conversion, timer/promise interrupt reporting, with-scope receiver identity,
VM candidate evidence leaking across functions, lexical outer constant-pool
extraction, and an accidental internal-helper public export. They are not new
independent security claims or new product features.

## Final integrated results

First full serial run: 883 tests, 882 pass / 1 fail / 0 skipped. The sole failure
was an old test mutating `trace.events.length`; it was migrated to `trace.clear()`
in accordance with M12, with its counter/sequence assumptions checked. The
focused env-misc + trace + types rerun passed 42/42. This failure is retained here
rather than presented as an all-green first attempt.

Post-correction complete suite and coverage both pass on the final source tree:

| Gate | Command / scope | Result |
|---|---|---|
| Full serial tests | `pnpm test` | 883/883 pass, 0 fail/skip; 91.910s |
| Host coverage | Node test coverage, `tools/**/*.js`, serial | 883/883 pass; 170.816s |
| Lines | 32531 / 36078 | 90.17% |
| Branches | 6220 / 7615 | 81.68% |
| Functions | 1870 / 2100 | 89.05% |
| Public types | `pnpm test:types`, strict NodeNext/noEmit/skipLibCheck:false | exit 0; all 11 package subpaths consumed |
| Syntax | `node --check` on every tools JS | 93/93 |
| Package imports | package-name root/subpath imports | 11/11 |
| CLI | analyze/restore/run/events, valid profile+mocks, invalid JSON | 7/7 including expected exit 2 cases |
| Packaging | real `pnpm pack`, fresh temporary offline install | installed successfully; package CLI and sandbox 1+2 passed |
| Installed-package types | positive and rejected consumers against installed declarations | exit 0, using local compiler/typeRoots only |
| Safe VM cookbook | execute current docs/API.md example with explicit generated entry | `fib(10)=55 via VM` |
| Formatting | `git diff --check` | pass |

Coverage is host V8 only, not QuickJS guest branch coverage. As at baseline,
92/93 tool files entered the coverage report; `tools/engine/index.js` is not
zero-filled. All three aggregate metrics exceed 80%; this is not a claim that
every module or every guest behavior has 80% coverage.

Independent review results:

- Restoration: approved after fixing the newly found with-environment receiver
  case; reviewer ran 50/50 alignment tests. Owner ran 200/200 restoration tests
  three times; changed-pass coverage 99.15 / 87.87 / 92.06%.
- Instrumentation: approved after repairing mixed-function candidate evidence,
  lexical constant pools and internal-helper export leakage. Reviewer ran 99/99
  across four relevant suites; owner ran related 132/132 three times.
- Runtime security: no unresolved CRITICAL/HIGH in the scoped diff; reviewer ran
  22 bounded/synthetic cases. Owner ran seven suites, 163/163 with no engine abort
  output. No pressure tests or host-escape proof are claimed.
- Public surface: approved; independent 91/91 across four suites, including
  null/undefined compatibility, wildcard listeners and CLI configuration.
- Types/trace/test gaps: approved; independent first pass 65/65 across five files,
  then final strict compiler and types 10/10 after the additive runtime fields
  were synchronized. The later env-misc migration was verified in a 42/42 subset.
- Documentation: independently approved for current contracts, safety residuals,
  sandbox VM example, environment degradation, snapshot semantics and historical
  baselines. Counts above were extracted by the coordinator from actual logs.

Verification evidence:

- `/tmp/claude-501/tools-alignment-verification.UIVqmz/full-tests.log`: first run
  with the one snapshot-consumer failure; `full-tests-final.log`: corrected run.
- Same directory: `coverage-tests.log`, `coverage.lcov`, `coverage-summary.json`,
  `types.log`, `syntax-exports.json` and command exit-code files.
- `/tmp/claude-501/tools-final-e0rToo/`: CLI commands/results, real pack and offline
  installation, installed-package runtime/type consumers, cookbook output and
  package-content comparison. Initial offline installation hit a sandbox store
  lock permission error; an approved retry remained offline with scripts disabled.
  Later packs include documentation updates; tools/types/package.json match the
  source used for successful fresh installation.

## Acceptance outcome and limits

**Complete for this report's H1–H7/M1–M12 scope.** All nineteen finding rows have
implementation, regression and review dispositions. Known limitations were not
silently promoted into guarantees: host-heap budgets, caught intrinsic-prototype
reuse, heuristic VM detection, shallow snapshots, finite redaction paths and
caller-supplied private sandbox configuration remain documented boundaries.

No compilation build or ESLint is configured for the directly published ESM
implementation; syntax and consumer type checks are the applicable gates. No
multi-platform matrix, remote CI, online dependency-vulnerability audit or formal
sandbox-escape proof was run. No commit, push or publication was performed.
Temporary evidence directories may be cleaned by the operating system; this
repository ledger retains commands, results and per-finding regression anchors.
