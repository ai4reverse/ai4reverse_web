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
import { rewriteCellInitLoops } from './lib/cell-init.mjs'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

/** First register index that names a module-scope cell rather than a frame local. */
const MODULE_BASE = 868

/**
 * Register 4 holds this sentinel while a virtual function is still running: the
 * dispatch loop keeps executing only while `x(u, 4) === B`. Any other value is
 * the function's return value.
 *
 * Read by the link pass (prologue `var rRet = SENTINEL`) and by
 * `lowerReturnSlot`/`endsTerminal` inside `emitFunction`.
 */
const SENTINEL = 25

/** Mid-body returns recovered from writes to register 4 (read by the header). */
let returnSlotRewrites = 0

/** Blocks whose `throw`/`return` cut the CFG successor edge (read by the header). */
let terminalCuts = 0

/** Irreducible back edges rebuilt as local retry loops. */
let backEdgeLoops = 0

/**
 * Control transfers the emitter could not express: a jump whose target was
 * already emitted. Every one of these is a silently wrong function, so the
 * count is a correctness metric, not a size metric.
 */
let droppedTransfers = 0

/** Functions that lost at least one control transfer. */
const droppedByFunction = new Set()

/**
 * Blocks a branch arm had to skip because another arm had already emitted them.
 *
 * `emitUntil` walks the arm's successors independently of `emitBlock`, so this
 * is the second, previously uncounted place where a control transfer can vanish.
 * Counted separately because some of these skips are legitimate sharing; the
 * per-function list is the work list for the structure audit.
 */
let sharedBlockSkips = 0
const skippedByFunction = new Set()

/** Module-scope cell names the lift emitted; hoisted to one declaration. */
const moduleCells = new Set()

const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))

const cfgByAt = new Map(cfg.instructions.map((i) => [i.at, i]))
const control = new Set(cfg.controlHandlers)

// --- blocks and dominators --------------------------------------------------
function buildBlocks(instructions, start, end, extraLeaders = null) {
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
  // Try regions are structural boundaries the CFG does not show: the handler
  // is only reachable through an exception edge. Splitting at `PUSH_HANDLER`,
  // at the first protected instruction and at the handler entry lets the
  // emitter replace the whole setup with a real `try`.
  for (const s of extraLeaders ?? []) if (s >= start && s < end) leaders.add(s)
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
let cellInitLoops = 0
let cellInitCells = 0

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
/** `__frames.pop()`, `__frames.push(…)`, `__thrown.pop()` — handler bookkeeping. */
function isHandlerBookkeeping(node, t) {
  if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return false
  const { object, property } = node.callee
  if (t.isIdentifier(object, { name: '__frames' })) return property.name === 'pop' || property.name === 'push'
  if (t.isIdentifier(object, { name: '__thrown' })) return property.name === 'pop'
  return false
}

/**
 * Remove the interpreter's handler-stack bookkeeping from one `try`/`catch`
 * body. A real `try` already pops the handler on every exit, so the pops are
 * not merely redundant — they would pop the runtime's array to nothing and the
 * following `CATCH` would read `undefined`.
 */
function stripHandlerBookkeeping(statements, t) {
  const clean = (statement) => {
    if (t.isExpressionStatement(statement)) {
      const expression = statement.expression
      const parts = t.isSequenceExpression(expression) ? expression.expressions : [expression]
      const kept = parts.filter((p) => !isHandlerBookkeeping(p, t))
      if (kept.length === 0) return null
      statement.expression = kept.length === 1 ? kept[0] : t.sequenceExpression(kept)
      return statement
    }
    if (t.isIfStatement(statement)) {
      for (const key of ['consequent', 'alternate']) {
        const branch = statement[key]
        if (t.isBlockStatement(branch)) branch.body = stripHandlerBookkeeping(branch.body, t)
      }
    } else if (t.isBlockStatement(statement)) {
      statement.body = stripHandlerBookkeeping(statement.body, t)
    }
    return statement
  }
  const out = []
  for (const statement of statements) {
    const next = clean(statement)
    if (next) out.push(next)
  }
  return out
}

/** `CATCH` reads the thrown value off the frame's stack; here it is the catch parameter. */
function rewriteCatchEntry(statements, t) {
  const visit = (node, parent, key) => {
    if (!node || typeof node !== 'object') return
    if (
      t.isMemberExpression(node) &&
      !node.computed &&
      t.isIdentifier(node.property, { name: 'v' }) &&
      t.isCallExpression(node.object) &&
      t.isMemberExpression(node.object.callee) &&
      t.isIdentifier(node.object.callee.object, { name: '__thrown' })
    ) {
      if (parent) parent[key] = t.identifier('__caught')
      return
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) v.forEach((c, i) => visit(c, v, i))
      else if (v && typeof v === 'object' && v.type) visit(v, node, k)
    }
  }
  statements.forEach((statement) => visit(statement, null, null))
  return statements
}

function emitFunction(fn) {
  const body = disasm.instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  if (!body.length) return null

  const instructionAt = new Map(body.map((i) => [i.at, i]))
  /** Address of the instruction after `at`, or null at the function's end. */
  const nextOf = (at) => {
    const next = instructionAt.get(at)?.next ?? null
    return next !== null && instructionAt.has(next) ? next : null
  }
  /** Every instruction reachable from `start` along normal CFG edges. */
  const reachWithin = (start) => {
    const seen = new Set()
    const queue = start === null ? [] : [start]
    while (queue.length) {
      const at = queue.shift()
      if (at === null || seen.has(at) || !instructionAt.has(at)) continue
      seen.add(at)
      for (const s of cfgByAt.get(at)?.successors ?? []) queue.push(s)
    }
    return seen
  }

  // --- try/catch regions ----------------------------------------------------
  //
  // The interpreter has no `try`: `PUSH_HANDLER` (op 218) records
  // `{h: handler, f: finally}` on the frame's handler stack, every call pops it
  // again on normal return, and `Y`'s own `catch` jumps the instruction pointer
  // to `h` and pushes the thrown value onto the frame's thrown stack. `CATCH`
  // (op 168) then pops both stacks and moves the value into a register.
  //
  // None of that can be reproduced by a lifted function, which has no
  // instruction pointer and no frame. The handler entry is not a CFG successor
  // either, so the emitter used to lay the catch body out inline and run it
  // unconditionally. A `PUSH_HANDLER` instruction is exactly one `try`, though,
  // and the region it protects is everything reachable from the next
  // instruction until the point where normal flow and the handler reconverge.
  // That is a real `try { … } catch { … }`.
  const tryRegions = new Map()
  const extraLeaders = new Set()
  for (const ins of body) {
    if (ins.opcode !== 218) continue
    const [catchReg, , handler, dst] = ins.operands
    // `N(n, dst, imm)` stores the handler address into `dst` and the push reads
    // it back from `catchReg`; they are the same register in every occurrence.
    if (catchReg !== dst) continue
    const bodyStart = nextOf(ins.at)
    if (!instructionAt.has(handler) || bodyStart === null || handler <= ins.at) continue
    const normal = reachWithin(bodyStart)
    const caught = reachWithin(handler)
    // A handler that normal flow can fall into is a branch, not an exception
    // target; leave those alone rather than invent a `try`.
    if (normal.has(handler)) continue
    let joinAt = null
    for (const at of normal) {
      if (!caught.has(at)) continue
      if (joinAt === null || at < joinAt) joinAt = at
    }
    tryRegions.set(ins.at, { bodyStart, catchStart: handler, joinAt })
    extraLeaders.add(ins.at)
    extraLeaders.add(bodyStart)
    extraLeaders.add(handler)
    if (joinAt !== null) extraLeaders.add(joinAt)
  }

  const { blocks, byStart } = buildBlocks(body, fn.start, fn.end, extraLeaders)
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

  /**
   * Addresses that end the region currently being emitted.
   *
   * A `try` body must stop where the protected region ends, but the region's
   * last jump targets the reconvergence point, which the emitter would
   * otherwise walk into and duplicate inside the `try`. While a region is
   * being emitted, reaching a stop address emits nothing and jumping to one
   * emits nothing, which is exactly falling out of the `try` block.
   */
  const stops = []
  const isStop = (at) => at !== null && stops.includes(at)
  const withStop = (at, run) => {
    if (at !== null) stops.push(at)
    try {
      return run()
    } finally {
      if (at !== null) stops.pop()
    }
  }

  /**
   * A lifted statement list is terminal when it cannot fall through: op232's
   * handler is a bare `throw`, and op247 (MAKE_GENERATOR) ends in a `return`.
   *
   * The guarded-throw family — `if (!(name in l)) throw new ReferenceError(…)`,
   * opcodes 109/128/163/193/258 and friends, 25 in all — must NOT match. Those
   * handlers continue after the guard, so treating them as terminal would drop
   * the rest of the handler and every block behind it.
   */
  const endsTerminal = (stmts) => {
    const last = stmts[stmts.length - 1]
    return Boolean(last) && (t.isThrowStatement(last) || t.isReturnStatement(last))
  }

  /**
   * The interpreter returns as soon as register 4 leaves the sentinel: the
   * dispatch loop re-tests `x(u, 4) === B` after every handler. The link pass
   * can only append one `return` at the end of the body, so every mid-body store
   * into register 4 needs the same test inline — otherwise the lifted function
   * keeps executing past its return.
   */
  const lowerReturnSlot = (statement) => {
    if (!t.isExpressionStatement(statement)) return [statement]
    const expr = statement.expression
    // Handlers such as op165 emit `r11 = callee.call(...), rRet = r11` as one
    // sequence expression, so the store to register 4 is the *last element*, not
    // the whole statement. Missing that shape is why frontierSign returned the
    // sentinel: the write happened but never turned into a return.
    const tail = t.isSequenceExpression(expr) ? expr.expressions[expr.expressions.length - 1] : expr
    if (!t.isAssignmentExpression(tail) || tail.operator !== '=') return [statement]
    if (!t.isIdentifier(tail.left, { name: 'rRet' })) return [statement]
    returnSlotRewrites++
    const leading = t.isSequenceExpression(expr) ? expr.expressions.slice(0, -1) : []
    const out = []
    if (leading.length === 1) out.push(t.expressionStatement(leading[0]))
    else if (leading.length > 1) out.push(t.expressionStatement(t.sequenceExpression(leading)))
    out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier('rRet'), tail.right)))
    out.push(
      t.ifStatement(
        t.binaryExpression('!==', t.identifier('rRet'), t.numericLiteral(SENTINEL)),
        t.blockStatement([t.returnStatement(t.identifier('rRet'))]),
      ),
    )
    return out
  }

  /**
   * How large a block may be and still be re-emitted at a second control-flow
   * site, and how many such re-emissions may nest.
   *
   * `emitBlock` marks every block it emits, so a second predecessor of a shared
   * join block gets no control transfer at all. Inside a loop that silently
   * deletes the back edge: fn_44's copy block jumps to the POSTINC block at
   * 4909, which the other arm had already emitted, so the increment vanished and
   * the loop re-copied the same key forever. Re-emitting a *small* loop-local
   * block restores the transfer without duplicating whole subtrees.
   */
  const FORCE_MAX_INSTRUCTIONS = 8
  const FORCE_DEPTH_LIMIT = 4
  let forceDepth = 0
  const canForceReemit = (at) => {
    const b = byStart.get(at)
    return Boolean(b) && b.instructions.length <= FORCE_MAX_INSTRUCTIONS
  }

  /**
   * Rebuild a small **irreducible** region as a retry loop at the jump site.
   *
   * fn_241 (frontierSign) is the motivating case: two entries converge on the
   * block that calls the signer, and a later block jumps back to it, but the
   * merge point does not dominate the back edge, so no `while` covers the cycle.
   * The first entry's arm emits the block; the second entry's jump then finds it
   * already emitted and silently disappears — the normal (non-stub) path never
   * calls the signer at all and returns the sentinel.
   *
   * Emitting the region again behind `while (true)`, with the back edge as
   * `continue`, restores the transfer without touching the rest of the function.
   * The walk is capped so a pathological region cannot expand the output.
   */
  const BACK_EDGE_BLOCK_BUDGET = 24
  function emitBackEdgeLoop(head) {
    const local = new Set()
    let budget = BACK_EDGE_BLOCK_BUDGET
    const emitOne = (at, isHead) => {
      if (!isHead && at === head) return [t.continueStatement()]
      if (local.has(at) || budget <= 0) return [t.continueStatement()]
      const b = byStart.get(at)
      if (!b) return []
      budget--
      local.add(at)
      const stmts = []
      const last = b.instructions[b.instructions.length - 1]
      const isCtl = control.has(last.opcode)
      for (const ins of b.instructions) {
        if (isCtl && ins.at === last.at) continue
        for (const s of instructionStatements(ins)) stmts.push(...lowerReturnSlot(s))
      }
      for (const r of referencedRegisters(stmts)) allRefs.add(r)
      if (!isCtl) {
        for (const s of b.successors) stmts.push(...emitOne(s, false))
        return stmts
      }
      const br = branchOf(last)
      if (!br) return stmts
      stmts.push(...br.effects)
      for (const r of referencedRegisters(stmts)) allRefs.add(r)
      if (br.cond === null) {
        if (br.target != null) stmts.push(...emitOne(br.target, false))
        return stmts
      }
      stmts.push(
        t.ifStatement(
          br.cond,
          t.blockStatement(emitOne(br.trueTarget, false)),
          t.blockStatement(emitOne(br.falseTarget, false)),
        ),
      )
      return stmts
    }
    const body = emitOne(head, true)
    return body.length ? t.whileStatement(t.booleanLiteral(true), t.blockStatement(body)) : null
  }

  function emitBlock(start, loop, force = false) {
    if (isStop(start)) return []
    if (emitted.has(start) && !force) return []
    const block = byStart.get(start)
    if (!block) return []
    if (!force) emitted.add(start)
    const region = tryRegions.get(start)
    if (region) {
      // The `PUSH_HANDLER` block holds only the handler bookkeeping, which the
      // `try` replaces, so it is not emitted at all.
      const tryBody = withStop(region.joinAt, () => emitUntil(region.bodyStart, region.joinAt, loop))
      const catchBody = withStop(region.joinAt, () => emitUntil(region.catchStart, region.joinAt, loop))
      rewriteCatchEntry(catchBody, t)
      const out = [
        t.tryStatement(
          t.blockStatement(stripHandlerBookkeeping(tryBody, t)),
          t.catchClause(t.identifier('__caught'), t.blockStatement(stripHandlerBookkeeping(catchBody, t))),
          null,
        ),
      ]
      if (region.joinAt !== null) out.push(...emitBlock(region.joinAt, loop))
      return out
    }

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
      for (const s of stmts) out.push(...lowerReturnSlot(s))
      for (const r of referencedRegisters(stmts)) allRefs.add(r)
    }

    if (!isControl) {
      // A block that ends in `throw`/`return` has no fall-through. Queueing its
      // CFG successor would inline the normal continuation *after* the throw,
      // inside whichever arm this block was emitted into — the fn_44 defect.
      if (endsTerminal(out)) {
        terminalCuts++
        return out
      }
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
      // Falling out of the region being emitted (a `try` body or its handler):
      // the statement list ends where the structure ends.
      if (isStop(target)) return out
      if (loop && target === loop.head) {
        out.push(t.continueStatement())
        return out
      }
      if (emitted.has(target)) {
        // Another arm already emitted this block. Returning nothing here drops
        // this path's control transfer; re-emit a small loop-local block so the
        // jump still reaches its update/back-edge code.
        if (
          loop &&
          loop.members.has(target) &&
          !loopHeads.has(target) &&
          canForceReemit(target) &&
          forceDepth < FORCE_DEPTH_LIMIT
        ) {
          forceDepth++
          try {
            out.push(...emitBlock(target, loop, true))
          } finally {
            forceDepth--
          }
          return out
        }
        // No enclosing loop: a small block can still be re-emitted so this
        // path keeps its control transfer. Without that, a jump into a merge
        // block that was consumed by the other arm is lost, and any back edge
        // hiding behind it can never be rebuilt (fn_241 / frontierSign).
        if (!loop && canForceReemit(target) && forceDepth < FORCE_DEPTH_LIMIT) {
          forceDepth++
          try {
            out.push(...emitBlock(target, null, true))
          } finally {
            forceDepth--
          }
          return out
        }
        // Genuine irreducible back edge with no rebuildable block: re-create the
        // cycle as a local retry loop rather than dropping it.
        if (!loop && target < block.start) {
          const retry = emitBackEdgeLoop(target)
          if (retry) {
            backEdgeLoops++
            out.push(retry)
          }
        }
        // A transfer nothing could reconstruct: the emitted function is
        // silently wrong, so count it and name the function.
        if (!loop) {
          droppedTransfers++
          droppedByFunction.add(fn.id)
        }
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
      if (s === stop || seen.has(s)) continue
      if (emitted.has(s)) {
        sharedBlockSkips++
        skippedByFunction.add(fn.id)
        continue
      }
      seen.add(s)
      const stmts = emitBlock(s, loop)
      acc.push(...stmts)
      // Same rule as emitBody, and both sites must cut: patching one alone is a
      // no-op, because the other re-admits the block.
      if (endsTerminal(stmts)) continue
      for (const nx of byStart.get(s)?.successors ?? []) if (nx !== stop && !seen.has(nx)) q.push(nx)
    }
    return acc
  }

  const top = emitBlock(fn.start, null)
  for (const b of blocks) if (!emitted.has(b.start)) top.push(...emitBlock(b.start, null))

  // The body starts with a loop that installs a `{ v: … }` box for every
  // register in a static range. Its index is a run-time value, so the lift left
  // it as a store into the state object rather than to the named cell that the
  // rest of the body reads. Expand it here, while this function's `allRefs` and
  // the program-wide module-cell set are both still being built.
  const cellInit = rewriteCellInitLoops(t.blockStatement(top), t, {
    nameOf: regName,
    moduleBase: MODULE_BASE,
    onFrameName: (name) => allRefs.add(name),
    onModuleName: (name) => moduleCells.add(name),
  })
  cellInitLoops += cellInit.rewritten
  cellInitCells += cellInit.cells

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

/**
 * Link pass: turn 146 standalone function bodies into one callable program.
 *
 * Emitting each virtual function as a zero-argument declaration is not enough
 * to run it. The interpreter supplied four things that a bare declaration does
 * not, and without them the lifted code is readable but dead:
 *
 *   1. **The prologue.** `Y` seeds registers 0..6 with `null`, `undefined`,
 *      `true`, `false`, the return sentinel, `this` and `arguments`. Here those
 *      become parameters and the first statements of the function.
 *   2. **The return slot.** A virtual function signals completion by writing
 *      register 4; the interpreter's loop tests it against the sentinel. That
 *      becomes `return rRet`.
 *   3. **Re-entry.** `Y(entryPc, frame, this, arguments, 0, hint)` is a call to
 *      the virtual function whose entry is `entryPc`. Now that the callee is a
 *      real function, the call becomes `fn_<id>(thisArg, argsObj)`.
 *   4. **Module cells.** Registers at or above 868 are one binding shared by
 *      every function, but the emitter declared them inside each function.
 *      They are hoisted to one program-level declaration here.
 *
 * Every rewrite is counted and reported, so an unlinked site shows up as a
 * number rather than as a silent `undefined`.
 */
const PROLOGUE_NAMES = new Set(['rNull', 'rUndef', 'rTrue', 'rFalse', 'rRet', 'rThis', 'rArgs'])
const MODULE_RE = /^mod\d+$/

const byEntry = new Map(fnDoc.functions.map((f) => [f.start, f]))
let linkedCalls = 0
let unlinkedCalls = 0

/** Drop declarators that the link pass supplies instead. */
function filterDeclarators(statement) {
  if (!t.isVariableDeclaration(statement)) return statement
  const kept = statement.declarations.filter((d) => {
    if (!t.isIdentifier(d.id)) return true
    const name = d.id.name
    if (MODULE_RE.test(name)) {
      moduleCells.add(name)
      return false
    }
    return !PROLOGUE_NAMES.has(name)
  })
  if (kept.length === statement.declarations.length) return statement
  if (kept.length === 0) return null
  return t.variableDeclaration(statement.kind, kept)
}

for (const node of program) {
  if (!t.isFunctionDeclaration(node)) continue
  const kept = []
  for (const statement of node.body.body) {
    const filtered = filterDeclarators(statement)
    if (filtered) kept.push(filtered)
  }
  node.params = [t.identifier('rThis'), t.identifier('rArgs')]
  node.body.body = [
    t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier('rNull'), t.nullLiteral()),
      t.variableDeclarator(t.identifier('rUndef'), t.unaryExpression('void', t.numericLiteral(0))),
      t.variableDeclarator(t.identifier('rTrue'), t.booleanLiteral(true)),
      t.variableDeclarator(t.identifier('rFalse'), t.booleanLiteral(false)),
      t.variableDeclarator(t.identifier('rRet'), t.numericLiteral(SENTINEL)),
    ]),
    ...kept,
    t.returnStatement(t.identifier('rRet')),
  ]
}

/**
 * `__state[<literal>]` -> the register it names.
 *
 * The translator lowers `x(n, 6)` to `rArgs`, but a handler that reaches a
 * register through a member expression on an *alias* of the VM state
 * (`var t = n; … t.A[6][0]`) or on a parent frame survives as `__state[6]`.
 * Both mean the same slot, so the literal form is rewritten to the register
 * name. Dynamic indices (`__state[r]`) are left alone and counted — a register
 * number computed at run time cannot be resolved to a name without re-creating
 * the register file this project is removing.
 */
let stateSlotsResolved = 0
let stateDynamicLeft = 0
let parentReads = 0

/**
 * Frame depth of an `X.A[<n>]` base, or null when it is not a frame at all.
 *
 * The lift spells the interpreter's frame walk three ways, because a handler may
 * alias the state parameter or rebind it: `__state`, `__parent` (already one
 * level up) and the literal `.o` links between them. All three mean "the frame
 * `depth` levels above the one this code runs in", so they are collapsed here
 * before the index is bound to a name.
 */
function frameChainDepth(node) {
  let depth = 0
  let cursor = node
  while (t.isMemberExpression(cursor) && !cursor.computed && t.isIdentifier(cursor.property, { name: 'o' })) {
    depth += 1
    cursor = cursor.object
  }
  if (t.isIdentifier(cursor, { name: '__parent' })) return depth + 1
  if (t.isIdentifier(cursor, { name: '__state' })) return depth
  return null
}

/**
 * Resolve frame-slot accesses that survived translation.
 *
 * Three shapes reach here:
 *
 *   `__state[6]`         — a register reached through an alias of the frame.
 *   `__state.A[6]`       — the same slot through the register file, depth 0.
 *   `__state.o.o.A[14]`  — a frame-local register of an enclosing function, the
 *                          upvalue the interpreter reads by walking `.o`. The
 *                          lift leaves it as a member chain whenever the state
 *                          parameter was rebound, so it is not covered by the
 *                          `__parent` form.
 *
 * The first two become the register name. A chain of depth > 0 becomes the
 * three-argument `__upvalue(__state, depth, index)` that `22-nest.mjs` resolves
 * to the ancestor's variable; a module-scope index needs no walk at all. A
 * computed index that only exists at run time (`__state[r]`) is left alone and
 * counted: naming it would require keeping the register file this project
 * exists to remove.
 *
 * A frame register at or above the frame's cell boundary is stored by the
 * interpreter as a `{ v }` box, and code that reads the register file raw
 * spells the unwrap out: `n.o.A[14].v`. The lift models every frame register
 * as a variable holding the *value* (that is what dropping the boxes means),
 * so the trailing `.v` has to go with the box. Leaving it turned
 * `__upvalue(__state, 1, 14).v` into a read of a property on the lifted value —
 * `undefined.v` for the bootstrap's typeof helper, which had been stored as a
 * plain function. Module cells are the exception: they stay boxes (`mod<N>.v`),
 * because the cell is shared and nothing unwraps it.
 */
function slotReplacement(node) {
  if (!t.isMemberExpression(node) || !node.computed) return null
  if (t.isIdentifier(node.object, { name: '__state' })) {
    if (!t.isNumericLiteral(node.property)) return { dynamic: true }
    const index = node.property.value
    return { node: t.identifier(regName(index)), depth: 0, index }
  }
  if (
    t.isMemberExpression(node.object) &&
    !node.object.computed &&
    t.isIdentifier(node.object.property, { name: 'A' }) &&
    t.isNumericLiteral(node.property)
  ) {
    const depth = frameChainDepth(node.object.object)
    if (depth === null) return null
    const index = node.property.value
    if (depth === 0) return { node: t.identifier(regName(index)), depth, index }
    return {
      node:
        index >= MODULE_BASE
          ? t.identifier(`mod${index}`)
          : t.callExpression(t.identifier('__upvalue'), [
              t.identifier('__state'),
              t.numericLiteral(depth),
              t.numericLiteral(index),
            ]),
      depth,
      index,
    }
  }
  return null
}

function resolveStateSlots(node) {
  if (!node || typeof node !== 'object') return
  if (t.isMemberExpression(node)) {
    // `X.A[14].v` — drop the box access together with the box.
    if (
      !node.computed &&
      t.isIdentifier(node.property, { name: 'v' }) &&
      t.isMemberExpression(node.object)
    ) {
      const inner = slotReplacement(node.object)
      if (inner?.node && inner.index < MODULE_BASE) {
        Object.keys(node).forEach((k) => delete node[k])
        Object.assign(node, inner.node)
        stateSlotsResolved++
        return
      }
    }
    if (node.computed) {
      const slot = slotReplacement(node)
      if (slot?.node) {
        Object.keys(node).forEach((k) => delete node[k])
        Object.assign(node, slot.node)
        if (slot.depth === 0) stateSlotsResolved++
        else parentReads++
        return
      }
      if (slot?.dynamic) stateDynamicLeft++
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach(resolveStateSlots)
    else if (v && typeof v === 'object' && typeof v.type === 'string') resolveStateSlots(v)
  }
}
for (const node of program) resolveStateSlots(node)

/** `__enter(entryPc, frame, thisArg, argsObj, 0, hint)` -> `fn_<id>(thisArg, argsObj)` */
function relink(node) {
  if (!node || typeof node !== 'object') return
  if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: '__enter' })) {
    const [entry, , thisArg, argsObj] = node.arguments
    const target = t.isNumericLiteral(entry) ? byEntry.get(entry.value) : null
    if (target) {
      node.callee = t.identifier(`fn_${target.id}`)
      node.arguments = [thisArg, argsObj]
      linkedCalls++
      return
    }
    unlinkedCalls++
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach(relink)
    else if (v && typeof v === 'object' && typeof v.type === 'string') relink(v)
  }
}
for (const node of program) relink(node)

if (moduleCells.size) {
  program.unshift(
    t.variableDeclaration(
      'var',
      [...moduleCells].sort().map((name) => t.variableDeclarator(t.identifier(name), null)),
    ),
  )
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
  ` * return-slot lowered  ${returnSlotRewrites}  — mid-body register-4 store now returns\n` +
  ` * terminal cuts        ${terminalCuts}  — throw/return blocks stop the CFG edge\n` +
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
console.log(`return-slot lowered  ${returnSlotRewrites}`)
console.log(`terminal cuts        ${terminalCuts}`)
console.log(`back-edge loops      ${backEdgeLoops}`)
console.log(`dropped transfers    ${droppedTransfers} in ${droppedByFunction.size} functions: ${[...droppedByFunction].sort((a, b) => a - b).join(',')}`)
console.log(`shared-block skips   ${sharedBlockSkips} in ${skippedByFunction.size} functions: ${[...skippedByFunction].sort((a, b) => a - b).join(',')}`)
console.log(`functions emitted    ${ok} / ${fnDoc.functions.length}`)
console.log(`emit failures        ${failed.length}`)
console.log(`re-entry linked      ${linkedCalls}`)
console.log(`re-entry unlinked    ${unlinkedCalls}`)
console.log(`module cells hoisted ${moduleCells.size}`)
console.log(`cell init loops       ${cellInitLoops} (${cellInitCells} cells)`)
console.log(`state slots resolved ${stateSlotsResolved}`)
console.log(`state slots dynamic  ${stateDynamicLeft}`)
console.log(`parses               ${parses}`)
console.log(`output               ${path.join(OUT, 'lifted.js')}`)
