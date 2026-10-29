# MCP workflow hooks

The six servers in `.mcp.json` are not a menu. Project hooks attach each one to
a specific step of the reverse-engineering workflow, at the moment that step
starts, so a session cannot quietly fall back to hand-rolled search or bare
`node` execution.

This is deliberately not another context injection. The hooks do three things a
SessionStart reminder cannot:

1. **Route** a request to a stage playbook (`UserPromptSubmit`).
2. **Nudge at the tool call** where the wrong action is about to happen
   (`PreToolUse` / `PostToolUse`).
3. **Enforce** the two rules that must not be ignored: untrusted samples never
   run under bare node, and a session that changed source or ran analysis must
   settle its evidence before it ends.

## Stage map

| Stage | Primary MCP | Trigger | What the hook says |
|---|---|---|---|
| intake | memory, mimir-ontology | `UserPromptSubmit` | Look up prior Sample/Finding first; hash the sample; never persist bytes |
| locate | codebase-memory, serena, semble | `PreToolUse` search/edit | Graph and symbol lookups before grep; `not_indexed` is not absence |
| restore | serena | `UserPromptSubmit`, `PreToolUse` edit | Symbol-level edits; restoration is static; equivalence by seeded rerun |
| analyze | codebase-memory, mimir-ontology | `PreToolUse` Bash (deny), `PostToolUse` Bash | CLI/sandbox only; emit the Finding/Artifact claim template |
| verify | memory, mimir-ontology | `Stop` | Normalise host measurements; a finding is verified only after a byte-identical rerun |
| ontology | open-ontologies | `PostToolUse` edit | RDF/OWL/SPARQL only; `.mimir/schema.yaml` belongs to `mimir ingest` |

`semble` is recommended where names are unknown: in the locate playbook and
when a grep returns nothing. `open-ontologies` only fires for RDF/OWL/SPARQL
files; the repository has none today, which is why the ontology stage is mostly
prompt-driven.

## Hook inventory

| File | Event | Matcher | Behaviour |
|---|---|---|---|
| `inject-mcp-inventory.mjs` | `SessionStart` | — | Lists every configured server with its usage note |
| `re-workflow-router.mjs` | `UserPromptSubmit` | — | Injects the stage playbook; silent for non-RE prompts and agent hand-backs |
| `mcp-locate-first.mjs` | `PreToolUse` | `Grep\|Glob\|Bash\|Edit\|Write\|MultiEdit` | Locate/edit nudge, capped at 2 searches + 3 edits per session |
| `guard-sample-execution.mjs` | `PreToolUse` | `Bash` | **Denies** running a non-harness script with bare `node` |
| `record-mcp-usage.mjs` | `PostToolUse` | `mcp__.*` | Records which configured servers were used |
| `record-analysis-evidence.mjs` | `PostToolUse` | `Bash\|Grep\|Glob\|Edit\|Write\|MultiEdit` | Prints claim templates, marks tests/edits/ingest, suggests semble on an empty search |
| `settle-before-stop.mjs` | `Stop` | — | Blocks once if source edits were untested, no configured MCP was used, or an analysis ran without evidence |

All hooks exit 0 on every path. A broken hook must never block a session; a
failure is logged on stderr and the hook passes.

## The execution guard

`guard-sample-execution.mjs` refuses commands such as:

```bash
node examples/anti-analysis.js
node src/shein/sig-main.raw.js
bash -c 'node examples/anti-analysis.js'
```

and allows the sanctioned paths:

```bash
node tools/cli.js analyze examples/sample-loader.js
node examples/restore-demo.mjs          # harness: imports ../tools/
node src/tiktok/scripts/00-recon.mjs    # pipeline stage
node --test tests/report.test.js
```

A script may run on the host only when it is trusted by **path**, never by its
content or extension:

- reviewed directories: `tools/`, `tests/`, `.claude/hooks/`,
  `src/<target>/scripts/`;
- an explicit allowlist of runnable harnesses in
  `.claude/hooks/lib/guards.mjs` (`examples/*-demo.mjs`, the `national-sdk`
  build/verify/demo scripts, and the sample builders).

Content sniffing was removed on purpose: a malicious sample can write a
shebang or an `import '../tools/index.js'` line and certify itself. Extension
is ignored for the same reason: `node foo` and `node foo.ts` are as executable
as `node foo.js`. Paths are canonicalised with `realpath` before the prefix
check, and targets outside the repository or bare package specifiers are
refused.

Node code-loading options are treated as execution targets too: `-r/--require`,
`--import`, `--loader/--experimental-loader` (including the `--flag=value`
form), and `node -` all go through the same path check. Inline `-e`/`-p` is
refused outright — a regex cannot prove inline code does not read and evaluate
a sample; put the utility in a reviewed harness instead. A compound command
that changes directory (`cd`, `pushd`, `env -C`) is refused when it also runs
node, because the effective working directory cannot be established. `data:`,
`http(s):` and `file:` module specifiers are refused.

This is defence in depth for operator mistakes, not a sandbox: anyone who can
write to a trusted path can still evade it. The real boundary remains
`TracelessSandbox`.

## Session state

Hooks communicate through one JSON file per session:

```
$AI4REVERSE_HOOK_STATE_DIR (default: <os.tmpdir()>/ai4reverse-hook-state)/<session-hash>.json
```

```json
{
  "stage": "analyze",
  "mcpServers": { "memory": 2, "mimir-ontology": 1 },
  "edits": ["tools/restore/index.js"],
  "testsRun": true,
  "analysisRuns": 1,
  "evidence": true,
  "nudges": { "search:0": true },
  "stopBlocks": 1,
  "updatedAt": "2026-10-29T00:00:00.000Z"
}
```

Only paths and counters are stored — never tool output, sample bytes, or
secrets. Updates use a temp file plus `rename`. The directory lives outside the
repository and is never committed.

## Disabling and debugging

- `AI4REVERSE_HOOKS=off` turns all project hooks into a no-op for one session.
- Run a hook by hand to see its output:

  ```bash
  printf '%s' '{"prompt":"帮我还原这个 JSVMP 样本","session_id":"smoke"}' \
    | node .claude/hooks/re-workflow-router.mjs
  ```

- Settings changes need a new session (or a hook reload) before they take
  effect.

## Adding a server

1. Add it to `.mcp.json`.
2. Add a usage note to `USAGE` in `.claude/hooks/lib/mcp-config.mjs`; an
   undocumented server is still listed, with a generic note.
3. If it belongs to a workflow stage, add it to the relevant playbook in
   `.claude/hooks/lib/workflow.mjs`.
4. If it has a moment-of-need trigger, extend `record-analysis-evidence.mjs` or
   `mcp-locate-first.mjs` and add a test.

## Known limits

- Hooks never call an MCP server directly. They are synchronous, have a 10 s
  timeout, and `uvx` cold starts have already produced a 30 s `CONNECT_TIMEOUT`;
  a stdio JSON-RPC client inside a hook would stall the session. The model runs
  the templated call instead.
- `mimir-ontology` is read-only. Evidence is written by generating JSONL claims
  and running `uvx --from mimir-ontology==0.3.2 mimir ingest <claims>.jsonl
  --dir .mimir`, then `... mimir materialize --dir .mimir`.
- The Stop check is capped at one block per session and is skipped whenever
  `stop_hook_active` is set, so it cannot loop.
- `mimir-ontology` serves the materialized graph it loaded when the MCP server
  started. After `mimir ingest` + `mimir materialize`, the MCP view keeps the old
  snapshot until the session restarts; the cached `mimir` CLI (`search`, `show`,
  `query`) reads the new graph immediately.
- A piping command hides its exit code (`... | tail` exits 0 after a failure),
  so the evidence hook also treats `error:`/`Traceback`/`could not` on stderr as
  failure and refuses to mark the evidence as recorded.
