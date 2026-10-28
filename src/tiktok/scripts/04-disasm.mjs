#!/usr/bin/env node
/**
 * Disassemble the JSVMP bytecode.
 *
 * The interpreter reads a big-endian 16-bit opcode and dispatches `C[opcode]`.
 * Each handler consumes its operands through `J` (u16), `L` (u8) or `K` (u24)
 * in source order, so the operand widths of an opcode are recoverable
 * statically. This walks the bytecode applying those widths and emits one line
 * per instruction.
 *
 * Validation is the point: a correct width table makes the walk land exactly on
 * `O.length` with no overrun and no leftover zero padding. If it does not tile,
 * the report says where it broke instead of emitting a plausible-looking dump.
 *
 * Emits under tmp/:
 *   bytecode.bin  inflated bytecode
 *   disasm.txt    one instruction per line
 *   disasm.json   {instructions, coverage, breaks}
 *   widths.json   opcode -> ordered operand widths
 *
 *   node scripts/04-disasm.mjs [input]
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const INPUT = process.argv[2] ?? path.join(ROOT, 'resources/mssdk.min.js')
const TMP = path.join(ROOT, 'tmp')

const source = fs.readFileSync(INPUT, 'utf8')

// --- 1. recover the bytecode -----------------------------------------------
// Shape: `var B={},O=dwInfl.dwAbA(R("<base64>"))`
function recoverBytecode() {
  const re = /=(\w+)\.dwAbA\(R\("([A-Za-z0-9+/=]{1000,})"\)\)/g
  const m = re.exec(source)
  if (!m) throw new Error('bytecode assignment `X.dwAbA(R("..."))` not found')
  const b64 = m[2]
  const raw = Buffer.from(b64, 'base64')
  const inflated = zlib.inflateRawSync(raw)
  return { b64Bytes: raw.length, inflated }
}

const { b64Bytes, inflated } = recoverBytecode()
fs.writeFileSync(path.join(TMP, 'bytecode.bin'), inflated)
console.log(`bytecode: ${b64Bytes} base64 bytes -> ${inflated.length} bytecode bytes`)

// --- 2. recover the handler table and each handler's operand widths ---------
const ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true })

let table = null
traverse(ast, {
  AssignmentExpression(p) {
    const { left, right } = p.node
    if (left?.type !== 'Identifier' || right?.type !== 'ArrayExpression') return
    const els = right.elements.filter(Boolean)
    if (els.length < 16) return
    if (!els.every((e) => e.type === 'FunctionExpression')) return
    if (!table || els.length > table.els.length) table = { name: left.name, els }
  },
})
if (!table) throw new Error('handler table not found')

const WIDTH = { J: 2, L: 1, K: 3 }

function orderedWidths(fnNode) {
  const out = []
  // Only calls whose nearest enclosing function is the handler itself count as
  // eager operand reads. A reader inside a nested closure runs later (or never),
  // and counting it would desync the whole walk.
  const visit = (node, insideNestedFn) => {
    if (!node || typeof node !== 'object') return
    const isFn =
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionDeclaration'
    if (isFn && node !== fnNode) insideNestedFn = true
    if (!insideNestedFn && node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
      const w = WIDTH[node.callee.name]
      if (w) out.push({ width: w, reader: node.callee.name, offset: node.start })
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const v = node[key]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c, insideNestedFn)
      } else if (v && typeof v.type === 'string') {
        visit(v, insideNestedFn)
      }
    }
  }
  visit(fnNode.body, false)
  return out
}

const widths = []
for (let i = 0; i < table.els.length; i++) {
  widths.push({ opcode: i, operands: orderedWidths(table.els[i]) })
}
fs.writeFileSync(path.join(TMP, 'widths.json'), JSON.stringify(widths, null, 2))

// --- 3. walk the bytecode ---------------------------------------------------
const code = inflated
const lines = []
const instructions = []
const breaks = []
let ip = 0
let count = 0

while (ip < code.length) {
  if (ip + 1 >= code.length) {
    breaks.push({ ip, reason: 'truncated opcode' })
    break
  }
  const opcode = (code[ip] << 8) | code[ip + 1]
  const at = ip
  ip += 2

  const spec = widths[opcode]
  if (!spec) {
    breaks.push({ ip: at, opcode, reason: 'opcode out of table range' })
    break
  }

  const operands = []
  let ok = true
  for (const { width } of spec.operands) {
    if (ip + width > code.length) {
      breaks.push({ ip: at, opcode, reason: 'operand overruns bytecode' })
      ok = false
      break
    }
    let v = 0
    for (let k = 0; k < width; k++) v = (v << 8) | code[ip + k]
    operands.push({ width, value: v })
    ip += width
  }
  if (!ok) break

  const text =
    `${String(at).padStart(7)}  ` +
    `op${String(opcode).padStart(3)}` +
    (operands.length ? '  ' + operands.map((o) => `0x${o.value.toString(16).padStart(o.width * 2, '0')}(${o.value})`).join(' ') : '') +
    `   ; +${ip - at}B`

  lines.push(text)
  instructions.push({ at, opcode, operands: operands.map((o) => o.value), next: ip })
  count++
}

fs.writeFileSync(path.join(TMP, 'disasm.txt'), lines.join('\n') + '\n')
fs.writeFileSync(
  path.join(TMP, 'disasm.json'),
  JSON.stringify(
    {
      bytecodeBytes: code.length,
      instructionCount: count,
      coverage: ip,
      tiled: ip === code.length && breaks.length === 0,
      breaks,
      instructions,
    },
    null,
    2,
  ),
)

// --- 4. report --------------------------------------------------------------
const opcodeUse = new Map()
for (const ins of instructions) opcodeUse.set(ins.opcode, (opcodeUse.get(ins.opcode) ?? 0) + 1)

console.log(`handler table  ${table.name} with ${table.els.length} entries`)
console.log(`instructions   ${count}`)
console.log(`coverage       ${ip} / ${code.length} bytes (${((ip / code.length) * 100).toFixed(2)}%)  tiled=${ip === code.length && breaks.length === 0}`)
console.log(`distinct opcodes used: ${opcodeUse.size} / ${table.els.length}`)
if (breaks.length) {
  console.log(`breaks: ${JSON.stringify(breaks)}`)
}
console.log('\n=== first 20 instructions ===')
for (const l of lines.slice(0, 20)) console.log(l)

const unused = []
for (let i = 0; i < table.els.length; i++) if (!opcodeUse.has(i)) unused.push(i)
console.log(`\nunused opcodes (${unused.length}): ${unused.slice(0, 40).join(',')}${unused.length > 40 ? ' ...' : ''}`)

console.log('\n=== hottest opcodes ===')
for (const [op, n] of [...opcodeUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const w = widths[op].operands.map((o) => o.width).join('')
  console.log(`  op${String(op).padStart(3)}  x${String(n).padStart(5)}  operands=${w || '-'}`)
}
