#!/usr/bin/env node
/**
 * Simplification pass: remove what the substitutions left behind.
 *
 * Replacing a string-decrypt idiom leaves debris that is dead, not wrong:
 *
 *   t = T[6] + ":" + T[5], "", text6 = "", c = T[65], a = T[3], …
 *
 * The guard was replaced by the literal, but the cache key it computed, the
 * bare literal that stood in for the guard's value, and the two table-index
 * locals are still written. They are correct JavaScript and meaningless code.
 *
 * Three eliminations, each with the condition that makes it sound:
 *
 *   1. **Dead expression statements** — a bare literal in statement position.
 *   2. **Name-dead stores** — a write to a name that is never read anywhere in
 *      the function. No analysis needed: the name has no reader at all.
 *   3. **Overwritten stores** — a write with no intervening read before the same
 *      name is written again. This is a reaching definition over one *linear*
 *      statement list, so it is only applied where the list is straight-line;
 *      loops, branches and handlers are left untouched because a store there can
 *      be read on a path this pass does not model. The removed right-hand side
 *      must also be free of calls, since a call may have an effect.
 *
 * Runs to a fixpoint, because removing a store can expose another.
 *
 * Input/output: output/final.js (rewritten in place).
 *
 *   node scripts/18-simplify.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import * as t from '@babel/types'
import { isPrologueDeclarator } from './lib/registers.mjs'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'output')
const FILE = path.join(OUT, 'final.js')

const isPureLiteral = (node) =>
  t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)

/** True when evaluating this expression cannot call out. */
function hasNoCalls(node) {
  let pure = true
  const visit = (n) => {
    if (!n || typeof n !== 'object' || !pure) return
    if (t.isCallExpression(n) || t.isNewExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n)) {
      pure = false
      return
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) visit(c)
      else if (v && typeof v === 'object' && v.type) visit(v)
    }
  }
  visit(node)
  return pure
}

/** Names read by an expression (a write target does not count as a read). */
function readsOf(node) {
  const out = new Set()
  const visit = (n, parent, key) => {
    if (!n || typeof n !== 'object') return
    if (t.isIdentifier(n)) {
      if (!(t.isAssignmentExpression(parent) && key === 'left')) out.add(n.name)
      return
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) visit(c, n, k)
      else if (v && typeof v === 'object' && v.type) visit(v, n, k)
    }
  }
  visit(node, null, null)
  return out
}

/**
 * Every name the function reads, and every name it writes.
 *
 * Nested functions that bind a name themselves are skipped for that name: a
 * handler's VM parameter is often called `t`, and counting its uses as reads of
 * the outer `t` kept 410 dead cache-key stores alive.
 */
function usage(fnNode) {
  const read = new Set()
  const written = new Set()

  /**
   * Names a nested function binds for itself.
   *
   * Only this function's own scope counts: parameters, its name, `var`
   * declarations and hoisted function declarations. The walk stops at any
   * nested function, because a `var t` inside a closure is the closure's
   * binding, not this one's. Letting those leak into the outer set made every
   * outer read of the same name look shadowed, so a store whose only readers
   * sat in a closure was classified as name-dead and deleted — that is how
   * `var t = rArgs[0]` disappeared from the md5 module while `t.exports` two
   * screens later still read it.
   *
   * `let`/`const` are deliberately not collected: they are block-scoped, and a
   * set that is unioned for the whole function would mark names shadowed in
   * sibling blocks too. Missing a shadow only makes more reads count, which
   * keeps a store alive; inventing one deletes a live store.
   */
  const ownBindings = (node) => {
    const names = new Set()
    for (const p of node.params ?? []) {
      if (t.isIdentifier(p)) names.add(p.name)
      else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) names.add(p.left.name)
    }
    if (node.id && t.isIdentifier(node.id)) names.add(node.id.name)
    const scan = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n.params)) return // nested function: its own scope
      if (t.isFunctionDeclaration(n) && n.id) names.add(n.id.name)
      if (t.isVariableDeclaration(n) && n.kind === 'var') {
        for (const d of n.declarations) if (t.isIdentifier(d.id)) names.add(d.id.name)
      }
      for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const v = n[k]
        if (Array.isArray(v)) for (const c of v) scan(c)
        else if (v && typeof v === 'object' && v.type) scan(v)
      }
    }
    if (node.body) scan(node.body)
    return names
  }

  const visit = (node, parent, key, shadowed) => {
    if (!node || typeof node !== 'object') return

    // Any node with its own parameter list opens a scope. Matching only
    // FunctionDeclaration/Expression/Arrow missed object and class methods,
    // whose `t` parameters kept the outer `t` looking live.
    if (Array.isArray(node.params)) {
      const inner = new Set(shadowed)
      for (const n of ownBindings(node)) inner.add(n)
      for (const k of t.VISITOR_KEYS[node.type] ?? []) {
        const v = node[k]
        if (Array.isArray(v)) for (const c of v) visit(c, node, k, inner)
        else if (v && typeof v === 'object' && v.type) visit(v, node, k, inner)
      }
      return
    }

    if (t.isIdentifier(node)) {
      if (shadowed.has(node.name)) return
      if (t.isAssignmentExpression(parent) && key === 'left') written.add(node.name)
      else if (t.isUpdateExpression(parent)) {
        read.add(node.name)
        written.add(node.name)
      } else if (!(t.isMemberExpression(parent) && key === 'property' && !parent.computed)) read.add(node.name)
      return
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) visit(c, node, k, shadowed)
      else if (v && typeof v === 'object' && v.type) visit(v, node, k, shadowed)
    }
  }
  // Start inside the analysed function's body, not at the function itself.
  //
  // Its own parameters and `var`s are the names being analysed, so they must
  // count as reads and writes. Entering at the function node put them in
  // `shadowed` and silently dropped every reference to them, which is why
  // `var t = rArgs[0]` in the md5 module looked like a store with no reader
  // even though `t.exports` reads it two screens later. Nested functions still
  // open their own scope through the `params` branch above.
  visit(fnNode.body, fnNode, 'body', new Set())
  return { read, written }
}

const counters = { statements: 0, nameDead: 0, overwritten: 0 }

/** Statements whose bodies must not be rewritten by this pass. */
const OPAQUE = (s) =>
  t.isWhileStatement(s) ||
  t.isForStatement(s) ||
  t.isDoWhileStatement(s) ||
  t.isForInStatement(s) ||
  t.isForOfStatement(s) ||
  t.isBlockStatement(s) ||
  t.isIfStatement(s) ||
  t.isTryStatement(s) ||
  t.isSwitchStatement(s)

/** True when the expression writes a binding of its own (`x++`, `y = …`). */
function hasNestedWrite(node) {
  let found = false
  const visit = (n) => {
    if (!n || typeof n !== 'object' || found) return
    if (t.isUpdateExpression(n) || t.isAssignmentExpression(n)) found = true
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) visit(c)
      else if (v && typeof v === 'object' && v.type) visit(v)
    }
  }
  visit(node)
  return found
}

/**
 * Rewrite one straight-line statement list.
 *
 * `deadNames` are names with no reader in the whole function. The overwrite
 * rule is applied on the flattened (statement, part) stream so a write in one
 * statement can kill a write in an earlier one.
 */
function simplifyList(statements, deadNames) {
  // flatten to parts, remembering which statement each belongs to
  const parts = []
  statements.forEach((stmt, si) => {
    if (OPAQUE(stmt)) {
      // Recurse into the body: most surviving dead stores sit inside the many
      // `if` and `while` blocks, and leaving them unvisited is why the outer
      // pass reported zero removals while liveness analysis found 1,646.
      const nested = []
      if (t.isBlockStatement(stmt)) nested.push(() => simplifyList(stmt.body, deadNames))
      if (stmt.consequent && stmt.consequent.type === 'BlockStatement') {
        nested.push(() => simplifyList(stmt.consequent.body, deadNames))
      }
      if (stmt.alternate && stmt.alternate.type === 'BlockStatement') {
        nested.push(() => simplifyList(stmt.alternate.body, deadNames))
      }
      if (stmt.body && stmt.body.type === 'BlockStatement') {
        nested.push(() => simplifyList(stmt.body.body, deadNames))
      }
      if (stmt.handler?.body) nested.push(() => simplifyList(stmt.handler.body.body, deadNames))
      if (stmt.finalizer) nested.push(() => simplifyList(stmt.finalizer.body, deadNames))
      for (const fn of nested) fn()
      parts.push({ stmt, si, keep: true, whole: true })
      return
    }
    // A `var c = T[11], a = T[5]` declaration writes `c` and `a`, and those
    // writes are overwritten a statement later once the memo that used them is
    // gone. Treating the whole declaration as opaque kept every one of them.
    if (t.isVariableDeclaration(stmt)) {
      const withInit = stmt.declarations.filter((d) => d.init)
      // The interpreter's seeded registers (`rNull`, `rUndef`, `rTrue`,
      // `rFalse`, `rRet`, `rThis`, `rArgs`) are *declarations*, not stores.
      // Decomposing them into assignments let the overwrite rule delete them
      // one by one, and dropping `rUndef` left every later read of it dangling —
      // the function threw `ReferenceError: rUndef is not defined` on entry.
      if (withInit.length === 0 || withInit.every(isPrologueDeclarator)) {
        parts.push({ stmt, si, keep: true, whole: true })
        return
      }
      for (const d of withInit) {
        // `keep` must be stated: the rebuild keeps only parts whose write
        // survived, and a part created without it was filtered out on every
        // pass. That silently deleted every initialised declaration in
        // statement position — `var t = rArgs[0]` in the md5 module went
        // missing while the `t.exports` that reads it stayed, so the function
        // threw `TypeError: cannot read property 'exports' of undefined`.
        parts.push({
          stmt,
          si,
          keep: true,
          declarator: d,
          expr: t.assignmentExpression('=', t.identifier(d.id.name), d.init),
        })
      }
      return
    }
    if (!t.isExpressionStatement(stmt)) {
      parts.push({ stmt, si, keep: true, whole: true })
      return
    }
    const e = stmt.expression
    const list = t.isSequenceExpression(e) ? e.expressions : [e]
    list.forEach((expr) => parts.push({ stmt, si, expr, keep: true }))
  })

  // 1 + 2: literals and name-dead stores
  for (const p of parts) {
    if (p.whole) continue
    if (isPureLiteral(p.expr)) {
      p.keep = false
      counters.statements++
      continue
    }
    // A module cell is shared program state: no per-function dead-name analysis
    // can prove its store unused.
    if (t.isAssignmentExpression(p.expr) && p.expr.operator === '=' && t.isIdentifier(p.expr.left) && !/^mod\d+$/.test(p.expr.left.name) && deadNames.has(p.expr.left.name)) {
      p.keep = false
      counters.nameDead++
    }
  }

  // 3: overwritten stores, over the surviving straight-line stream only
  const pending = new Map() // name -> part
  for (const p of parts) {
    if (p.whole) {
      // An opaque construct can read anything *inside it*, but only the names
      // it actually mentions. Clearing the whole pending map kept every store
      // that preceded a branch, which is most of them; clearing just the names
      // the branch touches is equally sound and far more precise.
      {
        const seen = new Set()
        const scan = (n) => {
          if (!n || typeof n !== 'object') return
          if (t.isIdentifier(n) && !seen.has(n.name)) {
            seen.add(n.name)
            pending.delete(n.name)
          }
          for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const v = n[k]
            if (Array.isArray(v)) for (const c of v) scan(c)
            else if (v && typeof v === 'object' && v.type) scan(v)
          }
        }
        scan(p.stmt)
      }
      continue
    }
    if (!p.keep) continue
    if (t.isAssignmentExpression(p.expr) && p.expr.operator === '=' && t.isIdentifier(p.expr.left)) {
      const name = p.expr.left.name
      const prev = pending.get(name)
      // A part that *reads* the name before writing it is not an overwrite:
      // `r7 = r7.call(…)` consumes the previous value, so removing the store
      // that produced it leaves `undefined.call(…)`. Only a write whose own
      // right-hand side never mentions the name can kill the earlier one.
      const readsHere = readsOf(p.expr)
      if (prev && prev.keep && !/^mod\d+$/.test(name) && !readsHere.has(name) && hasNoCalls(prev.expr.right) && !hasNestedWrite(prev.expr.right)) {
        prev.keep = false
        counters.overwritten++
      }
      pending.set(name, p)
      for (const r of readsHere) pending.delete(r)
      continue
    }
    for (const r of readsOf(p.expr)) pending.delete(r)
  }

  // rebuild statements
  const byStatement = new Map()
  for (const p of parts) {
    if (!byStatement.has(p.si)) byStatement.set(p.si, [])
    byStatement.get(p.si).push(p)
  }
  const out = []
  for (let si = 0; si < statements.length; si++) {
    const group = byStatement.get(si) ?? []
    const head = group[0]
    if (head?.whole) {
      out.push(head.stmt)
      continue
    }
    const isDecl = group.some((p) => p.declarator)
    if (isDecl) {
      // Keep only the declarators whose write survived — plus every declarator
      // that never had an initialiser, since those are not stores and were
      // never in the rewrite stream. Rebuilding from the stream alone deleted
      // them: `var i, o, e = r.call(n), u = []` came out as `var e = …, u = []`
      // and the function then assigned to undeclared `i`/`o` under a strict
      // caller.
      //
      // A declarator whose *store* was removed is kept without its initialiser.
      // Dropping the declarator entirely also dropped the only declaration of
      // the name, so a later `o = …` (here the cell loop's exit value) wrote an
      // enclosing binding instead — `o` was a string in the module scope, then
      // became the number 1146, and `o.slice(…)` threw `TypeError: not a
      // function` on the module initialiser's first line.
      const keptDeclarators = new Set(group.filter((p) => p.keep).map((p) => p.declarator))
      const keepDeclarations = statements[si].declarations.map((d) =>
        !d.init || keptDeclarators.has(d) ? d : t.variableDeclarator(d.id, null),
      )
      if (keepDeclarations.length === 0) continue
      statements[si].declarations = keepDeclarations
      out.push(statements[si])
      continue
    }
    const kept = group.filter((p) => p.keep).map((p) => p.expr)
    if (kept.length === 0) continue
    statements[si].expression = kept.length === 1 ? kept[0] : t.sequenceExpression(kept)
    out.push(statements[si])
  }
  return out
}

const ast = parse(fs.readFileSync(FILE, 'utf8'), { sourceType: 'script' })
let functionsTouched = 0
let foldedWalks = 0

/**
 * Fold a parent-chain walk into the upvalue call that follows it.
 *
 * The lift stage emits `j(e, r)` as `__upvalue(e, r)` together with the loop
 * that produced `e`:
 *
 *   for (var u = n, f = 0; f < 4; f++) { u = u.o; }
 *   result = __upvalue(u, 896);
 *
 * The loop exists only to compute a depth, so it collapses to
 *
 *   result = __upvalue(n, 4, 896);
 *
 * which is the same information with the noise removed and the depth stated
 * rather than implied by a walk.
 */
function foldUpvalueWalks(statements) {
  const out = []
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]
    const next = statements[i + 1]
    if (
      t.isForStatement(stmt) &&
      t.isBlockStatement(stmt.body) &&
      stmt.body.body.length === 1 &&
      t.isExpressionStatement(stmt.body.body[0]) &&
      t.isAssignmentExpression(stmt.body.body[0].expression) &&
      t.isMemberExpression(stmt.body.body[0].expression.right) &&
      !stmt.body.body[0].expression.right.computed &&
      stmt.body.body[0].expression.right.property.name === 'o' &&
      next &&
      t.isExpressionStatement(next)
    ) {
      const loopVar = t.isVariableDeclaration(stmt.init)
        ? stmt.init.declarations.find((d) => d.init && t.isIdentifier(d.init))
        : null
      const counter = t.isVariableDeclaration(stmt.init)
        ? stmt.init.declarations.find((d) => d.init && t.isNumericLiteral(d.init))
        : null
      const bound = t.isBinaryExpression(stmt.test) && t.isNumericLiteral(stmt.test.right) ? stmt.test.right.value : null
      if (loopVar && counter && bound !== null && stmt.update) {
        let folded = false
        const visit = (node, parent, key) => {
          if (!node || typeof node !== 'object') return
          if (
            t.isCallExpression(node) &&
            t.isIdentifier(node.callee, { name: '__upvalue' }) &&
            node.arguments.length === 2 &&
            t.isIdentifier(node.arguments[0], { name: loopVar.id.name })
          ) {
            node.arguments = [loopVar.init, t.numericLiteral(bound), node.arguments[1]]
            folded = true
            return
          }
          for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end') continue
            const v = node[k]
            if (Array.isArray(v)) for (const c of v) visit(c, node, k)
            else if (v && typeof v === 'object' && v.type) visit(v, node, k)
          }
        }
        visit(next, null, null)
        if (folded) {
          foldedWalks++
          out.push(next)
          i++ // skip the loop and the statement it fed
          continue
        }
      }
    }
    out.push(stmt)
  }

  // A walk left over after folding is dead scaffolding: it advances a frame
  // pointer the lifted model does not have, and `__state.o` is `null`, so
  // running it throws `TypeError: cannot read property 'o' of null` — the first
  // upvalue walk in `fn_334` survived its own fold and the whole boot died
  // there. Drop it unless a two-argument `__upvalue(<same variable>, …)` still
  // depends on it; `22-nest.mjs` derives such a call's depth from exactly this
  // loop, so removing it would leave that call unresolvable.
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
  const neededWalks = new Set()
  const scanUpvalues = (node) => {
    if (!node || typeof node !== 'object') return
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name: '__upvalue' }) &&
      node.arguments.length === 2 &&
      t.isIdentifier(node.arguments[0])
    ) {
      neededWalks.add(node.arguments[0].name)
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) scanUpvalues(c)
      else if (v && typeof v === 'object' && v.type) scanUpvalues(v)
    }
  }
  for (const stmt of out) scanUpvalues(stmt)
  const remaining = []
  for (const stmt of out) {
    const variable = walkVariable(stmt)
    // A walk that no two-argument `__upvalue` uses is dead scaffolding: it
    // advances a frame pointer the lifted model does not have, and running it
    // throws `TypeError: cannot read property 'o' of null` (the first walk in
    // `fn_334` survived its own fold and the boot died there).
    //
    // A walk that IS still used is left exactly as it is: `22-nest.mjs` matches
    // this shape to derive the upvalue depth, and rewriting the body to
    // `f = f && f.o` silently broke that match — resolved upvalues dropped from
    // 139 to 77.
    if (variable !== null && !neededWalks.has(variable)) {
      foldedWalks++
      continue
    }
    remaining.push(stmt)
  }
  return remaining
}

// Every function declaration, including the ones the nesting pass moved inside
// their creator. Walking only `program.body` reached 80 of 146; the other 66 —
// where most of the surviving dead stores live — were never visited.
const allFunctions = []
const collectFunctions = (node) => {
  if (!node || typeof node !== 'object') return
  if (t.isFunctionDeclaration(node)) allFunctions.push(node)
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k]
    if (Array.isArray(v)) for (const c of v) collectFunctions(c)
    else if (v && typeof v === 'object' && v.type) collectFunctions(v)
  }
}
collectFunctions(ast.program)

for (const node of allFunctions) {
  const { read, written } = usage(node)
  const dead = new Set()
  for (const name of written) if (!read.has(name)) dead.add(name)

  let changed = false
  for (let round = 0; round < 5; round++) {
    const before = counters.statements + counters.nameDead + counters.overwritten
    node.body.body = simplifyList(node.body.body, dead)
    node.body.body = foldUpvalueWalks(node.body.body)
    if (counters.statements + counters.nameDead + counters.overwritten === before) break
    changed = true
  }
  if (changed) functionsTouched++
}

const source = fs.readFileSync(FILE, 'utf8')
const headerLines = source.split('\n')
const headerEnd = headerLines.findIndex((l, i) => i > 0 && l === ' */')
const header = headerEnd > 0 ? headerLines.slice(0, headerEnd + 1).join('\n') : ''
const body = generate(ast, { comments: true, compact: false }).code
const outText = header + '\n' + body + '\n'

let parses = true
try {
  parse(outText, { sourceType: 'script' })
} catch (e) {
  parses = false
  console.log(`parse error: ${e.message}`)
}
if (parses) fs.writeFileSync(FILE, outText)

const tally = (re) => (outText.match(re) ?? []).length
console.log(`functions touched    ${functionsTouched}`)
console.log(`dead statements      ${counters.statements}`)
console.log(`name-dead stores     ${counters.nameDead}`)
console.log(`overwritten stores   ${counters.overwritten}`)
console.log(`upvalue walks folded ${foldedWalks}`)
console.log(`T[ lookups left      ${tally(/T\[/g)}`)
console.log(`parses               ${parses}`)
console.log(`output               ${FILE}`)
