# Verification guide

## 1. Prerequisites

- Node.js ≥ 22.18 (the repository engine requirement).
- `pnpm install` at the repository root (Babel, QuickJS, pino, z3).
- No network, no file or process I/O is performed by the SDK at runtime; the
  verifier only uses Node's `crypto` as an independent oracle.

## 2. Commands

```bash
# Rebuild the protected artifacts and run the full matrix (37 checks)
node examples/national-sdk/verify.mjs

# Build only
node examples/national-sdk/build/build-sdk.mjs --seeds 1001-1003

# Platform test entry (unit + sandbox + the matrix above)
node --test tests/national-sdk.test.js

# Whole repository
pnpm test
```

`verify.mjs` exits non-zero if any check fails and prints the failing checks at
the end. It is safe to run repeatedly; builds are deterministic per seed.

## 3. What each section proves

### §1 Published vectors and OpenSSL oracles

| Check | Evidence |
| --- | --- |
| SM3("abc"), SM3(abcd×16) | GB/T 32905 published digests |
| SM4 KAT | GB/T 32907 `681edf34…4246` |
| AES-128/256 KAT | FIPS 197 |
| SM2 known-answer signature | GM/T 0003.5 public key, `r`, `s` for message `message digest`, nonce `5927…bc21` |
| SM4/AES/SM3/SHA-256/HMAC-SM3 | 12 random blocks/hashes cross-checked against OpenSSL via Node `crypto` |
| ChaCha20 | 5 keystreams cross-checked against OpenSSL |
| SM2 ECDH | symmetry + off-curve rejection |

This is the strongest evidence that the primitives are not “self-consistent but
wrong”: two independent implementations agree, and the SM2 vector pins the
curve, the `Z` digest and the signature equation.

### §2 White-box suites and device vault

- 12 suites across three families are instantiated.
- AES/SM4 suites must produce byte-identical ciphertext to the reference cipher
  for the same key (equivalence, not “looks encrypted”).
- SPN suites must round-trip.
- Suite ids must be distinct: a seed change must produce different tables.
- `JSON.stringify(instance)` must not contain the key.
- The device vault seals state with six different suites, round-trips each,
  rejects ciphertext and suite tampering, and round-trips its transport form.

### §3 Mutated/custom ciphers

- 40 parameterisations round-trip (`decrypt(encrypt(x)) = x`).
- A one-bit input change must flip ≥ 32 of 128 output bits (avalanche), which
  catches degenerate or linear mutants.
- Keyed sponge and ARX stream must depend on the key/seed.

### §4 Hybrid envelopes

- 30 envelopes across random 3–5-layer plans round-trip through ECDH.
- At least 5 distinct plans are observed.
- Ciphertext, header (layer list/nonce), and tag tampering are all rejected.
- The compact transport form is lossless.
- Local (white-box) sealing rejects a different device key.

### §5 Zero-trust guard

- `document.all` fails on a synthetic browser with exactly the expected
  sub-checks (`typeof-undefined`, `falsy`, `loose-null`).
- Removing `document.all` entirely is detected.
- The synthetic browser passes ~42/45 signals; only the un-fakeable proof (and
  two Node-specific tells) fail. Its verdict is `hostile` because a proof
  failed — not because the detector rejects everything.
- An empty scope produces score 100 and ≥ 25 failures.
- Policy thresholds are exercised directly: all-pass → `trusted`, one failure →
  at least `guarded`, two criticals → `hostile`, proof → `hostile`, token
  round-trip.

### §6 Device identity and drift

- Two loads with the same storage produce the same token (`seen` increments).
- A screen change changes `hardwareHash` and the token, and drift attributes it
  to the hardware class.
- A UA (software) change leaves the token unchanged but changes `softwareHash`.
- Fingerprint coverage > 0.7 and hardware/software hashes differ.

### §7 Signing and server verification

- A clean signed request verifies with zero reasons.
- Replay is rejected by the nonce cache.
- Body tampering breaks both signature and MAC.
- Risk-header tampering breaks both.
- A 10-minute-old request is rejected by the timestamp window.
- A sealed body verifies and decrypts to the exact plaintext.

### §8 JSVMP

- 60 randomised requests produce a VM canonical string identical to the
  readable reference encoder.
- Plans contain 3–5 distinct valid layers; key ids are 16 hex chars.
- 40 seeds observe all 3 dispatch strategies and > 30 distinct opcode-remap
  prefixes.
- The container contains none of the plaintext markers, and a checksum tamper
  is rejected at load.
- 416 instructions are produced from the NSL source.

### §9 Protected builds

For each of three seeds:

- the bundle contains no `x-nsdk-sig`, `createSdk`, `SERVER_LAYERS`,
  `nsdk/device/v1` or `document.all` literals;
- module boundary names (`function __nsdk_m_`) are gone;
- the bundle runs on the host, `NSDK.create` works, `selfTest` passes and a
  sealed request verifies against the reference server.

Cross-build:

- three distinct hashes and three distinct opcode permutations;
- identical instruction count (the program is the same, only packaging differs).

Sandbox (build 1001):

- runs inside `TracelessSandbox` with statement instrumentation disabled;
- `selfTest.ok`, VM active, `localStorage` storage, fingerprint coverage > 0.5;
- `document.all` reported `fail` and `dom-document-all` present in evidence;
- guard level `hostile` (expected);
- the signature verifies with the server clock pinned to the guest timestamp
  (the harness clock is virtual and intentionally not wall time);
- host disposal record is `{ok: true, errors: []}`.

### §10 Platform analysis

`analyzeSample` runs the protected bundle with code instrumentation off and
produces a report: dynamic run OK, sample hash, techniques detected, verdict.
This proves the artifact is a first-class platform sample, not only a standalone
library. The verdict is heuristic: a hardened signing SDK legitimately trips the
platform's anti-analysis and obfuscation scoring, so the check requires a valid
report rather than a benign verdict.

## 4. Determinism

- Builds are deterministic per seed: VM key, opcode permutation, container,
  export names, obfuscation, string mask.
- Tests fix `seed: 0x5eed` for the sandbox and pin the verifier clock where the
  virtual clock is involved.
- Signatures are randomised by design (nonce/ephemeral key); tests assert
  verification, not signature equality.

## 5. Performance notes

- `verify.mjs` takes roughly 20–30 s on a laptop (three protected builds dominate;
  each build runs the bundler, the obfuscator and the VM container generation).
- Statement-level instrumentation of a 700 KB bundle costs ~1 minute; the
  integration paths explicitly set `instrumentation: { code: { level: 'off' } }`.
  Static analysis, API tracing, hooks and the JSVMP tracer still run.
- The sandbox memory limit is raised to 256 MB for bundle runs because white-box
  table generation is memory-hungry (lazily, one suite at a time).

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `timestamp-too-old` in a sandbox test | guest uses the virtual clock; pin the verifier `now` to the signed timestamp |
| `unknown-device-key` | provision the key id printed by `sdk.keyId` / `sdk.publicKey` |
| `NSDK_VM_TAMPER` | container checksum failed; rebuild rather than patching bytes |
| `NSDK_VM_INTEGRITY` | VM canonical string differs from the reference; a patch or a host-API change |
| verify is slow | three builds × ~700 KB + sandbox; pass `--no-build`-style reuse by not rebuilding (see `dist/`) |
| guard `hostile` on a normal desktop | check the evidence list; a privacy extension may block canvas/WebGL, but a proof failure means the environment is not a browser |
