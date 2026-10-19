# Research notes

The design is not improvised. This file records the primary sources behind each
non-obvious decision, and what the SDK deliberately does *not* claim.

## 1. Chinese national cryptography

| Source | What it fixed |
| --- | --- |
| GB/T 32918.1–5 (SM2) | curve `sm2p256v1`, `Z` digest, signature equation, default user ID `1234567812345678`, ECDH |
| GB/T 32905-2016 (SM3) | IV, message expansion, `P0`/`P1` permutations, padding |
| GB/T 32907-2016 (SM4) | S-box, `FK`/`CK`, linear transforms, decryption by reversed round keys |
| GM/T 0003.5 example vectors | end-to-end KAT: public key, `r`, `s` for `message digest` with fixed `k` |

Decision: SM2/SM3/SM4 are the interoperable core (server verification, MAC,
device identity). Custom algorithms are additive. The KAT is executable
(`verify.mjs` §1) rather than copied into prose.

## 2. White-box cryptography

| Source | Consequence for this design |
| --- | --- |
| Chow, Eisen, Johnson, van Oorschot, *White-Box Cryptography and an AES Implementation* (2002) | key-instantiated T-boxes, internal encodings, external encodings |
| Billet, Gilbert, Ech-Chatel, *Cryptanalysis of a White Box AES Implementation* (2005) | linear encodings are breakable; do not claim BGE resistance |
| Michiels, Gorissen, Hollmann, *Cryptanalysis of a Generic Class of White-Box Implementations* (2009) | generic attacks on table-based schemes; per-instance randomisation matters |
| Differential-fault / DFA work on white-box AES (Dusart et al.; later “code lifting” results) | protect table integrity at runtime; no decrypt tables |
| “Code lifting” literature | an attacker can call the tables instead of extracting the key; white-box raises cost, not secrecy |

Decisions taken from this literature:

- internal encodings are linear so 32-bit T-boxes can be XOR-combined, with
  random matrices per boundary and per instance;
- decrypt via CTR over the forward function, eliminating inverse tables and the
  inverse key schedule (half the surface, no key schedule to recover);
- a runtime table self-test (`selfTest`) catches patched tables;
- documentation states plainly that a live debugger defeats the scheme.

## 3. `document.all` and `[[IsHTMLDDA]]`

| Source | Consequence |
| --- | --- |
| ECMAScript specification: `ToBoolean`, abstract equality, and the `IsHTMLDDA` internal slot | `document.all` is falsy, `== null`, but not `=== undefined`, while `typeof` is `"undefined"` |
| WHATWG HTML: `document.all` / `HTMLAllCollection` | the property exists in every browser, even though it is deprecated |
| ECMAScript `typeof` semantics | `typeof` cannot be intercepted by proxies or `Symbol.toStringTag`; a real object always reports `"object"` |

Decision: treat a failure of the combined invariants as a **proof** of
non-browser execution. A JS-only sandbox cannot reproduce the slot; therefore
the platform’s QuickJS environment is detected. This is documented as an
expected finding, not hidden. Probing only `typeof` would be enough for the
proof, but the detector reports ten sub-checks so an analyst sees *why*.

## 4. JSVMP and devirtualisation

| Source | Consequence |
| --- | --- |
| Public work on virtualisation obfuscation and devirtualisation (dispatch-loop recovery, handler identification, symbolic execution of bytecode) | a single static dispatch loop is recoverable; vary the dispatcher and the opcode encoding |
| Practice in commercial anti-bot SDKs (VMProtect-style bytecode, encrypted handlers) | encrypt the container, authenticate it, remap opcodes at runtime |
| Taint/symbolic analysis of interpreters | keep the ISA small, the program short, and cross-check its output against a reference implementation |

Decisions:

- 48-opcode stack ISA restricted to what the signing program needs;
- build-time opcode permutation + per-invocation permutation + three dispatch
  strategies (direct table, routed table, binary search);
- encrypted and checksummed container; the key is a white-box keystream, not a
  literal;
- the JS layer independently recomputes the canonical request; a VM/reference
  mismatch aborts signing (`NSDK_VM_INTEGRITY`). This turns devirtualisation
  attempts into a denial of signing rather than a silent forgery.

## 5. Obfuscation and control-flow integrity

| Source | Consequence |
| --- | --- |
| Collberg, Thomborson, Low, *A Taxonomy of Obfuscating Transformations* (1997) | classify transformations; layer them |
| Control-flow flattening literature (Wang et al.; later “flattening” attacks) | state-machine dispatch with shuffled states and opaque predicates |
| Opaque predicate / dead-code literature | cheap, robust decoys when arithmetic identities are chosen carefully |
| String-encryption practice | per-build mask, decoder memoisation, encode object keys but not patterns |

Decisions:

- seven passes, each independently parameterised, but the build **executes** the
  result and verifies a signature; no pass is trusted on inspection alone;
- transformations that cannot be proven safe (e.g. wrapping a `let` in a block,
  computed keys in destructuring patterns) are skipped or rewritten;
- flattened `let/const` become `var` because the state machine re-enters the
  switch block (a TDZ trap found during review, see `DESIGN-REVIEW.md` #11).

## 6. Fingerprinting and anti-automation

| Source | Consequence |
| --- | --- |
| Canvas/WebGL/Audio fingerprinting research (Mowery & Shacham; later large-scale studies) | collect rendering surfaces, hash them, never send raw pixels |
| Headless-detection practice (`navigator.webdriver`, UA tokens, plugin arrays, window chrome) | separate automation signals from browser invariants; weights differ |
| Zero-trust principles (never trust a single signal; verify continuously) | proof signals separated; unknown lowers confidence; criticals need corroboration |
| Privacy research on fingerprint entropy | token bound to hardware-only fields; software changes do not mint new identities; drift is reported |

Decisions:

- 31 fingerprint fields, three stability classes, hardware-only device token;
- risk token is signed but treated as untrusted input by the server;
- `document.all` is the only proof; everything else is weighted evidence.

## 7. Hybrid encryption and protocol design

| Source | Consequence |
| --- | --- |
| ECIES-style constructions (SEC 1, ISO 18033-2) | ephemeral ECDH + KDF + symmetric layers + MAC |
| RFC 8439 (ChaCha20) | portable stream layer and test vectors |
| NIST SP 800-38A (CBC/CFB) | length-preserving CFB layers for block ciphers |
| HKDF (RFC 5869) | domain-separated per-layer keys and tag key |
| Replay-window practice (timestamp + nonce + body binding) | server-side cache, clock skew tolerance |

Decisions:

- white-box layers are device-only; envelope layers must be server-invertible;
- layer plan and parameters derive from the ECDH secret, so an attacker cannot
  pin a weak plan;
- two authenticators (SM2 + HMAC-SM3) over overlapping fields.

## 8. Open questions / further work

- Wire the custom ciphers into a formally analysed mode (e.g. a tweakable
  wide-block construction) instead of CFB composition.
- Add SM2 encryption (C1C3C2) as an alternative to ECDH + symmetric layers for
  small payloads.
- Evaluate whether a per-build generated dispatcher (source generation rather
  than runtime remapping) is worth the build complexity.
- Consider a WebAssembly white-box for hot paths, at the cost of portability.
- Add server-side risk correlation examples (account history, rate limits).
