# Design review and revalidation record

This document is the audit trail for the SDK: what was required, what was
designed, what broke during review, and what remains risky. It is intentionally
specific — every defect listed here was found by a test or a review pass, fixed,
and is now covered by `verify.mjs`.

## 1. Requirement audit

| Requirement (objective) | Concrete interpretation | Artifact | Proof |
| --- | --- | --- | --- |
| 用于接口签名 | produce `x-nsdk-*` headers that a server can independently verify | `src/signing/`, `server/verify.mjs` | verify §7; `tests/national-sdk.test.js` signing test |
| 设备指纹收集 | stable device token from hardware fields + drift reporting | `src/fingerprint/` | verify §6 |
| 国家级 JS-SDK | Chinese national crypto standards are first-class (SM2/SM3/SM4), with interop-ready encodings | `src/core/sm2.js`, `hash.js`, `sm4.js` | verify §1 (GM/T 0003.5 vector) |
| 超多套动态隐式白盒算法 | 12 suites, tables generated per session, no key property; device vault rotates suite + salt on every save | `src/core/whitebox/`, `src/core/vault.js` | verify §2 |
| 超多套魔改且定制加密算法 | 6 families, seed-parameterised, round-trip + avalanche | `src/core/custom.js` | verify §3 |
| 混合加密 | ECDH + 3–5 distinct layers (standard, mutated, white-box) + tag + encoding | `src/core/hybrid.js` | verify §4 |
| 超多套、动态、多态代码混淆 | 7 passes, per-build parameters, verified by execution | `build/obfuscate.mjs` | verify §9 |
| 动态且多态的动态隐式白盒 JSVMP | encrypted container, build permutation, session remap, 3 dispatch strategies | `src/vm/` | verify §8 |
| 浏览器内核级环境检测 | 45 signals / 6 layers, proof + weights + coverage | `src/guard/` | verify §5 |
| 零信任 | no single signal trusted; proofs separated; unknown lowers confidence | `src/guard/policy.js` | policy threshold checks |
| 纵深防御 | independent layers, dual canonicaliser, dual authenticators | guard + signing | verify §7/§8 |
| `document.all` 检测 | ten `HTMLAllCollection`/`[[IsHTMLDDA]]` invariants | `src/guard/document-all.js` | verify §5 + sandbox check |
| 最终放到 examples/ | self-contained `examples/national-sdk/` project | this directory | repository layout test |

## 2. Review rounds

### Round 1 — redefine and research

Decisions made before code:

- **Standards first.** Use GB/T 32918/32905/32907 and FIPS 197 as the
  interoperable core; custom algorithms are additive, never the only protection
  of a long-term secret.
- **Server-verifiable hybrid.** White-box ciphers cannot be inverted by the
  server, so white-box protects key material and local state; envelopes use
  ECDH-derived keys over server-invertible layers.
- **Dual implementation.** The protected logic runs in the VM *and* a readable
  reference implementation; signing aborts if they disagree.
- **White-box in the real runtime.** The device vault rotates one of the twelve
  suites on every save, so white-box AES/SM4/SPN are used by the SDK itself, not
  only by tests; the VM key and device key seed flow through the SPN.
- **`document.all` as proof.** The `[[IsHTMLDDA]]` slot cannot be emulated;
  treating its failure as decisive is sound and survives sandbox evolution.
- **Honest limits.** White-box is an economic barrier, not a boundary; this is
  stated in the README, threat model and algorithm docs.

### Round 2 — redesign and reanalyse

Defects found and fixed:

| # | Defect | How it was found | Fix |
| --- | --- | --- | --- |
| 1 | White-box AES applied an extra full round (initial key + full round, then 9 more) | byte-equality test against the reference AES showed divergence after round 10 | round 0 is now AddRoundKey only; rounds 1–9 are T-box rounds |
| 2 | `randomBijection` ignored `prng.shuffle`'s return value, so all SPN S-boxes were the identity permutation and the “keyed” SPN was key-independent | direct test: two keys produced identical ciphertext | `Uint8Array.from(prng.shuffle(...))` |
| 3 | Radix decode/encode lost or corrupted leading zero bytes (`[0,1,0]` → wrong) | property test over edge cases | separated sentinel zeros from the numeric part; decode re-prepends them |
| 4 | VM frames never initialised parameters from `args`, so `ctx` was `undefined` | VM returned `undefined`; first call target was `undefined` | parameters occupy the first local slots and are bound at frame creation |
| 5 | Runtime handler lookup used `perm[runtimeCode]` instead of an inverse session map | dispatch called `undefined` | build `runtimeHandler[sessionMap[buildCode]] = perm[buildCode]` |
| 6 | The signing host API was not passed to the VM (`ctx.h` missing) | `h.kdf` was `undefined` | `createHostApi()` injected into every VM call |
| 7 | Guard `critical`/`proof` options were passed to `guarded()` instead of `add()`, so `document.all` was not decisive | fake-browser verdict was `guarded` instead of `hostile` | options moved to the signal registration |
| 8 | Fingerprint canonicalisation encoded `NaN` as `{"$num":"NaN"}`, while persisted JSON turns it into `null`, producing false drift | second identity load reported “major” drift | non-finite numbers canonicalise to `null`, matching JSON |
| 9 | Profile signer passed a *function* (`guard.token`) as the risk header, producing `invalid-risk-token` | verifier rejected a clean request | `resolveRisk()` handles functions/strings/objects |
| 10 | String-table mask was keyed by character index but decoded by hex offset, so every string after the first decoded wrong | obfuscated bundle produced `ISA undefined` | encode with `index * 4` |
| 11 | Flattening top-level `let/const` into a switch let the machine re-enter the block scope on every transition, hitting the TDZ | “Cannot access 'exponent' before initialization” | top-level `let/const` become `var` before flattening |
| 12 | Flattened state ids could collide; once cases were shuffled the wrong duplicate ran | `Cannot mix BigInt and other types` only with flatten+shuffle | unique state ids and collision-free end id |
| 13 | Export names (`createSdk`, `SERVER_LAYERS`, …) leaked through module boundaries and destructuring | plaintext-marker check on the bundle | per-build random export keys; entry exports stay public |
| 14 | Numeric-literal rewriting re-visited its own replacements | stack overflow during obfuscation | `path.skip()` after replacement |
| 15 | Template literals were not encoded, leaking `nsdk/device/v1/...` | marker scan | templates lowered to encoded `+` chains |
| 16 | Obfuscated bundle took ~60 s under statement instrumentation | sandbox timing | integration tests disable statement instrumentation; documented |
| 17 | White-box AES/SM4 were only exercised by self-tests, not by the runtime signing/identity path | requirement audit (“超多套…白盒算法” should be in use) | added the device vault: random suite + salts per save, authenticated envelope, tamper checks |

### Round 3 — review and revalidate

- `verify.mjs` was written as an independent harness, not as a copy of the unit
  tests: it rebuilds artifacts and checks them from the outside.
- The synthetic browser fixture is deliberately incapable of passing
  `document.all`; it proves the detector is selective (42/45 pass) rather than
  uniformly hostile.
- The QuickJS sandbox run is a first-class check: signature verification with a
  pinned clock, guard evidence, self-test, storage and fingerprint coverage.
- Platform analysis is part of the matrix, so the artifact is validated both as
  a library and as an analysis sample.
- All plaintext-marker checks are assertions, not printouts.

## 3. Residual risk register

| Risk | Likelihood | Impact | Mitigation / decision |
| --- | --- | --- | --- |
| Static white-box key extraction | medium | device key forgery | per-device install secret; white-box only protects the bootstrap; rotate keys |
| Debugger dumps live tables | high (with effort) | key recovery | accepted; documented; server-side anomaly detection |
| Custom ciphers have no public cryptanalysis | medium | envelope weakness | envelope security also relies on SM4/AES/ChaCha20 and HMAC-SM3; custom layers add depth, not sole secrecy |
| Guard evasion by patching JS | medium | automation passes | dual canonicaliser, white-box-signed logic, server-side signals; `document.all` proof is the hardest to fake |
| `document.all` false positive | none in real browsers | — | only browsers have the slot; sandbox detection is intended |
| Replay cache single-process | high in multi-instance deploys | replay | reference implementation documents replacing it with shared storage |
| SM2 nonce quality in sandbox | deterministic by design | test-only signatures | production uses WebCrypto entropy; documented |
| 700 KB bundle | — | load cost | table generators are lazy; ~30 ms parse in QuickJS |
| Statement-level instrumentation cost | — | analysis time | run with `code.level: 'off'`; static/API/JSVMP tracing still available |

## 4. Alternatives considered and rejected

- **WASM white-box:** smaller tables and better performance, but QuickJS/WASM
  availability varies, analysis becomes harder for the platform, and the
  “pure JS, no host APIs” portability goal is lost.
- **Reusing the platform's JSVMP builder:** the platform's VM is designed to be
  *analysable*; this SDK needs a different program, encrypted container,
  per-invocation remapping and three dispatchers. The ISA is separate.
- **Full Chow–Eisen–Johnson–van Oorschot MBF network:** strongest published
  design, large implementation and still broken by BGE; the selected byte-linear
  encodings plus CTR-only tables are a better cost/benefit ratio for a reference
  SDK.
- **Poly1305/ChaCha20-Poly1305:** attractive, but HMAC-SM3 keeps one hash family
  and one national-standard story; a second AEAD adds code without changing the
  threat model.
- **Per-device compiled bytecode:** impossible to ship one bundle for all
  devices; the container is per-build, and per-device secrecy lives in the
  derived keys.
- **Trusting `navigator.webdriver` alone:** trivially spoofed; it is one
  critical signal, not a verdict.

## 5. Research inputs

The primary sources behind each decision are listed in `RESEARCH.md`: the
Chow-style white-box construction and its published breaks (BGE, Michiels et
al.), the ECMAScript `IsHTMLDDA` semantics, JSVMP devirtualisation practice,
control-flow-flattening/opaque-predicate literature, canvas/WebGL fingerprinting
studies, and ECIES/HKDF/replay-window practice. The review used those sources to
reject claims the implementation cannot support (notably “white-box is
unbreakable” and “the sandbox is undetectable”).

## 6. Test coverage summary

| Area | Unit tests | Matrix checks | Platform test |
| --- | --- | --- | --- |
| Primitives | vectors + OpenSSL | 8 | yes |
| White-box | 12 suites + vault | 4 | yes |
| Mutants | round-trip + avalanche | 3 | yes |
| Envelope | round-trip + tamper | 4 | yes |
| Guard | document.all, policy, fake/empty | 5 | yes |
| Identity | stability + drift | 2 | yes |
| Signing | verify/replay/tamper/skew/sealed | 2 | yes |
| VM | canonical equivalence, variants, container | 3 | yes |
| Builds | host run, polymorphism, obfuscation | 5 | yes |
| Platform | analysis | 1 | yes |

The repository test suite (`tests/national-sdk.test.js`) runs the unit layer, a
host and sandbox integration, and the complete `verify.mjs` matrix.
