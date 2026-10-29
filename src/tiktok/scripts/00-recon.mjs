#!/usr/bin/env node
/**
 * Reconnaissance: structural map of the target bundle.
 *
 * Parses the minified source, measures every function (source size, statement
 * count, branch count, nesting depth), and scores each one as a VM-dispatch or
 * control-flow-flattening candidate. Reads only; writes a JSON report to tmp/.
 *
 *   node scripts/00-recon.mjs [input] [output]
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const INPUT = process.argv[2] ?? path.join(ROOT, 'resources/mssdk.min.js')
const OUTPUT = process.argv[3] ?? path.join(ROOT, 'tmp/recon.json')

const source = fs.readFileSync(INPUT, 'utf8')
const ast = parse(source, {
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
})

const funcs = []
const fanIn = new Map()

function nodeText(node) {
  return source.slice(node.start, node.end)
}

function nameOf(p) {
  const node = p.node
  if (node.id?.name) return node.id.name
  if (p.parentPath?.isVariableDeclarator()) return p.parentPath.node.id.name
  if (p.parentPath?.isObjectProperty()) return `obj[${nodeText(p.parentPath.node.key)}]`
  if (p.parentPath?.isAssignmentExpression()) return `assign<${nodeText(p.parentPath.node.left)}>`
  return '<anonymous>'
}

traverse(ast, {
  Function(p) {
    const node = p.node
    if (!node.body) return
    const text = nodeText(node)
    let statements = 0
    let branches = 0
    let maxDepth = 0
    let loops = 0
    let calls = 0
    let computedMember = 0
    p.traverse({
      enter(s) {
        if (s.getFunctionParent()?.node !== node) return
        if (s.isStatement()) statements++
        if (s.isIfStatement() || s.isConditionalExpression() || s.isLogicalExpression()) branches++
        if (s.isLoop()) loops++
        if (s.isCallExpression()) calls++
        if (s.isMemberExpression() && s.node.computed) computedMember++
        let depth = 0
        for (let q = s.parentPath; q && q.node !== node; q = q.parentPath) {
          if (q.isFunction() || q.isLoop() || q.isConditional() || q.isSwitchStatement()) depth++
        }
        if (depth > maxDepth) maxDepth = depth
      },
    })
    funcs.push({
      name: nameOf(p),
      start: node.start,
      end: node.end,
      line: node.loc?.start.line ?? 0,
      column: node.loc?.start.column ?? 0,
      bytes: text.length,
      params: node.params.length,
      statements,
      branches,
      loops,
      calls,
      computedMember,
      maxDepth,
    })
  },
  Identifier(p) {
    if (!p.isReferencedIdentifier()) return
    const n = p.node.name
    fanIn.set(n, (fanIn.get(n) ?? 0) + 1)
  },
})

funcs.sort((a, b) => b.bytes - a.bytes)

const total = funcs.reduce((n, f) => n + f.bytes, 0)
const report = {
  input: INPUT,
  bytes: source.length,
  recoveredParseErrors: ast.errors?.length ?? 0,
  parseErrorSamples: (ast.errors ?? []).slice(0, 5).map((e) => String(e.message).slice(0, 200)),
  functionCount: funcs.length,
  functionBytes: total,
  functions: funcs,
  identifierFanIn: [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80),
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2))

console.log(`parse errors: ${report.recoveredParseErrors}`)
for (const m of report.parseErrorSamples) console.log(`  ! ${m}`)
console.log(`functions:    ${funcs.length} (${total} bytes of ${source.length})`)

console.log('\n=== 30 largest functions ===')
console.log('bytes   stmts   br   loops calls   cm    depth  name')
for (const f of funcs.slice(0, 30)) {
  console.log(
    String(f.bytes).padEnd(8),
    String(f.statements).padEnd(7),
    String(f.branches).padEnd(5),
    String(f.loops).padEnd(6),
    String(f.calls).padEnd(6),
    String(f.computedMember).padEnd(6),
    String(f.maxDepth).padEnd(6),
    f.name,
  )
}

console.log('\n=== dispatch candidates (loops>=2 && branches>=8) ===')
const dispatch = funcs.filter((f) => f.loops >= 2 && f.branches >= 8)
for (const f of dispatch.slice(0, 20)) {
  console.log(`bytes=${f.bytes} loops=${f.loops} br=${f.branches} cm=${f.computedMember} depth=${f.maxDepth} ${f.name}`)
}
if (dispatch.length === 0) console.log('(none)')

console.log('\n=== control-flow-flattening candidates (branches>=20, depth>=3) ===')
const flatten = funcs.filter((f) => f.branches >= 20 && f.maxDepth >= 3)
for (const f of flatten.slice(0, 20)) {
  console.log(`bytes=${f.bytes} loops=${f.loops} br=${f.branches} depth=${f.maxDepth} ${f.name}`)
}
if (flatten.length === 0) console.log('(none)')

console.log('\n=== top identifier fan-in ===')
for (const [name, n] of report.identifierFanIn.slice(0, 20)) {
  console.log(String(n).padStart(6), name)
}

console.log(`\nreport -> ${OUTPUT}`)
