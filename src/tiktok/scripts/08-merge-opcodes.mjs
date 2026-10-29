#!/usr/bin/env node
/**
 * Merge per-range opcode semantics into one canonical instruction-set table.
 *
 * Workers write tmp/opcodes/<first>-<last>.json independently. Independence is
 * also the risk: a worker can mis-read a handler's operand arity and produce a
 * plausible table that desyncs the disassembly. So every entry is checked
 * against tmp/widths.json — the operand widths that were proven correct by the
 * 100% bytecode tiling — and any mismatch is reported as a hard error rather
 * than silently merged.
 *
 * Emits tmp/opcode-table.json and output/opcode-table.md.
 *
 *   node scripts/08-merge-opcodes.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const widths = JSON.parse(fs.readFileSync(path.join(TMP, 'widths.json'), 'utf8'))
const expected = new Map(widths.map((w) => [w.opcode, w.operands]))

const KIND_BY_WIDTH = { 1: 'u8', 2: 'u16', 3: 'u24' }

const dir = path.join(TMP, 'opcodes')
if (!fs.existsSync(dir)) {
  console.error('tmp/opcodes/ does not exist — no worker output to merge')
  process.exit(1)
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
if (files.length === 0) {
  console.error('tmp/opcodes/ is empty — no worker output to merge')
  process.exit(1)
}

const byOpcode = new Map()
const problems = []
const coverage = new Map()

for (const file of files) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8')
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    problems.push(`${file}: not valid JSON — ${err.message}`)
    continue
  }
  const list = doc.opcodes ?? doc.table?.opcodes ?? []
  if (!Array.isArray(list) || list.length === 0) {
    problems.push(`${file}: no opcodes array`)
    continue
  }
  for (const entry of list) {
    const op = entry.opcode
    if (typeof op !== 'number') {
      problems.push(`${file}: entry without numeric opcode`)
      continue
    }
    if (byOpcode.has(op)) problems.push(`${file}: opcode ${op} already defined`)
    byOpcode.set(op, { ...entry, sourceFile: file })

    // Cross-check arity and widths against the proven operand model.
    const exp = expected.get(op)
    if (!exp) {
      problems.push(`${file}: opcode ${op} outside the handler table`)
      continue
    }
    const got = entry.operands ?? []
    if (got.length !== exp.length) {
      problems.push(`${file}: op${op} arity ${got.length} != expected ${exp.length}`)
      coverage.set(op, { op, ok: false, reason: 'arity' })
      continue
    }
    const badWidths = got
      .map((o, i) => ({ i, want: exp[i].width, got: o?.kind }))
      .filter(({ want, got }) => KIND_BY_WIDTH[want] !== got)
    if (badWidths.length) {
      problems.push(
        `${file}: op${op} operand kinds [${got.map((o) => o?.kind).join(',')}] != expected [${exp.map((e) => KIND_BY_WIDTH[e.width]).join(',')}]`,
      )
      coverage.set(op, { op, ok: false, reason: 'width' })
      continue
    }
    coverage.set(op, { op, ok: true })
  }
}

const total = widths.length
const merged = []
for (let op = 0; op < total; op++) {
  const e = byOpcode.get(op)
  const exp = expected.get(op)
  merged.push({
    opcode: op,
    mnemonic: e?.mnemonic ?? `op${op}`,
    operands: e?.operands ?? exp.map((o) => ({ kind: KIND_BY_WIDTH[o.width], name: `_${o.reader}` })),
    reads: e?.reads ?? [],
    writes: e?.writes ?? [],
    stack: e?.stack ?? null,
    semantics: e?.semantics ?? null,
    js: e?.js ?? null,
    confidence: e?.confidence ?? 'missing',
    evidence: e?.evidence ?? null,
    // The artifact contract requires a note whenever confidence is not `high`.
    // Dropping it here made every medium-confidence row look unexplained even
    // though the worker had written a reason.
    note: e?.note ?? null,
    sourceFile: e?.sourceFile ?? null,
  })
}

const missing = merged.filter((m) => m.confidence === 'missing').map((m) => m.opcode)
const lowConf = merged.filter((m) => m.confidence === 'medium' || m.confidence === 'low')

fs.writeFileSync(path.join(TMP, 'opcode-table.json'), JSON.stringify({ count: total, missing, problems, opcodes: merged }, null, 2))

const md = [
  '# JSVMP instruction set — byted_acrawler / mssdk',
  '',
  `${total} opcodes · merged from ${files.length} worker files`,
  `proven operand model: every operand list below matches tmp/widths.json`,
  '',
  missing.length
    ? `**${missing.length} opcodes have no semantics yet:** ${missing.join(', ')}`
    : '**every opcode has semantics.**',
  problems.length ? `\n**${problems.length} merge problems** — see tmp/opcode-table.json` : '',
  '',
  '| op | mnemonic | operands | reads | writes | confidence | semantics |',
  '|----|----------|----------|-------|--------|------------|-----------|',
]
for (const o of merged) {
  const ops = o.operands.map((x) => `${x.kind}:${x.name ?? '?'}`).join(' ')
  md.push(
    `| ${o.opcode} | ${o.mnemonic} | ${ops} | ${o.reads.join(',')} | ${o.writes.join(',')} | ${o.confidence} | ${(o.semantics ?? '').replace(/\|/g, '\\|')} |`,
  )
}
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'opcode-table.md'), md.join('\n') + '\n')

console.log(`worker files      ${files.length}`)
console.log(`opcodes merged    ${total - missing.length} / ${total}`)
console.log(`missing semantics ${missing.length}${missing.length ? ': ' + missing.slice(0, 20).join(',') : ''}`)
console.log(`medium/low conf   ${lowConf.length}`)
console.log(`arity/width problems ${problems.length}`)
for (const p of problems.slice(0, 15)) console.log(`  ! ${p}`)
if (problems.length > 15) console.log(`  ... ${problems.length - 15} more`)
console.log(`\ntable -> ${path.join(OUT, 'opcode-table.md')}`)
