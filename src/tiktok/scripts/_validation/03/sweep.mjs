#!/usr/bin/env node
/**
 * Sweep candidate decompiled artifacts against the original under the frozen
 * gate wrapper, so the study runs on a pair that is actually green (or so the
 * redness is documented rather than assumed away).
 *
 *   node src/tiktok/scripts/_validation/03/sweep.mjs
 */

import path from 'node:path'
import fs from 'node:fs'
import { ORIGINAL, WORK, GATE, GATE_WRAPPER, runSide, gateMatched } from './lib.mjs'

const candidates = [
  'src/tiktok/output/runnable.min.js',
  'src/tiktok/output/runnable.js',
  'src/tiktok/output/final.js',
  'src/tiktok/output/lifted.js',
  'src/tiktok/output/decompiled-faithful.js',
  'src/tiktok/output/readable.js',
]

const t0 = Date.now()
const original = runSide(ORIGINAL, GATE_WRAPPER, { outFile: path.join(WORK, 'sweep-original.js'), seed: GATE.seed })
const rows = []
for (const rel of candidates) {
  const side = runSide(path.resolve(rel), GATE_WRAPPER, {
    outFile: path.join(WORK, `sweep-${path.basename(rel)}.js`),
    seed: GATE.seed,
  })
  rows.push({ candidate: rel, ok: side.ok, value: side.value, matched: gateMatched(original, side) })
  console.log(`${gateMatched(original, side) ? 'MATCH ' : 'DIFF  '} ${rel}  ok=${side.ok}  ${side.value}`)
}
fs.writeFileSync(path.join(WORK, 'sweep.json'), JSON.stringify({ original, rows, elapsedMs: Date.now() - t0 }, null, 2))
console.log('original', original.ok, original.value)
