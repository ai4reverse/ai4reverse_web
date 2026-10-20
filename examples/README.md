# Examples

Every file here is safe to run: the platform performs **no real network, file or
process I/O**. Samples execute inside the QuickJS sandbox with a virtual clock,
mocked network and a seeded browser profile; demo scripts run on the host and
only call the platform API.

## MEGA: 18 pure-JS single-file works, 70.32MB effective code

`mega/` is the heaviest suite in the repository: **18 complete works** — 8 virus
samples, 8 JS security SDKs and 2 applications — where every work is **exactly
one JavaScript file** with no imports, no modules, no external libraries and no
second code file. The runner measures effective code (block/line comments and
blank lines stripped) and enforces **≥2.8MB per work and ≥50MB across the
suite**. Current result: **18/18 verified, 70.32MB effective / 70.47MB raw**.

Each work combines black-hole multi-layer obfuscation, a fortress nested JSVMP,
≥3 dynamic implicit white-box suites, ≥3 mutated/custom ciphers, ≥3 custom
encodings with mixed pipelines, and rendering-engine-level environment probes
(HTMLDDA `document.all`, CSS, WebGL, canvas, fonts, iframe realms, layout,
audio/media/permissions).

```bash
node examples/mega/run-all.mjs                 # 18/18 + purity/capability/≥50MB gate
node examples/mega/run-all.mjs --json          # machine-readable + byte/metrics
node examples/mega/run-all.mjs --filter 01,07,13
node tests/examples-mega.test.js               # node --test entry point
```

See [`mega/README.md`](./mega/README.md) and [`mega/SPEC.md`](./mega/SPEC.md)
for the index and the enforced contract.

## Suite II: 30 more complete works with a ≥100KB code gate

`suite/` adds 30 further complete works — 10 JS security SDKs, 12 virus samples
and 8 applications — and a code-volume gate. `run-all.mjs` verifies every
contract and measures *effective* code (comments and blank lines stripped),
failing the run below **100KB**. Current result: **30/30 verified, 562.8KB
effective code**.

```bash
node examples/suite/run-all.mjs                 # 30/30 + ≥100KB gate
node examples/suite/run-all.mjs --json          # machine-readable + byte stats
node examples/suite/run-all.mjs --filter 01,11,23
node examples/suite/run-all.mjs --min-effective-bytes 120000
```

See [`suite/README.md`](./suite/README.md) for the index.

## Complete works: 30 JS security SDKs, virus samples and applications

`works/` contains 30 independently runnable, verified works:

- **10 JS security SDKs** — secure storage, WebAuthn/passkey, device
  fingerprinting, bot detection, anti-tamper, JSVMP protection, Babel
  obfuscation, ES256 licensing, E2EE messaging, secret scanning.
- **12 virus samples** — browser locker, fileless loader, service-worker
  persistence, prototype-pollution rootkit, session hijacker, formjacker,
  wallet approval drainer, clipboard worm, PWA updater malware, WASM miner,
  DNS beacon, JSVMP ransomware.
- **8 applications** — SOC triage console, malware zoo manager, threat-intel
  enricher, CI security gate, phishing-kit analyzer, detection-rule generator,
  IR playbook, parallel sandbox farm.

Each work has `work.json` (contract), `README.md` (dossier) and an entrypoint
(`src/index.js` + `verify.mjs`, `sample.js`, or `app.mjs`).

```bash
node examples/works/run-all.mjs            # 30/30 contract check
node examples/works/run-all.mjs --json     # machine-readable results
node examples/works/run-all.mjs --filter 01,11,23
```

See [`works/README.md`](./works/README.md) for the index and per-work commands.

## Product suite: 50 commercial / military-grade packages

`products/` contains 50 complete product packages in 50 distinct categories —
banking webinject, card skimmer, wallet drainer, ransomware stager, wiper, APT
beacon, DNS tunnel, steganographic loader, Websocket/HTTP/Telegram/Discord/Slack
C2, DGA, fast-flux, supply-chain worm, adtech fraud, sandbox/VM evasion,
JSVMP/JSFuck/string-array protection, and more. Each package has
`product.json` (machine-checkable analysis contract), `sample.js` (runnable
sample) and `README.md` (dossier: chain, capabilities, commands, expected
forensics, defence).

```bash
node examples/products/run-all.mjs            # 50/50 contract check
node examples/products/run-all.mjs --json     # machine-readable results
node examples/products/run-all.mjs --filter 01,17,40
node tools/cli.js analyze examples/products/01-bank-webinject/sample.js
```

See [`products/README.md`](./products/README.md) for the full index, severity
distribution and product-by-product commands.

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
