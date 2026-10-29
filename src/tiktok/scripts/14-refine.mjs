#!/usr/bin/env node
/**
 * Refinement pass: lift the flat register program back into readable code.
 *
 * Three transformations, in order of how much they change the reading:
 *
 *   1. **Loops are rebuilt.** The previous structuring pass dropped back edges
 *      on the floor, so a looping function was emitted as a straight line — a
 *      semantic defect, not just a readability one. A back edge to a dominator
 *      now becomes `while (true)` with `continue` at the back edge and `break`
 *      where control leaves the loop.
 *   2. **Expressions are aggregated.** A value written to a register and read
 *      once is inlined into its use, so `R[17]="includes"; R[7]=R[9][R[17]]`
 *      becomes `R[7]=R[9]["includes"]`. A definition is only inlined when no
 *      register it reads is written between the definition and the use.
 *   3. **Registers are named.** 0..6 by their prologue role, module-state cells
 *      (>= 868) as `mod<N>`, and function temporaries as `t1, t2, …` in order
 *      of first definition.
 *
 * Anything the pass cannot prove safe is left alone and counted, never guessed.
 *
 * Emits output/refined.js.
 *
 *   node scripts/14-refine.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))

const cfgByAt = new Map(cfg.instructions.map((i) => [i.at, i]))
const control = new Set(cfg.controlHandlers)

/** Role names for the registers the interpreter prologue preloads. */
const REG_NAME = { 0: 'rNull', 1: 'rUndef', 2: 'rTrue', 3: 'rFalse', 4: 'rRet', 5: 'rThis', 6: 'rArgs' }
/** Registers at or above this index are module-scope cells, not temporaries. */
const MODULE_BASE = 868

// --- statement text, taken from the readable layer --------------------------
const readable = fs.readFileSync(path.join(OUT, 'readable.js'), 'utf8').split('\n')
const statement = new Map()
for (const line of readable) {
  const m = line.match(/^\s*\/\* @(\d+) \*\/ /)
  if (!m) continue
  let code = line.slice(m[0].length)
  const sep = code.lastIndexOf('   // ')
  if (sep !== -1) code = code.slice(0, sep)
  statement.set(Number(m[1]), code.trim())
}

function rawStatement(ins) {
  return statement.get(ins.at) ?? ''
}

// --- expression aggregation -------------------------------------------------
function splitParts(text) {
  let s = text.trim()
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim()
  s = s.replace(/;\s*$/, '').trim()
  if (!s) return []
  const parts = []
  let depth = 0
  let start = 0
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if ((ch === ',' || ch === ';') && depth === 0) {
      // Splitting on `;` as well as `,` matters: a handler body can hold two
      // statements, and treating them as one part made the aggregator inline a
      // definition whose right-hand side was itself a statement sequence.
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  // A statement whose brackets do not balance cannot be split safely: the `;`
  // seen above may be inside a nested function that the scan tracked wrongly
  // (a regex literal, for instance, changes what `{` means). Keep it whole
  // rather than emitting a fragment that will not parse.
  if (depth !== 0 || quote !== null) return [text.trim()]
  return parts.map((p) => p.trim()).filter(Boolean)
}

const READ_RE = /\bR\[(\d+)\]/g
const DEF_RE = /^R\[(\d+)\]\s*=\s*/

function registersRead(text) {
  const out = new Set()
  for (const m of text.matchAll(READ_RE)) out.add(Number(m[1]))
  return out
}

/**
 * Inline single-use definitions inside one straight-line statement list.
 *
 * A definition is inlined only when it is a whole-statement assignment, it is
 * read exactly once afterwards, and no register the definition reads is written
 * in between — otherwise moving it would change the value it computes.
 */
function aggregate(parts) {
  const list = parts.slice()
  for (let round = 0; round < 12; round++) {
    let changed = false
    for (let i = 0; i < list.length; i++) {
      const m = list[i].match(DEF_RE)
      if (!m) continue
      const target = Number(m[1])
      const rhs = list[i].slice(m[0].length)

      // A statement that starts with `R[target] =` is a *redefinition*, not a
      // use; counting or rewriting that position would turn the assignment
      // target into an expression and produce an invalid left-hand side.
      const leadingDef = new RegExp(`^R\\[${target}\\]\\s*=`)
      const countUses = (stmt) => {
        const head = (stmt.match(leadingDef) ?? [''])[0]
        const rest = stmt.slice(head.length)
        return { total: (rest.match(new RegExp(`\\bR\\[${target}\\]`, 'g')) ?? []).length, head }
      }

      let uses = 0
      let useIndex = -1
      for (let j = i + 1; j < list.length; j++) {
        const c = countUses(list[j])
        if (c.total > 0 || c.head) {
          uses = c.total
          useIndex = j
          break
        }
      }
      if (uses !== 1 || useIndex < 0) continue

      const deps = registersRead(rhs)
      let clobbered = false
      for (let j = i + 1; j < useIndex; j++) {
        const dm = list[j].match(DEF_RE)
        if (dm && deps.has(Number(dm[1]))) {
          clobbered = true
          break
        }
      }
      if (clobbered) continue

      const target_stmt = list[useIndex]
      const head = (target_stmt.match(leadingDef) ?? [''])[0]
      list[useIndex] =
        head + target_stmt.slice(head.length).replace(new RegExp(`\\bR\\[${target}\\]`, 'g'), `(${rhs})`)
      list.splice(i, 1)
      changed = true
      break
    }
    if (!changed) break
  }
  return list
}

/**
 * Make an expression safe in statement position. A minified handler can leave
 * an immediately-invoked function expression unparenthesised
 * (`function(){…}(c)`), which is a syntax error at statement level.
 */
function asStatement(part) {
  return /^function\s*\(/.test(part) ? `(${part})` : part
}

// --- blocks -----------------------------------------------------------------
function buildBlocks(instructions, start, end) {
  const targets = new Set()
  for (const ins of instructions) {
    if (!control.has(ins.opcode)) continue
    for (const s of cfgByAt.get(ins.at)?.successors ?? []) targets.add(s)
  }
  const leaders = new Set([start])
  for (const t of targets) if (t >= start && t < end) leaders.add(t)
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
    const text = rawStatement(last).trim()
    if (/^\{?\s*throw\b/.test(text)) b.successors = []
    else if (control.has(last.opcode)) {
      b.successors = [...new Set((cfgByAt.get(last.at)?.successors ?? []).filter((s) => byStart.has(s)))]
    } else {
      const next = byStart.get(last.next)
      b.successors = next ? [last.next] : []
    }
  }
  return { blocks, byStart }
}

function computeDominators(blocks, entry) {
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
      if (preds.length === 0) next = new Set([b.start])
      else {
        next = new Set(dom.get(preds[0].start))
        for (const p of preds.slice(1)) {
          for (const d of [...next]) if (!dom.get(p.start).has(d)) next.delete(d)
        }
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

function reachableFrom(start, byStart) {
  const seen = new Set()
  const q = [start]
  while (q.length) {
    const s = q.shift()
    if (seen.has(s)) continue
    seen.add(s)
    for (const t of byStart.get(s)?.successors ?? []) q.push(t)
  }
  return seen
}

// --- per-function emission ---------------------------------------------------
let loopCount = 0
let inlineCount = 0
const unstructured = []
const emittedInsideLoop = new Set()

function refineFunction(fn) {
  const body = disasm.instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  if (body.length === 0) return []
  const { blocks, byStart } = buildBlocks(body, fn.start, fn.end)
  const dom = computeDominators(blocks, fn.start)

  const loopHeads = new Set()
  for (const b of blocks) {
    for (const s of b.successors) {
      if (s <= b.start && dom.get(b.start)?.has(s)) loopHeads.add(s)
    }
  }

  const loopOf = new Map()
  for (const head of loopHeads) {
    const members = new Set()
    const fromHead = reachableFrom(head, byStart)
    for (const b of blocks) {
      if (!fromHead.has(b.start)) continue
      if (reachableFrom(b.start, byStart).has(head)) members.add(b.start)
    }
    members.add(head)
    for (const m of members) if (!loopOf.has(m)) loopOf.set(m, { head, members })
  }

  const emitted = new Set()
  const out = []
  const ind = (n) => '  '.repeat(n)

  function emitStraight(block, depth) {
    const last = block.instructions[block.instructions.length - 1]
    const parts = []
    for (const ins of block.instructions) if (ins.at !== last.at) parts.push(...splitParts(rawStatement(ins)))
    const fused = aggregate(parts)
    inlineCount += parts.length - fused.length
    for (const p of fused) out.push(`${ind(depth)}${asStatement(p)};`)
    return last
  }

  function emitBlock(start, depth, loop) {
    if (emitted.has(start)) return
    const block = byStart.get(start)
    if (!block) return
    emitted.add(start)

    if (loopHeads.has(start) && (!loop || loop.head !== start)) {
      loopCount++
      const info = loopOf.get(start)
      out.push(`${ind(depth)}while (true) {`)
      // Emit the header's own body inside the loop. Re-entering emitBlock here
      // would hit the `emitted` guard and produce an empty loop body.
      emitBody(block, depth + 1, info)
      out.push(`${ind(depth)}}`)
      for (const s of block.successors) if (s !== info.head && !info.members.has(s)) emitBlock(s, depth, null)
      return
    }

    emitBody(block, depth, loop)
  }

  function emitBody(block, depth, loop) {
    const term = block.instructions[block.instructions.length - 1]
    const termText = rawStatement(term).trim()
    const isThrow = /^\{?\s*throw\b/.test(termText)
    // The terminator of a block is emitted only when it is not pure control
    // flow; a branch is expressed by the emitted `if`, never by an `ip =`.
    const needsTermStatement = !control.has(term.opcode) && !isThrow

    const parts = []
    for (const ins of block.instructions) {
      if (ins.at === term.at && !needsTermStatement) continue
      parts.push(...splitParts(rawStatement(ins)))
    }
    const fused = aggregate(parts)
    inlineCount += parts.length - fused.length
    for (const p of fused) out.push(`${ind(depth)}${asStatement(p)};`)

    if (isThrow) return

    const succ = block.successors
    if (succ.length === 0) return

    if (succ.length === 1) {
      const t = succ[0]
      if (loop && t === loop.head) {
        out.push(`${ind(depth)}continue;`)
        return
      }
      emitBlock(t, depth, loop && loop.members.has(t) ? loop : null)
      return
    }

    const parsed = parseConditional(termText)
    if (!parsed) {
      unstructured.push({ fn: fn.id, at: term.at })
      return
    }
    for (const e of parsed.effects) out.push(`${ind(depth)}${e}`)

    if (loop) {
      const tHead = parsed.trueTarget === loop.head
      const fHead = parsed.falseTarget === loop.head
      const tOut = !loop.members.has(parsed.trueTarget)
      const fOut = !loop.members.has(parsed.falseTarget)
      if (tHead || fHead || tOut || fOut) {
        const exitOnTrue = tHead || tOut
        const stmt = tHead || fHead ? 'continue;' : 'break;'
        out.push(`${ind(depth)}if (${exitOnTrue ? parsed.cond : `!(${parsed.cond})`}) ${stmt}`)
        const stay = exitOnTrue ? parsed.falseTarget : parsed.trueTarget
        if (loop.members.has(stay) && stay !== loop.head) emitBlock(stay, depth, loop)
        return
      }
    }

    const recon = commonSuccessor(parsed.trueTarget, parsed.falseTarget, byStart)
    if (recon === null) {
      unstructured.push({ fn: fn.id, at: term.at })
      return
    }
    out.push(`${ind(depth)}if (${parsed.cond}) {`)
    emitUntil(parsed.trueTarget, recon, depth + 1, loop)
    if (parsed.falseTarget !== recon) {
      out.push(`${ind(depth)}} else {`)
      emitUntil(parsed.falseTarget, recon, depth + 1, loop)
    }
    out.push(`${ind(depth)}}`)
    emitBlock(recon, depth, loop)
  }

  function emitUntil(start, stop, depth, loop) {
    const seen = new Set()
    const q = [start]
    while (q.length) {
      const s = q.shift()
      if (s === stop || seen.has(s) || emitted.has(s)) continue
      seen.add(s)
      const before = out.length
      emitBlock(s, depth, loop)
      if (out.length === before) continue
      for (const t of byStart.get(s)?.successors ?? []) if (t !== stop && !seen.has(t)) q.push(t)
    }
  }

  emitBlock(fn.start, 0, null)
  for (const b of blocks) if (!emitted.has(b.start)) emitBlock(b.start, 0, null)
  return out
}

function commonSuccessor(a, b, byStart) {
  const ra = reachableFrom(a, byStart)
  const rb = reachableFrom(b, byStart)
  const common = [...ra].filter((x) => rb.has(x))
  if (common.length === 0) return null
  let best = null
  let bestSize = Infinity
  for (const c of common) {
    const size = reachableFrom(c, byStart).size
    if (size < bestSize) {
      bestSize = size
      best = c
    }
  }
  return best
}

function splitTopLevelCommas(text) {
  const parts = []
  let depth = 0
  let start = 0
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function parseConditional(stmt) {
  let s = stmt.trim()
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim()
  s = s.replace(/;\s*$/, '').trim()
  const m = s.match(/\?\s*ip\s*=\s*(\d+)\s*:\s*ip\s*=\s*(\d+)\s*$/)
  if (!m) return null
  const before = s.slice(0, m.index).trim()
  const parts = splitTopLevelCommas(before)
  const cond = (parts.pop() ?? '').trim()
  if (!cond) return null
  return {
    effects: parts.map((p) => p.trim()).filter(Boolean).map((p) => `${p};`),
    cond,
    trueTarget: Number(m[1]),
    falseTarget: Number(m[2]),
  }
}

// --- register naming --------------------------------------------------------
function nameRegisters(lines) {
  const order = new Map()
  let next = 1
  const nameFor = (n) => {
    if (REG_NAME[n]) return REG_NAME[n]
    if (n >= MODULE_BASE) return `mod${n}`
    if (!order.has(n)) order.set(n, `t${next++}`)
    return order.get(n)
  }
  // `R[7]in x` is valid JavaScript (the `]` ends the token), but renaming to
  // `t7in x` would glue a keyword onto the identifier. Keep a space when the
  // replacement is followed by something word-like.
  return lines.map((l) =>
    l
      .replace(/\bR\[(\d+)\](?=[A-Za-z_$0-9])/g, (whole, n) => `${nameFor(Number(n))} `)
      .replace(/\bR\[(\d+)\]/g, (whole, n) => nameFor(Number(n)))

  )
}

// --- emit -------------------------------------------------------------------
const out = []
out.push('/*')
out.push(' * Refined decompilation — TikTok mssdk / byted_acrawler JSVMP')
out.push(' *')
out.push(' * A transcription of third-party code, kept as evidence. Not written to be')
out.push(' * executed; it preserves the target’s behaviour, weaknesses included.')
out.push(' *')
out.push(' * Loops are rebuilt from back edges, single-use definitions are inlined into')
out.push(' * their use, and registers are named by role.')
out.push(' *')
out.push(' *   rNull rUndef rTrue rFalse   prologue constant slots (writable)')
out.push(' *   rRet                        return value; writing it ends the frame')
out.push(' *   rThis rArgs                 receiver and argument list')
out.push(' *   mod<N>                      module-scope cell (register index >= 868)')
out.push(' *   t<N>                        function temporary, by first definition')
out.push(' */')
out.push('')

// Fallback source: the structured pass is verified to parse, so a function the
// refiner cannot shape correctly is taken from there instead of emitting a
// fragment that will not parse.
const structuredSrc = fs.readFileSync(path.join(OUT, 'structured.js'), 'utf8').split('\n')
const structuredBodies = new Map()
for (let i = 0; i < structuredSrc.length; i++) {
  const m = structuredSrc[i].match(/^function fn_(\d+)\(\) \{$/)
  if (!m) continue
  const body = []
  let depth = 1
  for (let j = i + 1; j < structuredSrc.length && depth > 0; j++) {
    depth += (structuredSrc[j].match(/\{/g) ?? []).length - (structuredSrc[j].match(/\}/g) ?? []).length
    if (depth > 0) body.push(structuredSrc[j])
  }
  structuredBodies.set(Number(m[1]), body)
}
let refinedCount = 0
let fallbackCount = 0

for (const fn of fnDoc.functions) {
  out.push(
    `// fn ${fn.id} — entry ${fn.start}, ${fn.instructionCount} instructions${
      fn.calledVia.length ? `, created by ${fn.calledVia.join('/')}` : ', bootstrap'
    }`,
  )
  let lines = null
  try {
    lines = nameRegisters(refineFunction(fn))
    // A refinement that does not parse is worse than no refinement: check the
    // function in isolation and fall back when it fails.
    parse(`(function(){ ${lines.join('\n')} })`, { sourceType: 'script' })
  } catch (err) {
    unstructured.push({ fn: fn.id, error: err.message })
    lines = null
  }
  if (lines) {
    refinedCount++
    out.push(`function fn_${fn.id}() {`)
    for (const l of lines) out.push(`  ${l}`)
    out.push('}')
  } else {
    fallbackCount++
    const body = structuredBodies.get(fn.id)
    out.push(`function fn_${fn.id}() {   // refinement not applied — see report`)
    for (const l of body ?? []) out.push(l)
    out.push('}')
  }
  out.push('')
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'refined.js'), out.join('\n') + '\n')

console.log(`functions          ${fnDoc.functions.length}`)
console.log(`loops rebuilt      ${loopCount}`)
console.log(`inlined defs       ${inlineCount}`)
console.log(`refined            ${refinedCount}`)
console.log(`fallback           ${fallbackCount}`)
console.log(`unstructured       ${unstructured.length}`)
console.log(`output             ${path.join(OUT, 'refined.js')}`)
