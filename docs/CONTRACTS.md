# Module contracts

Every module in `tools/` is ESM (no CommonJS), Node >= 22.18, and must be importable
standalone. Tests use the built-in `node:test` runner. No new runtime dependencies
beyond `package.json` are allowed.

## Universal rules

- **No globals.** Modules export functions/classes, never mutate `globalThis`.
- **Disposal discipline.** Anything holding a `quickjs-emscripten` handle must return it
  through `tools/util/disposable.js` helpers, otherwise `runtime.dispose()` aborts.
- **Structured events.** All observations are emitted as plain objects with the trace
  schema below and forwarded through the sandbox trace recorder.
- **No magic constants** duplicated across modules; import from the owner module.

## Trace event schema (`tools/instrumentation/trace.js`)

```js
{
  seq: number,            // monotonic per sandbox run
  t: number,              // virtual epoch ms (deterministic)
  wall: number,           // host wall clock ms (metadata only)
  kind: string,           // 'code'|'api'|'exception'|'ast'|'jsvmp'|'dom'|'net'
                          // |'storage'|'timer'|'eval'|'sandbox'|'hook'|'ioc'
  phase: string,          // 'before'|'after'|'error'|'enter'|'exit'|'step'|'emit'
  actor: string,          // '' | 'guest' | 'instrumentation' | 'hook' | 'env'
  ...payload              // flat, JSON-serializable, no handles
}
```

`createTraceRecorder({ logger, clock, limit })` returns:

```js
{
  emit(kind, phase, payload),   // -> event (also appended to ring)
  events,                       // readonly array (may be bounded)
  child(kind),                  // recorder that stamps kind/phase
  drain(),                      // returns events and clears the ring
  size,                         // number of retained events
  stats()                       // counts per kind
}
```

## Host bridge contract (`tools/sandbox/bridge.js`)

Environment modules never touch quickjs handles directly through raw ctx APIs where a
helper exists. `createHostBridge({ ctx, runtime, sandbox })` returns:

```js
{
  ctx, runtime, sandbox,
  global,                                  // ctx.global handle (do not dispose)
  fn(name, length, impl, opts?),           // native-like guest function handle
  obj(),                                   // guest object
  arr(),                                   // guest array
  str(s), num(n), bool(b), undef(), null_(), bigint(n),
  toGuest(value),                          // deep JS -> guest conversion
  fromGuest(handle),                       // deep guest -> JS (primitives + plain)
  get(handle, key), set(handle, key, value),
  define(handle, props),                   // defineProperties from a plain map
  evalInGuest(source, filename),           // returns {ok, value|error}
  emit(kind, phase, payload),              // trace emission
  reportIOC(kind, value),                  // analysis IOC capture
  clock, profile, logger,
  onDispose(fn)                            // register cleanup for sandbox teardown
}
```

`fn()` must create functions with `newFunctionWithOptions` so `name`, `length`,
`Function.prototype.toString` (`[native code]`) and stack traces match platform
functions: **no host frames may ever appear in guest stack traces**, and no wrapper
`name` may leak the platform (`no "sandbox"`, no `__`).

## Environment surface contract (`tools/sandbox/env/*.js`)

```js
export const meta = { id: 'navigator', order: 20, requires: [] }

export function install(bridge) {
  // define the surface on bridge.global / its dependencies
  // return nothing; register cleanup with bridge.onDispose if needed
}
```

- `order` sorts installation (lower first).
- Modules must be idempotent and must not add any global beyond the real browser
  surface they emulate.
- Every value that malware commonly fingerprints must be derived from
  `bridge.profile` (a seeded, internally consistent profile), never from `Math.random`
  or host time.
- Any API accepting a callback must call it with the guest `this` and guest arguments,
  and must never leak host stack frames.
- Emit `kind: 'api'` trace events for every observed call (name, args summary, result
  summary) through `bridge.emit`.

## Restoration pass contract (`tools/restore/passes/*.js`)

```js
export const meta = {
  id: 'strings', order: 30,
  description: 'decode escape sequences and encoded string literals',
  idempotent: true
}

/**
 * @param {import('@babel/core').types.Node} ast - mutated in place
 * @param {object} context
 * @param {object} context.types     - @babel/types
 * @param {object} context.traverse  - traverse function
 * @param {object} context.template  - @babel/template module
 * @param {object} context.logger
 * @param {object} context.options   - pass options from the pipeline
 * @param {function} context.report  - report(change) for the pass report
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {}
```

Passes must be conservative: never change observable semantics of surviving code.
When semantics are uncertain, leave the node untouched and record a note.

## JSVMP contract (`tools/jsvmp/*.js`)

`spec.js` owns the canonical opcode table:

```js
export const OPCODES = [{ code: 1, name: 'LOAD_CONST', argc: 1 }, ...]
export const OPCODE_BY_NAME, OPCODE_BY_CODE
```

`builder.js`:

```js
export function buildVM(program, options)
// program: [{ op: 'LOAD_CONST', args: [...] }, ...]
// options: { seed, name, obfuscate, stringTable, numericEncryption }
// returns { code, dispatchTable, opcodes, sourceMap }
```

`analyze.js`:

```js
export function analyzeVM(source, options)
// returns { detected, kind, dispatch: { variable, cases: [{ test, body, opcode }] },
//           handlers: { [opcode]: { source, ast } }, interpreter: {...} }
```

## Analysis contract (`tools/analysis/*.js`)

`ioc.js`:

```js
export function extractIOCs(text, options) // -> { urls, domains, ips, emails, hashes, wallets, base64, ... }
```

`report.js`:

```js
export function buildReport(analysis) // -> plain JSON object matching docs/REPORT-SCHEMA.md
export function renderMarkdown(report) // -> string
```

## Logger contract (`tools/logging/logger.js`)

```js
export function createLogger(options) // pino instance (pretty in TTY or when pretty:true)
export function createEventSink({ logger, pretty }) // => { write(event), flush() }
export const redactPaths // pino redact config covering cookies/tokens/payloads
```

Log rules: never `console.log`; log through pino; log levels are honored; event logs use
`msg` + structured fields; no handle or function values anywhere.
