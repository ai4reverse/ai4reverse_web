# Pre-registered gate thresholds

These thresholds were fixed **before** they were used to judge anything. The
first gate run produced the baseline numbers recorded in `results.json`; from
that point the thresholds are what make a later run fail. Writing them first is
the whole point — the previous acceptance waves "confirmed" the same false
defect six times because the conclusion was chosen after the observation.

## Metrics the gate reports

| Metric | Meaning |
|---|---|
| `foundAny` | share of questions where the adapter returned at least one oracle file |
| `meanRecall` | average of `|returned ∩ oracle| / |oracle|` |
| `falseEmpty` | share of questions where the oracle has files and the adapter returned **none** |
| `receiverInvariant` | whether `trace_path` resolves a method that is called through a variable |

All proportions carry a 95 % Wilson interval and the sample size `n`. A point
estimate without its interval is not reportable.

## Gates

**G1 — indexed-stratum recall.** `meanRecall(indexed) ≥ 0.30`.
Below this, the retriever may not be used as a primary symbol search; it may
only be used after `rg` has already narrowed the file set.

**G2 — blind-stratum silent emptiness.** `falseEmpty(excluded-subtree) == 0` and
`falseEmpty(gitignore) == 0`.
This is deliberately absolute rather than a ratio. A single confident "no such
symbol" on a file the index cannot see is enough to send an analysis down the
wrong path, so the only acceptable rate is zero. Any non-zero value makes a
coverage check (`check_index_coverage` on the exact file path) mandatory before
acting on an empty result.

**G3 — receiver invariant.** `graphCallers ≥ attributableSites` → PASS.
FAIL means the call graph under-reports instance-method calls, and `trace_path`
must not be used to conclude "no callers".

**G4 — reproducibility.** Two runs against the same index generation must
produce identical `results.json` numbers. If they differ, the gate is invalid
and no verdict from it may be used.

## Decision rule

| Observation | Decision |
|---|---|
| G1 pass and G2 pass and G3 pass | the retriever may be a primary search surface |
| G1 pass, G2 fail | keep it, but a coverage check is mandatory before any "absent" conclusion |
| G1 fail | demote to a hint source; `rg` stays primary |
| G3 fail | `trace_path` is a hint, never evidence |

## Baseline (first run, 2026-10-29)

| Adapter | Stratum | n | foundAny | meanRecall | falseEmpty |
|---|---|---|---|---|---|
| rg | all | 14 each | 100 % | 1.00 | 0 % |
| codebase-memory | indexed | 14 | 100 % [78–100] | 0.37 | 0 % [0–22] |
| codebase-memory | excluded-subtree | 14 | 7 % [1–31] | 0.03 | **93 % [69–99]** |
| codebase-memory | gitignore | 14 | 29 % [12–55] | 0.09 | **71 % [45–88]** |

`receiverInvariant`: **FAIL** — `TracelessSandbox.run`, reachable from 72 files
that construct the class, with 547 co-located `.run(` call sites, resolved to
**0** callers.

Verdict under the rule above: **G1 pass, G2 fail, G3 fail** → `codebase-memory`
and `trace_path` are hint sources only; `rg` remains primary; a coverage check is
mandatory.
