#!/usr/bin/env node
/**
 * API usage walkthrough.
 *
 * Demonstrates the three entry points an integration will normally use:
 *
 *   - TracelessSandbox.run()  — one dynamic run with a full trace record
 *   - analyzeSample()         — static + dynamic + restored + report
 *   - restore()               — Babel parse/transform/generate
 *
 * Run: node examples/api-usage.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  TracelessSandbox,
  analyzeSample,
  restore,
  createLogger,
  createMemoryDestination,
} from '../tools/index.js'

const file = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))

// ---------------------------------------------------------------------------
// 1. Dynamic run with in-memory pino logs
// ---------------------------------------------------------------------------
const destination = createMemoryDestination()
const logger = createLogger({ level: 'info', destination })

const sandbox = await TracelessSandbox.create({
  seed: 7,
  logger,
  env: { strict: true },
  profile: { locale: 'zh-CN', os: 'windows', browser: 'chrome' },
})

const run = await sandbox.run(
  `
  function stage(n) {
    var url = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");
    return url + '?stage=' + n;
  }
  console.log('endpoint', stage(2));
  localStorage.setItem('stage', '2');
  `,
  { filename: 'https://cdn.example.test/assets/app.4f19.min.js' },
)

console.log('--- dynamic run ---')
console.log('ok:', run.ok, '| result:', JSON.stringify(run.result?.preview ?? run.result))
console.log('filename:', run.filename)
console.log('trace events:', run.traceStats.total, run.traceStats.byKind)
console.log('integrity intact:', run.integrity.intact, '| disposal ok:', run.disposal.ok)
logger.info({ runId: run.runId, ok: run.ok }, 'dynamic run complete')
console.log('pino lines captured:', destination.records().length)
const evalLike = (run.events ?? []).filter((event) => event.event === 'eval' || /atob/.test(event.api ?? ''))
console.log('decoding calls observed:', evalLike.length)

// The sandbox is reusable; each run still gets a fresh context.
const second = await sandbox.run('typeof localStorage.getItem("stage")')
console.log('fresh context in second run:', second.result.value)
sandbox.dispose()

// ---------------------------------------------------------------------------
// 2. Full analysis pipeline + report
// ---------------------------------------------------------------------------
console.log('\n--- analyzeSample ---')
const loader = await readFile(file('sample-loader.js'), 'utf8')
const analysis = await analyzeSample(loader, {
  name: 'sample-loader.js',
  seed: 0x5eed,
  logLevel: 'silent',
  network: { policy: 'deny' },
})
console.log('verdict:', analysis.report.verdict.level, analysis.report.verdict.score)
console.log('reasons:', analysis.report.verdict.reasons.map((reason) => reason.code).join(', '))
console.log('urls:', analysis.report.static.iocs.urls.map((entry) => entry.value))
console.log('artifacts:', analysis.report.artifacts.map((artifact) => `${artifact.kind}:${artifact.sha256.slice(0, 8)}`))
console.log('kill chain:', analysis.report.dynamic.behavior.killChain.map((stage) => stage.stage).join(' -> '))
console.log('recommendations:', analysis.report.recommendations.length)

// ---------------------------------------------------------------------------
// 3. Static restoration
// ---------------------------------------------------------------------------
console.log('\n--- restore ---')
const obfuscated = await readFile(file('string-array-obfuscated.js'), 'utf8')
const restored = restore(obfuscated)
console.log('bytes:', analysis.report.static.restoration.size, '->', Buffer.byteLength(restored.code))
console.log(
  'changed passes:',
  restored.passes.filter((pass) => pass.changed).map((pass) => pass.id).join(', '),
)
console.log(restored.code.split('\n').slice(0, 8).join('\n'))
