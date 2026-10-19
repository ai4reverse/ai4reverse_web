# NSDK — 接口签名与设备指纹 SDK（国家级加固参考实现）

> A self-contained, buildable reference SDK for **request signing** and
> **device-fingerprint collection**, hardened with dynamic implicit white-box
> crypto, polymorphic code protection and a zero-trust, defence-in-depth
> environment detector.
>
> 本目录既是可直接运行的 SDK，也是 `ai4reverse` 平台的高强度**分析样本**：
> 平台可以运行它、还原它、并在 JSVMP 层面追踪它。

```
examples/national-sdk/
├── src/                    reference implementation (ES modules, testable)
│   ├── core/               bytes, PRNG, hashes, SM2/SM4/AES/ChaCha20
│   │   ├── whitebox/       implicit-key AES / SM4 / SPN
│   │   ├── custom.js       mutated & custom ciphers (魔改)
│   │   ├── variants.js     suite + layer catalogue
│   │   ├── vault.js        white-box local vault (rotating suites)
│   │   └── hybrid.js       SM2-ECDH hybrid envelope, local sealing
│   ├── vm/                 NSL compiler, ISA, interpreter, host API, program
│   ├── guard/              zero-trust detector (45 signals, 6 layers)
│   ├── fingerprint/        collectors, canonicalisation, device identity
│   ├── signing/            canonical request, signer, key ladder
│   └── runtime.js          public SDK composition
├── build/                  bundler, polymorphic obfuscator, protected build
│   └── generated/config.js per-build key material + VM container (generated)
├── server/verify.mjs       reference server-side verifier (Node)
├── dist/                   generated protected bundles + manifest
├── docs/                   threat model, algorithms, detection, verification,
│                           research notes, design review
├── testing/fixtures.mjs    synthetic browser + sandbox runner (shared tests)
└── verify.mjs              full revalidation matrix (37 checks)
```

## 1. What it delivers

| Objective requirement | Implementation | Evidence |
| --- | --- | --- |
| 接口签名 | canonical request + SM2 signature + HMAC-SM3 header MAC + timestamp/nonce/replay window + optional sealed body (`src/signing/`) | `verify.mjs` §7, `tests/national-sdk.test.js` |
| 设备指纹收集 | 31-field fingerprint, hardware/software/session stability classes, device token bound to hardware hash, drift detection (`src/fingerprint/`) | `verify.mjs` §6 |
| 超多套动态隐式白盒算法 | 12 lazily generated white-box suites across AES, SM4 and a keyed SPN; key exists only inside tables; new encodings every instantiation; the device vault picks a random suite + salt on every save (`src/core/whitebox/`, `src/core/vault.js`) | `verify.mjs` §2 |
| 超多套魔改且定制加密算法 | mutant AES-128, mutant SM4, RC6-like ARX, MAGMA/GOST-like Feistel, ARX stream, keyed sponge; each parameterised per seed (`src/core/custom.js`) | `verify.mjs` §3 |
| 混合加密 | SM2 ECDH → per-request random 3–5 layer pipeline (CFB, stream, keyed substitution, keyed permutation) + HMAC-SM3 tag + per-request radix alphabet (`src/core/hybrid.js`) | `verify.mjs` §4 |
| 超多套、动态、多态的代码混淆 | 7 seeded passes: control-flow flattening, opaque predicates, dead branches, switch shuffling, identifier mangling, numeric encoding, string table with per-build mask, decoy functions (`build/obfuscate.mjs`) | `verify.mjs` §9 |
| 动态且多态的动态隐式白盒 JSVMP | 48-opcode NSL VM, encrypted + checksummed container, build-time opcode permutation, per-invocation opcode remap, 3 dispatch strategies; bytecode key derived through the white-box SPN (`src/vm/`) | `verify.mjs` §8 |
| 浏览器内核级环境检测，零信任 + 纵深防御 | 45 signals in 6 layers, weights + proof signals + coverage-aware confidence; `document.all` as a proof-grade invariant (`src/guard/`) | `verify.mjs` §5 |

## 2. Quick start

```bash
# Build three protected variants (each ~680–700 KB, ~4–5 s per build)
node build/build-sdk.mjs --seeds 1001-1003

# Full evidence matrix: vectors, white-box equivalence, envelopes, guard,
# identity, JSVMP, host + QuickJS sandbox, platform analysis
node verify.mjs

# Run the platform test suite entry (from the repository root)
node --test tests/national-sdk.test.js
```

Reference (unprotected) SDK in Node:

```js
import { createDevelopmentSdk } from './examples/national-sdk/src/index.js'

const sdk = createDevelopmentSdk({ serverPublicKey }) // compiles the NSL program
const { headers, body } = sdk.sign(
  { method: 'POST', url: '/v1/orders?b=2&a=1', headers: { 'content-type': 'application/json' }, body: '{"x":1}' },
  { sealBody: true },
)
// headers: x-nsdk-v / -kid / -ts / -nonce / -fp / -risk / -sig / -mac / -body
```

Protected bundle in a browser-like environment:

```js
const sdk = NSDK.create({ serverPublicKey })
const signed = sdk.signedRequest({ method: 'GET', url: '/v1/profile' })
console.log(sdk.riskToken(), sdk.fingerprint().token, sdk.keyId)
```

Provisioning: the device derives its SM2 key deterministically from the
white-box keystream and its install secret. The server learns the public key
once (`sdk.publicKey`) and stores it under `sdk.keyId`.

## 3. Architecture

```
                    ┌──────────────────────── device ────────────────────────┐
fingerprint ───────►│ identity: hardware hash → device token (HMAC-SM3)     │
 (31 fields)        │ guard: 45 signals → risk token (level.score.conf)      │
                    │                                                        │
request ───────────►│ VM (NSL bytecode) ──► canonical request + sigBase      │
                    │      │  encrypted container, opcode remap, 3 dispatchers│
                    │      ▼                                                 │
                    │ white-box SPN ──► device key (SM2), VM key, local seal │
                    │      │                                                 │
                    │      ▼                                                 │
                    │ hybrid envelope: ECDH + 3–5 layers + tag + base62      │
                    └────────────────────────┬───────────────────────────────┘
                                             ▼
                    ┌──────────────────── server ────────────────────────────┐
                    │ canonical rebuild → SM2 verify → HMAC verify            │
                    │ timestamp window → nonce replay cache → open envelope   │
                    └─────────────────────────────────────────────────────────┘
```

Two independent implementations of the canonicaliser (readable JS and the VM
program) must agree before a request is signed; a mismatch throws
`NSDK_VM_INTEGRITY`. Two independent authenticators (SM2 signature and
HMAC-SM3) cover overlapping-but-different fields.

## 4. Crypto catalogue

**Standards-based:** SM2 (GB/T 32918, Jacobian BigInt, Z/ID), SM3 (GB/T 32905),
SM4 (GB/T 32907), AES-128/256 (FIPS 197), ChaCha20 (RFC 8439), HMAC-SM3,
HKDF-style expansion.

**White-box (implicit key):**

| Family | Instances | Key representation | Table budget |
| --- | --- | --- | --- |
| White-box AES-128 | 4 | absorbed into T-boxes + encoded masks | ~156 KB/instance |
| White-box SM4 | 4 | folded into per-round decode maps | ~300 KB/instance |
| White-box SPN (keyed S-boxes) | 4 | 16 key-derived 8-bit S-boxes | ~4 KB/instance |

Tables are generated lazily from the session seed; a bundle carries generators,
not twelve copies of tables. No instance object contains the key; decryption of
white-box layers uses CTR over the forward tables only.

**Runtime use:** the device vault (`src/core/vault.js`) seals persisted state on
every save with a randomly chosen suite and a fresh table salt, so the local
envelope (`wb-aes/b`, `wb-sm4/c`, `wb-spn/a`, …) rotates algorithms and encodings
across sessions rather than only in tests. The VM key and device key seed are
derived through the white-box SPN.

**Mutated/custom (魔改):** mutant AES (random S-box, row shifts, invertible
MixColumns, sponge key schedule), mutant SM4 (random S-box, diffusion
rotations, mutated constants), RC6-like, MAGMA-like, ARX stream, keyed sponge.
All are seed-parameterised and verified for round-trip and avalanche.

**Hybrid layers (server-invertible):** `sm4-cfb`, `aes-cfb`, `chacha20`,
`arx`, `mutant-aes-cfb`, `mutant-sm4-cfb`, `rc6-cfb`, `magma-cfb`, `subst`,
`perm`, and two white-box layers `wb-aes-ctr` / `wb-sm4-ctr` whose tables are
generated from the ECDH-derived layer secret (the server regenerates them). CFB,
substitution, permutation and white-box tables are not XOR streams, so a
multi-layer pipeline is not equivalent to one stream cipher.

## 5. Environment detection (zero trust + defence in depth)

| Layer | Purpose | Examples |
| --- | --- | --- |
| L1 engine | ECMAScript invariants | native `toString`, primitive coercions, function arity, error stacks, brands |
| L2 DOM | HTML/DOM invariants | **`document.all`**, collections, prototypes, events, computed style |
| L3 rendering | real rendering surfaces | 2D canvas + pixels, WebGL vendor/renderer, fonts, media queries, CSS.supports |
| L4 entropy | clocks and randomness | `performance.now`, dates, `crypto.getRandomValues`, `Intl` formatting |
| L5 consistency | cross-checks | UA ↔ platform ↔ locale ↔ timezone ↔ screen geometry ↔ hardware |
| L6 automation | headless tells | `navigator.webdriver`, headless UA, window chrome, plugins, PDF viewer |

`document.all` is **proof-grade**: in every real browser it carries the
`[[IsHTMLDDA]]` internal slot, so `typeof document.all === 'undefined'` while
`document.all == null` is true and `Boolean(document.all)` is false. ECMAScript
cannot construct such a value: an object always reports `'object'`, and
`'undefined'` is only the primitive. Failing this check proves the code is not
in a browser, independent of all other signals.

Policy: weights add into a 0–100 score; two critical failures or one proof →
`hostile`; one critical or ≥30 → `suspicious`; ≥10 or low confidence →
`guarded`; otherwise `trusted`. `unknown` results reduce confidence rather than
counting as clean.

**Expected platform finding:** the QuickJS sandbox has no `document.all`, so
the SDK correctly reports `hostile` there. This is not a bug in the sample — it
is a fundamental limit of any JS-only emulation, documented in
`docs/ENVIRONMENT-DETECTION.md`. The platform's `anti-analysis.js` sample
(which does not test `document.all`) still reports “findings: none”.

## 6. Protected build

```bash
node build/build-sdk.mjs --seed 1001 --seed 1002
```

Each build produces `dist/nsdk-<seed>.js` (+ `manifest.json`) and differs in:

- white-box static key, build salt, VM key derivation;
- VM opcode permutation, encrypted container, per-build export names;
- string-table mask, identifier names, flattened control flow, opaque
  predicates, decoy functions, switch order.

The build verifies itself by executing the artifact (host + sandbox) and
checking a real signature — not by pattern-matching its own output.

## 7. Performance (QuickJS sandbox, statement instrumentation disabled)

| Operation | Cost |
| --- | --- |
| Bundle load (700–750 KB) | ~30–50 ms |
| `NSDK.create` (SPN + vault open/seal + identity + key) | ~0.3–0.8 s |
| `sign` (VM + SM2 + envelope) | ~10–90 ms; +0.1–0.6 s if the plan includes a white-box layer |
| `selfTest` (KATs + white-box + vault integrity) | ~1–2 s |
| Fingerprint / guard | ~5–20 ms |

`create` is dominated by generating the white-box tables for the vault (two
suites: one to open the old state, one to seal the new one). This is a one-time
cost; `sign` only reuses keys/VM. `selfTest` is opt-in and intentionally
expensive because it generates reference tables.

Statement-level instrumentation of the full bundle is expensive (~1 min) because
it wraps every statement; use `instrumentation: { code: { level: 'off' } }` for
integration runs.

## 8. Honest limitations

- **White-box is not a security boundary against a live debugger.** It protects
  keys from static extraction and raises the cost of automated analysis; anyone
  who can pause the page can read tables and call them.
- **Static white-box keys are shared.** The bundle's SPN bootstrap key is the
  same on every device; per-device secrecy comes from the install secret and
  the derived device key, not from the white-box tables.
- **`document.all` cannot be emulated.** Any sandbox is detectable by it. In a
  real browser the check passes and contributes confidence.
- **Risk tokens are untrusted input.** They are signed, but a patched device can
  sign anything; treat them as one signal among many (rate limits, account
  history, server-side anomaly detection).
- **SM2 nonces** use WebCrypto when available. In the platform sandbox
  `crypto.getRandomValues` is seeded by design, so signatures are deterministic
  for a run; production browsers provide real entropy.
- The custom ciphers are proprietary constructions with no public cryptanalysis;
  they are used for defence-in-depth and disguise, never as the only protection
  of long-term secrets. The envelope's key exchange and MAC are standard.

## 9. Compliance notes (等保 / 密评)

- SM2/SM3/SM4 follow the national standards and are implemented without
  host crypto dependencies, so behaviour is identical in browser, Node and the
  analysis sandbox.
- The white-box and mutated ciphers are **not** certified cryptographic
  modules. For a 密评 (commercial cryptography assessment) deployment, keep the
  long-term signing key in a certified HSM/SE, use the white-box layer only as
  defence-in-depth, and treat the custom layers as obfuscation.
- Entropy: production browsers supply WebCrypto entropy; the analysis sandbox
  deliberately seeds it for reproducibility. A deployment should reject devices
  whose entropy source is not `crypto`.
- The reference replay cache is single-process; a multi-instance deployment must
  use shared atomic storage.
- Fingerprint collection must be disclosed and minimised (see §7); only the
  device token is transmitted.

## 10. Evidence

`node verify.mjs` runs 37 checks and prints a pass/fail table:

```
1. published vectors and OpenSSL oracles        (8 checks)
2. white-box suites + device vault               (4 checks)
3. mutated/custom ciphers                        (3 checks)
4. hybrid envelopes                              (4 checks)
5. zero-trust environment detection              (5 checks)
6. device identity and drift                     (2 checks)
7. request signing and verification              (2 checks)
8. JSVMP program, bytecode and polymorphism      (3 checks)
9. protected builds (host + QuickJS sandbox)     (5 checks)
10. platform analysis of the artifact            (1 check)
```

The same matrix is part of the repository test suite
(`tests/national-sdk.test.js`), together with unit tests for each subsystem.
`docs/VERIFICATION.md` maps every requirement to its check.

## 11. Standards and research

- GB/T 32918.1–5 — SM2 public-key algorithms (curve, signatures, key exchange).
- GB/T 32905-2016 — SM3 cryptographic hash.
- GB/T 32907-2016 — SM4 block cipher.
- FIPS 197 — AES; RFC 8439 — ChaCha20.
- ECMAScript `[[IsHTMLDDA]]` / `document.all` semantics.
- White-box AES literature: Chow–Eisen–Johnson–van Oorschot tables, BGE and
  DFA attacks (the design assumes these attacks exist; see threat model).
- JSVMP devirtualisation practice (dispatch recovery, opcode remapping).

`docs/DESIGN-REVIEW.md` records the redesign/reanalysis rounds, the defects
found, and the residual risks; `docs/RESEARCH.md` lists the primary sources
behind the white-box, `document.all`, JSVMP, obfuscation and fingerprinting
decisions.
