# MCP acceptance — 2026-10-29 (third wave)

Companions: [`MCP-WORKFLOW.md`](./MCP-WORKFLOW.md) documents the hook mechanism;
[`ACCEPTANCE.md`](./ACCEPTANCE.md) is the acceptance record for `tools/`. This file is
the acceptance record for the six MCP servers, which neither of those covers.
(`MCP-WORKFLOW.md` is not yet tracked by git; add the back-link when it is committed.)

Six servers are configured in `.mcp.json`. This wave asks a different question from
the 2026-10-26 and 2026-10-27 waves.

Those waves asked *"does the server start, and does the tool return something?"* —
and answered it twelve times over. This wave asks: **given a reverse-engineering
question whose answer is independently computable, does the MCP answer it correctly,
does it see the files that matter, and does it beat `rg`?**

Evidence classes: **[V]** verified by re-running and comparing against source or `rg`;
**[A]** asserted by a probe but not independently reproduced.

Method: one control arm (shell-only oracle), six server probes, one hook-integration
audit, one adversarial red team. Every MCP answer was checked against source before
being scored. Two probes could not see the MCP tools from their own session and drove
the same servers over stdio/CLI instead; that is noted where it matters.

---

## 1. Verdicts

| Server | Verdict | Reason in one line |
|---|---|---|
| `codebase-memory` | **CONDITIONAL PASS** | Strong on the indexed zone, but eight documented silent-failure shapes; usable only with a coverage check before every conclusion. |
| `serena` | **CONDITIONAL PASS (structure only)** | The only server that can see the untracked `src/tiktok` pipeline — but its reference tool returns `{}` for symbols with 19 real references. |
| `semble` | **FAIL (as a decision instrument)** | Cannot represent "no results": a nonsense query returns five confident paths. |
| `memory` | **DEMOTE** | No fact/hypothesis status, substring-only search, ~70–80 % redundant with existing docs. |
| `mimir-ontology` | **PASS (narrow)** | The only store that preserves `verified: false`; useful for claim auditing, not code understanding. |
| `open-ontologies` | **REMOVE** | Zero RDF/OWL/SPARQL in the repository; 119 tools of context for a capability nothing produces or consumes. |

Overall: **the servers are not the bottleneck. The wiring between them and the work
is.** The knowledge layer (`memory`, `mimir`) has been adopted since the hooks landed;
the retrieval layer (`codebase-memory`, `serena`, `semble`) has not, and the evidence
below explains why.

---

## 2. Environment at measurement

Measured 2026-10-29 13:38 CST. These numbers move — a parallel session was writing to
`.mimir` throughout this wave (`Finding` went 43 → 49 during the audit).

| Fact | Value |
|---|---|
| `codebase-memory` index | 29 289 nodes / 151 267 edges, built `2026-10-29T04:58:02Z` |
| JS files **indexed** vs **on disk** | 362 vs 1 002 — **64 % of `.js` files are not in the graph** [V] |
| `tools/` lines outside the index | 17 709 / 44 202 = **40.1 %** (`tools/sandbox/env/`, excluded subtree) [V] |
| `src/tiktok/scripts/` | 27 numbered stages, 13 065 lines, **untracked**, excluded by gitignore [V] |
| `src/tiktok/tmp/pretty.js` | the real 365-entry dispatch table; untracked, invisible [V] |
| `.mimir` | 120 claims / 67 entities (49 Finding, 16 Artifact, 2 Sample) / 53 links |
| `.claude/memory.jsonl` | 19 entities / 43–45 relations / 30 626 B |

The exclusion chain matters: the numbered stages are hidden by the **machine-global**
`~/.gitignore_global:73 **/[0-9]*.*`, not by the repository. A repo-level `!` negation
cannot override it; only same-file negation or git tracking can.

---

## 3. `codebase-memory` — CONDITIONAL PASS

### What it is genuinely good at [V]

- **Inbound call graph on direct-identifier callees.** `trace_path` on
  `…sandbox.bridge.createHostBridge` separates real calls from re-export lines and
  labels hop distance; `rg` alone returns nine hits, four of them `export {}`.
- **Whole-repo symbol inventory with degree.** `search_graph name_pattern=dispatch`
  returns 17 symbols with file, line range, in-degree and out-degree in one call.
- **Honest disclosure when asked directly.** `get_code_snippet` on a partially parsed
  file emits a `coverage_note`; `check_index_coverage` at **file** granularity returns
  `excluded` + `not_indexed_dir` + the reason.

### The decisive defect: `trace_path` never infers receiver types [V]

| Query | Result |
|---|---|
| `…TracelessSandbox.create` (static call on a class name) | `callers_total: 36`, correctly grouped |
| `…TracelessSandbox.run` (instance call `sb.run(...)`) | `callers_total: 0`, `callers_total_relation: "eq"` |
| Ground truth (`rg`) | 4 production call sites |

The rule: **`trace_path` resolves bare-identifier callees and static
`ClassName.method` references; it returns a confident zero for instance methods called
through a variable, even when the receiver is assigned from `Ctor.create()` one line
earlier.** The `"eq"` relation is what makes it dangerous — the response reads as
*proof* that no caller exists.

This also retires a recorded workaround: prior memory said `trace_path` requires a fully
qualified name and that short names "waste a round trip". In this session the MCP path
rejected `TracelessSandbox.run` with `function not found`, while the CLI path accepted
it and answered `0`. **The two call paths resolve names differently.** Use the full qn
and verify the rule per call path.

### Silent-failure shapes (all [V])

Every item below returns a well-formed, confident answer with no coverage caveat.

1. `search_graph name_pattern=userAgent` → `total: 3`, all under `examples/`. The real
   installer (`tools/sandbox/env/navigator.js:86`) is invisible.
2. `search_graph file_pattern=tools/sandbox/env` → `total: 0` with the hint *"broaden or
   remove filters"* — advice that walks the model **away** from the truth.
3. `search_graph name_pattern=translateHandler` → `total: 0` on a real exported function.
4. `search_code pattern=translateHandler` → 3 files, `has_more: false`,
   `total_relation: "eq"`; misses the definition and the real consumer
   `src/tiktok/scripts/16-emit-lifted.mjs:26`.
5. `trace_path TracelessSandbox.run` → `0` (see above).
6. **The advertised fallback shares the blindness.** The server's own instructions say
   *"Use search_code/grep for literals or coverage gaps."* `search_code` greps the same
   filtered corpus: 7 literal occurrences of `createNetworkService` under
   `tools/sandbox/env/` return `total_grep_matches: 0`. The recovery path cannot detect
   the gap it exists to catch.
7. `check_index_coverage` **on a directory** returns `no_recorded_issue` while the same
   payload's per-file rows mark every file `gitignore`. Directory-level and file-level
   coverage contradict each other, and the contradiction points toward "fine".
8. `get_architecture` reports **362** JS files against **1 002** on disk [V] — a 3×
   undercount with no coverage field in the payload.

Parameter naming is also a trap, though not a defect: `file_pattern` is a **filename**
(`lifted.js` works, `src/tiktok/output/lifted.js` returns 0), while `path_filter` takes a
**path** and works correctly. Same concept, two flags, opposite semantics.

### Required usage discipline

> Before any "X does not exist" conclusion, call `check_index_coverage` with the exact
> **file** path. `status != no_recorded_issue`, `excluded`, `gitignore`, or
> `parse_partial` all mean **UNKNOWN**, never absent. Enumerate files with
> `rg --files`, never with `get_architecture`.

---

## 4. `serena` — CONDITIONAL PASS (structure only)

### The decisive advantage [V]

`get_symbols_overview` and `find_symbol` work on **untracked** files, because the LSP
backend reads the filesystem rather than a git index. On
`src/tiktok/scripts/15-lift.mjs` — a file `codebase-memory` cannot see at all — serena
returned all 13 top-level functions and all 6 `Scope` methods, correct. On
`tools/sandbox/sandbox.js` it was *more complete than `rg`*: it found
`static async create`, which a naive grep misses, and every line range was accurate.

### The decisive defect [V]

`find_referencing_symbols` returns `{}` for cross-file references, and `{}` is
indistinguishable from a genuine empty result:

| Symbol | serena | ground truth (`rg`) |
|---|---|---|
| `createHostBridge` | `{}` | 5 real call sites |
| `TracelessSandbox` | 1 (same-file) | 98 references across 34 files |
| `analyzeSource` | `{}` | 19 references, incl. `sandbox.js:33,555` |

Worse, `safe_delete_symbol` sits next to it. The textbook reading — "symbol exists, zero
references, therefore dead code, safe to delete" — is one tool call away from a wrong
destructive action. Within a single file the tool is correct (one call site found, no
false positives).

### Operational limits [V]

- Workspace-wide `find_symbol` (no `relative_path`): **timeout at 120 s**.
- `find_symbol Scope` in the untracked `.mjs`: **timeout at 120 s** (228 s elapsed).
- `get_diagnostics_for_file` on a 15 KB `.mjs`: **68 s**; on `env/globals.js`: 504 ms,
  with a genuine TS2345.
- Read-only calls are not pure: serena writes `.serena/cache/typescript/*.pkl` into the
  repository (gitignored, but a "read" tool that mutates the tree).

### Required usage discipline

> `{}` means **unknown**, not **none**. Calibrate once per session on a symbol known to
> have callers; if that also returns `{}`, stop using the reference tool for the rest of
> the session and use `rg -n`. Use serena for **structure on untracked files** — that is
> its unique capability here — and always pass `relative_path` to avoid the timeout.

---

## 5. `semble` — FAIL (as a decision instrument)

The dedicated probe failed before delivering: the `uvx` cold start did not complete in
the time box and the retry hit a 502. The findings below come from the red team's direct
CLI runs against the same package, and are consistent with the known instrument
behaviour.

**Absence is unrepresentable.** [V]

| Query | Hits | Top score |
|---|---|---|
| `"opcode dispatch"` | 5 | 0.0257 |
| `"quantum key rotation lattice cryptosystem"` | 5 | 0.0110 |
| `"banana pancake recipe with maple syrup"` | 5 | 0.0091 |

There is no empty result and no threshold. A semantic searcher that always returns five
paths cannot answer "is this absent from the repository?" — the one question a
reverse-engineering session most needs answered. Scores are not calibrated across
queries, so `0.0110` for nonsense is not visually distinct from `0.0257` for a real
concept.

**Verdict:** keep as a *discovery* aid when names are unknown and a human will read the
hits; do not use it as evidence of absence, and do not let it into an automated gate.

---

## 6. `memory` — DEMOTE

**It is no longer empty.** 19 entities / 43–45 relations / 30 626 B, written since the
evidence hooks landed. Write/read/delete round-trips cleanly (+144 B, then byte-identical
after delete) [V].

But it fails the two tests that matter for "deepening code understanding":

1. **No epistemic status.** There is no field anywhere recording verified vs hypothesis.
   The `latch` hypothesis that `mimir` holds explicitly (`verified: false`) is
   **absent entirely** — `latch` → 0 entities, `hypothesis` → 0, `commonSuccessor` → 0.
   Hedges survive only as incidental English inside two observations. Everything else
   reads as flat assertion. [V]
2. **The query interface is substring-only.** `"what is known about the tiktok mssdk
   decoder"` → **0 entities**. Only single tokens work (`tiktok` → 4). [V]

Also by design: `search_nodes` emits relations whose *other* endpoint did not match, so
a decoy entity shows up in results for a search it never matched
(`dist/index.js:516-518`) [V].

**Redundancy:** 15 of 19 entities restate repo structure already in `tools/index.js` and
`docs/`; the 4 RE entities duplicate the file-based auto-memory. Estimated 70–80 %
redundant. Its one genuine save: it is the only surviving record of the SHEIN
x-gw-auth chain now that `src/shein/` is empty.

**Verdict:** demote to a fallback document store. Do not treat it as a knowledge base
with truth values. The file-based auto-memory already does this job better and is
injected automatically.

---

## 7. `mimir-ontology` — PASS (narrow)

**It preserves epistemic status — the only thing in this stack that does.** [V]

`get` on the latch finding returns `"verified": {"value": false, …}` and the summary
begins *"Hypothesis from static analysis and an agent report, not yet independently
executed"*. `query {verified eq false}` returns exactly the three unverified findings.
This is the single concrete question mimir answers better than reading five reports:
**"which conclusions about this pipeline are still unproven?"**

Caveats, all [V]:

- **`confidence` is `1.0` on all 120 claims**, including the unverified hypotheses. A
  reader who trusts `confidence` instead of `verified` is misled. Only `verified` carries
  the distinction.
- **The MCP view is frozen at server start.** Controlled experiment: after `ingest` +
  `materialize` under a running server, the new entity returns `0` while the CLI returns
  `1`, with no warning (`mimir/cli.py:386-410`; the only staleness check compares
  `schema_hash`, which materialize does not change). Restart after every materialize.
- **No text search.** `search` is one type plus equality filters; `contains` is rejected
  with `INVALID_OPERATOR`. You must know the type first.
- **45 % of claims (54/120) point at deleted files** — 25 at
  `src/tiktok/output/acceptance/FINDINGS.md`, 29 at the now-empty `src/shein/`. The
  provenance links that would let a reader audit them are dead.
- **The graph is partially disconnected**: at measurement, 17 of 43 findings were not
  reachable by `traverse` from the Sample.
- **Do not verify counts from `.mimir/*.jsonl`.** Those files are ingestion *inputs*, not
  the log; the log lives in the `claims` table. Counting JSONL produces a false
  discrepancy.

**Verdict:** keep, for claim/status auditing only. Not a code-understanding tool.

---

## 8. `open-ontologies` — REMOVE

This wave overturns the headline defect recorded by six prior rounds.

### `onto_dl_check` is not broken — the calling convention is undocumented

Independently reproduced twice, in the live server and by the probe:

| Input | Result |
|---|---|
| `sub_class: "http://example.org/Dog"` | `{"error":"Unknown class: http://example.org/Dog"}` |
| `sub_class: "<http://example.org/Dog>"` | `{"sub_class":"<…Dog>","subsumed":true,"super_class":"<…Animal>","trace":[]}` |

The tool parses its argument as Turtle and rejects a bare IRI, but its schema says *"IRI
of the sub-class"*. The engine is correct — `onto_dl_explain` even produces
`Clash: disjoint concepts Atom(0) and Atom(1)` for a genuinely unsatisfiable class.

`onto_default_apply` was likewise misdiagnosed: the "empty `triples_added`" came from a
read-only data directory. With a writable directory it adds the triple, and the second
application returning `[]` is correct idempotency.

**This is the most important methodological finding of the wave.** Six independent
acceptance rounds "confirmed" the same HIGH defect because each reused the previous
round's probe, which passed a bare IRI. The error text echoes the input it received —
that is the signal that separates "the tool is broken" from "I called it wrong".

### Why remove it anyway

- **Zero RDF/OWL/SPARQL files in the repository.** `.mimir/schema.yaml` is Mimir YAML;
  the project's own hook already encodes that boundary.
- Sampling 27 tools across families: 24 returned non-error (89 %), 22 strictly functional
  (81 %). `onto_embed`, `onto_search`, `onto_similarity` are dead in this deployment (no
  models directory).
- The only plausible workflow — claims → JSON-LD → SPARQL/SHACL — requires **hand-authored
  RDF**, loses per-claim provenance, and has no round-trip (`onto_convert` has no JSON-LD
  output). It duplicates `mimir`.
- New defects observed: `onto_ingest` is non-atomic (leaves one triple on error);
  `onto_hnsw_build` returns `ok:true, entries_indexed:0`; `onto_clear` does not remove
  registered laws, which then fire against later graphs across processes.

**Verdict: REMOVE from `.mcp.json`.** 119 tools of context buy nothing this repository
produces or consumes.

---

## 9. Corrections to previously recorded conclusions

| Recorded | Status now |
|---|---|
| `onto_dl_check` family unusable (HIGH, six rounds) | **False for this build.** Requires `<IRI>`. Amend, do not erase — the operational rule "prefer `onto_classify_el`" stays valid. |
| `onto_default_apply` returns empty `triples_added` | **Misdiagnosed.** Read-only data directory. |
| `trace_path` only accepts fully qualified names | **Incomplete.** The real rule is receiver form: static/class-name calls resolve, variable-receiver instance calls silently return 0. |
| `memory` graph is empty / writes fail | **Superseded.** 30 626 B, write probe clean; the problem is now semantics, not plumbing. |
| `.mcp.json` untracked | **Fixed** — tracked since `a029ee9`. |
| `serena` cross-file `find_referencing_symbols` | **Still broken**, third confirmation, now with `analyzeSource` (19 refs) as a second witness. |

---

## 10. The work-loop problem, quantified

MCP call counts in recent session transcripts (Bash counted in the same files):

| Session | Bash | MCP |
|---|---|---|
| `ae455e5b` (7 MB) | 127 | `memory` 7, `mimir` 9 |
| `a339798c` (8 MB) | 95 | `mimir` 8 |
| `d8ff0c20` (2 MB) | 46 | **none** |
| `1a956ac0` (3 MB) | 51 | **none** |
| `185781cd` (3 MB) | 78 | **none** |

The knowledge layer has been adopted — it was 0 MCP calls everywhere before the evidence
hooks landed. The retrieval layer has not. The evidence above supplies the mechanism:
`codebase-memory` is blind to 40 % of `tools/` and all of the tiktok pipeline, and
`serena`'s reference tool is the one operation a session reaches for first.

---

## 11. Hook layer audit

The hooks are real, not cosmetic: during this audit the guard denied three of the
auditor's own commands live, and the router classified RE prompts correctly.

| Check | Result |
|---|---|
| Inventory lists exactly the 6 configured servers, pins correct | PASS [V] |
| Router: RE prompt → stage; `what time is it` → silent; hand-back → silent | PASS [V] |
| Guard: all 9 documented allow/deny cases | PASS [V] |
| Guard: bypasses | **FAIL** — see below |
| State file shape, 0700/0600, outside repo | PASS [V] |
| Fail-open on malformed input, missing config, `AI4REVERSE_HOOKS=off` | PASS [V] |
| Stop conditions and 1-block cap | PASS, but **trivially satisfiable** |

### Guard bypasses [V, logic-confirmed; not executed]

`node --test a.js examples/anti-analysis.js` (only the first target is checked);
`cat sample.js | node`; `NODE_OPTIONS=--require ./sample.js node …`;
`node --test --test-reporter=./sample.js …`. Also out of scope by wording: `npx tsx`,
`bun`, `deno`. These were reasoned from `.claude/hooks/lib/guards.mjs`, **not run** —
running them would execute the sample the guard exists to stop.

### Guard false blocks [V]

`cd src/tiktok && node scripts/00-recon.mjs` (a legitimate stage) is denied;
`node "$VAR/x.mjs"` is denied (no shell-variable expansion); all out-of-repo utilities
are denied by design.

### Stale advice shipped to every session [V]

The inventory and playbooks actively misdirect work:

1. `docs/MCP-WORKFLOW.md:66` lists `node -e "…"` as **allowed**; the guard denies all
   inline `-e/-p` and `tests/mcp-workflow-hooks.test.js:102` asserts the denial.
2. `workflow.mjs:87` sends the `locate` stage to
   `serena.find_referencing_symbols` — the one tool proven to return `{}` across files.
3. The `codebase-memory` usage note warns only about `src/tiktok`, not about
   `tools/sandbox/env/` (40 % of `tools/`).
4. The `memory` note omits the `$PWD` graph-split: starting from a subdirectory silently
   writes a different `.claude/memory.jsonl`.
5. The `codebase-memory` note omits the receiver rule for `trace_path`.
6. `docs/MCP-WORKFLOW.md:40` says the locate hook matches `Glob`; it has no `Glob` branch.
7. `docs/MCP-WORKFLOW.md:72-74` omits `node_modules/` from reviewed directories.
8. `workflow.mjs:97` claims bare `node` on a sample is denied; `npx tsx`/`bun`/`deno` and
   `cat sample | node` pass.
9. `semble` note omits the required `repo` argument; `mimir` note omits
   snapshot-until-restart.

### Evidence recording can be fooled [V]

- `TEST_PATTERN` is matched against the **raw command string**, so
  `rg "node --test" docs/` sets `testsRun: true` and prints "Tests passed". A grep can
  satisfy the evidence gate.
- A single `mcp__memory__add_observations` sets both `mcpServers.memory` and `evidence`,
  so the Stop gate clears in one call.
- `state.stage` is overwritten per prompt and only the **last** stage is checked, so an
  `analyze` run with no evidence passes if a later `verify`-classified prompt arrives.
- Reported but **not reproduced**: a plain `cp -r .mimir` triggering "Claims ingested"
  (the hook returns `{}` on that input).

---

## 12. Why fixes do not persist

HEAD commit `93cd01b "rm schema"` deleted **24 files / 7 099 lines** — the entire
`src/tiktok/scripts/` pipeline — from git tracking, while leaving the files on disk. It
did not touch `.gitignore`, and its message mentions only a schema.

That commit silently undid the 2026-10-28 fix (`08e029c`) that had made the pipeline
visible to the index. The lesson is structural: **the fix was an environment property
(git tracking), not a code change with a regression test.** Compare
`docs/ACCEPTANCE.md` §14, where every closed blocker carries a test that failed before
the fix.

---

## 13. Remediation

### P0 — do these or the acceptance does not hold

1. **Restore index coverage of the working tree.** Re-track `src/tiktok/scripts/`
   (`git add -f`) or add a same-file negation to `~/.gitignore_global`. Add a regression
   test asserting `git ls-files src/tiktok/scripts | wc -l >= 27`, so the next
   "rm schema" cannot undo it silently. [Fixes the 64 % blind spot.]
2. **Make coverage checking mandatory before conclusions.** Change the `locate` playbook
   to: `index_status` → `check_index_coverage` on the target **file** paths → only then
   `search_graph` / `trace_path`. Any `0` without a coverage check is UNKNOWN. [Neutralises
   all eight silent-failure shapes.]
3. **Stop recommending `find_referencing_symbols` for cross-file work.**
   `workflow.mjs:87` → same-file only; cross-file uses `rg -n` or `trace_path` (with the
   receiver caveat). Remove `safe_delete_symbol` from any automated flow. [Prevents the
   "dead code" conclusion.]
4. **Fix the documented contradictions**: `docs/MCP-WORKFLOW.md:66` (`node -e`),
   `:40` (`Glob`), `:72-74` (`node_modules`), `workflow.mjs:97` (`npx`/`bun`/`deno`).
   [A playbook that is wrong is worse than no playbook.]

### P1 — close the structural gaps

5. **`tools/sandbox/env/`**: rename the directory or accept the exclusion explicitly in
   the usage note. It is 17 709 lines — the layer restore work reads most.
6. **Remove `open-ontologies`** from `.mcp.json`, or keep it only with a note that the
   repository has no RDF and that `.mimir/schema.yaml` is not OWL.
7. **Close the guard bypasses**: check every positional target, treat a pipe into `node`
   as execution, treat `--require`/`--import`/`--test-reporter` values as targets, and
   decide explicitly whether `npx tsx`/`bun`/`deno` are in scope.
8. **Make evidence recording position-aware**: require `pnpm test` / `node --test` at the
   command start, not as a substring anywhere.
9. **mimir staleness**: print a restart reminder after `materialize`, or compare the
   graph hash rather than `schema_hash`.

### P2 — judgement calls

10. Retire the MCP `memory` server, or migrate its content into the file-based
    auto-memory, which already wins on injection and has no schema confusion.
11. Add a score floor and an explicit empty result to `semble`, or stop using it for
    absence questions.
12. Repair provenance: 54 claims point at deleted files; either restore the reports or
    mark the claims stale.

---

## 14. Acceptance decision

**Accepted with conditions.** All six servers connect and several are individually
excellent. The stack does **not** yet deliver the stated goal — deepening understanding
of the reverse-engineering code — because the two retrieval servers with real value
(`codebase-memory`, `serena`) are blind exactly where the work happens, and the
playbook installed to route work to them points at their broken operation.

The single highest-leverage change is P0-1 + P0-2: restore tracking, then make a coverage
check the mandatory first step of every locate. Together they convert eight silent
failure modes into loud ones.

## 15. Not verified

- The dedicated `semble` probe never delivered (cold-start timeout, then a 502 on
  retry). §5 is from the red team's CLI runs only.
- `codebase-memory` and `serena` probes in two subagent sessions could not see the MCP
  tools and drove the servers over CLI/stdio. Answers are the real implementations; the
  *transport* differs.
- The guard bypasses were reasoned from source, not executed (§11).
- No end-to-end run of `pnpm test` was performed for this wave; no source files were
  changed.
- `.mimir` counts drift while a parallel session writes; all numbers are stamped
  13:38 CST.
