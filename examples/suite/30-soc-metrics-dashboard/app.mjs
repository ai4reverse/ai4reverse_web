#!/usr/bin/env node
/**
 * SOC Metrics Dashboard — turn raw alert/analysis records into the numbers a
 * SOC lead is actually asked for: how fast do we detect, how fast do we close,
 * what are we seeing, and are we meeting SLA.
 *
 * Input is either
 *   - a JSON array of alert records (exported from a SIEM/ticket system), or
 *   - a set of samples, which the platform analyses so records can be generated,
 *   - a platform report, via `recordFromReport()` for pipeline integration.
 *
 * The dashboard never invents a number: every metric carries its `samples` count
 * and every share is expressed against the alert total.
 *
 *   --input records.json | --samples <file...> | --json | --markdown | --self-test
 */
import { readFile } from 'node:fs/promises'
import { analyzeSample } from '../../../tools/index.js'

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low'])
export const VERDICTS = Object.freeze(['malicious', 'suspicious', 'benign'])
export const DEFAULT_SLA_MINUTES = Object.freeze({ critical: 60, high: 240, medium: 1440, low: 4320 })
export const DEFAULT_BASE_TIME = '2024-03-01T00:00:00.000Z'

const MINUTE_MS = 60_000

export function parseTimestamp(value, field = 'timestamp') {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(time)) throw new Error(`${field} is not a valid timestamp: ${value}`)
  return time
}

export function isoOf(ms) {
  return new Date(ms).toISOString()
}

export function minutesBetween(start, end) {
  return Math.round(((parseTimestamp(end) - parseTimestamp(start)) / MINUTE_MS) * 10) / 10
}

function round1(value) {
  return Math.round(value * 10) / 10
}

export function percent(count, total) {
  return total === 0 ? 0 : round1((count / total) * 100)
}

/** Nearest-rank percentile on an ascending copy; 0 for an empty sample. */
export function percentile(values, fraction) {
  if (values.length === 0) return 0
  if (!(fraction > 0 && fraction <= 1)) throw new Error('percentile fraction must be in (0, 1]')
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return round1(sorted[rank - 1])
}

/** Mean/median/p90/min/max for a list of minute values. */
export function summarizeMinutes(values) {
  if (values.length === 0) {
    return { samples: 0, meanMinutes: 0, medianMinutes: 0, p90Minutes: 0, minMinutes: 0, maxMinutes: 0 }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const sum = sorted.reduce((total, value) => total + value, 0)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return {
    samples: sorted.length,
    meanMinutes: round1(sum / sorted.length),
    medianMinutes: round1(median),
    p90Minutes: percentile(sorted, 0.9),
    minMinutes: round1(sorted[0]),
    maxMinutes: round1(sorted[sorted.length - 1]),
  }
}

function stringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
}

/**
 * Validate one alert record and derive the durations the metrics need.
 * Duration fields are computed here so a caller cannot smuggle in a wrong MTTD.
 */
export function normalizeRecord(input, index = 0) {
  if (!input || typeof input !== 'object') throw new Error('record must be an object')
  const id = String(input.id ?? `AL-${String(index + 1).padStart(4, '0')}`).trim()
  if (id.length === 0) throw new Error('record id is required')
  const verdict = String(input.verdict ?? '').toLowerCase()
  if (!VERDICTS.includes(verdict)) throw new Error(`record ${id} has invalid verdict ${input.verdict}`)
  const severity = String(input.severity ?? 'medium').toLowerCase()
  if (!SEVERITIES.includes(severity)) throw new Error(`record ${id} has invalid severity ${input.severity}`)
  const firstSignalMs = parseTimestamp(input.firstSignalAt, `record ${id} firstSignalAt`)
  const detectedMs = parseTimestamp(input.detectedAt, `record ${id} detectedAt`)
  if (detectedMs < firstSignalMs) throw new Error(`record ${id} detectedAt precedes firstSignalAt`)
  const containedMs = input.containedAt ? parseTimestamp(input.containedAt, `record ${id} containedAt`) : null
  if (containedMs !== null && containedMs < detectedMs) throw new Error(`record ${id} containedAt precedes detectedAt`)
  const resolvedMs = input.resolvedAt ? parseTimestamp(input.resolvedAt, `record ${id} resolvedAt`) : null
  if (resolvedMs !== null) {
    const floor = containedMs ?? detectedMs
    if (resolvedMs < floor) throw new Error(`record ${id} resolvedAt precedes ${containedMs === null ? 'detectedAt' : 'containedAt'}`)
  }
  const slaMinutes = input.slaMinutes === undefined ? DEFAULT_SLA_MINUTES[severity] : Number(input.slaMinutes)
  if (!Number.isFinite(slaMinutes) || slaMinutes <= 0) throw new Error(`record ${id} slaMinutes must be positive`)
  const score = input.score === undefined || input.score === null ? null : Number(input.score)
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error(`record ${id} score must be 0..100`)
  return {
    id,
    title: String(input.title ?? id),
    severity,
    verdict,
    source: String(input.source ?? 'unknown'),
    score,
    firstSignalAt: isoOf(firstSignalMs),
    detectedAt: isoOf(detectedMs),
    containedAt: containedMs === null ? null : isoOf(containedMs),
    resolvedAt: resolvedMs === null ? null : isoOf(resolvedMs),
    slaMinutes,
    techniques: stringList(input.techniques, `record ${id} techniques`),
    iocHosts: stringList(input.iocHosts, `record ${id} iocHosts`).map((host) => host.toLowerCase()),
    mttdMinutes: minutesBetween(firstSignalMs, detectedMs),
    mttcMinutes: containedMs === null ? null : minutesBetween(detectedMs, containedMs),
    mttrMinutes: resolvedMs === null ? null : minutesBetween(detectedMs, resolvedMs),
  }
}

export function normalizeRecords(inputs) {
  if (!Array.isArray(inputs)) throw new Error('records must be an array')
  const seen = new Set()
  const records = inputs.map((input, index) => {
    const record = normalizeRecord(input, index)
    if (seen.has(record.id)) throw new Error(`duplicate record id ${record.id}`)
    seen.add(record.id)
    return record
  })
  return records
}

/** Count occurrences and turn them into `{key, count, share}` rows. */
function tally(records, pick) {
  const counts = new Map()
  for (const record of records) {
    for (const key of pick(record)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, share: percent(count, records.length) }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

/**
 * @param {object[]} inputs raw records
 * @param {{asOf?: string, top?: number}} [options] `asOf` is the backlog clock
 */
export function computeMetrics(inputs, options = {}) {
  const records = normalizeRecords(inputs)
  const requestedTop = Number(options.top ?? 5)
  const top = Number.isFinite(requestedTop) ? Math.max(1, Math.trunc(requestedTop)) : 5
  const timestamps = []
  for (const record of records) {
    for (const field of ['firstSignalAt', 'detectedAt', 'containedAt', 'resolvedAt']) {
      if (record[field]) timestamps.push(parseTimestamp(record[field]))
    }
  }
  const asOfMs = options.asOf ? parseTimestamp(options.asOf, 'asOf') : timestamps.length > 0 ? Math.max(...timestamps) : Date.parse(DEFAULT_BASE_TIME)
  const startMs = timestamps.length > 0 ? Math.min(...timestamps) : asOfMs

  const resolved = records.filter((record) => record.resolvedAt !== null)
  const unresolved = records.filter((record) => record.resolvedAt === null)
  const breached = resolved.filter((record) => record.mttrMinutes > record.slaMinutes)
  const overdueOpen = unresolved.filter((record) => minutesBetween(record.detectedAt, asOfMs) > record.slaMinutes)

  const verdictCounts = {}
  for (const verdict of VERDICTS) {
    const count = records.filter((record) => record.verdict === verdict).length
    verdictCounts[verdict] = { count, percent: percent(count, records.length) }
  }
  const severityCounts = {}
  for (const severity of SEVERITIES) {
    const count = records.filter((record) => record.severity === severity).length
    severityCounts[severity] = { count, percent: percent(count, records.length) }
  }
  const sources = {}
  for (const record of records) {
    const entry = sources[record.source] ?? { count: 0, malicious: 0, resolved: 0 }
    entry.count += 1
    if (record.verdict === 'malicious') entry.malicious += 1
    if (record.resolvedAt) entry.resolved += 1
    sources[record.source] = entry
  }
  for (const entry of Object.values(sources)) {
    entry.percent = percent(entry.count, records.length)
  }

  const byDay = new Map()
  for (const record of records) {
    const day = record.detectedAt.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  const daily = [...byDay.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([date, count]) => ({ date, count }))

  const agingMinutes = unresolved
    .map((record) => ({ id: record.id, minutes: minutesBetween(record.detectedAt, asOfMs), slaMinutes: record.slaMinutes }))
    .sort((left, right) => right.minutes - left.minutes)

  return {
    window: { start: isoOf(startMs), end: isoOf(Math.max(asOfMs, ...timestamps)), asOf: isoOf(asOfMs) },
    totals: {
      alerts: records.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      malicious: verdictCounts.malicious.count,
      suspicious: verdictCounts.suspicious.count,
      benign: verdictCounts.benign.count,
      meanScore: records.some((record) => record.score !== null)
        ? round1(records.filter((record) => record.score !== null).reduce((sum, record) => sum + record.score, 0) / records.filter((record) => record.score !== null).length)
        : 0,
    },
    mttd: summarizeMinutes(records.map((record) => record.mttdMinutes)),
    mttc: summarizeMinutes(records.filter((record) => record.mttcMinutes !== null).map((record) => record.mttcMinutes)),
    mttr: summarizeMinutes(resolved.map((record) => record.mttrMinutes)),
    sla: {
      within: resolved.length - breached.length,
      breached: breached.length,
      evaluated: resolved.length,
      compliance: percent(resolved.length - breached.length, resolved.length),
      overdueOpen: overdueOpen.length,
      breachedIds: breached.map((record) => record.id),
      overdueIds: overdueOpen.map((record) => record.id),
    },
    verdicts: verdictCounts,
    severities: severityCounts,
    sources,
    topTechniques: tally(records, (record) => record.techniques).slice(0, top),
    topIocs: tally(records, (record) => record.iocHosts).slice(0, top),
    daily,
    backlog: {
      unresolvedIds: unresolved.map((record) => record.id),
      aging: agingMinutes,
      oldestMinutes: agingMinutes.length > 0 ? agingMinutes[0].minutes : 0,
      overdueIds: overdueOpen.map((record) => record.id),
    },
    riskQueue: records
      .filter((record) => record.verdict !== 'benign' && record.resolvedAt === null)
      .sort((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity) || (right.score ?? 0) - (left.score ?? 0))
      .map((record) => ({ id: record.id, title: record.title, severity: record.severity, verdict: record.verdict, score: record.score })),
  }
}

/**
 * Map one platform analysis report onto an alert record.
 * Timeline offsets are explicit inputs: the platform knows *what* happened, the
 * SOC pipeline owns *when* it was noticed.
 */
export function recordFromReport(report, options = {}) {
  const baseMs = parseTimestamp(options.firstSignalAt ?? DEFAULT_BASE_TIME, 'firstSignalAt')
  const detectedAfter = Number(options.detectedAfterMinutes ?? 5)
  const containedAfter = options.containedAfterMinutes === undefined ? null : Number(options.containedAfterMinutes)
  const resolvedAfter = options.resolvedAfterMinutes === undefined ? null : Number(options.resolvedAfterMinutes)
  const verdict = String(report?.verdict?.level ?? '').toLowerCase()
  if (!VERDICTS.includes(verdict)) throw new Error('report.verdict.level is not a known verdict')
  const severity = options.severity ?? (verdict === 'malicious' ? 'critical' : verdict === 'suspicious' ? 'high' : 'low')
  const iocHosts = (report.static?.iocs?.urls ?? []).map((url) => url.host).filter(Boolean)
  return normalizeRecord({
    id: options.id ?? `AL-${String(report?.sample?.sha256 ?? '').slice(0, 8).toUpperCase()}`,
    title: options.title ?? report?.sample?.name ?? 'analysis result',
    severity,
    verdict,
    source: options.source ?? 'sandbox',
    score: report?.verdict?.score ?? null,
    firstSignalAt: isoOf(baseMs),
    detectedAt: isoOf(baseMs + detectedAfter * MINUTE_MS),
    containedAt: containedAfter === null ? null : isoOf(baseMs + containedAfter * MINUTE_MS),
    resolvedAt: resolvedAfter === null ? null : isoOf(baseMs + resolvedAfter * MINUTE_MS),
    slaMinutes: options.slaMinutes,
    techniques: report?.static?.techniques ?? [],
    iocHosts,
  })
}

export function ingestReports(reports, options = {}) {
  if (!Array.isArray(reports)) throw new Error('reports must be an array')
  const spacing = Number(options.spacingMinutes ?? 15)
  return reports.map((report, index) => {
    const firstSignalMs = parseTimestamp(options.firstSignalAt ?? DEFAULT_BASE_TIME, 'firstSignalAt') + index * spacing * MINUTE_MS
    return recordFromReport(report, {
      ...options,
      id: options.idPrefix ? `${options.idPrefix}${String(index + 1).padStart(4, '0')}` : undefined,
      firstSignalAt: isoOf(firstSignalMs),
    })
  })
}

/**
 * Analyse samples and synthesise a timeline from the verdict score.
 * The mapping is intentionally simple and documented: faster detection for
 * noisier (higher-scoring) samples, longer handling for malicious ones.
 */
export async function generateRecords(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('samples must be a non-empty array')
  const seed = options.seed ?? 0x5eed
  const baseMs = parseTimestamp(options.firstSignalAt ?? DEFAULT_BASE_TIME, 'firstSignalAt')
  const records = []
  for (const [index, sample] of samples.entries()) {
    const result = await analyzeSample(sample.source, {
      name: sample.name ?? `sample-${index + 1}.js`,
      logLevel: 'silent',
      seed,
      network: { policy: 'deny' },
    })
    const report = result.report
    const detectedAfter = Math.max(3, 40 - Math.round(report.verdict.score / 4))
    const malicious = report.verdict.level !== 'benign'
    const containedAfter = detectedAfter + (malicious ? 25 : 5)
    const resolvedAfter = containedAfter + (malicious ? 60 : 10)
    records.push(
      recordFromReport(report, {
        id: `AL-${String(index + 1).padStart(4, '0')}`,
        title: sample.name ?? `sample-${index + 1}.js`,
        source: sample.source ?? 'sandbox',
        firstSignalAt: isoOf(baseMs + index * 10 * MINUTE_MS),
        detectedAfterMinutes: detectedAfter,
        containedAfterMinutes: containedAfter,
        resolvedAfterMinutes: resolvedAfter,
        severity: malicious ? 'critical' : 'low',
      }),
    )
  }
  return records
}

function bar(value, max, width = 18) {
  if (max <= 0) return ''
  const filled = Math.max(value === 0 ? 0 : 1, Math.round((value / max) * width))
  return '█'.repeat(filled).padEnd(width, '·')
}

/**
 * ASCII dashboard: fixed-width, monochrome, safe in a terminal or a ticket note.
 */
export function renderAscii(metrics) {
  const WIDTH = 66
  const lines = []
  const rule = `${"─".repeat(WIDTH)}`
  const boxLine = (content) => `│${String(content).padEnd(WIDTH).slice(0, WIDTH)}│`
  const row = (label, value) => lines.push(boxLine(` ${String(label).padEnd(20)}${String(value).slice(0, WIDTH - 22)}`))
  lines.push(`┌${rule}┐`)
  lines.push(boxLine(`${' SOC METRICS DASHBOARD'.padEnd(WIDTH - 12)}${isoOf(Date.parse(metrics.window.asOf)).slice(11, 16)}Z`))
  lines.push(boxLine(` window ${metrics.window.start.slice(0, 10)} → ${metrics.window.end.slice(0, 10)} · ${metrics.totals.alerts} alerts`))
  lines.push(`├${rule}┤`)
  row('Alerts', `${metrics.totals.alerts}  resolved ${metrics.totals.resolved}  open ${metrics.totals.unresolved}`)
  row('Malicious', `${metrics.totals.malicious} (${metrics.verdicts.malicious.percent}%)  suspicious ${metrics.totals.suspicious} (${metrics.verdicts.suspicious.percent}%)`)
  row('Mean verdict score', metrics.totals.meanScore)
  row('MTTD signal→alert', `mean ${metrics.mttd.meanMinutes}m  median ${metrics.mttd.medianMinutes}m  p90 ${metrics.mttd.p90Minutes}m  n=${metrics.mttd.samples}`)
  row('MTTC alert→contain', `mean ${metrics.mttc.meanMinutes}m  median ${metrics.mttc.medianMinutes}m  p90 ${metrics.mttc.p90Minutes}m  n=${metrics.mttc.samples}`)
  row('MTTR alert→close', `mean ${metrics.mttr.meanMinutes}m  median ${metrics.mttr.medianMinutes}m  p90 ${metrics.mttr.p90Minutes}m  n=${metrics.mttr.samples}`)
  row('SLA compliance', `${metrics.sla.compliance}%  (${metrics.sla.within}/${metrics.sla.evaluated})  breached ${metrics.sla.breached}  overdue-open ${metrics.sla.overdueOpen}`)
  row('Backlog', `open ${metrics.backlog.unresolvedIds.length}  oldest ${metrics.backlog.oldestMinutes}m`)
  lines.push(`├${rule}┤`)
  lines.push(boxLine(' Verdict distribution'))
  for (const verdict of VERDICTS) {
    const entry = metrics.verdicts[verdict]
    lines.push(boxLine(`   ${verdict.padEnd(11)}${String(entry.count).padStart(3)}  ${String(`${entry.percent}%`).padStart(6)}  ${bar(entry.count, metrics.totals.alerts, 20)}`))
  }
  lines.push(`├${rule}┤`)
  lines.push(boxLine(' Top techniques'))
  if (metrics.topTechniques.length === 0) lines.push(boxLine('   (none)'))
  for (const entry of metrics.topTechniques) {
    lines.push(
      boxLine(`   ${entry.key.padEnd(26)}${String(entry.count).padStart(3)}  ${String(`${entry.share}%`).padStart(6)}  ${bar(entry.count, metrics.topTechniques[0].count, 12)}`),
    )
  }
  lines.push(`├${rule}┤`)
  lines.push(boxLine(' Top IOC hosts'))
  if (metrics.topIocs.length === 0) lines.push(boxLine('   (none)'))
  for (const entry of metrics.topIocs) {
    lines.push(boxLine(`   ${entry.key.padEnd(30)}${String(entry.count).padStart(3)}  ${String(`${entry.share}%`).padStart(6)}`))
  }
  lines.push(`├${rule}┤`)
  lines.push(boxLine(' Daily volume'))
  const maxDaily = Math.max(1, ...metrics.daily.map((day) => day.count))
  for (const day of metrics.daily) {
    lines.push(boxLine(`   ${day.date}  ${bar(day.count, maxDaily, 30)} ${String(day.count).padStart(3)}`))
  }
  if (metrics.riskQueue.length > 0) {
    lines.push(`├${rule}┤`)
    lines.push(boxLine(' Open malicious/suspicious queue'))
    for (const item of metrics.riskQueue.slice(0, 5)) {
      lines.push(boxLine(`   ${item.id.padEnd(10)}${item.severity.padEnd(9)}score=${String(item.score ?? '-').padEnd(4)}open`))
    }
  }
  lines.push(`└${rule}┘`)
  return `${lines.join('\n')}\n`
}

/** Markdown dashboard for a weekly report or a wiki page. */
export function renderMarkdown(metrics) {
  const lines = []
  lines.push('# SOC 指标看板')
  lines.push('')
  lines.push(`- 统计窗口: ${metrics.window.start} → ${metrics.window.end}`)
  lines.push(`- 计算时点: ${metrics.window.asOf}`)
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 告警总数 | ${metrics.totals.alerts} |`)
  lines.push(`| 已闭环 / 未闭环 | ${metrics.totals.resolved} / ${metrics.totals.unresolved} |`)
  lines.push(`| 恶意 / 可疑 / 正常 | ${metrics.totals.malicious} / ${metrics.totals.suspicious} / ${metrics.totals.benign} |`)
  lines.push(`| 平均判定分 | ${metrics.totals.meanScore} |`)
  lines.push(`| MTTD 均值 / 中位 / P90 | ${metrics.mttd.meanMinutes}m / ${metrics.mttd.medianMinutes}m / ${metrics.mttd.p90Minutes}m (n=${metrics.mttd.samples}) |`)
  lines.push(`| MTTC 均值 / 中位 / P90 | ${metrics.mttc.meanMinutes}m / ${metrics.mttc.medianMinutes}m / ${metrics.mttc.p90Minutes}m (n=${metrics.mttc.samples}) |`)
  lines.push(`| MTTR 均值 / 中位 / P90 | ${metrics.mttr.meanMinutes}m / ${metrics.mttr.medianMinutes}m / ${metrics.mttr.p90Minutes}m (n=${metrics.mttr.samples}) |`)
  lines.push(`| SLA 达标率 | ${metrics.sla.compliance}% (${metrics.sla.within}/${metrics.sla.evaluated}) |`)
  lines.push(`| SLA 违约 / 超期未闭环 | ${metrics.sla.breached} / ${metrics.sla.overdueOpen} |`)
  lines.push('')
  lines.push('## 判定分布')
  lines.push('')
  lines.push('| 判定 | 数量 | 占比 |')
  lines.push('| --- | --- | --- |')
  for (const verdict of VERDICTS) {
    lines.push(`| ${verdict} | ${metrics.verdicts[verdict].count} | ${metrics.verdicts[verdict].percent}% |`)
  }
  lines.push('')
  lines.push('## 严重级别分布')
  lines.push('')
  lines.push('| 级别 | 数量 | 占比 |')
  lines.push('| --- | --- | --- |')
  for (const severity of SEVERITIES) {
    lines.push(`| ${severity} | ${metrics.severities[severity].count} | ${metrics.severities[severity].percent}% |`)
  }
  lines.push('')
  lines.push('## Top 技术点')
  lines.push('')
  if (metrics.topTechniques.length === 0) lines.push('(无)')
  else {
    lines.push('| 技术点 | 次数 | 占告警比 |')
    lines.push('| --- | --- | --- |')
    for (const entry of metrics.topTechniques) lines.push(`| ${entry.key} | ${entry.count} | ${entry.share}% |`)
  }
  lines.push('')
  lines.push('## Top IOC')
  lines.push('')
  if (metrics.topIocs.length === 0) lines.push('(无)')
  else {
    lines.push('| IOC | 次数 | 占告警比 |')
    lines.push('| --- | --- | --- |')
    for (const entry of metrics.topIocs) lines.push(`| ${entry.key} | ${entry.count} | ${entry.share}% |`)
  }
  lines.push('')
  lines.push('## 每日处置量')
  lines.push('')
  lines.push('| 日期 | 告警数 |')
  lines.push('| --- | --- |')
  for (const day of metrics.daily) lines.push(`| ${day.date} | ${day.count} |`)
  lines.push('')
  lines.push('## 待处置队列')
  lines.push('')
  if (metrics.riskQueue.length === 0) lines.push('(空)')
  else {
    lines.push('| 告警 | 级别 | 判定 | 分数 | 标题 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const item of metrics.riskQueue) lines.push(`| ${item.id} | ${item.severity} | ${item.verdict} | ${item.score ?? '-'} | ${item.title} |`)
  }
  lines.push('')
  lines.push(`> 由 SOC Metrics Dashboard 生成 · 样本数 ${metrics.totals.alerts}`)
  return `${lines.join('\n')}\n`
}

const SYNTHETIC_BASE = Date.parse('2024-03-05T00:00:00.000Z')
const at = (minutes) => isoOf(SYNTHETIC_BASE + minutes * MINUTE_MS)

/** Five hand-written records with arithmetic small enough to assert by hand. */
function syntheticRecords() {
  return [
    {
      id: 'AL-0001',
      title: '钓鱼凭据回传',
      severity: 'critical',
      verdict: 'malicious',
      source: 'email',
      score: 78,
      firstSignalAt: at(0),
      detectedAt: at(5),
      containedAt: at(15),
      resolvedAt: at(65),
      slaMinutes: 120,
      techniques: ['T1566.002'],
      iocHosts: ['sso-verify.example.test'],
    },
    {
      id: 'AL-0002',
      title: 'WebSocket C2 回连',
      severity: 'high',
      verdict: 'malicious',
      source: 'edr',
      score: 66,
      firstSignalAt: at(30),
      detectedAt: at(45),
      containedAt: at(65),
      resolvedAt: at(125),
      slaMinutes: 60,
      techniques: ['T1071.001'],
      iocHosts: ['c2.example.test'],
    },
    {
      id: 'AL-0003',
      title: '可疑表单注入',
      severity: 'medium',
      verdict: 'suspicious',
      source: 'proxy',
      score: 41,
      firstSignalAt: at(100),
      detectedAt: at(120),
      containedAt: at(140),
      resolvedAt: at(150),
      slaMinutes: 240,
      techniques: ['T1566.002'],
      iocHosts: ['cdn.polyfill.example.test'],
    },
    {
      id: 'AL-0004',
      title: '误报：内网扫描插件',
      severity: 'low',
      verdict: 'benign',
      source: 'sandbox',
      score: 12,
      firstSignalAt: at(200),
      detectedAt: at(230),
      resolvedAt: at(245),
      slaMinutes: 480,
    },
    {
      id: 'AL-0005',
      title: '勒索前置工具落地',
      severity: 'critical',
      verdict: 'malicious',
      source: 'manual',
      score: 88,
      firstSignalAt: at(240),
      detectedAt: at(280),
      slaMinutes: 60,
      techniques: ['T1486', 'T1490'],
      iocHosts: ['c2.example.test'],
    },
  ]
}

function closeTo(actual, expected, tolerance, label) {
  if (Math.abs(Number(actual) - expected) > tolerance) throw new Error(`${label}: expected ~${expected}, got ${actual}`)
}

async function selfTest() {
  const records = normalizeRecords(syntheticRecords())
  if (records.length !== 5) throw new Error('record normalisation lost rows')
  const metrics = computeMetrics(records, { asOf: at(400) })

  // Totals and distributions.
  if (metrics.totals.alerts !== 5) throw new Error(`alerts ${metrics.totals.alerts}`)
  if (metrics.totals.resolved !== 4 || metrics.totals.unresolved !== 1) throw new Error('resolution totals')
  if (metrics.totals.malicious !== 3) throw new Error(`malicious ${metrics.totals.malicious}`)
  if (metrics.verdicts.malicious.percent !== 60) throw new Error(`malicious share ${metrics.verdicts.malicious.percent}`)
  if (metrics.verdicts.suspicious.percent !== 20) throw new Error('suspicious share')
  if (metrics.verdicts.benign.percent !== 20) throw new Error('benign share')
  if (metrics.severities.critical.count !== 2) throw new Error('severity tally')
  const shares = VERDICTS.reduce((sum, verdict) => sum + metrics.verdicts[verdict].percent, 0)
  closeTo(shares, 100, 0.0001, 'verdict shares')

  // MTTD = detected - first signal, over all 5 records.
  if (metrics.mttd.samples !== 5) throw new Error(`mttd samples ${metrics.mttd.samples}`)
  if (metrics.mttd.meanMinutes !== 22) throw new Error(`mttd mean ${metrics.mttd.meanMinutes}`)
  if (metrics.mttd.medianMinutes !== 20) throw new Error(`mttd median ${metrics.mttd.medianMinutes}`)
  if (metrics.mttd.p90Minutes !== 40) throw new Error(`mttd p90 ${metrics.mttd.p90Minutes}`)

  // MTTR = resolved - detected, over the 4 closed records.
  if (metrics.mttr.samples !== 4) throw new Error(`mttr samples ${metrics.mttr.samples}`)
  closeTo(metrics.mttr.meanMinutes, 46.25, 0.06, 'mttr mean')
  if (metrics.mttr.medianMinutes !== 45) throw new Error(`mttr median ${metrics.mttr.medianMinutes}`)
  if (metrics.mttr.p90Minutes !== 80) throw new Error(`mttr p90 ${metrics.mttr.p90Minutes}`)
  if (metrics.mttc.samples !== 3) throw new Error(`mttc samples ${metrics.mttc.samples}`)

  // SLA: AL-0002 breached 60m at 80m, AL-0005 open for 120m against 60m.
  if (metrics.sla.evaluated !== 4) throw new Error('sla denominator')
  if (metrics.sla.within !== 3 || metrics.sla.breached !== 1) throw new Error('sla counts')
  if (metrics.sla.compliance !== 75) throw new Error(`sla compliance ${metrics.sla.compliance}`)
  if (!metrics.sla.breachedIds.includes('AL-0002')) throw new Error('breached id missing')
  if (metrics.sla.overdueOpen !== 1 || !metrics.sla.overdueIds.includes('AL-0005')) throw new Error('overdue open id missing')

  // Technique and IOC roll-ups.
  if (metrics.topTechniques[0].key !== 'T1566.002' || metrics.topTechniques[0].count !== 2) throw new Error('top technique')
  if (metrics.topTechniques[0].share !== 40) throw new Error(`top technique share ${metrics.topTechniques[0].share}`)
  if (metrics.topIocs[0].key !== 'c2.example.test' || metrics.topIocs[0].count !== 2) throw new Error('top IOC')
  if (metrics.topIocs[0].share !== 40) throw new Error('top IOC share')

  // Source mix.
  if (metrics.sources.email.malicious !== 1) throw new Error('source malicious tally')
  if (metrics.sources.manual.resolved !== 0) throw new Error('source resolved tally')

  // Daily volume and backlog.
  if (metrics.daily.length !== 1 || metrics.daily[0].count !== 5) throw new Error('daily volume')
  if (metrics.backlog.unresolvedIds.join(',') !== 'AL-0005') throw new Error('backlog ids')
  if (metrics.backlog.oldestMinutes !== 120) throw new Error(`oldest backlog ${metrics.backlog.oldestMinutes}`)
  if (metrics.riskQueue.length !== 1 || metrics.riskQueue[0].id !== 'AL-0005') throw new Error('risk queue')

  // Validation must reject impossible records.
  const rejects = [
    [{ ...syntheticRecords()[0], verdict: 'unknown' }, 'verdict'],
    [{ ...syntheticRecords()[0], detectedAt: at(-10) }, 'precedes'],
    [{ ...syntheticRecords()[0], resolvedAt: at(4) }, 'precedes'],
  ]
  for (const [bad, expected] of rejects) {
    let message = null
    try {
      normalizeRecord(bad)
    } catch (error) {
      message = error.message
    }
    if (!message || !message.includes(expected)) throw new Error(`bad record not rejected with ${expected}: ${message}`)
  }
  let duplicate = null
  try {
    normalizeRecords([syntheticRecords()[0], syntheticRecords()[0]])
  } catch (error) {
    duplicate = error.message
  }
  if (!duplicate || !duplicate.includes('duplicate record id')) throw new Error('duplicate id not rejected')

  // Platform integration: a real analysis becomes a record without hand mapping.
  const analysis = await analyzeSample('eval(atob("ZmV0Y2goJ2h0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L2JlYWNvbicp")); fetch("https://c2.example.test/beacon").catch(function(){});', {
    name: 'beacon.js',
    logLevel: 'silent',
    seed: 0x5eed,
    network: { policy: 'deny' },
  })
  const ingested = recordFromReport(analysis.report, { id: 'AL-0100', source: 'sandbox', detectedAfterMinutes: 7 })
  if (!VERDICTS.includes(ingested.verdict)) throw new Error(`ingested verdict ${ingested.verdict}`)
  if (ingested.verdict !== analysis.report.verdict.level) throw new Error('verdict not mapped from report')
  if (!ingested.iocHosts.includes('c2.example.test')) throw new Error(`ingested IOC hosts ${ingested.iocHosts}`)
  if (ingested.mttdMinutes !== 7) throw new Error(`ingested mttd ${ingested.mttdMinutes}`)
  if (ingested.score !== analysis.report.verdict.score) throw new Error('score not mapped from report')

  const generated = await generateRecords([
    { name: 'beacon.js', source: 'fetch("https://c2.example.test/beacon").catch(function(){}); eval(atob("Y29uc29sZS5sb2coMSk="));' },
    { name: 'benign.js', source: 'var a = 1 + 2; console.log(a);' },
  ])
  if (generated.length !== 2) throw new Error('generateRecords length')
  const generatedMetrics = computeMetrics(generated)
  if (generatedMetrics.totals.alerts !== 2) throw new Error('generated metrics alerts')
  if (generatedMetrics.totals.resolved !== 2) throw new Error('generated records must all be closed')
  if (generatedMetrics.topIocs.length === 0) throw new Error('generated records lost IOC hosts')
  if (!generatedMetrics.topIocs.some((entry) => entry.key === 'c2.example.test')) throw new Error('generated IOC missing')

  const ingestedMetrics = computeMetrics(ingestReports([analysis.report, analysis.report], { idPrefix: 'AL-02', spacingMinutes: 30 }))
  if (ingestedMetrics.totals.alerts !== 2) throw new Error('ingestReports totals')
  if (ingestedMetrics.topIocs[0].count !== 2) throw new Error('ingestReports IOC dedupe')

  // Renderers and JSON export.
  const ascii = renderAscii(metrics)
  for (const needle of ['SOC METRICS DASHBOARD', 'MTTD', 'MTTR', 'SLA compliance', 'Top techniques', 'Daily volume', '█']) {
    if (!ascii.includes(needle)) throw new Error(`ascii dashboard missing ${needle}`)
  }
  const markdown = renderMarkdown(metrics)
  for (const needle of ['SOC 指标看板', 'MTTD', 'SLA 达标率', 'Top 技术点', 'Top IOC', '待处置队列']) {
    if (!markdown.includes(needle)) throw new Error(`markdown dashboard missing ${needle}`)
  }
  if (!markdown.includes('T1566.002') || !markdown.includes('c2.example.test')) throw new Error('markdown lost detail rows')
  const exported = JSON.parse(JSON.stringify(metrics))
  if (exported.totals.alerts !== 5 || exported.sla.compliance !== 75) throw new Error('JSON export round-trip failed')

  console.log(
    `soc-metrics: alerts=${metrics.totals.alerts} verdicts=${JSON.stringify({ malicious: metrics.verdicts.malicious.percent, suspicious: metrics.verdicts.suspicious.percent, benign: metrics.verdicts.benign.percent })} mttd(mean/p90)=${metrics.mttd.meanMinutes}/${metrics.mttd.p90Minutes} mttr(mean/p90)=${metrics.mttr.meanMinutes}/${metrics.mttr.p90Minutes} sla=${metrics.sla.compliance}%`,
  )
  console.log(`top: technique=${metrics.topTechniques[0].key} ioc=${metrics.topIocs[0].key} backlog=${metrics.backlog.unresolvedIds.join(',')}`)
  console.log('SELFTEST OK')
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) return selfTest()
  if (argv.length === 0 || argv.includes('--help')) {
    console.log(
      [
        'SOC Metrics Dashboard',
        '  --input records.json [--as-of ISO] [--top 5] [--json|--markdown]',
        '  --samples file.js [file2.js ...] [--json|--markdown]',
        '  --demo                       使用内置示例记录',
        '  --self-test',
      ].join('\n'),
    )
    if (argv.length === 0) process.exitCode = 2
    return
  }
  const valueFlags = new Set(['--input', '--as-of', '--top'])
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (valueFlags.has(arg)) {
      index += 1
      continue
    }
    if (!arg.startsWith('--')) files.push(arg)
  }
  let records
  if (argv.includes('--demo')) {
    records = syntheticRecords()
  } else if (option(argv, '--input', null)) {
    const raw = JSON.parse(await readFile(option(argv, '--input'), 'utf8'))
    records = Array.isArray(raw) ? raw : (raw.records ?? raw.alerts ?? [])
  } else if (files.length > 0) {
    const samples = await Promise.all(files.map(async (file) => ({ name: file.split('/').pop(), source: await readFile(file, 'utf8') })))
    records = await generateRecords(samples)
  } else {
    throw new Error('provide --input, --samples or --demo')
  }
  const metrics = computeMetrics(records, {
    asOf: option(argv, '--as-of', undefined),
    top: Number(option(argv, '--top', '5')),
  })
  if (argv.includes('--json')) console.log(JSON.stringify(metrics, null, 2))
  else if (argv.includes('--markdown')) process.stdout.write(renderMarkdown(metrics))
  else process.stdout.write(renderAscii(metrics))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
