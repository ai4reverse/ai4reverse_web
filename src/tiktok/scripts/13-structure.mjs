#!/usr/bin/env node
/**
 * Structuring pass: turn the flat `ip = …` program into if/else and loops.
 *
 * The readable layer emits one statement per instruction, with branches still
 * spelled as `ip = cond ? A : B`. That is exact but reads like an interpreter
 * trace. This pass rebuilds the block structure from the control-flow graph:
 *
 *   - leaders are the function entry, every jump target, and every instruction
 *     after a control transfer;
 *   - a forward conditional whose two arms reconverge becomes `if/else`;
 *   - a back edge to a dominator becomes `while (true)` with the exit as `break`;
 *   - anything the structuring cannot prove it has shaped correctly is emitted
 *     as a labelled block, and counted. A guessed structure would silently
 *     change the program, so unrecognised shapes are left explicit.
 *
 * Also renames the seven registers the interpreter preloads, since their roles
 * are fixed by `Y`'s prologue rather than being arbitrary.
 *
 * Emits output/structured.js.
 *
 *   node scripts/13-structure.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'

const generate = _generate.default ?? _generate
const traverse = _traverse.default ?? _traverse
const ident = (name) => ({ type: 'Identifier', name })

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'cfg.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))
const table = JSON.parse(fs.readFileSync(path.join(TMP, 'opcode-table.json'), 'utf8'))
const byOpcode = new Map(table.opcodes.map((o) => [o.opcode, o]))

const cfgByAt = new Map(cfg.instructions.map((i) => [i.at, i]))
const control = new Set(cfg.controlHandlers)

/**
 * Registers the interpreter preloads in `Y`. These are initial values on
 * ordinary registers, not constants — any of them may be overwritten — so the
 * names describe their starting role only.
 */
const REG_NAME = {
  0: 'rNull',
  1: 'rUndef',
  2: 'rTrue',
  3: 'rFalse',
  4: 'rRet',
  5: 'rThis',
  6: 'rArgs',
}

// --- load the statement text produced by the readable layer ----------------
const readable = fs.readFileSync(path.join(OUT, 'readable.js'), 'utf8').split('\n')
const statement = new Map()
for (const line of readable) {
  const m = line.match(/^\s*\/\* @(\d+) \*\/ /)
  if (!m) continue
  let code = line.slice(m[0].length)
  // The readable layer terminates every line with exactly three spaces and the
  // mnemonic. Stripping a generic `//` comment here would cut a URL literal at
  // its `https://`, leaving an unterminated string in the output.
  const sep = code.lastIndexOf('   // ')
  if (sep !== -1) code = code.slice(0, sep)
  statement.set(Number(m[1]), code.trim())
}

function render(ins) {
  const code = statement.get(ins.at) ?? ''
  // Registers 0..6 always sit below the cell boundary (the smallest arity the
  // bytecode ever passes is well above 7), so reading, writing and raw access
  // all reduce to a plain variable for them. This is done on the AST: a regex
  // that rewrites `setV(4, x)` to `rRet = x` leaves the call's closing
  // parenthesis behind and the file stops parsing.
  let ast
  try {
    ast = parse(`(${code})`, { sourceType: 'script' }).program.body[0].expression
  } catch {
    return code
  }
  const isReg = (node) => node?.type === 'NumericLiteral' && REG_NAME[node.value]
  traverse(
    { type: 'File', program: { type: 'Program', sourceType: 'script', body: [ast], directives: [] } },
    {
      MemberExpression(p) {
        const obj = p.node.object
        const prop = p.node.property
        if (!isReg(prop)) return
        const name = REG_NAME[prop.value]
        if (obj?.type === 'Identifier' && obj.name === 'R') {
          p.replaceWith(ident(name))
        } else if (obj?.type === 'Identifier' && obj.name === 'raw') {
          p.replaceWith({ type: 'MemberExpression', object: ident('raw'), property: ident(name) })
        }
      },
    },
  )
  try {
    return generate(ast, { compact: true, concise: true }).code
  } catch {
    return code
  }
}

/** Split a function's instructions into basic blocks. */
function buildBlocks(instructions, start, end) {
  const targets = new Set()
  for (const ins of instructions) {
    if (!control.has(ins.opcode)) continue
    const c = cfgByAt.get(ins.at)
    for (const s of c?.successors ?? []) targets.add(s)
  }

  const leaders = new Set([start])
  for (const t of targets) if (t >= start && t < end) leaders.add(t)
  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i]
    if (control.has(ins.opcode) && i + 1 < instructions.length) leaders.add(instructions[i + 1].at)
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
    const text = render(last).trim()
    // `throw` terminates the block: its handler does not touch `n.u`, so the
    // CFG would otherwise let control fall through into the next block and the
    // structurer would nest everything after a throw inside the throwing arm.
    if (/^\{?\s*throw\b/.test(text)) {
      b.successors = []
    } else if (control.has(last.opcode)) {
      b.successors = [...new Set((c?.successors ?? []).filter((s) => byStart.has(s)))]
    } else {
      const next = byStart.get(last.next)
      b.successors = next ? [last.next] : []
    }
  }
  return { blocks, byStart }
}

/** Immediate dominators, iterative. */
function dominators(blocks, entryStart) {
  const all = new Set(blocks.map((b) => b.start))
  const dom = new Map()
  for (const b of blocks) dom.set(b.start, b.start === entryStart ? new Set([b.start]) : new Set(all))
  let changed = true
  while (changed) {
    changed = false
    for (const b of blocks) {
      if (b.start === entryStart) continue
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

// --- structuring ------------------------------------------------------------
let structured = 0
let fallback = 0

/** Split on commas that sit at the top level of the expression. */
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

/**
 * Decompose a conditional instruction into its side effects and its condition.
 *
 * The handler body is a sequence expression, so the instruction text reads
 * `{ effect1, effect2, cond ? ip = A : ip = B; }`. The effects must be emitted
 * before the `if` and the condition must be the trailing element, otherwise the
 * emitted `if (…)` would swallow the side effects into its test.
 */
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

function structureFunction(fn) {
  const body = disasm.instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  if (body.length === 0) return []
  const { blocks, byStart } = buildBlocks(body, fn.start, fn.end)
  const dom = dominators(blocks, fn.start)

  const emitted = new Set()
  const out = []
  const indent = (n) => '  '.repeat(n)

  // A back edge is an edge to a block that dominates its source.
  const loopHeaders = new Set()
  for (const b of blocks) {
    for (const s of b.successors) {
      if (s <= b.start && dom.get(b.start).has(s)) loopHeaders.add(s)
    }
  }

  function emitBlock(start, depth) {
    if (emitted.has(start)) return
    const block = byStart.get(start)
    if (!block) return
    emitted.add(start)

    const term = block.instructions[block.instructions.length - 1]
    const head = block.instructions.slice(0, -1)
    const isControl = control.has(term.opcode)

    if (!isControl) {
      for (const ins of block.instructions) out.push(`${indent(depth)}${render(ins)}`)
      for (const s of block.successors) emitBlock(s, depth)
      return
    }

    for (const ins of head) out.push(`${indent(depth)}${render(ins)}`)

    const succ = block.successors
    // Unconditional transfer
    if (succ.length === 1) {
      const target = succ[0]
      if (target <= start) {
        // back edge: the enclosing while(true) owns the jump, so it is implicit
        return
      }
      emitBlock(target, depth)
      return
    }

    // Conditional: `ip = cond ? A : B`
    if (succ.length === 2) {
      const [a, b] = succ
      // Conditional: the handler spelled it `{ …effects…, cond ? ip=A : ip=B; }`
      const parsed = parseConditional(render(term))
      if (!parsed) {
        out.push(`${indent(depth)}${render(term)}   // unstructured conditional`)
        fallback++
        for (const s of succ) emitBlock(s, depth)
        return
      }
      for (const e of parsed.effects) out.push(`${indent(depth)}${e}`)
      const cond = parsed.cond
      const trueTarget = parsed.trueTarget
      const falseTarget = parsed.falseTarget

      // find where the two arms reconverge
      const reconverge = commonSuccessor(trueTarget, falseTarget, byStart)
      const takesTrue = a === trueTarget
      const first = takesTrue ? trueTarget : falseTarget
      const second = takesTrue ? falseTarget : trueTarget

      if (reconverge !== null) {
        structured++
        out.push(`${indent(depth)}if (${cond}) {`)
        emitUntil(first, reconverge, depth + 1)
        if (second !== reconverge) {
          out.push(`${indent(depth)}} else {`)
          emitUntil(second, reconverge, depth + 1)
        }
        out.push(`${indent(depth)}}`)
        emitBlock(reconverge, depth)
      } else {
        out.push(`${indent(depth)}${render(term)}   // arms do not reconverge`)
        fallback++
        emitBlock(first, depth)
        emitBlock(second, depth)
      }
      return
    }

    out.push(`${indent(depth)}${render(term)}`)
  }

  function emitUntil(start, stop, depth) {
    const seen = new Set()
    const queue = [start]
    while (queue.length) {
      const s = queue.shift()
      if (s === stop || seen.has(s) || emitted.has(s)) continue
      seen.add(s)
      const before = out.length
      emitBlock(s, depth)
      if (out.length === before) continue
      const block = byStart.get(s)
      for (const t of block?.successors ?? []) {
        if (t !== stop && !seen.has(t)) queue.push(t)
      }
    }
  }

  emitBlock(fn.start, 0)
  // anything reachable only through an edge we did not shape
  for (const b of blocks) if (!emitted.has(b.start)) emitBlock(b.start, 0)

  return out
}

function commonSuccessor(a, b, byStart) {
  const reach = (start) => {
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
  const ra = reach(a)
  const rb = reach(b)
  const common = [...ra].filter((x) => rb.has(x))
  if (common.length === 0) return null
  // nearest common successor: the one with the smallest reachable set
  let best = null
  let bestSize = Infinity
  for (const c of common) {
    const size = reach(c).size
    if (size < bestSize) {
      bestSize = size
      best = c
    }
  }
  return best
}

// --- emit -------------------------------------------------------------------
const out = []
out.push('/*')
out.push(' * Structured decompilation — TikTok mssdk / byted_acrawler JSVMP')
out.push(' *')
out.push(' * A transcription of third-party code (byted_acrawler), kept as evidence.')
out.push(' * It is not written to be executed and preserves the target’s behaviour,')
out.push(' * weaknesses included. See the README section on seed entropy.')
out.push(' *')
out.push(' * If/else and loops are rebuilt from the control-flow graph; a shape the')
out.push(' * structurer cannot prove it has shaped correctly is left as an explicit')
out.push(' * `ip = …` transfer and counted in the run report rather than guessed.')
out.push(' *')
out.push(' * Registers preloaded by the interpreter prologue:')
out.push(' *   rNull, rUndef, rTrue, rFalse  initial constant slots (writable)')
out.push(' *   rRet                          return value; writing it ends the frame')
out.push(' *   rThis, rArgs                  receiver and argument list')
out.push(' */')
out.push('')

for (const fn of fnDoc.functions) {
  out.push(
    `// fn ${fn.id} — entry ${fn.start}, ${fn.instructionCount} instructions${
      fn.calledVia.length ? `, created by ${fn.calledVia.join('/')}` : ', bootstrap'
    }`,
  )
  try {
    const lines = structureFunction(fn)
    out.push(`function fn_${fn.id}() {`)
    for (const l of lines) out.push(`  ${l}`)
    out.push('}')
  } catch (err) {
    fallback++
    out.push(`function fn_${fn.id}() { throw new Error(${JSON.stringify(`structuring failed: ${err.message}`)}) }`)
  }
  out.push('')
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'structured.js'), out.join('\n') + '\n')

console.log(`functions            ${fnDoc.functions.length}`)
console.log(`conditionals shaped  ${structured}`)
console.log(`unstructured shapes  ${fallback}`)
console.log(`output               ${path.join(OUT, 'structured.js')}`)
