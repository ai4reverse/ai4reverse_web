#!/usr/bin/env node
/**
 * MEGA suite runner — pure-JS, single-file, 50MB-effective-code works.
 *
 * Each work is exactly one JavaScript file (no imports, requires, modules or
 * external libraries). The runner:
 *   1. enforces single-file/pure-JS purity,
 *   2. measures effective code (comments + blank lines stripped),
 *   3. executes the file and requires `MEGA SELFTEST OK` plus MEGA METRICS,
 *   4. validates white-box / custom-cipher / encoding / JSVMP / env-detection
 *      capability minima from the manifest,
 *   5. enforces per-work and suite-wide byte gates (default 50,000,000).
 *
 *   node examples/mega/run-all.mjs [--json] [--filter 01,05]
 *        [--min-effective-bytes 50000000] [--min-work-bytes 2800000]
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const BASE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const filter = option('--filter', '') ? String(option('--filter', '')).split(',').map((item) => item.trim()).filter(Boolean) : null
const minEffectiveBytes = Number(option('--min-effective-bytes', '50000000'))
const minWorkBytes = Number(option('--min-work-bytes', '2800000'))

const ALLOWED_EXTRA_FILES = new Set(['work.json', 'README.md'])

/** Strip block/line comments and blank lines; conservative effective measure. */
export function effectiveBytes(source) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, '')
  return text
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1').trim())
    .filter(Boolean)
    .join('\n').length
}

const FORBIDDEN = [
  { id: 'require', pattern: /\brequire\s*\(/ },
  { id: 'import', pattern: /\bimport\s+(?:[\w*{]|\()/ },
  { id: 'export', pattern: /\bexport\s+(?:default|const|let|var|function|class|\{)/ },
  { id: 'module-exports', pattern: /\bmodule\.exports\b|\bexports\.[\w$]+\s*=/ },
  { id: 'amd', pattern: /\bdefine\s*\(\s*\[/ },
  { id: 'node-protocol', pattern: /['"]node:/ },
  { id: 'wasm', pattern: /\bWebAssembly\.(?:instantiate|compile|Module)\b/ },
]

async function listFiles(directory) {
  const output = []
  const walk = async (current, prefix = '') => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(`${current}/${entry.name}`, relative)
      } else {
        output.push({ relative, path: `${current}/${entry.name}`, size: (await stat(`${current}/${entry.name}`)).size })
      }
    }
  }
  await walk(directory)
  return output
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
  const files = await listFiles(root)
  const jsFiles = files.filter((file) => /\.(?:js|mjs|cjs)$/.test(file.relative))
  const extra = files.filter((file) => !/\.(?:js|mjs|cjs)$/.test(file.relative) && !ALLOWED_EXTRA_FILES.has(file.relative))
  const entry = manifest.entry ?? jsFiles[0]?.relative
  const entryFile = files.find((file) => file.relative === entry)
  const issues = []

  if (!entryFile) issues.push(`missing entry ${entry ?? '(none)'}`)
  if (jsFiles.length !== 1) issues.push(`expected exactly one JS file, found ${jsFiles.length}`)
  if (extra.length > 0) issues.push(`unexpected non-JS files: ${extra.map((file) => file.relative).join(',')}`)
  if (files.some((file) => file.relative.includes('/'))) issues.push('code must not be split into subdirectories/modules')

  let effective = 0
  let raw = 0
  if (entryFile) {
    const source = await readFile(entryFile.path, 'utf8')
    raw = Buffer.byteLength(source, 'utf8')
    effective = effectiveBytes(source)
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(source)) issues.push(`impure JS: ${rule.id}`)
    }
  }
  totalEffective += effective
  totalRaw += raw
  if (effective < minWorkBytes) issues.push(`effective code ${(effective / 1048576).toFixed(2)}MB < ${(minWorkBytes / 1048576).toFixed(2)}MB`)

  const protection = manifest.protection ?? {}
  const crypto = manifest.crypto ?? {}
  const environment = manifest.environment ?? {}
  if (protection.blackhole !== true) issues.push('missing blackhole obfuscation declaration')
  if (protection.fortressJsvmp !== true) issues.push('missing fortress JSVMP declaration')
  if (protection.dynamic !== true || protection.polymorphic !== true || protection.adversarial !== true) {
    issues.push('protection must declare dynamic/polymorphic/adversarial')
  }
  if (!(crypto.whitebox >= 3)) issues.push('manifest requires >=3 white-box suites')
  if (!(crypto.customCiphers >= 3)) issues.push('manifest requires >=3 custom ciphers')
  if (!(crypto.encodings >= 3)) issues.push('manifest requires >=3 custom encodings')
  if (crypto.mixed !== true) issues.push('manifest requires mixed encryption')
  if (environment.renderingEngine !== true) issues.push('manifest requires rendering-engine detection')

  let metrics = null
  let stdout = ''
  if (entryFile) {
    try {
      const run = await exec(process.execPath, [entryFile.path], { cwd: root, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
      stdout = run.stdout ?? ''
      const metricsMatch = /MEGA METRICS (\{[\s\S]*?\})/.exec(stdout)
      if (!stdout.includes('MEGA SELFTEST OK')) issues.push('missing MEGA SELFTEST OK marker')
      if (!metricsMatch) issues.push('missing MEGA METRICS JSON')
      else {
        try {
          metrics = JSON.parse(metricsMatch[1])
        } catch {
          issues.push('invalid MEGA METRICS JSON')
        }
      }
    } catch (error) {
      issues.push(`execution failed: ${error.message.split('\n')[0]}`)
    }
  }

  if (metrics) {
    if (!(metrics.whitebox >= 3)) issues.push(`metrics: whitebox ${metrics.whitebox} < 3`)
    if (!(metrics.customCiphers >= 3)) issues.push(`metrics: customCiphers ${metrics.customCiphers} < 3`)
    if (!(metrics.encodings >= 3)) issues.push(`metrics: encodings ${metrics.encodings} < 3`)
    if (!(metrics.jsvmpOps >= 1000)) issues.push(`metrics: jsvmpOps ${metrics.jsvmpOps} < 1000`)
    if (!(metrics.envChecks >= 50)) issues.push(`metrics: envChecks ${metrics.envChecks} < 50`)
    if (!(metrics.polymorphicVariants >= 10)) issues.push(`metrics: polymorphicVariants ${metrics.polymorphicVariants} < 10`)
    if (!(metrics.mixedRounds >= 1)) issues.push('metrics: mixedRounds < 1')
    if (metrics.documentAll !== true) issues.push('metrics: document.all probe not executed')
    if (!(metrics.antiDebug >= 1)) issues.push('metrics: anti-debug checks missing')
  }

  if (issues.length > 0) {
    failures.push({ id: manifest.id, title: manifest.title, reasons: issues })
    results.push({
      id: manifest.id,
      type: manifest.type,
      title: manifest.title,
      grade: manifest.grade,
      effective,
      raw,
      metrics,
      ok: false,
      issues,
    })
    continue
  }
  results.push({
    id: manifest.id,
    type: manifest.type,
    title: manifest.title,
    grade: manifest.grade,
    effective,
    raw,
    metrics,
    ok: true,
    issues: [],
  })
}

const belowMinimum = !filter && (totalEffective < minEffectiveBytes || failures.length > 0)
if (!filter && totalEffective < minEffectiveBytes) {
  failures.push({ id: 'suite', title: 'effective code volume', reasons: [`${totalEffective} < ${minEffectiveBytes}`] })
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        total: results.length,
        passed: results.length - failures.filter((failure) => failure.id !== 'suite').length,
        failed: failures.length,
        totalEffectiveBytes: totalEffective,
        totalRawBytes: totalRaw,
        minEffectiveBytes,
        minWorkBytes,
        belowMinimum,
        results,
        failures,
      },
      null,
      2,
    ),
  )
} else {
  const header = ['ID', 'TYPE', 'TITLE', 'GRADE', 'CODE', 'WB', 'CIPH', 'ENC', 'VM-OPS', 'ENV', 'RESULT']
  const rows = results.map((record) => [
    record.id,
    record.type,
    record.title,
    record.grade,
    `${(record.effective / 1048576).toFixed(2)}MB`,
    String(record.metrics?.whitebox ?? '-'),
    String(record.metrics?.customCiphers ?? '-'),
    String(record.metrics?.encodings ?? '-'),
    String(record.metrics?.jsvmpOps ?? '-'),
    String(record.metrics?.envChecks ?? '-'),
    record.ok ? 'PASS' : `FAIL: ${record.issues.join('; ')}`,
  ])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  console.log(line(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
  console.log(
    `\n${results.filter((record) => record.ok).length}/${results.length} works verified | effective ${(totalEffective / 1048576).toFixed(2)}MB (raw ${(totalRaw / 1048576).toFixed(2)}MB)`,
  )
}
if (failures.length > 0) process.exitCode = 1
