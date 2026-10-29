#!/usr/bin/env node
/**
 * Extract the JSVMP instruction set from the bundle.
 *
 * The interpreter is `C[opcode](state)`: `C` is an array literal of handler
 * functions, `opcode` is a big-endian 16-bit index read out of the bytecode.
 * This pulls `C` apart into one file per handler and records, for each, the
 * operand readers it calls (J/L/K), the register operations (x/N/U/j/G) and the
 * control-flow helpers (H). That call profile is the raw material for a
 * semantic opcode table.
 *
 * Emits under tmp/:
 *   handlers/NNNN.js   one file per handler, index-prefixed
 *   opcodes.json       index -> {bytes, calls, reads, writes, file}
 *   opcodes.md         human-readable table
 *
 *   node scripts/03-extract-vm.mjs [input]
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'

const generate = _generate.default ?? _generate
const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const INPUT = process.argv[2] ?? path.join(ROOT, 'resources/mssdk.min.js')
const TMP = path.join(ROOT, 'tmp')

const source = fs.readFileSync(INPUT, 'utf8')
const ast = parse(source, {
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
})

// Locate the handler table: the array literal bound to a single-letter name
// whose elements are overwhelmingly function expressions. Score by element
// count rather than by name, because minified names are scope-local.
let best = null
traverse(ast, {
  VariableDeclarator(p) {
    const { id, init } = p.node
    if (id?.type !== 'Identifier' || init?.type !== 'ArrayExpression') return
    const els = init.elements.filter(Boolean)
    if (els.length < 16) return
    const fnLike = els.filter((e) => e.type === 'FunctionExpression' || e.type === 'ArrowFunctionExpression').length
    if (fnLike !== els.length) return
    if (!best || els.length > best.els.length) best = { name: id.name, init, els, path: p }
  },
  AssignmentExpression(p) {
    // `C=[]` followed later by `C=[function(){...}, ...]` is the common minified
    // shape: the declarator carries an empty array, the real table is assigned.
    const { left, right } = p.node
    if (left?.type !== 'Identifier' || right?.type !== 'ArrayExpression') return
    const els = right.elements.filter(Boolean)
    if (els.length < 16) return
    const fnLike = els.filter((e) => e.type === 'FunctionExpression' || e.type === 'ArrowFunctionExpression').length
    if (fnLike !== els.length) return
    if (!best || els.length > best.els.length) best = { name: left.name, init: right, els, path: p }
  },
})

if (!best) {
  console.error('handler table not found (no all-function array literal with >= 16 elements)')
  process.exit(1)
}

console.log(`handler table: ${best.name}  elements: ${best.els.length}  offsets ${best.init.start}..${best.init.end}`)

const handlersDir = path.join(TMP, 'handlers')
fs.rmSync(handlersDir, { recursive: true, force: true })
fs.mkdirSync(handlersDir, { recursive: true })

const READERS = { J: 'u16', K: 'u24', L: 'u8' }
const REGOPS = { x: 'get', N: 'set', U: 'setRaw', j: 'cell', G: 'postInc' }
const CONTROL = { H: 'unwind' }

const table = []
for (let i = 0; i < best.els.length; i++) {
  const el = best.els[i]
  const text = source.slice(el.start, el.end)
  const calls = new Map()
  let readers = []
  let regOps = []
  let control = []
  const literals = []

  traverse(
    {
      type: 'File',
      program: {
        type: 'Program',
        sourceType: 'script',
        body: [el],
        directives: [],
      },
    },
    {
      CallExpression(p) {
        if (p.node.callee?.type === 'Identifier') {
          const n = p.node.callee.name
          calls.set(n, (calls.get(n) ?? 0) + 1)
          if (READERS[n]) readers.push(READERS[n])
          if (REGOPS[n]) regOps.push(REGOPS[n])
          if (CONTROL[n]) control.push(CONTROL[n])
        }
      },
      NumericLiteral(p) {
        if (literals.length < 12) literals.push(p.node.value)
      },
      StringLiteral(p) {
        if (p.node.value.length <= 40 && literals.length < 12) literals.push(JSON.stringify(p.node.value))
      },
    },
  )

  const id = String(i).padStart(4, '0')
  const file = path.join(handlersDir, `${id}.js`)
  const pretty = generate(el, { comments: true, compact: false }).code
  fs.writeFileSync(
    file,
    `// handler ${id}  offsets ${el.start}..${el.end}  ${text.length} bytes\n` +
      `// reads: ${[...new Set(readers)].join(',') || '-'}   ` +
      `regops: ${[...new Set(regOps)].join(',') || '-'}   ` +
      `control: ${[...new Set(control)].join(',') || '-'}\n` +
      `// literals: ${literals.join(', ')}\n` +
      `${pretty}\n`,
  )

  table.push({
    index: i,
    start: el.start,
    end: el.end,
    bytes: text.length,
    readers: [...new Set(readers)],
    regOps: [...new Set(regOps)],
    control: [...new Set(control)],
    literals,
    file: path.relative(ROOT, file),
    calls: Object.fromEntries(calls),
  })
}

fs.writeFileSync(path.join(TMP, 'opcodes.json'), JSON.stringify({ table: best.name, count: table.length, handlers: table }, null, 2))

const md = [
  `# instruction set — table \`${best.name}\` (${table.length} handlers)`,
  '',
  '| idx | bytes | reads | regops | control | literals | file |',
  '|-----|-------|-------|--------|---------|----------|------|',
]
for (const h of table) {
  md.push(
    `| ${h.index} | ${h.bytes} | ${h.readers.join(',')} | ${h.regOps.join(',')} | ${h.control.join(',')} | ${h.literals.slice(0, 4).join(' ')} | ${h.file} |`,
  )
}
fs.writeFileSync(path.join(TMP, 'opcodes.md'), md.join('\n') + '\n')

console.log(`handlers extracted: ${table.length}`)
const totalBytes = table.reduce((n, h) => n + h.bytes, 0)
console.log(`handler bytes:      ${totalBytes}`)
for (const h of table.slice(0, 10)) {
  console.log(`  ${String(h.index).padStart(3)} ${String(h.bytes).padStart(5)}B  reads=${h.readers.join(',') || '-'} regops=${h.regOps.join(',') || '-'}`)
}
console.log(`table -> ${path.join(TMP, 'opcodes.md')}`)
