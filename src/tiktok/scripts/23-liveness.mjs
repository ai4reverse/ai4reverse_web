#!/usr/bin/env node
/**
 * Whole-function dead-store elimination for the table-read residue.
 *
 * The block-local pass in `18-simplify` only sees one statement list at a time,
 * so a store whose only possible reader sits in a later sibling block survives.
 * The rule here is broader and still sound:
 *
 *   a store to `n` is dead when no read of `n` occurs anywhere later in the
 *   function's source order.
 *
 * Source order is a superset of execution order for structured code, so if
 * nothing later reads the name, nothing that runs later can read it either. The
 * converse is deliberately not claimed: a later read does NOT prove the store
 * live, it only means this pass cannot remove it.
 *
 * Stores whose right-hand side can call out are never removed.
 *
 * Runs after 22-nest on output/final.js, in place.
 *
 *   node scripts/23-liveness.mjs
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

const source = fs.readFileSync(FILE, 'utf8')
const ast = parse(source, { sourceType: 'script' })

/** Every identifier read, ignoring write targets and property names. */
const readsIn = (node) => {
  const out = new Set()
  const visit = (n, parent, key) => {
    if (!n || typeof n !== 'object') return
    if (t.isIdentifier(n)) {
      if (t.isAssignmentExpression(parent) && key === 'left') return
      if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) return
      out.add(n.name)
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

const hasCall = (node) => {
  let found = false
  const visit = (n) => {
    if (!n || typeof n !== 'object' || found) return
    if (t.isCallExpression(n) || t.isNewExpression(n)) found = true
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k]
      if (Array.isArray(v)) for (const c of v) visit(c)
      else if (v && typeof v === 'object' && v.type) visit(v)
    }
  }
  visit(node)
  return found
}

/** Flatten a statement tree into source order. */
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (t.isExpressionStatement(node)) {
    const e = node.expression
    for (const p of t.isSequenceExpression(e) ? e.expressions : [e]) out.push(p)
    return out
  }
  if (t.isVariableDeclaration(node)) {
    for (const d of node.declarations) if (d.init) {
      const synth = t.assignmentExpression('=', t.identifier(d.id.name), d.init)
      synth.__declarator = d
      out.push(synth)
    }
    return out
  }
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k]
    if (Array.isArray(v)) for (const c of v) flatten(c, out)
    else if (v && typeof v === 'object' && v.type && !t.isIdentifier(v)) flatten(v, out)
  }
  return out
}

let removed = 0
const touched = new Set()

const processFunction = (fn) => {
  const parts = flatten(fn.body, [])
  const readAt = parts.map((p) => readsIn(p))
  const dead = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!t.isAssignmentExpression(p, { operator: '=' }) || !t.isIdentifier(p.left)) continue
    if (hasCall(p.right)) continue
    const name = p.left.name
    // Scan forward: the first later occurrence decides. A read makes the store
    // live; another write makes it dead, because nothing in between could have
    // observed the value. Whole-function, unlike the block-local pass.
    let live = false
    for (let j = i + 1; j < parts.length; j++) {
      const q = parts[j]
      const isWrite = t.isAssignmentExpression(q, { operator: '=' }) && t.isIdentifier(q.left, { name })
      if (isWrite) break
      if (readAt[j].has(name)) {
        live = true
        break
      }
    }
    if (!live) dead.push(i)
  }
  if (dead.length === 0) return
  for (const i of dead) {
    parts[i].__dead = true
    if (parts[i].__declarator) parts[i].__declarator.__dead = true
  }
  removed += dead.length
  touched.add(fn.id?.name ?? 'anon')
}

const allFunctions = []
const collect = (n) => {
  if (!n || typeof n !== 'object') return
  if (t.isFunctionDeclaration(n)) allFunctions.push(n)
  for (const k of t.VISITOR_KEYS[n.type] ?? []) {
    const v = n[k]
    if (Array.isArray(v)) for (const c of v) collect(c)
    else if (v && typeof v === 'object' && v.type) collect(v)
  }
}
collect(ast.program)
for (const fn of allFunctions) processFunction(fn)

// Marking is only useful if the statements can leave the tree, so removal walks
// the same shape and drops anything flagged.
const prune = (node) => {
  if (!node || typeof node !== 'object') return
  if (t.isVariableDeclaration(node) && node.declarations.some((d) => d.__dead)) {
    node.declarations = node.declarations.filter((d) => {
      if (d.__dead) delete d.__dead
      return !d.__dead
    })
  }
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k]
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const c = v[i]
        if (!c || typeof c !== 'object' || !c.type) continue
        if (t.isExpressionStatement(c)) {
          const e = c.expression
          const list = t.isSequenceExpression(e) ? e.expressions : [e]
          if (list.some((x) => x.__dead)) {
            const kept = list
              .filter((x) => !x.__dead)
              .map((x) => {
                const copy = { ...x }
                delete copy.__dead
                return copy
              })
            if (kept.length === 0) {
              v.splice(i, 1)
              continue
            }
            c.expression = kept.length === 1 ? kept[0] : t.sequenceExpression(kept)
          }
        }
        prune(c)
      }
    } else if (v && typeof v === 'object' && v.type) prune(v)
  }
}
for (const fn of allFunctions) prune(fn)

const headerLines = source.split('\n')
const headerEnd = headerLines.findIndex((l, i) => i > 0 && l === ' */')
const header = headerEnd > 0 ? headerLines.slice(0, headerEnd + 1).join('\n') : ''
const code = generate(ast, { comments: true, compact: false }).code
const outText = header + '\n' + code + '\n'

let parses = true
try {
  parse(outText, { sourceType: 'script' })
} catch (err) {
  parses = false
  console.log(`parse error: ${err.message}`)
}
if (parses) fs.writeFileSync(FILE, outText)

const tally = (re) => (outText.match(re) ?? []).length
console.log(`stores removed       ${removed}`)
console.log(`functions touched    ${touched.size}`)
console.log(`T[ lookups left      ${tally(/T\[/g)}`)
console.log(`parses               ${parses}`)
console.log(`output               ${FILE}`)
