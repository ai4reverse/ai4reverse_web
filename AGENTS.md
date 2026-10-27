# Repository Guidelines

## Project Structure & Module Organization

This is an ESM package for traceless malicious-JavaScript analysis.

- `tools/` is the implementation; `tools/index.js` is the entry point, with subsystems under `tools/{sandbox,instrumentation,restore,analysis,jsvmp,constraint,taint}/`.
- `types/` defines public contracts; `tests/` has `node:test` suites, helpers, and fixtures; `examples/` has runnable samples.
- `docs/` covers architecture, contracts, security, and verification; `src/shein/` holds captures and scripts; never commit secrets or sensitive samples.

## Reverse-Engineering Workflow

Treat this package as the first reverse-engineering toolkit. Before writing ad-hoc code, inspect `tools/index.js` and the package exports, then reuse the library:

- Use `restore`/Babel passes for obfuscated source, `analyze` for the full pipeline, and `TracelessSandbox` for execution.
- Use `jsvmp`, `constraint`, and `taint` for VM, predicate, and data-flow work; extend existing modules instead of duplicating logic.

## MCP-Assisted Workflow

Use `.mcp.json` servers in every nontrivial task:

- Start by querying `codebase-memory` and `memory`; record verified decisions afterward.
- Use `serena` for symbols, references, and edits, and `semble` for semantic search; confirm both with source or `rg`.
- Record evidence-backed hypotheses in `mimir-ontology` (`.mimir/`); validate schemas with `open-ontologies`.
- Verify MCP output; never persist secrets, raw malicious samples, or unverified claims.

## Build, Test, and Development Commands

Use Node.js 24.18+ and pnpm.

```bash
pnpm install
pnpm test
pnpm test:types
node tools/cli.js analyze examples/sample-loader.js
node tools/cli.js restore examples/sample-loader.js
node tools/cli.js run examples/sample-loader.js --events
pnpm build:sdk
```

## Coding Style & Naming Conventions

- Match nearby code: two-space indentation, single quotes, no semicolons, JSDoc on public APIs.
- Use kebab-case filenames, `camelCase` functions/variables, `PascalCase` classes, `SCREAMING_SNAKE_CASE` constants.
- Export APIs through `tools/*/index.js`; align `package.json`, types, and docs. No linter/formatter is configured.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name suites `<area>.test.js` and tests descriptively. Run one file with `node --test tests/report.test.js`, then `pnpm test` before submitting. No coverage threshold exists, but add regression tests for determinism, sandbox isolation, tracelessness, and restored-code equivalence.

## Commit & Pull Request Guidelines

Use Conventional Commits with a subsystem scope (`feat(jsvmp): ...`, `fix(sandbox): ...`) and imperative summaries. No PR template exists. Include a summary, linked issue when applicable, test results, and risks. Update tests, types, docs, and examples for public behavior changes; include CLI/report output when relevant.

## Security & Configuration Tips

Run untrusted samples only through `TracelessSandbox`, the CLI, or public APIs—never directly with Node.js. Preserve blocked filesystem/process/network access and mocked networking. Seeded randomness/time support reproducibility. Consult the security, contract, and architecture docs before sandbox/instrumentation changes.
