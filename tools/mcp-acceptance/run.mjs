#!/usr/bin/env node
/**
 * Run the acceptance gate: measure each retrieval adapter against an oracle,
 * then assert the two invariants that make silent failure visible.
 *
 * Adapters are deliberately dumb. They take a symbol and return the set of
 * files they claim reference it. Nothing here scores prose or reads a table.
 *
 * Metrics are reported per stratum, with a Wilson interval, because the whole
 * finding of the previous acceptance wave was that an average across strata
 * hides the failure that matters.
 *
 * Usage:
 *   node tools/mcp-acceptance/run.mjs --repo <path> --gold gold.jsonl --out results.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, run, wilson } from './shared.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CBM_FALLBACK = `${process.env.HOME}/.npm/_npx/1a4be6c4de01e972/node_modules/.bin/codebase-memory-mcp`

/** The project key the index server derives from the absolute root path. */
const projectName = (repo) => repo.replace(/^\//, '').replace(/[\\/]/g, '-')

/** Full-disk reference search — the oracle and the ceiling adapter. */
const rgAdapter = (repo) => ({
  name: 'rg',
  describe: 'rg --no-ignore (whole disk)',
  query: (symbol) => {
    const result = run('rg', [
      '-l', '-w', '--no-ignore', '--hidden',
      '--glob', '!node_modules', '--glob', '!.git', '--glob', '!.claude/worktrees',
      symbol, '--', repo,
    ], { timeout: 60_000 })
    if (!result.ok && result.code !== 1) return { files: [], error: result.stderr.trim() }
    return {
      files: result.stdout.split('\n').filter(Boolean).map((path) => path.slice(repo.length + 1)),
    }
  },
})

/** codebase-memory text search over the indexed corpus. */
const cbmAdapter = (repo) => {
  const binary = existsSync(CBM_FALLBACK) ? CBM_FALLBACK : 'codebase-memory-mcp'
  const project = projectName(repo)
  return {
    name: 'codebase-memory',
    describe: 'search_code mode=files over the indexed corpus',
    query: (symbol) => {
      const payload = JSON.stringify({ project, pattern: symbol, mode: 'files', limit: 50 })
      const result = run(binary, ['cli', '--json', 'search_code', payload], { timeout: 120_000 })
      if (!result.ok && result.stdout.trim() === '') {
        return { files: [], error: result.stderr.trim() || `exit ${result.code}` }
      }
      let envelope
      try {
        envelope = JSON.parse(result.stdout)
      } catch {
        return { files: [], error: `unparseable output: ${result.stdout.slice(0, 120)}` }
      }
      const text = envelope?.content?.[0]?.text ?? ''
      if (envelope?.isError) return { files: [], error: text.slice(0, 200) }
      const files = text
        .split('\n')
        .map((line) => /^\s*-\s+(.+)$/.exec(line))
        .filter(Boolean)
        .map((match) => match[1].trim())
      return { files }
    },
  }
}

/** Metric bundle for one adapter on one stratum. */
const score = (adapter, items) => {
  let foundAny = 0
  let falseEmpty = 0
  let recallSum = 0
  let reciprocalSum = 0
  const violations = []
  for (const item of items) {
    const oracle = new Set(item.oracle.files)
    const answer = adapter.query(item.symbol)
    if (answer.error) return { error: answer.error }
    const returned = new Set(answer.files)
    const overlap = [...returned].filter((file) => oracle.has(file))
    if (overlap.length > 0) foundAny += 1
    recallSum += oracle.size === 0 ? 0 : overlap.length / oracle.size
    const rank = answer.files.findIndex((file) => oracle.has(file))
    reciprocalSum += rank === -1 ? 0 : 1 / (rank + 1)
    if (answer.files.length === 0 && oracle.size > 0) {
      falseEmpty += 1
      violations.push({
        id: item.id,
        symbol: item.symbol,
        stratum: item.stratum,
        oracleFiles: oracle.size,
      })
    }
  }
  const total = items.length
  return {
    n: total,
    foundAny: wilson(foundAny, total),
    meanRecall: total === 0 ? 0 : recallSum / total,
    mrr: total === 0 ? 0 : reciprocalSum / total,
    falseEmpty: wilson(falseEmpty, total),
    falseEmptyCount: falseEmpty,
    violations,
  }
}

/**
 * Invariant 2: a method that is called through a variable receiver must not
 * resolve to "no callers" without saying so.
 *
 * The candidate is chosen mechanically: take every `variable.method(` name in
 * the repository, keep the ones with at least two call sites, and find a class
 * that declares that method while having no `Class.method(` call sites at all.
 * If the graph then answers `callers_total: 0`, it has silently dropped real
 * call sites rather than reported an unknown.
 */
const receiverInvariant = (repo, adapter) => {
  const project = projectName(repo)
  const globs = ['--glob', '!node_modules', '--glob', '!.git', '--glob', '!.claude/worktrees/**']
  const sourceGlobs = ['--glob', '*.js', '--glob', '*.mjs', '--glob', '*.cjs', '--glob', '*.ts']
  // A call written inside a comment is not a call site; excluding comment lines
  // here is what stops documentation from being counted as a static receiver.
  const NOT_A_COMMENT = '^(?!\\s*(?:\\*|//|/\\*)).*?'
  const skipMethods = new Set([
    'then', 'catch', 'map', 'filter', 'forEach', 'push', 'slice', 'call', 'apply', 'bind',
    'exec', 'invoke', 'toString', 'has', 'get', 'set', 'add', 'delete', 'close',
  ])

  const instanceNames = run('rg', ['-o', '--pcre2', '--no-filename', '--no-ignore', '--hidden',
    ...globs, ...sourceGlobs,
    '-r', '$1', `${NOT_A_COMMENT}\\b[a-z_$][A-Za-z0-9_$]*\\.([a-z][A-Za-z0-9_]*)\\(`, repo], { timeout: 60_000 })
  if (!instanceNames.ok && instanceNames.code !== 1) {
    return { status: 'SKIP', reason: instanceNames.stderr.trim() }
  }
  const instanceCounts = new Map()
  for (const name of instanceNames.stdout.split('\n')) {
    const key = name.trim()
    if (key) instanceCounts.set(key, (instanceCounts.get(key) ?? 0) + 1)
  }

  const staticPairs = run('rg', ['-o', '--pcre2', '--no-filename', '--no-ignore', '--hidden',
    ...globs, ...sourceGlobs,
    '-r', '$1.$2', `${NOT_A_COMMENT}\\b([A-Z][A-Za-z0-9_]*)\\.([a-z][A-Za-z0-9_]*)\\(`, repo], { timeout: 60_000 })
  const staticCounts = new Set(
    staticPairs.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  )

  const classFiles = run('rg', ['-l', '--no-ignore', '--hidden', ...globs,
    '^\\s*(?:export\\s+)?class\\s+[A-Z]', `${repo}/tools`], { timeout: 60_000 })

  const classPattern = /(?:^|\n)\s*(?:export\s+)?class\s+([A-Z][A-Za-z0-9_]*)/g
  const methodPattern = /(?:^|\n)\s+(?:static\s+)?(?:async\s+)?#?([a-z][A-Za-z0-9_]*)\s*\(/g
  const sources = classFiles.stdout.split('\n').filter(Boolean).slice(0, 12).map((file) => {
    const text = readFileSync(file, 'utf8')
    return {
      file,
      owners: [...text.matchAll(classPattern)].map((match) => match[1]),
      methods: [...new Set([...text.matchAll(methodPattern)].map((match) => match[1]))],
    }
  })

  // A bare `x.method(` site cannot be attributed to a class without type
  // inference, and type inference is exactly what the graph does not do.
  // Attribution here is by co-location instead: count `.method(` only inside
  // files that construct the class (`new C(` or `C.create(`). That is
  // auditable by a reader and cannot be inflated by an unrelated object that
  // happens to share the method name.
  let lastError = null
  for (const source of sources) {
    for (const owner of source.owners) {
      const constructors = run('rg', ['-l', '--no-ignore', '--hidden', ...globs, ...sourceGlobs,
        `\\bnew ${owner}\\(|\\b${owner}\\.create\\(`, repo], { timeout: 60_000 })
      const files = constructors.stdout.split('\n').filter(Boolean)
      if (files.length === 0) continue

      const tally = new Map()
      const calls = run('rg', ['-o', '--no-filename', '--no-ignore', '--hidden',
        ...globs, ...sourceGlobs, '-r', '$1', '\\.([a-z][A-Za-z0-9_]*)\\(', ...files],
      { timeout: 60_000 })
      for (const name of calls.stdout.split('\n')) {
        const key = name.trim()
        if (key) tally.set(key, (tally.get(key) ?? 0) + 1)
      }

      let best = null
      for (const method of source.methods) {
        if (skipMethods.has(method)) continue
        if (staticCounts.has(`${owner}.${method}`)) continue
        const sites = tally.get(method) ?? 0
        if (sites < 2) continue
        if (!best || sites > best.sites) best = { method, sites }
      }
      if (!best) continue

      const modulePath = source.file
        .slice(repo.length + 1)
        .replace(/\.[^./]+$/, '')
        .replace(/\//g, '.')
      const qualified = `${project}.${modulePath}.${owner}.${best.method}`
      const result = adapter.trace(qualified)
      if (result.error) {
        lastError = `${qualified}: ${result.error}`.slice(0, 240)
        continue
      }
      return {
        status: result.callers >= best.sites ? 'PASS' : 'FAIL',
        qualified,
        constructorFiles: files.length,
        attributableSites: best.sites,
        graphCallers: result.callers,
        note: result.callers === 0
          ? 'graph reported zero callers for a method with attributable call sites'
          : 'graph under-reports attributable call sites',
      }
    }
  }

  return {
    status: 'SKIP',
    reason: 'no class with attributable variable-receiver call sites',
    diagnostics: {
      classFiles: sources.length,
      distinctInstanceMethods: instanceCounts.size,
      lastError,
    },
  }
}

const main = () => {
  const args = parseArgs(process.argv.slice(2), {
    repo: process.cwd(),
    gold: join(HERE, 'gold.jsonl'),
    out: join(HERE, 'results.json'),
  })
  const repo = String(args.repo).replace(/\/$/, '')
  const gold = readFileSync(String(args.gold), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  const cbm = cbmAdapter(repo)
  const adapters = [rgAdapter(repo), cbm]

  const results = { repo, generatedAt: new Date().toISOString(), gold: gold.length, adapters: {} }
  for (const adapter of adapters) {
    const byStratum = {}
    for (const stratum of [...new Set(gold.map((item) => item.stratum))]) {
      const items = gold.filter((item) => item.stratum === stratum)
      byStratum[stratum] = score(adapter, items)
    }
    results.adapters[adapter.name] = { description: adapter.describe, byStratum }
  }

  const trace = cbmAdapter(repo)
  trace.trace = (qualified) => {
    const binary = existsSync(CBM_FALLBACK) ? CBM_FALLBACK : 'codebase-memory-mcp'
    const payload = JSON.stringify({ project: projectName(repo), function_name: qualified, direction: 'inbound', depth: 2, format: 'json' })
    const result = run(binary, ['cli', '--json', 'trace_path', payload], { timeout: 120_000 })
    if (!result.ok && result.stdout.trim() === '') return { error: result.stderr.trim() || `exit ${result.code}` }
    try {
      const envelope = JSON.parse(result.stdout)
      const text = envelope?.content?.[0]?.text ?? ''
      if (envelope?.isError) return { error: text.slice(0, 200) }
      const parsed = JSON.parse(text)
      if (parsed.error) return { error: parsed.error }
      return { callers: Number(parsed.callers_total ?? 0) }
    } catch {
      return { error: 'unparseable trace output' }
    }
  }
  results.receiverInvariant = receiverInvariant(repo, trace)

  writeFileSync(String(args.out), `${JSON.stringify(results, null, 2)}\n`)

  for (const [name, bundle] of Object.entries(results.adapters)) {
    console.log(`\n${name} — ${bundle.description}`)
    console.log('  stratum            n   foundAny   meanRecall   falseEmpty')
    for (const [stratum, metric] of Object.entries(bundle.byStratum)) {
      if (metric.error) {
        console.log(`  ${stratum.padEnd(16)} ${metric.error.slice(0, 60)}`)
        continue
      }
      const percent = (interval) => `${(interval.p * 100).toFixed(0)}% [${(interval.low * 100).toFixed(0)}–${(interval.high * 100).toFixed(0)}]`
      console.log(
        `  ${stratum.padEnd(16)} ${String(metric.n).padStart(2)}  ${percent(metric.foundAny).padEnd(16)} ${metric.meanRecall.toFixed(2).padStart(8)}   ${percent(metric.falseEmpty)}`,
      )
    }
  }
  console.log(`\nreceiver invariant: ${JSON.stringify(results.receiverInvariant)}`)
  console.log(`\nwrote ${args.out}`)
}

main()
