#!/usr/bin/env node
/**
 * Derive the five coverage strata mechanically.
 *
 * Nothing here is a judgement call: every file is classified from data that
 * already exists — the index database's own coverage rows, git's ignore
 * resolution, and the file's presence in the index's hash table. That is the
 * point of the gate: a claim about "what the tool can see" must be a count,
 * not an impression.
 *
 * Strata: indexed | parse_partial | excluded-subtree | gitignore | untracked.
 *
 * Usage:
 *   node tools/mcp-acceptance/strata.mjs --repo <path> [--db <path>] [--out strata.json]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs, run, indexDbPath } from './shared.mjs'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.serena',
  '.mimir',
  '.pi',
  '.ruff_cache',
  '.cache',
  'worktrees',
])

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.py', '.md', '.json',
  '.yaml', '.yml', '.sh', '.html', '.txt', '.csv',
])

const MAX_BYTES = 32 * 1024 * 1024

/** Walk the repository, skipping vendored and agent-state directories. */
const walk = (root) => {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const stats = statSync(absolute)
      if (stats.size > MAX_BYTES) continue
      const extension = entry.name.slice(entry.name.lastIndexOf('.'))
      const lines = TEXT_EXT.has(extension) ? countLines(absolute) : 0
      files.push({ rel: relative(root, absolute), lines })
    }
  }
  visit(root)
  return files
}

/** Count newline-terminated lines; a trailing partial line counts as one. */
const countLines = (absolute) => {
  const text = readFileSync(absolute, 'utf8')
  if (text.length === 0) return 0
  const newlines = text.split('\n').length - 1
  return text.endsWith('\n') ? newlines : newlines + 1
}

/** Resolve every path's ignore status, and which ignore file decided it. */
const resolveIgnores = (repo, paths) => {
  const map = new Map()
  if (paths.length === 0) return map
  const result = run('git', ['-C', repo, 'check-ignore', '-v', '--stdin'], {
    input: paths.join('\n'),
    timeout: 60_000,
  })
  for (const line of result.stdout.split('\n')) {
    const tab = line.lastIndexOf('\t')
    if (tab === -1) continue
    const meta = line.slice(0, tab)
    const path = line.slice(tab + 1)
    const first = meta.indexOf(':')
    const second = meta.indexOf(':', first + 1)
    const source = meta.slice(0, first)
    const scope = source.endsWith('.gitignore_global') || !source.startsWith(repo)
      ? 'global'
      : 'repo'
    map.set(path, { source, pattern: meta.slice(second + 1), scope })
  }
  return map
}

/** Read one column-separated query from the index database. */
const queryDb = (db, sql) => {
  const result = run('sqlite3', ['-noheader', '-separator', '\t', db, sql], { timeout: 60_000 })
  if (!result.ok) return null
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
}

const main = () => {
  const args = parseArgs(process.argv.slice(2), { repo: process.cwd() })
  const repo = String(args.repo).replace(/\/$/, '')
  const db = String(args.db ?? indexDbPath(repo))
  const out = args.out ? String(args.out) : null

  const files = walk(repo)
  const ignore = resolveIgnores(repo, files.map((file) => file.rel))

  const coverage = queryDb(db, 'select rel_path, kind, detail from index_coverage')
  const hashes = queryDb(db, 'select rel_path from file_hashes')

  const parsePartial = new Set()
  const excludedDirs = []
  const recordedIgnored = new Map()
  for (const row of coverage ?? []) {
    const [path, kind, detail] = row
    if (kind === 'parse_partial') parsePartial.add(path)
    if (kind === 'not_indexed_dir') excludedDirs.push(path)
    if (kind === 'not_indexed_file') recordedIgnored.set(path, detail)
  }
  const indexed = new Set((hashes ?? []).map((row) => row[0]))

  const spans = new Map()
  const bump = (stratum, file) => {
    const current = spans.get(stratum) ?? { files: 0, lines: 0, examples: [], paths: [] }
    current.files += 1
    current.lines += file.lines
    current.paths.push(file.rel)
    if (current.examples.length < 5) current.examples.push(file.rel)
    spans.set(stratum, current)
  }

  for (const file of files) {
    const underExcluded = excludedDirs.some(
      (directory) => file.rel === directory || file.rel.startsWith(`${directory}/`),
    )
    let stratum
    if (parsePartial.has(file.rel)) stratum = 'parse_partial'
    else if (underExcluded) stratum = 'excluded-subtree'
    else if (indexed.has(file.rel)) stratum = 'indexed'
    else if (recordedIgnored.has(file.rel) || ignore.has(file.rel)) stratum = 'gitignore'
    else stratum = 'untracked'
    bump(stratum, file)
  }

  const provenance = { global: 0, repo: 0 }
  for (const entry of ignore.values()) provenance[entry.scope] += 1

  const report = {
    repo,
    db,
    dbReadable: coverage !== null && hashes !== null,
    generatedAt: new Date().toISOString(),
    scanned: {
      files: files.length,
      lines: files.reduce((sum, file) => sum + file.lines, 0),
    },
    strata: Object.fromEntries(
      [...spans.entries()].sort((left, right) => right[1].files - left[1].files),
    ),
    ignoredByScope: provenance,
    excludedDirs,
    parsePartial: [...parsePartial],
  }

  const rows = Object.entries(report.strata)
  const width = Math.max(...rows.map(([name]) => name.length), 5)
  console.log(`repo: ${repo}`)
  console.log(`db:   ${db}${report.dbReadable ? '' : '  (unreadable — strata degraded)'}`)
  console.log('')
  for (const [name, span] of rows) {
    console.log(
      `  ${name.padEnd(width)}  ${String(span.files).padStart(5)} files  ${String(span.lines).padStart(8)} lines`,
    )
  }
  console.log('')
  console.log(`  ignore provenance: global=${provenance.global} repo=${provenance.repo}`)

  if (out) {
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`  wrote ${out}`)
  }
}

main()
