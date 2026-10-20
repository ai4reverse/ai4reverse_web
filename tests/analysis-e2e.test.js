import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../tools/analysis/orchestrator.js'
import { VERDICT_WEIGHTS } from '../tools/analysis/report.js'

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
  // console output is high volume but not behaviour, and the platform's own
  // installation events are not the sample's: nothing here may score.
  assert.equal(result.report.verdict.score, 0, JSON.stringify(result.report.verdict.reasons))
  assert.deepEqual(result.report.verdict.reasons, [])
})

test('an inert sample scores nothing: platform events are not behaviour', async () => {
  const result = await analyzeSample('var x = 1;', {
    name: 'inert.js',
    logLevel: 'silent',
    env: { strict: false },
  })
  const { report, behavior } = result

  assert.equal(report.verdict.score, 0, JSON.stringify(report.verdict.reasons))
  assert.deepEqual(report.verdict.families, [])
  assert.equal(report.verdict.level, 'benign')
  assert.equal(report.verdict.reasons.some((reason) => reason.code === 'DYNAMIC_DOM'), false)
  assert.equal(report.verdict.reasons.some((reason) => reason.code === 'HOOKS_MOCKED'), false)

  // Evidence is filtered, not hidden: the installation events stay in the trace.
  assert.ok(
    report.dynamic.events.some((event) => event.api === 'document.installed'),
    'document.installed must remain in the trace',
  )
  assert.equal(behavior.counts.dom, 0, 'no guest DOM event occurred')
  assert.ok(behavior.counts.platform > 0, JSON.stringify(behavior.counts))
  assert.equal(report.tracing.truncated, false)
})

test('examples/benign.js stays benign with no platform-injected DOM reason', async () => {
  const source = await readFile(`${ROOT}examples/benign.js`, 'utf8')
  const result = await analyzeSample(source, {
    name: 'benign.js',
    logLevel: 'silent',
    env: { strict: false },
  })

  assert.equal(result.report.verdict.level, 'benign')
  assert.equal(result.report.verdict.score, 0, JSON.stringify(result.report.verdict.reasons))
  assert.equal(result.report.verdict.reasons.some((reason) => reason.code === 'DYNAMIC_DOM'), false)
})

test('real DOM manipulation still scores', async () => {
  const result = await analyzeSample("document.write('<div id=\"x\">hi</div>')", {
    name: 'dom.js',
    logLevel: 'silent',
    env: { strict: false },
  })

  const reason = result.report.verdict.reasons.find((entry) => entry.code === 'DYNAMIC_DOM')
  assert.ok(reason, JSON.stringify(result.report.verdict.reasons))
  assert.match(reason.detail, /DOM mutation/)
})

test('a restoration failure is recorded instead of erased (F8)', async () => {
  const result = await analyzeSample('var x = 1;', {
    name: 'inert.js',
    logLevel: 'silent',
    dynamic: false,
    restoreHooks: {
      pipeline() {
        throw new Error('pass exploded')
      },
    },
  })

  assert.equal(result.report.static.restoration.error, 'pass exploded')
  assert.equal(result.report.static.restoration.code, 'var x = 1;')
  assert.ok(
    result.report.recommendations.some((line) => /restoration failed/i.test(line)),
    JSON.stringify(result.report.recommendations),
  )
  assert.match(result.markdown, /Restoration error:\*\* pass exploded/)
})

test('trace-budget truncation is explicit and survives the lost marker (F9)', async () => {
  // A loop big enough to exceed a tiny code-step budget, so the instrumenter
  // stops emitting and posts its `code:trace-truncated` marker.
  const source = 'var total = 0; for (var i = 0; i < 400; i += 1) { total += i }'
  const result = await analyzeSample(source, {
    name: 'loop.js',
    logLevel: 'silent',
    env: { strict: false },
    instrumentation: { code: { maxEvents: 100 } },
  })

  assert.equal(result.report.dynamic.ok, true, JSON.stringify(result.report.dynamic.error))
  assert.equal(result.traceTruncation.truncated, true, JSON.stringify(result.traceTruncation))
  assert.ok(result.traceTruncation.truncatedBy.includes('code-budget'), JSON.stringify(result.traceTruncation))
  assert.equal(result.report.tracing.truncated, true)
  assert.ok(result.report.tracing.truncatedBy.includes('code-budget'))
  assert.match(result.markdown, /Trace truncated:\*\* yes/)
  assert.match(result.markdown, /code-step budget reached/)
})

test('the retained-window limit also reports truncation', async () => {
  const source = 'var total = 0; for (var i = 0; i < 60; i += 1) { total += i }'
  const result = await analyzeSample(source, {
    name: 'loop.js',
    logLevel: 'silent',
    env: { strict: false },
    limits: { maxEvents: 40 },
  })

  assert.ok(result.report.tracing.dropped > 0, JSON.stringify(result.report.tracing))
  assert.equal(result.report.tracing.truncated, true)
  assert.ok(result.report.tracing.truncatedBy.includes('event-limit'))
  assert.ok(
    result.report.recommendations.some((line) => /Trace truncated/.test(line)),
    JSON.stringify(result.report.recommendations),
  )
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

test('a webinject-style overlay scores DYNAMIC_DOM from real mutations', async () => {
  // The shape `examples/products/01-bank-webinject/sample.js` has: create an
  // element, fill it, attach it. Before mutation tracing existed this sample
  // scored zero DOM events and under-reported its behaviour.
  const source = `(function () {
    var template = '<form id="login"><input name="user"><input name="pass" type="password"></form>'
    var overlay = document.createElement('div')
    overlay.id = 'helios'
    overlay.style.position = 'fixed'
    overlay.innerHTML = template
    overlay.setAttribute('data-bank', 'bs')
    document.body.appendChild(overlay)
    overlay.addEventListener('submit', function (event) { event.preventDefault() })
  })()`
  const result = await analyzeSample(source, { name: 'webinject.js', logLevel: 'silent', env: { strict: false } })
  const { report, behavior } = result

  assert.equal(report.dynamic.ok, true, JSON.stringify(report.dynamic.error))
  assert.ok(behavior.counts.dom >= 2, `expected real mutations, saw ${behavior.counts.dom}`)
  const reason = report.verdict.reasons.find((entry) => entry.code === 'DYNAMIC_DOM')
  assert.ok(reason, JSON.stringify(report.verdict.reasons))
  assert.match(reason.detail, /DOM mutation/)
  assert.ok(
    reason.weight >= VERDICT_WEIGHTS.dynamicDomBase + 2 * VERDICT_WEIGHTS.dynamicDomStep,
    `DOM evidence must scale with the number of mutations: ${reason.weight}`,
  )

  // The evidence is guest-attributed and bounded: no payload text, no host path.
  const mutations = report.dynamic.events.filter((event) => event.kind === 'dom' && event.op)
  assert.ok(mutations.length >= 2, JSON.stringify(mutations))
  assert.ok(mutations.every((event) => event.actor === 'sandbox'))
  assert.deepEqual(
    [...new Set(mutations.map((event) => event.op))].sort(),
    ['appendChild', 'set innerHTML', 'setAttribute'],
  )
  assert.doesNotMatch(JSON.stringify(mutations), /<input|password|helios/, 'no payload text')

  // The platform's own installation events stay excluded from the count.
  assert.ok(behavior.counts.platform > 0, JSON.stringify(behavior.counts))
  assert.ok(report.dynamic.events.some((event) => event.api === 'document.installed'))

  // DOM injection is visible as a kill-chain stage, not just a number.
  assert.ok(behavior.killChain.some((stage) => stage.stage === 'injection'), JSON.stringify(behavior.killChain))
})


test('keepTrace true/false preserves score and provenance for sample-loader', async () => {
  const source = await loaderSource()
  const kept = await analyzeSample(source, {
    name: 'sample-loader.js',
    logLevel: 'silent',
    seed: 0x5eed,
    env: { strict: false },
    keepTrace: true,
  })
  const dropped = await analyzeSample(source, {
    name: 'sample-loader.js',
    logLevel: 'silent',
    seed: 0x5eed,
    env: { strict: false },
    keepTrace: false,
  })

  assert.equal(kept.report.verdict.score, dropped.report.verdict.score)
  assert.deepEqual(
    kept.report.verdict.reasons.map((r) => r.code),
    dropped.report.verdict.reasons.map((r) => r.code),
  )
  assert.deepEqual(kept.report.provenance, dropped.report.provenance)

  for (const entry of kept.report.provenance) {
    assert.ok(entry.refs.length >= 1, entry.reasonCode)
    for (const ref of entry.refs) {
      assert.ok(['event', 'ioc', 'artifact', 'stage', 'killChain'].includes(ref.kind), JSON.stringify(ref))
      assert.equal(typeof ref.id, 'string')
      assert.ok(ref.id.length > 0)
    }
    // Event refs must not point at known platform install seq labels.
    const eventIds = entry.refs.filter((ref) => ref.kind === 'event').map((ref) => String(ref.id))
    assert.equal(eventIds.includes('document.installed'), false)
  }

  // Retained-event absence must not drop evidence: dropped run has empty events.
  assert.equal(dropped.report.dynamic.events.length, 0)
  assert.ok(kept.report.dynamic.events.length > 0)
  assert.ok(kept.report.provenance.length > 0)
  assert.match(kept.markdown, /\*\*Evidence \(/)
})
