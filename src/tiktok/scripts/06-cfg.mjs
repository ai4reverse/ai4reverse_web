#!/usr/bin/env node
/**
 * Recover the bytecode's function and control-flow structure.
 *
 * Jump targets and function entry points are absolute u24 operands (handlers do
 * `n.u = K(n)` and `Y(entry, …)`). A real target always lands on an instruction
 * boundary, so membership in the instruction-start set separates genuine
 * targets from numbers that merely look like offsets. That test needs no
 * per-opcode semantics and fails loudly when the operand model drifts.
 *
 * Emits under tmp/:
 *   cfg.json      per-instruction successors, targets, entry points
 *   functions.md  function table with size, instruction count, callers
 *
 *   node scripts/06-cfg.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')

const widths = JSON.parse(fs.readFileSync(path.join(TMP, 'widths.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const code = fs.readFileSync(path.join(TMP, 'bytecode.bin'))

if (!disasm.tiled) {
  console.error('refusing to build a CFG over a disassembly that does not tile')
  process.exit(1)
}

const instructions = disasm.instructions
const startSet = new Set(instructions.map((i) => i.at))
const byStart = new Map(instructions.map((i) => [i.at, i]))

// --- 1. classify operands ---------------------------------------------------
// u24 operands are the only ones wide enough for a bytecode offset. Mark one as
// a jump target when it lands exactly on an instruction start.
let jumpTargets = 0
let u24Total = 0
for (const ins of instructions) {
  const spec = widths[ins.opcode].operands
  ins.operandMeta = ins.operands.map((value, idx) => {
    const { width, reader } = spec[idx] ?? {}
    const isOffsetCandidate = width === 3
    if (isOffsetCandidate) u24Total++
    const isTarget = isOffsetCandidate && startSet.has(value)
    if (isTarget) jumpTargets++
    return { value, width, reader, isTarget }
  })
  ins.targets = ins.operandMeta.filter((m) => m.isTarget).map((m) => m.value)
}

// --- 2. successor edges -----------------------------------------------------
// A handler transfers control instead of falling through when it assigns `n.u`
// directly (jump/branch) OR calls `H(n)`, which pops the frame stack and sets
// `n.u` to the caller's resume offset. Both must be terminators or the
// reachability walk silently stops at every `return`.
const CONTROL_HANDLERS = new Set()
const handlerDir = path.join(TMP, 'handlers')
for (const f of fs.readdirSync(handlerDir)) {
  const src = fs.readFileSync(path.join(handlerDir, f), 'utf8')
  const idx = Number(f.replace(/\.js$/, ''))
  if (/n\.u\s*=/.test(src) || /\bH\(/.test(src)) CONTROL_HANDLERS.add(idx)
}

for (const ins of instructions) {
  const hasExplicitControl = CONTROL_HANDLERS.has(ins.opcode)
  if (hasExplicitControl) {
    ins.successors = [...new Set(ins.targets)]
    ins.kind = 'branch'
  } else {
    ins.successors = startSet.has(ins.next) ? [ins.next] : []
    ins.kind = 'next'
  }
}

// --- 3. entry points --------------------------------------------------------
// Any jump target that no other instruction reaches by fall-through is a
// candidate function or block entry. Function entries additionally appear as
// u24 operands of the 16 handlers that call Y(...).
const fallThroughTargets = new Set(instructions.filter((i) => i.kind === 'next').map((i) => i.next))
const explicitTargets = new Set(instructions.flatMap((i) => (i.kind === 'branch' ? i.targets : [])))

const entries = new Set([0])
for (const t of explicitTargets) {
  if (!fallThroughTargets.has(t)) entries.add(t)
}

// --- 4. reachability from the VM entry --------------------------------------
const reachable = new Set()
const queue = [0]
while (queue.length) {
  const at = queue.pop()
  if (reachable.has(at)) continue
  reachable.add(at)
  const ins = byStart.get(at)
  if (!ins) continue
  for (const s of ins.successors) queue.push(s)
}

// --- 5. function regions ----------------------------------------------------
// Sort every entry point and treat the span up to the next entry as one
// function. This is a partition, not a proof: report it as such.
const entryList = [...entries].sort((a, b) => a - b)
const callersOf = new Map()
for (const ins of instructions) {
  if (ins.kind !== 'branch') continue
  for (const t of ins.targets) {
    if (!callersOf.has(t)) callersOf.set(t, new Set())
    callersOf.get(t).add(ins.at)
  }
}

const functions = []
for (let i = 0; i < entryList.length; i++) {
  const start = entryList[i]
  const end = i + 1 < entryList.length ? entryList[i + 1] : code.length
  const body = instructions.filter((ins) => ins.at >= start && ins.at < end)
  const reachableHere = body.filter((ins) => reachable.has(ins.at)).length
  functions.push({
    id: i,
    start,
    end,
    bytes: end - start,
    instructions: body.length,
    reachableInstructions: reachableHere,
    callers: [...(callersOf.get(start) ?? [])].slice(0, 12),
    isEntry: start === 0,
  })
}

fs.writeFileSync(
  path.join(TMP, 'cfg.json'),
  JSON.stringify(
    {
      bytecodeBytes: code.length,
      instructionCount: instructions.length,
      u24OperandCount: u24Total,
      jumpTargetCount: jumpTargets,
      controlHandlers: [...CONTROL_HANDLERS].sort((a, b) => a - b),
      entryCount: entryList.length,
      reachableInstructions: reachable.size,
      functions,
      instructions: instructions.map((i) => ({
        at: i.at,
        opcode: i.opcode,
        operands: i.operands,
        kind: i.kind,
        successors: i.successors,
      })),
    },
    null,
    2,
  ),
)

const md = [
  '# bytecode function table',
  '',
  `bytecode ${code.length} B, ${instructions.length} instructions, ${entryList.length} entry points`,
  `u24 operands ${u24Total}, of which ${jumpTargets} land on an instruction boundary`,
  `reachable from entry 0: ${reachable.size} / ${instructions.length} instructions`,
  '',
  '| fn | start | end | bytes | instrs | reachable | callers |',
  '|----|-------|-----|-------|--------|-----------|---------|',
]
for (const f of functions) {
  md.push(
    `| ${f.id} | ${f.start} | ${f.end} | ${f.bytes} | ${f.instructions} | ${f.reachableInstructions} | ${f.callers.join(',')} |`,
  )
}
fs.writeFileSync(path.join(TMP, 'functions.md'), md.join('\n') + '\n')

console.log(`u24 operands        ${u24Total}`)
console.log(`valid jump targets  ${jumpTargets}`)
console.log(`control handlers    ${CONTROL_HANDLERS.size}`)
console.log(`entry points        ${entryList.length}`)
console.log(`reachable instrs    ${reachable.size} / ${instructions.length} (${((reachable.size / instructions.length) * 100).toFixed(1)}%)`)
console.log('\n=== largest function regions ===')
for (const f of [...functions].sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
  console.log(`  fn${String(f.id).padStart(3)}  ${String(f.start).padStart(6)}..${String(f.end).padStart(6)}  ${String(f.bytes).padStart(6)}B  ${String(f.instructions).padStart(5)} ins  callers=${f.callers.length}`)
}
const unreachable = instructions.filter((i) => !reachable.has(i.at)).length
console.log(`\nunreachable instructions: ${unreachable}`)
