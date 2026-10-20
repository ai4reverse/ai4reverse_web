#!/usr/bin/env node
/**
 * Complete-works suite runner.
 *
 * 40 complete works live under examples/works/:
 *   - sdk/   JS security SDKs (each runs its own verify.mjs)
 *   - virus/ malicious samples (analyzed in the strict sandbox against a contract)
 *   - app/   complete applications built on the analysis platform (--self-test)
 *
 *   node examples/works/run-all.mjs [--json] [--filter 01,16,31]
 */
import { readdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../../tools/analysis/orchestrator.js'

const exec = promisify(execFile)
const BASE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const filterIndex = args.indexOf('--filter')
const filter = filterIndex >= 0 ? String(args[filterIndex + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean) : null

const directories = (await readdir(BASE, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{2}-[a-z0-9-]+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const works = []
for (const directory of directories) {
  const id = directory.slice(0, 2)
  if (filter && !filter.includes(id) && !filter.includes(directory)) continue
  const root = `${BASE}${directory}`
  const manifest = JSON.parse(await readFile(`${root}/work.json`, 'utf8'))
  works.push({ id, directory, root, manifest })
}

const failures = []
const results = []
for (const work of works) {
  const { manifest, root, directory } = work
  const detail = []
  try {
    if (!['sdk', 'virus', 'app'].includes(manifest.type)) throw new Error(`unknown type ${manifest.type}`)

    if (manifest.type === 'sdk') {
      const verify = manifest.verify?.command ?? 'node verify.mjs'
      const { stdout } = await exec(verify, { cwd: root, timeout: 120_000, shell: true })
      const match = /checks:\s*(\d+)\/(\d+)/i.exec(stdout)
      if (!match) throw new Error('verify summary missing')
      const passed = Number(match[1])
      const total = Number(match[2])
      if (passed !== total || total < 5) throw new Error(`checks ${passed}/${total}`)
      detail.push(`${passed}/${total} checks`)
    } else if (manifest.type === 'virus') {
      const source = await readFile(`${root}/${manifest.entry ?? 'sample.js'}`, 'utf8')
      const result = await analyzeSample(source, {
        name: `${directory}/${manifest.entry ?? 'sample.js'}`,
        logLevel: 'silent',
        env: { strict: true },
        seed: 0x5eed,
        network: { policy: 'deny', routes: manifest.expect?.networkRoutes ?? [] },
        instrumentation: manifest.expect?.requireVm ? { jsvmp: true } : undefined,
      })
      const report = result.report
      const expectation = manifest.expect ?? {}
      const issues = []
      if (report.dynamic.ok !== true) issues.push(`dynamic.ok=false (${report.dynamic.error?.message ?? 'unknown'})`)
      if (expectation.level && report.verdict.level !== expectation.level) issues.push(`level ${report.verdict.level} != ${expectation.level}`)
      if (Number.isFinite(expectation.minScore) && report.verdict.score < expectation.minScore) issues.push(`score ${report.verdict.score} < ${expectation.minScore}`)
      for (const category of expectation.requireIocs ?? []) {
        if (!Array.isArray(report.static.iocs?.[category]) || report.static.iocs[category].length === 0) issues.push(`missing IOC ${category}`)
      }
      if (Array.isArray(expectation.artifactsAny) && expectation.artifactsAny.length > 0) {
        const kinds = new Set((report.artifacts ?? []).map((artifact) => artifact.kind))
        if (!expectation.artifactsAny.some((kind) => kinds.has(kind))) issues.push(`missing artifact ${expectation.artifactsAny.join('|')}`)
      }
      for (const technique of expectation.requireTechniques ?? []) {
        if (!(report.static.techniques ?? []).includes(technique)) issues.push(`missing technique ${technique}`)
      }
      for (const kind of expectation.requireTraceKinds ?? []) {
        if (!(report.dynamic.counts?.byKind?.[kind] > 0)) issues.push(`missing trace ${kind}`)
      }
      if (expectation.requireVm === true && report.tracing.jsvmp?.detected !== true) issues.push('JSVMP not detected')
      if (expectation.allowIntegrityDrift !== true && report.integrity?.intact !== true) issues.push('integrity drift')
      if (result.run?.disposal?.ok !== true) issues.push('disposal failed')
      detail.push(`${report.verdict.level} ${report.verdict.score}`)
      if (issues.length > 0) throw new Error(issues.join('; '))
    } else {
      const verify = manifest.verify ?? {}
      const argv = [manifest.entry ?? 'app.mjs', ...(verify.args ?? ['--self-test'])]
      const { stdout } = await exec(process.execPath, argv, { cwd: root, timeout: 180_000 })
      const expected = verify.expect ?? 'SELFTEST OK'
      if (!stdout.includes(expected)) throw new Error(`missing marker ${expected}`)
      detail.push(String(expected))
    }
  } catch (error) {
    failures.push({ id: manifest.id, title: manifest.title, reason: error.message })
    results.push({ id: manifest.id, type: manifest.type, title: manifest.title, grade: manifest.grade, ok: false, detail: [...detail, error.message] })
    continue
  }
  results.push({ id: manifest.id, type: manifest.type, title: manifest.title, grade: manifest.grade, ok: true, detail })
}

if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed: results.length - failures.length, failed: failures.length, results, failures }, null, 2))
} else {
  const header = ['ID', 'TYPE', 'TITLE', 'GRADE', 'RESULT']
  const rows = results.map((record) => [record.id, record.type, record.title, record.grade, record.ok ? record.detail.join('; ') : `FAIL: ${record.detail.join('; ')}`])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  console.log(line(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
  console.log(`\n${results.length - failures.length}/${results.length} works verified`)
}
if (failures.length > 0) process.exitCode = 1
