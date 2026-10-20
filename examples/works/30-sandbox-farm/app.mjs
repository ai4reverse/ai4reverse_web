#!/usr/bin/env node
/**
 * Sandbox Farm — run many samples across a bounded pool of isolated QuickJS
 * sandboxes, aggregate verdicts/IOCs and prove per-run isolation.
 */
import { readFile } from 'node:fs/promises'
import { TracelessSandbox } from '../../../tools/index.js'

/**
 * @param {Array<{name: string, source: string}>} samples
 * @param {{concurrency?: number, seed?: number, timeoutMs?: number}} [options]
 */
export async function runFarm(samples, options = {}) {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, samples.length || 1))
  const seed = options.seed ?? 0x5eed
  const pool = await Promise.all(
    Array.from({ length: concurrency }, () => TracelessSandbox.create({ seed, logLevel: 'silent', env: { strict: true }, limits: { timeoutMs: options.timeoutMs ?? 2500 } })),
  )
  const results = new Array(samples.length)
  let next = 0
  const workers = pool.map(async (sandbox) => {
    while (true) {
      const index = next
      next += 1
      if (index >= samples.length) return
      const sample = samples[index]
      try {
        const run = await sandbox.run(sample.source, { filename: `https://cdn.example.test/farm/${index}.js` })
        const classification = run.ok ? 'completed' : run.limitsHit.length > 0 ? `limit:${run.limitsHit[0]}` : 'error'
        results[index] = {
          name: sample.name,
          ok: run.ok,
          classification,
          limitsHit: run.limitsHit,
          result: run.result ?? null,
          error: run.error?.message ?? null,
          events: run.traceStats?.total ?? 0,
          virtualMs: run.virtualMs,
          disposal: run.disposal?.ok === true,
        }
      } catch (error) {
        results[index] = { name: sample.name, ok: false, classification: 'threw', error: error.message, disposal: false }
      }
    }
  })
  await Promise.all(workers)
  for (const sandbox of pool) sandbox.dispose()
  return {
    count: results.length,
    completed: results.filter((result) => result.ok).length,
    limited: results.filter((result) => result.classification.startsWith('limit')).length,
    failed: results.filter((result) => !result.ok).length,
    allDisposed: results.every((result) => result.disposal),
    results,
  }
}

async function selfTest() {
  const samples = [
    { name: 'malicious.js', source: 'fetch(atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3Q=")).catch(function(){}); localStorage.setItem("x", "1");' },
    { name: 'benign.js', source: 'var a = 1 + 2; console.log(a);' },
    { name: 'spin.js', source: 'while (true) {}' },
    { name: 'isolation.js', source: 'globalThis.__farmMarker = 1; typeof window;' },
  ]
  const report = await runFarm(samples, { concurrency: 2, timeoutMs: 400 })
  if (report.count !== 4) throw new Error('sample count mismatch')
  if (report.completed < 3) throw new Error(`expected 3 completions, got ${report.completed}`)
  if (report.limited !== 1) throw new Error(`expected 1 timeout, got ${report.limited}`)
  if (!report.allDisposed) throw new Error('disposal failure')
  const isolation = await runFarm([{ name: 'fresh.js', source: 'typeof globalThis.__farmMarker' }], { concurrency: 1 })
  if (isolation.results[0].result?.value !== 'undefined') throw new Error('state leaked between runs')
  console.log(`farm: total=${report.count} completed=${report.completed} limited=${report.limited} disposed=${report.allDisposed}`)
  console.log('SELFTEST OK')
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  if (process.argv.includes('--help') || !process.argv[2]) {
    console.log('Sandbox Farm\n  <file...> [--concurrency 3] [--json]\n  --self-test')
    if (!process.argv[2]) process.exitCode = 2
    return
  }
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  const concurrencyIndex = process.argv.indexOf('--concurrency')
  const concurrency = concurrencyIndex >= 0 ? Number(process.argv[concurrencyIndex + 1]) : 3
  const samples = await Promise.all(files.map(async (file) => ({ name: file, source: await readFile(file, 'utf8') })))
  const report = await runFarm(samples, { concurrency })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const result of report.results) {
    console.log(`${String(result.name).padEnd(40)} ${result.classification.padEnd(14)} events=${result.events} dispo=${result.disposal}`)
  }
  console.log(`completed=${report.completed} limited=${report.limited} failed=${report.failed}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
