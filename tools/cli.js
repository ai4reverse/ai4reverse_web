#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createLogger } from './logging/logger.js'
import { analyzeSample } from './analysis/orchestrator.js'
import { restore, listPasses } from './restore/index.js'
import { TracelessSandbox } from './sandbox/sandbox.js'

/**
 * CLI entry point. `stdout` carries results only; all diagnostics go through
 * pino on stderr, so the tool is pipeline-safe:
 *
 *   ai4reverse analyze sample.js --json | jq '.verdict'
 *   ai4reverse restore sample.js --out restored.js
 *   ai4reverse run sample.js --events | head
 */

const USAGE = `ai4reverse — traceless malicious JavaScript analysis

Usage:
  ai4reverse analyze <file> [options]     static + dynamic analysis with report
  ai4reverse restore <file> [options]     restored (deobfuscated) source
  ai4reverse run <file> [options]         single dynamic run, trace summary
  ai4reverse passes [--json]              list restoration passes
  ai4reverse version

Options (analyze/run):
  --json                 emit machine-readable JSON on stdout
  --out <path>           write result to a file ("-" for stdout)
  --seed <value>         profile/PRNG seed (default 0x5eed)
  --timeout <ms>         host wall-clock limit per run (default 5000)
  --virtual-ms <ms>      virtual time budget (default 60000)
  --level <level>        instrumentation level: off|function|branch|statement
  --no-dynamic           static analysis only
  --no-restore           skip the Babel restoration pipeline
  --run-restored         also execute restored code for comparison
  --source-url <url>     original script URL (used for stack fidelity + IOCs)
  --entry <name>         call a global function after evaluation
  --arg <json>           JSON argument for --entry (repeatable)
  --profile <json>       profile overrides, e.g. '{"os":"macos","locale":"en-US"}'
  --mocks <json>         API mocks: [{"api":"fetch","response":{"ok":false}}]
  --log-level <level>    pino level (default warn)
  --pretty               pretty-print logs

Options (restore):
  --passes <ids>         comma-separated pass ids (default: all)
  --exclude <ids>        comma-separated pass ids to skip
  --rounds <n>           pipeline rounds (default 2)
`

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      seed: { type: 'string' },
      timeout: { type: 'string' },
      'virtual-ms': { type: 'string' },
      level: { type: 'string' },
      'no-dynamic': { type: 'boolean', default: false },
      'no-restore': { type: 'boolean', default: false },
      'run-restored': { type: 'boolean', default: false },
      'source-url': { type: 'string' },
      entry: { type: 'string' },
      arg: { type: 'string', multiple: true, default: [] },
      profile: { type: 'string' },
      mocks: { type: 'string' },
      'log-level': { type: 'string', default: 'warn' },
      pretty: { type: 'boolean', default: false },
      passes: { type: 'string' },
      exclude: { type: 'string' },
      rounds: { type: 'string' },
      events: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  return { values, positionals }
}

async function readSource(path) {
  if (!path) throw new UsageError('missing input file')
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${error.code ?? error.message}`)
  }
}

/** Parse a CLI JSON option, converting failures into usage errors. */
function parseJsonOption(name, text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`invalid JSON for --${name}: ${error.message}`)
  }
}

/** Validate an optional numeric CLI option. */
function numericOption(name, text) {
  if (text === undefined) return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${name} must be a positive number`)
  return value
}

class UsageError extends Error {}

async function emitResult(text, options) {
  if (options.out && options.out !== '-') {
    await writeFile(options.out, text)
    process.stderr.write(`wrote ${Buffer.byteLength(text)} bytes to ${options.out}\n`)
    return
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

/** @param {string[]} argv */
export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseCli(argv)
  } catch (error) {
    throw new UsageError(`invalid arguments: ${error.message}`)
  }
  const { values, positionals } = parsed
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE)
    return 0
  }
  const command = positionals[0]
  const file = positionals[1]
  // Results go to stdout; every diagnostic belongs on stderr so
  // `ai4reverse analyze --json | jq` stays parseable.
  const logger = createLogger({ level: values['log-level'], pretty: values.pretty, destination: 2 })

  if (command === 'version') {
    process.stdout.write('ai4reverse 1.0.0\n')
    return 0
  }

  if (command === 'passes') {
    const passes = listPasses()
    if (values.json) {
      process.stdout.write(`${JSON.stringify(passes, null, 2)}\n`)
    } else {
      for (const pass of passes) {
        process.stdout.write(`${String(pass.order).padStart(3)}  ${pass.id.padEnd(16)} ${pass.description ?? ''}\n`)
      }
    }
    return 0
  }

  if (values.events && values.json && command === 'run') {
    throw new UsageError('--events and --json are mutually exclusive')
  }

  if (command === 'restore') {
    const source = await readSource(file)
    const selection = {
      only: values.passes ? String(values.passes).split(',').map((item) => item.trim()).filter(Boolean) : null,
      exclude: values.exclude ? String(values.exclude).split(',').map((item) => item.trim()).filter(Boolean) : [],
    }
    const result = restore(source, {
      ...selection,
      maxRounds: values.rounds ? Number(values.rounds) : 2,
      filename: file,
      logger,
    })
    if (values.json) {
      await emitResult(JSON.stringify(result, null, 2), values)
    } else {
      await emitResult(result.code, values)
      if (!values.out) {
        const changed = result.passes.filter((pass) => pass.changed).map((pass) => pass.id)
        logger.info({ changed, stats: result.stats }, 'restoration complete')
      }
    }
    return 0
  }

  if (command === 'run') {
    const source = await readSource(file)
    const sandbox = await TracelessSandbox.create({
      seed: values.seed ?? 0x5eed,
      limits: buildLimits(values),
      logger,
      env: { strict: false },
    })
    try {
      const run = await sandbox.run(source, {
        sourceUrl: values['source-url'],
        filename: file,
        level: values.level,
        entry: values.entry,
        args: (values.arg ?? []).map(parseJsonArg),
      })
      if (values.events) {
        const lines = (run.events ?? []).map((event) => JSON.stringify(event)).join('\n')
        await emitResult(lines, values)
        return run.ok ? 0 : 1
      }
      const summary = {
        ok: run.ok,
        result: run.result,
        error: run.error,
        limitsHit: run.limitsHit,
        filename: run.filename,
        virtualMs: run.virtualMs,
        trace: run.traceStats,
        integrity: run.integrity,
        instrumentation: run.instrumentation?.stats,
        vm: run.vm ? { detected: true, opcodes: run.vm.opcodes, cases: run.vm.cases } : { detected: false },
        disposal: run.disposal,
      }
      await emitResult(`${JSON.stringify(summary, null, 2)}\n`, values)
      return run.ok ? 0 : 1
    } finally {
      sandbox.dispose()
    }
  }

  if (command === 'analyze') {
    const source = await readSource(file)
    if (source.trim().length === 0) throw new UsageError(`${file} is empty`)
    logger.info({ file, bytes: source.length }, 'analysis starting')
    const result = await analyzeSample(source, {
      name: file,
      sourceUrl: values['source-url'],
      seed: values.seed ?? 0x5eed,
      logger,
      limits: buildLimits(values),
      dynamic: !values['no-dynamic'],
      restore: !values['no-restore'],
      runRestored: values['run-restored'],
      level: values.level,
      entry: values.entry,
      args: (values.arg ?? []).map(parseJsonArg),
      profile: values.profile ? parseJsonOption('profile', values.profile) : undefined,
      mocks: values.mocks ? parseJsonOption('mocks', values.mocks) : undefined,
      instrumentation: values.level ? { code: { level: values.level } } : undefined,
    })
    const output = values.json ? `${JSON.stringify(result.report, null, 2)}\n` : result.markdown
    await emitResult(output, values)
    logger.info(
      {
        verdict: result.report.verdict.level,
        score: result.report.verdict.score,
        iocs: Object.fromEntries(
          Object.entries(result.report.static.iocs ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
        ),
      },
      'analysis complete',
    )
    return 0
  }

  throw new UsageError(`unknown command: ${command}`)
}

function buildLimits(values) {
  const limits = {}
  const timeoutMs = numericOption('timeout', values.timeout)
  const maxVirtualMs = numericOption('virtual-ms', values['virtual-ms'])
  if (timeoutMs !== undefined) limits.timeoutMs = timeoutMs
  if (maxVirtualMs !== undefined) limits.maxVirtualMs = maxVirtualMs
  return limits
}

function parseJsonArg(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    // npm/pnpm install `bin` as a symlink named `ai4reverse`; compare against the
    // resolved real path so the installed command actually runs.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return entry.endsWith('cli.js')
  }
}
if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0
    },
    (error) => {
      if (error instanceof UsageError) {
        process.stderr.write(`error: ${error.message}\n\n${USAGE}`)
        process.exitCode = 2
      } else {
        process.stderr.write(`error: ${error?.stack ?? error}\n`)
        process.exitCode = 1
      }
    },
  )
}
