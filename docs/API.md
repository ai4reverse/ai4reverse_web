# API cookbook

All modules are ESM. Import the barrel (`tools/index.js`) or a submodule.

## Run a sample

```js
import { TracelessSandbox } from './tools/sandbox/index.js'

const sandbox = await TracelessSandbox.create({
  seed: 0x5eed,                     // deterministic profile/clock/PRNG
  profile: { locale: 'zh-CN', os: 'windows', browser: 'chrome' },
  limits: { timeoutMs: 5000, maxVirtualMs: 60_000, memoryBytes: 64 << 20 },
  env: { strict: true },            // default false: see "Environment subset"
  logLevel: 'warn',
})

const run = await sandbox.run(source, {
  sourceUrl: 'https://cdn.example.test/app.min.js', // stack fidelity + IOCs
  filename: undefined,                              // or an explicit filename
  type: 'script',                                   // 'script' | 'module'
  level: 'statement',                               // off|function|branch|statement
  entry: 'start',                                   // optional global function
  args: [{ host: 'c2.test' }],
  network: { policy: 'deny' },
  hooks: [
    { phase: 'api:before', handler, priority: 100 },  // descriptor form
    ['code:after', handler2],                         // tuple form
  ],
})

console.log(run.ok, run.result, run.limitsHit)
console.log(run.traceStats.byKind)      // {code, api, net, exception, …}
console.log(run.integrity.intrinsicDrift) // prototype tampering by the sample
console.log(run.disposal)                // { ok: true, errors: [] }
console.log(run.settle)                  // event-loop settlement, see below
sandbox.dispose()
```

`run.events` is the structured trace (see `docs/ARCHITECTURE.md`). Set
`keepTrace: false` when you only need statistics.

### Option validation

`profile` and `limits` are validated, not guessed:

```js
try {
  await TracelessSandbox.create({ profile: { browser: 'chromium' } })
} catch (error) {
  error.code        // 'SANDBOX_PROFILE'
  error.message     // profile.browser must be one of chrome, edge, firefox, got "chromium"
  error.details     // { field, value, accepted }
}

try {
  await TracelessSandbox.create({ limits: { maxEvent: 10 } })
} catch (error) {
  error.code        // 'SANDBOX_LIMITS'
  error.message     // unknown limit 'maxEvent'; accepted limits are timeoutMs, …
}
```

`normalizeLimits(input, { strict: false, logger })` keeps the lenient path for
callers that forward foreign option bags and emits one `logger.warn` per ignored
entry. `registerHooks(bus, registrations)` accepts a descriptor
`{phase, handler, priority?}`, a tuple `[phase, handler, options?]`, a list of
either, or a hook set `{registrations}`; a malformed registration throws
`HookError` instead of being skipped.

### `run.disposal` — success and failure shapes

A clean teardown keeps exactly the old shape:

```js
{ ok: true, errors: [] }
```

A failed teardown is additive; it says *what* leaked and *where*. Two shapes:

```js
// (a) a disposal step threw
{
  ok: false,
  errors: [{ stage: 'runtime', message: 'Aborted(Assertion failed: list_empty(…))' }],
  leaked: true,      // true only when the failing step was `runtime`
  stage: 'runtime'   // first failing stage
}

// (b) a stack-limit breach: the runtime was abandoned, never disposed
{
  ok: false,
  errors: [],
  leaked: true,
  stage: 'runtime',
  skipped: true
}
```

A **classified** stack breach always reports the second shape, with
`error.stack === ''` (the frame list depends on recursion depth), whichever
engine shape produced it: `error.name`/`message` keep the engine's wording and
`run.limitsHit` is `['stack']`. If guest code catches the converted overflow the
script itself succeeds, so the run is `ok:true` **and** `limitsHit: ['stack']`.

Stages are the reverse acquisition order: `stack-guard`, `instrumentation`,
`bridge`, `stealth`, `context`, `runtime`, `clock`. `leaked: true` is a statement about the
engine heap, not about the sample's intent; the module is quarantined in both
cases and the next run recompiles it. A `skipped` failure also implies
`leaked: true`.

### `run.settle` — event-loop settlement

```js
{
  jobs: number,                  // promise jobs executed
  timerCallbacks: number,        // timer callbacks invoked
  promiseErrors: number,         // rejected jobs nobody handled
  exhausted: boolean,            // a job/timer cap was hit
  pendingTimers: number,         // timers still scheduled at settle time
  virtualMs: number,             // virtual time consumed by the settle
  limitsHit: string[],           // stack, timeout, virtual-time or memory evidence
  timedOut: boolean,             // host timeout/virtual-time during settlement
  stackExhaustion: boolean,      // explicit engine marker (drives abandonment)
  error: null | { origin: 'timer'|'promise-job', name, message, stack },
}
```

`run.stackExhaustion` mirrors the marker at the top level. Host stack evidence
requires abandonment; otherwise the host-owned interrupt reason determines
`timeout` or `virtual-time`. Intrinsic-shaped `InternalError` values are a
fallback for stack/allocation errors, not an unforgeable allocator witness.
Plain guest errors cannot establish a limit merely by saying "stack overflow",
"interrupted" or "out of memory". Reusing a prototype after catching a genuine
engine error remains a documented limitation; see `docs/SECURITY-MODEL.md`.

`run.timedOut` includes settlement interrupts. Each pending-job batch is bounded
by the remaining `maxJobs`, not just the fixed batch size. Execution counters
measure actual executed jobs; pending work makes `exhausted` true at the cap.

### Concurrency

`run()` is `async` and **queued**: all sandboxes in a process share one QuickJS
WASM module, so one guest run executes at a time. Concurrent calls wait (they are
never rejected) and each still gets a fresh runtime, context, profile and clock.
Do not call `run()` from inside a hook, an env callback or guest code — it would
wait for the run that is holding the queue. Real parallelism needs worker
processes.

## Full analysis (report)

```js
import { analyzeSample } from './tools/analysis/index.js'

const { report, markdown, artifacts, behavior, restoration } = await analyzeSample(source, {
  name: 'loader.js',
  sourceUrl: 'https://cdn.example.test/loader.js',
  seed: 7,
  dynamic: true,
  restore: true,
  runRestored: false,
  network: { policy: 'deny', routes: [{ match: 'api.test', response: { ok: true, status: 200, bodyText: '{}' } }] },
})

console.log(report.verdict)         // {score, level, confidence, reasons}
console.log(report.static.iocs)     // urls, domains, ips, wallets, telegram, …
console.log(report.dynamic.behavior.killChain)
console.log(markdown)               // human-readable report
```

`analyzeSample()` also returns the raw `run` record (`run.disposal`,
`run.settle`, `run.events`, `run.traceStats`); the report itself is normalised
and carries only the observable outcome (`dynamic.ok`, `dynamic.limitsHit`,
`dynamic.error`, `report.integrity`).

Report fields that carry evidence rather than volume (`docs/REPORT-SCHEMA.md`):

| Field | Meaning |
| --- | --- |
| `dynamic.behavior.counts.platform` | Trace events the platform emitted while building the environment. They are excluded from every behaviour counter and from the verdict, so a sample cannot borrow suspicion from the sandbox's setup. |
| `tracing.truncated`, `tracing.truncatedBy` | `true` with `code-budget` and/or `event-limit`; derived from the run record, so it stays true when the `code:trace-truncated` marker was evicted from the retained window. |
| `static.restoration.error` | The restoration pipeline threw; `null` when it ran. Markdown prints `**Restoration error:**`. |
| `hooks.errors`, `hooks.errorsTruncated` | Newest 50 hook failures (`{hook, phase, message}`); the bus itself keeps 200. |

Static-only: pass `dynamic: false`. It never executes the sample.

When restoration changes the source, `runRestored: true` runs a fresh sandbox
with the same explicit run options: entry/args, script/module type, code level,
settlement policy, network/mocks and trace retention. It does not force a
different instrumentation level. The comparison still reports two executions;
it is not an automatic proof of semantic equivalence. If an externally supplied
sandbox has private configuration, supply equivalent explicit options for the
comparison rather than assuming its internals can be cloned.

## Restore code

```js
import { restore, listPasses } from './tools/restore/index.js'

const result = restore(source, {
  maxRounds: 2,
  only: null,                 // ['strings', 'eval-unwrap']
  exclude: ['rename'],
  generateOptions: { comments: true },
  hooks: hookBus,             // optional: ast:transform may rewrite the tree
})
console.log(result.code)
console.log(result.passes.filter((p) => p.changed)) // [{id, changed, notes, durationMs, round}]
console.log(result.stats.beforeHash, result.stats.afterHash)
console.log(result.outputValid, result.outputError, result.notes)
```

Passes share one Babel AST. Never execute restored code as "the sample":
restoration is static evidence; `runRestored` runs it separately for comparison.

### Output validation, `changed` and deferral

```js
import { restore, validateOutput, isDeferredPass, listPasses } from './tools/restore/index.js'

validateOutput('var a = 1')        // true
validateOutput('function (')       // false — strict re-parse, no error recovery
validateOutput(code, { sourceType: 'script', filename: 'a.js' })

const r = restore(source)
r.outputValid   // boolean: did the generated text re-parse?
r.outputError   // null, or { message } — e.g. "Unterminated string constant. (2:10)"
r.notes         // [] normally; on failure: ["output validation failed (…); returned the input source unchanged"]
r.changed       // outputValid && (a pass changed the text || the text differs from the input)
```

- `restore()` **never returns code that does not parse**: on failure it returns
  the input source unchanged, `map: null`, `outputValid: false`.
- `passes[].changed` means the generated text changed; a rewrite that regenerates
  identical text is not a change (that is what makes the pipeline idempotent).
- `meta.deferred` (declared by `rename`) makes a pass run once, in the final
  round; the orchestrator still runs it when the final round is never reached
  (`only: ['rename']`). `isDeferredPass(pass)` is the reader; `listPasses()`
  reports `deferred` per pass and `passes --json` exposes it.
- `validateOutput`'s `sourceType` is advisory: the parser falls back to the other
  source type and accepts a top-level `return` (guest-eval tolerance). Text that
  fails *both* grammars is always rejected, which is the guarantee that matters.

## Hooks

```js
import { createHookBus, createDefaultHooks, registerHooks } from './tools/hook/index.js'

const bus = createHookBus()
registerHooks(bus, createDefaultHooks({ trace }).registrations)
bus.on('api:before', (payload) => {
  if (payload.api === 'navigator.sendBeacon') return { block: true } // traceless mock
}, { priority: 100, owner: 'my-plugin', traceless: { preservesIdentity: true } })
```

Phases (21, `HOOK_PHASES`): `code:before|after|error|step`,
`api:before|after|error`, `exception:throw|catch|uncaught`,
`ast:enter|exit|node|transform`, `jsvmp:enter|opcode|step|exit`,
`lifecycle:init|run|dispose`. `code:step` is dispatchable but never traced (the
per-statement probe already emits a `code` event). A hook trace event uses trace
phase `emit` (or `transform` for the mutating pipeline) and carries the hook
phase in `hook`. Throwing handlers are isolated: the bus keeps the newest 200
failures capped at 64 KiB of text and reports `errorsTruncated`.

## Instrumentation directly

```js
import { createInstrumentation, analyzeSource } from './tools/instrumentation/index.js'

const facts = analyzeSource(source) // Babel-only, no execution
console.log(facts.facts.obfuscation, facts.facts.techniques)
```

The sandbox composes instrumentation for you; use the module directly only when
embedding the instrumenter in another runtime.

## Taint analysis (Circle-IR)

```js
import { analyzeTaint, renderTaintReport } from 'ai4reverse-web/taint'

const taint = await analyzeTaint(source, { filename: 'loader.js' })
console.log(taint.sources, taint.sinks, taint.sanitizers, taint.flows)
console.log(renderTaintReport(taint))
```

The root and `/analysis` barrels expose the same API and `TAINT_LIMITS`.
`analyzeSample()` enables it by default: raw evidence is `result.taint`,
normalized evidence is `report.static.taint`, and Markdown includes the section.
`taint:false` disables it; an object configures its worker, patterns and limits.
The standalone CLI is `taint <file> [--json] [--out <path>] [--timeout <ms>]`.
`--taint-config '<JSON>'` adds patterns for `taint` or `analyze`;
`analyze --no-taint` disables this stage.

It parses only original source bytes, never executes the sample or follows its
imports/URLs. Syntax recovery, timeouts and engine failures are explicit failed
reports. All evidence is bounded; an empty flow list is not proof of safety.
See [TAINT.md](TAINT.md) for the full options, patterns, schema and limitations.

## Constraint solving

```js
import {
  analyzeConstraints, collectPathConditions, solveConstraints, provePredicate,
  proveEquivalent, simplifyExpression,
} from './tools/constraint/index.js'

// Static evidence about branch conditions (never executes the sample).
const report = await analyzeConstraints(source, { filename: 'loader.js' })
console.log(report.stats.opaque, report.opaquePredicates)
const paths = collectPathConditions(source) // syntactic path conditions, no solver
console.log(report.unreachableBranches, report.simplifications)
console.log(report.truncated, report.assumptions)

// A model for a conjunction.
const sat = await solveConstraints(['x * 2 === 42'])       // {status:'sat', model:{x:21}}
const unsat = await solveConstraints(['x > 10', 'x < 5']) // {status:'unsat'}

// Validity and counterexamples.
await provePredicate('(x & 1) === 0 || (x & 1) === 1')    // always-true, no assumptions
await provePredicate('x + 1 > x')                         // contingent (NaN/Infinity/precision)
await provePredicate('x + 1 > x', { assumeIntegers: true }) // always-true, ['integers']
await proveEquivalent('x + y', 'y + x', { assumeIntegers: true })
await simplifyExpression('(x & 1) === 0 || (x & 1) === 1') // SMT normal form + verification
```

The default domain is the exact JS fragment (bitwise through 32-bit vectors,
boolean structure, `typeof`, exact comparisons). Integer arithmetic is an
explicit `assumeIntegers` assumption and is reported on every finding.
`unknown` is a normal solver answer and is never treated as a proof. See
`docs/CONSTRAINT.md` for the full soundness model, budgets and limits.

`analyzeSample()` runs this component unless `constraints: false`; the result is
`report.static.constraint` (plus `result.constraint`) and a
`## Constraint solving` Markdown section.

## JSVMP

```js
import { buildVM, buildSampleProgram, analyzeVM, summarizeVM } from './tools/jsvmp/index.js'
import { TracelessSandbox } from './tools/sandbox/index.js'

const vmName = 'exampleVm'
const vm = buildVM(buildSampleProgram(), { seed: 3, name: vmName, obfuscate: true })
const sandbox = await TracelessSandbox.create({ logLevel: 'silent' })
try {
  const run = await sandbox.run(vm.code, { entry: vmName })
  if (!run.ok) throw new Error(run.error?.message ?? 'VM execution failed')
  console.log(run.result.value) // "fib(10)=55 via VM"
} finally {
  sandbox.dispose()
}
const analysis = analyzeVM(vm.code)
console.log(summarizeVM(analysis).dispatch) // cases, opcodes, loop type
```

The artifact's `run({ trust: 'host' })` convenience method executes in the host
process and is only for explicitly trusted, platform-originated programs. It
rejects calls without that acknowledgement; sample-derived artifacts should use
the sandbox path above.

Inside a sandbox, setting `instrumentation: { jsvmp: true }` traces the dispatch
loop at opcode level; `run.vm` and `run.events` (`event: 'jsvmp:opcode'`) carry
the virtual program.

## Logging

```js
import { createLogger, createMemoryDestination, createEventSink, scopeLogger } from './tools/logging/logger.js'
// `scopeLogger` is also exported from the entry barrel (tools/index.js).

const destination = createMemoryDestination()
const logger = createLogger({ level: 'debug', destination })
const sink = createEventSink({ logger, level: 'trace' })
scopeLogger(logger, { runId: 'run-1' }).info({ bytes: 1024 }, 'started')
```

pino-pretty is used automatically on a TTY (or `--pretty` in the CLI).

## CLI

```
node tools/cli.js analyze <file> [options]
node tools/cli.js restore <file> [options] [--passes a,b] [--exclude c] [--rounds n]
node tools/cli.js run <file> [--json|--out path] [--events]
node tools/cli.js constraint <file> [--json|--out path] [--timeout ms]
                                  [--assume-integers|--assume-int32]
node tools/cli.js taint <file> [--json|--out path] [--timeout ms]
                               [--taint-config JSON]
node tools/cli.js passes [--json]
node tools/cli.js version

shared options (parsed by one strict parser for analyze/restore/run):
  --json | --out <path|-> | --seed N | --timeout ms | --virtual-ms ms
  --level off|function|branch|statement | --no-dynamic | --no-restore
  --run-restored | --source-url url | --entry fn | --arg JSON|string
  --profile JSON | --mocks JSON | --log-level L | --pretty
  --no-taint | --taint-config JSON (analyze)
```

`restore` therefore accepts `--json`, `--seed`, `--out` and `--level` too
(`--pretty` and `--log-level` apply to its own logging).

Exit codes: `0` success, `1` analysis/run failure, `2` usage error.

### CLI contract (strict validation)

| Invocation | Exit | stderr | stdout |
| --- | --- | --- | --- |
| valid `analyze`/`restore`/`run`/`constraint`/`taint`/`passes`/`version`/`--help` | 0 | empty (logs only with `--log-level`) | result (pure JSON with `--json`) |
| unknown option (`--nonsense`) | 2 | `error: invalid arguments: Unknown option '--nonsense'. …` | empty |
| `--seed zzz` / `--seed 0xzz` | 2 | `error: --seed must be a decimal or 0x-prefixed hex integer, got "zzz"` | empty |
| `--rounds 0`, `--rounds 6`, `--rounds 2.5` | 2 | `error: --rounds must be an integer between 1 and 5, got "0"` | empty |
| `--level bogus` | 2 | `error: --level must be one of off\|function\|branch\|statement, got "bogus"` | empty |
| unknown `--passes`/`--exclude` id | 2 | `error: unknown pass id for --passes: bogus (valid: strings, …)` | empty |
| unreadable input / empty file | 2 | `error: cannot read <path>: ENOENT` / `error: <path> is empty` | empty |
| `--out` write failure (EACCES/ENOENT/ENOTDIR/EPERM) | 2 | `error: cannot write <path>: ENOENT` | empty |
| `--events --json` | 2 | `error: --events and --json are mutually exclusive` | empty |
| analysis/run failure (`--entry` missing, sample throws) | 1 | diagnosis | JSON result |
| `--out -` | 0 | empty | result |
| `--out <file>` | 0 | `wrote N bytes to <file>` | empty |

`--arg <value>` is repeatable and is parsed as JSON when the value is valid JSON
(so `--arg 42` is a number and `{"a":1}` is an object) and passed as a string
otherwise (`--arg hello`).

### Serialization note

- `run.events`, `run.settle`, `run.disposal` and the whole report are plain
  JSON. Trace payloads are sanitised (strings 2 048 chars, arrays 100 items,
  depth 5, handles → `'[Handle]'`), so `JSON.stringify(report)` always works.
- Host timing (`wall`, `startedAt`, `durationMs`) is the only non-deterministic
  field; strip it before comparing two runs.
- `restore().code` has **no trailing newline**. Redirecting stdout (`> out.js`)
  appends one, so re-restoring that file reports `changed: true` with zero
  changed passes. Use `--out <file>` for a byte-exact round trip.

### Subpath imports and types

Every subpath is importable on its own and ships declarations:

```js
import { restore, validateOutput } from 'ai4reverse-web/restore'
import { TracelessSandbox } from 'ai4reverse-web/sandbox'
import { createHookBus } from 'ai4reverse-web/hook'
import { analyzeSample } from 'ai4reverse-web/analysis'
import { createLogger, scopeLogger } from 'ai4reverse-web/logging'
import { analyzeConstraints, solveConstraints } from 'ai4reverse-web/constraint'
```

`package.json` maps `.`, `./sandbox`, `./instrumentation`, `./hook`, `./restore`,
`./analysis`, `./jsvmp`, `./constraint`, `./taint`, `./logging`, `./invocation`,
`./util`, `./cli` to `tools/**` with a matching `types/*.d.ts`. The entry barrel
exports 78 names; `validateOutput` and `isDeferredPass` are on `./restore` only.
