#!/usr/bin/env node
/**
 * Product-suite runner.
 *
 * Analyzes every product package under examples/products/ with the strict
 * sandbox and validates the expectations declared in each product.json
 * (verdict level, minimum score, IOC categories, artifact kinds, techniques,
 * JSVMP tracing). Exits non-zero if any product drifts from its contract.
 *
 *   node examples/products/run-all.mjs            # table
 *   node examples/products/run-all.mjs --json     # machine-readable results
 *   node examples/products/run-all.mjs --filter 03,17
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../../tools/analysis/orchestrator.js'

const BASE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const filterIndex = args.indexOf('--filter')
const filter = filterIndex >= 0 ? String(args[filterIndex + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean) : null

const directories = (await readdir(BASE, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{2}-[a-z0-9-]+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const products = []
for (const directory of directories) {
  const id = directory.slice(0, 2)
  if (filter && !filter.includes(id) && !filter.includes(directory)) continue
  const root = `${BASE}${directory}`
  const manifest = JSON.parse(await readFile(`${root}/product.json`, 'utf8'))
  const source = await readFile(`${root}/${manifest.sample ?? 'sample.js'}`, 'utf8')
  products.push({ id, directory, root, manifest, source })
}

if (products.length === 0) {
  console.error('no product packages found')
  process.exit(1)
}

const failures = []
const results = []

for (const product of products) {
  const { manifest, source, directory } = product
  const expectation = manifest.expect ?? {}
  const instrumentation = expectation.requireVm ? { jsvmp: true } : undefined
  let result
  try {
    result = await analyzeSample(source, {
      name: `${directory}/${manifest.sample ?? 'sample.js'}`,
      logLevel: 'silent',
      env: { strict: true },
      seed: 0x5eed,
      instrumentation,
      network: { policy: 'deny', routes: expectation.networkRoutes ?? [] },
    })
  } catch (error) {
    failures.push({ id: manifest.id, name: manifest.name, reason: `analysis threw: ${error.message}` })
    continue
  }

  const report = result.report
  const reasons = []
  if (!['critical', 'high', 'medium', 'low'].includes(manifest.severity)) {
    reasons.push(`invalid severity ${manifest.severity}`)
  }
  if (report.dynamic.ok !== true) reasons.push(`dynamic.ok=false (${report.dynamic.error?.message ?? 'unknown'})`)
  if (expectation.level && report.verdict.level !== expectation.level) {
    reasons.push(`level ${report.verdict.level} != ${expectation.level}`)
  }
  if (Number.isFinite(expectation.minScore) && report.verdict.score < expectation.minScore) {
    reasons.push(`score ${report.verdict.score} < ${expectation.minScore}`)
  }
  for (const category of expectation.requireIocs ?? []) {
    const entries = report.static.iocs?.[category]
    if (!Array.isArray(entries) || entries.length === 0) reasons.push(`missing IOC category ${category}`)
  }
  if (Array.isArray(expectation.artifactsAny) && expectation.artifactsAny.length > 0) {
    const kinds = new Set((report.artifacts ?? []).map((artifact) => artifact.kind))
    if (!expectation.artifactsAny.some((kind) => kinds.has(kind))) {
      reasons.push(`no artifact of kind ${expectation.artifactsAny.join('|')}`)
    }
  }
  for (const technique of expectation.requireTechniques ?? []) {
    if (!(report.static.techniques ?? []).includes(technique)) reasons.push(`missing technique ${technique}`)
  }
  for (const kind of expectation.requireTraceKinds ?? []) {
    if (!(report.dynamic.counts?.byKind?.[kind] > 0)) reasons.push(`missing trace kind ${kind}`)
  }
  if (expectation.requireVm === true && report.tracing.jsvmp?.detected !== true) {
    reasons.push('JSVMP not detected')
  }
  if (report.sample?.sha256?.length !== 64) reasons.push('missing sample hash')
  if (report.integrity?.intact !== true) reasons.push('integrity drift detected')
  if (result.run?.disposal?.ok !== true) reasons.push('handle disposal failed')

  const iocCount = Object.entries(report.static.iocs ?? {})
    .filter(([key, value]) => key !== 'meta' && Array.isArray(value))
    .reduce((sum, [, value]) => sum + value.length, 0)
  const record = {
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    grade: manifest.grade,
    severity: manifest.severity,
    category: manifest.category,
    level: report.verdict.level,
    score: report.verdict.score,
    iocs: iocCount,
    artifacts: report.artifacts.length,
    techniques: report.static.techniques.length,
    jsvmp: report.tracing.jsvmp?.detected === true,
    integrity: report.integrity?.intact === true,
    disposal: result.run?.disposal?.ok === true,
    ok: reasons.length === 0,
    reasons,
  }
  results.push(record)
  if (reasons.length > 0) failures.push({ ...record, reasons })
}

if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed: results.length - failures.length, failed: failures.length, results, failures }, null, 2))
} else {
  const header = ['ID', 'PRODUCT', 'GRADE', 'SEV', 'LEVEL', 'SCORE', 'IOC', 'ART', 'TECH', 'VM', 'STATUS']
  const rows = results.map((record) => [
    record.id,
    record.name,
    record.grade,
    record.severity,
    record.level,
    String(record.score),
    String(record.iocs),
    String(record.artifacts),
    String(record.techniques),
    record.jsvmp ? 'yes' : '-',
    record.ok ? 'PASS' : `FAIL: ${record.reasons.join('; ')}`,
  ])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  console.log(line(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
  console.log(`\n${results.length - failures.length}/${results.length} products satisfied their expectations`)
}

if (failures.length > 0) process.exitCode = 1
