import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAINT_LIMITS } from '../tools/taint/index.js'

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
  const { path: empty } = await fixture(t, '', 'empty.js')
  for (const args of [
    ['taint'], ['taint', path, '--timeout', '0'], ['taint', path, '--timeout', '1.5'],
    ['taint', path, '--timeout', '200000'],
    ['taint', path, '--taint-config', '{'], ['taint', path, '--taint-config', 'null'],
    ['taint', path, '--taint-config', '{"sinks":[{}]}'], ['taint', path, '--no-taint'],
    ['taint', empty],
    ['run', path, '--taint-config', '{}'], ['analyze', path, '--no-taint', '--taint-config', '{}'],
    ['analyze', path, '--taint-config', '{"sources":"oops"}'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /error:/)
    // The reason is named, not just signalled by the exit code.
    if (args[1] === empty) assert.match(result.stderr, /is empty/, `${JSON.stringify(args)}: ${result.stderr}`)
    if (args.at(-1) === '200000') assert.match(result.stderr, /integer from 1 to 120000/, `${JSON.stringify(args)}: ${result.stderr}`)
  }
})

test('taint CLI refuses sources whose overlong lines Circle-IR would blank', async (t) => {
  // Circle-IR replaces every line longer than 10 000 characters with an empty
  // line without reporting it, so a minified one-liner must fail loudly instead
  // of returning a clean scan with no evidence.
  const { path } = await fixture(t, `const value = location.hash;${' '.repeat(10_001)}\neval(value);`)
  const result = await run(['taint', path, '--json'])
  assert.equal(result.code, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.error.code, 'TAINT_SOURCE_LAYOUT')
  assert.deepEqual(report.truncatedBy, ['overlong-line'])
  assert.equal(report.ok, false)
  assert.deepEqual(report.sources, [])
  assert.deepEqual(report.sinks, [])
  assert.deepEqual(report.flows, [])
})

test('taint CLI refuses an oversized file from its stat before reading it', async (t) => {
  // The API receives an existing string; the CLI is the entry point that can
  // still avoid decoding a hostile multi-GB file into host memory.
  const { path } = await fixture(t, 'a'.repeat(TAINT_LIMITS.maxSourceBytes + 1))
  const result = await run(['taint', path, '--json'])
  assert.equal(result.code, 1, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.error.code, 'TAINT_SOURCE_LIMIT')
  assert.deepEqual(report.truncatedBy, ['source-size'])
  assert.deepEqual(report.sources, [])
  assert.deepEqual(report.flows, [])
})

test('taint CLI accepts sink suppression fields and an empty arg_positions list', async (t) => {
  const { path } = await fixture(t, 'const input = location.hash;\ncustomEval(input);')
  const config = {
    sinks: [{
      method: 'customEval',
      type: 'code_injection',
      cwe: 'CWE-94',
      severity: 'high',
      arg_positions: [],
      safe_if_string_literal_at: 0,
    }],
  }
  const result = await run(['taint', path, '--json', '--taint-config', JSON.stringify(config)])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.ok(report.sinks.some((sink) => sink.method === 'customEval' && sink.cwe === 'CWE-94'), JSON.stringify(report.sinks))
  assert.ok(report.flows.some((flow) => flow.sink_type === 'code_injection'), JSON.stringify(report.flows))
})
