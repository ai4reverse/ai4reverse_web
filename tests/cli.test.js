import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'tools', 'cli.js')

async function sampleFile(name, content) {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-cli-'))
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

test('cli lists restoration passes', async () => {
  const { stdout } = await exec(process.execPath, [CLI, 'passes', '--json'], { cwd: ROOT })
  const passes = JSON.parse(stdout)
  assert.ok(passes.length >= 10)
  const ids = passes.map((pass) => pass.id)
  for (const expected of ['strings', 'string-array', 'control-flow', 'eval-unwrap', 'anti-analysis', 'rename']) {
    assert.ok(ids.includes(expected), `missing pass ${expected}`)
  }
})

test('cli analyze --json emits the report on stdout and logs on stderr', async () => {
  const path = await sampleFile(
    'sample.js',
    "var url = atob('aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u'); eval('console.log(url)');",
  )
  const { stdout, stderr } = await exec(process.execPath, [CLI, 'analyze', path, '--json', '--log-level', 'silent'], {
    cwd: ROOT,
    timeout: 60_000,
  })
  const report = JSON.parse(stdout)
  assert.equal(report.sample.name, path)
  assert.ok(report.verdict.score >= 0)
  assert.ok(report.static.iocs.urls.some((entry) => entry.value.includes('c2.example.test')))
  assert.equal(report.dynamic.ok, true)
  assert.equal(typeof stderr, 'string')
})

test('cli restore writes restored code to stdout', async () => {
  const path = await sampleFile('obf.js', "var a = ['\\x68','\\x69']; console.log(a[0] + a[1]);")
  const { stdout } = await exec(process.execPath, [CLI, 'restore', path], { cwd: ROOT, timeout: 60_000 })
  assert.ok(stdout.length > 0)
  assert.ok(!stdout.includes('\\x68'), `escape not decoded: ${stdout}`)
})

test('cli run reports a structured summary and exit code 0', async () => {
  const path = await sampleFile('run.js', 'globalThis.out = 6 * 7; out')
  const { stdout } = await exec(process.execPath, [CLI, 'run', path, '--json'], { cwd: ROOT, timeout: 60_000 })
  const summary = JSON.parse(stdout)
  assert.equal(summary.ok, true)
  assert.equal(summary.result.value, 42)
  assert.equal(summary.disposal.ok, true)
})

test('cli returns non-zero for an unknown command', async () => {
  await assert.rejects(
    () => exec(process.execPath, [CLI, 'nonsense'], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /unknown command/)
      return true
    },
  )
})

test('cli analyze --out writes markdown to a file', async () => {
  const path = await sampleFile('markdown.js', 'var a = 1; a')
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-out-'))
  const out = join(dir, 'report.md')
  await exec(process.execPath, [CLI, 'analyze', path, '--out', out, '--log-level', 'silent'], {
    cwd: ROOT,
    timeout: 60_000,
  })
  const text = await readFile(out, 'utf8')
  assert.match(text, /^# ai4reverse analysis report/)
})

test('cli fails cleanly on missing input and malformed options', async () => {
  await assert.rejects(
    () => exec(process.execPath, [CLI, 'analyze', '/tmp/definitely-not-here-4f19.js'], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /cannot read/)
      return true
    },
  )
  const path = await sampleFile('bad-profile.js', 'var a = 1; a')
  await assert.rejects(
    () => exec(process.execPath, [CLI, 'analyze', path, '--profile', '{not-json'], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /invalid JSON for --profile/)
      return true
    },
  )
})

test('cli keeps stdout parseable while logging to stderr', async () => {
  const path = await sampleFile('logs.js', 'var a = 1; a')
  const { stdout, stderr } = await exec(
    process.execPath,
    [CLI, 'analyze', path, '--json', '--log-level', 'info', '--no-dynamic'],
    { cwd: ROOT, timeout: 60_000 },
  )
  assert.doesNotThrow(() => JSON.parse(stdout))
  assert.match(stdout, /"verdict"/)
  assert.match(stderr, /analysis starting/)
  assert.doesNotMatch(stdout, /analysis starting/)
})

test('cli rejects an empty input file as a usage error', async () => {
  const path = await sampleFile('empty.js', '   \n')
  await assert.rejects(
    () => exec(process.execPath, [CLI, 'analyze', path], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /is empty/)
      return true
    },
  )
})

test('cli run --events emits one JSON event per line', async () => {
  const path = await sampleFile('events.js', 'console.log("one"); setTimeout(function(){ console.log("two") }, 5);')
  const { stdout } = await exec(process.execPath, [CLI, 'run', path, '--events'], { cwd: ROOT, timeout: 60_000 })
  const lines = stdout.split('\n').filter(Boolean)
  assert.ok(lines.length > 3)
  const parsed = lines.map((line) => JSON.parse(line))
  assert.ok(parsed.every((event) => typeof event.kind === 'string' && typeof event.seq === 'number'))
  assert.ok(parsed.some((event) => event.kind === 'code'))
})

/**
 * Run the CLI and capture the outcome instead of throwing on a non-zero exit,
 * so the usage-error contract (exit 2, message on stderr, empty stdout) can be
 * asserted directly.
 */
async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      timeout: 60_000,
      ...options,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** D7: bad input is a usage error — exit 2, explained on stderr, nothing on stdout. */
async function assertUsageError(args, pattern) {
  const result = await runCli(args)
  assert.equal(result.code, 2, `expected exit 2 for "${args.join(' ')}", got ${result.code}: ${result.stderr}`)
  assert.equal(result.stdout, '', `"${args.join(' ')}" wrote to stdout on a usage error`)
  assert.match(result.stderr, pattern)
  return result
}

test('cli -h/--help print usage without running a command', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag])
    assert.equal(result.code, 0, `${flag}: ${result.stderr}`)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
})

test('cli with no command prints usage and exits 2', async () => {
  const result = await runCli([])
  assert.equal(result.code, 2, result.stderr)
  assert.match(result.stdout, /Usage:/)
})

test('cli rejects --events outside the run command', async () => {
  await assertUsageError(
    ['analyze', 'examples/benign.js', '--events', '--no-dynamic'],
    /--events is only valid with the run command/,
  )
})

test('cli analyze exits 1 when the guest run fails', async () => {
  const path = await sampleFile('throw.js', 'throw new Error("boom")')
  const result = await runCli(['analyze', path, '--json', '--log-level', 'silent'])
  assert.equal(result.code, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.dynamic.ok, false)
  assert.match(String(report.dynamic.error), /boom/)
})

test('cli analyze --no-dynamic still exits 0', async () => {
  const result = await runCli(['analyze', 'examples/benign.js', '--json', '--no-dynamic', '--log-level', 'silent'])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.dynamic.ok, false)
})

test('cli rejects unknown options for every command', async () => {
  const cases = [
    ['analyze', 'examples/benign.js', '--nonsense'],
    ['restore', 'examples/benign.js', '--nonsense'],
    ['run', 'examples/benign.js', '--nonsense'],
    ['passes', '--nonsense'],
    ['version', '--nonsense'],
    // an option that needs a value but has none
    ['analyze', 'examples/benign.js', '--seed'],
  ]
  for (const args of cases) await assertUsageError(args, /invalid arguments/)
})

test('cli rejects malformed --seed values', async () => {
  for (const value of ['xyz', '1.5', '0x', '0xzz', '12abc', '-12', '']) {
    await assertUsageError(
      ['analyze', 'examples/benign.js', '--no-dynamic', `--seed=${value}`],
      /--seed must be a decimal or 0x-prefixed hex integer/,
    )
  }
})

test('cli accepts decimal and 0x hex seeds', async () => {
  for (const value of ['24173', '0x5eed', '0X5EED', '0001']) {
    const result = await runCli(['restore', 'examples/benign.js', '--seed', value])
    assert.equal(result.code, 0, `${value}: ${result.stderr}`)
    assert.match(result.stdout, /Benign control sample/)
  }
  // the seed is part of the profile fed to the sandbox, not just a CLI field
  const run = await runCli(['run', 'examples/benign.js', '--json', '--seed', '0x5eed'])
  assert.equal(run.code, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).ok, true)
})

test('cli rejects --rounds outside 1-5 and non-integers', async () => {
  for (const value of ['abc', '0', '6', '1.5', '-1', '']) {
    await assertUsageError(
      ['restore', 'examples/benign.js', `--rounds=${value}`],
      /--rounds must be an integer between 1 and 5/,
    )
  }
})

test('cli accepts every valid --rounds value', async () => {
  for (const value of [1, 2, 3, 4, 5]) {
    const result = await runCli(['restore', 'examples/sample-loader.js', '--rounds', String(value)])
    assert.equal(result.code, 0, `rounds=${value}: ${result.stderr}`)
    assert.ok(result.stdout.length > 0)
  }
})

test('cli rejects unknown pass ids and names the valid ones', async () => {
  const ids = JSON.parse((await runCli(['passes', '--json'])).stdout).map((pass) => pass.id)
  for (const args of [
    ['restore', 'examples/benign.js', '--passes', 'bogus'],
    ['restore', 'examples/benign.js', '--exclude', 'bogus'],
    ['restore', 'examples/benign.js', '--passes', 'strings,bogus'],
  ]) {
    const result = await assertUsageError(args, /unknown pass id/)
    for (const id of ids) assert.ok(result.stderr.includes(id), `valid pass id ${id} missing from the message`)
  }
})

test('cli accepts every registered pass id in --passes and --exclude', async () => {
  const ids = JSON.parse((await runCli(['passes', '--json'])).stdout).map((pass) => pass.id)
  const only = await runCli(['restore', 'examples/sample-loader.js', '--passes', ids.join(',')])
  assert.equal(only.code, 0, only.stderr)
  assert.ok(only.stdout.length > 0)
  const excluded = await runCli(['restore', 'examples/sample-loader.js', '--exclude', ids.join(',')])
  assert.equal(excluded.code, 0, excluded.stderr)
  assert.ok(excluded.stdout.length > 0)
})

test('cli rejects invalid --level and accepts the documented levels', async () => {
  for (const value of ['bogus', 'trace', 'OFF', '']) {
    await assertUsageError(
      ['analyze', 'examples/benign.js', '--no-dynamic', `--level=${value}`],
      /--level must be one of off\|function\|branch\|statement/,
    )
  }
  for (const level of ['off', 'function', 'branch', 'statement']) {
    const result = await runCli(['restore', 'examples/benign.js', '--level', level])
    assert.equal(result.code, 0, `${level}: ${result.stderr}`)
  }
  const run = await runCli(['run', 'examples/benign.js', '--json', '--level', 'off'])
  assert.equal(run.code, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).ok, true)
})

test('cli --out failures are usage errors with the path and code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-out-'))
  const parentFile = join(dir, 'not-a-dir')
  await writeFile(parentFile, 'x')
  const missing = join(dir, 'missing', 'report.json')

  const enoent = await assertUsageError(
    ['analyze', 'examples/benign.js', '--no-dynamic', '--json', '--out', missing],
    /cannot write /,
  )
  assert.ok(enoent.stderr.includes(missing), 'stderr must name the target path')
  assert.match(enoent.stderr, /ENOENT/)
  await assert.rejects(() => readFile(missing, 'utf8'), /ENOENT/)

  const enotdir = await assertUsageError(
    ['restore', 'examples/benign.js', '--out', join(parentFile, 'report.js')],
    /cannot write /,
  )
  assert.match(enotdir.stderr, /ENOTDIR/)

  if ((process.getuid?.() ?? 1) !== 0) {
    const locked = join(dir, 'locked')
    await mkdir(locked, { mode: 0o500 })
    const eacces = await assertUsageError(['restore', 'examples/benign.js', '--out', join(locked, 'report.js')], /cannot write /)
    assert.match(eacces.stderr, /EACCES/)
  }
})

test('cli --out - writes the result to stdout', async () => {
  const text = await runCli(['restore', 'examples/benign.js', '--out', '-'])
  assert.equal(text.code, 0, text.stderr)
  assert.match(text.stdout, /Benign control sample/)
  assert.doesNotMatch(text.stderr, /wrote/)

  const json = await runCli(['restore', 'examples/sample-loader.js', '--json', '--out', '-'])
  assert.equal(json.code, 0, json.stderr)
  assert.equal(JSON.parse(json.stdout).outputValid, true)
})

test('cli --out writes the file and keeps stdout empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-out-'))
  const out = join(dir, 'restore.json')
  const result = await runCli(['restore', 'examples/sample-loader.js', '--json', '--out', out])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /wrote \d+ bytes/)
  assert.equal(JSON.parse(await readFile(out, 'utf8')).outputValid, true)
})

test('cli keeps --events and --json mutually exclusive', async () => {
  await assertUsageError(['run', 'examples/benign.js', '--events', '--json'], /mutually exclusive/)
})

test('cli --json keeps stdout pure JSON while logging to stderr', async () => {
  const result = await runCli(['restore', 'examples/sample-loader.js', '--json', '--log-level', 'debug'])
  assert.equal(result.code, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(typeof parsed.code, 'string')
  assert.doesNotMatch(result.stdout, /"level":\d+/)
})

test('cli --arg keeps JSON-or-string behavior for --entry', async () => {
  const path = await sampleFile('entry.js', 'function probe(a, b, c) { return [a, b, c] }')
  const result = await runCli([
    'run',
    path,
    '--json',
    '--entry',
    'probe',
    '--arg',
    '42',
    '--arg',
    'hello',
    '--arg',
    '{"k":1}',
  ])
  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.ok, true)
  assert.equal(summary.result.preview, '[42,"hello",{"k":1}]')
})

test('cli rejects a missing input file for every file command', async () => {
  for (const command of ['analyze', 'restore', 'run']) {
    await assertUsageError([command], /missing input file/)
  }
})

test('cli rejects malformed numeric limits', async () => {
  for (const option of ['--timeout', '--virtual-ms']) {
    for (const value of ['abc', '0', '-5']) {
      await assertUsageError(
        ['analyze', 'examples/benign.js', '--no-dynamic', `${option}=${value}`],
        /must be a positive number/,
      )
    }
  }
})

/**
 * Settle visibility: the event loop is the only place a stack breach inside a
 * timer or promise callback is attributed. The script itself succeeds, so the
 * summary keeps `ok: true` while `limitsHit` gains `'stack'` and the runtime is
 * abandoned (`disposal.skipped`). Before this contract the summary dropped
 * `settle` entirely, which left the analyst with an unexplained limit hit and a
 * failed teardown; each case used to print an `Aborted(...)` line to stderr.
 */
test('cli run --json exposes the event-loop stack breach that abandoned the runtime', async () => {
  const path = await sampleFile('timer-stack.js', 'setTimeout(function f(){ return f() }, 0)')
  const result = await runCli(['run', path, '--json'])
  // The evaluated script returned normally, so the run itself is a success.
  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)

  assert.equal(summary.ok, true)
  assert.equal(summary.error, null)
  assert.ok(summary.limitsHit.includes('stack'), `expected stack in limitsHit, got ${JSON.stringify(summary.limitsHit)}`)

  assert.ok(summary.settle && typeof summary.settle === 'object', 'the run summary must carry settle')
  assert.equal(summary.settle.error?.origin, 'timer')
  assert.equal(summary.settle.error?.name, 'RangeError')
  assert.match(String(summary.settle.error?.message), /maximum call stack/i)
  assert.ok(summary.settle.limitsHit.includes('stack'), JSON.stringify(summary.settle.limitsHit))
  assert.equal(typeof summary.settle.virtualMs, 'number')
  assert.equal(typeof summary.settle.pendingTimers, 'number')
  assert.equal(typeof summary.settle.jobs, 'number')

  // The heap is unrecoverable: abandoned, not disposed, and no engine abort.
  assert.equal(summary.disposal.ok, false)
  assert.equal(summary.disposal.skipped, true)
  assert.doesNotMatch(result.stderr, /Aborted\(/)
})

test('cli run --json shows a clean settle for a run that hits no limit', async () => {
  const path = await sampleFile('no-limits.js', 'globalThis.out = 6 * 7; out')
  const result = await runCli(['run', path, '--json'])
  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)

  assert.equal(summary.ok, true)
  assert.equal(summary.disposal.ok, true)
  assert.ok(summary.settle && typeof summary.settle === 'object', 'the run summary must carry settle')
  // Tolerate both spellings of "nothing hit": an empty list or an absent key.
  assert.deepEqual(summary.settle.limitsHit ?? [], [])
  assert.equal(summary.settle.error, null)
  assert.equal('skipped' in summary.settle, false)
})

test('cli run --json emits settle: null when the run never reached the event loop', async () => {
  const path = await sampleFile('throws.js', "throw new Error('boom')")
  const result = await runCli(['run', path, '--json'])
  assert.equal(result.code, 1, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.ok, false)
  assert.equal(summary.settle, null)
})
