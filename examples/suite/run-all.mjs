#!/usr/bin/env node
/**
 * Suite II runner — complete commercial/military works with a code-volume gate.
 *
 * Verifies every package by type:
 *   sdk   -> run verify.mjs, require `checks: N/N` (N >= 5)
 *   virus -> strict-sandbox analysis + contract validation
 *   app   -> run `--self-test`, require the declared marker
 *
 * It also measures *effective* code (comments and blank lines stripped) across
 * the suite and enforces `--min-effective-bytes` (default 100000) on a full run.
 *
 *   node examples/suite/run-all.mjs [--json] [--filter 01,11] [--min-effective-bytes N]
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { analyzeSample } from '../../tools/analysis/orchestrator.js'

const exec = promisify(execFile)
const BASE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const filter = option('--filter', '') ? String(option('--filter', '')).split(',').map((item) => item.trim()).filter(Boolean) : null
const minEffectiveBytes = Number(option('--min-effective-bytes', '100000'))

/** Strip block/line comments and blank lines for a conservative effective-size measure. */
export function effectiveBytes(source) {
  const withoutBlocks = String(source).replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLines = withoutBlocks
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1').trim())
    .filter(Boolean)
    .join('\n')
  return Buffer.byteLength(withoutLines, 'utf8')
}

async function codeFiles(directory) {
  const output = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build'].includes(entry.name)) continue
        await walk(path)
      } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        output.push(path)
      }
    }
  }
  await walk(directory)
  return output
}

async function measure(directory) {
  const files = await codeFiles(directory)
  let raw = 0
  let effective = 0
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    raw += Buffer.byteLength(source, 'utf8')
    effective += effectiveBytes(source)
  }
  return { files: files.length, raw, effective }
}

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
let totalEffective = 0
let totalRaw = 0

for (const work of works) {
  const { manifest, root, directory } = work
  const detail = []
  const size = await measure(root)
  totalEffective += size.effective
  totalRaw += size.raw
  try {
    if (!['sdk', 'virus', 'app'].includes(manifest.type)) throw new Error(`unknown type ${manifest.type}`)

    if (manifest.type === 'sdk') {
      const { stdout } = await exec(manifest.verify?.command ?? 'node verify.mjs', { cwd: root, timeout: 180_000, shell: true })
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
      const { stdout } = await exec(process.execPath, [manifest.entry ?? 'app.mjs', ...(verify.args ?? ['--self-test'])], { cwd: root, timeout: 300_000 })
      const expected = verify.expect ?? 'SELFTEST OK'
      if (!stdout.includes(expected)) throw new Error(`missing marker ${expected}`)
      detail.push(String(expected))
    }
    detail.push(`${(size.effective / 1024).toFixed(1)}KB code`)
  } catch (error) {
    failures.push({ id: manifest.id, title: manifest.title, reason: error.message })
    results.push({ id: manifest.id, type: manifest.type, title: manifest.title, grade: manifest.grade, ok: false, detail: [...detail, error.message], ...size })
    continue
  }
  results.push({ id: manifest.id, type: manifest.type, title: manifest.title, grade: manifest.grade, ok: true, detail, ...size })
}

const belowMinimum = !filter && totalEffective < minEffectiveBytes
if (belowMinimum) failures.push({ id: 'suite', title: 'code volume', reason: `effective code ${totalEffective} < ${minEffectiveBytes} bytes` })

if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed: results.length - failures.length, failed: failures.length, totalEffectiveBytes: totalEffective, totalRawBytes: totalRaw, minEffectiveBytes, belowMinimum, results, failures }, null, 2))
} else {
  const header = ['ID', 'TYPE', 'TITLE', 'GRADE', 'CODE', 'RESULT']
  const rows = results.map((record) => [
    record.id,
    record.type,
    record.title,
    record.grade,
    `${(record.effective / 1024).toFixed(1)}KB`,
    record.ok ? record.detail.filter((item) => !/KB code$/.test(item)).join('; ') : `FAIL: ${record.detail.join('; ')}`,
  ])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  console.log(line(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
  console.log(`\n${results.length - failures.length}/${results.length} works verified | effective code ${(totalEffective / 1024).toFixed(1)}KB (raw ${(totalRaw / 1024).toFixed(1)}KB)`)
}
if (failures.length > 0) process.exitCode = 1
