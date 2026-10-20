#!/usr/bin/env node
/**
 * Sandbox Scheduler — a bounded, priority-ordered execution planner on top of the
 * traceless sandbox.
 *
 * The scheduler owns the four things a shared analysis cluster must get right:
 *
 *   capacity     never more concurrent QuickJS isolates than the host can carry
 *   priority     critical work is admitted before bulk work, deterministically
 *   fairness     per-tenant concurrency, per-tenant queue ceilings, timeout budgets
 *   durability   bounded retries with exponential backoff, every isolate disposed
 *
 * Admission order is recorded explicitly, so concurrent execution never obscures
 * the scheduling decision that was made.
 *
 *   <sample...> [--capacity 2] [--tenant acme] [--priority high] [--json] / --self-test
 */
import { readFile } from 'node:fs/promises'
import { TracelessSandbox } from '../../../tools/index.js'

/** Lower number wins. Names are accepted for CLI/REST friendliness. */
export const PRIORITIES = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 })

export const DEFAULT_SCHEDULER_OPTIONS = Object.freeze({
  capacity: 2,
  tenantConcurrency: 1,
  tenantQueueLimit: 8,
  maxAttempts: 2,
  backoffBaseMs: 25,
  maxBackoffMs: 1000,
  maxTimeoutMs: 2500,
  defaultTimeoutMs: 800,
  seed: 0x5eed,
  retryOn: ['timeout', 'error', 'host-error'],
})

/** Map a run classification onto the retry policy vocabulary. */
export function retryKind(classification) {
  if (classification === 'completed') return 'completed'
  if (classification === 'limit:timeout') return 'timeout'
  if (classification === 'host-error') return 'host-error'
  if (classification === 'error') return 'error'
  return 'other'
}

function normalizePriority(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(9, Math.trunc(value)))
  const name = String(value ?? 'normal').toLowerCase()
  if (!(name in PRIORITIES)) throw new Error(`unknown priority ${value} (expected ${Object.keys(PRIORITIES).join('|')})`)
  return PRIORITIES[name]
}

function priorityName(score) {
  const match = Object.entries(PRIORITIES).find(([, value]) => value === score)
  return match ? match[0] : String(score)
}

/**
 * @param {object} [options]
 * @param {number} [options.capacity] global concurrent isolate ceiling
 * @param {number} [options.tenantConcurrency] default per-tenant ceiling
 * @param {number} [options.tenantQueueLimit] default per-tenant pending ceiling
 * @param {Record<string, {concurrency?: number, queueLimit?: number, budgetMs?: number}>} [options.tenants]
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable backoff timer
 */
export function createScheduler(options = {}) {
  const config = { ...DEFAULT_SCHEDULER_OPTIONS, ...options }
  if (!Number.isInteger(config.capacity) || config.capacity < 1) throw new Error('capacity must be a positive integer')
  if (config.maxAttempts < 1) throw new Error('maxAttempts must be >= 1')
  const tenants = options.tenants ?? {}
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const retryOn = new Set(config.retryOn)

  const pending = []
  const inFlight = new Set()
  const timers = new Set()
  const records = []
  const byId = new Map()
  const active = new Map()
  const rejected = []
  const admissionOrder = []
  const peak = { global: 0, byTenant: {} }
  const counters = {
    submitted: 0,
    accepted: 0,
    rejected: 0,
    attempts: 0,
    completed: 0,
    timeouts: 0,
    errors: 0,
    retries: 0,
    disposed: 0,
    disposalFailures: 0,
    backoffMs: 0,
  }
  let started = false
  let submittedSeq = 0

  const tenantConfig = (tenant) => {
    const override = tenants[tenant] ?? {}
    return {
      concurrency: override.concurrency ?? config.tenantConcurrency,
      queueLimit: override.queueLimit ?? config.tenantQueueLimit,
      budgetMs: override.budgetMs ?? Number.POSITIVE_INFINITY,
    }
  }

  const compare = (left, right) =>
    left.priority - right.priority || left.submittedAt - right.submittedAt || left.id.localeCompare(right.id)

  const sortPending = () => pending.sort(compare)

  /** Re-queue after a backoff delay. The isolate slot is already released, and the
   * timer keeps `run()` alive so a retry is never dropped at the end of the queue. */
  const scheduleRetry = (task, delay) => {
    let timer = null
    timer = sleep(delay).then(() => {
      timers.delete(timer)
      pending.push(task)
      sortPending()
    })
    timers.add(timer)
  }

  const bumpPeak = (tenant) => {
    if (inFlight.size > peak.global) peak.global = inFlight.size
    const current = active.get(tenant) ?? 0
    const tenantPeak = peak.byTenant[tenant] ?? 0
    if (current > tenantPeak) peak.byTenant[tenant] = current
  }

  const runAttempt = async (task) => {
    let sandbox = null
    let disposed = false
    try {
      sandbox = await TracelessSandbox.create({
        seed: config.seed,
        logLevel: 'silent',
        limits: { timeoutMs: task.effectiveTimeoutMs },
      })
      const run = await sandbox.run(task.source, { filename: `https://range.example.test/${task.id}.js` })
      const classification = run.ok ? 'completed' : run.limitsHit.length > 0 ? `limit:${run.limitsHit[0]}` : 'error'
      return {
        classification,
        ok: run.ok,
        virtualMs: run.virtualMs,
        limitsHit: run.limitsHit,
        result: run.result ?? null,
        error: run.error?.message ?? null,
        disposalOk: run.disposal?.ok === true,
      }
    } catch (error) {
      return { classification: 'host-error', ok: false, virtualMs: 0, limitsHit: [], result: null, error: error.message, disposalOk: false }
    } finally {
      try {
        task.created = sandbox !== null
        sandbox?.dispose()
        disposed = sandbox !== null
      } catch {
        disposed = false
      }
      task.disposed = disposed
    }
  }

  const admitOne = () => {
    if (inFlight.size >= config.capacity) return false
    const index = pending.findIndex((task) => (active.get(task.tenant) ?? 0) < tenantConfig(task.tenant).concurrency)
    if (index < 0) return false
    const [task] = pending.splice(index, 1)
    const tenant = task.tenant
    active.set(tenant, (active.get(tenant) ?? 0) + 1)
    task.attempt += 1
    const attemptNo = task.attempt
    admissionOrder.push(`${task.id}#${attemptNo}`)
    const promise = runAttempt(task)
      .then((outcome) => {
        counters.attempts += 1
        if (task.disposed) counters.disposed += 1
        if (task.created && (!task.disposed || !outcome.disposalOk)) counters.disposalFailures += 1
        if (outcome.classification === 'completed') counters.completed += 1
        else if (outcome.classification === 'limit:timeout') counters.timeouts += 1
        else counters.errors += 1
        const record = byId.get(task.id)
        const attempt = {
          attempt: attemptNo,
          classification: outcome.classification,
          ok: outcome.ok,
          virtualMs: outcome.virtualMs,
          limitsHit: outcome.limitsHit,
          error: outcome.error,
          effectiveTimeoutMs: task.effectiveTimeoutMs,
          disposalOk: outcome.disposalOk,
          disposed: task.disposed,
          backoffMs: 0,
        }
        record.attempts.push(attempt)
        record.runs += 1
        if (outcome.ok) {
          record.status = 'completed'
          record.result = outcome.result
        } else {
          const kind = retryKind(outcome.classification)
          const canRetry = retryOn.has(kind) && attemptNo < task.maxAttempts
          if (canRetry) {
            const delay = Math.min(config.maxBackoffMs, config.backoffBaseMs * 2 ** (attemptNo - 1))
            attempt.backoffMs = delay
            record.retries += 1
            record.backoffMs += delay
            counters.retries += 1
            counters.backoffMs += delay
            record.status = 'retrying'
          } else {
            record.status = 'failed'
            record.failure = { classification: outcome.classification, error: outcome.error }
          }
        }
        if (record.status === 'retrying') scheduleRetry(task, attempt.backoffMs)
      })
      .catch((error) => {
        const record = byId.get(task.id)
        record.status = 'failed'
        record.failure = { classification: 'host-error', error: error.message }
        counters.errors += 1
      })
      .finally(() => {
        inFlight.delete(promise)
        active.set(tenant, (active.get(tenant) ?? 1) - 1)
      })
    inFlight.add(promise)
    bumpPeak(tenant)
    return true
  }

  const scheduler = {
    config,
    /** Enqueue a sample. Rejections are recorded, never silently dropped. */
    submit(task) {
      if (started) throw new Error('cannot submit after run()')
      const id = String(task.id ?? `task-${records.length + 1}`)
      if (byId.has(id)) throw new Error(`duplicate task id ${id}`)
      const source = typeof task.source === 'string' ? task.source : ''
      if (source.trim().length === 0) throw new Error(`task ${id} has an empty source`)
      const tenant = String(task.tenant ?? 'default')
      const limits = tenantConfig(tenant)
      const priority = normalizePriority(task.priority)
      submittedSeq += 1
      counters.submitted += 1
      const record = {
        id,
        tenant,
        priority,
        priorityName: priorityName(priority),
        submittedAt: submittedSeq,
        attempts: [],
        runs: 0,
        retries: 0,
        backoffMs: 0,
        status: 'queued',
        result: null,
        failure: null,
      }
      const queuedForTenant = records.filter((item) => item.tenant === tenant && item.status === 'queued').length
      if (queuedForTenant >= limits.queueLimit) {
        counters.rejected += 1
        record.status = 'rejected'
        record.failure = { classification: 'rejected', error: `tenant queue limit ${limits.queueLimit} reached` }
        records.push(record)
        byId.set(id, record)
        rejected.push({ id, tenant, reason: 'tenant-queue-full', queueLimit: limits.queueLimit })
        return { accepted: false, id, tenant, reason: 'tenant-queue-full', queueLimit: limits.queueLimit }
      }
      const requestedTimeoutMs = Number(task.timeoutMs ?? config.defaultTimeoutMs)
      if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) throw new Error(`task ${id} timeoutMs must be positive`)
      const effectiveTimeoutMs = Math.min(Math.max(requestedTimeoutMs, 50), config.maxTimeoutMs, limits.budgetMs)
      records.push(record)
      byId.set(id, record)
      counters.accepted += 1
      pending.push({
        id,
        tenant,
        priority,
        source,
        submittedAt: submittedSeq,
        attempt: 0,
        maxAttempts: Math.max(1, Number(task.maxAttempts ?? config.maxAttempts)),
        requestedTimeoutMs,
        effectiveTimeoutMs,
        disposed: false,
      })
      sortPending()
      return { accepted: true, id, tenant, priority: priorityName(priority), effectiveTimeoutMs }
    },

    /** Drain the queue. Returns the aggregated report. */
    async run() {
      started = true
      while (pending.length > 0 || inFlight.size > 0 || timers.size > 0) {
        while (admitOne()) {
          /* fill every free slot, in priority order */
        }
        if (pending.length === 0 && inFlight.size === 0 && timers.size === 0) break
        const waits = [...inFlight, ...timers]
        if (waits.length === 0) break
        await Promise.race(waits)
      }
      return scheduler.report()
    },

    report() {
      const byTenant = {}
      for (const record of records) {
        const entry = byTenant[record.tenant] ?? {
          submitted: 0,
          accepted: 0,
          rejected: 0,
          runs: 0,
          retries: 0,
          completed: 0,
          failed: 0,
          timeouts: 0,
          virtualMs: 0,
          peakConcurrency: peak.byTenant[record.tenant] ?? 0,
        }
        entry.submitted += 1
        if (record.status === 'rejected') entry.rejected += 1
        else entry.accepted += 1
        entry.runs += record.runs
        entry.retries += record.retries
        if (record.status === 'completed') entry.completed += 1
        if (record.status === 'failed') entry.failed += 1
        for (const attempt of record.attempts) {
          entry.virtualMs += attempt.virtualMs
          if (attempt.classification === 'limit:timeout') entry.timeouts += 1
        }
        byTenant[record.tenant] = entry
      }
      for (const entry of Object.values(byTenant)) {
        entry.avgVirtualMs = entry.runs === 0 ? 0 : Math.round(entry.virtualMs / entry.runs)
      }
      return {
        capacity: config.capacity,
        tenantConcurrency: config.tenantConcurrency,
        tenantQueueLimit: config.tenantQueueLimit,
        maxAttempts: config.maxAttempts,
        backoff: { baseMs: config.backoffBaseMs, capMs: config.maxBackoffMs },
        counters: { ...counters },
        admissionOrder: [...admissionOrder],
        peakConcurrency: { global: peak.global, byTenant: { ...peak.byTenant } },
        rejected: [...rejected],
        tasks: records.map((record) => ({
          id: record.id,
          tenant: record.tenant,
          priority: record.priorityName,
          status: record.status,
          attempts: record.attempts,
          runs: record.runs,
          retries: record.retries,
          backoffMs: record.backoffMs,
          result: record.result,
          failure: record.failure,
        })),
        tenants: byTenant,
        tasksCompleted: records.filter((record) => record.status === 'completed').length,
        tasksFailed: records.filter((record) => record.status === 'failed').length,
        tasksRejected: records.filter((record) => record.status === 'rejected').length,
        allDisposed: counters.disposalFailures === 0 && counters.attempts > 0,
      }
    },
  }

  return scheduler
}

const SAMPLES = Object.freeze({
  benign: 'var total = 0; for (var i = 0; i < 100; i += 1) total += i; total;',
  beacon: 'fetch("https://c2.example.test/beacon").catch(function () {}); localStorage.setItem("k", "v"); "beaconed";',
  spin: 'while (true) {}',
  crash: 'null.x();',
})

async function selfTest() {
  // 1. Priority ordering: capacity 1 makes the admission order observable.
  const ordered = createScheduler({ capacity: 1, sleep: async () => {}, defaultTimeoutMs: 600 })
  const submissions = [
    { id: 't-closure', tenant: 'acme', priority: 'low', source: SAMPLES.benign },
    { id: 't-critical', tenant: 'globex', priority: 'critical', source: SAMPLES.beacon },
    { id: 't-normal', tenant: 'acme', priority: 'normal', source: SAMPLES.benign },
    { id: 't-high', tenant: 'globex', priority: 'high', source: SAMPLES.benign },
  ]
  for (const task of submissions) {
    const accepted = ordered.submit(task)
    if (!accepted.accepted) throw new Error(`task ${task.id} rejected unexpectedly`)
  }
  const orderReport = await ordered.run()
  const expectedOrder = ['t-critical#1', 't-high#1', 't-normal#1', 't-closure#1']
  if (orderReport.admissionOrder.join(',') !== expectedOrder.join(',')) {
    throw new Error(`admission order ${orderReport.admissionOrder.join(',')} != ${expectedOrder.join(',')}`)
  }
  if (orderReport.peakConcurrency.global !== 1) throw new Error(`capacity 1 exceeded: ${orderReport.peakConcurrency.global}`)
  if (orderReport.tasksCompleted !== 4) throw new Error(`expected 4 completions, got ${orderReport.tasksCompleted}`)
  if (!orderReport.allDisposed) throw new Error('scheduler leaked an isolate')
  const criticalRecord = orderReport.tasks.find((task) => task.id === 't-critical')
  if (criticalRecord.priority !== 'critical') throw new Error('priority label lost')

  // 2. Retry, timeout budgets, two tenants, quotas and disposal.
  const retrying = createScheduler({
    capacity: 2,
    tenants: { acme: { concurrency: 1, budgetMs: 400 }, globex: { concurrency: 2 } },
    maxAttempts: 3,
    backoffBaseMs: 20,
    sleep: async () => {},
    defaultTimeoutMs: 150,
  })
  retrying.submit({ id: 'spin', tenant: 'acme', priority: 'high', source: SAMPLES.spin, timeoutMs: 120, maxAttempts: 3 })
  retrying.submit({ id: 'crash', tenant: 'globex', priority: 'normal', source: SAMPLES.crash, maxAttempts: 2 })
  retrying.submit({ id: 'good', tenant: 'globex', priority: 'normal', source: SAMPLES.beacon })
  retrying.submit({ id: 'bulk', tenant: 'acme', priority: 'low', source: SAMPLES.benign, timeoutMs: 5000 })
  const retryReport = await retrying.run()
  const spin = retryReport.tasks.find((task) => task.id === 'spin')
  if (spin.status !== 'failed') throw new Error(`spin should exhaust retries, got ${spin.status}`)
  if (spin.attempts.length !== 3) throw new Error(`spin attempts ${spin.attempts.length} != 3`)
  if (spin.retries !== 2) throw new Error(`spin retries ${spin.retries} != 2`)
  for (const attempt of spin.attempts) {
    if (attempt.classification !== 'limit:timeout') throw new Error(`spin classification ${attempt.classification}`)
    if (attempt.effectiveTimeoutMs !== 120) throw new Error(`spin timeout budget ${attempt.effectiveTimeoutMs} != 120`)
    if (!attempt.disposalOk || !attempt.disposed) throw new Error('timeout attempt was not disposed')
  }
  if (spin.attempts[0].backoffMs !== 20 || spin.attempts[1].backoffMs !== 40) {
    throw new Error(`backoff schedule ${spin.attempts.map((attempt) => attempt.backoffMs).join(',')}`)
  }
  if (spin.attempts[2].backoffMs !== 0) throw new Error('last attempt must not back off')
  if (spin.backoffMs !== 60) throw new Error(`spin total backoff ${spin.backoffMs} != 60`)

  const crash = retryReport.tasks.find((task) => task.id === 'crash')
  if (crash.status !== 'failed' || crash.attempts.length !== 2) throw new Error(`crash retry ${crash.status}/${crash.attempts.length}`)
  if (crash.attempts[0].classification !== 'error') throw new Error(`crash classification ${crash.attempts[0].classification}`)
  if (!crash.attempts.every((attempt) => attempt.disposalOk)) throw new Error('crash attempt was not disposed')

  const good = retryReport.tasks.find((task) => task.id === 'good')
  if (good.status !== 'completed' || good.retries !== 0) throw new Error(`good task ${good.status}/${good.retries}`)
  if (good.result?.value !== 'beaconed') throw new Error(`good result ${JSON.stringify(good.result)}`)

  const bulk = retryReport.tasks.find((task) => task.id === 'bulk')
  if (bulk.attempts[0].effectiveTimeoutMs !== 400) throw new Error(`budget clamp failed: ${bulk.attempts[0].effectiveTimeoutMs}`)

  if (retryReport.peakConcurrency.byTenant.acme > 1) throw new Error(`acme quota breached: ${retryReport.peakConcurrency.byTenant.acme}`)
  if (retryReport.peakConcurrency.byTenant.globex > 2) throw new Error(`globex quota breached: ${retryReport.peakConcurrency.byTenant.globex}`)
  if (retryReport.peakConcurrency.global > 2) throw new Error(`global capacity breached: ${retryReport.peakConcurrency.global}`)
  if (retryReport.counters.disposalFailures !== 0) throw new Error(`disposal failures ${retryReport.counters.disposalFailures}`)
  if (retryReport.counters.attempts !== retryReport.counters.disposed) throw new Error('attempt/disposal accounting drift')
  if (retryReport.counters.retries !== 3) throw new Error(`retries ${retryReport.counters.retries} != 3`)
  if (retryReport.counters.timeouts !== 3) throw new Error(`timeouts ${retryReport.counters.timeouts} != 3`)
  if (retryReport.tenants.acme.retries !== 2) throw new Error('per-tenant retry aggregation failed')
  if (retryReport.tenants.globex.completed !== 1) throw new Error('per-tenant completion aggregation failed')

  // 3. Per-tenant queue ceiling: 5 submissions, queueLimit 2.
  const limited = createScheduler({ capacity: 2, tenantQueueLimit: 2, sleep: async () => {}, defaultTimeoutMs: 400 })
  const outcomes = []
  for (let index = 0; index < 5; index += 1) {
    outcomes.push(limited.submit({ id: `bulk-${index}`, tenant: 'acme', priority: 'normal', source: SAMPLES.benign }))
  }
  const accepted = outcomes.filter((outcome) => outcome.accepted).length
  const rejectedCount = outcomes.filter((outcome) => !outcome.accepted).length
  if (accepted !== 2 || rejectedCount !== 3) throw new Error(`queue ceiling accepted=${accepted} rejected=${rejectedCount}`)
  if (!outcomes.every((outcome, index) => index < 2 || outcome.reason === 'tenant-queue-full')) {
    throw new Error('rejection reason missing')
  }
  const limitReport = await limited.run()
  if (limitReport.rejected.length !== 3) throw new Error(`rejected list ${limitReport.rejected.length}`)
  if (limitReport.tasksRejected !== 3 || limitReport.tasksCompleted !== 2) throw new Error('task status accounting failed')
  if (limitReport.counters.submitted !== 5) throw new Error('submitted counter failed')

  // 4. Retry re-admission: a retrying task must never run twice at once, and it
  //    must not be re-queued while its previous attempt still holds a slot.
  const guarded = createScheduler({
    capacity: 2,
    tenants: { acme: { concurrency: 2 } },
    maxAttempts: 3,
    backoffBaseMs: 30,
    sleep: async () => {},
    defaultTimeoutMs: 120,
  })
  guarded.submit({ id: 'slow', tenant: 'acme', priority: 'critical', source: SAMPLES.spin, timeoutMs: 100, maxAttempts: 3 })
  guarded.submit({ id: 'fast-1', tenant: 'acme', priority: 'normal', source: SAMPLES.benign })
  guarded.submit({ id: 'fast-2', tenant: 'acme', priority: 'normal', source: SAMPLES.benign })
  const guardReport = await guarded.run()
  const slow = guardReport.tasks.find((task) => task.id === 'slow')
  if (slow.attempts.map((attempt) => attempt.attempt).join(',') !== '1,2,3') throw new Error('retry attempts out of sequence')
  if (slow.runs !== slow.attempts.length) throw new Error('run/attempt accounting drift')
  if (guardReport.peakConcurrency.byTenant.acme > 2) throw new Error('retry re-admission breached the tenant quota')
  if (!guardReport.allDisposed) throw new Error('retry path leaked an isolate')

  let postRunGuard = null
  try {
    limited.submit({ id: 'late', tenant: 'acme', source: SAMPLES.benign })
  } catch (error) {
    postRunGuard = error.message
  }
  if (!postRunGuard || !postRunGuard.includes('after run()')) throw new Error('post-run submit was not rejected')

  console.log(
    `scheduler: order=${orderReport.admissionOrder.join(',')} attempts=${retryReport.counters.attempts} retries=${retryReport.counters.retries} timeouts=${retryReport.counters.timeouts} disposed=${retryReport.counters.disposed} rejected=${limitReport.tasksRejected}`,
  )
  console.log(`peaks: global=${retryReport.peakConcurrency.global} tenants=${JSON.stringify(retryReport.peakConcurrency.byTenant)}`)
  console.log('SELFTEST OK')
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) return selfTest()
  const VALUE_FLAGS = new Set(['--capacity', '--quota', '--queue-limit', '--attempts', '--timeout', '--tenant', '--priority'])
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (VALUE_FLAGS.has(arg)) {
      index += 1
      continue
    }
    if (!arg.startsWith('--')) files.push(arg)
  }
  if (argv.length === 0 || argv.includes('--help') || files.length === 0) {
    console.log(
      [
        'Sandbox Scheduler',
        '  <sample.js...> [--capacity 2] [--tenant acme] [--priority high]',
        '                 [--timeout 800] [--attempts 2] [--quota 1] [--queue-limit 8] [--json]',
        '  --self-test',
      ].join('\n'),
    )
    if (argv.length === 0) process.exitCode = 2
    return
  }
  const scheduler = createScheduler({
    capacity: Number(option(argv, '--capacity', '2')),
    tenantConcurrency: Number(option(argv, '--quota', '1')),
    tenantQueueLimit: Number(option(argv, '--queue-limit', '8')),
    maxAttempts: Number(option(argv, '--attempts', '2')),
    defaultTimeoutMs: Number(option(argv, '--timeout', '800')),
  })
  for (const file of files) {
    const accepted = scheduler.submit({
      id: file.split('/').pop(),
      tenant: option(argv, '--tenant', 'default'),
      priority: option(argv, '--priority', 'normal'),
      timeoutMs: Number(option(argv, '--timeout', '800')),
      source: await readFile(file, 'utf8'),
    })
    if (!accepted.accepted) console.error(`rejected ${accepted.id}: ${accepted.reason}`)
  }
  const report = await scheduler.run()
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const task of report.tasks) {
    const attempt = task.attempts[0] ?? {}
    const last = task.attempts[task.attempts.length - 1] ?? {}
    console.log(
      `${task.id.padEnd(24)} ${task.tenant.padEnd(8)} ${task.priority.padEnd(9)} ${task.status.padEnd(10)} runs=${task.runs} retries=${task.retries} ${String(last.classification ?? '-').padEnd(16)} budget=${attempt.effectiveTimeoutMs ?? '-'}ms disposed=${attempt.disposed ?? false}`,
    )
  }
  console.log(
    `completed=${report.tasksCompleted} failed=${report.tasksFailed} rejected=${report.tasksRejected} attempts=${report.counters.attempts} retries=${report.counters.retries} disposed=${report.counters.disposed} peak=${report.peakConcurrency.global}`,
  )
  if (report.tasksFailed > 0) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
