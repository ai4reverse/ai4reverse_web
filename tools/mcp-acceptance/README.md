# MCP acceptance gate

A re-runnable gate that answers one question with numbers: **does the retrieval
layer see the code that reverse-engineering work actually touches?**

It is not a report generator. Every question it asks has an answer that `rg` can
compute independently, so each score is checkable by someone who distrusts the
gate itself.

## Why the layout is `tools/mcp-acceptance/` and not `scripts/mcp-acceptance/`

The project's execution guard only trusts `tools/`, `tests/`, `node_modules/`,
`.claude/hooks/` and `src/<target>/scripts/`. A harness placed under a top-level
`scripts/` is refused by that guard before it can run. That is a real finding,
recorded as F-0 in the acceptance conclusion; moving the harness under `tools/`
is the workaround, not a preference.

## Pipeline

```bash
# 1. Classify every file into one of five strata, from git + the index DB.
node tools/mcp-acceptance/strata.mjs \
  --repo "$PWD" --out /tmp/strata.json

# 2. Sample symbols per stratum and derive their answers with rg --no-ignore.
node tools/mcp-acceptance/gold.mjs \
  --repo "$PWD" --strata /tmp/strata.json --out /tmp/gold.jsonl

# 3. Score each adapter against the oracle, per stratum, with intervals.
node tools/mcp-acceptance/run.mjs \
  --repo "$PWD" --gold /tmp/gold.jsonl --out /tmp/results.json

# 4. Mutate a throwaway repo and check the index follows it.
node tools/mcp-acceptance/fault-inject.mjs --wait 9000
```

`THRESHOLDS.md` holds the pre-registered gates. Read it before reading any
number: the verdict is whatever those thresholds say, not whatever the table
looks like.

## Requirements

- `node` 24+, `rg`, `git`, `sqlite3`.
- The `codebase-memory` CLI (resolved from the npx cache; override with an
  `existsSync`-checked path in `run.mjs` if it moves).
- **Write access to `~/.cache/codebase-memory-mcp`.** Inside the sandbox that
  directory is read-only and every CLI call fails with
  `could not load saved runtime settings`. Run the harness with the sandbox
  disabled, or the adapter reports UNAVAILABLE — which is itself a valid,
  honest result.

## Strata

| Stratum | Derived from |
|---|---|
| `indexed` | present in the index database's `file_hashes` |
| `parse_partial` | `index_coverage.kind = parse_partial` |
| `excluded-subtree` | under a directory listed as `not_indexed_dir` |
| `gitignore` | ignored by git, and recorded as `not_indexed_file` |
| `untracked` | on disk, in neither |
| `other` | anything the walk could not attribute |

## Interpretations the gate refuses to make

- A `0` from any adapter is **UNKNOWN**, never "absent".
- `foundAny` is not recall. Both are reported; a high `foundAny` with low
  `meanRecall` means the tool finds one file and stops.
- The receiver invariant attributes call sites by co-location (`new C(` /
  `C.create(` in the same file), not by type inference. A PASS is therefore
  strong; a FAIL is conservative.

## Known limits

- The gold corpus is restricted to `tools/` and `src/` on purpose: excluded
  subtrees also contain agent state and build output, which would make the
  sample measure the wrong thing.
- Only `rg` and `codebase-memory` adapters are implemented. `serena` and
  `semble` need a running MCP server; in the 2026-10-29 session both were
  unavailable, and the gate reports unavailable rather than guessing.
