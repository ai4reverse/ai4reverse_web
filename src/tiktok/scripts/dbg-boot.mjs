#!/usr/bin/env node
/**
 * Build an instrumented twin of the current `output/final.js`, run it through
 * the sandbox and print the last marker plus the boot error message.
 *
 * Temporary investigation harness; the shipped pipeline is 16…27 + 29-verify.
 *
 *   node src/tiktok/scripts/dbg-boot.mjs [fnName]
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const CLI = path.join(REPO, 'tools', 'cli.js')
const fnName = process.argv[2] ?? 'fn_3'

const build = spawnSync(process.execPath, [path.join(import.meta.dirname, 'dbg-mark.mjs'), fnName, ...process.argv.slice(3)], {
  encoding: 'utf8',
})
if (build.status !== 0) {
  console.error(build.stdout, build.stderr)
  process.exit(build.status ?? 1)
}
const outFile = build.stdout.match(/^output\s+(\S+)$/m)?.[1]
if (!outFile) {
  console.error('no output path from dbg-mark:\n' + build.stdout)
  process.exit(1)
}

const run = spawnSync(
  process.execPath,
  [CLI, 'run', outFile, '--json', '--seed', '0x5eed', '--timeout', '60000', '--entry', '__probe'],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 },
)
const start = run.stdout.indexOf('{')
const parsed = start >= 0 ? JSON.parse(run.stdout.slice(start)) : null
const value = parsed?.result?.value ?? parsed?.error?.message ?? null
console.log(`file  ${path.relative(REPO, outFile)}`)
if (value === null) {
  console.log(`raw   ${run.stdout.slice(0, 2000)}`)
  console.log(`err   ${run.stderr.slice(0, 2000)}`)
  process.exit(1)
}
let payload
try {
  payload = JSON.parse(value)
} catch {
  console.log(`value ${value}`)
  process.exit(0)
}
console.log(`mark  ${payload.mark}`)
console.log(`msg   ${payload.msg}`)
console.log(`boot  ${(payload.boot ?? '').split('\n').slice(0, 8).join('\n      ')}`)
