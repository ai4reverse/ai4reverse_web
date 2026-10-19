#!/usr/bin/env node
/**
 * Restoration walkthrough: the same Babel parse -> pass chain -> generate
 * pipeline used by the CLI, with per-pass attribution.
 *
 * Run: node examples/restore-demo.mjs [sample.js]
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { restore } from '../tools/index.js'

const file = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))
const targets = process.argv[2]
  ? [process.argv[2]]
  : ['string-array-obfuscated.js', 'control-flow-flattened.js', 'jsfuck-lite.js', 'sample-loader.js']

for (const target of targets) {
  const source = target.startsWith('/') ? await readFile(target, 'utf8') : await readFile(file(target), 'utf8')
  const result = restore(source, { filename: target, maxRounds: 2 })

  console.log(`\n=== ${target} ===`)
  console.log(
    `bytes: ${Buffer.byteLength(source)} -> ${Buffer.byteLength(result.code)} ` +
      `(${result.stats.changedPasses} pass(es) changed, ${result.rounds} round(s), ${result.stats.durationMs}ms)`,
  )
  console.log('passes:')
  for (const pass of result.passes) {
    const state = pass.changed ? 'changed' : 'no-op  '
    const note = pass.notes?.[0] ? ` — ${pass.notes[0]}` : ''
    console.log(`  ${pass.id.padEnd(16)} ${state} ${String(pass.durationMs).padStart(4)}ms${note}`)
  }
  console.log('restored excerpt:')
  console.log(
    result.code
      .split('\n')
      .slice(0, 12)
      .map((line) => `  ${line}`)
      .join('\n'),
  )
}
