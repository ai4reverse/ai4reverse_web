#!/usr/bin/env node
/**
 * Fault injection: does the index follow the working tree, and does a stale
 * answer announce itself?
 *
 * The gate's other checks measure what the index contains. This one measures
 * what happens when the tree changes underneath it — the failure mode that
 * silently serves yesterday's truth to today's question.
 *
 * The repository under test is a throwaway git repo in the temp directory, so
 * nothing in the real checkout is touched. Each mutation is reported as
 * DETECTED / STALE / SKIP; STALE is the failure that matters.
 *
 * Usage:
 *   node tools/mcp-acceptance/fault-inject.mjs [--wait 9000] [--keep]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, run } from './shared.mjs'

const BINARY = `${process.env.HOME}/.npm/_npx/1a4be6c4de01e972/node_modules/.bin/codebase-memory-mcp`
const ALIAS = 'mcp-acceptance-fault-inject'

/**
 * Call one tool through the CLI and return its parsed payload.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @returns {{ok: boolean, data?: unknown, error?: string}}
 */
const call = (tool, args) => {
  const result = run(BINARY, ['cli', '--json', tool, JSON.stringify(args)], { timeout: 240_000 })
  if (!existsSync(BINARY)) return { ok: false, error: 'codebase-memory-mcp not found' }
  if (result.stdout.trim() === '') return { ok: false, error: result.stderr.trim() || `exit ${result.code}` }
  try {
    const envelope = JSON.parse(result.stdout)
    if (envelope.isError) return { ok: false, error: String(envelope.content?.[0]?.text ?? '').slice(0, 200) }
    const text = envelope.content?.[0]?.text ?? ''
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: true, data: text }
    }
  } catch {
    return { ok: false, error: result.stdout.slice(0, 200) }
  }
}

/** Whether a text search returns at least one file. */
const finds = (pattern) => {
  const result = call('search_code', { project: ALIAS, pattern, mode: 'files', limit: 20 })
  if (!result.ok) return { error: result.error }
  const text = String(result.data)
  const files = text.split('\n').map((line) => /^\s*-\s+(.+)$/.exec(line)).filter(Boolean)
  return { hits: files.length }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  const args = parseArgs(process.argv.slice(2), { wait: '9000' })
  const waitMs = Number(args.wait)
  const work = join(tmpdir(), 'mcp-acceptance-fi')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  writeFileSync(join(work, 'alpha.mjs'), 'export function alphaFn(value) {\n  return value + 1\n}\n')
  writeFileSync(
    join(work, 'beta.mjs'),
    "import { alphaFn } from './alpha.mjs'\n\nexport const useAlpha = () => alphaFn(1)\n",
  )
  run('git', ['init', '-q'], { cwd: work })
  run('git', ['add', '-A'], { cwd: work })
  run('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture'], { cwd: work })

  const indexed = call('index_repository', { repo_path: work, mode: 'fast', name: ALIAS })
  if (!indexed.ok) {
    console.log(`SKIP: index_repository failed: ${indexed.error}`)
    if (!args.keep) rmSync(work, { recursive: true, force: true })
    return
  }

  const baseline = finds('alphaFn')
  const report = { work, waitMs, indexed: true, baseline, mutations: {} }

  writeFileSync(
    join(work, 'alpha.mjs'),
    'export function alphaFn(value) {\n  return value + 1\n}\n\nexport function gammaFn(value) {\n  return value * 2\n}\n',
  )
  await sleep(waitMs)
  const added = finds('gammaFn')
  report.mutations.add = {
    expected: 'DETECTED',
    result: added.error ? `ERROR ${added.error}` : added.hits > 0 ? 'DETECTED' : 'STALE',
  }

  rmSync(join(work, 'beta.mjs'))
  await sleep(waitMs)
  const removed = finds('useAlpha')
  report.mutations.remove = {
    expected: 'the removed file no longer appears',
    result: removed.error ? `ERROR ${removed.error}` : removed.hits === 0 ? 'DETECTED' : 'STALE',
  }

  console.log(JSON.stringify(report, null, 2))
  call('delete_project', { project: ALIAS })
  if (!args.keep) rmSync(work, { recursive: true, force: true })
}

await main()
