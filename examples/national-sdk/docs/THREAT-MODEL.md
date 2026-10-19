# Threat model

## 1. Assets

| Asset | Where it lives | Impact if lost |
| --- | --- | --- |
| Device signing key (SM2 scalar) | derived at runtime from the white-box keystream + install secret; never persisted | forged requests attributed to a device |
| Install secret | sealed in `localStorage` by the white-box SPN | device identity cloning |
| VM bytecode / signing program | encrypted container in the bundle | static replication of the signing logic |
| White-box tables | generated at runtime; never serialized | key extraction from tables (static) |
| Fingerprint and risk verdict | device only; only the token + risk token leave | privacy, evasion |
| Server static SM2 key | server / HSM | decryption of every envelope |

## 2. Adversaries

| Adversary | Capability | Mitigations |
| --- | --- | --- |
| **Static analyst** | owns the bundle, can read/decompile it | encrypted VM container, per-build opcode permutation, string table, control-flow flattening, table-generated white-box, randomised exports |
| **Dynamic analyst** | can pause execution, dump memory, hook functions | white-box raises the cost but *does not stop* this adversary; keys are derivable once tables are dumped |
| **Emulator / sandbox operator** | tries to impersonate a browser | zero-trust guard, `document.all` proof, rendering/consistency layers |
| **Network attacker** | can read/modify requests | SM2 signature, HMAC-SM3 MAC, hybrid envelope with tag, replay window |
| **Malicious client** | can patch the SDK and sign arbitrary requests | signatures only prove possession of a device key; risk token is advisory; server must rate-limit and correlate |
| **Replay attacker** | replays a captured request | timestamp window + nonce cache + body-bound signature/MAC |

## 3. Trust boundaries

1. **Device bundle** — untrusted by the server, even when signed. Everything sent
   is a claim until verified against a provisioned public key.
2. **Signing key** — derived, not stored. The derivation input (white-box
   keystream + sealed install secret) is the real secret material.
3. **Server verifier** — the only component that decides whether a request is
   authentic. The device's risk token never substitutes for verification.
4. **Platform sandbox** — for analysis only. It is explicitly not a browser and
   the SDK is designed to notice that (`document.all`).

## 4. What the design protects against

- **Passive capture**: envelope confidentiality via ECDH-derived layer keys;
  integrity via SM3-based tag and signature.
- **Request tampering**: canonical request covers method, path, query, signed
  headers and body hash; SM2 and HMAC cover overlapping fields.
- **Header rewriting**: MAC covers signature + timestamp + nonce + token + risk +
  canonical request.
- **Replay**: 5-minute window, nonce cache, body binding.
- **Static key extraction**: white-box tables embed the key; no key value is a
  property of any object; the VM container is encrypted and checksummed.
- **Naive sandboxing**: 45 independent signals including an unfakeable browser
  invariant.
- **Algorithm fingerprinting**: per-request random layer plan, mutated ciphers,
  per-request radix alphabet, per-build obfuscation.

## 5. What it does **not** protect against

- A debugger that dumps white-box tables and reconstructs the key schedule. This
  is inherent to software white-box cryptography; the design goal is cost, not
  impossibility.
- A patched client that removes the guard and signs with a stolen device key.
- Server-side fraud committed with a legitimately signed request.
- A compromised browser extension with access to the page's JS heap.
- Side-channel attacks (cache/timing) against `BigInt` SM2 in the browser.
- Quantum adversaries (SM2/ECDH are not post-quantum).

## 6. White-box assumptions

The white-box instances assume the attacker has the bundle and can read every
table. Their value is:

1. **No key literal** to grep for; key recovery requires solving the encoding
   layers (Chow-style T-boxes with random linear internal encodings).
2. **Per-instance randomisation**: two sessions on the same device produce
   different tables for the same key, so a recorded attack does not transfer.
3. **No decryption tables**: CTR over the forward function halves the table
   surface and eliminates the inverse key schedule.
4. **Table integrity is self-tested** at runtime (`sdk.selfTest()`), so patched
   tables are detected by the SDK itself.

Residual: BGE-style attacks against linear encodings remain applicable; the
design does not claim resistance beyond “raises static-analysis cost”.

## 7. Privacy

The SDK collects fingerprint fields locally to produce a stable token. Only the
token, the device public key id and a compact risk token are transmitted; raw
canvas pixels, fonts and WebGL strings stay on the device. A deployment should:

- document the fields collected and the retention of the token;
- treat the token as a pseudonym, not a legal identity;
- avoid sending the full fingerprint unless the user consented;
- rotate the install secret on account reset to unlink identities.

## 8. Server-side checklist

- Provision device public keys out of band; never trust a key sent in a request.
- Verify signature **and** MAC; reject if either fails.
- Enforce the timestamp window and nonce cache atomically (the reference cache is
  single-process; use Redis/DB in production).
- Decrypt sealed bodies only after tag verification.
- Rate-limit per token/IP/account and correlate risk tokens with anomalies.
- Treat `hostile` as a signal for step-up authentication, not as proof of fraud.
- Keep the server clock authoritative; devices lie about time.
