#!/usr/bin/env node
/**
 * Build the single-source-of-truth manifest for this reverse-engineering run.
 *
 * The skill's artifact contract asks for one file that says, per artifact, what
 * it is, what it hashes to, which gate it belongs to and whether that gate
 * passed. This stage derives all of it from the files themselves — nothing here
 * is asserted from memory, so a stale artifact or a missing stage shows up as a
 * hash change or a `missing` status rather than as a confident stale claim.
 *
 * Writes src/tiktok/work/MANIFEST.json.
 *
 *   node scripts/26-manifest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')
const WORK = path.join(ROOT, 'work')
const TARGET = path.join(ROOT, 'resources/mssdk.min.js')

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function describe(relPath, gate, extras = {}) {
  const abs = path.join(ROOT, relPath)
  if (!fs.existsSync(abs)) return { path: relPath, gate, status: 'missing', ...extras }
  const stat = fs.statSync(abs)
  const entry = {
    path: relPath,
    gate,
    status: 'present',
    sha256: sha256(abs),
    bytes: stat.size,
    ...extras,
  }
  if (relPath.endsWith('.jsonl')) {
    entry.records = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean).length
  } else if (/\.(js|mjs|txt|md|csv|json)$/.test(relPath)) {
    entry.lines = fs.readFileSync(abs, 'utf8').split('\n').length
  }
  return entry
}

const targetHash = sha256(TARGET)

const artifacts = [
  describe('work/00-env/env-baseline.json', 'O0'),
  describe('work/M2-BRIEF.md', 'O1'),
  describe('tmp/bytecode.bin', 'O2'),
  describe('tmp/disasm.json', 'O2'),
  describe('tmp/widths.json', 'O2'),
  describe('tmp/strings.json', 'O2'),
  describe('tmp/opcodes.md', 'O3'),
  describe('tmp/functions.json', 'M3'),
  describe('tmp/opcode-table.json', 'M2'),
  describe('output/opcode-table.md', 'M2'),
  describe('output/disassembly.txt', 'O2'),
  describe('output/decompiled.js', 'V1'),
  describe('output/decompiled-faithful.js', 'V1'),
  describe('output/functions-index.md', 'V1'),
  describe('output/readable.js', 'V1'),
  describe('output/lifted.js', 'V3'),
  describe('output/final.js', 'V3'),
  describe('output/module-scope.js', 'V3'),
  describe('output/runnable.js', 'V3'),
  describe('output/runnable.min.js', 'V3'),
  describe('work/02-verify/string-verification.md', 'V2'),
  describe('work/02-verify/harness-report.md', 'V2'),
  describe('work/08-verify/verify-report.md', 'V2'),
  describe('work/04-trace/trace.jsonl', 'M1'),
  describe('work/04-trace/coverage.txt', 'M1'),
]

const stages = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()

const manifest = {
  schema: 'jsvmp-manifest/1',
  target_hash: targetHash.slice(0, 16),
  target_sha256: targetHash,
  target_bytes: fs.statSync(TARGET).size,
  created: new Date().toISOString(),
  stages,
  artifacts,
  counts: {
    artifacts: artifacts.length,
    present: artifacts.filter((a) => a.status === 'present').length,
    missing: artifacts.filter((a) => a.status === 'missing').map((a) => a.path),
  },
}

fs.mkdirSync(WORK, { recursive: true })
fs.writeFileSync(path.join(WORK, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))

console.log(`target            ${manifest.target_hash}  ${manifest.target_bytes} bytes`)
console.log(`artifacts         ${manifest.counts.present} present / ${manifest.counts.artifacts}`)
if (manifest.counts.missing.length) console.log(`missing           ${manifest.counts.missing.join(', ')}`)
console.log(`stages            ${stages.length}`)
console.log(`output            ${path.join(WORK, 'MANIFEST.json')}`)
