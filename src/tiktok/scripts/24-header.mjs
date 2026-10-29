#!/usr/bin/env node
/**
 * Collapse the duplicated banner comments that accumulate across re-emits.
 *
 * Every stage that rewrites `output/final.js` re-attaches its own banner and
 * re-serialises the tree with comments preserved. After four rewrites the file
 * begins with the same twenty-line banner four times and is 7.5 MB instead of
 * 1.1 MB — pure noise that makes the artifact hard to read and hard to diff.
 *
 * This stage keeps the first banner and drops later copies of an identical
 * leading block comment. It does not touch code: the tree is only re-serialised
 * after the duplicate leading comments are removed.
 *
 * Input/output: output/final.js (rewritten in place).
 *
 *   node scripts/24-header.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const FILE = path.join(ROOT, 'output/final.js')

const source = fs.readFileSync(FILE, 'utf8')
const seen = new Set()
let removed = 0

// A leading run of block comments, then the program. Matching the run rather
// than the AST keeps the pass independent of how the generator lays comments
// out on the first node.
const BANNER = /^(\/\*[\s\S]*?\*\/\s*)+/
const run = source.match(BANNER)?.[0] ?? ''
const blocks = run.match(/\/\*[\s\S]*?\*\//g) ?? []
const keptBlocks = blocks.filter((block) => {
  const key = block.trim()
  if (seen.has(key)) {
    removed++
    return false
  }
  seen.add(key)
  return true
})

if (removed === 0) {
  console.log('leading banners   unchanged')
  console.log(`output            ${FILE}`)
  process.exit(0)
}

const body = source.slice(run.length)
const rebuilt = `${keptBlocks.join('\n\n')}\n\n${body}`

// Prove the rewrite did not touch code before adopting it: the program without
// banners must generate to exactly the same text as the rewritten file with its
// banners ignored. Comments are excluded from both sides, since removing them is
// the entire point.
const opts = { comments: false }
const before = generate(parse(body, { sourceType: 'script' }), opts).code
const after = generate(parse(rebuilt, { sourceType: 'script' }), opts).code
if (before !== after) {
  console.error('refusing: stripping banners changed the generated program')
  process.exit(1)
}

fs.writeFileSync(FILE, rebuilt)
console.log(`leading banners   removed ${removed}`)
console.log(`bytes             ${source.length} -> ${rebuilt.length}`)
console.log(`code identical    yes (${before.length} bytes generated)`)
console.log(`output            ${FILE}`)
