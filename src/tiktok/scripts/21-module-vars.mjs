#!/usr/bin/env node
/**
 * Resolve upvalue reads that target module scope into plain variables.
 *
 * The VM has two register ranges: indices below 868 are per-frame temporaries,
 * and indices at or above 868 are module-scope cells installed once by the
 * bootstrap and shared by every frame. The lift stage emits both as
 * `__upvalue(frame, depth, index)`, which is correct but hides the distinction.
 *
 * For the module range the frame walk is pointless — the target is the same
 * binding no matter which frame asks. So this pass:
 *
 *   1. collects every `__upvalue(…, index)` with index >= 868,
 *   2. declares those as top-level `let mod<N>`, and
 *   3. rewrites the call to the variable.
 *
 * Frame-local upvalues (index < 868) are left untouched: their value genuinely
 * depends on the frame chain, and resolving them needs the enclosing scopes to
 * exist, which they do not in a flat function set.
 *
 * Runs after 20-repair-memo. Input/output: output/final.js (rewritten in place).
 *
 *   node scripts/21-module-vars.mjs
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

const MODULE_BASE = 868
const moduleIds = new Set()
let resolved = 0

/** Walk every node, rewriting qualifying upvalue calls in place. */
const visit = (node) => {
  if (!node || typeof node !== 'object') return
  if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: '__upvalue' })) {
    // Three forms appear: (frame, depth, index) and (frame, index).
    const args = node.arguments
    const idx = args.length === 3 ? args[2] : args[1]
    if (idx && t.isNumericLiteral(idx) && idx.value >= MODULE_BASE) {
      moduleIds.add(idx.value)
      Object.keys(node).forEach((k) => delete node[k])
      Object.assign(node, { type: 'Identifier', name: `mod${idx.value}` })
      resolved++
      return
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue
    const v = node[k]
    if (Array.isArray(v)) for (const c of v) visit(c)
    else if (v && typeof v === 'object' && v.type) visit(v)
  }
}
visit(ast.program)

// Declare the module variables before anything that reads them. `let` at the
// top of the program is the module scope the VM's cells model.
if (moduleIds.size > 0) {
  const decl = t.variableDeclaration(
    'let',
    [...moduleIds].sort((a, b) => a - b).map((n) => t.variableDeclarator(t.identifier(`mod${n}`), null)),
  )
  ast.program.body.unshift(decl)
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
console.log(`module upvalues resolved ${resolved}`)
console.log(`module variables declared ${moduleIds.size}`)
console.log(`__upvalue remaining       ${tally(/__upvalue\(/g)}`)
console.log(`parses                    ${parses}`)
console.log(`output                    ${FILE}`)
