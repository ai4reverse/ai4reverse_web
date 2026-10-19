# Report schema

`tools/analysis/report.js` owns this contract. `buildReport(analysis)` always
returns every top-level key below, even when the input bundle is empty or
partial, and the result is plain JSON (no class instances, handles or
functions). `renderMarkdown(report)` is a lossy human-readable projection of the
same object.

## Top-level shape

| Key | Type | Meaning |
| --- | --- | --- |
| `meta` | object | producer, run identity, seed, environment profile and limits |
| `sample` | object | analysed sample identity |
| `verdict` | object | weighted score, level, confidence and reasons |
| `static` | object | parse, restoration, AST summary, IOCs and techniques |
| `dynamic` | object | sandbox result, trace events and observed behaviour |
| `tracing` | object | trace volume and JSVMP detection |
| `hooks` | object | hook activity and mocked environment APIs |
| `artifacts` | array | captured artifacts with hashes and previews |
| `recommendations` | array | analyst-facing next steps |
| `integrity` | object | trace integrity result |

### `meta`

| Field | Type | Notes |
| --- | --- | --- |
| `tool` | string | always `"ai4reverse"` |
| `version` | string | tool version from `package.json` |
| `runId` | string | run identifier, `""` when unknown |
| `startedAt` | string | ISO timestamp, `""` when unknown |
| `durationMs` | number | total analysis duration |
| `seed` | number \| string \| null | determinism seed |
| `profile` | object | `{browser, platform, userAgent, timezone, locale, screen}` |
| `profile.screen` | object \| null | `{width, height, ...}` when known |
| `limits` | object | limits applied by the run (timeouts, event caps) |

### `sample`

`{name, size, sha256, sourceUrl, sourceType, truncated}` — `size` is bytes,
`truncated` records whether the analysed source was clipped.

### `verdict`

`{score, level, confidence, families, reasons}`

- `score`: integer 0..100, the sum of every reason weight, clamped.
- `level`: `benign` (0-24), `suspicious` (25-59), `malicious` (60-100).
- `confidence`: 0..1, grows with the number of independent signal families.
- `families`: sorted strings such as `obfuscation`, `c2`, `network`.
- `reasons`: `[{code, weight, detail}]`, one entry per matched heuristic.

The weights live in `VERDICT_WEIGHTS` in `tools/analysis/report.js`; every
point is attributable to a reason.

| Reason code | Weight |
| --- | --- |
| `STATIC_EVAL_LIKE` | `min(15, 5 + 2 * evalLike)` |
| `STATIC_OBFUSCATION` | `min(20, round(score / 5))` when score >= 30 |
| `STATIC_NETWORK` | `min(10, 4 + networkCalls)` |
| `STATIC_RESTORATION` | `min(12, 4 * changedPasses)` |
| `STATIC_TIMERS` | `3` when any timer exists |
| `IOC_URLS` | `min(12, 4 + 2 * nonBenignUrls)` |
| `IOC_SUSPICIOUS_TLDS` | `min(12, 6 * suspiciousDomains)` |
| `IOC_ENCODED_PAYLOAD` | `6` |
| `IOC_HASHES` | `5` |
| `IOC_WALLETS` | `min(15, 8 + 2 * wallets)` |
| `IOC_MESSENGER` | `min(14, 8 + 2 * telegramAndWebhooks)` |
| `IOC_EXECUTION` | `10` |
| `IOC_MUTEX` | `3` |
| `DYNAMIC_NETWORK` | `min(15, 6 + networkEvents)` |
| `DYNAMIC_STORAGE` | `4` |
| `DYNAMIC_DOM` | `min(10, 4 + domEvents)` |
| `DYNAMIC_EVAL` | `min(10, 4 + evalEvents)` |
| `DYNAMIC_API_MISUSE` | `8` |
| `DYNAMIC_LIMITS` | `10` |
| `DYNAMIC_UNCAUGHT` | `2` |
| `TRACING_JSVMP` | `12` |
| `HOOKS_MOCKED` | `6` |

With no reasons the score is 0 and confidence is 0.05. Otherwise confidence is
`min(0.95, 0.15 + 0.12 * families + 0.02 * min(reasons, 10))`, rounded to two
decimals, so independent signal families raise confidence.

### `static`

`parse`: `{ok, sourceType, errors}`.

`restoration`:

| Field | Type | Notes |
| --- | --- | --- |
| `passes` | array | `[{id, changed, durationMs, notes}]` |
| `code` | string | restored source |
| `sha256` | string | hash of the restored source |
| `size` | number | restored source size in bytes |
| `reducedBy` | number | bytes removed relative to the input |

`ast`: `{functions, strings, memberAccesses, evalLike, timers, networkCalls,
obfuscation}` where `obfuscation` is `{score, indicators}`.

`iocs`: the output of `extractIOCs()` (see below).

`techniques`: array of analyst-facing technique labels.

### `dynamic`

`{ok, error, limitsHit, result, events, counts, behavior, exceptions,
environment}`

- `result`: `{type, preview}` of the guest's return value.
- `events`: trace events (see `docs/CONTRACTS.md`).
- `counts`: `{byKind}` map of trace kind to count.
- `behavior`: `{apis, network, storage, dom, timers}`; `apis` is
  `[{name, count}]`, the other fields are summaries produced by the sandbox.
- `exceptions`: `{uncaught, caught, promiseJobs}`.
- `environment`: `{profile}` used by the sandbox.

### `tracing`

`{enabled, events, dropped, jsvmp}` with `jsvmp: {detected, opcodes, steps}`.

### `hooks`

`{active, fired, mocks}` counts.

### `artifacts`

`[{id, kind, sha256, size, preview}]`.

### `integrity`

`{intact, drift}`. `intact` is only `true` when verification actually ran;
`drift` lists mismatching trace segments.

## IOC categories

`static.iocs` is exactly the result of `extractIOCs(text, options)`:

| Category | Item shape |
| --- | --- |
| `urls` | `{value, scheme, host, path, source, offset, benignHost?}` — `source` is `static`, `decoded` or `dynamic` |
| `domains` | `{value, count, offset, suspiciousTld?}` |
| `ips` | `{value, version, count, offset}` |
| `emails` | `{value, count, offset}` |
| `hashes` | `{value, algo, count, offset}` — `algo` is `md5`, `sha1`, `sha256` or `sha512` |
| `wallets` | `{value, kind, count, offset}` — `kind` is `btc`, `eth` or `xmr` |
| `base64` | `{value, length, count, offset, decodedPreview?, decodedKind?}` |
| `telegram` | `{value, kind, count, offset}` — `bot-token` or `channel` |
| `discordWebhooks` | `{value, count, offset}` |
| `crypto` | `{value, kind, count, offset}` — mining terms and pool URLs |
| `shellCommands` | `{value, count, offset}` |
| `registryKeys` | `{value, count, offset}` |
| `filePaths` | `{value, count, offset}` |
| `mutexes` | `{value, count, offset}` |
| `other` | `{value, kind, count, offset}` — e.g. `String.fromCharCode` output |

`meta` is `{truncated}`. Extraction is offline and bounded by
`IOC_LIMITS.maxCandidates` (2000) and `IOC_LIMITS.maxLength` (5 MiB). Values are
deduplicated by value; the first offset and an occurrence count are retained.
Known-benign hosts (`w3.org`, `schema.org` and subdomains) remain visible in
`urls` with `benignHost: true` but are omitted from `domains`. Base64 values of
at least 16 characters are decoded one level; indicators found inside are merged
with `source: "decoded"`.

## Markdown rendering

`renderMarkdown(report)` emits the fixed headings `Verdict`, `Sample`,
`Static analysis`, `IOCs`, `Dynamic behaviour`, `Tracing/JSVMP`, `Integrity`,
`Recommendations`. Empty IOC categories are skipped; pipes are escaped in
tables; missing data renders as `—`, `none` or `0` rather than `undefined`.

## Trimmed example

```json
{
  "meta": {
    "tool": "ai4reverse",
    "version": "1.0.0",
    "runId": "run-42",
    "startedAt": "2025-01-01T00:00:00.000Z",
    "durationMs": 1234,
    "seed": 7,
    "profile": {
      "browser": "Chromium",
      "platform": "Win32",
      "userAgent": "Mozilla/5.0",
      "timezone": "UTC",
      "locale": "en-US",
      "screen": { "width": 1920, "height": 1080 }
    },
    "limits": { "timeoutMs": 5000, "maxEvents": 1000 }
  },
  "sample": {
    "name": "sample.js",
    "size": 1024,
    "sha256": "aaaa…",
    "sourceUrl": "https://samples.test/sample.js",
    "sourceType": "script",
    "truncated": false
  },
  "verdict": {
    "score": 100,
    "level": "malicious",
    "confidence": 0.89,
    "families": ["c2", "obfuscation", "ransomware"],
    "reasons": [
      { "code": "STATIC_EVAL_LIKE", "weight": 9, "detail": "2 eval-like call(s)" },
      { "code": "IOC_WALLETS", "weight": 10, "detail": "1 wallet address(es)" }
    ]
  },
  "static": {
    "parse": { "ok": true, "sourceType": "script", "errors": [] },
    "restoration": {
      "passes": [{ "id": "strings", "changed": true, "durationMs": 3, "notes": [] }],
      "code": "eval(\"x\")",
      "sha256": "bbbb…",
      "size": 9,
      "reducedBy": 1015
    },
    "ast": {
      "functions": 4,
      "strings": 12,
      "memberAccesses": 80,
      "evalLike": 2,
      "timers": 1,
      "networkCalls": 3,
      "obfuscation": { "score": 75, "indicators": ["hex strings"] }
    },
    "iocs": {
      "urls": [
        {
          "value": "https://evil.example.com/a",
          "scheme": "https",
          "host": "evil.example.com",
          "path": "/a",
          "source": "static",
          "offset": 0
        }
      ],
      "domains": [{ "value": "evil.example.com", "count": 1, "offset": 8 }],
      "ips": [],
      "emails": [],
      "hashes": [],
      "wallets": [],
      "base64": [],
      "telegram": [],
      "discordWebhooks": [],
      "crypto": [],
      "shellCommands": [],
      "registryKeys": [],
      "filePaths": [],
      "mutexes": [],
      "other": [],
      "meta": { "truncated": false }
    },
    "techniques": ["eval chain"]
  },
  "dynamic": {
    "ok": true,
    "error": null,
    "limitsHit": [],
    "result": { "type": "string", "preview": "ok" },
    "events": [],
    "counts": { "byKind": { "net": 3 } },
    "behavior": {
      "apis": [{ "name": "eval", "count": 2 }],
      "network": { "requests": 3 },
      "storage": {},
      "dom": {},
      "timers": {}
    },
    "exceptions": { "uncaught": 0, "caught": 0, "promiseJobs": 0 },
    "environment": { "profile": { "browser": "Chromium", "platform": "Win32" } }
  },
  "tracing": {
    "enabled": true,
    "events": 25,
    "dropped": 0,
    "jsvmp": { "detected": false, "opcodes": 0, "steps": 0 }
  },
  "hooks": { "active": 3, "fired": 2, "mocks": 0 },
  "artifacts": [
    { "id": "art-1", "kind": "network", "sha256": "cccc…", "size": 12, "preview": "https://…" }
  ],
  "recommendations": ["Block evil.example.com at the perimeter."],
  "integrity": { "intact": true, "drift": [] }
}
```

## Additive fields (v1.1)

The schema is append-only. The following optional fields are emitted by
`analyzeSample()` and may be absent when the corresponding stage did not run:

| Field | Meaning |
| --- | --- |
| `static.restoration.rounds`, `static.restoration.stats` | Pipeline rounds and hashes/timings. |
| `static.restoration.size`, `reducedBy` | Output size and bytes removed (not a fraction). |
| `static.iocs.<category>[].sources` | Present only when a value was observed by ≥2 sources (`static`, `decoded`, `restored`, `dynamic`). |
| `static.iocs.meta.truncated` | True when the IOC scan hit its candidate/size cap; also reflected in `sample.truncated`. |
| `dynamic.restored` | Result of the optional second run of restored code (`ok`, `error`, `counts`, `result`). |
| `dynamic.behavior.killChain` | Inferred stages (`execution`, `decode`, `command-and-control`, `persistence`, `collection`, `injection`, `fault`). |
| `dynamic.behavior.counts`, `evalStages`, `console`, `mocks` | Detailed behaviour counters and staged-eval/console records. |
| `dynamic.counts.byKind`, `dynamic.exceptions` | Trace counts per event kind and exception counters. |
| `tracing.jsvmp.sequence`, `dispatch`, `kind` | Recovered opcode sequence (bounded) and dispatch shape. |
| `artifacts[].source`, `artifacts[].count` | Provenance (`dynamic:eval@12`, `network:<url>@7`, `static:offset=…`) and duplicate count. |
| `hooks.errors` | Hook registrations that threw (isolated, never fatal). |

### Run records returned alongside the report

`report.dynamic` is normalised to a stable set of fields, so two run-level
objects are **not** part of the report JSON: they are returned by
`analyzeSample()` as `run` (and printed by `tools/cli.js run --json`) and the
report keeps only their observable outcome (`dynamic.ok`, `dynamic.limitsHit`,
`dynamic.error`).

```js
const { report, run } = await analyzeSample(source)
run.disposal   // teardown record, shapes below
run.settle     // event-loop settlement, fields below
report.integrity // integrity diff (top-level, already in the schema)
```

### `run.disposal`

The run's teardown record, verbatim:

```jsonc
{ "ok": true, "errors": [] }                       // clean
{
  "ok": false,
  "errors": [{ "stage": "runtime", "message": "Aborted(…)" }],
  "leaked": true,                                   // WASM heap known corrupted
  "stage": "runtime",                               // first failing (or skipped) stage
  "skipped": true                                   // present only when abandoned
}
```

Stages: `instrumentation`, `bridge`, `stealth`, `context`, `runtime`, `clock`.
`skipped: true` means the runtime was **abandoned** after a stack-limit breach
(it was never disposed, and the WASM module was quarantined), so `leaked:true`
here is a statement about the engine heap, not about the sample's intent.

### `run.settle`

```jsonc
{
  "jobs": 0,               // promise jobs executed
  "timerCallbacks": 2,     // timer callbacks invoked
  "promiseErrors": 0,      // unhandled rejections observed at settle
  "exhausted": false,      // a job/timer cap was hit
  "pendingTimers": 0,      // timers still scheduled
  "virtualMs": 0,          // virtual time consumed by the settle
  "limitsHit": [],         // e.g. ["stack"] when a callback breached the stack
  "stackExhaustion": false,// explicit engine marker (drives abandonment)
  "error": null            // { origin: 'timer'|'promise-job', name, message, stack }
}
```

`dynamic.limitsHit` (the report field) is the union of the script phase and the
settle phase, so a breach inside a callback still shows up even though
`dynamic.ok` stays `true` for the script itself. `run.stackExhaustion` is the
explicit engine marker (`docs/API.md`); the report keeps the observable outcome.

`report.integrity.drift` entries have `{kind, target, detail?}` where `kind` is
one of `global-added`, `global-removed`, `prototype-added`, `prototype-removed`,
`constructor-added`, `constructor-removed`, `native-changed`, `value-changed`,
`symbol-added`, `symbol-removed`. Script-defined globals are recorded but do not
make `intact` false; intrinsic/prototype changes do.
