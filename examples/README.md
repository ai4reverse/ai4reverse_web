# Examples

Every file here is safe to run: the platform performs **no real network, file or
process I/O**. Samples execute inside the QuickJS sandbox with a virtual clock,
mocked network and a seeded browser profile; demo scripts run on the host and
only call the platform API.

## Malicious / obfuscated samples

Analyse them with the CLI: `node tools/cli.js analyze examples/<file> --json`
(or without `--json` for a Markdown report).

| File | Technique | What the platform should show |
| --- | --- | --- |
| `sample-loader.js` | hex escapes, string array, `btoa`/`atob` config, staged `eval`, `fetch` beacon, `localStorage`, retry timer | verdict `malicious` (60), 2–3 URLs, 4 artifacts, `strings`/`string-array` restoration changes, kill chain `execution → persistence` |
| `string-array-obfuscated.js` | rotated string array + decoder + hex escapes + `fetch` | `strings` + `string-array` passes change; readable `endpoint`; suspicious verdict |
| `control-flow-flattened.js` | `switch(order[idx++])` dispatch loop + dead branch | `control-flow` + `dead-code` passes change; sequential statements restored |
| `jsfuck-lite.js` | strings/numbers built from `[]`, `!`, `+`, `{}` | `jsfuck` pass folds the expressions; untouched suspicious constructs remain |
| `eval-chain.js` | base64 → `eval` → base64 → `eval` (three stages) | `eval` trace events, decoded stage artifacts, `stage-3 executed` in console |
| `staged-payload.js` | `atob` + `Function` constructor dropper | `Function` call-site event, decoded body artifact, storage write |
| `network-c2.js` | `fetch` POST, XHR beacon, `sendBeacon`, WebSocket, storage | 8+ `net` events (default policy denies with realistic errors), 4 IOCs, `suspicious` verdict |
| `anti-analysis.js` | timing loop, `navigator.webdriver`, `_phantom`, `Function('return this')`, `toString` brand, caught stack, devtools size, `debugger` | **`console.log('analysis findings: none')`** — the sandbox is not detected; `anti-analysis` pass notes the probes |
| `fingerprint-probe.js` | UA/platform/timezone/Intl/screen/WebGL/canvas/audio/fonts | coherent fingerprint (e.g. `Asia/Shanghai` + `GMT+0800` + Windows UA), stable across runs with the same seed |
| `jsvmp-sample.js` | generated JSVMP interpreter (obfuscated opcode cipher, encoded consts) | `tracing.jsvmp.detected=true`, 14 opcodes, hundreds of `jsvmp:opcode` events; static analyzer reports `stack-vm`/`switch-dispatch` |
| `benign.js` | arithmetic loop + `console.log` | verdict `benign` (score 6), zero URLs/artifacts, no restoration changes |

Useful commands:

```bash
node tools/cli.js analyze examples/sample-loader.js            # Markdown report
node tools/cli.js analyze examples/network-c2.js --json | jq .static.iocs
node tools/cli.js restore examples/string-array-obfuscated.js  # restored source
node tools/cli.js run examples/anti-analysis.js --events       # raw trace stream
node tools/cli.js analyze examples/jsvmp-sample.js --json | jq .tracing.jsvmp
```

Analyse every sample in one go:

```bash
for sample in examples/*.js; do
  node tools/cli.js analyze "$sample" --json --log-level silent \
    | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log(r.sample.name, r.verdict.level, r.verdict.score)})'
done
```

## Hardened SDK specimen (`national-sdk/`)

A self-contained SDK project — not a malicious sample — for **request signing**
and **device-fingerprint collection**, built to exercise every analysis
capability at maximum strength:

| Area | What it contains | Expected platform behaviour |
| --- | --- | --- |
| Crypto | SM2/SM3/SM4 + AES/ChaCha20, 12 dynamic implicit white-box suites, mutated/custom ciphers, SM2-ECDH hybrid envelopes | primitives verify against OpenSSL/GM/T vectors; white-box tables are generated at runtime, not present statically |
| Code protection | 7-pass polymorphic obfuscator, encrypted 48-opcode JSVMP container, per-build opcode permutation, per-invocation remap, 3 dispatchers | statement-level instrumentation of the full bundle is expensive (~1 min); run with `code.level: 'off'` for integration, JSVMP/API tracing still works |
| Environment detection | 45 signals in 6 zero-trust layers, `document.all` proof, rendering/consistency cross-checks | inside the QuickJS sandbox the SDK correctly reports `hostile` because `document.all` cannot be emulated; this is an expected finding, documented in the SDK |
| Verification | `verify.mjs` (37 checks), reference server verifier, host + sandbox signing round-trips | `node examples/national-sdk/verify.mjs` exits 0 only when the whole matrix passes |

```bash
node examples/national-sdk/build/build-sdk.mjs --seeds 1001-1003
node examples/national-sdk/demo.mjs
node examples/national-sdk/verify.mjs
node --test tests/national-sdk.test.js
```

See `examples/national-sdk/README.md`, `docs/THREAT-MODEL.md`,
`docs/ALGORITHMS.md`, `docs/ENVIRONMENT-DETECTION.md`,
`docs/VERIFICATION.md` and `docs/DESIGN-REVIEW.md` inside that directory.

## Programmatic demos (run with Node)

| File | Demonstrates |
| --- | --- |
| `api-usage.mjs` | `TracelessSandbox.run` + pino capture, `analyzeSample` verdict/IOCs/artifacts/kill-chain, `restore` pass attribution |
| `hooks-demo.mjs` | traceless API mock (`sendBeacon`), synthetic network route, exception/code hooks, hook audit and trace counts |
| `restore-demo.mjs` | per-pass restoration table and restored excerpts for several samples |
| `jsvmp-demo.mjs` | build an obfuscated JSVMP, static dispatch/handler analysis, opcode-level dynamic trace and devirtualised sequence |
| `build-jsvmp-sample.mjs` | regenerates `jsvmp-sample.js` after changes to `tools/jsvmp/` |

```bash
node examples/api-usage.mjs
node examples/hooks-demo.mjs
node examples/restore-demo.mjs
node examples/jsvmp-demo.mjs
node examples/build-jsvmp-sample.mjs   # only when regenerating the VM sample
```

## CLI cookbook

```bash
bash examples/cli-usage.sh
```

See `README.md`, `docs/API.md` and `docs/REPORT-SCHEMA.md` for the full surface.
