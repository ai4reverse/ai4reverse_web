import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
