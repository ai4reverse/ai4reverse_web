import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../tools/analysis/orchestrator.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function loaderSource() {
  return readFile(`${ROOT}examples/sample-loader.js`, 'utf8')
}

test('end-to-end analysis of the synthetic loader produces a full report', async () => {
  const source = await loaderSource()
  const result = await analyzeSample(source, {
    name: 'sample-loader.js',
    logLevel: 'silent',
    seed: 0x5eed,
    env: { strict: false },
  })

  const { report, markdown } = result
  for (const key of ['meta', 'sample', 'verdict', 'static', 'dynamic', 'tracing', 'hooks', 'artifacts', 'recommendations', 'integrity']) {
    assert.ok(key in report, `report missing ${key}`)
  }
  assert.equal(report.sample.name, 'sample-loader.js')
  assert.equal(report.sample.sha256.length, 64)
  assert.ok(['suspicious', 'malicious'].includes(report.verdict.level), JSON.stringify(report.verdict))
  assert.ok(report.verdict.reasons.length > 0)
  assert.ok(report.static.techniques.includes('dynamic-code-execution'))
  assert.ok(report.static.restoration.passes.some((pass) => pass.changed))
  assert.ok(Array.isArray(report.static.iocs.urls) && report.static.iocs.urls.length >= 1)
  assert.ok(report.static.iocs.urls.some((entry) => /c2\.example\.test/.test(entry.value)))
  assert.equal(report.dynamic.ok, true, JSON.stringify(report.dynamic.error))
  const eventCount = Object.values(report.dynamic.counts.byKind ?? {}).reduce((sum, value) => sum + value, 0)
  assert.ok(eventCount > 0, JSON.stringify(report.dynamic.counts))
  assert.ok(report.dynamic.behavior.apis.length > 0)
  assert.ok(report.dynamic.behavior.killChain.some((stage) => stage.stage === 'execution'))
  assert.ok(report.artifacts.some((artifact) => /stage-2 executed/.test(artifact.preview ?? '')))
  assert.ok(report.recommendations.length > 0)
  assert.equal(report.integrity.intact, true, JSON.stringify(report.integrity.drift))

  assert.match(markdown, /^# ai4reverse analysis report/m)
  assert.match(markdown, /## Verdict/)
  assert.match(markdown, /## IOCs/)
  assert.match(markdown, /## Dynamic behaviour/)
  assert.doesNotMatch(markdown, /\[object Object\]|NaN%|: NaN/)

  assert.doesNotThrow(() => JSON.stringify(report))
})

test('benign sample stays benign and reports no C2', async () => {
  const result = await analyzeSample(
    "var total = 0; for (var i = 1; i <= 10; i++) { total += i } console.log('total', total);",
    { name: 'benign.js', logLevel: 'silent', env: { strict: false } },
  )
  assert.ok(['benign', 'suspicious'].includes(result.report.verdict.level))
  assert.equal(result.report.verdict.level, 'benign', JSON.stringify(result.report.verdict.reasons))
  assert.equal(result.report.static.iocs.urls.length, 0)
  assert.equal(result.report.dynamic.ok, true)
})

test('static-only analysis skips execution but keeps static sections', async () => {
  const source = await loaderSource()
  const result = await analyzeSample(source, {
    name: 'sample-loader.js',
    logLevel: 'silent',
    dynamic: false,
    env: { strict: false },
  })
  assert.equal(result.run, null)
  assert.equal(result.report.dynamic.ok, false)
  assert.ok(result.report.static.restoration.passes.length > 0)
  assert.ok(result.report.static.iocs.urls.length >= 1)
})

test('restored code can be executed for comparison', async () => {
  const source = await loaderSource()
  const result = await analyzeSample(source, {
    name: 'sample-loader.js',
    logLevel: 'silent',
    runRestored: true,
    env: { strict: false },
  })
  assert.ok(result.report.dynamic.restored !== null)
  assert.equal(typeof result.report.dynamic.restored.ok, 'boolean')
})

test('JSVMP sample is reported as a virtual machine in tracing', async () => {
  const { buildVM, buildSampleProgram } = await import('../tools/jsvmp/index.js')
  const vm = buildVM(buildSampleProgram(), { seed: 4 })
  const result = await analyzeSample(`${vm.code}\n__vm_run()`, {
    name: 'vm.js',
    logLevel: 'silent',
    env: { strict: false },
    instrumentation: { jsvmp: true },
  })
  assert.equal(result.report.dynamic.ok, true, JSON.stringify(result.report.dynamic.error))
  assert.equal(result.report.tracing.jsvmp.detected, true)
  assert.ok(result.report.tracing.jsvmp.opcodes >= 10)
  assert.ok(result.report.tracing.jsvmp.steps > 0)
  assert.match(result.report.dynamic.result.preview ?? '', /fib\(10\)=55/)
})

test('report units and provenance are schema-correct', async () => {
  const source = await loaderSource()
  const result = await analyzeSample(source, { name: 'sample-loader.js', logLevel: 'silent', env: { strict: false } })
  const { report } = result
  assert.ok(report.static.restoration.reducedBy > 1, 'reducedBy must be bytes, not a fraction')
  assert.equal(typeof report.static.restoration.size, 'number')
  assert.ok(report.artifacts.length > 0)
  assert.ok(report.artifacts.every((artifact) => typeof artifact.sha256 === 'string'))
  assert.ok(report.artifacts.some((artifact) => typeof artifact.source === 'string' && artifact.source.length > 0))
  for (const entry of report.static.iocs.urls) {
    if (entry.sources) assert.ok(entry.sources.length >= 2, JSON.stringify(entry))
  }
})

test('restored code contributes static IOCs when the original is escape-heavy', async () => {
  const source =
    'var url = "\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2f\\x63\\x32\\x2e\\x65\\x78\\x61\\x6d\\x70\\x6c\\x65\\x2e\\x74\\x65\\x73\\x74\\x2f\\x78";'
  const result = await analyzeSample(source, { name: 'escaped.js', logLevel: 'silent', env: { strict: false } })
  const urls = result.report.static.iocs.urls.map((entry) => entry.value)
  assert.ok(urls.some((value) => value.includes('c2.example.test')), JSON.stringify(urls))
})

test('mergeIocs tracks truncation and only multi-source entries carry sources', async () => {
  const { mergeIocs } = await import('../tools/analysis/orchestrator.js')
  const merged = mergeIocs(
    { urls: [{ value: 'https://a.test', source: 'static' }], meta: { truncated: true } },
    { urls: [{ value: 'https://a.test', source: 'dynamic' }, { value: 'https://b.test', source: 'dynamic' }] },
  )
  assert.equal(merged.meta.truncated, true)
  const a = merged.urls.find((entry) => entry.value === 'https://a.test')
  const b = merged.urls.find((entry) => entry.value === 'https://b.test')
  assert.deepEqual(a.sources, ['static', 'dynamic'])
  assert.equal('sources' in b, false)
})
