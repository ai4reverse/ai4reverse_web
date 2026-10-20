#!/usr/bin/env node
/**
 * CLI entry point. `stdout` carries results only; all diagnostics go through
 * pino on stderr, so the tool is pipeline-safe:
 *
 *   ai4reverse analyze sample.js --json | jq '.verdict'
 *   ai4reverse restore sample.js --out restored.js
 *   ai4reverse run sample.js --events | head
 */

import { readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createLogger } from './logging/logger.js'
import { analyzeSample } from './analysis/orchestrator.js'
import { restore, listPasses } from './restore/index.js'
import { TracelessSandbox } from './sandbox/sandbox.js'

const USAGE = `ai4reverse — traceless malicious JavaScript analysis

Usage:
  ai4reverse analyze <file> [options]     static + dynamic analysis with report
  ai4reverse restore <file> [options]     restored (deobfuscated) source
  ai4reverse run <file> [options]         single dynamic run, trace summary
  ai4reverse passes [--json]              list restoration passes
  ai4reverse version
  ai4reverse --help

Options (analyze/run):
  --json                 emit machine-readable JSON on stdout
  --out <path>           write result to a file ("-" for stdout)
  --seed <value>         profile/PRNG seed, decimal or 0x-prefixed hex
                         (default 0x5eed)
  --timeout <ms>         host wall-clock limit per run (default 5000)
  --virtual-ms <ms>      virtual time budget (default 60000)
  --level <level>        instrumentation level: off|function|branch|statement
  --no-dynamic           static analysis only
  --no-restore           skip the Babel restoration pipeline
  --run-restored         also execute restored code for comparison
  --source-url <url>     original script URL (used for stack fidelity + IOCs)
  --entry <name>         call a global function after evaluation
  --arg <value>          argument for --entry (repeatable). Parsed as JSON when
                         it is valid JSON, otherwise passed as a string, so
                         --arg 42 is a number and --arg hello is "hello"
  --profile <json>       profile overrides, e.g. '{"os":"macos","locale":"en-US"}'
  --mocks <json>         API mocks: [{"api":"fetch","response":{"ok":false}}]
  --log-level <level>    pino level (default warn)
  --pretty               pretty-print logs

Options (restore):
  --passes <ids>         comma-separated pass ids (default: all)
  --exclude <ids>        comma-separated pass ids to skip
  --rounds <n>           pipeline rounds, integer 1-5 (default 2)

Option values are validated: an unknown option, an unknown pass id, a bad
--level or a malformed number is a usage error (exit 2) with the message on
stderr and nothing on stdout.

Exit codes:
  0  success
  1  analysis/run failed, or an unexpected error
  2  usage error (bad arguments, unreadable input, unwritable --out)
`

/** Options that are validated against a closed set at parse time. */
const LEVELS = ['off', 'function', 'branch', 'statement']
/** `restore` pipeline rounds: more than five never reaches a new fixed point. */
const MAX_ROUNDS = 5

function passIds() {
  return listPasses().map((pass) => pass.id)
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    // Strict parsing: an unknown option is a typo, and a silently ignored typo
    // changes what evidence is produced. Fail instead of guessing.
    strict: true,
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
      help: { type: 'boolean', short: 'h', default: false },
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

/**
 * Validate `--seed`. Only decimal and 0x-prefixed hex integers are accepted.
 * Parsed to a number so `--seed 0x5eed` matches the numeric default `0x5eed`
 * (ACCEPTANCE H12: a string seed was hashed differently by `hashSeed`).
 *
 * @param {string|undefined} text
 * @returns {number|undefined}
 */
function seedOption(text) {
  if (text === undefined) return undefined
  const raw = String(text).trim()
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
    throw new UsageError(`--seed must be a decimal or 0x-prefixed hex integer, got ${JSON.stringify(text)}`)
  }
  return Number(raw)
}

/**
 * Validate `--rounds` as an integer in `[1, MAX_ROUNDS]`. A non-numeric value
 * used to become `NaN` and silently skip the pipeline.
 *
 * @param {string|undefined} text
 * @returns {number|undefined}
 */
function roundsOption(text) {
  if (text === undefined) return undefined
  const raw = String(text).trim()
  const rounds = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new UsageError(`--rounds must be an integer between 1 and ${MAX_ROUNDS}, got ${JSON.stringify(text)}`)
  }
  return rounds
}

/**
 * Validate `--level` against the instrumentation levels the guest supports.
 * Unknown levels previously fell back to `statement` without a warning.
 *
 * @param {string|undefined} text
 * @returns {string|undefined}
 */
function levelOption(text) {
  if (text === undefined) return undefined
  const level = String(text)
  if (!LEVELS.includes(level)) {
    throw new UsageError(`--level must be one of ${LEVELS.join('|')}, got ${JSON.stringify(text)}`)
  }
  return level
}

/**
 * Validate a comma-separated pass id list against the pass registry, so an
 * unknown id fails instead of producing an unmodified "restored" file.
 *
 * @param {string} name - option name, for the message
 * @param {string|undefined} text
 * @returns {string[]|null} `null` when the option was not supplied
 */
function passListOption(name, text) {
  if (text === undefined) return null
  const ids = String(text).split(',').map((item) => item.trim()).filter(Boolean)
  if (ids.length === 0) return null
  const valid = passIds()
  const unknown = ids.filter((id) => !valid.includes(id))
  if (unknown.length > 0) {
    throw new UsageError(`unknown pass id for --${name}: ${unknown.join(', ')} (valid: ${valid.join(', ')})`)
  }
  return ids
}

class UsageError extends Error { }

async function emitResult(text, options) {
  if (options.out && options.out !== '-') {
    try {
      await writeFile(options.out, text)
    } catch (error) {
      // An unwritable --out would otherwise surface as a stack trace and exit 1
      // with the analysis already done; report it as the usage error it is.
      throw new UsageError(`cannot write ${options.out}: ${error.code ?? error.message}`)
    }
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
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (positionals.length === 0) {
    // No command is a usage error (ACCEPTANCE H12): print help and exit 2 so
    // batch wrappers do not treat an empty invocation as success.
    process.stdout.write(USAGE)
    return 2
  }
  const command = positionals[0]
  const file = positionals[1]
  if (values.events && command !== 'run') {
    throw new UsageError('--events is only valid with the run command')
  }
  // Validate every closed-set option before a file is read or analysis starts.
  // A typo must never produce a result: batch pipelines treat a silent default
  // as evidence.
  const settings = {
    seed: seedOption(values.seed),
    rounds: roundsOption(values.rounds),
    level: levelOption(values.level),
    passes: passListOption('passes', values.passes),
    exclude: passListOption('exclude', values.exclude),
    profile: values.profile !== undefined ? parseJsonOption('profile', values.profile) : undefined,
    mocks: values.mocks !== undefined ? parseJsonOption('mocks', values.mocks) : undefined,
    // Malformed numbers are usage errors too, and they are checked before any
    // file is read rather than when the limit object is finally built.
    limits: buildLimits(values),
  }
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
      only: settings.passes,
      exclude: settings.exclude ?? [],
    }
    const result = restore(source, {
      ...selection,
      maxRounds: settings.rounds ?? 2,
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
      seed: settings.seed ?? 0x5eed,
      limits: settings.limits,
      profile: settings.profile,
      logger,
      env: { strict: false },
    })
    try {
      const run = await sandbox.run(source, {
        sourceUrl: values['source-url'],
        filename: file,
        level: settings.level,
        entry: values.entry,
        args: (values.arg ?? []).map(parseJsonArg),
        mocks: settings.mocks,
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
        settle: settleSummary(run.settle),
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
      seed: settings.seed ?? 0x5eed,
      logger,
      limits: settings.limits,
      dynamic: !values['no-dynamic'],
      restore: !values['no-restore'],
      runRestored: values['run-restored'],
      level: settings.level,
      entry: values.entry,
      args: (values.arg ?? []).map(parseJsonArg),
      profile: settings.profile,
      mocks: settings.mocks,
      instrumentation: settings.level ? { code: { level: settings.level } } : undefined,
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
    // Guest throw / failed dynamic run is a non-zero exit, matching `run`
    // (ACCEPTANCE H12). `--no-dynamic` leaves `report.dynamic.ok` false with
    // no `run`, so only an actual sandbox run decides the exit code.
    if (result.run && result.run.ok === false) return 1
    return 0
  }

  throw new UsageError(`unknown command: ${command}`)
}

/**
 * Project the event-loop settle record onto the `run` summary.
 *
 * `settle` is the only place a stack breach inside a timer or promise callback
 * is attributed: the entry script itself succeeded, so `ok`/`error` stay clean
 * while `limitsHit` gains `'stack'` and the runtime is abandoned
 * (`disposal.skipped`). Dropping it from the summary left the analyst with an
 * unexplained limit hit and a failed teardown.
 *
 * `null` when the run never reached the event loop (init failure, interrupted
 * runtime), matching how `vm` reports "not observed" instead of omitting the
 * key: a consumer must not have to distinguish absent from empty.
 * Optional keys are left as `undefined` so `JSON.stringify` omits them, which
 * keeps `skipped`/`reason` present only when they mean something.
 *
 * @param {object|null|undefined} settle settle record from `run.settle`
 * @returns {object|null} JSON-safe summary, or `null`
 */
function settleSummary(settle) {
  if (!settle) return null
  return {
    virtualMs: settle.virtualMs,
    pendingTimers: settle.pendingTimers,
    jobs: settle.jobs,
    skipped: settle.skipped,
    reason: settle.reason,
    limitsHit: settle.limitsHit,
    error: settle.error ?? null,
  }
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
