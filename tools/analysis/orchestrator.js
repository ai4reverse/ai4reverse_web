import { TracelessSandbox } from '../sandbox/sandbox.js'
import { analyzeSource } from '../instrumentation/ast.js'
import { restore } from '../restore/index.js'
import { extractIOCs, extractFromEvents } from './ioc.js'
import { buildReport, renderMarkdown } from './report.js'
import { summarizeBehavior } from './behavior.js'
import { extractStagedPayloads } from './stage.js'
import { createLogger } from '../logging/logger.js'
import { sha256, shortHash } from '../util/hash.js'
import { analyzeVM, summarizeVM } from '../jsvmp/index.js'

/**
 * Analysis orchestrator: the composed pipeline an analyst actually runs.
 *
 *   normalize -> static analysis -> Babel restoration -> dynamic (traceless)
 *   execution -> stage extraction -> behaviour summary -> report + verdict
 *
 * The dynamic run always executes the ORIGINAL bytes. Restoration is a static
 * transformation used for reading; executing restored code would measure a
 * different program.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {string} [options.sourceUrl]
 * @param {number|string} [options.seed]
 * @param {object} [options.profile]
 * @param {object} [options.limits]
 * @param {object} [options.logger]
 * @param {'silent'|'error'|'warn'|'info'|'debug'|'trace'} [options.logLevel]
 * @param {boolean} [options.dynamic] run the sample (default true)
 * @param {boolean} [options.restore] restore code (default true)
 * @param {boolean} [options.runRestored] also execute restored code for comparison
 * @param {object} [options.instrumentation]
 * @param {object} [options.sandbox] reuse an initialised sandbox
 * @param {Array} [options.hooks]
 * @param {string} [options.entry] entry function to call after evaluation
 * @param {unknown[]} [options.args]
 */
export async function analyzeSample(source, options = {}) {
  const text = String(source ?? '')
  if (text.length === 0) throw new Error('analyzeSample requires a non-empty source string')
  const startedAt = Date.now()
  const seed = options.seed ?? 0x5eed
  const logger = options.logger ?? createLogger({ level: options.logLevel ?? 'silent' })
  const name = options.name ?? 'sample.js'
  const sourceUrl = options.sourceUrl
  const runId = `analysis-${shortHash(`${seed}:${text}`)}`
  const digest = sha256(text)

  // ---- static ------------------------------------------------------------
  const staticAnalysis = analyzeSource(text, { filename: name })
  const facts = staticAnalysis.ok ? staticAnalysis.facts : null

  let restoration = null
  if (options.restore !== false) {
    try {
      restoration = restore(text, {
        filename: name,
        maxRounds: options.maxRounds ?? 2,
        logger,
        generateOptions: options.generateOptions,
        hooks: options.restoreHooks ?? null,
      })
    } catch (error) {
      logger.warn({ err: error.message }, 'restoration pipeline failed; continuing with raw source')
      restoration = { code: text, passes: [], changed: false, error: { message: error.message }, stats: null }
    }
  }

  const iocOptions = options.maxIocBytes ? { maxLength: options.maxIocBytes } : {}
  const staticIocs = extractIOCs(text, iocOptions)
  const restoredIocs =
    restoration?.changed && restoration.code && restoration.code !== text
      ? tagIocs(extractIOCs(restoration.code, iocOptions), 'restored')
      : null

  // ---- dynamic -----------------------------------------------------------
  let run = null
  let runError = null
  let sandbox = options.sandbox ?? null
  const runOptions = {
    sourceUrl,
    filename: options.filename,
    type: options.type,
    level: options.level ?? options.instrumentation?.code?.level,
    entry: options.entry,
    args: options.args,
    // Analysis always needs the full trace for behaviour/verdict. Report
    // retention is decided below from `options.keepTrace` (P0-6).
    keepTrace: true,
    mocks: options.mocks,
    network: options.network,
    settle: options.settle,
  }
  if (options.dynamic !== false) {
    try {
      if (!sandbox) {
        sandbox = await TracelessSandbox.create({
          seed,
          profile: options.profile,
          limits: options.limits,
          logger,
          ioc: { extractIOCs },
          instrumentation: options.instrumentation,
          hooks: options.hooks,
          env: { strict: options.strictEnv ?? false },
        })
      }
      run = await sandbox.run(text, runOptions)
    } catch (error) {
      runError = { name: error.name, message: error.message, code: error.code }
      logger.warn({ err: error.message }, 'dynamic run failed')
    }
  }

  // Sandbox always keeps the full trace for scoring (keepTrace forced true
  // above). Honour the caller's keepTrace for the returned run record only.
  const events = run?.events ?? []
  if (options.keepTrace === false && run) run.events = null
  const dynamicIocs = extractFromEvents(events)
  const mergedIocs = mergeIocs(staticIocs, dynamicIocs, restoredIocs)
  const behavior = summarizeBehavior(events)
  const artifactStore = extractStagedPayloads(events, text, { logger })
  const artifacts = artifactStore.summary()

  // ---- optional second execution of restored code ------------------------
  let restoredRun = null
  if (options.runRestored && restoration?.changed && options.dynamic !== false) {
    // The comparison run must be a *fresh* sandbox with the same environment,
    // network policy and hooks as the original; reusing `options.sandbox`
    // would leak state between the two runs.
    let restoredSandbox = null
    try {
      restoredSandbox = await TracelessSandbox.create({
        seed,
        profile: options.profile,
        limits: options.limits,
        logger,
        ioc: { extractIOCs },
        instrumentation: options.instrumentation,
        hooks: options.hooks,
        env: { strict: options.strictEnv ?? false },
      })
      restoredRun = await restoredSandbox.run(restoration.code, {
        ...runOptions,
        filename: options.filename ?? `${name}.restored.js`,
      })
      if (options.keepTrace === false && restoredRun) restoredRun.events = null
    } catch (error) {
      logger.warn({ err: error.message }, 'restored-code run failed')
      restoredRun = { ok: false, error: { name: error.name, message: error.message } }
    } finally {
      restoredSandbox?.dispose()
    }
  }
  // Dispose the sandbox this function created (never one supplied by caller).
  if (!options.sandbox) sandbox?.dispose()

  // ---- JSVMP summary -----------------------------------------------------
  let vmAnalysis = null
  let vmSummary = null
  try {
    if (run?.vm) {
      vmAnalysis = analyzeVM(text)
      vmSummary = summarizeVM(vmAnalysis)
    } else if (facts?.dispatchSwitches > 0 && options.jsvmpAnalysis !== false) {
      vmAnalysis = analyzeVM(text)
      if (vmAnalysis.detected) vmSummary = summarizeVM(vmAnalysis)
    }
  } catch (error) {
    logger.debug({ err: error.message }, 'jsvmp analysis failed')
  }

  const opcodeEvents = events.filter(
    (event) => event.kind === 'code' && event.event === 'jsvmp:opcode',
  )
  const truncation = summarizeTraceTruncation(run)
  const tracing = {
    enabled: Boolean(run),
    events: run?.traceStats?.total ?? 0,
    dropped: run?.traceStats?.dropped ?? 0,
    truncated: truncation.truncated,
    truncatedBy: truncation.truncatedBy,
    byKind: run?.traceStats?.byKind ?? {},
    jsvmp: {
      detected: Boolean(run?.vm ?? vmAnalysis?.detected),
      opcodes: run?.vm?.opcodes ?? vmAnalysis?.dispatch?.cases?.length ?? 0,
      steps: opcodeEvents.length,
      kind: run?.vm?.kind ?? vmAnalysis?.kind ?? null,
      dispatch: vmSummary?.dispatch ?? null,
      sequence: opcodeEvents.slice(0, 500).map((event) => event.opcode),
    },
  }

  const staticSection = {
    parse: {
      ok: staticAnalysis.ok,
      sourceType: staticAnalysis.sourceType ?? (staticAnalysis.ok ? 'script' : null),
      errors: staticAnalysis.ok ? [] : [{ message: staticAnalysis.error }],
    },
    restoration: {
      passes: restoration?.passes ?? [],
      code: restoration?.code ?? text,
      // A failed pipeline is still evidence: keep the message so the report can
      // say why the static section holds the raw source (audit F8).
      error: restoration?.error ?? null,
      sha256: sha256(restoration?.code ?? text),
      size: Buffer.byteLength(restoration?.code ?? text),
      reducedBy: Math.max(0, Buffer.byteLength(text) - Buffer.byteLength(restoration?.code ?? text)),
      rounds: restoration?.rounds ?? 0,
      stats: restoration?.stats ?? null,
    },
    ast: facts
      ? {
          ...facts,
          strings: facts.stringsTotal,
          networkCalls:
            (facts.fetchCalls ?? 0) + (facts.xhrCalls ?? 0) + (facts.websocketCalls ?? 0),
        }
      : null,
    iocs: mergedIocs,
    techniques: facts?.techniques ?? [],
  }

  const maxRetainedEvents = options.maxRetainedEvents ?? 5000
  const retainEvents = options.keepTrace !== false
  const retainedEvents = retainEvents ? events.slice(0, maxRetainedEvents) : []
  const dynamicSection = {
    ok: Boolean(run?.ok),
    error: run?.error ?? runError ?? null,
    limitsHit: run?.limitsHit ?? [],
    provisional: Boolean(run?.provisional),
    result: run?.result ?? null,
    events: retainedEvents,
    eventsTruncated: (retainEvents && events.length > maxRetainedEvents) || Boolean(run?.provisional),
    counts: { byKind: run?.traceStats?.byKind ?? {}, total: run?.traceStats?.total ?? 0 },
    behavior: {
      apis: behavior.apis,
      network: behavior.network,
      storage: behavior.storage,
      dom: behavior.dom,
      timers: behavior.timers,
      console: behavior.console,
      evalStages: behavior.evalStages,
      killChain: behavior.killChain,
      mocks: behavior.mocks,
      counts: behavior.counts,
    },
    exceptions: behavior.exceptions,
    environment: { profile: run?.profile ?? options.profile ?? null },
    integrity: run?.integrity ?? null,
    disposal: run?.disposal ?? null,
    virtualMs: run?.virtualMs ?? 0,
    durationMs: run?.durationMs ?? 0,
    settle: run?.settle ?? null,
    restored: restoredRun
      ? { ok: restoredRun.ok, error: restoredRun.error ?? null, counts: restoredRun.traceStats ?? null }
      : null,
  }

  const report = buildReport({
    meta: {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      seed,
      profile: run?.profile ?? options.profile ?? null,
      limits: sandbox?.limits ?? options.limits ?? null,
    },
    sample: {
      name,
      size: text.length,
      sha256: digest,
      sourceUrl: sourceUrl ?? null,
      sourceType: staticAnalysis.sourceType ?? 'script',
      truncated: mergedIocs?.meta?.truncated === true || Buffer.byteLength(text) > 5 * 1024 * 1024,
    },
    static: staticSection,
    dynamic: dynamicSection,
    tracing,
    hooks: {
      active: run?.hooks?.describe ?? [],
      fired: run?.hooks?.fired ?? [],
      mocks: behavior.mocks,
      errors: run?.hooks?.errors ?? [],
    },
    artifacts,
    integrity: run?.integrity ?? { intact: false, drift: [{ kind: 'no-dynamic-run', detail: 'dynamic execution disabled or failed' }] },
    recommendations: recommend({ run, runError, facts, behavior, tracing, restoration, mergedIocs, staticAnalysis, traceTruncation: truncation }),
  })

  // Expose the detailed behaviour sections without changing the stable schema:
  // kill-chain inference and per-category counts are additive extensions.
  if (report.dynamic) {
    report.dynamic.restored = restoredRun
      ? {
          ok: restoredRun.ok,
          error: restoredRun.error ?? null,
          counts: restoredRun.traceStats ?? null,
          result: restoredRun.result ?? null,
        }
      : null
  }
  if (report.dynamic?.behavior) {
    report.dynamic.behavior.killChain = behavior.killChain
    report.dynamic.behavior.counts = behavior.counts
    report.dynamic.behavior.evalStages = behavior.evalStages
    report.dynamic.behavior.console = behavior.console
    report.dynamic.behavior.mocks = behavior.mocks
  }

  const markdown = renderMarkdown(report)
  return {
    report,
    markdown,
    run,
    restoredRun,
    restoration,
    artifacts,
    artifactStore,
    behavior,
    facts,
    iocs: mergedIocs,
    jsvmp: vmSummary,
    vmAnalysis,
    traceTruncation: truncation,
  }
}

/**
 * Whether the trace is complete, derived from the run record rather than from
 * the retained event window.
 *
 * Two independent budgets cut observations. The code instrumenter stops
 * emitting after its own `maxEvents` code steps and emits a
 * `code:trace-truncated` marker once; later events can push that marker out of
 * the retained window. The recorder drops the oldest retained events once
 * `limits.maxEvents` is reached and counts them in `traceStats.dropped`.
 *
 * Both facts live on the run record and are pure functions of the sample, the
 * seed and the limits, so the report can state truncation (and its cause) even
 * when no marker survives. Hard-stopping at 20 003 observations while the read
 * window shows `dropped: 80` therefore no longer looks like a complete trace.
 *
 * @param {object|null} [run] sandbox run record
 * @returns {{truncated: boolean, truncatedBy: string[], dropped: number, markerRetained: boolean}}
 */
export function summarizeTraceTruncation(run) {
  const events = Array.isArray(run?.events) ? run.events : []
  const markerRetained = events.some((event) => event?.kind === 'code' && event?.event === 'trace-truncated')
  const codeBudget = run?.instrumentation?.describe?.code?.truncated === true || markerRetained
  const dropped = Number.isFinite(run?.traceStats?.dropped) ? run.traceStats.dropped : 0
  const truncatedBy = []
  if (codeBudget) truncatedBy.push('code-budget')
  if (dropped > 0) truncatedBy.push('event-limit')
  return { truncated: truncatedBy.length > 0, truncatedBy, dropped, markerRetained }
}

/**
 * Merge IOC sets (original source, restored source, dynamic trace), deduping by
 * value and keeping provenance. `sources` is only emitted when a value was seen
 * by more than one source, so the schema stays stable for ordinary entries.
 * @param {object} staticIocs
 * @param {object} dynamicIocs
 * @param {object|null} [restoredIocs]
 */
export function mergeIocs(staticIocs = {}, dynamicIocs = {}, restoredIocs = null) {
  const merged = {}
  const sets = [staticIocs, dynamicIocs, restoredIocs].filter(Boolean)
  const keys = new Set(sets.flatMap((set) => Object.keys(set ?? {})))
  for (const key of keys) {
    if (key === 'meta') continue
    const byValue = new Map()
    for (const set of sets) {
      const list = Array.isArray(set?.[key]) ? set[key] : []
      for (const entry of list) {
        const value = typeof entry === 'string' ? entry : entry?.value
        if (!value) continue
        const existing = byValue.get(value)
        const source = entry?.source
        if (existing) {
          existing.count = (existing.count ?? 1) + (entry.count ?? 1)
          if (source && !existing.sources.includes(source)) existing.sources.push(source)
        } else {
          byValue.set(value, {
            ...(typeof entry === 'object' ? entry : { value }),
            value,
            count: entry?.count ?? 1,
            sources: source ? [source] : [],
          })
        }
      }
    }
    merged[key] = [...byValue.values()].map((entry) => {
      const { sources, ...rest } = entry
      return sources.length > 1 ? { ...rest, sources } : rest
    })
  }
  merged.meta = {
    truncated: sets.some((set) => set?.meta?.truncated === true),
  }
  return merged
}

/**
 * Tag every IOC entry in a set with a provenance source (e.g. 'restored').
 * @param {object} iocs
 * @param {string} source
 */
function tagIocs(iocs, source) {
  const tagged = {}
  for (const [key, value] of Object.entries(iocs ?? {})) {
    if (key === 'meta' || !Array.isArray(value)) {
      tagged[key] = value
      continue
    }
    tagged[key] = value.map((entry) =>
      typeof entry === 'string' ? { value: entry, source } : { ...entry, source },
    )
  }
  return tagged
}

/**
 * Turn observations into analyst actions.
 * @param {object} context
 */
export function recommend(context) {
  const { run, runError, facts, behavior, tracing, restoration, mergedIocs, staticAnalysis } = context
  const out = []

  if (!staticAnalysis?.ok) out.push('Source did not parse as a valid JavaScript program; treat as truncated or encrypted container.')
  if (runError) out.push(`Dynamic execution failed (${runError.message}); inspect the sandbox error before concluding the sample is inert.`)
  // Host-wall interruptions are provisional (P0-12): do not recommend as if the
  // sample hit a guest-derived limit or anti-analysis spin.
  if (run?.limitsHit?.length && !run?.provisional) {
    out.push(`Execution hit limits (${run.limitsHit.join(', ')}); raise limits or single-step the sample to observe later stages.`)
  }
  if (run?.ok === false && run?.error?.name === 'InternalError' && !run?.provisional) {
    out.push('Runtime interruption usually indicates an anti-analysis spin loop; review the statement trace tail for the loop site.')
  }
  if (restoration?.error) {
    out.push(`Restoration failed (${restoration.error.message ?? restoration.error}); the static section contains the raw source, so read the original bytes.`)
  }
  if (context.traceTruncation?.truncated) {
    out.push(`Trace truncated (${context.traceTruncation.truncatedBy.join(', ')}); later behaviour may be unobserved.`)
  }
  if (tracing?.jsvmp?.detected) {
    out.push(`JSVMP detected (${tracing.jsvmp.opcodes} opcodes, ${tracing.jsvmp.steps} traced steps); review the devirtualised opcode sequence and handler bodies.`)
  }
  if (facts?.evalLike > 0) out.push('Dynamic code evaluation present; inspect extracted eval payloads (artifacts) for stage 2.')
  if ((mergedIocs?.urls ?? []).length > 0) out.push('Extracted URLs should be enriched against threat-intelligence sources before active contact.')
  if ((mergedIocs?.telegram ?? []).length > 0 || (mergedIocs?.discordWebhooks ?? []).length > 0) {
    out.push('Messenger/webhook C2 detected; capture bot ids and webhook paths as high-value IOCs.')
  }
  if ((mergedIocs?.wallets ?? []).length > 0) out.push('Cryptocurrency addresses found; pivot on chain for infrastructure and victim clustering.')
  if (behavior?.exceptions?.uncaught?.length) out.push('Uncaught exceptions observed; the sample may require a specific browser profile or additional globals.')
  if (restoration?.changed) out.push(`Restoration changed ${restoration.passes.filter((pass) => pass.changed).length} passes; read the restored code rather than the original.`)
  if (run && run.integrity && run.integrity.intact === false && run.integrity.intrinsicDrift?.length) {
    out.push('Sample modified intrinsics/prototypes; review integrity drift for hooking and anti-analysis behaviour.')
  }
  if (out.length === 0) out.push('No high-signal behaviour observed; consider a longer virtual-time budget or a different profile.')
  return out
}
