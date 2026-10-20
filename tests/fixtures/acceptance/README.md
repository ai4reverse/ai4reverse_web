# Acceptance probes (2026-10-20 wave)

Executable evidence for `docs/ACCEPTANCE.md`. These files are **not** part of
`pnpm test`; they are manual gates that reproduce one confirmed defect family
each. Every probe prints JSON and exits 0; the interesting part is the printed
value compared with the expectation recorded in `docs/ACCEPTANCE.md`.

Run one with plain Node from the repository root (Node >= 24.18):

```bash
node tests/fixtures/acceptance/dom-oracles.mjs
```

| Probe | Reproduces | Expected at HEAD (2026-10-20, `f0255dc`) |
| --- | --- | --- |
| `dom-oracles.mjs` | `typeof Navigator` and friends are `undefined`; document/window listeners never fire; blank and painted canvas pixels are identical opaque noise; `location.href = …` is a silent no-op; `document.location` is missing | `typeofNavigator: "undefined"`, `docHits: 0`, `blank === painted`, unchanged `locationHref` |
| `disposal-leak.mjs` | An element listener holds an unowned handle duplicate, so an ordinary loader pattern reports a leak and quarantines the WASM module | `disposal.ok: false`, `leaked: true`, `stage: "runtime"`, one `Aborted(…gc_obj_list…)` on stderr |
| `host-evidence-forgery.mjs` | A guest-supplied `{name, message}` on `AbortController.abort()` is certified as host stack evidence | `limitsHit: ["stack"]`, `stackExhaustion: true`, `disposal.leaked: true, skipped: true` |
| `traceless-oracles.mjs` | The instrumentation channel symbol is an enumerable own property and is stolen with an `Object.assign` Proxy trap | `stolenKey: "ai4r.channel.<hash>.0"`, `channelType: "function"`, `enumerable: true` |
| `trace-forgery.mjs` | Calling the stolen channel emits attacker-chosen `code:step` events | guest return value `forged-value` becomes a `code`/`step` payload |
| `instrumentation-budget.mjs` | A mid-pair insertion budget split produces a `SyntaxError` attributed to the sample | `maxInsertions` 5–6 ⇒ `errorName: "SyntaxError"`, `expecting catch or finally` |
| `restore-jsvmp-regressions.mjs` | `throw a, b` throws `a` when instrumented; ordinary loop+switch code is classified as a JSVMP; `string-array` deletes a dynamically-referenced array; `dead-code` takes the wrong bigint branch | `off: 2` vs `on: 1`; `detected: true, kind: "stack-vm"`; `window._0xa` reference with the array deleted; `if (0n)` keeps `live()` |
| `analysis-network-regressions.mjs` | The 5 000-event report slice hides a later `net` event from the verdict; unescaped Markdown in a guest return value; a refused timer drops the `net` event while keeping the IOC | `hasDynamicNetwork: false` with `counts.byKind.net: 1`; raw `![x](…)` in Markdown; `net: 0, ioc: 1` |
| `verdict-retention.mjs` | Same sample scores differently with `keepTrace: true` vs `false` | scores 13 vs 24 on the generated sample |
| `crypto-views.mjs` | `readBytes` ignores `byteOffset`/`byteLength`; `getRandomValues` indexes by element count; AES-GCM ignores AAD and `tagLength` | digest of a 4-byte window equals the 16-byte buffer's digest; `DataView(8)` all zero; `tagLength: 96` still returns a 16-byte tag |
| `hook-bus-regressions.mjs` | Wildcard phase double-matches; `once` survives a throw; a throwing logger escapes; a grandchild trace kind throws | `steps: 2`; `onceThrow: {ran: 2}`; `threw: true`; `unknown trace kind: hook.net` |
| `cli-contract.mjs` | The documented default seed spelling changes the profile; `analyze` exits 0 on a throwing sample; `--events` is accepted outside `run`; no-argument invocation exits 0 | seed `24301` vs `"0x5eed"`, different profiles; `analyze: 0` vs `run: 1`; both `--events` cases `0` |

Rules for these probes: they run benign synthetic input through
`TracelessSandbox` only (never a third-party sample with bare Node), they keep
no state outside `$TMPDIR`, and `disposal-leak.mjs` is expected to print one
engine `Aborted(…)` line to stderr — that line is the finding, not a harness bug.
