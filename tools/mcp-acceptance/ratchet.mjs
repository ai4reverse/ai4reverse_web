#!/usr/bin/env node
/**
 * The anti-rot ratchet.
 *
 * Every check here corresponds to a defect that was already found once. The
 * point is not to find it again — it is to make sure the fix, once it exists,
 * cannot be undone silently. A check that is red is therefore not a bug in this
 * file: it is the list of things still to fix, with the exact remediation.
 *
 * Deliberately separate from `pnpm test`: the repository's own suite must stay
 * green, while this command is allowed — and expected — to be red exactly where
 * a known defect is still live.
 *
 * Exit code is 1 when any check fails, so it can gate a commit or a nightly run.
 *
 * Usage:
 *   node tools/mcp-acceptance/ratchet.mjs [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './shared.mjs'

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rootFlag = process.argv.indexOf('--root')
const ROOT = rootFlag === -1 ? SELF_ROOT : process.argv[rootFlag + 1]
const HOOKS = process.env.AI4REVERSE_HOOKS_DIR ?? join(ROOT, '.claude/hooks')
const HOOKS_PRESENT = existsSync(HOOKS)

const checks = []
const add = (id, guard, fix, body) => checks.push({ id, guard, fix, run: body })

/** Ask the execution guard for a verdict; null means the hook is unavailable. */
const guardDecision = (command) => {
  const result = run('node', [join(HOOKS, 'guard-sample-execution.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'ratchet' }),
    timeout: 20_000,
  })
  try {
    return JSON.parse(result.stdout)?.hookSpecificOutput?.permissionDecision ?? 'allow'
  } catch {
    return null
  }
}

/** Ask the evidence hook whether it would claim a test ran. */
const claimsTestsRan = (command) => {
  const result = run('node', [join(HOOKS, 'record-analysis-evidence.mjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: '', stderr: '' },
      session_id: 'ratchet-evidence',
    }),
    timeout: 20_000,
  })
  try {
    const context = JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext ?? ''
    return /Tests passed/.test(context)
  } catch {
    return null
  }
}

// --- 1. tracking -----------------------------------------------------------
add('tracking', 'src/tiktok/scripts stays tracked', {
  '2026-10-29': '93cd01b "rm schema" untracked 24 pipeline stages (7099 lines)',
  fix: 'git add -f src/tiktok/scripts',
}, () => {
  const directory = join(ROOT, 'src/tiktok/scripts')
  if (!existsSync(directory)) return { status: 'SKIP', detail: 'corpus absent in this checkout' }
  const listed = run('git', ['-C', ROOT, 'ls-files', 'src/tiktok/scripts'], { timeout: 30_000 })
  const tracked = listed.stdout.split('\n').filter(Boolean).length
  return tracked >= 27
    ? { status: 'PASS', detail: `${tracked} files tracked` }
    : { status: 'FAIL', detail: `${tracked} files tracked, expected >= 27` }
})

// --- 2. execution guard bypasses ------------------------------------------
const bypasses = [
  ['guard:pipe', 'cat examples/anti-analysis.js | node'],
  ['guard:require', 'NODE_OPTIONS=--require ./examples/anti-analysis.js node tools/cli.js version'],
  ['guard:reporter', 'node --test --test-reporter=./examples/anti-analysis.js tests/report.test.js'],
  ['guard:multi-target', 'node --test tests/report.test.js examples/anti-analysis.js'],
]

for (const [id, command] of bypasses) {
  add(id, 'execution guard refuses a sample reachable through this form', {
    '2026-10-29': 'guard-sample-execution.mjs checks only the first positional target and plain `node`',
    fix: 'extend lib/guards.mjs: every positional target, redirection source, and code-loading flag value',
  }, () => {
    if (!HOOKS_PRESENT) return { status: 'SKIP', detail: 'hooks are untracked (F-1) and absent here' }
    const decision = guardDecision(command)
    if (decision === null) return { status: 'SKIP', detail: 'guard did not answer' }
    return decision === 'deny'
      ? { status: 'PASS', detail: 'denied' }
      : { status: 'FAIL', detail: `allowed: ${command}` }
  })
}

// --- 3. evidence false positive -------------------------------------------
add('evidence:false-positive', 'searching for a test command is not running it', {
  '2026-10-29': 'TEST_PATTERN matches the raw command string, so `rg "node --test"` marks testsRun',
  fix: 'require the test command at invocation position, not as a substring',
}, () => {
  if (!HOOKS_PRESENT) return { status: 'SKIP', detail: 'hooks are untracked (F-1) and absent here' }
  const claimed = claimsTestsRan('rg "node --test" docs/')
  if (claimed === null) return { status: 'SKIP', detail: 'evidence hook did not answer' }
  return claimed
    ? { status: 'FAIL', detail: 'a search command was recorded as a test run' }
    : { status: 'PASS', detail: 'search command not treated as a test run' }
})

// --- 4. guidance ------------------------------------------------------------
add('guidance:locate-playbook', 'the locate playbook does not recommend the broken reference tool', {
  '2026-10-29': 'workflow.mjs sends locate to serena.find_referencing_symbols, which returns {} across files',
  fix: 'say "same file only" and route cross-file to rg / trace_path',
}, () => {
  const file = join(HOOKS, 'lib/workflow.mjs')
  if (!existsSync(file)) return { status: 'SKIP', detail: 'hooks are untracked (F-1) and absent here' }
  const text = readFileSync(file, 'utf8')
  const block = /locate:\s*\[([\s\S]*?)\]\.join/.exec(text)?.[1] ?? ''
  return block.includes('find_referencing_symbols')
    ? { status: 'FAIL', detail: 'locate still recommends find_referencing_symbols' }
    : { status: 'PASS', detail: 'locate no longer recommends it' }
})

add('guidance:docs-allowlist', 'the workflow doc does not list a command the guard denies', {
  '2026-10-29': 'docs/MCP-WORKFLOW.md:66 lists `node -e` as allowed; the guard denies all inline -e/-p',
  fix: 'move `node -e` into the denied examples',
}, () => {
  const file = join(ROOT, 'docs/MCP-WORKFLOW.md')
  if (!existsSync(file)) return { status: 'SKIP', detail: 'doc absent in this checkout' }
  const text = readFileSync(file, 'utf8')
  const allowed = /allows the sanctioned paths:[\s\S]*?```([\s\S]*?)```/.exec(text)?.[1] ?? ''
  return /node\s+-e/.test(allowed)
    ? { status: 'FAIL', detail: 'the allowed-paths block still contains `node -e`' }
    : { status: 'PASS', detail: 'allowed-paths block is clean' }
})

// --- 5. provenance ----------------------------------------------------------
add('provenance:live-references', 'claims do not point at deleted files', {
  '2026-10-29': '54/120 mimir claims referenced a path that no longer exists',
  fix: 'restore the reports or mark the claims stale',
}, () => {
  const database = join(ROOT, '.mimir/mimir.db')
  if (!existsSync(database)) return { status: 'SKIP', detail: '.mimir absent in this checkout' }
  // `immutable=1` avoids the write lock sqlite otherwise takes even for a read
  // (WAL needs a -shm file). The trade-off is that a concurrent writer may make
  // the snapshot inconsistent, so this check answers "are the references live",
  // not "is the graph exactly this".
  const result = run('sqlite3', ['-noheader', `file:${database}?immutable=1`,
    "select distinct json_extract(payload,'$.provenance.document_ref') from claims"], { timeout: 30_000 })
  if (!result.ok) return { status: 'SKIP', detail: `mimir not readable: ${result.stderr.trim() || result.code}` }
  const refs = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const dead = refs.filter((reference) => !existsSync(join(ROOT, reference)))
  return dead.length === 0
    ? { status: 'PASS', detail: `${refs.length} live references` }
    : { status: 'FAIL', detail: `${dead.length}/${refs.length} references are dead: ${dead.slice(0, 3).join(', ')}` }
})

// --- 6. baseline consistency -------------------------------------------------
add('thresholds:baseline', 'the committed baseline still satisfies G1', {
  '2026-10-29': 'the gate exists so its verdict cannot drift with the prose',
  fix: 're-run tools/mcp-acceptance/run.mjs and commit the new baseline',
}, () => {
  const file = join(ROOT, 'tools/mcp-acceptance/baseline-results.json')
  if (!existsSync(file)) return { status: 'SKIP', detail: 'baseline not committed' }
  const baseline = JSON.parse(readFileSync(file, 'utf8'))
  const indexed = baseline?.adapters?.['codebase-memory']?.byStratum?.indexed
  if (!indexed) return { status: 'FAIL', detail: 'baseline has no indexed stratum' }
  return indexed.meanRecall >= 0.3
    ? { status: 'PASS', detail: `indexed recall ${indexed.meanRecall.toFixed(2)}` }
    : { status: 'FAIL', detail: `indexed recall ${indexed.meanRecall.toFixed(2)} below G1 floor 0.30` }
})

// --- run ---------------------------------------------------------------------
const results = checks.map((entry) => {
  let outcome
  try {
    outcome = entry.run()
  } catch (error) {
    outcome = { status: 'FAIL', detail: `check threw: ${error.message}` }
  }
  return { id: entry.id, guard: entry.guard, fix: entry.fix, ...outcome }
})

const failed = results.filter((result) => result.status === 'FAIL')
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ results, failed: failed.length }, null, 2))
} else {
  const width = Math.max(...results.map((result) => result.id.length))
  for (const result of results) {
    console.log(`${result.status.padEnd(4)}  ${result.id.padEnd(width)}  ${result.detail}`)
  }
  console.log('')
  for (const result of failed) {
    console.log(`FAIL ${result.id}`)
    for (const [source, origin] of Object.entries(result.fix ?? {})) {
      console.log(`     ${source}: ${origin}`)
    }
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks pass, ${failed.length} fail`)
}

process.exitCode = failed.length === 0 ? 0 : 1
