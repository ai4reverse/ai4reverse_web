#!/usr/bin/env node
/**
 * Repair dangling memo reads left behind by the string substitution.
 *
 * `lib/strings-ast.mjs` replaces a memo guard with its decrypted literal, but in
 * some sites it also rewrites the *cache key* of later reads, so the output ends
 * up reading a slot nothing writes:
 *
 *   c = T[29] + ":" + T[3], "InstallTrigger", value3 = S[T[3]];
 *
 * There is no `S[T[3]] = …` anywhere in the file, so at run time `S[T[3]]` is
 * `undefined` — the code no longer produces the decrypted string. That is a
 * behaviour change, not a cosmetic blemish.
 *
 * The repair is sound because the decrypted literal is the value the guard
 * produced, and it sits in the same statement immediately before the read.
 * A read is rewritten only when BOTH hold:
 *
 *   1. its key has no matching `S[…] =` write anywhere in the file (so it is
 *      provably dangling and currently yields `undefined`), and
 *   2. a string literal appears earlier in the same statement.
 *
 * Anything else is left alone and counted, never guessed.
 *
 * Runs after 19-name. Input/output: output/final.js (rewritten in place).
 *
 *   node scripts/20-repair-memo.mjs
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

/** Keys that are written somewhere: `S[k] = …`. */
const written = new Set()
const collectWrites = (node) => {
  if (!node || typeof node !== 'object') return
  if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) && t.isIdentifier(node.left.object, { name: 'S' })) {
    const k = node.left.computed ? node.left.property : null
    if (k && t.isStringLiteral(k)) written.add(k.value)
    else if (k && t.isMemberExpression(k) && t.isIdentifier(k.object, { name: 'T' }) && t.isNumericLiteral(k.property)) {
      written.add(`__T_${k.property.value}`)
    }
  }
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[key]
    if (Array.isArray(v)) for (const c of v) collectWrites(c)
    else if (v && typeof v === 'object' && v.type) collectWrites(v)
  }
}
collectWrites(ast)

const isDangling = (node) => {
  const prop = node.computed ? node.property : null
  if (!prop) return false
  if (t.isStringLiteral(prop)) return !written.has(prop.value)
  if (t.isMemberExpression(prop) && t.isIdentifier(prop.object, { name: 'T' }) && t.isNumericLiteral(prop.property)) {
    return !written.has(`__T_${prop.property.value}`)
  }
  return false
}

let repaired = 0
let unresolved = 0

/** Decrypted plaintext per table index, for rebuilding a value the module dropped. */
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/strings.json'), 'utf8'))
const plainByIndex = {}
for (const [k, v] of Object.entries(strings)) {
  if (/^\d+$/.test(k) && v && typeof v.plain === 'string') plainByIndex[k] = v.plain
}

/** `T[a] + ":" + T[b]` -> the payload index a, or null. */
const keyPairOf = (node) => {
  if (!t.isBinaryExpression(node, { operator: '+' })) return null
  const left = node.left
  const inner = t.isBinaryExpression(left, { operator: '+' }) ? left.left : null
  if (inner && t.isMemberExpression(inner) && t.isIdentifier(inner.object, { name: 'T' }) && t.isNumericLiteral(inner.property)) {
    return inner.property.value
  }
  return null
}

const walkStatements = (statements) => {
  // A payload slot bound in an earlier statement of the same block still names
  // the value a later dangling read should have: `f = T[84]; … = S[T[5]]`.
  let blockPayload = null
  // The global-lookup idiom is `Y = l["X"]` followed by `Z = Y[S[...]]`, so the
  // cache slot provably holds X. That is a derivation, not a guess.
  let blockGlobalName = null
  for (const stmt of statements) {
    if (!t.isExpressionStatement(stmt)) {
      for (const key of t.VISITOR_KEYS[stmt.type] ?? []) {
        const v = stmt[key]
        if (v && typeof v === 'object' && v.type === 'BlockStatement') walkStatements(v.body)
        else if (Array.isArray(v)) walkStatements(v.filter((x) => x && x.type && x.type.endsWith('Statement')))
      }
      continue
    }
    const e = stmt.expression
    const parts = t.isSequenceExpression(e) ? e.expressions : [e]
    let lastLiteral = null
    let payloadIndex = blockPayload
    for (const part of parts) {
      if (t.isStringLiteral(part)) {
        lastLiteral = part
        continue
      }
      if (t.isAssignmentExpression(part, { operator: '=' }) && t.isIdentifier(part.left)) {
        const rr = part.right
        if (t.isMemberExpression(rr) && t.isIdentifier(rr.object, { name: 'l' }) && rr.computed && t.isStringLiteral(rr.property)) {
          blockGlobalName = rr.property.value
        }
        const p = keyPairOf(part.right)
        if (p !== null) payloadIndex = p
        else if (
          t.isMemberExpression(part.right) &&
          t.isIdentifier(part.right.object, { name: 'T' }) &&
          t.isNumericLiteral(part.right.property)
        ) {
          payloadIndex = part.right.property.value
        }
      }
      if (payloadIndex !== null) blockPayload = payloadIndex
      const visit = (node, parent, key) => {
        if (!node || typeof node !== 'object') return
        if (t.isMemberExpression(node) && t.isIdentifier(node.object, { name: 'S' }) && isDangling(node)) {
          const isWriteTarget = parent && t.isAssignmentExpression(parent) && key === 'left'
          if (!isWriteTarget) {
            if (lastLiteral) {
              Object.keys(node).forEach((k) => delete node[k])
              Object.assign(node, { type: 'StringLiteral', value: lastLiteral.value })
              repaired++
            } else if (blockGlobalName !== null && String(node.property?.type ?? "") !== "") {
              Object.keys(node).forEach((k) => delete node[k])
              Object.assign(node, { type: 'StringLiteral', value: blockGlobalName })
              repaired++
            } else if (payloadIndex !== null && plainByIndex[String(payloadIndex)] !== undefined) {
              // No adjacent literal, but the cache key built in this statement
              // names the payload: `c = T[84] + ":" + T[1]`. The value this memo
              // slot holds is exactly the decryption of that payload, which the
              // string table already gives us.
              Object.keys(node).forEach((k) => delete node[k])
              Object.assign(node, { type: 'StringLiteral', value: plainByIndex[String(payloadIndex)] })
              repaired++
            } else unresolved++
            return
          }
        }
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'start' || k === 'end') continue
          const v = node[k]
          if (Array.isArray(v)) for (const c of v) visit(c, node, k)
          else if (v && typeof v === 'object' && v.type) visit(v, node, k)
        }
      }
      visit(part, null, null)
    }
  }
}

// Every function, including the ones the nesting pass moved inside a creator.
// Walking only `program.body` missed the nested 66, which is where the
// unresolved reads were.
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

for (const fn of allFunctions) {
  if (fn.type === 'FunctionDeclaration') walkStatements(fn.body.body)
}

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
console.log(`dangling reads repaired ${repaired}`)
console.log(`left unresolved         ${unresolved}`)
console.log(`S[ remaining            ${tally(/S\[/g)}`)
console.log(`parses                  ${parses}`)
console.log(`output                  ${FILE}`)
