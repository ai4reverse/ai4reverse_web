/**
 * Report -> observation normalisation.
 *
 * The hunting engine never reads the report schema directly: it queries a flat
 * table of observations. Each observation is one analytic fact (an indicator, a
 * trace event, a technique, an artifact, a verdict) projected onto the shared
 * field vocabulary that rules can select on. Projection is pure and stable, so
 * two runs of the same report produce identical observation ids.
 */

const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

function textOf(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && typeof part !== 'object')
    .map((part) => String(part).toLowerCase())
    .join(' ')
}

function hostOf(url) {
  if (typeof url !== 'string') return null
  const match = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)
  return match ? match[1].toLowerCase() : null
}

function baseObservation(fields) {
  const observation = {
    layer: null,
    kind: null,
    action: null,
    api: null,
    url: null,
    host: null,
    domain: null,
    path: null,
    value: null,
    technique: null,
    category: null,
    artifact: null,
    stage: null,
    seq: null,
    offset: null,
    count: null,
    score: null,
    confidence: null,
    suspiciousTld: null,
    ...fields,
  }
  observation.text = textOf(
    observation.layer,
    observation.kind,
    observation.action,
    observation.api,
    observation.url,
    observation.host,
    observation.domain,
    observation.path,
    observation.value,
    observation.technique,
    observation.category,
    observation.artifact,
    observation.stage,
  )
  return observation
}

function verdictObservations(report) {
  const verdict = report.verdict ?? {}
  return [
    baseObservation({
      id: 'verdict:classify',
      layer: 'verdict',
      kind: 'verdict',
      action: 'classify',
      value: verdict.level ?? null,
      score: Number.isFinite(verdict.score) ? verdict.score : null,
      confidence: Number.isFinite(verdict.confidence) ? verdict.confidence : null,
      count: Array.isArray(verdict.reasons) ? verdict.reasons.length : null,
    }),
  ]
}

function staticObservations(report) {
  const observations = []
  const staticSection = report.static ?? {}
  const restoration = staticSection.restoration ?? {}
  for (const pass of restoration.passes ?? []) {
    if (!pass || pass.changed !== true) continue
    observations.push(
      baseObservation({
        id: `static:restoration:${pass.id}`,
        layer: 'static',
        kind: 'restoration',
        action: 'pass.changed',
        value: pass.id,
        count: 1,
      }),
    )
  }
  const obfuscation = staticSection.ast?.obfuscation ?? {}
  for (const indicator of obfuscation.indicators ?? []) {
    observations.push(
      baseObservation({
        id: `static:obfuscation:${indicator.id}`,
        layer: 'static',
        kind: 'obfuscation',
        action: 'obfuscation.indicator',
        value: indicator.id,
        count: Number.isFinite(indicator.weight) ? indicator.weight : null,
      }),
    )
  }
  if (Number.isFinite(obfuscation.score)) {
    observations.push(
      baseObservation({
        id: 'static:obfuscation:total',
        layer: 'static',
        kind: 'obfuscation',
        action: 'obfuscation.scored',
        score: obfuscation.score,
        value: obfuscation.score,
      }),
    )
  }
  for (const technique of staticSection.techniques ?? []) {
    observations.push(
      baseObservation({
        id: `technique:${technique}`,
        layer: 'technique',
        kind: 'technique',
        action: 'technique.detected',
        technique,
        value: technique,
      }),
    )
  }
  if (report.tracing?.jsvmp?.detected === true) {
    observations.push(
      baseObservation({
        id: 'static:tracing:jsvmp',
        layer: 'static',
        kind: 'tracing',
        action: 'jsvmp.detected',
        value: 'jsvmp',
        count: Number.isFinite(report.tracing.jsvmp.opcodes) ? report.tracing.jsvmp.opcodes : null,
      }),
    )
  }
  return observations
}

function iocObservations(report) {
  const observations = []
  const iocs = report.static?.iocs ?? {}
  for (const [category, list] of Object.entries(iocs)) {
    if (category === 'meta' || !Array.isArray(list)) continue
    list.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return
      const value = entry.value
      const host = entry.host ?? (category === 'urls' ? hostOf(value) : null)
      const domain = entry.domain ?? (host && HOST_RE.test(host) ? host : category === 'domains' ? String(value) : null)
      observations.push(
        baseObservation({
          id: `ioc:${category}:${index}`,
          layer: 'ioc',
          kind: 'ioc',
          action: 'indicator.extracted',
          category,
          value: typeof value === 'string' ? value : String(value),
          url: category === 'urls' ? value : null,
          host,
          domain,
          path: entry.path ?? null,
          suspiciousTld: typeof entry.suspiciousTld === 'boolean' ? entry.suspiciousTld : null,
          offset: Number.isFinite(entry.offset) ? entry.offset : null,
          count: Number.isFinite(entry.count) ? entry.count : null,
        }),
      )
    })
  }
  return observations
}

function dynamicObservations(report) {
  const observations = []
  const dynamic = report.dynamic ?? {}
  for (const event of dynamic.events ?? []) {
    if (!event || typeof event !== 'object') continue
    const url = typeof event.url === 'string' ? event.url : null
    const host = hostOf(url)
    observations.push(
      baseObservation({
        id: `dynamic:event:${event.seq}`,
        layer: 'dynamic',
        kind: event.kind ?? null,
        action: event.event ?? null,
        api: typeof event.api === 'string' ? event.api : null,
        url,
        host,
        domain: host && HOST_RE.test(host) ? host : null,
        value: typeof event.value === 'string' ? event.value.slice(0, 256) : null,
        seq: Number.isFinite(event.seq) ? event.seq : null,
      }),
    )
  }
  const behavior = dynamic.behavior ?? {}
  for (const entry of behavior.apis ?? []) {
    observations.push(
      baseObservation({
        id: `dynamic:api:${entry.name}`,
        layer: 'behavior',
        kind: 'api',
        action: 'api.called',
        api: entry.name,
        count: Number.isFinite(entry.count) ? entry.count : null,
      }),
    )
  }
  (behavior.killChain ?? []).forEach((stage, index) => {
    observations.push(
      baseObservation({
        id: `dynamic:stage:${index}:${stage.stage}`,
        layer: 'behavior',
        kind: 'killchain',
        action: 'stage.reached',
        stage: stage.stage ?? null,
        value: stage.detail ?? null,
      }),
    )
  })
  for (const stage of behavior.evalStages ?? []) {
    observations.push(
      baseObservation({
        id: `dynamic:eval:${stage.seq}`,
        layer: 'dynamic',
        kind: 'eval',
        action: 'eval.payload',
        value: typeof stage.value === 'string' ? stage.value.slice(0, 256) : null,
        seq: Number.isFinite(stage.seq) ? stage.seq : null,
        count: Number.isFinite(stage.length) ? stage.length : null,
      }),
    )
  }
  return observations
}

function artifactObservations(report) {
  return (report.artifacts ?? []).map((artifact, index) =>
    baseObservation({
      id: `artifact:${artifact.id ?? index}`,
      layer: 'artifact',
      kind: 'artifact',
      action: 'artifact.captured',
      artifact: artifact.kind ?? null,
      value: typeof artifact.preview === 'string' ? artifact.preview.slice(0, 256) : null,
      count: Number.isFinite(artifact.size) ? artifact.size : null,
    }),
  )
}

/**
 * Project a report into the observation table used by the query engine.
 * @param {object} report report produced by `analyzeSample(...).report`
 * @returns {object[]} observations sorted by id for deterministic iteration
 */
export function normalizeReport(report) {
  const input = report && typeof report === 'object' ? report : {}
  const observations = [
    ...verdictObservations(input),
    ...staticObservations(input),
    ...iocObservations(input),
    ...dynamicObservations(input),
    ...artifactObservations(input),
  ]
  return observations.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
