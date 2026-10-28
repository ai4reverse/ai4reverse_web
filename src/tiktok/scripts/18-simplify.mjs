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

  /** Names a nested function binds for itself. */
  const ownBindings = (node) => {
    const names = new Set()
    for (const p of node.params ?? []) {
      if (t.isIdentifier(p)) names.add(p.name)
      else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) names.add(p.left.name)
    }
    if (t.isFunctionDeclaration(node) && node.id) names.add(node.id.name)
    const scan = (n) => {
      if (!n || typeof n !== 'object') return
      if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) names.add(n.id.name)
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
  visit(fnNode, null, null, new Set())
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
      if (withInit.length === 0) {
        parts.push({ stmt, si, keep: true, whole: true })
        return
      }
      for (const d of withInit) {
        parts.push({
          stmt,
          si,
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
    if (t.isAssignmentExpression(p.expr) && p.expr.operator === '=' && t.isIdentifier(p.expr.left) && deadNames.has(p.expr.left.name)) {
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
      if (prev && prev.keep && hasNoCalls(prev.expr.right)) {
        prev.keep = false
        counters.overwritten++
      }
      pending.set(name, p)
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
      // Keep only the declarators whose write survived.
      const keepDeclarations = group.filter((p) => p.keep).map((p) => p.declarator).filter(Boolean)
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
  return out
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
