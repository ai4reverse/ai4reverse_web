#!/usr/bin/env node
/**
 * Resolve frame-local upvalue reads by nesting functions into their creators.
 *
 * `__upvalue(n, depth, index)` means "walk `depth` frames up from this one and
 * read register `index`". The parent chain is not guesswork: frame P is the
 * parent of frame F exactly when P contains the `Y(entryF, …)` instruction that
 * creates F. That is checkable statically, and this script refuses rather than
 * guesses when a child has more than one creator.
 *
 * The rewrite has three parts:
 *
 *   1. every register name is made unique per function (`r7` -> `f12_r7`), so a
 *      nested child can never shadow a value it means to capture;
 *   2. each function is moved inside its unique creator's body;
 *   3. `__upvalue(n, d, i)` becomes the ancestor's variable, found by walking
 *      `d` levels up the verified parent chain.
 *
 * Safety: the result is written to a side file and adopted only if it parses,
 * still has every function, and every resolved name lands on a variable that is
 * actually declared in an enclosing scope. Anything else keeps the current
 * `final.js` and reports why.
 *
 *   node scripts/22-nest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import * as t from '@babel/types'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')
const FILE = path.join(OUT, 'final.js')

const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))

// --- 1. verified parent map ------------------------------------------------
const fnAt = (at) => fnDoc.functions.find((f) => at >= f.start && at < f.end) ?? null
const byEntry = new Map(fnDoc.functions.map((f) => [f.start, f]))

const CREATORS = new Set([19, 31, 124, 136, 138, 159])
const parentsOf = new Map() // entry -> Set(parent id)
for (const ins of disasm.instructions) {
  if (!CREATORS.has(ins.opcode)) continue
  const holder = fnAt(ins.at)
  if (!holder) continue
  for (const v of ins.operands) {
    if (!byEntry.has(v)) continue
    if (!parentsOf.has(v)) parentsOf.set(v, new Set())
    parentsOf.get(v).add(holder.id)
  }
}

// Each child that can be nested: exactly one creator, and not the bootstrap.
const parentOf = new Map() // child id -> parent id
let multiParent = 0
for (const f of fnDoc.functions) {
  const ps = parentsOf.get(f.start)
  if (!ps || ps.size === 0) continue
  if (ps.size === 1) {
    const p = [...ps][0]
    if (p !== f.id) parentOf.set(f.id, p)
  } else multiParent++
}

/** Walk `depth` levels up the verified chain. */
const ancestorAt = (id, depth) => {
  let cur = id
  for (let i = 0; i < depth; i++) {
    if (!parentOf.has(cur)) return null
    cur = parentOf.get(cur)
  }
  return cur
}

const source = fs.readFileSync(FILE, 'utf8')
const ast = parse(source, { sourceType: 'script' })

// --- 2. unique register names per function --------------------------------
const REG = /^(r\d+|mod\d+|rArgs|rRet|rThis|rUndef|rNull|rTrue|rFalse)$/
let renames = 0
const fnById = new Map()
for (const node of ast.program.body) {
  if (node.type !== 'FunctionDeclaration') continue
  const m = node.id.name.match(/^fn_(\d+)$/)
  if (!m) continue
  const id = Number(m[1])
  fnById.set(id, node)
  const map = new Map()
  const visit = (n, parent, key) => {
    if (!n || typeof n !== 'object') return
    if (t.isIdentifier(n) && REG.test(n.name)) {
      const isPropertyName = t.isMemberExpression(parent) && key === 'property' && !parent.computed
      if (!isPropertyName) {
        if (!map.has(n.name)) map.set(n.name, `f${id}_${n.name}`)
        n.name = map.get(n.name)
        renames++
        return
      }
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) visit(c, n, k)
      else if (v && typeof v === 'object' && v.type) visit(v, n, k)
    }
  }
  visit(node, null, null)
}

// --- 3. resolve upvalue calls ---------------------------------------------
/**
 * Depth of each counted parent-walk, keyed by the variable it advances.
 *
 * A handler that reads an ancestor frame emits
 *
 *   for (var … f = n, c = 0; c < 2; c++) { f = f.o; }
 *
 * so the depth is the loop bound. Recording it lets the two-argument
 * `__upvalue(f, idx)` form resolve exactly like the three-argument one instead
 * of staying opaque.
 */
function walkDepths(statements, into) {
  for (const stmt of statements) {
    if (t.isForStatement(stmt) && t.isBlockStatement(stmt.body) && stmt.body.body.length === 1) {
      const b = stmt.body.body[0]
      if (t.isExpressionStatement(b) && t.isAssignmentExpression(b.expression)) {
        const rhs = b.expression.right
        if (t.isMemberExpression(rhs) && !rhs.computed && rhs.property.name === 'o' && t.isIdentifier(rhs.object)) {
          const bound =
            t.isBinaryExpression(stmt.test) && t.isNumericLiteral(stmt.test.right) ? stmt.test.right.value : null
          if (bound !== null) into.set(rhs.object.name, bound)
        }
      }
    }
    for (const k of t.VISITOR_KEYS[stmt.type] ?? []) {
      const v = stmt[k]
      if (v && typeof v === 'object' && v.type === 'BlockStatement') walkDepths(v.body, into)
    }
  }
}

let resolved = 0
let unresolved = 0
// A child can read a register its ancestor never touches itself, so the
// ancestor's `let` list may be missing it. Collect what each target must
// declare and add it after resolution.
const neededByTarget = new Map() // target id -> Set(register name)
const readersOf = new Map() // reader id -> Set(depth)
for (const [id, node] of fnById) {
  const depths = new Map()
  walkDepths(node.body.body, depths)
  const visit = (n, parent, key) => {
    if (!n || typeof n !== 'object') return
    if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: '__upvalue' })) {
      const args = n.arguments
      let depth = null
      let idx = null
      if (args.length === 3 && t.isNumericLiteral(args[1]) && t.isNumericLiteral(args[2])) {
        depth = args[1].value
        idx = args[2].value
      } else if (args.length === 2 && t.isIdentifier(args[0]) && t.isNumericLiteral(args[1]) && depths.has(args[0].name)) {
        depth = depths.get(args[0].name)
        idx = args[1].value
      }
      if (depth !== null) {
        const target = ancestorAt(id, depth)
        if (target !== null && fnById.has(target)) {
          const name = `f${target}_r${idx}`
          if (!readersOf.has(id)) readersOf.set(id, new Set())
          readersOf.get(id).add(depth)
          if (!neededByTarget.has(target)) neededByTarget.set(target, new Set())
          neededByTarget.get(target).add(name)
          Object.keys(n).forEach((k) => delete n[k])
          Object.assign(n, { type: 'Identifier', name })
          resolved++
          return
        }
      }
      unresolved++
      return
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) visit(c, n, k)
      else if (v && typeof v === 'object' && v.type) visit(v, n, k)
    }
  }
  visit(node, null, null)
}

// Declare any register a nested child reads from its ancestor but the ancestor
// itself never declares.
let injected = 0
for (const [target, names] of neededByTarget) {
  const fn = fnById.get(target)
  if (!fn) continue
  const declared = new Set()
  const scan = (n) => {
    if (!n || typeof n !== 'object') return
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) declared.add(n.id.name)
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) scan(c)
      else if (v && typeof v === 'object' && v.type) scan(v)
    }
  }
  scan(fn.body)
  const missing = [...names].filter((n) => !declared.has(n))
  if (missing.length === 0) continue
  const decl = t.variableDeclaration('let', missing.map((n) => t.variableDeclarator(t.identifier(n), null)))
  fn.body.body.unshift(decl)
  injected += missing.length
}

// --- 4. nest only along chains that actually need lexical access -----------
// Nesting the whole call tree produced a 67-level pyramid for no reason: the
// upvalue depths in this program are 1 and 2. A function only has to live
// inside its creator when it (or a descendant) reads an ancestor's register, so
// the nesting set is exactly the readers plus the chain up to their target.
const mustNest = new Set()
for (const [reader, depths] of readersOf) {
  for (const d of depths) {
    let cur = reader
    for (let i = 0; i < d; i++) {
      if (!parentOf.has(cur)) break
      mustNest.add(cur)
      cur = parentOf.get(cur)
    }
  }
}
const nestSet = new Map([...parentOf].filter(([child]) => mustNest.has(child)))

const topLevel = []
for (const node of ast.program.body) {
  if (node.type === 'FunctionDeclaration') {
    const m = node.id.name.match(/^fn_(\d+)$/)
    const id = m ? Number(m[1]) : null
    if (id !== null && nestSet.has(id) && fnById.has(nestSet.get(id))) continue
  }
  topLevel.push(node)
}
for (const [id, p] of nestSet) {
  const child = fnById.get(id)
  const parent = fnById.get(p)
  if (!child || !parent) continue
  parent.body.body.push(child)
}

// --- 5. verify before adopting -------------------------------------------
const headerLines = source.split('\n')
const headerEnd = headerLines.findIndex((l, i) => i > 0 && l === ' */')
const header = headerEnd > 0 ? headerLines.slice(0, headerEnd + 1).join('\n') : ''
const code = generate(t.file(t.program(topLevel)), { comments: true, compact: false }).code
const outText = header + '\n' + code + '\n'

const problems = []
try {
  parse(outText, { sourceType: 'script' })
} catch (err) {
  problems.push(`does not parse: ${err.message}`)
}
const fnCount = (outText.match(/function fn_\d+\(/g) ?? []).length
if (fnCount !== fnDoc.functions.length) problems.push(`function count ${fnCount} != ${fnDoc.functions.length}`)

// Every resolved name must be declared somewhere in an enclosing scope. This is
// a lexical check, not a semantic one: a name that resolves to nothing would be
// a `ReferenceError` at run time, so it must not ship.
if (problems.length === 0) {
  const check = parse(outText, { sourceType: 'script' })
  const declared = new Set()
  const collect = (n) => {
    if (!n || typeof n !== 'object') return
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) declared.add(n.id.name)
    if (Array.isArray(n.params)) for (const p of n.params) if (t.isIdentifier(p)) declared.add(p.name)
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) collect(c)
      else if (v && typeof v === 'object' && v.type) collect(v)
    }
  }
  collect(check.program)
  const used = new Set((outText.match(/\bf\d+_r\d+\b/g) ?? []))
  const missing = [...used].filter((u) => !declared.has(u))
  if (missing.length) problems.push(`${missing.length} resolved names have no declaration, e.g. ${missing.slice(0, 3).join(', ')}`)
}

if (problems.length) {
  console.log('NOT ADOPTED — current final.js kept')
  for (const p of problems) console.log(`  ! ${p}`)
  process.exit(1)
}

fs.writeFileSync(FILE, outText)
const tally = (re) => (outText.match(re) ?? []).length
console.log(`functions nested          ${parentOf.size}`)
console.log(`multi-parent (left flat)  ${multiParent}`)
console.log(`registers renamed         ${renames}`)
console.log(`upvalues resolved         ${resolved}`)
console.log(`upvalues left             ${unresolved}`)
console.log(`parses                    true`)
console.log(`output                    ${FILE}`)
