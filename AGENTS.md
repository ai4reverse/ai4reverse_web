# Repository Guidelines

## Project Structure & Module Organization

This is an ESM Node.js package for traceless malicious-JavaScript analysis.

- `tools/` contains the implementation. `tools/index.js` is the package entry point; subsystem exports live under `tools/sandbox/`, `tools/instrumentation/`, `tools/restore/`, `tools/analysis/`, and `tools/jsvmp/`.
- `types/` contains public `.d.ts` declarations.
- `tests/` contains `node:test` suites and shared helpers in `tests/helpers/`.
- `examples/` contains runnable samples and contract fixtures. `docs/` documents architecture, contracts, reporting, verification, and security.

## Build, Test, and Development Commands

Use Node.js 24.18 or newer and pnpm.

```bash
pnpm install                    # Install dependencies
pnpm test                       # Run the full serial suite
pnpm test:watch                 # Re-run tests during development
node tools/cli.js analyze examples/sample-loader.js
node tools/cli.js restore examples/sample-loader.js
node tools/cli.js run examples/sample-loader.js --events
pnpm build:sdk                  # Rebuild the national SDK examples
```

There is no compile step for the package itself; ESM files under `tools/` are published directly. Generated SDK output is ignored.

## Coding Style & Naming Conventions

- Follow existing ESM style: two-space indentation, single quotes, no semicolons, and concise JSDoc on public functions.
- Use kebab-case filenames, `camelCase` functions and variables, `PascalCase` classes, and `SCREAMING_SNAKE_CASE` constants.
- Export public APIs through the relevant `tools/*/index.js`; keep `package.json` exports and `types/` declarations aligned.
- No linter or formatter is configured. Match nearby code and order imports from Node built-ins to internal modules.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name suites `<area>.test.js`, such as `restore-pipeline.test.js`, and use descriptive `test('...')` names. Run one file with `node --test tests/report.test.js`; run `pnpm test` before submitting. No coverage threshold is enforced, but bug fixes and features should add regression tests, particularly for determinism, sandbox isolation, and restored-code equivalence.

## Commit & Pull Request Guidelines

Use Conventional Commits with a subsystem scope: `feat(jsvmp): ...`, `fix(sandbox): ...`, `test(restore): ...`, or `refactor(cli): ...`. Write summaries in the imperative mood.

No pull-request template is configured. Include a focused summary, linked issue when applicable, test results, and risks. Update related tests, declarations, docs, and examples with behavior or public-surface changes; include representative CLI or report output for user-visible changes.

## Security & Configuration Tips

Run untrusted samples only through `TracelessSandbox`, the CLI, or API entry points—never directly with Node.js. Preserve the sandbox's lack of host filesystem, process, and network access; network behavior must remain mocked. Seeded PRNGs and virtual time support reproducible runs. Consult `docs/SECURITY-MODEL.md`, `docs/CONTRACTS.md`, and `docs/ARCHITECTURE.md` before changing sandbox or instrumentation behavior.
