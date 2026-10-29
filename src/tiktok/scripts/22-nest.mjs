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

const source = fs.readFileSync(FILE, 'utf8')
const ast = parse(source, { sourceType: 'script' })

/**
 * Parent id of every function the lift linked a call to, read from the call
 * sites themselves.
 *
 * `Y(entry, frame, this, arguments, 0, hint)` is the interpreter's only way to
 * run a function, and it always builds a new frame whose `o` is the frame it is
 * handed. The lift already turns every such call into `fn_<id>(this, args)` and
 * leaves it inside the function whose frame is passed, so the call site *is*
 * the parent edge: `fn_K(...)` occurring in `fn_P` means P's frame is K's
 * parent. Handlers that stash their frame in a closure keep this true, because
 * the closure captures the same frame the inlined call sees.
 *
 * Deriving the edge from the disassembly instead was wrong twice over: the
 * operand positions differ per opcode, so unrelated operands that merely look
 * like an entry added phantom parents (`fn_1` appeared to have three), and the
 * module initialiser hard-codes its 194 `Y(<entry>, …)` calls with no operands
 * at all, so its children had none.
 */
const parentCandidates = new Map() // child id -> Set(parent id)
const noteEdge = (child, parent) => {
  if (!Number.isInteger(child) || !Number.isInteger(parent) || child === parent) return
  if (!parentCandidates.has(child)) parentCandidates.set(child, new Set())
  parentCandidates.get(child).add(parent)
}
const fnCalleeId = (node) => {
  if (!t.isIdentifier(node.callee)) return null
  const match = /^fn_(\d+)$/.exec(node.callee.name)
  return match ? Number(match[1]) : null
}
for (const node of ast.program.body) {
  if (!t.isFunctionDeclaration(node)) continue
  const parentMatch = /^fn_(\d+)$/.exec(node.id?.name ?? '')
  if (!parentMatch) continue
  const parentId = Number(parentMatch[1])
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (t.isCallExpression(n)) {
      const child = fnCalleeId(n)
      if (child !== null) noteEdge(child, parentId)
    }
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
      const value = n[key]
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object' && value.type) visit(value)
    }
  }
  visit(node.body)
}

// Opcodes whose handler calls `Y(entry, frame, this, arguments, 0, hint)`.
//
// Used only as a fallback for a function the lift never linked a call to. Every
// `Y(` call site in `tmp/handlers` passes `n` or an alias (`var t = n`) of the
// handler's own frame, so the holder is the parent; several opcodes take the
// entry from an operand, and one handler hard-codes its entries.
const CREATORS = new Set([12, 19, 31, 46, 55, 91, 103, 124, 134, 136, 138, 159, 247, 263, 312])

const handlerEntriesCache = new Map()
const handlerEntries = (opcode) => {
  if (handlerEntriesCache.has(opcode)) return handlerEntriesCache.get(opcode)
  const file = path.join(TMP, 'handlers', String(opcode).padStart(4, '0') + '.js')
  const entries = []
  if (fs.existsSync(file)) {
    const handlerSource = fs.readFileSync(file, 'utf8')
    for (const match of handlerSource.matchAll(/[^A-Za-z_$.]Y\(\s*(\d+)\s*,/g)) entries.push(Number(match[1]))
  }
  handlerEntriesCache.set(opcode, entries)
  return entries
}

const fallbackParents = new Map() // entry -> Set(parent id)
for (const ins of disasm.instructions) {
  if (!CREATORS.has(ins.opcode)) continue
  const holder = fnAt(ins.at)
  if (!holder) continue
  for (const entry of [...ins.operands, ...handlerEntries(ins.opcode)]) {
    if (!byEntry.has(entry)) continue
    if (!fallbackParents.has(entry)) fallbackParents.set(entry, new Set())
    fallbackParents.get(entry).add(holder.id)
  }
}

const parentsOf = new Map() // child id -> Set(parent id)
for (const f of fnDoc.functions) {
  const linked = parentCandidates.get(f.id)
  if (linked && linked.size) parentsOf.set(f.id, linked)
  else if (fallbackParents.has(f.start)) parentsOf.set(f.id, fallbackParents.get(f.start))
}

// Each child that can be nested: exactly one creator, and not the bootstrap.
const parentOf = new Map() // child id -> parent id
let multiParent = 0
for (const f of fnDoc.functions) {
  const ps = parentsOf.get(f.id)
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

// --- 2. unique register names per function --------------------------------
// Frame-local registers only. Module cells (`mod<N>`) are deliberately NOT in
// this set: they are one binding shared by every function, declared once at
// program scope by the lift stage. Prefixing them per function produced
// `f3_mod947` inside a body while the declaration stayed `mod947`, so every
// module cell read `undefined` and the bootstrap died on its first store.
const REG = /^(r\d+|rArgs|rRet|rThis|rUndef|rNull|rTrue|rFalse)$/
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

// --- 3a. drop frame-walk loops that no upvalue needs any more --------------
/**
 * `for (…; c < n; c++) { f = f.o }` advances a frame pointer so a following
 * `__upvalue(f, idx)` can read an ancestor's register. After resolution there
 * is no such call left, and the lifted runtime has no frame chain at all
 * (`__state.o` is `null`), so the loop can only throw
 * `TypeError: cannot read property 'o' of null` — which is exactly where the
 * boot died in `fn_334`. A walk that still feeds an unresolved call is kept.
 */
{
  const walkVariable = (stmt) => {
    if (!t.isForStatement(stmt) || !t.isBlockStatement(stmt.body) || stmt.body.body.length !== 1) return null
    const body = stmt.body.body[0]
    if (!t.isExpressionStatement(body) || !t.isAssignmentExpression(body.expression)) return null
    const { left, right } = body.expression
    if (!t.isIdentifier(left)) return null
    if (!t.isMemberExpression(right) || right.computed || right.property.name !== 'o') return null
    if (!t.isIdentifier(right.object, { name: left.name })) return null
    return left.name
  }
  let pruned = 0
  for (const [, fn] of fnById) {
    const needed = new Set()
    const scanUpvalue = (n) => {
      if (!n || typeof n !== 'object') return
      if (
        t.isCallExpression(n) &&
        t.isIdentifier(n.callee, { name: '__upvalue' }) &&
        n.arguments.length === 2 &&
        t.isIdentifier(n.arguments[0])
      ) {
        needed.add(n.arguments[0].name)
      }
      for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const v = n[k]
        if (Array.isArray(v)) for (const c of v) scanUpvalue(c)
        else if (v && typeof v === 'object' && v.type) scanUpvalue(v)
      }
    }
    scanUpvalue(fn.body)
    const kept = []
    for (const stmt of fn.body.body) {
      const variable = walkVariable(stmt)
      if (variable === null || needed.has(variable)) {
        kept.push(stmt)
        continue
      }
      // The walk itself is dead, but its *init* carries real work: the emitted
      // shape is `for (r114 = mod903.v, f = __state, c = 0; c < 1; c++) { f = f.o }`,
      // so dropping the statement also dropped `r114 = mod903.v` and `init` then
      // called `undefined.call(…)`. Keep everything in the init except the frame
      // pointer bookkeeping.
      pruned++
      const init = stmt.init
      if (t.isVariableDeclaration(init)) {
        kept.push(init)
        continue
      }
      const expressions = t.isSequenceExpression(init) ? init.expressions : init ? [init] : []
      const meaningful = expressions.filter((e) => {
        if (!t.isAssignmentExpression(e) || !t.isIdentifier(e.left)) return true
        return e.left.name !== variable && e.left.name !== 'f' && e.left.name !== 'c'
      })
      if (meaningful.length) kept.push(t.expressionStatement(meaningful.length === 1 ? meaningful[0] : t.sequenceExpression(meaningful)))
    }
    fn.body.body = kept
  }
  if (pruned) console.log(`frame walks pruned       ${pruned}`)
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

// --- 3b. unique local names for a nested child ----------------------------
/**
 * A function that is moved into its creator must not share a *name* with the
 * ancestor it lands in.
 *
 * The lift keeps the handler's own variable names (`e`, `t`, `r`, …) and the
 * names of the VM's function wrappers, and nothing stops two handlers from
 * using the same short name. While every function was top level that was
 * harmless — each had its own scope. Once a child is nested, a child that
 * assigns `e` writes the ancestor's `e`: the bootstrap's `function e(n) { return
 * fn_30(this, arguments); }` wrapper was overwritten with the string
 * `"g8q]RE7XC0pSWgRattached_lo"` by a nested handler, and `fn_3` then threw
 * `TypeError: not a function` at `mod946.v = e({})`.
 *
 * Registers already get this treatment (`r7` -> `f12_r7`); this applies the same
 * idea to everything else a function declares for itself. Free variables keep
 * their name, because they must still resolve outward, and module cells keep
 * theirs because they are one binding shared by the whole program.
 */
const LOCAL_PREFIX = /^f\d+_/
const RESERVED_LOCAL = /^(mod\d+|r\d+|rArgs|rRet|rThis|rUndef|rNull|rTrue|rFalse)$/

/** Names a function binds for itself (parameters, `var`/`let`/`const`, functions, catch). */
function ownDeclarations(fnNode) {
  const names = new Set()
  for (const p of fnNode.params ?? []) if (t.isIdentifier(p)) names.add(p.name)
  const scan = (n) => {
    if (!n || typeof n !== 'object') return
    // The declaration's *name* belongs to the enclosing scope, so it is
    // recorded before the nested-function early return. Checking `params`
    // first skipped it, and a function declaration (`function e(n) {…}`) was
    // never renamed even though the name was the one colliding.
    if (t.isFunctionDeclaration(n) && n.id) names.add(n.id.name)
    if (Array.isArray(n.params)) return // a nested function: its own scope
    if (t.isVariableDeclaration(n)) for (const d of n.declarations) if (t.isIdentifier(d.id)) names.add(d.id.name)
    if (t.isCatchClause(n) && t.isIdentifier(n.param)) names.add(n.param.name)
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(scan)
      else if (v && typeof v === 'object' && v.type) scan(v)
    }
  }
  if (fnNode.body) scan(fnNode.body)
  return names
}

/** True for an identifier position that is a name, not a variable reference. */
function isNamePosition(parent, key) {
  if (!parent) return false
  if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) return true
  if ((t.isObjectProperty(parent) || t.isObjectMethod(parent) || t.isClassMethod(parent) || t.isClassProperty(parent)) && key === 'key' && !parent.computed) return true
  if (t.isLabeledStatement(parent) && key === 'label') return true
  if ((t.isBreakStatement(parent) || t.isContinueStatement(parent)) && key === 'label') return true
  return false
}

let localRenames = 0
const renamedLocals = new Set()
/**
 * Rename the declarations `fnNode` owns, and every reference to them, to
 * `f<id>_<name>`. References inside a nested function that declares the same
 * name are that function's own binding and are left alone.
 */
function uniqueLocalNames(id, fnNode) {
  const declared = ownDeclarations(fnNode)
  const map = new Map()
  for (const name of declared) {
    if (RESERVED_LOCAL.test(name) || LOCAL_PREFIX.test(name)) continue
    map.set(name, `f${id}_${name}`)
  }
  if (map.size === 0) return 0

  const rename = (n, parent, key, shadowed) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n.params)) {
      // A function declaration's name is bound in the *enclosing* scope, so it
      // is renamed here; its parameters and its own `var`s shadow ours inside
      // the body. The declaration's own name is deliberately not added to the
      // shadow set: references to it inside the body are the same binding and
      // must be renamed too.
      if (t.isFunctionDeclaration(n) && n.id && map.has(n.id.name) && !shadowed.has(n.id.name)) {
        n.id.name = map.get(n.id.name)
        renamedLocals.add(n.id.name)
        localRenames++
      }
      const inner = new Set(shadowed)
      for (const name of ownDeclarations(n)) if (name !== n.id?.name) inner.add(name)
      for (const k of t.VISITOR_KEYS[n.type] ?? []) rename(n[k], n, k, inner)
      return
    }
    if (t.isIdentifier(n)) {
      if (shadowed.has(n.name) || !map.has(n.name)) return
      if (isNamePosition(parent, key)) return
      // `{e}` keeps its key and gains a renamed value.
      if (t.isObjectProperty(parent) && parent.shorthand) parent.shorthand = false
      n.name = map.get(n.name)
      renamedLocals.add(n.name)
      localRenames++
      return
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach((c) => rename(c, n, k, shadowed))
      else if (v && typeof v === 'object' && v.type) rename(v, n, k, shadowed)
    }
  }
  rename(fnNode.body, fnNode, 'body', new Set())
  return map.size
}

// Every function, not only the nested ones. A nested child's *free* names keep
// resolving outward — in this program `e` and `I` are module-scope scratch
// variables that handler 0084's SDK closure reads — and nesting it inside a
// function that declares `e` would capture the name instead. Prefixing every
// function's locals means no function declares a name another one uses freely.
for (const [id, node] of fnById) uniqueLocalNames(id, node)

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

// --- 5. declare upvalue registers the ancestor never bound ------------------
/**
 * A resolved upvalue name (`f<target>_r<idx>`) can point at a register the
 * target function never declares. In the interpreter such a slot reads as
 * `undefined` until something writes it, and the closure that reads it is a real
 * binding in the VM's frame, not a ReferenceError waiting to happen. Declaring
 * it with no initializer is the faithful translation and is what lets the nested
 * function close over the ancestor's slot.
 *
 * This runs on the tree, before generation, so the declaration is part of what
 * gets emitted and re-checked below.
 */
{
  const declaredNames = new Set()
  const collectDecl = (n) => {
    if (!n || typeof n !== 'object') return
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) declaredNames.add(n.id.name)
    if (Array.isArray(n.params)) for (const p of n.params) if (t.isIdentifier(p)) declaredNames.add(p.name)
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) collectDecl(c)
      else if (v && typeof v === 'object' && v.type) collectDecl(v)
    }
  }
  for (const node of topLevel) collectDecl(node)

  const usedNames = new Set()
  const collectUse = (n) => {
    if (!n || typeof n !== 'object') return
    if (t.isIdentifier(n) && /^f\d+_r\d+$/.test(n.name)) usedNames.add(n.name)
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) collectUse(c)
      else if (v && typeof v === 'object' && v.type) collectUse(v)
    }
  }
  for (const node of topLevel) collectUse(node)

  let repaired = 0
  for (const name of usedNames) {
    if (declaredNames.has(name)) continue
    const target = Number(name.match(/^f(\d+)_/)?.[1])
    const fn = fnById.get(target)
    if (!fn) continue
    fn.body.body.unshift(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(name), null)]))
    repaired++
  }
  if (repaired) console.log(`declared ${repaired} upvalue registers the ancestor never bound`)
}

// --- 6. verify before adopting -------------------------------------------
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
    if (t.isFunctionDeclaration(n) && n.id) declared.add(n.id.name)
    if (t.isCatchClause(n) && t.isIdentifier(n.param)) declared.add(n.param.name)
    if (Array.isArray(n.params)) for (const p of n.params) if (t.isIdentifier(p)) declared.add(p.name)
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) collect(c)
      else if (v && typeof v === 'object' && v.type) collect(v)
    }
  }
  collect(check.program)
  // Every prefixed name — resolved registers (`f12_r7`) and uniqued locals
  // (`f12_e`) alike — must be declared somewhere in an enclosing scope.
  const used = new Set((outText.match(/\bf\d+_[A-Za-z_$][\w$]*\b/g) ?? []))
  const missing = [...used].filter((u) => !declared.has(u))
  if (missing.length) problems.push(`${missing.length} prefixed names have no declaration, e.g. ${missing.slice(0, 3).join(', ')}`)
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
console.log(`local names renamed       ${localRenames} (${renamedLocals.size} distinct)`)
console.log(`upvalues resolved         ${resolved}`)
console.log(`upvalues left             ${unresolved}`)
console.log(`parses                    true`)
console.log(`output                    ${FILE}`)
