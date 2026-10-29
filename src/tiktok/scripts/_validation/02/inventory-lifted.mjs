#!/usr/bin/env node
/**
 * Inventory the lifted program per function.
 *
 * For every `fn_N` in lifted.js, classify what the body needs from outside
 * itself: module cells, unresolved upvalues, calls into sibling functions,
 * native runtime fallbacks, host globals. The validator uses this to decide
 * which functions can be driven directly and which cannot be driven without the
 * caller's frame.
 *
 * Read-only. Writes validation/02-semantics/lifted-inventory.json.
 *
 *   node src/tiktok/scripts/_validation/02/inventory-lifted.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const traverse = _traverse.default ?? _traverse

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const INPUT = path.join(REPO, 'src/tiktok/output/lifted.js')
const OUT = path.join(REPO, 'src/tiktok/validation/02-semantics/lifted-inventory.json')

const source = fs.readFileSync(INPUT, 'utf8')
const ast = parse(source, { sourceType: 'script' })

/** Collect declarations belonging to one function (not nested functions). */
function ownDeclaredNames(fnPath) {
  const names = new Set(fnPath.node.params.map((p) => p.name).filter(Boolean))
  fnPath.traverse({
    Function(inner) {
      if (inner !== fnPath) inner.skip()
    },
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier') names.add(p.node.id.name)
    },
    FunctionDeclaration(p) {
      if (p.node.id) names.add(p.node.id.name)
    },
    CatchClause(p) {
      if (p.node.param?.type === 'Identifier') names.add(p.node.param.name)
    },
  })
  return names
}

const rows = []
traverse(ast, {
  FunctionDeclaration(p) {
    const name = p.node.id?.name ?? ''
    if (!/^fn_\d+$/.test(name)) return
    const id = Number(name.slice(3))
    const declared = ownDeclaredNames(p)

    const free = new Map() // name -> count
    const calls = new Set()
    const modRefs = new Set()
    const upvalues = [] // {depth, index}
    let nativeCount = 0
    let usesState = 0
    let dynamicState = 0
    let loops = 0
    let tries = 0
    let throws = 0

    p.traverse({
      ForStatement() { loops++ },
      WhileStatement() { loops++ },
      DoWhileStatement() { loops++ },
      TryStatement() { tries++ },
      ThrowStatement() { throws++ },
      CallExpression(c) {
        const callee = c.node.callee
        if (callee.type === 'Identifier') {
          const n = callee.name
          if (n === '__upvalue') {
            // __upvalue(frame, depth, index) is also called as
            // __upvalue(frame, index): the runtime then treats depth as 1.
            const a = c.node.arguments
            if (a.length >= 3 && a[1]?.type === 'NumericLiteral' && a[2]?.type === 'NumericLiteral') {
              upvalues.push({ form: 'three-arg', depth: a[1].value, index: a[2].value })
            } else if (a[1]?.type === 'NumericLiteral') {
              upvalues.push({ form: 'two-arg', depth: 1, index: a[1].value })
            } else {
              upvalues.push({ form: 'dynamic', depth: null, index: null })
            }
          }
          if (n === '__native') nativeCount++
          if (/^fn_\d+$/.test(n)) calls.add(Number(n.slice(3)))
        }
        // __state.A[<expr>] — dynamic register access
        if (
          callee.type === 'MemberExpression' &&
          callee.object?.type === 'MemberExpression' &&
          callee.object.object?.name === '__state' &&
          callee.object.property?.name === 'A' &&
          callee.property?.type !== 'Identifier'
        ) {
          dynamicState++
        }
      },
      MemberExpression(m) {
        if (m.node.object?.type === 'Identifier' && m.node.object.name === '__state') usesState++
      },
      Identifier(i) {
        const n = i.node.name
        if (n === '__state' || n === '__upvalue' || n === '__native') {
          if (!free.has(n)) free.set(n, 0)
          free.set(n, free.get(n) + 1)
          return
        }
        if (/^fn_\d+$/.test(n)) return
        if (/^mod\d+$/.test(n)) {
          modRefs.add(Number(n.slice(3)))
          return
        }
        if (declared.has(n)) return
        if (i.parentPath.isMemberExpression({ property: i.node }) && !i.parentPath.node.computed) return
        if (i.parentPath.isObjectProperty({ key: i.node }) && !i.parentPath.node.computed) return
        if (i.parentPath.isVariableDeclarator({ id: i.node })) return
        if (i.parentPath.isFunctionDeclaration({ id: i.node })) return
        if (i.parentPath.isFunctionExpression() || i.parentPath.isArrowFunctionExpression()) return
        if (i.parentPath.isLabeledStatement()) return
        if (i.parentPath.isBreakStatement() || i.parentPath.isContinueStatement()) return
        free.set(n, (free.get(n) ?? 0) + 1)
      },
    })

    rows.push({
      id,
      start: p.node.start,
      end: p.node.end,
      bytes: p.node.end - p.node.start,
      free: Object.fromEntries([...free.entries()].sort()),
      calls: [...calls].sort((a, b) => a - b),
      mods: [...modRefs].sort((a, b) => a - b),
      upvalues,
      nativeCount,
      usesState,
      dynamicState,
      loops,
      tries,
      throws,
    })
    p.skip()
  },
})

rows.sort((a, b) => a.id - b.id)
const summary = {
  functions: rows.length,
  withUpvalue: rows.filter((r) => r.upvalues.length).length,
  withModRefs: rows.filter((r) => r.mods.length).length,
  withCalls: rows.filter((r) => r.calls.length).length,
  withNative: rows.filter((r) => r.nativeCount).length,
  withDynamicState: rows.filter((r) => r.dynamicState).length,
  withLoops: rows.filter((r) => r.loops).length,
  withTry: rows.filter((r) => r.tries).length,
  withThrow: rows.filter((r) => r.throws).length,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ summary, functions: rows }, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 1))
console.log('written', path.relative(REPO, OUT))

// Show a few representative rows.
for (const id of [44, 340, 0, 3, 46, 55]) {
  const r = rows.find((x) => x.id === id)
  if (r) console.log(id, JSON.stringify({ mods: r.mods.length, upvalues: r.upvalues.length, calls: r.calls.length, native: r.nativeCount, dynamicState: r.dynamicState, free: Object.keys(r.free) }))
}
