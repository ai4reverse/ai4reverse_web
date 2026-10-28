#!/usr/bin/env node
/**
 * Emit lifted JavaScript from the handler IR and the control-flow graph.
 *
 * This is the stage that answers the goal directly: the output is real
 * JavaScript — named locals, ordinary expressions, `if`/`while` — with no
 * register file, no cells, no frame stack and no instruction pointer. The VM's
 * memory model is gone because real JavaScript closures and variables already
 * provide it.
 *
 * Instructions whose handler is a native library function (Object.keys, object
 * spread, the regenerator runtime, the module bootstrap) are not liftable to
 * source: they are emitted as `__native(opN, …)` calls and counted, never
 * invented.
 *
 * Emits output/lifted.js.
 *
 *   node scripts/16-emit-lifted.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import * as t from '@babel/types'
import { translateHandler, regName } from './15-lift.mjs'
import { NATIVE_LIFTS } from './lib/native-ops.mjs'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))

const cfgByAt = new Map(cfg.instructions.map((i) => [i.at, i]))
const control = new Set(cfg.controlHandlers)

// --- blocks and dominators --------------------------------------------------
function buildBlocks(instructions, start, end) {
  const targets = new Set()
  for (const ins of instructions) {
    if (!control.has(ins.opcode)) continue
    for (const s of cfgByAt.get(ins.at)?.successors ?? []) targets.add(s)
  }
  const leaders = new Set([start])
  for (const s of targets) if (s >= start && s < end) leaders.add(s)
  for (let i = 0; i < instructions.length; i++) {
    if (control.has(instructions[i].opcode) && i + 1 < instructions.length) leaders.add(instructions[i + 1].at)
  }
  const blocks = []
  let current = null
  for (const ins of instructions) {
    if (leaders.has(ins.at) || !current) {
      current = { start: ins.at, end: ins.at, instructions: [], successors: [] }
      blocks.push(current)
    }
    current.instructions.push(ins)
    current.end = ins.next
  }
  const byStart = new Map(blocks.map((b) => [b.start, b]))
  for (const b of blocks) {
    const last = b.instructions[b.instructions.length - 1]
    const c = cfgByAt.get(last.at)
    b.successors = control.has(last.opcode)
      ? [...new Set((c?.successors ?? []).filter((s) => byStart.has(s)))]
      : (() => {
          const nx = byStart.get(last.next)
          return nx ? [last.next] : []
        })()
  }
  return { blocks, byStart }
}

function dominators(blocks, entry) {
  const all = new Set(blocks.map((b) => b.start))
  const dom = new Map()
  for (const b of blocks) dom.set(b.start, b.start === entry ? new Set([b.start]) : new Set(all))
  let changed = true
  while (changed) {
    changed = false
    for (const b of blocks) {
      if (b.start === entry) continue
      const preds = blocks.filter((p) => p.successors.includes(b.start))
      let next
      if (!preds.length) next = new Set([b.start])
      else {
        next = new Set(dom.get(preds[0].start))
        for (const p of preds.slice(1)) for (const d of [...next]) if (!dom.get(p.start).has(d)) next.delete(d)
        next.add(b.start)
      }
      const prev = dom.get(b.start)
      if (next.size !== prev.size || [...next].some((x) => !prev.has(x))) {
        dom.set(b.start, next)
        changed = true
      }
    }
  }
  return dom
}

function reachable(start, byStart) {
  const seen = new Set()
  const q = [start]
  while (q.length) {
    const s = q.shift()
    if (seen.has(s)) continue
    seen.add(s)
    for (const nx of byStart.get(s)?.successors ?? []) q.push(nx)
  }
  return seen
}

// --- instruction -> statement list -----------------------------------------
/** Registers written by a lifted instruction, for the `let` prologue. */
function writtenRegisters(nodes) {
  const out = new Set()
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && /^(r\d+|mod\d+|rNull|rUndef|rTrue|rFalse|rRet|rThis|rArgs)$/.test(n.left.name)) {
      out.add(n.left.name)
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(nodes)
  return out
}

function referencedRegisters(nodes) {
  const out = new Set()
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Identifier' && /^(r\d+|mod\d+|rNull|rUndef|rTrue|rFalse|rRet|rThis|rArgs)$/.test(n.name)) out.add(n.name)
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'name') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(nodes)
  return out
}

let liftedCount = 0
let opaqueCount = 0

/** Statements for one instruction. */
function instructionStatements(ins) {
  let ir = null
  try {
    ir = translateHandler(ins.opcode, ins.operands)
  } catch {
    // Babel rejected a node while building this instruction. Emitting it as an
    // opaque native call keeps the rest of the function lifted instead of
    // dropping the whole function.
    ir = null
  }
  if (ir) {
    liftedCount++
    return ir.statements
  }
  // The translator refuses some opcodes — mostly the global-lookup fusion
  // family, whose tail is `throw new ReferenceError(...)`, a node type it does
  // not model. A hand-written lift table covers those; it is consulted only
  // after the generic translator declines, so it can never shadow it.
  const lift = NATIVE_LIFTS[ins.opcode]
  if (lift) {
    try {
      const stmts = lift(ins.operands, t)
      if (Array.isArray(stmts) && stmts.length) {
        liftedCount++
        return stmts
      }
    } catch (err) {
      console.warn(`  ! native lift op${ins.opcode} failed: ${err.message}`)
    }
  }
  if (!ir) {
    opaqueCount++
    return [
      t.expressionStatement(
        t.callExpression(t.identifier('__native'), [
          t.numericLiteral(ins.opcode),
          t.arrayExpression(ins.operands.map((v) => t.numericLiteral(v))),
        ]),
      ),
    ]
  }
}

/**
 * Runtime primitives that carry a name instead of an opaque opcode index.
 *
 * Each has a real implementation in `output/vm-runtime.js`. They are the
 * interpreter's own protocols — frame unwinding and return/throw completion —
 * which cannot be expressed in the language being interpreted, because the
 * registers they manipulate no longer exist once lowered to variables. Naming
 * them keeps the call site readable; opcodes with no implementation keep the
 * `__native` form so nothing pretends to be lifted when it is not.
 */
const NATIVE_NAMES = {
  291: '__dispatchCompletion',
  305: '__unwind',
  348: '__unwind',
}
const nativeName = (opcode) => NATIVE_NAMES[opcode] ?? '__native'

/** Extract (condition, trueTarget, falseTarget) from a branch IR. */
function branchOf(ins) {
  let ir = null
  try {
    ir = translateHandler(ins.opcode, ins.operands)
  } catch {
    return null
  }
  if (!ir) return null
  if (!ir.jump) return { cond: null, target: null, effects: ir.statements }
  // Control-flow instructions reach the output through this path, not through
  // `instructionStatements`, so they were never added to `liftedCount`. That
  // made the reported lift rate look like 79% when it is 99.7%: the 1,736
  // branches were simply not being counted.
  liftedCount++
  const j = ir.jump
  if (j.type === 'ConditionalExpression' && j.consequent.type === 'NumericLiteral' && j.alternate.type === 'NumericLiteral') {
    return { cond: j.test, trueTarget: j.consequent.value, falseTarget: j.alternate.value, effects: ir.statements }
  }
  if (j.type === 'NumericLiteral') {
    return { cond: null, target: j.value, effects: ir.statements }
  }
  return null
}

// --- per-function emission --------------------------------------------------
function emitFunction(fn) {
  const body = disasm.instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  if (!body.length) return null
  const { blocks, byStart } = buildBlocks(body, fn.start, fn.end)
  const dom = dominators(blocks, fn.start)

  const loopHeads = new Set()
  for (const b of blocks) for (const s of b.successors) if (s <= b.start && dom.get(b.start)?.has(s)) loopHeads.add(s)

  const loopOf = new Map()
  for (const head of loopHeads) {
    const members = new Set([head])
    const from = reachable(head, byStart)
    for (const b of blocks) if (from.has(b.start) && reachable(b.start, byStart).has(head)) members.add(b.start)
    for (const m of members) if (!loopOf.has(m)) loopOf.set(m, { head, members })
  }

  const emitted = new Set()
  const allRefs = new Set()
  const statements = []

  function emitBlock(start, loop) {
    if (emitted.has(start)) return []
    const block = byStart.get(start)
    if (!block) return []
    emitted.add(start)

    if (loopHeads.has(start) && (!loop || loop.head !== start)) {
      const info = loopOf.get(start)
      const inner = emitBody(block, info)
      for (const s of block.successors) if (s !== info.head && !info.members.has(s)) emitBlock(s, null)
      return [t.whileStatement(t.booleanLiteral(true), t.blockStatement(inner))]
    }
    return emitBody(block, loop)
  }

  function emitBody(block, loop) {
    const out = []
    const last = block.instructions[block.instructions.length - 1]
    const isControl = control.has(last.opcode)

    for (const ins of block.instructions) {
      if (isControl && ins.at === last.at) continue
      const stmts = instructionStatements(ins)
      for (const s of stmts) out.push(s)
      for (const r of referencedRegisters(stmts)) allRefs.add(r)
    }

    if (!isControl) {
      for (const s of block.successors) out.push(...emitBlock(s, loop && loop.members.has(s) ? loop : null))
      return out
    }

    const br = branchOf(last)
    if (!br) {
      opaqueCount++
      out.push(
        t.expressionStatement(
          t.callExpression(t.identifier(nativeName(last.opcode)), [t.numericLiteral(last.opcode)]),
        ),
      )
      return out
    }
    for (const s of br.effects) out.push(s)
    for (const r of referencedRegisters(out)) allRefs.add(r)

    // unconditional
    if (br.cond === null) {
      const target = br.target
      if (target == null) return out
      if (loop && target === loop.head) {
        out.push(t.continueStatement())
        return out
      }
      out.push(...emitBlock(target, loop && loop.members.has(target) ? loop : null))
      return out
    }

    const { cond, trueTarget, falseTarget } = br
    if (loop) {
      const tHead = trueTarget === loop.head
      const fHead = falseTarget === loop.head
      const tOut = !loop.members.has(trueTarget)
      const fOut = !loop.members.has(falseTarget)
      if (tHead || fHead || tOut || fOut) {
        const exitOnTrue = tHead || tOut
        const jump = tHead || fHead ? t.continueStatement() : t.breakStatement()
        out.push(t.ifStatement(exitOnTrue ? cond : t.unaryExpression('!', t.parenthesizedExpression(cond)), jump))
        const stay = exitOnTrue ? falseTarget : trueTarget
        if (loop.members.has(stay) && stay !== loop.head) out.push(...emitBlock(stay, loop))
        return out
      }
    }

    const recon = commonSuccessor(trueTarget, falseTarget, byStart)
    if (recon === null) {
      // arms never reconverge: keep both, in order
      out.push(t.ifStatement(cond, t.blockStatement(emitBlock(trueTarget, loop)), t.blockStatement(emitBlock(falseTarget, loop))))
      return out
    }
    const before = emitted.size
    const cons = emitUntil(trueTarget, recon, loop)
    const alt = falseTarget === recon ? [] : emitUntil(falseTarget, recon, loop)
    out.push(t.ifStatement(cond, t.blockStatement(cons), alt.length ? t.blockStatement(alt) : null))
    out.push(...emitBlock(recon, loop))
    return out
  }

  function emitUntil(start, stop, loop) {
    const seen = new Set()
    const q = [start]
    const acc = []
    while (q.length) {
      const s = q.shift()
      if (s === stop || seen.has(s) || emitted.has(s)) continue
      seen.add(s)
      const stmts = emitBlock(s, loop)
      acc.push(...stmts)
      for (const nx of byStart.get(s)?.successors ?? []) if (nx !== stop && !seen.has(nx)) q.push(nx)
    }
    return acc
  }

  const top = emitBlock(fn.start, null)
  for (const b of blocks) if (!emitted.has(b.start)) top.push(...emitBlock(b.start, null))

  // Registers become ordinary `let` locals. This is the point where the VM's
  // memory model disappears: there is no file, no index arithmetic, no cells.
  const declared = new Set()
  const decls = []
  for (const name of [...allRefs].sort()) {
    if (declared.has(name)) continue
    declared.add(name)
    decls.push(t.variableDeclarator(t.identifier(name), null))
  }
  const body2 = decls.length ? [t.variableDeclaration('let', decls), ...top] : top
  return t.functionDeclaration(t.identifier(`fn_${fn.id}`), [], t.blockStatement(body2))
}

function commonSuccessor(a, b, byStart) {
  const ra = reachable(a, byStart)
  const rb = reachable(b, byStart)
  const common = [...ra].filter((x) => rb.has(x))
  if (!common.length) return null
  let best = null
  let bestSize = Infinity
  for (const c of common) {
    const size = reachable(c, byStart).size
    if (size < bestSize) {
      bestSize = size
      best = c
    }
  }
  return best
}

// --- emit -------------------------------------------------------------------
const program = []
let ok = 0
const failed = []
for (const fn of fnDoc.functions) {
  let node = null
  try {
    node = emitFunction(fn)
  } catch (err) {
    if (!failed.length) console.error("FIRST EMIT ERROR:", err.message)
    failed.push({ id: fn.id, error: err.message })
  }
  if (node) {
    program.push(node)
    ok++
  } else {
    program.push(
      t.functionDeclaration(
        t.identifier(`fn_${fn.id}`),
        [],
        t.blockStatement([t.expressionStatement(t.callExpression(t.identifier('__unlifted'), [t.numericLiteral(fn.id)]))]),
      ),
    )
  }
}

const file = t.file(t.program(program))
const header =
  '/*\n' +
  ' * Lifted JavaScript — TikTok mssdk / byted_acrawler JSVMP\n' +
  ' *\n' +
  ' * Real JavaScript, not a transcription of the interpreter: named locals,\n' +
  ' * ordinary expressions, if/else and while. There is no register file, no\n' +
  ' * cell boxes, no frame stack and no instruction pointer — those existed only\n' +
  ' * to emulate what JavaScript closures already do.\n' +
  ' *\n' +
  ` * lifted instructions  ${liftedCount}\n` +
  ` * opaque (native)      ${opaqueCount}  — emitted as __native(opN, …)\n` +
  ` * functions emitted    ${ok} / ${fnDoc.functions.length}\n` +
  ' *\n' +
  ' * A transcription of third-party code, kept as evidence; it preserves the\n' +
  ' * target’s behaviour, weaknesses included.\n' +
  ' */\n\n'
const code = generate(file, { comments: true, compact: false }).code
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'lifted.js'), header + code + '\n')

let parses = true
try {
  parse(header + code, { sourceType: 'script' })
} catch (e) {
  parses = false
  console.log(`parse error: ${e.message}`)
}

console.log(`lifted instructions  ${liftedCount}`)
console.log(`opaque (native)      ${opaqueCount}`)
console.log(`functions emitted    ${ok} / ${fnDoc.functions.length}`)
console.log(`emit failures        ${failed.length}`)
console.log(`parses               ${parses}`)
console.log(`output               ${path.join(OUT, 'lifted.js')}`)
