# MCP retrieval gate — conclusion

Companion to [`MCP-ACCEPTANCE-2026-10-29.md`](./MCP-ACCEPTANCE-2026-10-29.md),
which recorded *what was observed*. This file records *what the gate decides*,
and is limited to the three questions the gate exists to answer.

Instrument: [`tools/mcp-acceptance/`](../tools/mcp-acceptance/README.md).
Thresholds: [`THRESHOLDS.md`](../tools/mcp-acceptance/THRESHOLDS.md) (written
before the numbers were read).

## What the gate measured

42 questions, 14 per stratum, answers derived by `rg --no-ignore` over the whole
disk. Adapter: `codebase-memory search_code` over the indexed corpus.

| Stratum | n | foundAny | meanRecall | **falseEmpty** |
|---|---|---|---|---|
| indexed | 14 | 100 % [78–100] | 0.37 | 0 % [0–22] |
| excluded-subtree | 14 | 7 % [1–31] | 0.03 | **93 % [69–99]** |
| gitignore | 14 | 29 % [12–55] | 0.09 | **71 % [45–88]** |

Receiver invariant: **FAIL** — `TracelessSandbox.run`, reachable from 72 files
that construct the class with 547 co-located call sites, resolves to **0**
callers.

Fault injection: **DETECTED** — a symbol added and a file removed in a throwaway
git repo were both reflected within 9 s. The index does follow a working tree;
staleness is not a general property of the server, only of the projection path.
Reproducibility: two consecutive runs produced byte-identical metric blocks.

## 1. Which may be the primary retrieval

**`rg` is the primary retrieval. `codebase-memory` is a hint source.**

G1 passes (recall 0.37 on the indexed stratum clears the 0.30 floor), so the
server is not useless — it finds *a* file for every indexed question. But recall
0.37 means it returns roughly one third of the referencing files, and on the two
strata where the reverse-engineering work actually lives it returns nothing at
all in 71–93 % of cases.

The rule that follows from G2: **before any "this symbol does not exist"
conclusion, call `check_index_coverage` on the exact file path.** A `0` without
that check is UNKNOWN. This is not a style preference; it is the difference
between a 7 % hit rate and a 100 % one.

## 2. Which must be removed

Nothing in this gate's scope, and that is a deliberate change from the previous
wave.

`open-ontologies` was recommended for removal there on the grounds that the
repository has no RDF. That verdict stands on its own evidence, but it is not a
retrieval question and the gate cannot test it — 119 tools still cost context on
every turn while nothing in `tools/` or `src/` produces or consumes OWL.

What the gate *does* justify removing is narrower: **`trace_path` must not be
used to conclude "no callers."** It stays available, demoted to a hint, because
the same tool answers static-receiver questions correctly (`TracelessSandbox.create`
→ 36 callers). The removal is of the inference, not the tool — G3 fails, so the
decision rule says "hint, never evidence".

## 3. Which invariant fires next

**G2 fires on the next index rebuild**, and it will fire loudly:

`index_coverage` currently records 18 excluded directories and 47 gitignored
files. Any commit that tracks or untracks files under `src/tiktok/scripts/`
changes the `gitignore` stratum's membership, and the gate's `falseEmpty` on that
stratum moves with it. That is why the thresholds are absolute: they are
designed to fail when the tree moves, not to pass forever.

**G3 fires on the next `codebase-memory` upgrade** that changes receiver
resolution. It is currently pinned at `0.12.1`; a version bump that adds type
inference turns G3 green, and one that changes qualified-name rules turns it
into an ERROR rather than a silent pass — both are visible.

## What would make this wrong

- The gold corpus is restricted to `tools/` and `src/`. A different prefix
  restriction would change the strata proportions, though not the direction.
- The receiver invariant attributes call sites by co-location, not by type
  inference. A FAIL is conservative; a PASS would be strong, but none was
  produced.
- `serena` and `semble` could not run in this environment, so the gate says
  nothing about them. That is a gap, not a clean bill.

## F-0 — the gate cannot live where the specification put it

The specified path `scripts/mcp-acceptance/` is refused by the project's own
execution guard, whose allowlist is `tools/`, `tests/`, `node_modules/`,
`.claude/hooks/` and `src/<target>/scripts/`. The harness therefore lives under
`tools/mcp-acceptance/`. Recorded here because it is the same class of defect the
gate exists to find: a rule that silently prevents the sanctioned action.
