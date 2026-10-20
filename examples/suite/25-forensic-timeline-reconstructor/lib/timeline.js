/**
 * Forensic timeline reconstruction.
 *
 * Three evidence sources are merged into one ordered view:
 *
 *   pre-run     static analysis (parse, restoration passes, techniques, IOCs)
 *   run         dynamic trace events, ordered by the sandbox's deterministic
 *               virtual clock (`t`), with the host wall clock as optional,
 *               explicitly-untrusted side evidence
 *   post-run    artifacts whose capture point cannot be correlated to a trace
 *               sequence number
 *
 * Artifacts carry `source: "dynamic:atob@80"`; the trailing number is the trace
 * sequence they were derived from, so a capture can be re-attached to the
 * virtual instant that produced it instead of being dumped at the end.
 */

export const STAGES = Object.freeze([
  'preparation',
  'initialization',
  'discovery',
  'execution',
  'persistence',
  'injection',
  'command-and-control',
  'collection',
])

const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage, index]))
const PHASE_RANK = { 'pre-run': 0, run: 1, 'post-run': 2 }

const STAGE_BY_KIND = Object.freeze({
  sandbox: 'initialization',
  api: 'discovery',
  hook: 'discovery',
  ast: 'discovery',
  code: 'execution',
  timer: 'execution',
  storage: 'persistence',
  dom: 'injection',
  net: 'command-and-control',
  ioc: 'collection',
})

const NOISE_KEYS = new Set(['seq', 't', 'wall', 'kind', 'phase', 'actor', 'event', 'markers'])

/** API calls that mutate the DOM are the only static trace of injection. */
const INJECTION_API_RE = /innerHTML|outerHTML|insertAdjacentHTML|appendChild|createElement|document\.write|execCommand/i
/** Environment bootstrap events emitted on the `dom` channel. */
const DOM_BOOTSTRAP_RE = /^document\.(?:installed|fonts\.installed)/

const truncate = (value, limit = 120) => {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Map a trace event onto its kill-chain-style stage. */
export function classifyStage(event) {
  if (!event || typeof event !== 'object') return 'discovery'
  const api = String(event.api ?? event.event ?? '')
  if (event.kind === 'api' && INJECTION_API_RE.test(api)) return 'injection'
  if (event.kind === 'dom') return DOM_BOOTSTRAP_RE.test(api) ? 'initialization' : 'injection'
  return STAGE_BY_KIND[event.kind] ?? 'discovery'
}

function describeAction(event) {
  if (event.kind === 'api' && typeof event.api === 'string' && event.api.length > 0) {
    return event.event === 'api.wrapped' ? `wrap(${event.api})` : event.api
  }
  if (typeof event.event === 'string' && event.event.length > 0) return event.event
  switch (event.kind) {
    case 'net':
      return event.method ? `net.request ${event.method}` : 'net.request'
    case 'api':
      return event.api ? `api.${event.api}` : 'api.call'
    case 'storage':
      return event.api ?? 'storage.access'
    case 'dom':
      return event.api ?? 'dom.mutation'
    case 'timer':
      return event.api ?? 'timer.schedule'
    case 'ioc':
      return 'ioc.capture'
    case 'hook':
      return 'hook.observe'
    default:
      return event.kind ?? 'event'
  }
}

function describeDetail(event) {
  const parts = []
  for (const key of ['method', 'url', 'api', 'key', 'value', 'status', 'error', 'delay', 'length', 'locale', 'timezone', 'instant']) {
    if (event[key] === undefined || event[key] === null) continue
    const raw = event[key]
    parts.push(`${key}=${typeof raw === 'string' ? truncate(raw, 90) : raw}`)
  }
  if (parts.length === 0) {
    for (const [key, raw] of Object.entries(event)) {
      if (NOISE_KEYS.has(key) || typeof raw === 'object') continue
      parts.push(`${key}=${truncate(raw, 60)}`)
      if (parts.length >= 4) break
    }
  }
  return truncate(parts.join(' · '), 220)
}

function makeEntry(fields) {
  return {
    id: fields.id,
    layer: fields.layer,
    phase: fields.phase,
    stage: fields.stage,
    action: fields.action,
    detail: fields.detail,
    virtualMs: fields.virtualMs ?? null,
    virtualIso: fields.virtualIso ?? null,
    offsetMs: fields.offsetMs ?? null,
    seq: fields.seq ?? null,
    hostOffsetMs: fields.hostOffsetMs ?? null,
  }
}

function staticEntries(report) {
  const entries = []
  const staticSection = report.static ?? {}
  const changed = (staticSection.restoration?.passes ?? []).filter((pass) => pass?.changed === true)
  for (const pass of changed) {
    entries.push(
      makeEntry({
        id: `static:restoration:${pass.id}`,
        layer: 'static',
        phase: 'pre-run',
        stage: 'preparation',
        action: `restoration.${pass.id}`,
        detail: 'restoration pass changed the code',
      }),
    )
  }
  for (const technique of staticSection.techniques ?? []) {
    entries.push(
      makeEntry({
        id: `static:technique:${technique}`,
        layer: 'static',
        phase: 'pre-run',
        stage: 'preparation',
        action: `technique.${technique}`,
        detail: 'static technique detection',
      }),
    )
  }
  const iocs = staticSection.iocs ?? {}
  for (const [category, list] of Object.entries(iocs)) {
    if (category === 'meta' || !Array.isArray(list)) continue
    for (const indicator of list) {
      if (!indicator || typeof indicator.value !== 'string') continue
      entries.push(
        makeEntry({
          id: `static:ioc:${category}:${indicator.offset ?? 0}`,
          layer: 'static',
          phase: 'pre-run',
          stage: 'preparation',
          action: `ioc.${category}`,
          detail: `${truncate(indicator.value, 90)}${Number.isFinite(indicator.offset) ? ` @${indicator.offset}` : ''}`,
        }),
      )
    }
  }
  return entries
}

function dynamicEntries(report, baseVirtual, baseHost) {
  const entries = []
  for (const event of report.dynamic?.events ?? []) {
    if (!event || typeof event !== 'object') continue
    const virtualMs = Number.isFinite(event.t) ? event.t : null
    entries.push(
      makeEntry({
        id: `dynamic:${event.seq ?? entries.length}`,
        layer: 'dynamic',
        phase: 'run',
        stage: classifyStage(event),
        action: describeAction(event),
        detail: describeDetail(event),
        virtualMs,
        virtualIso: virtualMs === null ? null : new Date(virtualMs).toISOString(),
        offsetMs: virtualMs === null || baseVirtual === null ? null : virtualMs - baseVirtual,
        seq: Number.isFinite(event.seq) ? event.seq : null,
        hostOffsetMs: Number.isFinite(event.wall) && baseHost !== null ? event.wall - baseHost : null,
      }),
    )
  }
  return entries
}

/** Resolve `dynamic:atob@80` to the virtual instant of sequence 80. */
function sourceSequence(artifact) {
  const match = /@(\d+)$/.exec(String(artifact?.source ?? ''))
  return match ? Number(match[1]) : null
}

function attachArtifact(artifact, eventsBySeq) {
  const seq = sourceSequence(artifact)
  if (seq === null) return null
  let anchor = null
  for (const candidate of eventsBySeq.keys()) {
    if (candidate <= seq && (anchor === null || candidate > anchor)) anchor = candidate
  }
  if (anchor === null) return null
  const event = eventsBySeq.get(anchor)
  if (!Number.isFinite(event?.t)) return null
  return { virtualMs: event.t, seq: anchor }
}

function artifactEntries(report, eventsBySeq, baseVirtual) {
  return (report.artifacts ?? []).map((artifact, index) => {
    const attached = attachArtifact(artifact, eventsBySeq)
    const virtualMs = attached?.virtualMs ?? null
    return makeEntry({
      id: `artifact:${artifact?.id ?? index}`,
      layer: 'artifact',
      phase: virtualMs === null ? 'post-run' : 'run',
      stage: 'collection',
      action: `artifact.${artifact?.kind ?? 'unknown'}`,
      detail: `${truncate(artifact?.preview ?? '', 90)}${attached ? ` ← seq ${attached.seq}` : ' (unresolved capture point)'}`,
      virtualMs,
      virtualIso: virtualMs === null ? null : new Date(virtualMs).toISOString(),
      offsetMs: virtualMs === null || baseVirtual === null ? null : virtualMs - baseVirtual,
      seq: attached?.seq ?? null,
    })
  })
}

/** Deterministic ordering: phase, virtual offset, trace sequence, then id. */
export function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const phase = (PHASE_RANK[left.phase] ?? 9) - (PHASE_RANK[right.phase] ?? 9)
    if (phase !== 0) return phase
    const leftOffset = left.offsetMs ?? -1
    const rightOffset = right.offsetMs ?? -1
    if (leftOffset !== rightOffset) return leftOffset - rightOffset
    const leftSeq = left.seq ?? -1
    const rightSeq = right.seq ?? -1
    if (leftSeq !== rightSeq) return leftSeq - rightSeq
    if (left.layer !== right.layer) return left.layer < right.layer ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * Detect virtual-clock gaps: consecutive run entries separated by more than
 * `thresholdMs`. Large gaps mark deferred execution (sleep/timer waits) or
 * tracing outages, both first-class forensic findings.
 */
export function detectGaps(entries, thresholdMs = 250) {
  const run = entries.filter((entry) => entry.phase === 'run' && Number.isFinite(entry.offsetMs))
  const gaps = []
  for (let index = 1; index < run.length; index += 1) {
    const previous = run[index - 1]
    const current = run[index]
    const delta = current.offsetMs - previous.offsetMs
    if (delta <= thresholdMs) continue
    gaps.push({
      afterId: previous.id,
      beforeId: current.id,
      deltaMs: delta,
      atOffsetMs: previous.offsetMs,
      fromStage: previous.stage,
      toStage: current.stage,
      afterAction: previous.action,
      beforeAction: current.action,
    })
  }
  return gaps
}

/** Structural anomalies: stage inversions, truncation and unresolved artifacts. */
export function detectAnomalies(entries, report, options = {}) {
  const anomalies = []
  const firstByStage = new Map()
  for (const entry of entries) {
    if (entry.phase !== 'run' || !STAGE_INDEX.has(entry.stage)) continue
    if (!firstByStage.has(entry.stage)) firstByStage.set(entry.stage, entry)
  }
  const execution = firstByStage.get('execution')
  for (const stage of ['command-and-control', 'persistence', 'injection']) {
    const marker = firstByStage.get(stage)
    if (!execution || !marker) continue
    if (marker.offsetMs < execution.offsetMs) {
      anomalies.push({
        code: 'STAGE_ORDER_INVERSION',
        severity: 'info',
        detail: `${stage} (${marker.action} @${marker.offsetMs}ms) observed before first execution (${execution.action} @${execution.offsetMs}ms)`,
      })
    }
  }
  if ((report.tracing?.dropped ?? 0) > 0) {
    anomalies.push({
      code: 'TRACE_TRUNCATED',
      severity: 'warning',
      detail: `${report.tracing.dropped} trace event(s) were dropped by the recorder`,
    })
  }
  for (const entry of entries) {
    if (entry.layer === 'artifact' && entry.phase === 'post-run') {
      anomalies.push({
        code: 'ARTIFACT_UNRESOLVED',
        severity: 'info',
        detail: `${entry.id} has no trace sequence; placed in the post-run bucket`,
      })
    }
  }
  if (options.includeHostClock) {
    const run = entries.filter((entry) => entry.phase === 'run' && Number.isFinite(entry.hostOffsetMs))
    for (let index = 1; index < run.length; index += 1) {
      if (run[index].hostOffsetMs + 1000 < run[index - 1].hostOffsetMs) {
        anomalies.push({
          code: 'HOST_CLOCK_REGRESSION',
          severity: 'warning',
          detail: `host clock moved backwards between ${run[index - 1].id} and ${run[index].id}`,
        })
        break
      }
    }
  }
  if (!entries.some((entry) => entry.phase === 'run')) {
    anomalies.push({ code: 'EMPTY_TRACE', severity: 'warning', detail: 'the report contains no dynamic trace events' })
  }
  return anomalies
}

function stageMarkers(entries) {
  const markers = []
  for (const stage of STAGES) {
    const first = entries.find((entry) => entry.phase === 'run' && entry.stage === stage)
    if (!first) continue
    markers.push({
      stage,
      offsetMs: first.offsetMs,
      virtualIso: first.virtualIso,
      seq: first.seq,
      action: first.action,
      count: entries.filter((entry) => entry.stage === stage).length,
    })
  }
  return markers.sort((left, right) => left.offsetMs - right.offsetMs)
}

/**
 * Reconstruct the timeline for one report.
 *
 * @param {object} report report from `analyzeSample(...).report`
 * @param {{gapThresholdMs?: number, layers?: string[], includeHostClock?: boolean}} [options]
 */
export function buildTimeline(report, options = {}) {
  const input = report && typeof report === 'object' ? report : {}
  const gapThresholdMs = Number.isFinite(options.gapThresholdMs) ? options.gapThresholdMs : 250
  const includeHostClock = options.includeHostClock === true
  const events = (input.dynamic?.events ?? []).filter((event) => Number.isFinite(event?.t))
  const baseVirtual = events.length > 0 ? Math.min(...events.map((event) => event.t)) : null
  const wallValues = events.map((event) => event.wall).filter((value) => Number.isFinite(value))
  const baseHost = includeHostClock && wallValues.length > 0 ? Math.min(...wallValues) : null
  const eventsBySeq = new Map(events.filter((event) => Number.isFinite(event.seq)).map((event) => [event.seq, event]))

  const layers = Array.isArray(options.layers) && options.layers.length > 0 ? new Set(options.layers) : null
  const all = [
    ...staticEntries(input),
    ...dynamicEntries(input, baseVirtual, baseHost),
    ...artifactEntries(input, eventsBySeq, baseVirtual),
  ]
  const entries = sortEntries(layers ? all.filter((entry) => layers.has(entry.layer)) : all)
  const gaps = detectGaps(entries, gapThresholdMs)
  const anomalies = detectAnomalies(entries, input, { includeHostClock })
  const durationMs = entries.reduce((max, entry) => (Number.isFinite(entry.offsetMs) ? Math.max(max, entry.offsetMs) : max), 0)
  const markers = stageMarkers(entries)

  return {
    sample: {
      name: input.sample?.name ?? 'unknown',
      sha256: input.sample?.sha256 ?? '',
      size: input.sample?.size ?? null,
      verdict: input.verdict?.level ?? null,
      score: input.verdict?.score ?? null,
    },
    clocks: {
      virtualBaseIso: baseVirtual === null ? null : new Date(baseVirtual).toISOString(),
      virtualBaseMs: baseVirtual,
      durationMs,
      hostClock: includeHostClock ? 'included (untrusted, not reproducible)' : 'excluded',
    },
    stageOrder: STAGES,
    markers,
    entries,
    gaps,
    anomalies,
    summary: {
      entries: entries.length,
      static: entries.filter((entry) => entry.layer === 'static').length,
      dynamic: entries.filter((entry) => entry.layer === 'dynamic').length,
      artifacts: entries.filter((entry) => entry.layer === 'artifact').length,
      gaps: gaps.length,
      anomalies: anomalies.length,
      stages: markers.map((marker) => marker.stage),
    },
  }
}
