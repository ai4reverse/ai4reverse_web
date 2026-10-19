# Algorithms and formats

## 1. Notation

- `SM3(M)` — GB/T 32905 hash, 32 bytes.
- `HMAC-SM3(K, M)` — HMAC with SM3, block size 64.
- `KDF(IKM, info, L)` — HKDF-style expander over HMAC-SM3:
  `PRK = HMAC-SM3(salt||0^32, IKM)`, `T(i) = HMAC-SM3(PRK, T(i-1) || info || i)`;
  output is the concatenation of `T(i)` truncated to `L`.
- `‖` — byte concatenation. All hex strings are lowercase.

## 2. Primitives

| Primitive | Parameters | Notes |
| --- | --- | --- |
| SM2 | sm2p256v1, Z from GB/T 32918.2, default ID `1234567812345678` | raw `r‖s`, DER helpers provided |
| SM3 | 256-bit | KAT `SM3("abc") = 66c7…a8e0` |
| SM4 | 128-bit block/key, 32 rounds | GB/T 32907 KAT `681e…4246` |
| AES | 128/256-bit key, 10/14 rounds | generated S-box (GF(2⁸) inverse + affine) |
| ChaCha20 | 256-bit key, 96-bit nonce, 32-bit counter | RFC 8439 |
| HMAC-SM3 | 64-byte block | used for MACs, KDF, token |
| Keyed sponge | ChaCha-like 6-round permutation, 32-byte output | custom hash |

## 3. Device key derivation

```
installSecret  ← 32 random bytes, sealed in localStorage (white-box SPN)
IV             = KDF(SM3(installSecret), "nsdk/device-key/v1", 16)
seed           = SPN.keystream(IV, 32)
d              = OS2IP(SM3(seed || counter)) mod (n-1) + 1     (counter 0..255)
P              = d·G
keyId          = SM3("nsdk/key/v1/" || hex(P))[0..8]
```

The private scalar never exists as a stored value: it is recomputed from the
SPN keystream and the install secret on each run. Losing the install secret
creates a new identity; changing only software fields keeps the same identity.

## 4. Request signature

Canonical request:

```
METHOD\n
PATH\n
sorted(percentEncode(k)=percentEncode(v), joined by &)\n
hex(SM3(exact transmitted body bytes))\n
lowercased signed headers, sorted, "name:value" joined by \n
\n
```

Signed string:

```
SM3( canonical ‖ "|" ‖ timestamp ‖ "|" ‖ nonce ‖ "|" ‖ deviceToken ‖ "|" ‖ riskToken )
```

- `timestamp`: Unix milliseconds.
- `nonce`: 16 random bytes (32 hex).
- `riskToken`: `level[0] + base36(score) + "." + base36(confidence*100)`.

Signature: SM2 over the ASCII of that 64-hex digest string, with `Z` bound to
the device public key. Headers (`x-nsdk-*`): `v, kid, ts, nonce, fp, risk, sig,
mac`, optionally `body: sealed` and `env: v1`.

Header MAC:

```
macKey = KDF(ECDH(d, serverPublic), "nsdk/sign/v1/mac/" + keyId, 32)
mac    = HMAC-SM3(macKey, sig ‖ "|" ‖ ts ‖ "|" ‖ nonce ‖ "|" ‖ fp ‖ "|" ‖ risk ‖ "|" ‖ canonical)
```

`ECDH(d, serverPublic)` equals `ECDH(serverPrivate, P)`, so the server derives
the same key without any device secret being transmitted.

## 5. Hybrid envelope

```json
{
  "v": 1,
  "kid": "<device key id>",
  "eph": "<uncompressed SM2 ephemeral public key, hex>",
  "nonce": "<16-byte hex>",
  "layers": ["sm4-cfb", "chacha20", "subst"],
  "enc": "b62",
  "ct": "<base62 ciphertext>",
  "tag": "<32-byte HMAC-SM3 hex>"
}
```

Construction:

```
ephScalar   = OS2IP(SM3(SPN.keystream(IV, 32))) mod (n-1) + 1
shared      = ECDH(ephScalar, serverPublic)             (64 bytes x‖y)
secrets     = { alphabet, tagKey, planKey } = KDF(shared, "nsdk/hybrid/v1/*/nonce", …)
plan        = 3..5 distinct layers from the catalogue (VM-selected)
for i, layer in plan:
    key, iv, aux = KDF(shared, "nsdk/hybrid/v1/i/layer/nonce/…", …)
    data = layer.apply(data, key, iv, aux)
ct          = radix62(data, alphabet)
tag         = HMAC-SM3(tagKey, canonicalHeader ‖ "|" ‖ ct)
```

Canonical header: `nsdk1|kid|eph|nonce|layers.join(",")|enc`.

- `mutant-*`, `subst`, `perm` parameters are derived from `aux`, so the server
  reconstructs exactly the same algorithm without extra fields.
- `chacha20` nonce is `KDF(aux, "nonce", 16)[0..12]`.
- `radix62` uses a per-envelope shuffled alphabet; leading zero bytes are
  encoded as leading alphabet[0] sentinels.
- Transport form: `nsdk1.<base64url(JSON)>`.

Layer catalogue:

| id | family | length-preserving | server invertible |
| --- | --- | --- | --- |
| `sm4-cfb` / `aes-cfb` | CFB | yes | yes |
| `chacha20` | stream | yes | yes |
| `arx` | custom ARX stream | yes | yes |
| `mutant-aes-cfb` / `mutant-sm4-cfb` | mutated CFB | yes | yes (params from aux) |
| `rc6-cfb` / `magma-cfb` | ARX/Feistel CFB | yes | yes |
| `subst` | keyed byte S-box | yes | yes |
| `perm` | keyed 16-byte permutation | yes | yes |
| `wb-aes-ctr` / `wb-sm4-ctr` | white-box CTR, tables generated from the ECDH `aux` | yes | yes (server regenerates identical tables from the shared secret) |
| white-box SPN | CTR | yes | **no** (device-only, used for the vault and key ladder) |

## 6. Device vault (local sealing, device-only)

Persisted state (install secret, previous hardware fingerprint, counters) is
sealed by a **randomly selected white-box suite** on every save:

```
suite     ∈ {wb-aes/a..d, wb-sm4/a..d, wb-spn/a..d}   (chosen per save)
salt      = 8 random bytes
vaultKey  = KDF(buildKey, "nsdk/vault/v1/" + suite + "/" + salt, 32)
instance  = WhiteBoxSuite(suite, seed = buildSalt + "::vault/" + salt,
                          key  = vaultKey[0..16] or full 32 for SPN)
ct        = instance.encrypt(nonce, payload)           (CTR)
tagKey    = KDF(vaultKey, "tag", 32)
tag       = HMAC-SM3(tagKey, "nsdkv1|suite|salt|nonce|enc" + "|" + base62(ct))
```

The envelope is `{v, suite, salt, nonce, enc, ct, tag}`. Loading regenerates the
named suite from `buildSalt`, the build key and the stored salt; no tables are
stored, and a tampered suite/salt/tag fails authentication. Because the suite
and salt change on every save, two sessions use different algorithms, tables and
encodings for the same state.

Device key derivation and the VM key also pass through the white-box SPN
(§3 and §8). White-box AES/SM4 are *not* used as envelope layers: the server
could not invert them, so those layers are standard/mutated ciphers whose
parameters derive from ECDH.

## 7. White-box constructions

### 7.1 AES-128 (implicit key, linear internal encodings)

State is 16 bytes, column-major. For each boundary `r = 0..9` and position `p`,
pick a random invertible GF(2)⁸-linear map `E[r][p]`.

- Initial round: `T0[p][x] = E[0][p](x ^ k0[p])` (key folded into the table).
- Rounds 1..9: for target column `c` and source row `p`,
  `T[r][c][p][x] = E[r][c*4+t]( MixColumns[t][p] · S( E[r-1][src]⁻¹(x) ) )`,
  `src = ((c+p) mod 4)*4 + p`.
  The round key is added as an encoded mask `E[r][p](rk[r][p])`.
- Round 10: `S(decode(x)) ^ k10`, plaintext output.

XOR of four encoded contributions equals the encoding of the XOR because every
internal map is linear; this is what allows 32-bit T-boxes with byte encodings.
The key exists only inside `T0` and the encoded masks. CTR uses the forward
function only.

### 7.2 SM4 (implicit round keys, per-word encodings)

`X[r+4] = X[r] ^ L(τ(X[r+1] ^ X[r+2] ^ X[r+3] ^ rk[r]))`.

- Each word `w` has four linear byte encodings `E[w][0..3]`.
- The decode table for `X[r+1]` folds the round-key bytes:
  `D1[j][v] = E[r+1][j]⁻¹(v) ^ rk[r][j]`.
- `A[j] = D1[j][x1] ^ D2[j][x2] ^ D3[j][x3]` (plaintext byte).
- `U[r][j][a] = E[r+4][t]( L(τ(a) << (24-8j)) )` for the four output bytes.
- `XD[r][j][v] = E[r+4][j]( E[r][j]⁻¹(v) )` re-encodes `X[r]`.
- The encoded word is `XOR_j U[r][j][A[j]] ^ XD[r][*]`, i.e. the encoding of
  `L(τ(A)) ^ X[r]`.

No round key is stored; it is absorbed into `D1`. 36 word environments are
generated per instance.

### 7.3 SPN (key as tables)

For 16 positions, `S_i = FisherYates(PRNG(HMAC-SM3(key, "nsdk/spn/sbox/" + i)))`.
14 rounds: substitute with `S_i`, XOR a public round constant, multiply by a
public invertible 4×4 GF(2⁸) matrix, rotate columns. There is no key schedule:
the S-boxes *are* the key. Used for local sealing, the device key seed and the
VM key.

## 8. VM

### 8.1 ISA

48 handler ids (fixed): constants/locals/args, arithmetic, bitwise, comparisons,
`typeof`, jumps, property get/set (static and computed), array/object literals,
`CALL`, `CALL_METHOD`, `RETURN`, `HALT`, conversions.

### 8.2 Container

```
{ v: 1, perm: [handlerId per build code], code: base64url(XOR(JSON, KDF(key,"code",len))), sum: SM3(JSON), bytes }
```

`JSON = { v, locals, consts, code: [[buildCode, ...args]], steps }`.
The checksum is verified before execution; the opcode permutation must be a
bijection over 0..47.

### 8.3 Execution

Per invocation:

```
sessionMap = PRNG(key ‖ runSeed).shuffle(0..47)
runtimeCode = sessionMap[buildCode]
handler     = perm[runtimeCode]
variant     = PRNG.int(3)
```

Dispatch variants: direct function table, routed two-level table, binary search
over a sorted `(runtimeCode, handler)` array. Instruction budget defaults to
2,000,000; PC bounds are checked every step.

### 8.4 Protected program

The signing program (416 instructions) percent-encodes and sorts query pairs,
builds header lines, the canonical request and signature base, derives session
material, chooses the envelope layer plan, and derives the VM key id. The JS
layer recomputes the canonical request and aborts on mismatch.

## 9. Obfuscation passes

| Pass | Transformation | Safety argument |
| --- | --- | --- |
| flatten | top-level statement list → shuffled state machine | `let/const` converted to `var`; nested loops/returns unchanged; unique state ids |
| opaque | wrap statements in `if ((n²-n) % 2 === 0)` | integer identity |
| dead | `if (n !== n) { junk }` | NaN comparison is false |
| shuffle | randomise switch case order | cases have unique labels and explicit `continue`/`return` |
| mangle | rename bindings via Babel scope table | no `eval`/`with` in the bundle |
| numbers | `n` → `a ^ b` | integer identity |
| strings | UTF-16 units XOR per-build mask in a decoder call; keys → computed | decoder mask keyed by hex offset |
| decoy | unused numeric functions | unreachable |
