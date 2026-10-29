#!/usr/bin/env node
/**
 * Structural map of mssdk.min.js for the per-function validator.
 *
 * Read-only. Locates the VM closure, the handler table, the bytecode/string-table
 * initialiser and the bootstrap call, and prints the enclosing function chain so
 * the harness knows exactly which source slice may be evaluated without running
 * the target.
 *
 *   node src/tiktok/scripts/_validation/02/inspect-scope.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const INPUT = path.join(REPO, 'src/tiktok/resources/mssdk.min.js')
const source = fs.readFileSync(INPUT, 'utf8')

const ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true })

/** Every function-ish node with parent links. */
const fns = []
function walk(node, parents = []) {
  if (!node || typeof node.type !== 'string') return
  const isFn =
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  const stack = isFn ? [...parents, node] : parents
  if (isFn) fns.push({ node, parents: stack })
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, stack)
    } else if (v && typeof v === 'object' && typeof v.type === 'string') {
      walk(v, stack)
    }
  }
}
walk(ast)

const TAIL = 'Y(0,void 0,l,[],0,14)'
const tailAt = source.lastIndexOf(TAIL)
console.log('bootstrap call at', tailAt)

const enclosing = fns
  .filter((f) => f.node.start <= tailAt && tailAt < f.node.end)
  .sort((a, b) => a.node.start - b.node.start)
console.log('\nenclosing function chain (outer -> inner):')
for (const f of enclosing) {
  console.log(
    `  ${f.node.type} ${f.node.start}..${f.node.end}  params=${f.node.params.length}  body=${
      f.node.body.start
    }..${f.node.body.end}`,
  )
}
const innermost = enclosing[enclosing.length - 1]
if (innermost) {
  const body = source.slice(innermost.node.body.start, innermost.node.body.end)
  console.log('\ninnermost body bytes', body.length)
  const lastStmt = innermost.node.body.body[innermost.node.body.body.length - 1]
  console.log('last statement', lastStmt?.type, lastStmt?.start, lastStmt?.end, JSON.stringify(source.slice(lastStmt?.start ?? 0, (lastStmt?.end ?? 0))).slice(0, 200))
}

// Where are the interesting literals?
const find = (needle) => {
  const at = source.indexOf(needle)
  const chain = fns
    .filter((f) => f.node.start <= at && at < f.node.end)
    .sort((a, b) => a.node.start - b.node.start)
  return { at, chain }
}
for (const needle of ['var S={},C=[]', 'C=[function(n){', 'var B={}', ',T=[', 'function J(n){', 'function Y(n,t,r,i,o,e){']) {
  const { at, chain } = find(needle)
  console.log(
    `\n${needle}\n  at ${at}  chain: ${chain.map((f) => `${f.node.type}@${f.node.start}`).join(' > ')}`,
  )
}

// Declarations of the T-array's bare identifiers: h, d, s, v, a.
// Report where they are assigned in the scope that owns T.
const tAt = source.indexOf(',T=[')
const tChain = fns.filter((f) => f.node.start <= tAt && tAt < f.node.end)
const tScope = tChain[tChain.length - 1]
console.log('\nT owner scope', tScope?.node.type, tScope?.node.start, tScope?.node.end)
