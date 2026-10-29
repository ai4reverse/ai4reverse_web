#!/usr/bin/env node
/**
 * Apply one textual patch to the current runnable bundle and write a fresh
 * file (a new path, because `tools/cli.js run` serves a stale program for a
 * path it has already seen). Prints the output path.
 *
 *   node src/tiktok/scripts/dbg-patch.mjs "<find>" "<replace>"
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const WORK = path.join(ROOT, 'work', '06-boot')
const [find, replace, needle] = process.argv.slice(2)
if (!find) {
  console.error('usage: dbg-patch.mjs "<find>" "<replace>" [needle]')
  process.exit(2)
}
const source = fs.readFileSync(path.join(ROOT, 'output', 'runnable.min.js'), 'utf8')
const at = source.indexOf(find)
if (at < 0) {
  console.error(`not found: ${find.slice(0, 60)}`)
  process.exit(1)
}
const patched = source.slice(0, at) + replace + source.slice(at + find.length)
const out = path.join(WORK, `patch-${Date.now().toString(36)}.js`)
fs.writeFileSync(out, patched + `\nfunction __probe(){return String(globalThis.__mark ?? '(none)')}\n`)
console.log(out)
if (needle) {
  const n = patched.indexOf(needle)
  console.log(`needle at ${n}`)
}
