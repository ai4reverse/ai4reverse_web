#!/usr/bin/env node
/**
 * Naming pass: give the remaining `v<N>` placeholders names inferred from use.
 *
 * The rename module falls back to `v<N>` when a register's defining expression
 * says nothing about its role — a property read, an argument, a value the
 * enclosing script supplied. That is honest but unreadable at 15,000 sites.
 *
 * This pass looks at how the variable is *used* rather than only at what was
 * first stored into it, and names it accordingly:
 *
 *   v7(...)   /  v7.call(…)  /  v7.apply(…)   -> callee
 *   v7[k]     /  v7.prop                      -> holder
 *   v7 < x, v7 === x, …                       -> flag
 *   assigned a string / array / object        -> text / list / obj
 *   assigned a function literal               -> fn
 *   assigned a number                         -> num
 *   assigned the result of x++ / --x          -> counter
 *   assigned a chained assignment (v = o[k] = w) -> copy
 *   used only as a call argument              -> arg
 *   used only as a computed property (o[v])   -> key
 *   used as an operand of &, |, +, <<, …      -> num
 *   used only as an object-literal value      -> value
 *   used only as `throw v`                    -> error
 *   otherwise                                 -> kept as v<N>
 *
 * Every rule is a statement about syntax, not about meaning: `holder` says the
 * value is indexed, not what it is. Where no rule applies the name is left
 * alone rather than invented, and the count of those is reported.
 *
 * Input/output: output/final.js (rewritten in place).
 *
 *   node scripts/19-name.mjs
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

const ast = parse(fs.readFileSync(FILE, 'utf8'), { sourceType: 'script' })

const FALLBACK = /^v\d+$/

/**
 * Operators whose operands are coerced to a number. `+` is included because
 * the existing rule already calls the result of `v = a + b` `num`; leaving it
 * out here would make the same expression numeric on one side of an
 * assignment and unclassified on the other.
 */
const NUMERIC_OPERATORS = new Set(['&', '|', '^', '<<', '>>', '>>>', '+', '-', '*', '/', '%'])

/** Decide a role for one identifier from every place it appears. */
function inferRole(name, fnNode) {
  let role = null
  const set = (r) => {
    if (!role) role = r
  }

  // Usage counters for the "only ever X" rules below. Those rules are
  // statements about *every* use of the name, so they cannot be answered by
  // the first-match traversal — a name that is an argument here and a property
  // key there is neither. Counting each shape and comparing the total answers
  // them exactly.
  const uses = { total: 0, callArg: 0, computedKey: 0, numericOperand: 0, objectValue: 0, throwArg: 0 }

  const visit = (node, parent, key) => {
    if (!node || typeof node !== 'object') return
    if (t.isIdentifier(node, { name })) {
      // The declaration site declares the name; it does not use the value.
      if (!(t.isVariableDeclarator(parent) && key === 'id')) {
        uses.total++
        // A value handed to a call, counted for the `arg` rule.
        if ((t.isCallExpression(parent) || t.isNewExpression(parent)) && key === 'arguments') uses.callArg++
        // A value used to index another value (`o[v]`), counted for `key`.
        if (t.isMemberExpression(parent) && key === 'property' && parent.computed) uses.computedKey++
        // A value that is thrown, counted for the `error` rule.
        if (t.isThrowStatement(parent) && key === 'argument') uses.throwArg++
        // A value placed in an object literal, counted for `value`.
        if (t.isObjectProperty(parent) && key === 'value') uses.objectValue++
        // A value consumed by arithmetic or a bitwise operator is a number:
        // every one of those operators coerces its operands to double/int32.
        if (
          (t.isBinaryExpression(parent) && NUMERIC_OPERATORS.has(parent.operator)) ||
          (t.isUnaryExpression(parent) && parent.operator === '-')
        )
          uses.numericOperand++
      }
      if (t.isCallExpression(parent) && key === 'callee') set('callee')
      else if (t.isMemberExpression(parent) && key === 'object') set('holder')
      else if (t.isBinaryExpression(parent) && ['===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(parent.operator)) set('flag')
      else if (t.isUnaryExpression(parent) && parent.operator === '!') set('flag')
      else if (t.isAssignmentExpression(parent) && key === 'right') {
        if (t.isStringLiteral(node)) set('text')
      }
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) visit(c, node, k)
      else if (v && typeof v === 'object' && v.type) visit(v, node, k)
    }
  }
  // first look at what is assigned *into* the name
  const assignShape = (node) => {
    if (!node || typeof node !== 'object') return
    if (t.isAssignmentExpression(node) && node.operator === '=' && t.isIdentifier(node.left, { name })) {
      const r = node.right
      if (t.isStringLiteral(r)) set('text')
      else if (t.isArrayExpression(r)) set('list')
      else if (t.isObjectExpression(r)) set('obj')
      else if (t.isCallExpression(r) || t.isNewExpression(r)) set('result')
      else if (t.isMemberExpression(r)) set('value')
      else if (t.isIdentifier(r)) set('copy')
      else if (t.isLogicalExpression(r)) set('bool')
      else if (t.isUnaryExpression(r) && r.operator === 'typeof') set('typeName')
      else if (t.isUnaryExpression(r)) set('num')
      else if (
        t.isBinaryExpression(r) &&
        ['===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(r.operator)
      )
        set('flag')
      else if (t.isBinaryExpression(r)) set('num')
      else if (t.isConditionalExpression(r)) set('value')
      // A function literal is the clearest statement the right-hand side can
      // make: the register holds a function, not a value it computed.
      else if (t.isFunctionExpression(r) || t.isArrowFunctionExpression(r)) set('fn')
      // A literal number is the direct evidence the value is numeric; the
      // unary/binary branches above only infer it from an operation.
      else if (t.isNumericLiteral(r)) set('num')
      // `v = copy16++` stores the value of a counter step, not a fresh number.
      else if (t.isUpdateExpression(r)) set('counter')
      // `v = o[k] = w` stores the value of the inner assignment, which is `w`.
      // Every such chain in this file ends in an identifier, so the value is a
      // copy of another variable exactly as if `v = w` had been written.
      else if (t.isAssignmentExpression(r)) set('copy')
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) assignShape(c)
      else if (v && typeof v === 'object' && v.type) assignShape(v)
    }
  }
  assignShape(fnNode)
  visit(fnNode, null, null)
  if (role) return role
  // "Only ever X" rules: every use has the one shape, so the name can say
  // which shape without claiming anything about the value itself.
  if (uses.total > 0 && uses.throwArg === uses.total) return 'error'
  if (uses.total > 0 && uses.callArg === uses.total) return 'arg'
  if (uses.total > 0 && uses.computedKey === uses.total) return 'key'
  // Any arithmetic use makes the value a number even when it is also read
  // elsewhere. `value` is the narrowest remaining claim (the value fills a
  // property slot), so it is only reached when nothing above fired.
  if (uses.numericOperand > 0) return 'num'
  if (uses.total > 0 && uses.objectValue === uses.total) return 'value'
  return null
}

let renamed = 0
let kept = 0
let functions = 0

for (const fnNode of ast.program.body) {
  if (fnNode.type !== 'FunctionDeclaration') continue
  functions++

  // collect the placeholder names this function declares
  const names = new Set()
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && FALLBACK.test(node.id.name)) names.add(node.id.name)
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) collect(c)
      else if (v && typeof v === 'object' && v.type) collect(v)
    }
  }
  collect(fnNode)

  const mapping = new Map()
  // Seed the used-name set with every identifier already in the function.
  // Without this, a role name such as `flag` collides with an existing variable
  // of that name and the output no longer parses.
  const used = new Set()
  const seed = (node) => {
    if (!node || typeof node !== 'object') return
    if (t.isIdentifier(node)) used.add(node.name)
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) seed(c)
      else if (v && typeof v === 'object' && v.type) seed(v)
    }
  }
  seed(fnNode)
  for (const name of [...names].sort()) {
    const role = inferRole(name, fnNode)
    if (!role) {
      kept++
      continue
    }
    let candidate = role
    let n = 1
    while (used.has(candidate)) candidate = `${role}${++n}`
    used.add(candidate)
    mapping.set(name, candidate)
    renamed++
  }

  if (mapping.size === 0) continue

  const rewrite = (node, parent, key) => {
    if (!node || typeof node !== 'object') return
    if (t.isIdentifier(node) && mapping.has(node.name)) {
      // a declaration target or a plain reference: safe to rename
      if (!(t.isMemberExpression(parent) && key === 'property' && !parent.computed)) {
        node.name = mapping.get(node.name)
        return
      }
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) rewrite(c, node, k)
      else if (v && typeof v === 'object' && v.type) rewrite(v, node, k)
    }
  }
  rewrite(fnNode, null, null)
}

const source = fs.readFileSync(FILE, 'utf8')
const headerLines = source.split('\n')
const headerEnd = headerLines.findIndex((l, i) => i > 0 && l === ' */')
const header = headerEnd > 0 ? headerLines.slice(0, headerEnd + 1).join('\n') : ''

// `generate` prints a node's leading comments, and the header is re-attached
// verbatim below, so the same block would be written twice. Left alone the
// file gains one more copy of its own header on every run, so remove from the
// AST the leading comment blocks that are byte-identical to the header and
// let the single re-attachment below be the only one.
if (header) {
  const first = ast.program.body[0]
  if (first?.leadingComments) {
    first.leadingComments = first.leadingComments.filter(
      (c) => source.slice(c.start, c.end).trim() !== header.trim()
    )
  }
}

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
console.log(`functions            ${functions}`)
console.log(`v<N> renamed         ${renamed}`)
console.log(`v<N> left unnamed    ${kept}`)
console.log(`v<N> occurrences     ${tally(/\bv\d+\b/g)}`)
console.log(`parses               ${parses}`)
console.log(`output               ${FILE}`)
