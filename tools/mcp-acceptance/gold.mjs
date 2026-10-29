#!/usr/bin/env node
/**
 * Build a stratified gold set whose answers are computed, not authored.
 *
 * For each coverage stratum the gate picks symbols out of real files, then
 * derives the answer set with `rg --no-ignore`, i.e. an oracle that sees the
 * whole disk rather than the index. That difference is the whole point: a
 * retriever is asked to find the same references the oracle found, and any
 * stratum where it cannot is a measured fact rather than an anecdote.
 *
 * Usage:
 *   node tools/mcp-acceptance/gold.mjs --repo <path> --strata strata.json --out gold.jsonl
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, run, sample } from './shared.mjs'

const TARGET_STRATA = ['indexed', 'excluded-subtree', 'gitignore']
const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|py)$/
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES_PER_STRATUM = 240

/**
 * The reverse-engineering corpus. Excluded subtrees also contain agent state and
 * build output (`dist/`, `__pycache__/`, `.claude/`); sampling those would
 * measure the wrong thing, so the gold set is restricted by path prefix and the
 * restriction is stated here rather than hidden in a sample.
 */
const INCLUDE_PREFIXES = ['tools/', 'src/']

/**
 * Generated identifiers (`fn_136`, `fn_239`) appear in dozens of emitted
 * copies, so their answer sets say more about how much generated output exists
 * than about reference retrieval. They are excluded by name, and the answer set
 * is additionally capped so one artifact flood cannot dominate a stratum.
 */
const GENERATED_NAME = /^fn_\d+$/
const MAX_ORACLE_FILES = 15

const definitionPatterns = [
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm,
]

/** Collect declared identifiers from one file. */
const symbolsIn = (absolute) => {
  const text = readFileSync(absolute, 'utf8')
  const found = new Set()
  for (const pattern of definitionPatterns) {
    pattern.lastIndex = 0
    let match = pattern.exec(text)
    while (match !== null) {
      if (match[1].length >= 6) found.add(match[1])
      match = pattern.exec(text)
    }
  }
  return [...found]
}

/** Compute the oracle answer set with a full-disk search. */
const oracleFor = (repo, symbol) => {
  const result = run(
    'rg',
    [
      '-n',
      '-w',
      '--no-ignore',
      '--hidden',
      '--glob', '!node_modules',
      '--glob', '!.git',
      '--glob', '!.claude/worktrees/**',
      symbol,
      '--',
      repo,
    ],
    { timeout: 60_000 },
  )
  if (!result.ok && result.code !== 1) return null
  const sites = []
  for (const line of result.stdout.split('\n')) {
    const match = /^(.*?):(\d+):/.exec(line)
    if (!match) continue
    sites.push({ file: match[1].slice(repo.length + 1), line: Number(match[2]) })
  }
  return sites
}

const main = () => {
  const args = parseArgs(process.argv.slice(2), {
    repo: process.cwd(),
    strata: 'strata.json',
    out: 'gold.jsonl',
    per: '14',
    seed: '20261029',
  })
  const repo = String(args.repo).replace(/\/$/, '')
  const perStratum = Number(args.per)
  const seed = Number(args.seed)

  if (!existsSync(String(args.strata))) {
    throw new Error(`missing ${args.strata} — run strata.mjs first`)
  }
  const report = JSON.parse(readFileSync(String(args.strata), 'utf8'))

  const seen = new Set()
  const gold = []
  let counter = 0

  for (const stratum of TARGET_STRATA) {
    const span = report.strata[stratum]
    if (!span) continue
    const candidates = []
    const files = sample(
      span.paths
        .filter((path) => SOURCE_EXT.test(path))
        .filter((path) => INCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix))),
      MAX_FILES_PER_STRATUM,
      seed + stratum.length,
    )
    for (const relative of files) {
      const absolute = join(repo, relative)
      let size = 0
      try {
        size = readFileSync(absolute).length
      } catch {
        continue
      }
      if (size > MAX_FILE_BYTES) continue
      for (const symbol of symbolsIn(absolute)) {
        if (GENERATED_NAME.test(symbol)) continue
        if (seen.has(symbol)) continue
        seen.add(symbol)
        candidates.push({ symbol, definedIn: relative })
      }
    }

    const accepted = []
    for (const candidate of candidates) {
      const sites = oracleFor(repo, candidate.symbol)
      if (sites === null || sites.length < 2) continue
      const files_hit = new Set(sites.map((site) => site.file))
      if (files_hit.size < 2 || files_hit.size > MAX_ORACLE_FILES) continue
      if (![...files_hit].some((file) => file !== candidate.definedIn)) continue
      accepted.push({ ...candidate, sites: [...files_hit] })
      if (accepted.length >= perStratum * 4) break
    }

    for (const item of sample(accepted, perStratum, seed + stratum.length)) {
      counter += 1
      gold.push({
        id: `g-${String(counter).padStart(3, '0')}`,
        stratum,
        symbol: item.symbol,
        definedIn: item.definedIn,
        question: `Which files reference ${item.symbol}?`,
        oracle: { files: item.sites.sort(), sites: item.sites.length },
      })
    }
  }

  const lines = gold.map((entry) => JSON.stringify(entry)).join('\n')
  writeFileSync(String(args.out), `${lines}\n`)

  const byStratum = new Map()
  for (const entry of gold) byStratum.set(entry.stratum, (byStratum.get(entry.stratum) ?? 0) + 1)
  console.log(`gold: ${gold.length} questions -> ${args.out}`)
  for (const [stratum, count] of byStratum) console.log(`  ${stratum}: ${count}`)
}

main()
