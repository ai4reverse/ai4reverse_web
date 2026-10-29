#!/usr/bin/env node
/** Probe the SMT shape prover on real instruction shapes. */
import fs from 'node:fs'
import path from 'node:path'
import { proveShape } from '../../../../tiktok/validation/02-semantics/smt-eval.mjs'
import { translateHandler } from '../../15-lift.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const V = path.join(REPO, 'src/tiktok/validation/02-semantics')
const handlers = JSON.parse(fs.readFileSync(path.join(V, 'extracted/handlers-exact.json'), 'utf8'))
const disasm = JSON.parse(fs.readFileSync(path.join(REPO, 'src/tiktok/tmp/disasm.json'), 'utf8'))

const shapes = new Map()
for (const ins of disasm.instructions) {
  const key = `${ins.opcode}:${ins.operands.join(',')}`
  if (!shapes.has(key)) shapes.set(key, ins)
}

const interesting = [294, 355, 234, 358, 302, 303, 301, 300, 2, 5, 6, 7, 8, 9, 14, 21, 23, 24, 30, 34, 45, 47, 48]
let shown = 0
for (const op of interesting) {
  const ins = [...shapes.values()].find((i) => i.opcode === op)
  if (!ins) continue
  if (shown++ > 14) break
  let ir = null
  try {
    ir = translateHandler(op, ins.operands)
  } catch (err) {
    console.log(`op${op} translate refused: ${err.message}`)
    continue
  }
  const r = await proveShape(handlers[op].source, ir, ins.operands, { timeoutMs: 2000 })
  console.log(`op${op} ${JSON.stringify(ins.operands)} -> ${r.status}`, JSON.stringify(r).slice(0, 220))
}
