# Static taint analysis (Circle-IR)

`tools/taint/` provides the JavaScript/TypeScript taint-analysis component. It
uses the installed `circle-ir` engine (currently 4.17.0), not keyword co-occurrence
or sandbox trace heuristics, to identify sources, sinks, sanitizers and data-flow
paths. It does **not** execute the sample, evaluate decoded strings, follow its
imports, read its files or contact its URLs.

## Entry points

```js
import { analyzeTaint, renderTaintReport, TAINT_LIMITS } from 'ai4reverse-web/taint'
// Also exported by ai4reverse-web and ai4reverse-web/analysis.

const source = [
  'const input = location.hash;',
  'const decoded = atob(input);',
  'eval(decoded);',
].join('\n')
const report = await analyzeTaint(source, { filename: 'loader.js' })
console.log(report.flows)
console.log(renderTaintReport(report))
```

Representative flow (confidence is engine evidence, not a probability of exploit):

```json
{
  "source_line": 1,
  "sink_line": 3,
  "source_type": "http_param",
  "sink_type": "code_injection",
  "confidence": 0.855,
  "sanitized": false,
  "pathTruncated": false,
  "path": [
    { "variable": "input", "line": 1, "type": "source" },
    { "variable": "decoded", "line": 2, "type": "assignment" },
    { "variable": "decoded", "line": 3, "type": "sink" }
  ]
}
```

The sink record also identifies `eval`, `CWE-94`, argument position `0` and the
original source line. Locations are 1-based lines; parser-error columns are
0-based. Coordinates always refer to the original source supplied to the
component, never restored or instrumented code.

```bash
node tools/cli.js taint examples/sample-loader.js --json
node tools/cli.js taint examples/network-c2.js --out taint.md
node tools/cli.js taint examples/sample-loader.js --timeout 10000
node examples/taint-demo.mjs
```

The CLI exits `0` when analysis completes, including when flows are present;
`1` on parse/engine/budget failure; and `2` on usage errors. Retained-output
truncation is reported in `truncated` and is not an engine failure. JSON is the
only output on stdout with `--json`; diagnostics cannot corrupt it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `filename` | `sample.js` | Metadata and parser inference only; the path is not read |
| `language` | inferred | `javascript` (also JSX), `typescript` or `tsx`; `.ts`/`.mts`/`.cts` and `.tsx` select the corresponding parser. `tsx` is echoed as requested while Circle-IR uses its TypeScript grammar internally |
| `limits` | `TAINT_LIMITS` | Positive-integer resource and evidence bounds below |
| `config` | `{}` | Additional Circle-IR source/sink/sanitizer patterns |
| `useDefaultConfig` | `true` | Include the engine's configured defaults; `false` does **not** disable its language-specific passes |
| `speculativeParamSources` | `false` | Opt in to flows whose only source is a bare function parameter |

Invalid source types, options, limits or malformed pattern shapes throw a
`TypeError`/`RangeError`. Engine errors (including unknown pattern type names)
return an explicit `ok:false` report. The empty string is a valid empty program
for the API; the CLI rejects an empty input file. Only JavaScript, TypeScript
and TSX are accepted; Circle-IR's HTML/Vue markup preprocessor is not exposed,
and any other language is rejected before analysis.

## Composed pipeline

`analyzeSample()` runs this component by default, including in static-only mode:

```js
const result = await analyzeSample(source, {
  dynamic: false,
  taint: { limits: { maxFlows: 50, timeoutMs: 10000 } },
})
result.taint                    // raw component result, measured elapsedMs
result.report.static.taint       // normalized JSON evidence; elapsedMs is 0
result.markdown                  // includes the taint section
```

`taint:false` / CLI `analyze --no-taint` skips the worker. The raw result is then
`null` and the stable report section has `enabled:false`, `ok:false`, empty
lists and a disabled note. An engine, timeout or option error in taint analysis
does not prevent the remaining analysis stages from running. Taint evidence
does not add verdict weights or claim dynamic execution of a path, but a failed
taint stage does add a recommendation so it is not silently ignored.

## Report

The JSON-only report contains:

- `enabled`, `ok`, `engine:'circle-ir'`, `engineVersion`, `filename`, `language`;
- `parse:{ok,errorCount,errors:[{line,column,message}]}`;
- `sources` with category, variable, severity, confidence, original code and
  location; `sinks` with category, CWE, method, argument indexes and code;
- `sanitizers` with method, line and the sink types they sanitize;
- `flows` with source/sink categories and lines, confidence, `sanitized`,
  `pathTruncated` and bounded propagation steps;
- `interprocedural:{tainted_methods,taint_bridges,method_flows}` as returned by
  Circle-IR (not an assertion of full cross-function coverage);
- `stats:{sources,sinks,sanitizers,flows,taintedMethods,methodFlows}` counted
  **before** retention limits, `limits`, `truncated`, `truncatedBy`, `notes`,
  `error:{code,message}|null` and `elapsedMs`.

An engine syntax-recovery tree produces `ok:false`, `TAINT_PARSE` and may still
contain partial evidence. A source-size, source-layout or deadline failure does
not present an empty flow list as a successful scan. Sources and sinks can
appear without a reported flow. Every list and quoted text has a retention cap.
When a path is shortened, its source and sink endpoints remain and
`pathTruncated:true` records the missing intermediate steps. Sources/sinks may
be capped independently; flows carry their own endpoint lines and types even if
the corresponding point record was not retained. Fixed metadata caps also
apply: at most 20 argument indexes per sink (`argument-limit`), 40 sanitizer
sink types (`sanitizer-type-limit`), 20 parser errors (`parse-error-limit`) and
20 notes (`note-limit`). `tainted_methods` is bounded by `maxSources`;
`taint_bridges` and `method_flows` by `maxFlows`.

Failure codes are `TAINT_PARSE`, `TAINT_SOURCE_LIMIT`, `TAINT_SOURCE_LAYOUT`,
`TAINT_TIMEOUT`, `TAINT_MEMORY`, `TAINT_ENGINE`, `TAINT_WORKER_EXIT` and
`TAINT_OPTIONS`. `truncatedBy` uses `source-size`, `overlong-line`, `timeout`,
`memory`, `source-limit`, `sink-limit`, `sanitizer-limit`, `flow-limit`,
`path-limit`, `text-limit`, `method-limit`, `bridge-limit`,
`method-flow-limit`, `parse-error-limit`, `sanitizer-type-limit`,
`argument-limit` and `note-limit`.

## Configuration

Patterns are data passed per request; no YAML/JSON paths are loaded automatically.
Custom lists are appended to fresh copies of the defaults. One analysis cannot
mutate a later analysis's configuration.

```js
const report = await analyzeTaint(source, {
  config: {
    sources: [{
      method: 'readInput', type: 'user_input', severity: 'high', return_tainted: true,
    }],
    sinks: [{
      method: 'publish', type: 'external_taint_escape', cwe: 'CWE-668',
      severity: 'high', arg_positions: [0],
    }],
    sanitizers: [{ method: 'scrubHtml', removes: ['xss'] }],
  },
})
```

Property sources use `object`, `property` and optionally `property_tainted`
(defaults to true for object/property patterns; an explicit `false` is
respected) and a property pattern requires `object`. A `method` source defaults
`return_tainted` to true and an `annotation` source defaults `param_tainted` to
true, because Circle-IR otherwise accepts the pattern but can never match it.
Circle-IR matches `object` and `property` as regular-expression fragments, not
literal names, so keep them identifier-shaped unless a pattern is intended. In
Circle-IR 4.17.0, custom property patterns are recognized primarily in call
arguments; a custom property read assigned to an intermediate variable can be
missed. Built-in URL/Storage sources have additional language-specific handling.
`class`, `annotation` and source `method_annotation` restrictions are supported.
Source/sink `languages` and sink `exclude_languages` restrict matching. Sink
`arg_positions` may be empty for receiver-carried sinks, and
`safe_if_class_literal_at`, `safe_if_string_literal_at` and
`safe_if_stream_arg_at` suppress a sink when that argument is a class literal,
string literal or stream value. Use Circle-IR's source/sink
type names, for example `http_param`, `http_cookie`, `dom_input`, `user_input`,
`code_injection`, `xss`, `ssrf` or `external_taint_escape`. Pattern arrays are
limited to 500 entries each; `arg_positions` holds at most 20 indexes from 0 to
100, `safe_if_*` is an index from 0 to 100, `removes` holds at most 40 sink
types, and `languages`/`exclude_languages` must be non-empty subsets of
`javascript`, `typescript` and `tsx`. Source/sink severities are
`critical|high|medium|low`. `useDefaultConfig:false` omits the pattern lists but
keeps the engine's sink-semantics registry.

CLI equivalent: `--taint-config '<JSON object>'` works with `taint` and `analyze`.
It cannot be combined with `--no-taint`.

## Resource boundaries

Every call gets a fresh Node Worker. Circle-IR does synchronous work after
parser initialization; a host-side `Promise.race` alone cannot interrupt it.
The parent terminates the Worker on a deadline and joins termination before
returning, including on errors. Engine state and logging stay outside the guest
and outside the caller's isolate. Worker stdout/stderr are drained, not forwarded
to the CLI result stream.

| Limit | Default | Accepted range |
| --- | ---: | ---: |
| `maxSourceBytes` | 1 MiB | 1–8 MiB |
| `timeoutMs` | 5000 | 1–120000 |
| `memoryMb` | 256 | 32–4096 |
| `maxSources` | 200 | 1–2000 |
| `maxSinks` | 200 | 1–2000 |
| `maxSanitizers` | 100 | 1–1000 |
| `maxFlows` | 100 | 1–1000 |
| `maxPathLength` | 40 | 2–200 |
| `maxTextLength` | 240 | 1–4096 |

`maxTextLength` applies to evidence snippets, notes and error messages. Semantic
labels (types, CWE, error code, version, language) retain up to 100 characters;
filenames retain up to 4096 characters, independently of the snippet limit.

The deadline includes Worker startup, module loading, WASM initialization,
analysis and result projection. Source size uses UTF-8 bytes and rejects the
**whole** program, not an analyzed prefix. The CLI stats a `taint` input before
decoding it and returns the same `TAINT_SOURCE_LIMIT` failure for an oversized
file without allocating it. Circle-IR 4.17.0 also blanks any line
longer than 10,000 UTF-16 code units before parsing and does not report that loss in
`parse_status`. The adapter scans first and returns `ok:false`,
`TAINT_SOURCE_LAYOUT` and `truncatedBy:['overlong-line']` without analyzing, so
a minified one-line bundle cannot be reported as a clean scan. A `memoryMb`
breach can produce `TAINT_MEMORY`, but this is a V8 old-generation heap limit,
**not** a total process-RSS or WASM/native-memory cap. Workers are not OS
security sandboxes; container/process resource limits remain necessary for
hostile corpora. Each concurrent caller starts a Worker, so callers must bound
batch concurrency.

For `analyze`, CLI `--timeout` bounds the dynamic run only; the taint worker
keeps its own budget. Configure it through `taint:{limits:{timeoutMs}}` in the
API or use the standalone `taint --timeout`. In a composed report the taint
section always has `elapsedMs:0` for determinism; the raw `result.taint` carries
the measured time.

## Precision and limits of the evidence

Circle-IR's JavaScript analysis is heuristic and incomplete. URL properties,
cookies, Storage reads and common HTTP request inputs seed taint; concatenation,
assignments, decoding calls and some function boundaries propagate it. Sensitive
calls and DOM writes become sinks. Known sanitizers and constant overwrites can
remove flows. These examples are regression-tested, not a claim that every JS
construct has complete modeling.

Do not interpret an empty flow list as proof of safety. Runtime-generated code,
encrypted payloads, computed property accesses, aliasing, complex control flow,
callbacks and cross-file propagation can be missed or imprecisely modeled. This
adapter analyzes **one source file** and does not claim project-wide analysis.
Sanitizer behavior is inherited from the engine and can over-suppress flows;
for example, in 4.17.0 an `escapeHtml` transform before `eval` can suppress a
code-injection flow even though HTML escaping is not a code sanitizer. Retained
sanitizer records and the explicit safety note keep that limitation visible.
`external_taint_escape` means tainted data reaches an external method, not proof
of exfiltration or an actual network request.

No reported flow, sanitizer or interprocedural path is a reachability proof or
exploitability proof. Correlate it with original code, constraint evidence and
sandbox observations. Reports contain live sample strings; render them as text,
not trusted HTML. The Markdown renderer escapes markup and table delimiters. It
is a bounded summary: use the JSON report for full source/sink records (for
example sink argument indexes and source `in_method`).

## Verification

```bash
node --test tests/taint.test.js tests/taint-cli.test.js
pnpm test:types
pnpm test
```

The tests exercise real Circle-IR parsing/propagation, clean and sanitized
negatives, custom patterns, parser inference, interprocedural metadata,
syntax recovery, timeout/recovery, original offsets, bounded evidence,
non-execution, concurrent determinism, public exports, CLI exit/output contracts,
report integration and strict public type consumers.
