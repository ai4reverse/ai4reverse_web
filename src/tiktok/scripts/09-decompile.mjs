#!/usr/bin/env node
/**
 * Decompile the JSVMP bytecode into readable JavaScript.
 *
 * The bytecode is a register-machine program over a 365-opcode native-semantics
 * instruction set. This emits, per recovered function, one JS statement per
 * instruction: straight-line ops become assignments, control-transfer ops become
 * labels and `goto`-style comments, and every line keeps its bytecode offset so
 * any claim can be traced back to a byte.
 *
 * Fidelity rule: an instruction whose semantics are unknown is emitted as an
 * explicitly marked placeholder. A decompiler that invents plausible code for
 * an opcode it does not understand produces output nobody can trust, so the
 * unknown count is printed and recorded rather than papered over.
 *
 * Emits output/decompiled.js and output/disassembly.txt.
 *
 *   node scripts/09-decompile.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const table = JSON.parse(fs.readFileSync(path.join(TMP, 'opcode-table.json'), 'utf8'))
const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))

// Jump targets and successor edges live in cfg.json, not disasm.json. Without
// merging them in, every branch degenerates into a straight line and the
// control-flow structure silently disappears.
const cfgByOffset = new Map(cfg.instructions.map((i) => [i.at, i]))
for (const ins of disasm.instructions) {
  const c = cfgByOffset.get(ins.at)
  ins.targets = c?.successors ?? []
  ins.kind = c?.kind ?? 'next'
}

const byOpcode = new Map(table.opcodes.map((o) => [o.opcode, o]))
const instructions = disasm.instructions
const byStart = new Map(instructions.map((i) => [i.at, i]))
const control = new Set(cfg.controlHandlers)

const REG = (n) => `r${n}`

/** Render one instruction as { code, comment, unknown }. */
function render(ins) {
  const spec = byOpcode.get(ins.opcode)
  const operandText = ins.operands.length ? ins.operands.join(', ') : ''

  if (!spec || spec.confidence === 'missing' || !spec.js) {
    return {
      code: null,
      comment: `op${ins.opcode}${operandText ? ` ${operandText}` : ''}`,
      unknown: true,
    }
  }

  // Substitute operand names with the concrete values the instruction carries.
  let js = spec.js
  const names = spec.operands.map((o, i) => [o.name ?? `a${i}`, ins.operands[i]])
  for (const [name, value] of names) {
    if (!name) continue
    js = js.replaceAll(new RegExp(`\\b${name}\\b`, 'g'), `r${value}`)
  }

  const isBranch = control.has(ins.opcode)
  const targets = isBranch ? [...new Set(ins.targets)] : []

  // A worker's `js` gloss is prose-adjacent: some contain ellipses or trailing
  // notes that are not valid JavaScript. Emit as code only what actually
  // parses; otherwise keep the text as a comment so the listing stays valid and
  // the reason is visible rather than being silently dropped.
  let executable = true
  try {
    parse(`(async()=>{ ${js} })`, { sourceType: 'module' })
  } catch {
    executable = false
  }

  return {
    code: executable ? js : null,
    prose: executable ? null : js,
    comment: `op${ins.opcode}${operandText ? ` (${operandText})` : ''}`,
    unknown: false,
    isBranch,
    targets,
    mnemonic: spec.mnemonic,
  }
}

// --- emit -------------------------------------------------------------------
const out = []
let unknownCount = 0
let proseCount = 0
let totalCount = 0

out.push('/*')
out.push(' * Decompiled JSVMP program — TikTok mssdk / byted_acrawler')
out.push(' *')
out.push(` *   bytecode      ${disasm.bytecodeBytes} bytes`)
out.push(` *   instructions  ${instructions.length}`)
out.push(` *   functions     ${fnDoc.functions.length}`)
out.push(` *   opcodes       ${table.opcodes.length} (${table.missing.length} without semantics)`)
out.push(' *')
out.push(' * Registers are rN. V(r) reads a register through the cell boundary,')
out.push(' * A[r] is the raw slot, W(r,v) writes, C(r,v) allocates a cell.')
out.push(' *')
out.push(' * Each line ends with its opcode mnemonic and its REAL operand values in')
out.push(' * parentheses. Register names in the code come from the worker table and a')
out.push(' * name can be bound to the wrong slot; the values are what let a reader see')
out.push(' * that. When a name and a value disagree, output/decompiled-faithful.js is')
out.push(' * authoritative — it inlines the real handler with the operands substituted.')
out.push(' *')
out.push(' * Bytecode offset of each instruction is given as the @N prefix.')
out.push(' * Instructions whose opcode had no recovered semantics are marked UNKNOWN')
out.push(' * and counted, never guessed.')
out.push(' */')
out.push('')
out.push('const S = 14; // registers below this are mutable cells {v: value}')
out.push('const A = [];')
out.push('function V(r) { return r >= S ? A[r].v : A[r]; }')
out.push('function W(r, v) { if (r >= S) A[r].v = v; else A[r] = v; }')
out.push('function C(r, v) { A[r] = { v }; }')
out.push('')

for (const fn of fnDoc.functions) {
  const body = instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  out.push(`// ---------------------------------------------------------------------------`)
  out.push(
    `// function #${fn.id}  entry ${fn.start}  span ${fn.bytes} B  ${fn.instructionCount} instructions` +
      (fn.calledVia.length ? `  (created by ${fn.calledVia.join('/')})` : ''),
  )
  out.push(`// ---------------------------------------------------------------------------`)
  out.push(`function fn_${fn.id}(...args) {   // VM re-entry at ${fn.start}`)
  out.push(`  A[6] = args;`)

  const labels = new Set(body.flatMap((i) => (control.has(i.opcode) ? i.targets : [])))

  for (const ins of body) {
    // Labels and gotos are emitted as comments: `goto` is not JavaScript, and
    // an emitted-but-invalid file would be worse than a listing that parses.
    // The control-flow structure stays readable and the file stays loadable.
    if (labels.has(ins.at)) out.push(`  // L_${ins.at}:`)
    const r = render(ins)
    totalCount++
    const head = `  /* @${String(ins.at).padEnd(6)} */ `
    // Print the instruction's real operand values on every line. Register names
    // in the code come from the worker table; a name can be bound to the wrong
    // slot, and the values are what lets a reader see that. When they disagree,
    // output/decompiled-faithful.js is authoritative.
    const ops = ins.operands.length ? ` (${ins.operands.join(',')})` : ''
    if (r.unknown) {
      unknownCount++
      out.push(`${head}// UNKNOWN ${r.comment}`)
      continue
    }
    if (r.prose) {
      proseCount++
      out.push(`${head}// ${r.prose}   // ${r.mnemonic ?? r.comment}${ops}`)
      continue
    }
    if (r.isBranch) {
      const targets = r.targets
      if (targets.length === 0) {
        out.push(`${head}{ ${r.code} }   // ${r.mnemonic ?? r.comment}${ops}; transfers control out of this function`)
        continue
      }
      out.push(`${head}{ ${r.code} }   // ${r.mnemonic ?? r.comment}${ops}`)
      if (targets.length === 1) out.push(`  // -> L_${targets[0]}`)
      else out.push(`  // -> ${targets.map((t) => `L_${t}`).join(' | ')}`)
      continue
    }
    out.push(`${head}{ ${r.code} }   // ${r.mnemonic ?? r.comment}${ops}`)
  }

  out.push(`}`)
  out.push('')
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'decompiled.js'), out.join('\n') + '\n')

// --- annotated disassembly ---------------------------------------------------
const dis = []
dis.push(`; JSVMP disassembly — ${instructions.length} instructions, ${disasm.bytecodeBytes} bytes`)
dis.push('; offset   opcode  operands                              width  mnemonic')
for (const ins of instructions) {
  const spec = byOpcode.get(ins.opcode)
  const ops = ins.operands.map((v) => `0x${v.toString(16)}`).join(' ')
  dis.push(
    `${String(ins.at).padStart(7)}  ${String(ins.opcode).padStart(4)}  ${ops.padEnd(36)} ${String(ins.next - ins.at).padStart(4)}   ${spec?.mnemonic ?? '?'}`,
  )
}
fs.writeFileSync(path.join(OUT, 'disassembly.txt'), dis.join('\n') + '\n')

console.log(`functions emitted  ${fnDoc.functions.length}`)
console.log(`instructions       ${totalCount}`)
console.log(`unknown semantics  ${unknownCount} (${((unknownCount / totalCount) * 100).toFixed(1)}%)`)
console.log(`prose-only glosses ${proseCount} (${((proseCount / totalCount) * 100).toFixed(1)}%) emitted as comments`)
console.log(`output             ${path.join(OUT, 'decompiled.js')}`)
console.log(`                   ${path.join(OUT, 'disassembly.txt')}`)
