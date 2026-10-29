#!/usr/bin/env node
/**
 * Structural probe: locate the VM's mutable regions in the frozen original
 * snapshot (handler table `C`, string table `T`, bytecode blob) and the
 * SHA-256 IV occurrences. Read-only; prints JSON.
 *
 *   node src/tiktok/scripts/_validation/03/structure.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import { WORK } from './lib.mjs'

const traverse = _traverse.default ?? _traverse
const ORIG = path.join(WORK, 'snapshot-original.js')
const source = fs.readFileSync(ORIG, 'utf8')
const ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true })

let handlers = null
let strings = null
traverse(ast, {
  AssignmentExpression(p) {
    const { left, right } = p.node
    if (left?.type !== 'Identifier' || right?.type !== 'ArrayExpression') return
    const els = right.elements.filter(Boolean)
    const fnLike = els.filter((e) => e.type === 'FunctionExpression').length
    const strLike = els.filter((e) => e.type === 'StringLiteral').length
    if (fnLike === els.length && els.length >= 16) {
      if (!handlers || els.length > handlers.els.length) handlers = { name: left.name, els, start: right.start, end: right.end }
    }
    if (strLike >= els.length * 0.9 && els.length >= 100) {
      if (!strings || els.length > strings.els.length) strings = { name: left.name, els, start: right.start, end: right.end }
    }
  },
})

const m = /=(\w+)\.dwAbA\(R\("([A-Za-z0-9+/=]{1000,})"\)\)/.exec(source)
const inflated = m ? zlib.inflateRawSync(Buffer.from(m[2], 'base64')) : null

const sha = []
for (const pat of ['1779033703', '1116352408']) {
  let i = -1
  while ((i = source.indexOf(pat, i + 1)) >= 0) sha.push({ pat, at: i, ctx: source.slice(i - 40, i + 40) })
}

const out = {
  sourceLen: source.length,
  handlers: handlers && { name: handlers.name, count: handlers.els.length, start: handlers.start, end: handlers.end },
  strings: strings && { name: strings.name, count: strings.els.length, start: strings.start, end: strings.end },
  bytecode: m && { start: m.index, b64Len: m[2].length, inflatedLen: inflated.length },
  sha,
  stringSamples: strings && [0, 1, 3, 5, 686, 753, 754, 750].map((i) => ({
    i,
    raw: strings.els[i]?.value,
    span: strings.els[i] ? [strings.els[i].start, strings.els[i].end] : null,
  })),
}
console.log(JSON.stringify(out, null, 2))
