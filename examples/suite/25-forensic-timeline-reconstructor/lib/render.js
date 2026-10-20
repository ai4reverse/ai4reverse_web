/**
 * Timeline renderers.
 *
 * Markdown is the analyst-facing artefact (share in an incident ticket); JSON is
 * the machine contract. Both are pure functions of the timeline object, so the
 * same reconstruction always renders byte-identically.
 */

const formatOffset = (ms) => {
  if (!Number.isFinite(ms)) return '—'
  const sign = ms < 0 ? '-' : '+'
  const absolute = Math.abs(ms)
  if (absolute < 1000) return `${sign}${absolute}ms`
  return `${sign}${(absolute / 1000).toFixed(3)}s`
}

const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

const formatHost = (ms) => (Number.isFinite(ms) ? formatOffset(ms) : '—')

/** Render the timeline as a Chinese-labelled Markdown dossier section. */
export function renderTimelineMarkdown(timeline, options = {}) {
  const includeHostClock = options.includeHostClock === true
  const maxRows = Number.isFinite(options.maxRows) ? options.maxRows : 400
  const lines = []
  lines.push(`# 取证时间线 / Forensic timeline — ${timeline.sample.name}`, '')
  lines.push('| 属性 | 值 |', '| --- | --- |')
  lines.push(`| 样本 SHA-256 | \`${timeline.sample.sha256.slice(0, 32)}…\` |`)
  lines.push(`| 分析判定 | ${timeline.sample.verdict ?? 'unknown'} (${timeline.sample.score ?? '—'}/100) |`)
  lines.push(`| 虚拟时钟起点 | ${timeline.clocks.virtualBaseIso ?? '—'} |`)
  lines.push(`| 覆盖时长 | ${formatOffset(timeline.clocks.durationMs)} |`)
  lines.push(
    `| 条目 | ${timeline.summary.entries}（静态 ${timeline.summary.static} / 动态 ${timeline.summary.dynamic} / 产物 ${timeline.summary.artifacts}） |`,
  )
  lines.push(`| 宿主墙钟 | ${timeline.clocks.hostClock} |`, '')

  lines.push('## 1. 阶段标记 / Stage markers', '')
  lines.push('| 阶段 | 首次出现 | 虚拟时间 | 序号 | 代表事件 | 条目数 |', '| --- | --- | --- | ---: | --- | ---: |')
  for (const marker of timeline.markers) {
    lines.push(
      `| ${marker.stage} | ${formatOffset(marker.offsetMs)} | ${marker.virtualIso ?? '—'} | ${marker.seq ?? '—'} | ${escapeCell(marker.action)} | ${marker.count} |`,
    )
  }
  if (timeline.markers.length === 0) lines.push('| — | — | — | — | 无动态阶段 | 0 |')
  lines.push('')

  lines.push('## 2. 执行时间线 / Timeline', '')
  const header = ['偏移', '虚拟时间', '层', '阶段', '事件', '详情']
  if (includeHostClock) header.splice(2, 0, '宿主Δ')
  lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`)
  const rows = timeline.entries.slice(0, maxRows)
  for (const entry of rows) {
    const cells = [formatOffset(entry.offsetMs), entry.virtualIso ?? '—']
    if (includeHostClock) cells.push(formatHost(entry.hostOffsetMs))
    cells.push(entry.layer, entry.stage, escapeCell(entry.action), escapeCell(entry.detail))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  if (timeline.entries.length > rows.length) {
    lines.push(`| … | | | | ${timeline.entries.length - rows.length} 条已截断 | |`)
  }
  lines.push('')

  lines.push('## 3. 时间空洞 / Gaps', '')
  if (timeline.gaps.length === 0) {
    lines.push('未检测到超过阈值的时间空洞。')
  } else {
    lines.push('| 起始偏移 | 间隔 | 前一事件 | 后一事件 | 阶段变化 |', '| --- | ---: | --- | --- | --- |')
    for (const gap of timeline.gaps) {
      lines.push(
        `| ${formatOffset(gap.atOffsetMs)} | ${formatOffset(gap.deltaMs)} | ${escapeCell(gap.afterAction)} | ${escapeCell(gap.beforeAction)} | ${gap.fromStage} → ${gap.toStage} |`,
      )
    }
  }
  lines.push('')

  lines.push('## 4. 异常 / Anomalies', '')
  if (timeline.anomalies.length === 0) {
    lines.push('未发现结构性异常。')
  } else {
    lines.push('| 代码 | 级别 | 说明 |', '| --- | --- | --- |')
    for (const anomaly of timeline.anomalies) {
      lines.push(`| ${anomaly.code} | ${anomaly.severity} | ${escapeCell(anomaly.detail)} |`)
    }
  }
  lines.push('')
  lines.push('## 5. 说明')
  lines.push('')
  lines.push('- 虚拟时间轴来自沙箱虚拟时钟，可确定复现；宿主墙钟默认排除在可复现输出之外。')
  lines.push('- 事件顺序按 (阶段桶, 虚拟偏移, 序号) 排序，同一输入必然产生同一顺序。')
  lines.push('- 时间空洞不等同于恶意行为：休眠/定时器等待与追踪丢包都会产生空洞，需结合事件内容判断。')
  return `${lines.join('\n')}\n`
}

/** Render a compact JSON view (drops nulls, keeps determinism). */
export function renderTimelineJson(timeline, options = {}) {
  const includeHostClock = options.includeHostClock === true
  return {
    sample: timeline.sample,
    clocks: timeline.clocks,
    stageOrder: timeline.stageOrder,
    summary: timeline.summary,
    markers: timeline.markers,
    entries: timeline.entries.map((entry) => {
      const projected = {
        id: entry.id,
        layer: entry.layer,
        phase: entry.phase,
        stage: entry.stage,
        action: entry.action,
        detail: entry.detail,
        offsetMs: entry.offsetMs,
        virtualIso: entry.virtualIso,
        seq: entry.seq,
      }
      if (includeHostClock) projected.hostOffsetMs = entry.hostOffsetMs
      return projected
    }),
    gaps: timeline.gaps,
    anomalies: timeline.anomalies,
  }
}

export { formatOffset }
