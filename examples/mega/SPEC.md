# MEGA suite specification — pure-JS, single-file works, ≥50MB effective code

## Hard requirements (enforced by `examples/mega/run-all.mjs`)

- **Exactly one JavaScript file per work** (`<slug>.js`). No subdirectories with
  code, no second `.js`, no `require`, `import`, `export`, `module.exports`,
  AMD `define`, `node:` imports, or `WebAssembly` usage. Pure JavaScript only;
  no external libraries. `work.json` and `README.md` are the only other files.
- **Effective code ≥ 2,800,000 bytes per work** (comments and blank lines
  stripped) and **≥ 50,000,000 bytes across the suite** on a full run.
- **Execution contract:** `node <entry>.js` exits 0, prints
  `MEGA SELFTEST OK` and one line
  `MEGA METRICS {"whitebox":N,"customCiphers":N,"encodings":N,"jsvmpOps":N,"envChecks":N,"polymorphicVariants":N,"mixedRounds":N,"documentAll":true,"antiDebug":N}`.
- Metrics minima: whitebox ≥3, customCiphers ≥3, encodings ≥3, jsvmpOps ≥1000,
  envChecks ≥50, polymorphicVariants ≥10, mixedRounds ≥1, documentAll=true,
  antiDebug ≥1.
- Manifest must declare:
  `protection: {blackhole:true, fortressJsvmp:true, dynamic:true, polymorphic:true, adversarial:true}`,
  `crypto: {whitebox:≥3, customCiphers:≥3, encodings:≥3, mixed:true}`,
  `environment: {renderingEngine:true}`.

## Content requirements

1. **Black-hole obfuscation**: multi-layer encrypted string/opcode tables,
   polymorphic decoders, control-flow flattening, dead branches, self-checksum,
   anti-debug traps (timing/stack/devtools), randomized per-instance constants.
2. **Fortress JSVMP**: at least one nested/encoded VM (opcode cipher, shuffled
   handlers, encoded const pool, stack integrity checks, VM-in-VM dispatch).
   Embedded bytecode must be substantial; self-test executes a small program and
   reports total embedded opcodes.
3. **Crypto**: ≥3 dynamic implicit white-box constructions (table-based SPN /
   Feistel / ARX, keys embedded implicitly and derived per instance), ≥3
   modified/custom ciphers (non-standard rounds/constants), ≥3 custom encodings
   (custom alphabet base-N, bit interleaving, Unicode mapping). Mixed pipeline:
   multiple rounds combining white-box → custom cipher → encoding with
   per-instance order.
4. **Environment detection at rendering-engine level**: `document.all`
   HTMLDDA semantics (`typeof document.all === 'undefined'`, falsy boolean,
   `.length`), CSS.supports/selectors, WebGL vendor/renderer/extensions,
   canvas pixels/toDataURL, font metrics, iframe cross-realm, audio, media,
   permissions, screen/DPR, matchMedia, Intl/timezone, storage/cookies,
   DOM constructors and layout geometry, worker/service-worker/WebAssembly
   availability. Must execute in Node with guarded absence and report checks.
5. **Volume source**: large *used* tables (white-box T-boxes, VM bytecode,
   polymorphic variant dispatch, probe matrices) generated into the single file.
   Self-test may validate a slice/checksum instead of executing all tables.
6. **Diversity**: each work uses different seeds/constants, different
   cipher/encoding compositions, different probe matrices and different
   protection layering. Different types (virus/SDK/app) have different top-level
   behavior.

## Analysis expectations

The works are deliberately large/hostile. `tools/cli.js` has an 8MB source
default limit; analysis can raise it with `--virtual-ms`/limits where needed, or
use the MEGA self-test as the primary gate. The MEGA runner is the authoritative
size/purity/capability verifier.
