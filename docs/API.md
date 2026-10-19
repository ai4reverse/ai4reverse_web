# API cookbook

All modules are ESM. Import the barrel (`tools/index.js`) or a submodule.

## Run a sample

```js
import { TracelessSandbox } from './tools/sandbox/index.js'

const sandbox = await TracelessSandbox.create({
  seed: 0x5eed,                     // deterministic profile/clock/PRNG
  profile: { locale: 'zh-CN', os: 'windows', browser: 'chrome' },
  limits: { timeoutMs: 5000, maxVirtualMs: 60_000, memoryBytes: 64 << 20 },
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
  hooks: [/* { phase, handler, priority } */],
})

console.log(run.ok, run.result, run.limitsHit)
console.log(run.traceStats.byKind)      // {code, api, net, exception, …}
console.log(run.integrity.intrinsicDrift) // prototype tampering by the sample
console.log(run.disposal)                // { ok: true, errors: [] }
sandbox.dispose()
```

`run.events` is the structured trace (see `docs/ARCHITECTURE.md`). Set
`keepTrace: false` when you only need statistics.

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

Static-only: pass `dynamic: false`. It never executes the sample.

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
console.log(result.passes.filter((p) => p.changed)) // [{id, changed, notes, durationMs}]
console.log(result.stats.beforeHash, result.stats.afterHash)
```

Passes share one Babel AST. Never execute restored code as "the sample":
restoration is static evidence; `runRestored` runs it separately for comparison.

## Hooks

```js
import { createHookBus, createDefaultHooks, registerHooks } from './tools/hook/index.js'

const bus = createHookBus()
registerHooks(bus, createDefaultHooks({ trace }).registrations)
bus.on('api:before', (payload) => {
  if (payload.api === 'navigator.sendBeacon') return { block: true } // traceless mock
}, { priority: 100, owner: 'my-plugin', traceless: { preservesIdentity: true } })
```

Phases: `code:before|after|error`, `api:before|after|error`,
`exception:throw|catch|uncaught`, `ast:enter|exit|node|transform`,
`jsvmp:enter|opcode|step|exit`, `lifecycle:*`.

## Instrumentation directly

```js
import { createInstrumentation, analyzeSource } from './tools/instrumentation/index.js'

const facts = analyzeSource(source) // Babel-only, no execution
console.log(facts.facts.obfuscation, facts.facts.techniques)
```

The sandbox composes instrumentation for you; use the module directly only when
embedding the instrumenter in another runtime.

## JSVMP

```js
import { buildVM, buildSampleProgram, analyzeVM, summarizeVM } from './tools/jsvmp/index.js'

const vm = buildVM(buildSampleProgram(), { seed: 3, obfuscate: true })
console.log(vm.run())                       // "fib(10)=55 via VM"
const analysis = analyzeVM(vm.code)
console.log(summarizeVM(analysis).dispatch) // cases, opcodes, loop type
```

Inside a sandbox, setting `instrumentation: { jsvmp: true }` traces the dispatch
loop at opcode level; `run.vm` and `run.events` (`event: 'jsvmp:opcode'`) carry
the virtual program.

## Logging

```js
import { createLogger, createMemoryDestination, createEventSink, scopeLogger } from './tools/logging/logger.js'

const destination = createMemoryDestination()
const logger = createLogger({ level: 'debug', destination })
const sink = createEventSink({ logger, level: 'trace' })
scopeLogger(logger, { runId: 'run-1' }).info({ bytes: 1024 }, 'started')
```

pino-pretty is used automatically on a TTY (or `--pretty` in the CLI).

## CLI

```
node tools/cli.js analyze <file> [--json|--out path] [--no-dynamic] [--no-restore]
                                [--seed N] [--timeout ms] [--virtual-ms ms]
                                [--level off|function|branch|statement]
                                [--source-url url] [--entry fn] [--arg JSON]
                                [--profile JSON] [--mocks JSON] [--pretty]
node tools/cli.js restore <file>  [--passes a,b] [--exclude c] [--rounds n] [--out path]
node tools/cli.js run <file>      [--json] [--events]
node tools/cli.js passes [--json]
```

Exit codes: `0` success, `1` analysis/run failure, `2` usage error.
