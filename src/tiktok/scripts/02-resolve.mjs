#!/usr/bin/env node
/**
 * Resolve one identifier binding at a byte offset using Babel scope analysis.
 *
 * Minified bundles reuse short names (`R`, `n`, `t`) in dozens of scopes, so a
 * plain text search finds the wrong definition. This walks the scopes and
 * reports the binding actually visible at the offset, plus every reference to
 * it, which is what makes a decoder traceable.
 *
 *   node scripts/02-resolve.mjs <offset> <name> [input]
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const OFFSET = Number(process.argv[2] ?? 154715)
const NAME = process.argv[3] ?? 'R'
const INPUT = process.argv[4] ?? path.join(ROOT, 'resources/mssdk.min.js')

const source = fs.readFileSync(INPUT, 'utf8')
const ast = parse(source, {
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
})

let targetPath = null
traverse(ast, {
  enter(p) {
    const { start, end } = p.node
    if (start == null || end == null) return
    if (start <= OFFSET && OFFSET < end) targetPath = p
  },
})

if (!targetPath) {
  console.error(`no AST node encloses offset ${OFFSET}`)
  process.exit(1)
}

console.log(`enclosing node: ${targetPath.node.type} @ ${targetPath.node.start}..${targetPath.node.end}`)
console.log(`enclosing function: ${targetPath.getFunctionParent()?.node.type ?? '(program)'}`)

for (let p = targetPath; p; p = p.parentPath) {
  const binding = p.scope?.getBinding?.(NAME)
  if (!binding) continue
  const b = binding
  const decl = b.path.node
  console.log(`\nBOUND at scope depth of ${p.node.type}`)
  console.log(`  kind:     ${b.kind}`)
  console.log(`  decl node:${decl.type}`)
  console.log(`  decl @    ${decl.start}..${decl.end}  (${decl.end - decl.start} bytes)`)
  console.log(`  references: ${b.referencePaths.length}`)
  console.log('\n--- declaration source ---')
  console.log(source.slice(decl.start, Math.min(decl.end, decl.start + 1800)))
  console.log('\n--- first 20 reference sites ---')
  for (const r of b.referencePaths.slice(0, 20)) {
    const parent = r.parentPath?.node
    const s = parent?.start ?? r.node.start
    console.log(`  @${s}: ${source.slice(s, Math.min(s + 110, source.length)).replace(/\n/g, ' ')}`)
  }
  process.exit(0)
}

console.log(`\n${NAME} is unbound (global or free variable) at offset ${OFFSET}`)
process.exit(0)
