#!/usr/bin/env node
/**
 * Reproduce one per-function counterexample on both sides.
 *
 *   node src/tiktok/scripts/_validation/02/repro.mjs --fn 44 --args '[{}, null]'
 *   node src/tiktok/scripts/_validation/02/repro.mjs --from src/tiktok/validation/02-semantics/counterexamples/fn_44.json
 *
 * Exit code 0 when both sides agree, 1 when they differ (so the command is also
 * a gate).
 */

import fs from 'node:fs'
import path from 'node:path'
import { runOne, valueByLabel } from './run-differential.mjs'

const ARGS = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const i = ARGS.indexOf(name)
  return i >= 0 ? ARGS[i + 1] : fallback
}

let fnId = Number(opt('--fn', 'NaN'))
const profile = Number(opt('--profile', '0'))
const from = opt('--from')

/** `@undefined` is not expressible in JSON; accept it as a token. */
function revive(value) {
  if (value === '@undefined') return undefined
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]))
  }
  return value
}

let args = null
let source = ''
if (from) {
  const ce = JSON.parse(fs.readFileSync(from, 'utf8'))
  if (!Number.isFinite(fnId)) fnId = Number(ce.fn)
  const caseIndex = Number(opt('--case', '0'))
  const failure = ce.failures?.[caseIndex]
  if (!failure) throw new Error(`${from}: no failure ${caseIndex}`)
  args = failure.args.map((a) => valueByLabel(a.label))
  source = `${path.basename(from)} case ${caseIndex} (labels: ${failure.args.map((a) => a.label).join(', ')})`
} else {
  const raw = opt('--args', '[]')
  args = revive(JSON.parse(raw))
  source = `--args ${raw}`
}
if (!Number.isFinite(fnId)) throw new Error('usage: repro.mjs --fn <id> (--args <JSON array> | --from <counterexample.json>)')

const result = runOne(fnId, args, profile)
const report = { source, ...result }
console.log(JSON.stringify(report, null, 2))
process.exit(result.equal ? 0 : 1)
