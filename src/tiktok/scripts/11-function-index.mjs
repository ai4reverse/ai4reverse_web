#!/usr/bin/env node
/**
 * Build a navigable index of the 146 recovered bytecode functions.
 *
 * 8,515 instructions across 146 functions is unreadable without a map. This
 * derives one mechanically: per function, its size, the opcodes it uses most,
 * which functions create it, and any plaintext string constants it references.
 * Nothing here is interpreted — every column comes from the disassembly, the
 * control-flow graph, or the decrypted string table.
 *
 * Emits output/functions-index.md.
 *
 *   node scripts/11-function-index.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))
const table = JSON.parse(fs.readFileSync(path.join(TMP, 'opcode-table.json'), 'utf8'))
const byOpcode = new Map(table.opcodes.map((o) => [o.opcode, o]))

let strings = {}
try {
  strings = JSON.parse(fs.readFileSync(path.join(TMP, 'strings.json'), 'utf8'))
} catch {
  console.warn('tmp/strings.json missing — string columns will be empty')
}

// Decode handlers consume two table indices; the pair (key, payload) decrypts.
// For a cheap per-function signal, surface any plaintext we already know for the
// indices this function touches.
function plainFor(index) {
  const entry = strings[String(index)]
  return entry?.plain ?? entry?.plaintext ?? null
}

const rows = []
for (const fn of fnDoc.functions) {
  const body = disasm.instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  const hist = new Map()
  for (const ins of body) hist.set(ins.opcode, (hist.get(ins.opcode) ?? 0) + 1)
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)

  // Any known plaintext reachable from this function's operands.
  const hints = new Set()
  for (const ins of body) {
    for (const v of ins.operands) {
      const p = plainFor(v)
      if (p && typeof p === 'string' && p.length >= 2 && p.length <= 40) hints.add(p)
    }
  }

  rows.push({
    id: fn.id,
    start: fn.start,
    bytes: fn.bytes,
    instructions: fn.instructionCount,
    callers: fn.calledVia,
    top: top.map(([op, n]) => `${byOpcode.get(op)?.mnemonic ?? 'op' + op}×${n}`),
    hints: [...hints].slice(0, 6),
  })
}

const md = [
  '# Bytecode function index',
  '',
  `${rows.length} functions · ${disasm.instructionCount} instructions · ${disasm.bytecodeBytes} bytes`,
  '',
  'Every column is mechanical: sizes and opcodes from the disassembly, callers',
  'from `Y()` operand analysis, hints from the decrypted string table. Read the',
  'body of a function in `decompiled.js` by its `entry` offset.',
  '',
  '| fn | entry | bytes | instrs | created by | dominant opcodes | string hints |',
  '|----|-------|-------|--------|------------|------------------|--------------|',
]
for (const r of rows) {
  md.push(
    `| ${r.id} | ${r.start} | ${r.bytes} | ${r.instructions} | ${r.callers.join(',') || 'bootstrap'} | ${r.top.join(' ')} | ${r.hints.join(' ')} |`,
  )
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'functions-index.md'), md.join('\n') + '\n')

console.log(`functions indexed ${rows.length}`)
console.log(`output            ${path.join(OUT, 'functions-index.md')}`)
const largest = [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 5)
for (const r of largest) console.log(`  fn${String(r.id).padStart(3)} ${String(r.bytes).padStart(5)}B ${r.top.join(' ')}`)
