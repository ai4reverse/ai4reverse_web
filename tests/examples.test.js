import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../tools/analysis/orchestrator.js'
import { restore } from '../tools/restore/index.js'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXAMPLES = `${ROOT}examples`

const SAMPLES = [
  'benign.js',
  'sample-loader.js',
  'string-array-obfuscated.js',
  'control-flow-flattened.js',
  'jsfuck-lite.js',
  'eval-chain.js',
  'staged-payload.js',
  'network-c2.js',
  'anti-analysis.js',
  'fingerprint-probe.js',
  'jsvmp-sample.js',
]

const DEMOS = ['api-usage.mjs', 'hooks-demo.mjs', 'restore-demo.mjs', 'jsvmp-demo.mjs']

async function analyzeFile(name) {
  const source = await readFile(`${EXAMPLES}/${name}`, 'utf8')
  return analyzeSample(source, {
    name,
    logLevel: 'silent',
    env: { strict: true },
    seed: 0x5eed,
    instrumentation: name === 'jsvmp-sample.js' ? { jsvmp: true } : undefined,
  })
}

test('every example sample executes in the sandbox and produces a report', async () => {
  for (const name of SAMPLES) {
    const result = await analyzeFile(name)
    assert.equal(result.report.dynamic.ok, true, `${name}: ${JSON.stringify(result.report.dynamic.error)}`)
    assert.equal(typeof result.report.verdict.score, 'number', name)
    assert.ok(['benign', 'suspicious', 'malicious'].includes(result.report.verdict.level), name)
    assert.equal(result.report.sample.name, name)
    assert.equal(result.report.sample.sha256.length, 64)
    assert.ok(result.report.recommendations.length > 0)
  }
})

test('malicious example exercises staging, IOCs, artifacts and restoration', async () => {
  const result = await analyzeFile('sample-loader.js')
  assert.ok(['suspicious', 'malicious'].includes(result.report.verdict.level))
  assert.ok(result.report.static.iocs.urls.some((entry) => /c2\.example\.test/.test(entry.value)))
  assert.ok(result.report.artifacts.some((artifact) => artifact.kind === 'eval-payload' || artifact.kind === 'decoded-string'))
  assert.ok(result.report.static.restoration.passes.some((pass) => pass.changed))
  assert.ok(result.report.dynamic.behavior.killChain.some((stage) => stage.stage === 'execution'))
})

test('staged payload and eval chain expose decoded artifacts', async () => {
  for (const name of ['eval-chain.js', 'staged-payload.js']) {
    const result = await analyzeFile(name)
    assert.ok(result.report.artifacts.length >= 2, `${name}: ${JSON.stringify(result.report.artifacts)}`)
    const kinds = result.report.artifacts.map((artifact) => artifact.kind)
    assert.ok(
      kinds.includes('eval-payload') || kinds.includes('function-body') || kinds.includes('decoded-string'),
      `${name}: ${kinds.join(',')}`,
    )
  }
})

test('anti-analysis sample detects nothing in the sandbox', async () => {
  const result = await analyzeFile('anti-analysis.js')
  const consoleText = (result.run?.events ?? [])
    .filter((event) => event.kind === 'api' && event.api === 'console.log')
    .map((event) => String(event.text))
    .join('\n')
  assert.match(consoleText, /analysis findings: none/, consoleText)
  assert.ok(result.report.static.techniques.includes('anti-debugging'))
})

test('network sample is fully mocked and yields network IOCs', async () => {
  const result = await analyzeFile('network-c2.js')
  const netEvents = (result.run?.events ?? []).filter((event) => event.kind === 'net')
  assert.ok(netEvents.length >= 3, JSON.stringify(netEvents))
  assert.ok(netEvents.every((event) => event.status === 0 || event.status === 204 || event.status === 200))
  assert.ok(result.report.static.iocs.urls.some((entry) => /c2\.example\.test/.test(entry.value)))
})

test('JSVMP sample is detected and traced at opcode level', async () => {
  const result = await analyzeFile('jsvmp-sample.js')
  assert.equal(result.report.tracing.jsvmp.detected, true)
  assert.ok(result.report.tracing.jsvmp.opcodes >= 10)
  assert.ok(result.report.tracing.jsvmp.steps > 0)
  const consoleText = (result.run?.events ?? [])
    .filter((event) => event.kind === 'api' && event.api === 'console.log')
    .map((event) => String(event.text))
    .join('\n')
  assert.match(consoleText, /fib\(10\)=55/, consoleText)
})

test('restoration makes the string-array example readable', () => {
  return readFile(`${EXAMPLES}/string-array-obfuscated.js`, 'utf8').then((source) => {
    const restored = restore(source)
    assert.match(restored.code, /https:\/\/c2\.example\.test\/gate/)
    assert.doesNotMatch(restored.code, /_0xd\(|_0x4f2a/)
  })
})

test('example demos run end-to-end', async () => {
  for (const demo of DEMOS) {
    const { stdout } = await exec(process.execPath, [`${EXAMPLES}/${demo}`], {
      cwd: ROOT,
      timeout: 120_000,
    })
    assert.ok(stdout.length > 0, demo)
    if (demo === 'api-usage.mjs') assert.match(stdout, /verdict:/)
    if (demo === 'hooks-demo.mjs') assert.match(stdout, /network IOCs:/)
    if (demo === 'restore-demo.mjs') assert.match(stdout, /passes:/)
    if (demo === 'jsvmp-demo.mjs') assert.match(stdout, /opcode trace events:/)
  }
})

test('the CLI cookbook script exits successfully', async () => {
  const { stdout } = await exec('bash', [`${EXAMPLES}/cli-usage.sh`], { cwd: ROOT, timeout: 180_000 })
  assert.match(stdout, /list restoration passes/)
  assert.match(stdout, /JSVMP tracing summary/)
})

test('examples/README documents every example', async () => {
  const readme = await readFile(`${EXAMPLES}/README.md`, 'utf8')
  const files = (await readdir(EXAMPLES)).filter((name) => name !== 'README.md')
  for (const name of files) {
    assert.ok(readme.includes(name), `examples/README.md does not mention ${name}`)
  }
})
