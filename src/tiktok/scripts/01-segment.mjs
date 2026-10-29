#!/usr/bin/env node
/**
 * Segment the bundle into byte-disjoint chunks built from function boundaries.
 *
 * The whole bundle is one IIFE, so statement-depth cutting degenerates. Func-
 * tion nodes, however, are exact and semantic: take every function node that
 * is not nested inside another function (the "maximal" set), which tiles the
 * file up to inter-function glue, then greedily pack neighbours into chunks of
 * at most CHUNK_BYTES. Buckets never overlap, so parallel workers never touch
 * the same bytes.
 *
 * Emits under tmp/:
 *   pretty.js        formatted source (regenerable, one artifact)
 *   chunks/NNNN.js   chunk source with its offsets in a header comment
 *   chunk-map.json   machine-readable chunk table
 *   chunk-map.md     human-readable chunk table
 *   funcs.json       every function node with offsets and size
 *
 *   node scripts/01-segment.mjs [input]
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'

const generate = _generate.default ?? _generate
const traverse = _traverse.default ?? _traverse

const CHUNK_BYTES = 8192


const ROOT = path.resolve(import.meta.dirname, '..')
const INPUT = process.argv[2] ?? path.join(ROOT, 'resources/mssdk.min.js')
const TMP = path.join(ROOT, 'tmp')

const source = fs.readFileSync(INPUT, 'utf8')
const ast = parse(source, {
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
})

const pretty = generate(ast, { comments: true, compact: false }).code
fs.writeFileSync(path.join(TMP, 'pretty.js'), pretty)

// --- maximal function nodes -------------------------------------------------
const funcs = []
traverse(ast, {
  Function(p) {
    const n = p.node
    if (n.start == null || n.end == null) return
    funcs.push({ start: n.start, end: n.end, type: n.type, depth: p.getFunctionParent() ? 1 : 0 })
  },
})

funcs.sort((a, b) => a.start - b.start || b.end - a.end)

// --- choose cut units -------------------------------------------------------
// Greedy descent: walk functions in source order. A function that fits the
// budget and is not already inside an emitted unit becomes a unit. A function
// larger than the budget is skipped, so its children get considered next and
// fill it. This tiles the file bottom-up without ever overlapping.
funcs.sort((a, b) => a.start - b.start || a.end - b.end)

const units = []
let coveredTo = 0
for (const f of funcs) {
  if (f.start < coveredTo) continue
  if (f.end - f.start > CHUNK_BYTES) continue
  units.push({ start: f.start, end: f.end, kind: f.type })
  coveredTo = f.end
}

// --- pack into chunks -------------------------------------------------------
// Glue bytes between units are attributed to the preceding unit, and adjacent
// units are merged while the chunk stays under CHUNK_BYTES.
const buckets = []
let cursor = 0
for (const u of units) {
  const prev = buckets[buckets.length - 1]
  if (prev && u.end - prev.start <= CHUNK_BYTES) {
    prev.end = u.end
  } else {
    buckets.push({ start: prev ? prev.end : 0, end: u.end })
  }
  cursor = u.end
}
if (buckets.length > 0) buckets[buckets.length - 1].end = source.length
// Any leading glue belongs to the first bucket.
if (buckets.length > 0) buckets[0].start = 0
if (buckets.length === 0) buckets.push({ start: 0, end: source.length })

const merged = buckets

const chunksDir = path.join(TMP, 'chunks')
fs.rmSync(chunksDir, { recursive: true, force: true })
fs.mkdirSync(chunksDir, { recursive: true })

function safe(s) {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48)
}

function describe(text) {
  const fns = [...text.matchAll(/function\s*([A-Za-z_$][\w$]*)?\s*\(/g)].map((m) => m[1] ?? 'anon')
  const declares = [...text.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  const assigns = [...text.matchAll(/([A-Za-z_$][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=/g)].map(
    (m) => `${m[1]}.prototype.${m[2]}`,
  )
  const wins = [...text.matchAll(/\b(window|document|navigator|location|localStorage|performance|XMLHttpRequest|crypto)\b/g)]
  const namespaces = new Set(wins.map((m) => m[1]))
  return {
    fns: [...new Set(fns)].slice(0, 10),
    declares: [...new Set(declares)].slice(0, 10),
    assigns: [...new Set(assigns)].slice(0, 8),
    hostRefs: [...namespaces],
    fnCount: fns.length,
  }
}

const table = []
for (let i = 0; i < merged.length; i++) {
  const b = merged[i]
  const text = source.slice(b.start, b.end)
  const id = String(i).padStart(4, '0')
  const info = describe(text)
  const label = info.assigns[0] ?? info.declares[0] ?? info.fns[0] ?? 'misc'
  const file = path.join(chunksDir, `${id}-${safe(label)}.js`)
  fs.writeFileSync(
    file,
    `// chunk ${id}  offsets ${b.start}..${b.end}  ${text.length} bytes\n` +
      `// functions: ${info.fnCount}   declares: ${info.declares.join(',')}\n` +
      `// assigns:   ${info.assigns.join(',')}\n` +
      `// host refs: ${info.hostRefs.join(',')}\n` +
      `${text}\n`,
  )
  table.push({ id, label, start: b.start, end: b.end, bytes: text.length, file: path.relative(ROOT, file), ...info })
}

fs.writeFileSync(path.join(TMP, 'funcs.json'), JSON.stringify({ count: units.length, funcs: units }, null, 2))
fs.writeFileSync(
  path.join(TMP, 'chunk-map.json'),
  JSON.stringify({ input: INPUT, chunkBytes: CHUNK_BYTES, chunkCount: table.length, chunks: table }, null, 2),
)

const md = [
  `# chunk map — ${path.basename(INPUT)}`,
  `source ${source.length} bytes → ${table.length} disjoint chunks (target ${CHUNK_BYTES} B)`,
  `cut units: ${units.length}`,
  '',
  '| id | label | bytes | offsets | declares | assigns | host |',
  '|----|-------|-------|---------|----------|---------|------|',
]
for (const c of table) {
  md.push(
    `| ${c.id} | ${c.label} | ${c.bytes} | ${c.start}..${c.end} | ${c.declares.slice(0, 4).join(',')} | ${c.assigns.slice(0, 3).join(',')} | ${c.hostRefs.join(',')} |`,
  )
}
fs.writeFileSync(path.join(TMP, 'chunk-map.md'), md.join('\n') + '\n')

console.log(`pretty.js      ${pretty.length} bytes`)
console.log(`cut units      ${units.length}`)
console.log(`chunks         ${table.length}`)
const covered = table.reduce((n, c) => n + c.bytes, 0)
console.log(`coverage       ${covered} / ${source.length} (${((covered / source.length) * 100).toFixed(1)}%)`)
for (const c of table.slice(0, 12)) {
  console.log(`  ${c.id} ${c.label.padEnd(22)} ${String(c.bytes).padStart(7)}  ${c.start}..${c.end}`)
}
console.log(`map -> ${path.join(TMP, 'chunk-map.md')}`)
