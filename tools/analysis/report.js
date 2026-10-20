/**
 * Report assembly and rendering.
 *
 * `buildReport()` is the single place that turns a raw analysis bundle into the
 * stable, JSON-serialisable shape documented in docs/REPORT-SCHEMA.md. It is
 * intentionally forgiving: a partial or empty bundle still yields every
 * top-level key, so downstream consumers never have to branch on missing data.
 *
 * `scoreVerdict()` owns the transparent heuristics. Every point in the score is
 * traceable to a `reason`; there are no hidden multipliers or random terms, and
 * adding evidence can never lower the score. `renderMarkdown()` mirrors the
 * same tolerance so a report can always be shared as human-readable text.
 */

import { createRequire } from 'node:module'
import { extractIOCs } from './ioc.js'
import { isPlatformEvent } from './behavior.js'

const require = createRequire(import.meta.url)

/** Tool version mirrored from package.json so reports identify their producer. */
export const TOOL_VERSION = (() => {
  try {
    return require('../../package.json').version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Every heuristic weight in one table. The verdict is a weighted sum of the
 * reasons derived from these values, clamped to 0..100.
 */
export const VERDICT_WEIGHTS = Object.freeze({
  staticEvalLikeBase: 5,
  staticEvalLikeStep: 2,
  staticEvalLikeMax: 15,
  staticObfuscationThreshold: 30,
  staticObfuscationDivisor: 5,
  staticObfuscationMax: 20,
  staticNetworkBase: 4,
  staticNetworkStep: 1,
  staticNetworkMax: 10,
  staticRestorationPerPass: 4,
  staticRestorationMax: 12,
  staticTimers: 3,
  iocUrlsBase: 4,
  iocUrlsStep: 2,
  iocUrlsMax: 12,
  iocSuspiciousTldPerDomain: 6,
  iocSuspiciousTldMax: 12,
  iocEncodedPayload: 6,
  iocHashes: 5,
  iocWalletsBase: 8,
  iocWalletsStep: 2,
  iocWalletsMax: 15,
  iocMessengerBase: 8,
  iocMessengerStep: 2,
  iocMessengerMax: 14,
  iocExecution: 10,
  iocMutex: 3,
  dynamicNetworkBase: 6,
  dynamicNetworkStep: 1,
  dynamicNetworkMax: 15,
  dynamicStorage: 4,
  dynamicDomBase: 4,
  dynamicDomStep: 1,
  dynamicDomMax: 10,
  dynamicEvalBase: 4,
  dynamicEvalStep: 1,
  dynamicEvalMax: 10,
  dynamicApiMisuse: 8,
  dynamicLimits: 10,
  dynamicUncaught: 2,
  dynamicEnvTamper: 8,
  dynamicWorkerOffload: 5,
  dynamicOfflinePersistence: 4,
  dynamicMessengerC2: 6,
  dynamicInputCapture: 4,
  tracingJsvmp: 12,
  hooksMocks: 6,
})

const DANGEROUS_APIS = new Set([
  'eval',
  'Function',
  'document.write',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'WebSocket',
  'XMLHttpRequest',
  'sendBeacon',
  'execCommand',
])

/**
 * Integrity drift kinds that constitute concrete evidence of guest tampering.
 * `no-dynamic-run` is the orchestrator's synthetic marker for "no run
 * happened" and `unavailable` means the snapshot itself was missing — neither
 * is the sample's doing, so neither may raise a behavioural reason.
 */
const ENV_TAMPER_KINDS = new Set([
  'global-added',
  'global-removed',
  'symbol-added',
  'symbol-removed',
  'prototype-added',
  'prototype-removed',
  'constructor-added',
  'constructor-removed',
  'native-changed',
  'value-changed',
])

/** Keyboard event types whose capture indicates keystroke logging (T1056). */
const INPUT_CAPTURE_EVENTS = new Set(['keydown', 'keyup', 'keypress'])

const IOC_KEYS = Object.freeze([
  'urls',
  'domains',
  'ips',
  'emails',
  'hashes',
  'wallets',
  'base64',
  'telegram',
  'discordWebhooks',
  'crypto',
  'shellCommands',
  'registryKeys',
  'filePaths',
  'mutexes',
  'other',
])

const PROFILE_STRING_KEYS = Object.freeze(['browser', 'platform', 'userAgent', 'timezone', 'locale'])
const SCREEN_KEYS = Object.freeze(['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelRatio'])

const LEVEL_BENIGN_MAX = 24
const LEVEL_SUSPICIOUS_MAX = 59

/** Hook failures are evidence, but a report never carries an unbounded list. */
const MAX_REPORTED_HOOK_ERRORS = 50

/** Truncation causes the report understands; anything else is dropped. */
const TRACE_TRUNCATION_REASONS = Object.freeze(['code-budget', 'event-limit'])

const TRACE_TRUNCATION_LABELS = Object.freeze({
  'code-budget': 'code-step budget reached',
  'event-limit': 'retention limit reached',
})

/**
 * Build the canonical report object.
 *
 * @param {object} [analysis] raw analysis bundle; every field is optional
 * @returns {object} report matching docs/REPORT-SCHEMA.md
 */
export function buildReport(analysis) {
  const input = obj(analysis)
  const inputMeta = obj(input.meta)
  const profile = normalizeProfile(inputMeta.profile ?? input.profile)

  const staticInput = obj(input.static)
  const restorationInput = obj(staticInput.restoration)
  const sourceCode = str(restorationInput.code) || str(input.code)
  const iocs = normalizeIocs(staticInput.iocs ?? input.iocs, sourceCode)

  const staticSection = {
    parse: normalizeParse(staticInput.parse ?? input.parse),
    restoration: normalizeRestoration(restorationInput, sourceCode),
    ast: normalizeAst(staticInput.ast ?? input.ast),
    iocs,
    techniques: asArray(staticInput.techniques),
  }

  const dynamicInput = obj(input.dynamic)
  const dynamicSection = normalizeDynamic(dynamicInput, profile)

  const tracing = normalizeTracing(input.tracing ?? dynamicInput.tracing)
  const hooks = normalizeHooks(input.hooks ?? dynamicInput.hooks)

  const verdict = scoreVerdict({
    staticSection,
    dynamicSection,
    iocs,
    tracing,
    hooks,
    integrity: input.integrity,
  })

  return {
    meta: {
      tool: 'ai4reverse',
      version: TOOL_VERSION,
      runId: str(inputMeta.runId ?? input.runId),
      startedAt: str(inputMeta.startedAt ?? input.startedAt),
      durationMs: num(inputMeta.durationMs ?? input.durationMs),
      seed: inputMeta.seed ?? input.seed ?? null,
      profile,
      limits: obj(inputMeta.limits ?? input.limits),
    },
    sample: normalizeSample(input.sample),
    verdict,
    static: staticSection,
    dynamic: dynamicSection,
    tracing,
    hooks,
    artifacts: asArray(input.artifacts).map(normalizeArtifact),
    recommendations: asArray(input.recommendations),
    integrity: {
      intact: obj(input.integrity).intact === true,
      drift: obj(input.integrity).drift ?? [],
    },
  }
}

/**
 * Transparent weighted verdict.
 *
 * The score is the sum of every matched reason, clamped to 0..100:
 * 0-24 benign, 25-59 suspicious, >=60 malicious. Confidence grows with the
 * number of independent signal families that contributed.
 *
 * @param {object} [input]
 * @param {object} [input.staticSection]
 * @param {object} [input.dynamicSection]
 * @param {object} [input.iocs]
 * @param {object} [input.tracing]
 * @param {object} [input.hooks]
 * @param {object} [input.integrity] sandbox integrity result; `drift` entries with
 *   concrete evidence kinds raise `DYNAMIC_ENV_TAMPER`
 * @returns {{score: number, level: 'benign'|'suspicious'|'malicious', confidence: number, families: string[], reasons: {code: string, weight: number, detail: string}[]}}
 */
export function scoreVerdict(input) {
  const options = obj(input)
  const staticSection = obj(options.staticSection ?? options.static)
  const dynamicSection = obj(options.dynamicSection ?? options.dynamic)
  const iocs = obj(options.iocs ?? staticSection.iocs)
  const tracing = obj(options.tracing ?? dynamicSection.tracing)
  const hooks = obj(options.hooks ?? dynamicSection.hooks)
  const integrity = obj(options.integrity)
  const weights = VERDICT_WEIGHTS

  /** @type {{code: string, weight: number, detail: string}[]} */
  const reasons = []
  const families = new Set()

  /**
   * @param {string} code
   * @param {number} weight
   * @param {string} detail
   * @param {string} family
   */
  const add = (code, weight, detail, family) => {
    const bounded = Math.max(0, Math.round(weight))
    if (bounded === 0) return
    reasons.push({ code, weight: bounded, detail })
    families.add(family)
  }

  // --- Static indicators ---------------------------------------------------
  const ast = obj(staticSection.ast)
  const evalLike = toCount(ast.evalLike)
  if (evalLike > 0) {
    add(
      'STATIC_EVAL_LIKE',
      Math.min(weights.staticEvalLikeMax, weights.staticEvalLikeBase + evalLike * weights.staticEvalLikeStep),
      `${evalLike} eval-like call(s)`,
      'obfuscation',
    )
  }

  const obfuscationScore = toCount(obj(ast.obfuscation).score)
  if (obfuscationScore >= weights.staticObfuscationThreshold) {
    add(
      'STATIC_OBFUSCATION',
      Math.min(weights.staticObfuscationMax, Math.round(obfuscationScore / weights.staticObfuscationDivisor)),
      `obfuscation score ${obfuscationScore}/100`,
      'obfuscation',
    )
  }

  const networkCalls = toCount(ast.networkCalls)
  if (networkCalls > 0) {
    add(
      'STATIC_NETWORK',
      Math.min(weights.staticNetworkMax, weights.staticNetworkBase + networkCalls * weights.staticNetworkStep),
      `${networkCalls} network call(s) in source`,
      'network',
    )
  }

  const changedPasses = asArray(obj(staticSection.restoration).passes).filter((pass) => obj(pass).changed === true).length
  if (changedPasses > 0) {
    add(
      'STATIC_RESTORATION',
      Math.min(weights.staticRestorationMax, changedPasses * weights.staticRestorationPerPass),
      `${changedPasses} restoration pass(es) changed the code`,
      'obfuscation',
    )
  }

  const timers = toCount(ast.timers)
  if (timers > 0) {
    add('STATIC_TIMERS', weights.staticTimers, `${timers} timer call(s)`, 'evasion')
  }

  // --- Extracted indicators ------------------------------------------------
  const urls = asArray(iocs.urls)
  const nonBenignUrls = urls.filter((url) => !obj(url).benignHost)
  if (nonBenignUrls.length > 0) {
    add(
      'IOC_URLS',
      Math.min(weights.iocUrlsMax, weights.iocUrlsBase + nonBenignUrls.length * weights.iocUrlsStep),
      `${nonBenignUrls.length} non-benign URL(s)`,
      'c2',
    )
  }

  const suspiciousDomains = asArray(iocs.domains).filter((domain) => obj(domain).suspiciousTld === true)
  if (suspiciousDomains.length > 0) {
    add(
      'IOC_SUSPICIOUS_TLDS',
      Math.min(weights.iocSuspiciousTldMax, suspiciousDomains.length * weights.iocSuspiciousTldPerDomain),
      `${suspiciousDomains.length} domain(s) on suspicious TLDs`,
      'c2',
    )
  }

  const encodedPayloads = asArray(iocs.base64).filter((item) => {
    const kind = obj(item).decodedKind
    return kind === 'url' || kind === 'script'
  })
  if (encodedPayloads.length > 0) {
    add('IOC_ENCODED_PAYLOAD', weights.iocEncodedPayload, `${encodedPayloads.length} decoded base64 payload(s)`, 'obfuscation')
  }

  const hashes = asArray(iocs.hashes).length
  if (hashes > 0) {
    add('IOC_HASHES', weights.iocHashes, `${hashes} hash indicator(s)`, 'payload')
  }

  const wallets = asArray(iocs.wallets).length
  if (wallets > 0) {
    add(
      'IOC_WALLETS',
      Math.min(weights.iocWalletsMax, weights.iocWalletsBase + wallets * weights.iocWalletsStep),
      `${wallets} wallet address(es)`,
      'ransomware',
    )
  }

  const messengers = asArray(iocs.telegram).length + asArray(iocs.discordWebhooks).length
  if (messengers > 0) {
    add(
      'IOC_MESSENGER',
      Math.min(weights.iocMessengerMax, weights.iocMessengerBase + messengers * weights.iocMessengerStep),
      `${messengers} messaging/webhook endpoint(s)`,
      'c2',
    )
  }

  if (asArray(iocs.shellCommands).length > 0 || asArray(iocs.registryKeys).length > 0) {
    add('IOC_EXECUTION', weights.iocExecution, 'shell command or registry persistence indicator', 'execution')
  }

  if (asArray(iocs.mutexes).length > 0) {
    add('IOC_MUTEX', weights.iocMutex, `${asArray(iocs.mutexes).length} mutex name(s)`, 'evasion')
  }

  // --- Dynamic behaviour ---------------------------------------------------
  const counts = obj(obj(dynamicSection.counts).byKind ?? dynamicSection.counts)
  const events = asArray(dynamicSection.events)
  // Attribution: only guest-originated events describe the sample, so the
  // platform's own installation events (`document.installed`, `api.wrapped`,
  // …) can never raise a behavioural reason. When the caller supplies no event
  // list at all (a hand-built fixture with counters only) the counters are the
  // only evidence available and are used as-is.
  const guestEvents = events.filter((event) => !isPlatformEvent(obj(event)))
  const eventCount = (kind) => guestEvents.filter((event) => obj(event).kind === kind).length
  const counted = (kind, counter) => (events.length > 0 ? eventCount(kind) : toCount(counter))

  const networkEvents = counted('net', counts.net)
  if (networkEvents > 0) {
    add(
      'DYNAMIC_NETWORK',
      Math.min(weights.dynamicNetworkMax, weights.dynamicNetworkBase + networkEvents * weights.dynamicNetworkStep),
      `${networkEvents} network event(s) at runtime`,
      'network',
    )
  }

  const storageEvents = counted('storage', counts.storage)
  if (storageEvents > 0) {
    add('DYNAMIC_STORAGE', weights.dynamicStorage, `${storageEvents} storage access(es)`, 'persistence')
  }

  const domEvents = counted('dom', counts.dom)
  if (domEvents > 0) {
    add(
      'DYNAMIC_DOM',
      Math.min(weights.dynamicDomMax, weights.dynamicDomBase + domEvents * weights.dynamicDomStep),
      `${domEvents} DOM mutation(s)`,
      'injection',
    )
  }

  const evalEvents = counted('eval', counts.eval)
  if (evalEvents > 0) {
    add(
      'DYNAMIC_EVAL',
      Math.min(weights.dynamicEvalMax, weights.dynamicEvalBase + evalEvents * weights.dynamicEvalStep),
      `${evalEvents} dynamic eval event(s)`,
      'obfuscation',
    )
  }

  const behavior = obj(dynamicSection.behavior)
  const apiNames = asArray(behavior.apis).map((api) => str(obj(api).name))
  const dangerousApis = apiNames.filter((name) => DANGEROUS_APIS.has(name))
  if (dangerousApis.length > 0) {
    add(
      'DYNAMIC_API_MISUSE',
      weights.dynamicApiMisuse,
      `sensitive APIs observed: ${dangerousApis.join(', ')}`,
      'injection',
    )
  }

  const offloadApis = apiNames.filter((name) => name === 'Worker' || name.startsWith('Worker.') || name.startsWith('WebAssembly.'))
  if (offloadApis.length > 0) {
    add(
      'DYNAMIC_WORKER_OFFLOAD',
      weights.dynamicWorkerOffload,
      `computation offloaded via ${offloadApis.join(', ')}`,
      'evasion',
    )
  }

  const persistenceApis = apiNames.filter((name) => name.includes('serviceWorker') || name.includes('caches'))
  if (persistenceApis.length > 0) {
    add(
      'DYNAMIC_OFFLINE_PERSISTENCE',
      weights.dynamicOfflinePersistence,
      `offline persistence via ${persistenceApis.join(', ')}`,
      'persistence',
    )
  }

  const tamperEntries = asArray(integrity.drift).filter((entry) => ENV_TAMPER_KINDS.has(str(obj(entry).kind)))
  if (integrity.intact === false && tamperEntries.length > 0) {
    add(
      'DYNAMIC_ENV_TAMPER',
      weights.dynamicEnvTamper,
      `${tamperEntries.length} environment integrity drift entr(y/ies): ${tamperEntries.map((entry) => str(obj(entry).kind)).join(', ')}`,
      'evasion',
    )
  }

  const messengerEndpoints = [...asArray(iocs.telegram), ...asArray(iocs.discordWebhooks)]
    .map((endpoint) => str(obj(endpoint).value))
    .filter(Boolean)
  if (messengerEndpoints.length > 0) {
    const networkUrls = asArray(behavior.network).map((entry) => str(obj(entry).url)).filter(Boolean)
    const contacted = messengerEndpoints.filter((endpoint) => networkUrls.some((url) => url.toLowerCase().includes(endpoint.toLowerCase())))
    if (contacted.length > 0) {
      add(
        'DYNAMIC_MESSENGER_C2',
        weights.dynamicMessengerC2,
        `runtime contact with ${contacted.length} discovered messaging/webhook endpoint(s)`,
        'c2',
      )
    }
  }

  const inputCaptures = guestEvents.filter((event) => {
    if (obj(event).kind !== 'api' || !str(obj(event).api).includes('addEventListener')) return false
    return INPUT_CAPTURE_EVENTS.has(str(obj(event).type ?? obj(event).args?.[0]))
  })
  if (inputCaptures.length > 0) {
    add(
      'DYNAMIC_INPUT_CAPTURE',
      weights.dynamicInputCapture,
      `${inputCaptures.length} keyboard event listener(s) registered`,
      'credential-access',
    )
  }

  const limitsHit = asArray(dynamicSection.limitsHit).length
  if (limitsHit > 0) {
    add('DYNAMIC_LIMITS', weights.dynamicLimits, `execution limit(s) hit: ${limitsHit}`, 'evasion')
  }

  const uncaught = toCount(obj(dynamicSection.exceptions).uncaught)
  if (uncaught > 0) {
    add('DYNAMIC_UNCAUGHT', weights.dynamicUncaught, `${uncaught} uncaught exception(s)`, 'evasion')
  }

  // --- Tracing and hooks ---------------------------------------------------
  if (obj(obj(tracing).jsvmp).detected === true) {
    add('TRACING_JSVMP', weights.tracingJsvmp, 'JSVMP dispatcher detected', 'obfuscation')
  }

  const mocks = toCount(obj(hooks).mocks)
  if (mocks > 0) {
    add('HOOKS_MOCKED', weights.hooksMocks, `${mocks} environment API(s) mocked`, 'anti-analysis')
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((total, reason) => total + reason.weight, 0)))
  const level = score >= LEVEL_SUSPICIOUS_MAX + 1 ? 'malicious' : score > LEVEL_BENIGN_MAX ? 'suspicious' : 'benign'
  const confidence =
    reasons.length === 0
      ? 0.05
      : round2(Math.min(0.95, 0.15 + families.size * 0.12 + Math.min(reasons.length, 10) * 0.02))

  return {
    score,
    level,
    confidence,
    families: [...families].sort(),
    reasons,
  }
}

/**
 * Render a report as Markdown. Never throws and never emits `undefined`.
 *
 * @param {object} report report from {@link buildReport}
 * @returns {string}
 */
export function renderMarkdown(report) {
  const input = obj(report)
  const meta = obj(input.meta)
  const sample = obj(input.sample)
  const verdict = obj(input.verdict)
  const staticSection = obj(input.static)
  const dynamicSection = obj(input.dynamic)
  const tracing = obj(input.tracing)
  const hooks = obj(input.hooks)
  const iocs = obj(staticSection.iocs)
  const lines = []

  lines.push('# ai4reverse analysis report', '')

  // Verdict
  lines.push('## Verdict', '')
  lines.push(`- **Score:** ${formatScore(verdict.score)} (${renderValue(verdict.level)})`)
  lines.push(`- **Confidence:** ${formatConfidence(verdict.confidence)}`)
  lines.push(`- **Families:** ${joinValues(verdict.families)}`)
  const reasons = asArray(verdict.reasons)
  if (reasons.length > 0) {
    lines.push('', '| Code | Weight | Detail |', '| --- | ---: | --- |')
    for (const reason of reasons) {
      const item = obj(reason)
      lines.push(`| ${escapeCell(item.code)} | ${formatNumber(item.weight)} | ${escapeCell(item.detail)} |`)
    }
  }
  lines.push('')

  // Sample
  lines.push('## Sample', '')
  lines.push(`- **Name:** ${renderValue(sample.name)}`)
  lines.push(`- **Size:** ${formatNumber(sample.size)} bytes`)
  lines.push(`- **SHA-256:** ${renderValue(sample.sha256)}`)
  lines.push(`- **Source:** ${renderValue(sample.sourceType)} ${sample.sourceUrl ? `(${escapeText(sample.sourceUrl)})` : ''}`.trim())
  lines.push(`- **Truncated:** ${formatBoolean(sample.truncated)}`)
  lines.push('')

  // Static analysis
  const parse = obj(staticSection.parse)
  const restoration = obj(staticSection.restoration)
  const ast = obj(staticSection.ast)
  const obfuscation = obj(ast.obfuscation)
  lines.push('## Static analysis', '')
  lines.push(`- **Parse:** ${formatBoolean(parse.ok)}${parse.sourceType ? ` (${escapeText(parse.sourceType)})` : ''}`)
  const parseErrors = asArray(parse.errors)
  if (parseErrors.length > 0) lines.push(`- **Parse errors:** ${parseErrors.length}`)
  const passes = asArray(restoration.passes)
  lines.push(`- **Restoration passes:** ${passes.length}`)
  if (restoration.error != null) lines.push(`- **Restoration error:** ${escapeText(restoration.error)}`)
  if (passes.length > 0) {
    lines.push('', '| Pass | Changed | Duration (ms) | Notes |', '| --- | --- | ---: | --- |')
    for (const pass of passes) {
      const item = obj(pass)
      lines.push(
        `| ${escapeCell(item.id)} | ${formatBoolean(item.changed)} | ${formatNumber(item.durationMs)} | ${escapeCell(joinValues(item.notes))} |`,
      )
    }
  }
  lines.push(`- **Code size:** ${formatNumber(restoration.size)} bytes (${formatNumber(restoration.reducedBy)} bytes saved)`)
  lines.push(`- **Code SHA-256:** ${renderValue(restoration.sha256)}`)
  lines.push(
    `- **AST:** ${formatNumber(ast.functions)} functions, ${formatNumber(ast.strings)} strings, ${formatNumber(ast.memberAccesses)} member accesses, ${formatNumber(ast.evalLike)} eval-like, ${formatNumber(ast.timers)} timers, ${formatNumber(ast.networkCalls)} network calls`,
  )
  lines.push(`- **Obfuscation:** ${formatNumber(obfuscation.score)}/100 (${joinValues(obfuscation.indicators)})`)
  lines.push(`- **Techniques:** ${joinValues(staticSection.techniques)}`)
  lines.push('')

  // IOCs
  lines.push('## IOCs', '')
  lines.push(...renderIocs(iocs))
  lines.push('')

  // Dynamic behaviour
  const result = obj(dynamicSection.result)
  const counts = obj(obj(dynamicSection.counts).byKind ?? dynamicSection.counts)
  const behavior = obj(dynamicSection.behavior)
  const exceptions = obj(dynamicSection.exceptions)
  lines.push('## Dynamic behaviour', '')
  lines.push(`- **Executed:** ${formatBoolean(dynamicSection.ok)}`)
  if (dynamicSection.error != null) lines.push(`- **Error:** ${escapeText(dynamicSection.error)}`)
  lines.push(`- **Limits hit:** ${joinValues(dynamicSection.limitsHit)}`)
  lines.push(`- **Result:** ${renderResult(result)}`)
  lines.push(`- **Event counts:** ${formatCounts(counts)}`)
  // `counts.byKind` is the raw trace histogram, which includes the events the
  // platform emits while it builds the environment. The behaviour counters
  // exclude them, so state the gap instead of showing two unexplained numbers.
  const attributed = obj(behavior.counts)
  const platformEvents = toCount(attributed.platform)
  if (platformEvents > 0) {
    lines.push(`- **Platform events (not sample behaviour):** ${formatNumber(platformEvents)}`)
  }
  const apis = asArray(behavior.apis)
  if (apis.length > 0) {
    lines.push('', '| API | Count |', '| --- | ---: |')
    for (const api of apis) {
      const item = obj(api)
      lines.push(`| ${escapeCell(item.name)} | ${formatNumber(item.count)} |`)
    }
  }
  lines.push('')
  lines.push(`- **Network:** ${summarize(behavior.network)}`)
  lines.push(`- **Storage:** ${summarize(behavior.storage)}`)
  lines.push(`- **DOM:** ${summarize(behavior.dom)}`)
  lines.push(`- **Timers:** ${summarize(behavior.timers)}`)
  lines.push(
    `- **Exceptions:** ${formatNumber(exceptions.uncaught)} uncaught, ${formatNumber(exceptions.caught)} caught, ${formatNumber(exceptions.promiseJobs)} promise jobs`,
  )
  lines.push(`- **Environment:** ${renderProfile(obj(obj(dynamicSection.environment).profile))}`)
  lines.push('')

  // Tracing / JSVMP
  const jsvmp = obj(tracing.jsvmp)
  lines.push('## Tracing/JSVMP', '')
  lines.push(`- **Tracing enabled:** ${formatBoolean(tracing.enabled)}`)
  lines.push(`- **Events:** ${formatNumber(tracing.events)} (${formatNumber(tracing.dropped)} dropped)`)
  lines.push(`- **Trace truncated:** ${renderTraceTruncation(tracing)}`)
  lines.push(`- **JSVMP detected:** ${formatBoolean(jsvmp.detected)}`)
  lines.push(`- **Opcodes:** ${formatNumber(jsvmp.opcodes)}; steps: ${formatNumber(jsvmp.steps)}`)
  lines.push(
    `- **Hooks:** ${formatNumber(hooks.active)} active, ${formatNumber(hooks.fired)} fired, ${formatNumber(hooks.mocks)} mocked`,
  )
  const hookErrors = asArray(hooks.errors)
  if (hookErrors.length > 0) {
    lines.push(
      `- **Hook errors:** ${hookErrors.length}${hooks.errorsTruncated === true ? ' (older failures dropped)' : ''}`,
    )
  }
  lines.push('')

  // Integrity
  const integrity = obj(input.integrity)
  lines.push('## Integrity', '')
  lines.push(`- **Trace intact:** ${formatBoolean(integrity.intact)}`)
  lines.push(`- **Drift:** ${summarize(integrity.drift)}`)
  lines.push('')

  // Recommendations
  lines.push('## Recommendations', '')
  const recommendations = asArray(input.recommendations)
  if (recommendations.length === 0) {
    lines.push('None.')
  } else {
    for (const recommendation of recommendations) lines.push(`- ${escapeText(summarize(recommendation))}`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * @param {object} iocs
 * @returns {string[]}
 */
function renderIocs(iocs) {
  const lines = []
  const categories = [
    ['urls', 'URLs', renderUrlTable],
    ['domains', 'Domains', renderDomainTable],
    ['ips', 'IP addresses', renderIpTable],
    ['emails', 'Emails', renderGenericTable],
    ['hashes', 'Hashes', renderGenericTable],
    ['wallets', 'Wallets', renderGenericTable],
    ['base64', 'Base64 blobs', renderGenericTable],
    ['telegram', 'Telegram', renderGenericTable],
    ['discordWebhooks', 'Discord webhooks', renderGenericTable],
    ['crypto', 'Crypto indicators', renderGenericTable],
    ['shellCommands', 'Shell commands', renderGenericTable],
    ['registryKeys', 'Registry keys', renderGenericTable],
    ['filePaths', 'File paths', renderGenericTable],
    ['mutexes', 'Mutexes', renderGenericTable],
    ['other', 'Other', renderGenericTable],
  ]
  let rendered = 0
  for (const [key, label, renderer] of categories) {
    const items = asArray(iocs[key])
    if (items.length === 0) continue
    rendered += 1
    lines.push(`### ${label}`, '')
    lines.push(...renderer(items), '')
  }
  if (rendered === 0) lines.push('No IOCs extracted.')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** @param {unknown[]} items */
function renderUrlTable(items) {
  const lines = ['| URL | Host | Source |', '| --- | --- | --- |']
  for (const item of items) {
    const url = typeof item === 'string' ? { value: item } : obj(item)
    const marker = url.benignHost ? ' (benign host)' : ''
    lines.push(
      `| ${escapeCell(url.value)}${marker} | ${escapeCell(url.host)} | ${escapeCell(url.source)} |`,
    )
  }
  return lines
}

/** @param {unknown[]} items */
function renderDomainTable(items) {
  const lines = ['| Domain | Count | Suspicious TLD |', '| --- | ---: | --- |']
  for (const item of items) {
    const domain = typeof item === 'string' ? { value: item, count: 1 } : obj(item)
    lines.push(
      `| ${escapeCell(domain.value)} | ${formatNumber(domain.count)} | ${formatBoolean(domain.suspiciousTld)} |`,
    )
  }
  return lines
}

/** @param {unknown[]} items */
function renderIpTable(items) {
  const lines = ['| IP | Version |', '| --- | ---: |']
  for (const item of items) {
    const ip = typeof item === 'string' ? { value: item } : obj(item)
    lines.push(`| ${escapeCell(ip.value)} | ${formatNumber(ip.version)} |`)
  }
  return lines
}

/** @param {unknown[]} items */
function renderGenericTable(items) {
  const lines = ['| Value | Count | Detail |', '| --- | ---: | --- |']
  for (const item of items) {
    if (typeof item === 'string') {
      lines.push(`| ${escapeCell(item)} | 1 |  |`)
      continue
    }
    const record = obj(item)
    const detailParts = []
    if (record.algo != null) detailParts.push(`algo=${record.algo}`)
    if (record.kind != null) detailParts.push(`kind=${record.kind}`)
    if (record.version != null) detailParts.push(`version=${record.version}`)
    if (record.length != null) detailParts.push(`length=${record.length}`)
    if (record.decodedKind != null) detailParts.push(`decoded=${record.decodedKind}`)
    if (record.decodedPreview != null) detailParts.push(`preview=${record.decodedPreview}`)
    lines.push(
      `| ${escapeCell(record.value)} | ${formatNumber(record.count)} | ${escapeCell(detailParts.join('; '))} |`,
    )
  }
  return lines
}

/** @param {object} result */
function renderResult(result) {
  const type = renderValue(result.type)
  if (typeof result.preview === 'string' && result.preview.length > 0) {
    return `${type} — ${escapeText(result.preview)}`
  }
  return type
}

/**
 * Render the trace-completeness line. Truncation is stated with its cause so an
 * analyst can tell "the sample was bigger than the code-step budget" from "the
 * retained window is smaller than the trace".
 * @param {object} tracing
 */
function renderTraceTruncation(tracing) {
  if (tracing.truncated !== true) return 'no'
  const reasons = asArray(tracing.truncatedBy).map((reason) => TRACE_TRUNCATION_LABELS[reason] ?? String(reason))
  const cause = reasons.length > 0 ? ` (${reasons.join('; ')})` : ''
  return `yes${cause} — ${formatNumber(tracing.dropped)} event(s) dropped`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatScore(score) {
  const numeric = Number(score)
  if (!Number.isFinite(numeric)) return '— / 100'
  return `${Math.max(0, Math.min(100, Math.round(numeric)))} / 100`
}

/**
 * @param {unknown} confidence
 */
function formatConfidence(confidence) {
  const numeric = Number(confidence)
  if (!Number.isFinite(numeric)) return '—'
  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`
}

/** @param {unknown} value */
function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : '0'
}

/** @param {unknown} value */
function formatBoolean(value) {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return '—'
}

/** @param {unknown} value */
function renderValue(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value.length > 0 ? escapeText(value) : '—'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return summarize(value)
}

/**
 * Summarise arbitrary report data for one line of Markdown.
 * @param {unknown} input
 */
function summarize(input) {
  if (input === null || input === undefined) return 'none'
  if (typeof input === 'string') return input.length > 0 ? escapeText(input) : 'none'
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') return String(input)
  if (Array.isArray(input)) {
    if (input.length === 0) return 'none'
    const shown = input.slice(0, 10).map((item) => summarize(item))
    if (input.length > shown.length) shown.push(`+${input.length - shown.length} more`)
    return shown.join(', ')
  }
  if (typeof input === 'object') {
    if (Object.keys(input).length === 0) return 'none'
    try {
      const json = JSON.stringify(input)
      if (json === undefined) return 'object'
      return json.length > 240 ? `${json.slice(0, 240)}…` : json
    } catch {
      return 'object'
    }
  }
  return String(input)
}

/**
 * @param {unknown} list
 */
function joinValues(list) {
  const items = asArray(list)
  if (items.length === 0) return 'none'
  return items.map((item) => escapeText(summarize(item))).join(', ')
}

/** @param {object} counts */
function formatCounts(counts) {
  const entries = Object.entries(counts)
  if (entries.length === 0) return 'none'
  return entries
    .map(([kind, count]) => `${escapeText(kind)}=${formatNumber(count)}`)
    .join(', ')
}

/** @param {object} profile */
function renderProfile(profile) {
  const parts = []
  for (const key of PROFILE_STRING_KEYS) {
    if (typeof profile[key] === 'string' && profile[key].length > 0) parts.push(`${key}=${profile[key]}`)
  }
  if (profile.screen && typeof profile.screen === 'object') parts.push(`screen=${summarize(profile.screen)}`)
  return parts.length > 0 ? escapeText(parts.join('; ')) : 'none'
}

/**
 * Escape Markdown table cell content and line breaks.
 * @param {unknown} input
 */
function escapeCell(input) {
  if (input === null || input === undefined) return ''
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

/**
 * Escape free text in list items.
 * @param {unknown} input
 */
function escapeText(input) {
  if (input === null || input === undefined) return ''
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    .replace(/\r?\n/g, ' ')
}

// --- Normalisation helpers -------------------------------------------------

/** @param {unknown} value */
function obj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** @param {unknown} value */
function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  const nested = value?.events
  if (Array.isArray(nested)) return nested
  return [value]
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/** @param {unknown} value */
function num(value) {
  return Number.isFinite(value) ? value : 0
}

/** @param {unknown} value */
function toCount(value) {
  if (Array.isArray(value)) return value.length
  if (Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return 0
}

/** @param {number} value */
function round2(value) {
  return Math.round(value * 100) / 100
}

/** @param {unknown} value */
function normalizeProfile(value) {
  const input = obj(value)
  /** @type {Record<string, unknown>} */
  const profile = {}
  for (const key of PROFILE_STRING_KEYS) profile[key] = str(input[key])
  profile.screen = normalizeScreen(input.screen)
  return profile
}

/** @param {unknown} value */
function normalizeScreen(value) {
  if (value === null || typeof value !== 'object') return null
  const input = obj(value)
  const screen = {}
  for (const key of SCREEN_KEYS) {
    if (Number.isFinite(input[key])) screen[key] = input[key]
  }
  return Object.keys(screen).length > 0 ? screen : null
}

/** @param {unknown} value */
function normalizeSample(value) {
  const input = obj(value)
  return {
    name: str(input.name),
    size: num(input.size),
    sha256: str(input.sha256),
    sourceUrl: str(input.sourceUrl),
    sourceType: str(input.sourceType),
    truncated: input.truncated === true,
  }
}

/** @param {unknown} value */
function normalizeParse(value) {
  const input = obj(value)
  return {
    ok: input.ok === true,
    sourceType: str(input.sourceType),
    errors: asArray(input.errors),
  }
}

/**
 * @param {object} input
 * @param {string} sourceCode
 */
function normalizeRestoration(input, sourceCode) {
  const passes = asArray(input.passes).map((pass) => {
    const item = obj(pass)
    return {
      id: str(item.id),
      changed: item.changed === true,
      durationMs: num(item.durationMs),
      notes: asArray(item.notes).map((note) => str(note)),
    }
  })
  const code = str(input.code) || sourceCode
  return {
    // A failing pipeline is evidence: the raw source is what got analysed, and
    // the failure message says why. Dropping it silently hid the failure.
    error: normalizeError(input.error),
    passes,
    code,
    sha256: str(input.sha256),
    size: Number.isFinite(input.size) ? input.size : code.length,
    reducedBy: num(input.reducedBy),
  }
}

/**
 * Flatten the several error shapes the pipeline stages use to one message.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeError(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 0 ? value : null
  const input = obj(value)
  const message = str(input.message ?? input.name ?? '')
  return message.length > 0 ? message : null
}

/** @param {unknown} value */
function normalizeAst(value) {
  const input = obj(value)
  const obfuscation = obj(input.obfuscation)
  return {
    functions: toCount(input.functions),
    strings: toCount(input.strings),
    memberAccesses: toCount(input.memberAccesses),
    evalLike: toCount(input.evalLike),
    timers: toCount(input.timers),
    networkCalls: toCount(input.networkCalls),
    obfuscation: {
      score: toCount(obfuscation.score),
      indicators: asArray(obfuscation.indicators),
    },
  }
}

/**
 * @param {unknown} value
 * @param {string} [sourceCode]
 */
function normalizeIocs(value, sourceCode) {
  const input = value == null && sourceCode ? extractIOCs(sourceCode) : obj(value)
  const result = {}
  for (const key of IOC_KEYS) result[key] = Array.isArray(input[key]) ? input[key] : []
  result.meta = { truncated: obj(input.meta).truncated === true }
  return result
}

/**
 * @param {object} input
 * @param {object} profile
 */
function normalizeDynamic(input, profile) {
  const countsInput = obj(input.counts)
  const behaviorInput = obj(input.behavior)
  const environment = obj(input.environment)
  const resultInput = input.result
  return {
    ok: input.ok === true,
    error:
      input.error === null || input.error === undefined
        ? null
        : typeof input.error === 'string'
          ? input.error
          : str(input.error.message ?? input.error.name ?? input.error),
    limitsHit: asArray(input.limitsHit),
    result: normalizeResult(resultInput),
    events: asArray(input.events),
    counts: { byKind: obj(countsInput.byKind ?? countsInput) },
    behavior: {
      apis: asArray(behaviorInput.apis).map((api) => {
        const item = obj(api)
        return { name: str(item.name), count: Number.isFinite(item.count) ? item.count : 1 }
      }),
      network: behaviorInput.network ?? {},
      storage: behaviorInput.storage ?? {},
      dom: behaviorInput.dom ?? {},
      timers: behaviorInput.timers ?? {},
    },
    exceptions: {
      uncaught: toCount(obj(input.exceptions).uncaught),
      caught: toCount(obj(input.exceptions).caught),
      promiseJobs: toCount(obj(input.exceptions).promiseJobs),
    },
    environment: {
      profile: normalizeProfile(environment.profile ?? profile),
    },
  }
}

/** @param {unknown} value */
function normalizeResult(value) {
  if (value === null || value === undefined) return { type: '', preview: '' }
  if (typeof value !== 'object') {
    return { type: typeof value, preview: str(value).slice(0, 500) }
  }
  const input = obj(value)
  return {
    type: str(input.type),
    preview: str(input.preview),
  }
}

/** @param {unknown} value */
function normalizeTracing(value) {
  const input = obj(value)
  const jsvmp = obj(input.jsvmp)
  // Truncation is derived by the orchestrator from the run record, so it stays
  // true even when the `code:trace-truncated` marker was pushed out of the
  // retained event window.
  const truncated = input.truncated === true || input.traceTruncated === true
  const truncatedBy = truncated
    ? asArray(input.truncatedBy)
        .map((reason) => str(reason))
        .filter((reason) => TRACE_TRUNCATION_REASONS.includes(reason))
    : []
  return {
    enabled: input.enabled === true,
    events: toCount(input.events),
    dropped: toCount(input.dropped),
    truncated,
    truncatedBy: [...new Set(truncatedBy)],
    jsvmp: {
      detected: jsvmp.detected === true,
      opcodes: toCount(jsvmp.opcodes),
      steps: toCount(jsvmp.steps),
    },
  }
}

/** @param {unknown} value */
function normalizeHooks(value) {
  const input = obj(value)
  const rawErrors = asArray(input.errors)
  const errors = rawErrors.slice(0, MAX_REPORTED_HOOK_ERRORS).map((entry) => {
    const item = obj(entry)
    return {
      hook: str(item.hook),
      phase: str(item.phase),
      message: str(item.message),
    }
  })
  return {
    active: toCount(input.active),
    fired: toCount(input.fired),
    mocks: toCount(input.mocks),
    errors,
    errorsTruncated: input.errorsTruncated === true || rawErrors.length > errors.length,
  }
}

/** @param {unknown} value */
function normalizeArtifact(value) {
  const input = typeof value === 'object' && value !== null ? obj(value) : { id: str(value) }
  return {
    id: str(input.id),
    kind: str(input.kind),
    sha256: str(input.sha256),
    size: num(input.size),
    preview: str(input.preview),
    ...(input.source ? { source: str(input.source) } : {}),
    ...(Number.isFinite(input.count) && input.count > 1 ? { count: input.count } : {}),
  }
}
