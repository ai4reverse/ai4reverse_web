/**
 * Behaviour summarisation.
 *
 * Trace events are the ground truth; this module turns them into the
 * categories an analyst reasons about (API usage, network, persistence, DOM
 * manipulation, timers, exceptions, staged eval) and infers a kill-chain shape.
 * It never invents events: every line maps to event sequence numbers.
 *
 * Attribution matters as much as collection: the platform emits its own trace
 * events while it installs the environment (DOM, canvas, wakers). Those are
 * filtered out here so a counter always means "the sample did this".
 */

const NETWORK_APIS = new Set([
  'fetch',
  'window.fetch',
  'XMLHttpRequest.open',
  'XMLHttpRequest.send',
  'WebSocket.send',
  'navigator.sendBeacon',
  'window.open',
])

/**
 * Mock reasons `createApiHooks` uses for its own *policy* hooks: dialog
 * suppression and popup blocking are installed for every run with the default
 * hook set. They are the platform answering the call, not the sample mocking
 * the environment, so they are not anti-analysis evidence.
 */
const PLATFORM_POLICY_MOCK_REASONS = new Set(['dialog-suppressed', 'popup-blocked'])

/** The APIs those policy hooks answer (the mock payload does not name the hook). */
const PLATFORM_POLICY_MOCK_APIS = new Set(['window.alert', 'window.confirm', 'window.prompt', 'window.open'])

/**
 * Attribute one trace event: was it the sample or the platform?
 *
 * The recorder stamps a single `actor` per run (`sandbox`), so attribution has
 * to come from the event itself. Three shapes describe the platform instead of
 * the sample:
 *
 *  1. `sandbox` events: environment lifecycle (`env.*-installed`, clock
 *     virtualisation, stealth installation).
 *  2. `api` events in phase `emit`: wrapper installation (`api.wrapped`) and
 *     the platform's own notices (`sensitive-api`). A guest call is `invoke`,
 *     or the env module's own `before`/`skip`.
 *  3. installation markers of any kind: an `api`/`event` label ending in
 *     `.installed` (`document.installed`, `document.fonts.installed`).
 *
 * The DOM and canvas modules announce themselves through the `dom` kind, so
 * without this filter a sample as inert as `var x = 1;` collected a fake
 * `DYNAMIC_DOM` reason (6 points) from the platform's own installation events.
 *
 * @param {object} event trace event
 * @returns {boolean}
 */
export function isPlatformEvent(event) {
  const item = event !== null && typeof event === 'object' ? event : {}
  if (item.kind === 'sandbox') return true
  if (item.kind === 'api' && item.phase === 'emit') return true
  return isInstallationLabel(item.api) || isInstallationLabel(item.event)
}

/** @param {unknown} value */
function isInstallationLabel(value) {
  return typeof value === 'string' && /(^|\.)installed(\.|$)/.test(value)
}

/** @param {object} event */
function isPlatformPolicyMock(event) {
  return PLATFORM_POLICY_MOCK_REASONS.has(event.reason) || PLATFORM_POLICY_MOCK_APIS.has(event.api)
}

/**
 * @param {object[]} events trace events
 * @returns {object} behaviour summary
 */
export function summarizeBehavior(events = []) {
  const apis = new Map()
  const network = []
  const storage = []
  const dom = []
  const timers = []
  const exceptions = { uncaught: [], caught: [], promiseJobs: [] }
  const evals = []
  const mocks = []
  let platformEvents = 0
  const iocs = []
  const consoleLines = []
  const crypto = []
  const clipboard = []

  // Instrumented APIs emit both an `invoke` event (wrapper) and the env
  // module's own `before` event. Counting both would double-count every call,
  // so prefer `invoke` when the run used API instrumentation.
  const hasInvokeEvents = events.some((event) => event.kind === 'api' && event.phase === 'invoke')

  for (const event of events) {
    // Only guest-originated observations describe the sample; installation and
    // tracing metadata describe the platform (see `eventOrigin`).
    if (isPlatformEvent(event)) {
      platformEvents += 1
      continue
    }
    const api = event.api
    switch (event.kind) {
      case 'api': {
        const countable = hasInvokeEvents ? event.phase === 'invoke' : event.phase === 'before' || event.phase === 'skip'
        if (api && countable) apis.set(api, (apis.get(api) ?? 0) + 1)
        // `api.wrapped`/`api.after` are instrumentation metadata, not calls.
        const isCallEvent = event.phase === 'invoke' || event.phase === 'before' || event.phase === 'skip'
        if (api && isCallEvent && NETWORK_APIS.has(api)) {
          network.push({
            api: event.api,
            url: event.url ?? event.args?.[0],
            seq: event.seq,
            status: event.status,
            mock: Boolean(event.mock),
          })
        }
        if (event.mock && !isPlatformPolicyMock(event)) mocks.push({ api, reason: event.reason, seq: event.seq })
        if (api === 'document.cookie:set' || api?.startsWith('document.cookie')) {
          storage.push({ kind: 'cookie', api, value: preview(event.value), seq: event.seq })
        }
        if (api?.startsWith('console.')) {
          consoleLines.push({ method: api.slice('console.'.length), text: event.text, seq: event.seq })
          // console output is high volume; do not count it as behaviour
          apis.delete(api)
        }
        if (api?.includes('crypto.subtle')) crypto.push({ api, seq: event.seq, detail: event.algorithm ?? event.args?.[0] })
        if (api?.includes('clipboard')) clipboard.push({ api, seq: event.seq, text: preview(event.args?.[0]) })
        break
      }
      case 'net':
        network.push({
          method: event.method,
          url: event.url,
          status: event.status,
          ok: event.ok,
          error: event.error,
          durationMs: event.durationMs,
          bodyLength: event.bodyLength,
          seq: event.seq,
        })
        break
      case 'storage':
        storage.push({
          api: event.api,
          key: event.key,
          value: preview(event.value),
          seq: event.seq,
        })
        break
      case 'dom':
        dom.push({ api: event.api ?? event.op, seq: event.seq, detail: event.value ?? event.args })
        break
      case 'timer':
        timers.push({ api: event.api, delay: event.delay, seq: event.seq })
        break
      case 'exception':
        if (event.phase === 'uncaught' || event.origin === 'promise-job') {
          exceptions.uncaught.push({
            name: event.error?.name,
            message: event.error?.message,
            origin: event.origin,
            stack: event.error?.stack,
            seq: event.seq,
          })
        } else if (event.phase === 'catch') {
          exceptions.caught.push({
            name: event.error?.name,
            message: event.error?.message,
            line: event.site?.line,
            seq: event.seq,
          })
        }
        break
      case 'code':
        if (event.event === 'eval' || event.event === 'Function') {
          evals.push({
            event: event.event,
            length: event.value?.length ?? event.value?.value?.length ?? 0,
            value: preview(event.value?.value ?? event.value),
            seq: event.seq,
          })
        }
        break
      case 'ioc':
        iocs.push({ kind: event.iocKind ?? event.kind ?? 'ioc', value: event.value, seq: event.seq })
        break
      default:
        break
    }
  }

  const ranked = [...apis.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }))

  return {
    apis: ranked,
    apiCount: ranked.reduce((total, entry) => total + entry.count, 0),
    network: dedupeNetwork(network),
    storage,
    dom: dom.slice(0, 2000),
    timers: timers.slice(0, 2000),
    exceptions,
    evalStages: evals,
    probes: evals.length,
    mocks,
    iocs,
    console: consoleLines.slice(0, 2000),
    crypto,
    clipboard,
    counts: {
      events: events.length,
      // Events excluded from every behaviour counter because the platform, not
      // the sample, emitted them.
      platform: platformEvents,
      apiCalls: ranked.reduce((total, entry) => total + entry.count, 0),
      network: network.length,
      storage: storage.length,
      dom: dom.length,
      timers: timers.length,
      exceptions: exceptions.uncaught.length + exceptions.caught.length,
      evals: evals.length,
      mocks: mocks.length,
      iocs: iocs.length,
    },
    killChain: inferKillChain({ ranked, network, storage, evals, exceptions, iocs }),
  }
}

/**
 * Infer coarse kill-chain stages from observed behaviour.
 * @param {object} summary
 */
export function inferKillChain(summary) {
  const stages = []
  const apiNames = new Set((summary.ranked ?? summary.apis ?? []).map((entry) => entry.name))
  const has = (pattern) => [...apiNames].some((name) => pattern.test(name))

  if (has(/eval|Function/) || (summary.evals ?? []).length > 0) {
    stages.push({ stage: 'execution', detail: 'dynamic code evaluation observed' })
  }
  if (has(/atob|charCode|unescape|decodeURI/)) {
    stages.push({ stage: 'decode', detail: 'string decoding API used' })
  }
  if ((summary.network ?? []).length > 0 || has(/fetch|XMLHttpRequest|WebSocket|sendBeacon/)) {
    stages.push({ stage: 'command-and-control', detail: 'outbound network activity' })
  }
  if ((summary.storage ?? []).length > 0 || has(/localStorage|sessionStorage|indexedDB|cookie/)) {
    stages.push({ stage: 'persistence', detail: 'state written to browser storage' })
  }
  if (has(/clipboard|getUserMedia|geolocation|Notification/)) {
    stages.push({ stage: 'collection', detail: 'sensitive host data accessed' })
  }
  if (has(/createElement|innerHTML|document\.write|appendChild/)) {
    stages.push({ stage: 'injection', detail: 'DOM injection observed' })
  }
  if ((summary.exceptions?.uncaught ?? []).length > 0) {
    stages.push({ stage: 'fault', detail: 'uncaught exception terminated or degraded the sample' })
  }
  return stages
}

function dedupeNetwork(entries) {
  const seen = new Map()
  for (const entry of entries) {
    const key = `${entry.method ?? ''}:${entry.url ?? ''}:${entry.status ?? ''}`
    const existing = seen.get(key)
    if (existing) {
      existing.count += 1
      existing.firstSeq = Math.min(existing.firstSeq, entry.seq ?? 0)
    } else {
      seen.set(key, { ...entry, count: 1, firstSeq: entry.seq ?? 0 })
    }
  }
  return [...seen.values()].slice(0, 500)
}

function preview(value, max = 512) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value
  try {
    const text = JSON.stringify(value)
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch {
    return '[object]'
  }
}
