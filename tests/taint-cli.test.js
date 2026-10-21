import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('../tools/cli.js', import.meta.url))

async function fixture(t, source, filename = 'sample.js') {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-taint-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, filename)
  await writeFile(path, source)
  return { path, dir }
}

async function run(args) {
  try {
    const result = await exec(process.execPath, [CLI, ...args], { timeout: 30_000 })
    return { ...result, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
  }
}

test('taint CLI emits only JSON on stdout and never executes the sample', async (t) => {
  const { path } = await fixture(t, 'const input = location.hash;\neval(input);\nprocess.exit(77);')
  const result = await run(['taint', path, '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.engine, 'circle-ir')
  assert.equal(report.ok, true)
  assert.ok(report.flows.some((flow) => flow.sink_type === 'code_injection'))
})

test('taint CLI writes Markdown with evidence and supports --out', async (t) => {
  const { path, dir } = await fixture(t, 'const input = location.hash;\ndocument.write(input);')
  const output = join(dir, 'taint.md')
  const result = await run(['taint', path, '--out', output])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '')
  const markdown = await readFile(output, 'utf8')
  assert.match(markdown, /^# Taint analysis/)
  assert.match(markdown, /CWE-79/)
  assert.match(markdown, /## Flows/)
})

test('taint CLI parser errors and worker timeouts are nonzero structured failures', async (t) => {
  const { path } = await fixture(t, 'const broken = ;\neval(location.hash);')
  const failed = await run(['taint', path, '--json'])
  assert.equal(failed.code, 1, failed.stderr)
  assert.equal(JSON.parse(failed.stdout).error.code, 'TAINT_PARSE')
  const timeout = await run(['taint', path, '--json', '--timeout', '1'])
  assert.equal(timeout.code, 1)
  assert.equal(JSON.parse(timeout.stdout).error.code, 'TAINT_TIMEOUT')
})

test('analyze CLI includes taint by default and --no-taint keeps the disabled shape', async (t) => {
  const { path } = await fixture(t, 'const input = location.hash;\neval(input);')
  for (const disabled of [false, true]) {
    const result = await run(['analyze', path, '--json', '--no-dynamic', '--no-restore', '--log-level', 'silent', ...(disabled ? ['--no-taint'] : [])])
    assert.equal(result.code, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.static.taint.enabled, !disabled)
    assert.equal(report.static.taint.elapsedMs, 0)
    if (disabled) assert.deepEqual(report.static.taint.flows, [])
    else assert.ok(report.static.taint.flows.length > 0)
  }
})

test('taint CLI accepts additional patterns and infers TypeScript', async (t) => {
  const { path } = await fixture(t, 'const input: string = readInput();\neval(input);', 'loader.ts')
  const config = { sources: [{ method: 'readInput', type: 'user_input', severity: 'high', return_tainted: true }] }
  const result = await run(['taint', path, '--json', '--taint-config', JSON.stringify(config)])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.language, 'typescript')
  assert.ok(report.sources.some((source) => source.type === 'user_input'))
  assert.ok(report.flows.some((flow) => flow.source_type === 'user_input'))
})

test('taint CLI usage errors are explained on stderr with empty stdout', async (t) => {
  const { path } = await fixture(t, '42')
  for (const args of [
    ['taint'], ['taint', path, '--timeout', '0'], ['taint', path, '--timeout', '1.5'],
    ['taint', path, '--taint-config', '{'], ['taint', path, '--taint-config', 'null'],
    ['taint', path, '--taint-config', '{"sinks":[{}]}'], ['taint', path, '--no-taint'],
    ['run', path, '--taint-config', '{}'], ['analyze', path, '--no-taint', '--taint-config', '{}'],
    ['analyze', path, '--taint-config', '{"sources":"oops"}'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /error:/)
  }
})
