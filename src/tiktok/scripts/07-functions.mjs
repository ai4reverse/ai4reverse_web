#!/usr/bin/env node
/**
 * Resolve true function entry points and rebuild reachability.
 *
 * Not every u24 operand is a function entry: most are ordinary jump targets
 * inside a function. The authoritative signal is `Y(entry, parent, this, args,
 * x, arity)` — the VM re-entry helper — whose FIRST argument is a bytecode
 * offset. This maps, for each of the handlers that call `Y`, which operand
 * index feeds that argument, then treats only those operand values as function
 * entries. Everything else is an intra-function branch target.
 *
 * Reachability is then computed from the entry set (the VM model: functions are
 * entered by `Y`, not by falling through), which is what makes "is every
 * instruction accounted for" a meaningful question.
 *
 * Emits tmp/functions.json and tmp/functions.md.
 *
 *   node scripts/07-functions.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')

const widths = JSON.parse(fs.readFileSync(path.join(TMP, 'widths.json'), 'utf8'))
const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const code = fs.readFileSync(path.join(TMP, 'bytecode.bin'))

const instructions = cfg.instructions
const byStart = new Map(instructions.map((i) => [i.at, i]))
const startSet = new Set(instructions.map((i) => i.at))

// --- 1. which operand index feeds Y's first argument? ----------------------
const handlersDir = path.join(TMP, 'handlers')

/**
 * Literal `Y(<number>, …)` targets, collected across every handler.
 *
 * Not every re-entry names its entry through an operand. The module bootstrap
 * calls the public API that way — `Y(98959, t, this, arguments, 0, 8)` is
 * `setTTWid` — so the entry is a plain number in the handler source. Recording
 * only operand-fed entries left 246 of 376 calls pointing at offsets that were
 * never treated as function boundaries, and their bodies stayed inlined in
 * whichever function happened to span them.
 */
const literalYTargets = []

function entryOperandIndexes(handlerSrc, opcode) {
  // The extracted handler files are `// header` lines followed by an anonymous
  // `function (n) {…}` expression, which is not a statement — wrap it so the
  // parser accepts it.
  const body = handlerSrc
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n')
    .trim()
  const ast = parse(`(${body})`, { sourceType: 'script', errorRecovery: true }).program.body[0].expression
  let operandCounter = 0
  // Map variable name -> operand index in byte-stream order.
  const nameToOperand = new Map()
  const found = []

  traverse(
    { type: 'File', program: { type: 'Program', sourceType: 'script', body: [ast], directives: [] } },
    {
      VariableDeclarator(p) {
        const { id, init } = p.node
        if (id?.type !== 'Identifier' || init?.type !== 'CallExpression') return
        const callee = init.callee
        if (callee?.type !== 'Identifier') return
        const w = { J: 2, L: 1, K: 3 }[callee.name]
        if (!w) return
        nameToOperand.set(id.name, { index: operandCounter, width: w, reader: callee.name })
        operandCounter++
      },
      CallExpression(p) {
        // One handler can define several functions in one instruction: op19
        // emits two closures from two separate K operands. Every `Y` call whose
        // first argument traces back to an operand is a function entry.
        if (p.node.callee?.type !== 'Identifier' || p.node.callee.name !== 'Y') return
        const arg0 = p.node.arguments[0]
        if (arg0?.type === 'Identifier' && nameToOperand.has(arg0.name)) {
          found.push(nameToOperand.get(arg0.name))
        } else if (arg0?.type === 'NumericLiteral') {
          literalYTargets.push({ opcode, offset: arg0.value })
        }
      },
    },
  )
  return found
}

const entryOpcodeMap = new Map()
for (const f of fs.readdirSync(handlersDir)) {
  // Only the extracted handler sources. Anything else that lands in this
  // directory — an editor's sidecar, a tool's scratch folder — is not a handler
  // and must not be read as one.
  if (!f.endsWith('.js')) continue
  const idx = Number(f.replace(/\.js$/, ''))
  if (!Number.isInteger(idx)) continue
  const src = fs.readFileSync(path.join(handlersDir, f), 'utf8')
  if (!/\bY\(/.test(src)) continue
  const infos = entryOperandIndexes(src, idx)
  if (infos.length) entryOpcodeMap.set(idx, infos)
}

console.log(`handlers calling Y(): ${[...entryOpcodeMap.keys()].length}`)
for (const [op, infos] of [...entryOpcodeMap.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  op${String(op).padStart(3)}  entries = ${infos.map((i) => `operand[${i.index}](${i.reader})`).join(' ')}`)
}

// --- 2. collect function entries -------------------------------------------
const entries = new Map() // offset -> {via: Set<opcode>}
function addEntry(off, opcode) {
  if (!startSet.has(off)) return false
  if (!entries.has(off)) entries.set(off, { via: new Set() })
  entries.get(off).via.add(opcode)
  return true
}

addEntry(0, -1) // the VM bootstrap entry
let resolvedCalls = 0
for (const ins of instructions) {
  const infos = entryOpcodeMap.get(ins.opcode)
  if (!infos) continue
  for (const info of infos) {
    const off = ins.operands[info.index]
    if (off == null) continue
    if (addEntry(off, ins.opcode)) resolvedCalls++
  }
}

// Re-entries whose entry offset is written literally in the handler, not fed
// through an operand slot (`Y(98959, …)`). Without these the public API entry
// points — init, report, setTTWebid, frontierSign — are not function
// boundaries, and their bodies stay inlined inside the bootstrap.
let literalCalls = 0
for (const { offset, opcode } of literalYTargets) {
  if (addEntry(offset, opcode)) literalCalls++
}

const entryOffsets = [...entries.keys()].sort((a, b) => a - b)
console.log(`\nfunction entries: ${entryOffsets.length} (from ${resolvedCalls} operand calls + ${literalCalls} literal calls + bootstrap)`)

// --- 3. reachability over the whole entry set ------------------------------
const reachable = new Set()
const queue = [...entryOffsets]
while (queue.length) {
  const at = queue.pop()
  if (reachable.has(at)) continue
  reachable.add(at)
  const ins = byStart.get(at)
  if (!ins) continue
  for (const s of ins.successors) queue.push(s)
}
const unreachable = instructions.filter((i) => !reachable.has(i.at))

// --- 4. function regions ---------------------------------------------------
const functions = []
for (let i = 0; i < entryOffsets.length; i++) {
  const start = entryOffsets[i]
  const end = i + 1 < entryOffsets.length ? entryOffsets[i + 1] : code.length
  const body = instructions.filter((ins) => ins.at >= start && ins.at < end)
  const live = body.filter((ins) => reachable.has(ins.at))
  const meta = entries.get(start)
  functions.push({
    id: i,
    start,
    end,
    bytes: end - start,
    instructionCount: body.length,
    reachableCount: live.length,
    calledVia: [...meta.via].filter((v) => v >= 0).map((v) => `op${v}`),
    isBootstrap: start === 0,
  })
}

fs.writeFileSync(
  path.join(TMP, 'functions.json'),
  JSON.stringify(
    {
      bytecodeBytes: code.length,
      instructionCount: instructions.length,
      entryOpcodeMap: Object.fromEntries([...entryOpcodeMap.entries()]),
      entryCount: entryOffsets.length,
      reachable: reachable.size,
      unreachable: unreachable.length,
      functions,
    },
    null,
    2,
  ),
)

const md = [
  '# bytecode functions',
  '',
  `bytecode ${code.length} B · ${instructions.length} instructions · ${entryOffsets.length} functions`,
  `reachable ${reachable.size} / ${instructions.length} (${((reachable.size / instructions.length) * 100).toFixed(1)}%)`,
  '',
  'Opcode → entry-operand mapping:',
  '',
  '| opcode | entry operand | reader |',
  '|--------|---------------|--------|',
  ...[...entryOpcodeMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([op, infos]) => `| ${op} | ${infos.map((i) => i.index).join(',')} | ${[...new Set(infos.map((i) => i.reader))].join('/')} |`),
  '',
  '| fn | start | end | bytes | instrs | reachable | called via |',
  '|----|-------|-----|-------|--------|-----------|------------|',
]
for (const f of functions) {
  md.push(
    `| ${f.id} | ${f.start} | ${f.end} | ${f.bytes} | ${f.instructionCount} | ${f.reachableCount} | ${f.calledVia.join(',')} |`,
  )
}
fs.writeFileSync(path.join(TMP, 'functions.md'), md.join('\n') + '\n')

console.log(`reachable          ${reachable.size} / ${instructions.length} (${((reachable.size / instructions.length) * 100).toFixed(1)}%)`)
console.log(`unreachable        ${unreachable.length}`)
if (unreachable.length) {
  console.log(`  first 10 unreachable offsets: ${unreachable.slice(0, 10).map((i) => i.at).join(', ')}`)
}
console.log('\n=== largest functions ===')
for (const f of [...functions].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
  console.log(`  fn${String(f.id).padStart(4)}  ${String(f.start).padStart(6)}..${String(f.end).padStart(6)}  ${String(f.bytes).padStart(5)}B  ${String(f.instructionCount).padStart(4)} ins  via ${f.calledVia.join(',')}`)
}
