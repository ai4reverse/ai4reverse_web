# Module contracts

Every module in `tools/` is ESM (no CommonJS), Node >= 24.18, and must be importable
standalone. Tests use the built-in `node:test` runner. No new runtime dependencies
beyond `package.json` are allowed.

This file is written against the code, not against intentions: every signature
below is the signature in `tools/` at the commit that last touched this file. When
a contract changes, the change and this file ship together (`tests/api-surface.test.js`
pins the exported surface, `tests/types.test.js` pins the declarations).

## Universal rules

- **No globals.** Modules export functions/classes, never mutate `globalThis`.
- **Disposal discipline.** Anything holding a `quickjs-emscripten` handle must return it
  through `tools/util/disposable.js` helpers or `bridge.onDispose`, otherwise
  `runtime.dispose()` aborts the WASM module and the sandbox reports
  `disposal.ok === false` (see `docs/SECURITY-MODEL.md`).
- **A handle that must outlive the call that created it is owned explicitly.**
  A `dup()` stored in module state belongs to that state (`canvas.js` keeps one
  `retain()` teardown set and frees early with `release()`), and a handle handed
  to a deferred guest callback must not come from a call-scoped `HandleBag`:
  queue plain descriptors and build the guest value at delivery time
  (`observers.js`). The call bag is disposed when the bridge call returns, so a
  stored duplicate from it is a use-after-free, and a duplicate with no owner is
  an engine abort at `runtime.dispose()`.
- **Structured events.** All observations are emitted as plain objects with the trace
  schema below and forwarded through the sandbox trace recorder.
- **No magic constants** duplicated across modules; import from the owner module.

## Trace recorder contract (`tools/instrumentation/trace.js`)

### Envelope

```js
{
  seq: number,            // monotonic per recorder, assigned by the recorder
  t: number,              // virtual epoch ms (deterministic; from `clock`)
  wall: number,           // host wall clock ms (metadata only; `Date.now()`)
  kind: string,           // one of TRACE_KINDS (14), see below
  phase: string,          // one of TRACE_PHASES (13), see below
  actor: string,          // payload.actor ?? options.actor
  ...payload              // flat, JSON-sanitised, no handles
}
```

`TRACE_KINDS` = `sandbox`, `code`, `api`, `exception`, `ast`, `jsvmp`, `dom`,
`net`, `storage`, `timer`, `eval`, `hook`, `ioc`, `restore`.

`TRACE_PHASES` = `emit`, `before`, `after`, `invoke`, `enter`, `exit`, `step`,
`transform`, `skip`, `error`, `throw`, `catch`, `uncaught`.

The envelope is applied **after** the payload, so a payload key named `kind`,
`phase` or `seq` can never clobber the envelope (a real bug in review 4.2).

### Recorder

`createTraceRecorder(options)` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `limit` | `0` | Retained-event cap; `0` is unbounded. Dropping the oldest event increments `dropped`. |
| `clock` | `() => Date.now()` | Virtual clock for `t`. The sandbox passes its virtual clock. |
| `sink` | `null` | Object with `write(event)` (the pino event sink). A throwing sink is swallowed. |
| `actor` | `'instrumentation'` | Default `actor` stamped on every event. |
| `strict` | `false` | When true, an unknown `kind`/`phase` throws **before** any state mutates (`TRACE_PHASES` is the gate). |

It returns:

```js
{
  emit(kind, phase, payload = {}),  // -> event; strict-validates first, then seq/t/counts
  events,                          // retained array (live, not a copy)
  size, dropped, seq,              // getters
  child(kind, phase = 'emit'),     // recorder bound to a kind (+ default phase);
                                   // its child(subKind) namespaces as `${kind}.${subKind}`
  subscribe(listener),             // push listener; returns an unsubscribe function
  drain(),                         // returns a copy of the events and empties the buffer
  stats(),                         // { total, retained, dropped, byKind }
  clear(),                         // empties buffer + counters
}
```

`sanitizePayload` bounds every payload: strings to 2 048 characters, arrays to
100 items (plus a `[+N more]` marker), object depth to 5, `Error` to
`{name, message, stack}` with 8 stack lines, functions to `[Function name]`,
and handles to `'[Handle]'`.

## Hook bus contract (`tools/hook/hookbus.js`)

`createHookBus({ logger, trace, strict, record, recordPhases })`:

| Option | Default | Meaning |
| --- | --- | --- |
| `logger` | `null` | Passed to handlers as `context.logger`. |
| `trace` | `null` | Recorder used for `hook` events. |
| `strict` | `false` | Reject a phase that is not in `HOOK_PHASES` and is not `*`/`domain:*`. |
| `record` | `true` | Emit `hook` trace events. |
| `recordPhases` | `null` | Prefix allow-list; when set it wins over the default policy. |

`HOOK_PHASES` (21, frozen): `code:before|after|error|step`,
`api:before|after|error`, `exception:throw|catch|uncaught`,
`ast:enter|exit|node|transform`, `jsvmp:enter|opcode|step|exit`,
`lifecycle:init|run|dispose`.

Registration: `on(phase, handler, { priority = 0, id, once, owner, traceless, context })`
returns an unsubscribe function. Matching is `phase`, then `domain:*`, then `*`,
ordered by `priority` descending and registration order ascending. `*` is only
valid as a phase name; `normalizePhase` rejects anything without a `:`. The
default `traceless` footprint is
`{ addsGlobals: false, preservesIdentity: true, preservesStack: true, consistentAnswers: true }`
and `describe()`/`report.hooks` report it verbatim.

The bus exposes `on`, `off(id)`, `clear(owner?)`, `setEnabled(id, enabled)`,
`has(phase)`, `emit`, `dispatch`, `pipeline`, `describe()`, `stats()`.

### emit / dispatch / pipeline

| Method | Returns | Semantics |
| --- | --- | --- |
| `emit(phase, payload = {}, extraContext = {})` | `{ phase, results }` | Observer dispatch. Payload is passed by reference and may be enriched. Handler return values are recorded, not applied. `result.stop === true` breaks the chain. |
| `dispatch(phase, payload = {}, extraContext = {})` | `{ blocked, value, args, stopped, results, phase }` | Interception (`api:before`). `{block: v}` / `{replace: v}` short-circuit with `blocked: true`; `{args: [...]}` rewrites arguments; `false` stops the chain. |
| `pipeline(phase, initial, extraContext = {})` | `{ value, changed, steps }` | Transform chain for `MUTATING_PHASES` = `code:before`, `ast:transform`, `api:before`, `ast:node` (and `domain:*`). A non-mutating phase throws `HookError`. |

**No-op phases are not evidence.** `emit`, `dispatch` and `pipeline` compute the
enabled registrations first; with none, they return the neutral shape
(`{phase, results: []}`, `{blocked:false, value:undefined, args:undefined,
stopped:false, results:[], phase}`, `{value: initial, changed:false, steps:[]}`)
**without** emitting a `hook` trace event and **without** incrementing
`stats().dispatches`. `dispatchCount` therefore counts dispatched phases, not
call attempts.

`shouldRecord(phase)` (used before every `hook` trace event):
`record:false` → off; a `recordPhases` prefix match → on; `code:step` → off (the
per-statement probe already emits a `code` event); `ast:*` and `jsvmp:*` → off
(they have their own event kinds). `code:step` stays dispatchable: a hook may
still subscribe to it, it is only never *traced* as a hook event.

**Errors are isolated and bounded.** A throwing handler is recorded in the ring
and never propagates to the guest. The ring keeps the newest 200 entries
(`MAX_HOOK_ERRORS`) and sets `errorsTruncated: true` once anything was dropped,
so a hook that throws on every statement cannot grow memory without limit.
`stats()` returns `{ hooks, dispatches, errors: [...copy], errorsTruncated, byPhase }`.

## Host bridge contract (`tools/sandbox/bridge.js`)

Environment modules never touch quickjs handles through raw `ctx` APIs where a
helper exists. `createHostBridge({ ctx, runtime, sandbox, profile, clock, trace, logger, stealth })`
returns:

```js
{
  ctx, runtime, sandbox, profile, clock, trace, logger, stealth,
  global,                       // ctx.global handle — borrowed, never dispose
  stats,                        // { calls, errors, conversions } (live counters)
  get undefined, get null,      // ctx.undefined / ctx.null handles
}
```

### Methods (real signatures)

| Method | Contract |
| --- | --- |
| `fn(name, length, impl, opts = {})` | Guest function backed by host code. `impl({ args, thisHandle, bag, bridge })`; the returned handle is transferred to the guest, primitives are converted. Arity is clamped to `0..8` and the guest-visible `length` is set explicitly. `opts.isConstructor` sets `[[Construct]]`. The handle is bridge-owned. |
| `nativeConstructor({ name, arity = 0, bindings = {}, body })` | Guest constructor whose body assigns to `self` and returns it; host functions are injected as lexical bindings. The result is `adopt()`ed as native. |
| `adopt(handle, nativeName)` | Register a guest function's source as `[native code]`-looking (best effort; returns the handle). |
| `install(target, key, value, flags = {})` | `defineProperty` with real flags. Defaults `{ enumerable: true, configurable: true, writable: true }`. `value` may be a handle or a plain JS value. Returns the value handle. **Reads through the original descriptor** when wrapping (`tools/instrumentation/api.js`), so `Object.keys(WebAssembly)` stays `[]`. |
| `accessor(target, key, { get, set, enumerable = true, configurable = true })` | Accessor property whose getter/setter are `fn()` host functions. |
| `toGuest(value)` | Deep JS → guest. Handles pass through; `undefined`/`null` map to the guest sentinels; strings/numbers/bigints are tracked in the current bag; `Uint8Array` → ArrayBuffer; arrays/objects recurse. **Refuses host functions** (`use bridge.fn()`). |
| `fromGuest(handle, depth = 0)` | Deep guest → JS. Primitives are dumped; promises are inspected non-destructively (`{__type:'promise', state}`); functions become `{__type:'function'}`; depth is capped at 4. |
| `str(args, index, fallback = '')` | String argument, else `fallback`. Never disposes. |
| `num(args, index, fallback = NaN)` | Number argument (`ctx.dump`), else `fallback`. |
| `int(args, index, fallback = 0)` | `num` truncated, else `fallback`. |
| `bool(args, index, fallback = false)` | Truthiness of the argument (`Boolean(ctx.dump)`) — webidl "boolean" semantics. |
| `value(args, index)` | Argument as a plain JS value (`fromGuest`); `undefined` on conversion failure. |
| `list(handle, limit = 1000)` | Guest array handle → JS array of plain values, `length` clamped to `limit`. |
| `get(target, key)` | Property read as a plain value (temporary handle disposed). |
| `set(target, key, value)` | Property write from a plain value; returns the handle passed to `ctx.setProp` (**consumed** by the call). |
| `obj(properties = {}, prototype = null)` | Plain guest object with the given properties; bridge-owned. |
| `arr(values = [])` | Guest array from plain values; bridge-owned. |
| `evalInGuest(source, filename = '')` | Evaluate inside the guest; returns `{ ok: true, value }` or `{ ok: false, error }` (plain values, handles disposed). |
| `deferred()` | Guest promise plus `resolve(value)` / `reject(value)` / `dispose()`; the deferred promise is disposed at teardown. |
| `emit(kind, phase, payload)` | Trace emission; never throws (a trace failure must not disturb the guest). |
| `reportIOC(kind, value)` | `emit('ioc', 'emit', { iocKind, value })` with the value stringified and capped at 2 048 characters. |
| `onDispose(fn)` | Register a teardown callback (dups, timers, deferreds); returns `fn`. |
| `disposeAll()` | Runs teardown callbacks LIFO, each in its own `try/catch` (a failure is logged, never thrown), then disposes the descriptor factories and every bridge-owned handle. Called once by the sandbox. |

There is **no** `bridge.call`, no `adoptPrototype`, and no `define`. Handles
created per host call live in a `HandleBag` that is disposed in `finally`, even
when the implementation throws (`bridge.fn`'s trampoline).

`fn()` must create functions with `newFunctionWithOptions` so `name`, `length`,
`Function.prototype.toString` (`[native code]`) and stack traces match platform
functions: **no host frames may ever appear in guest stack traces**, and no
wrapper `name` may leak the platform (no `"sandbox"`, no `__`).

## Environment surface contract (`tools/sandbox/env/*.js`)

```js
export const meta = { id: 'navigator', order: 58, requires: ['globals', 'storage'] }

export function install(bridge) {
  // define the surface on bridge.global / its dependencies
  // return nothing; register cleanup with bridge.onDispose if needed
}
```

`installEnvironment(bridge, { strict = true, only = null, exclude = [], logger })`:

- loads only ids from `ENV_MODULE_IDS` (28) minus `exclude`/outside `only`;
- sorts loaded modules by `(meta.order, meta.id)`, so the only tie (order 80:
  `crypto`, `xhr`) resolves deterministically;
- checks each module's `requires` against the set installed so far and throws
  `SandboxError` in strict mode (`environment module "x" missing requirement y`);
- a missing/failed module throws in strict mode and is skipped with a warning
  otherwise;
- returns `{ installed, missing, requested, tookMs, complete }`.

Contract rules:

- `meta.id` must equal the file id (`loadEnvModule` throws otherwise); `meta.order`
  defaults to 500 when omitted; `requires` must name modules installed strictly
  earlier.
- Modules are idempotent and add nothing beyond the real browser surface they
  emulate.
- Every value that malware commonly fingerprints must be derived from
  `bridge.profile` (seeded, internally consistent), never from `Math.random` or
  host time.
- Any API accepting a callback calls it with the guest `this` and guest
  arguments and never leaks host stack frames.
- `kind: 'api'` trace events are emitted for every observed call through
  `bridge.emit`.

### The 28 modules in install order

| order | id | requires |
| --- | --- | --- |
| 10 | `globals` | — |
| 20 | `console` | — |
| 25 | `time` | `globals` |
| 27 | `stack` | `globals` |
| 28 | `random` | `globals` |
| 30 | `dom` | `globals` |
| 32 | `dom-parser` | `globals`, `dom` |
| 45 | `screen` | `globals` |
| 50 | `location` | `globals` |
| 55 | `storage` | `globals` |
| 58 | `navigator` | `globals`, `storage` |
| 65 | `timers` | — |
| 70 | `encoding` | — |
| 75 | `performance` | `globals` |
| 80 | `crypto` | `globals` |
| 80 | `xhr` | `globals` |
| 82 | `network` | `globals` |
| 84 | `fetch` | `globals` |
| 85 | `eventsource` | `globals`, `network` |
| 86 | `websocket` | `globals` |
| 88 | `url` | `globals` |
| 92 | `blob` | `globals` |
| 100 | `misc` | `globals`, `navigator` |
| 105 | `canvas` | `globals` |
| 108 | `observers` | `dom` |
| 110 | `intl` | `globals` |
| 115 | `chrome` | `navigator` |
| 130 | `anti-fingerprint` | `globals` |

`tools/sandbox/env/platform-kit.js` is **not** a module: it exports `createKit`
only (no `meta`, no `install`) and is absent from `ENV_MODULE_IDS`; it is the
shared helper layer for `url`, `blob`, `navigator` and `misc`.
`tools/sandbox/env/index.js` is the loader. 30 files in the directory = 28
modules + loader + kit.

## Stealth contract (`tools/invocation/stealth.js`)

`createStealth(ctx, options = {})` with `{ nonce, trace, logger, maskToString = true }`
returns `{ install(), dispose(), isIntrinsicStackError(handle) }` plus helpers.
`install()` must run before any guest code and before an env module looks at
`Function.prototype.toString`; it captures the engine's `InternalError` binding
**first**, because `env/globals.js` deletes it for every non-Firefox profile.

`isIntrinsicStackError(handle)` is the guest-side half of stack-breach
classification (`tools/invocation/invoke.js` `isEngineStackError`):

- it answers from the **live handle**, never from a dump, so no guest-controlled
  `name`/`message` takes part;
- it walks the prototype chain against the captured `InternalError.prototype`
  (not `instanceof`), so mutating `Symbol.hasInstance` or the prototype itself
  cannot steer it;
- it returns `false` while the constructor is still reachable from the guest
  global (`globalThis.InternalError === target`), because `new InternalError(…)`
  is then prototype-identical to a real engine throw;
- it neither consumes nor disposes the caller's handle.

The host-side half is `isHostStackExhaustion(thrown)` in
`tools/sandbox/runtime.js` (a host-thrown `RangeError` out of the WASM
trampoline). Both feed the `stackExhaustion` marker, and only that marker drives
abandonment.

## Restoration pass contract (`tools/restore/passes/*.js`)

```js
export const meta = {
  id: 'strings',
  order: 30,
  description: 'decode escape sequences and encoded string literals',
  idempotent: true,   // default true; false means "may need another round"
  deferred: false,    // true: run once, in the final round (only `rename`)
}

/**
 * @param {import('@babel/core').types.Node} ast - mutated in place
 * @param {object} context
 * @returns {{changed: boolean, notes?: string[], changes?: object[]}}
 */
export function run(ast, context) {}
```

`context` is built by `createPassContext` (`tools/restore/pass-context.js`):
`{ types, traverse, template, logger, options, report(change), note(message),
replace(path, node), notes, changes }`. Shared helpers a pass may use:
`isDirectiveSlot`, `inWithScope`, `compareGeneratedText`, `valueToNode`. Other
guards (for example `string-array`'s `isBeforeDeclaration`) stay private to the
pass that needs them.

### `changed` means the generated text changed

`changed` drives the `STATIC_RESTORATION` verdict weight, `stopOnNoChange` and
the idempotency claim, so a pass may only report `changed: true` when the
generated replacement text differs from the text the current node generates.
Use `compareGeneratedText(node, replacement)` → `{ from, to, changed }`; rewrite
only when `from !== to` (D5).

### Idempotency

`restore(restore(x).code, { maxRounds: 1 })` must report `changed === false` for
every example sample: the default pipeline is a fixed point. `meta.idempotent:
false` would make the orchestrator stop re-running that pass; no pass currently
needs it.

### Deferral

`isDeferredPass(pass)` reads `meta.deferred`; the `rename` id is the fallback for
a pass that does not declare it. A deferred pass is skipped in every round
except the last, and the orchestrator runs it once even when `maxRounds` was
never reached (e.g. `only: ['rename']`), so it can never be silently dropped.

### Output validation

`restore()` re-parses the generated text with the pipeline's own parser in a
**strict** parse (`errorRecovery: false`, both source types). On failure it
returns the **input** source unchanged with `outputValid: false`,
`outputError: { message }`, `map: null` and a note — code that does not parse is
never returned. `validateOutput(code, { sourceType, filename })` exposes the
same check as a boolean. `changed` is therefore
`outputValid && (anyPassChanged || generatedText !== input)`.

Passes must be conservative: never change observable semantics of surviving
code. When semantics are uncertain, leave the node untouched and record a note.

## JSVMP contract (`tools/jsvmp/*.js`)

`spec.js` owns the canonical opcode table:

```js
export const OPCODES = [{ code: 1, name: 'LOAD_CONST', argc: 1 }, ...]
export const OPCODE_BY_NAME, OPCODE_BY_CODE, SEMANTICS
```

`builder.js`: `buildVM(program, { seed, name, obfuscate, stringTable,
numericEncryption })` → `{ code, dispatchTable, opcodes, run(), … }`, plus
`buildSampleProgram()`.

`analyze.js`: `analyzeVM(source, options)` → `{ detected, kind, dispatch,
handlers, … }`, with `extractHandlers`, `isJSVMP`, `summarizeVM` as the
composable pieces. `detectDispatch`/`locateInterpreter` are exported by
`tools/instrumentation/jsvmp.js`, which splices the probes. Detection requires interpreter
evidence (bytecode/stack/pc) *and* an indexed discriminant, so an ordinary
`switch` in a loop is not misclassified.

## Analysis contract (`tools/analysis/*.js`)

```js
extractIOCs(text, options)         // -> { urls, domains, ips, emails, hashes, wallets, base64, meta }
buildReport(analysis)              // -> plain JSON object matching docs/REPORT-SCHEMA.md
renderMarkdown(report)             // -> string
summarizeBehavior(trace)           // -> behaviour summary (killChain, counts, …)
extractStagedPayloads(...)         // -> artifact list
```

## Logger contract (`tools/logging/logger.js`)

```js
createLogger(options)                       // pino instance (pretty on a TTY or pretty:true)
createMemoryDestination()                   // in-memory sink for tests
createEventSink({ logger, pretty, level })  // => { write(event), flush() }
scopeLogger(logger, bindings)               // child logger with static fields
redactPaths                                 // pino redact config covering cookies/tokens/payloads
```

Log rules: never `console.log`; log through pino; log levels are honored; event
logs use `msg` + structured fields; no handle or function values anywhere. The
CLI keeps results on stdout and logs on stderr (fd 2).
