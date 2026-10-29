#!/usr/bin/env node
/**
 * Baseline probe: confirm both artifacts run under the frozen gate wrapper and
 * that the reproduced predicate agrees with 29-verify.mjs.
 *
 *   node src/tiktok/scripts/_validation/03/probe.mjs
 */

import path from 'node:path'
import { ORIGINAL, DECOMPILED, WORK, GATE, GATE_WRAPPER, MATRIX_WRAPPER, runSide, gateMatched } from './lib.mjs'

const t0 = Date.now()
const original = runSide(ORIGINAL, GATE_WRAPPER, {
  outFile: path.join(WORK, 'probe-original.js'),
  seed: GATE.seed,
})
const decompiled = runSide(DECOMPILED, GATE_WRAPPER, {
  outFile: path.join(WORK, 'probe-decompiled.js'),
  seed: GATE.seed,
})
const matched = gateMatched(original, decompiled)

console.log(JSON.stringify({ elapsedMs: Date.now() - t0, original, decompiled, matched }, null, 2))

const matrix = []
for (const cfg of [
  { aid: 1233, url: 'https://www.tiktok.com/api/', times: 1 },
  { aid: 424242, url: 'https://www.tiktok.com/api/', times: 1 },
  { aid: 1233, url: 'https://www.tiktok.com/api/search/general/full/?keyword=abc', times: 1 },
  { aid: 1233, url: 'https://www.tiktok.com/api/', times: 2 },
]) {
  const side = runSide(ORIGINAL, MATRIX_WRAPPER, {
    outFile: path.join(WORK, `probe-matrix-${cfg.aid}-${cfg.times}-${Buffer.from(cfg.url).toString('hex').slice(0, 8)}.js`),
    seed: GATE.seed,
    args: cfg,
  })
  matrix.push({ cfg, side })
}
console.log(JSON.stringify({ matrix }, null, 2))
