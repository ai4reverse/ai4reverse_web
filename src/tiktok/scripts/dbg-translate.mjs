#!/usr/bin/env node
/**
 * Translate one handler and report whether a literal survives, for pinning a
 * lift defect to a stage. Temporary investigation harness.
 *
 *   node src/tiktok/scripts/dbg-translate.mjs <opcode> [needle]
 */
import { translateHandler, handlerAst } from './15-lift.mjs'
import _generate from '@babel/generator'

const generate = _generate.default ?? _generate

const argv = process.argv.slice(2)
if (argv[0] === '--source') {
  // Locate the top-level statement of a handler that contains a literal.
  const [, opcodeArg, needle] = argv
  const ast = handlerAst(Number(opcodeArg))
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object') return
    if (depth === 0 && node.type?.endsWith('Statement')) {
      const text = generate(node, { comments: false }).code
      if (text.includes(needle)) {
        console.log(`statement type=${node.type} len=${text.length}`)
        console.log(text.slice(0, 400))
        if (node.type === 'ExpressionStatement' && node.expression.type === 'SequenceExpression') {
          const parts = node.expression.expressions
          console.log(`sequence parts=${parts.length}`)
          parts.forEach((p, i) => {
            const t = generate(p).code.replace(/\s+/g, ' ')
            if (t.includes(needle)) console.log(`   part ${i}: ${t.slice(0, 120)}`)
          })
        }
      }
      return
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach((c) => visit(c, node.type === 'BlockStatement' ? depth : depth))
      else if (v && typeof v === 'object') visit(v, depth)
    }
  }
  ast.body.body.forEach((s) => {
    const text = generate(s, { comments: false }).code
    if (text.includes(needle)) {
      console.log(`top-level statement type=${s.type} len=${text.length}`)
      if (s.type === 'ExpressionStatement' && s.expression.type === 'SequenceExpression') {
        const parts = s.expression.expressions
        console.log(`sequence parts=${parts.length}`)
        parts.forEach((p, i) => {
          const t = generate(p).code.replace(/\s+/g, ' ')
          if (t.includes(needle)) console.log(`   part ${i} (${p.type}): ${t.slice(0, 160)}`)
        })
      } else {
        console.log(text.slice(0, 300))
      }
    }
  })
  process.exit(0)
}

const opcode = Number(process.argv[2])
const needle = process.argv[3] ?? null
const ir = translateHandler(opcode, [])
if (!ir) {
  console.log('refused (opaque)')
  process.exit(0)
}
const code = ir.statements.map((s) => generate(s, { compact: false }).code).join('\n')
console.log(`statements ${ir.statements.length}  chars ${code.length}  operandsConsumed ${ir.operandsConsumed}`)
if (needle) {
  const hits = code.split('\n').filter((line) => line.includes(needle))
  console.log(`lines containing ${needle}: ${hits.length}`)
  for (const line of hits.slice(0, 5)) console.log('   ', line.trim().slice(0, 200))
}
