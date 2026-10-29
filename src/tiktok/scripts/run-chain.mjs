#!/usr/bin/env node
/**
 * Rebuild the decompiled bundle: 16 → 17 → 18 → 21 → 22 → 23 → 24 → 27.
 *
 * Convenience wrapper for the boot investigation; each stage is a separate,
 * independent script and this only sequences them. Stage output is shown for
 * the ones that report a decision (nest/emit) and hidden otherwise.
 *
 *   node src/tiktok/scripts/run-chain.mjs [--quiet]
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const STAGES = [
  '16-emit-lifted.mjs',
  '17-final.mjs',
  '18-simplify.mjs',
  '21-module-vars.mjs',
  '22-nest.mjs',
  '23-liveness.mjs',
  '24-header.mjs',
  '27-bundle-min.mjs',
]
const VERBOSE = new Set(['16-emit-lifted.mjs', '22-nest.mjs'])
const quiet = process.argv.includes('--quiet')

for (const stage of STAGES) {
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, stage)], { encoding: 'utf8' })
  if (run.status !== 0) {
    process.stdout.write(run.stdout ?? '')
    process.stderr.write(run.stderr ?? '')
    console.error(`stage ${stage} failed (${run.status})`)
    process.exit(1)
  }
  if (!quiet && VERBOSE.has(stage)) {
    const lines = (run.stdout ?? '').trim().split('\n')
    console.log(`--- ${stage} ---`)
    console.log(lines.filter((l) => /cell init|state slots|nested|multi-parent|upvalues|parses/.test(l)).join('\n'))
  }
}
if (!quiet) console.log('chain ok')
