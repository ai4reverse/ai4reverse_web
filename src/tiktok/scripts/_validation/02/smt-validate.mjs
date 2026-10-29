#!/usr/bin/env node
/**
 * SMT translation validation over every instruction of the required functions.
 *
 * For each distinct (opcode, operands) shape used by a function in the required
 * coverage set, `smt-eval.mjs` proves the handler's data operation and branch
 * condition equal to the emitter's translation. Shapes outside the modeled
 * fragment (calls, memory, strings, closures) are reported with the refusing
 * construct, never silently passed.
 *
 * Emits validation/02-semantics/smt-results.json and smt-by-function.csv.
 *
 *   node src/tiktok/scripts/_validation/02/smt-validate.mjs [--limit N] [--timeout MS]
 */

import fs from 'node:fs'
import path from 'node:path'
import { proveShape } from '../../../../tiktok/validation/02-semantics/smt-eval.mjs'
import { translateHandler } from '../../15-lift.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const SRC = path.join(REPO, 'src/tiktok')
const TMP = path.join(SRC, 'tmp')
const V = path.join(SRC, 'validation/02-semantics')

const ARGS = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name)
  return i >= 0 ? ARGS[i + 1] : fallback
}
const LIMIT = Number(opt('--limit', '0'))
const TIMEOUT = Number(opt('--timeout', '800'))

const handlers = JSON.parse(fs.readFileSync(path.join(V, 'extracted/handlers-exact.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const opcodeTable = JSON.parse(fs.readFileSync(path.join(TMP, 'opcode-table.json'), 'utf8'))
const functions = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8')).functions

/* --- the same required coverage set the concrete harness uses ------------- */
const cfgByAt = new Map(cfg.instructions.map((i) => [i.at, i]))
const starts = new Set(functions.map((f) => f.start))
function fnIdAt(offset) {
  for (const f of functions) if (f.start <= offset && offset < f.end) return f.id
  return null
}
function leadersOf(fn) {
  const leaders = new Set([fn.start])
  const own = new Set(disasm.instructions.filter((i) => fn.start <= i.at && i.at < fn.end).map((i) => i.at))
  for (const ins of disasm.instructions) {
    if (ins.at < fn.start || ins.at >= fn.end) continue
    for (const s of cfgByAt.get(ins.at)?.successors ?? []) if (s >= fn.start && s < fn.end) leaders.add(s)
    if (cfg.controlHandlers.includes(ins.opcode) && own.has(ins.next)) leaders.add(ins.next)
  }
  return leaders
}
function writesReg4(ins) {
  const meta = opcodeTable.opcodes[ins.opcode]
  if (!meta) return false
  const writes = new Set(meta.writes)
  return meta.operands.some((o, k) => o.kind === 'u16' && writes.has(o.name) && ins.operands[k] === 4)
}
const op218 = new Set()
const back = new Set()
const reg4 = new Set()
for (const ins of disasm.instructions) {
  if (ins.opcode === 218) op218.add(fnIdAt(ins.at))
  for (const s of cfgByAt.get(ins.at)?.successors ?? []) if (s <= ins.at) back.add(fnIdAt(ins.at))
}
for (const fn of functions) {
  const leaders = leadersOf(fn)
  const own = new Set(disasm.instructions.filter((i) => fn.start <= i.at && i.at < fn.end).map((i) => i.at))
  for (const ins of disasm.instructions) {
    if (ins.at < fn.start || ins.at >= fn.end) continue
    if (!writesReg4(ins)) continue
    if (!own.has(ins.next) || leaders.has(ins.next)) reg4.add(fn.id)
  }
}
const REQUIRED = new Set([44, 340, ...op218, ...back, ...reg4].filter((x) => x !== null))

/* --- shapes --------------------------------------------------------------- */
const requiredInstructions = disasm.instructions.filter((ins) => REQUIRED.has(fnIdAt(ins.at)))
const shapeKey = (ins) => `${ins.opcode}:${ins.operands.join(',')}`
const shapeMap = new Map()
for (const ins of requiredInstructions) {
  const key = shapeKey(ins)
  if (!shapeMap.has(key)) shapeMap.set(key, { key, opcode: ins.opcode, operands: ins.operands, count: 0, functions: new Set() })
  const row = shapeMap.get(key)
  row.count++
  row.functions.add(fnIdAt(ins.at))
}
let shapes = [...shapeMap.values()].sort((a, b) => b.count - a.count)
if (LIMIT > 0) shapes = shapes.slice(0, LIMIT)
console.log(`required functions      ${REQUIRED.size}`)
console.log(`instructions covered    ${requiredInstructions.length}`)
console.log(`distinct shapes         ${shapeMap.size}  (validating ${shapes.length})`)

const started = Date.now()
const results = []
let done = 0
for (const shape of shapes) {
  let outcome
  let ir = null
  try {
    ir = translateHandler(shape.opcode, shape.operands)
  } catch (err) {
    outcome = { status: 'unsupported', reason: `emitter refused: ${err.message}` }
  }
  if (!outcome) {
    const handler = handlers[shape.opcode]
    if (!handler) outcome = { status: 'unsupported', reason: 'no handler source' }
    else if (!ir) outcome = { status: 'unsupported', reason: 'no emitter IR' }
    else {
      try {
        outcome = await proveShape(handler.source, ir, shape.operands, { timeoutMs: TIMEOUT })
      } catch (err) {
        outcome = { status: 'error', reason: err.message }
      }
    }
  }
  results.push({ ...shape, functions: [...shape.functions].sort((a, b) => a - b), ...outcome })
  if (++done % 200 === 0) process.stderr.write(`  ${done}/${shapes.length} shapes\n`)
}

const tally = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
console.log('shape tally', JSON.stringify(tally), `${((Date.now() - started) / 1000).toFixed(1)}s`)

// Instruction-weighted coverage.
const weight = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + r.count), m), {})
console.log('instruction-weighted', JSON.stringify(weight))

/* --- per function --------------------------------------------------------- */
const byShape = new Map(results.map((r) => [r.key, r]))
const perFunction = []
for (const fn of functions) {
  if (!REQUIRED.has(fn.id)) continue
  const own = disasm.instructions.filter((i) => fn.start <= i.at && i.at < fn.end)
  const counts = { total: own.length, proved: 0, unsupported: 0, refuted: 0, error: 0 }
  const reasons = new Map()
  for (const ins of own) {
    const row = byShape.get(shapeKey(ins))
    if (!row) {
      counts.unsupported++ // shape was cut by --limit
      continue
    }
    counts[row.status] = (counts[row.status] ?? 0) + 1
    if (row.status === 'unsupported') {
      const reason = row.reason ?? 'out of model'
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
  }
  const dominant = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0] ?? null
  perFunction.push({
    id: fn.id,
    total: counts.total,
    proved: counts.proved,
    unsupported: counts.unsupported,
    refuted: counts.refuted ?? 0,
    error: counts.error ?? 0,
    status: counts.refuted ? 'refuted' : counts.proved === counts.total ? 'proved' : 'partial',
    dominantReason: dominant ? dominant[0] : null,
    provedShare: Number(((counts.proved / counts.total) * 100).toFixed(1)),
  })
}

fs.writeFileSync(
  path.join(V, 'smt-results.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      target: 'resources/mssdk.min.js',
      requiredFunctions: REQUIRED.size,
      instructions: requiredInstructions.length,
      distinctShapes: shapeMap.size,
      validatedShapes: shapes.length,
      tallies: { byShape: tally, byInstruction: weight },
      perFunction,
      shapes: results,
    },
    null,
    2,
  ) + '\n',
)

const csv = ['fn_id,instructions,smt_proved,smt_unsupported,smt_refuted,status,proved_share_pct,dominant_reason']
for (const r of perFunction.sort((a, b) => a.id - b.id)) {
  const reason = String(r.dominantReason ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')
  csv.push(`${r.id},${r.total},${r.proved},${r.unsupported},${r.refuted},${r.status},${r.provedShare},"${reason}"`)
}
fs.writeFileSync(path.join(V, 'smt-by-function.csv'), csv.join('\n') + '\n')

const fnTally = perFunction.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
console.log('per-function', JSON.stringify(fnTally))
console.log('refuted data shapes:', results.filter((r) => r.status === 'refuted').length)
for (const r of results.filter((x) => x.status === 'refuted').slice(0, 10)) {
  console.log(`  op${r.opcode} ${JSON.stringify(r.operands)} ${JSON.stringify(r.failures).slice(0, 200)}`)
}
console.log(`written ${path.relative(REPO, path.join(V, 'smt-results.json'))}`)
