#!/usr/bin/env node
/**
 * Debug helpers for the boot investigation. Temporary; remove when done.
 *
 *   node src/tiktok/scripts/dbg-context.mjs context <file> <col> [before] [after]
 *     — print text around a 1-based column of the first line, with a caret
 *   node src/tiktok/scripts/dbg-context.mjs find <file> <literal> [count]
 *     — print 1-based columns of a literal on the first line
 */
import fs from 'node:fs'

const [, , mode, ...args] = process.argv

if (mode === 'context') {
  const [file, colArg, beforeArg = '200', afterArg = '120'] = args
  const text = fs.readFileSync(file, 'utf8').split('\n')[0]
  const col = Number(colArg)
  const start = Math.max(0, col - 1 - Number(beforeArg))
  const end = Math.min(text.length, col - 1 + Number(afterArg))
  console.log(text.slice(start, end).replace(/\n/g, '\\n'))
  console.log(`${' '.repeat(col - 1 - start)}^ col ${col}`)
} else if (mode === 'find') {
  const [file, literal, countArg = '5'] = args
  const text = fs.readFileSync(file, 'utf8').split('\n')[0]
  let from = 0
  for (let n = 0; n < Number(countArg); n++) {
    const at = text.indexOf(literal, from)
    if (at === -1) break
    console.log(`${at + 1} (0-based ${at})`)
    from = at + 1
  }
} else {
  console.log(`unknown mode ${mode}`)
  process.exit(2)
}
