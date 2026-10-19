import { shortHash } from '../util/hash.js'
import { limitMessage } from '../sandbox/limits.js'

/**
 * Traceless invocation.
 *
 * A sample must not be able to tell *how* it was invoked:
 *  - the script filename looks like a normal web resource (never `sandbox.js`,
 *    `eval.js` or a host path), because stacks and `document.currentScript.src`
 *    expose it;
 *  - invocation goes through a plain global-scope evaluation, so `this`,
 *    `var`-to-global semantics, `arguments` and strict-mode directives behave
 *    exactly as in a browser script tag;
 *  - entry-point calls go through the guest's own function object (no host
 *    wrapper frames);
 *  - every QuickJS handle created on the boundary is disposed, so a run leaves
 *    no residue that a later run could observe.
 */
export function createInvoker(options) {
  const {
    ctx,
    runtime,
    bridge,
    stealth,
    profile,
    clock,
    trace,
    logger,
    limits,
    hooks,
    instrumentation,
  } = options

  let invocationCount = 0

  function resolveFilename({ sourceUrl, filename, kind = 'script', source } = {}) {
    if (filename) return filename
    if (sourceUrl) {
      try {
        const url = new URL(sourceUrl)
        url.hash = ''
        return url.href
      } catch {
        return String(sourceUrl)
      }
    }
    const digest = shortHash(String(source ?? ''), 8)
    const prefix = profile.origin
    if (kind === 'module') return `${prefix}/assets/app.${digest}.mjs`
    if (kind === 'eval') return `${prefix}/blank.html`
    return `${prefix}/static/js/${digest}.min.js`
  }

  /**
   * Evaluate one source text.
   * @param {string} source
   * @param {object} [runOptions]
   * @param {string} [runOptions.sourceUrl]
   * @param {string} [runOptions.filename]
   * @param {'script'|'module'} [runOptions.type]
   * @param {'off'|'function'|'branch'|'statement'} [runOptions.level]
   * @param {string} [runOptions.entry] call this global function after evaluation
   * @param {unknown[]} [runOptions.args]
   */
  function invoke(source, runOptions = {}) {
    invocationCount += 1
    const text = String(source ?? '')
    if (Buffer.byteLength(text, 'utf8') > limits.maxSourceBytes) {
      const error = {
        name: 'RangeError',
        message: limitMessage('source-size', limits),
        code: 'SANDBOX_LIMIT',
      }
      trace?.emit('sandbox', 'error', { event: 'source.too-large', bytes: text.length })
      return { ok: false, error, limitsHit: ['source-size'] }
    }

    const mode = runOptions.type === 'module' ? 'module' : 'script'
    const filename = resolveFilename({
      sourceUrl: runOptions.sourceUrl,
      filename: runOptions.filename,
      kind: mode === 'module' ? 'module' : 'script',
      source: text,
    })

    const prepared = instrumentation
      ? instrumentation.prepare(text, {
          filename,
          level: runOptions.level,
          sourceType: mode,
        })
      : { code: text, plan: new Map(), facts: null, vm: null, stats: { insertions: 0 } }

    const startedAt = Date.now()
    let evalResult
    try {
      evalResult = ctx.evalCode(prepared.code, filename, { type: mode })
    } catch (error) {
      // QuickJS surfaces native stack exhaustion as a host RangeError instead
      // of a guest exception. Treat it as a stack limit and keep the record
      // structured so the report can say what happened.
      if (/call stack|stack overflow|too deep/i.test(String(error?.message))) {
        const dumped = { name: 'RangeError', message: 'Maximum call stack size exceeded', stack: '' }
        instrumentation?.exceptions?.reportUncaught(dumped, 'eval', { filename, limitsHit: ['stack'] })
        trace?.emit('code', 'error', { event: 'invoke.stack-overflow', filename })
        return {
          ok: false,
          error: dumped,
          limitsHit: ['stack'],
          timedOut: false,
          filename,
          prepared,
          facts: prepared.facts,
          vm: prepared.vm,
          durationMs: Date.now() - startedAt,
          virtualMs: Math.round(clock.elapsedMs),
        }
      }
      throw error
    }
    const durationMs = Date.now() - startedAt

    if (evalResult.error) {
      const dumped = stealth?.sanitizeError ? stealth.sanitizeError(ctx.dump(evalResult.error)) : ctx.dump(evalResult.error)
      evalResult.error.dispose()
      const classified = classifyLimit(dumped, runtime, limits)
      if (instrumentation?.exceptions) {
        instrumentation.exceptions.reportUncaught(dumped, mode === 'module' ? 'module' : 'eval', { filename })
      }
      trace?.emit('code', 'error', { event: 'invoke.failed', filename, error: dumped, limitsHit: classified ? [classified] : [] })
      hooks?.emit('code:error', {
        source: text,
        filename,
        error: dumped,
        limitsHit: classified ? [classified] : [],
        prepared,
      })
      hooks?.emit('code:after', { source: text, filename, error: dumped, prepared, ok: false, limitsHit: classified ? [classified] : [] })
      return {
        ok: false,
        error: dumped,
        limitsHit: classified ? [classified] : [],
        timedOut: classified === 'timeout' || classified === 'virtual-time',
        filename,
        prepared,
        facts: prepared.facts,
        vm: prepared.vm,
        durationMs,
        virtualMs: Math.round(clock.elapsedMs),
      }
    }

    let valueHandle = evalResult.value
    let entryResult = null
    try {
      if (runOptions.entry) {
        entryResult = callEntry(runOptions.entry, runOptions.args ?? [], { filename })
        if (!entryResult.ok) {
          return {
            ok: false,
            error: entryResult.error,
            limitsHit: [],
            filename,
            prepared,
            facts: prepared.facts,
            vm: prepared.vm,
            durationMs,
            virtualMs: Math.round(clock.elapsedMs),
          }
        }
      }
      const raw = entryResult?.ok ? entryResult.handle : valueHandle
      const dumped = ctx.dump(raw)
      const summary = summarizeResult(dumped)
      trace?.emit('code', 'after', {
        event: 'invoke.ok',
        filename,
        resultType: summary.type,
        preview: summary.preview,
        instrumented: prepared.stats?.insertions ?? 0,
        virtualMs: Math.round(clock.elapsedMs),
      })
      hooks?.emit('code:after', {
        source: text,
        filename,
        result: summary,
        prepared,
        ok: true,
        limitsHit: [],
      })
      return {
        ok: true,
        result: summary,
        value: summary.value,
        filename,
        prepared,
        facts: prepared.facts,
        vm: prepared.vm,
        durationMs,
        virtualMs: Math.round(clock.elapsedMs),
      }
    } finally {
      // Entry-point call owns its returned handle; the eval result handle is
      // always ours to release.
      if (entryResult?.ok && entryResult.handle) {
        try {
          entryResult.handle.dispose()
        } catch {
          /* already released */
        }
      }
      try {
        valueHandle?.dispose?.()
      } catch {
        /* already released */
      }
    }
  }

  /**
   * Call a global function after evaluation. Used for entry-point samples
   * (`window.start(...)`, `_0x1234()`), invoked from the host without wrappers.
   * @param {string} name
   * @param {unknown[]} args
   * @param {{filename?: string}} [meta]
   */
  function callEntry(name, args, meta = {}) {
    const entryHandle = safeProp(ctx, ctx.global, name)
    if (!entryHandle) {
      return {
        ok: false,
        error: { name: 'ReferenceError', message: `${name} is not defined`, code: 'ENTRY_NOT_FOUND' },
      }
    }
    if (ctx.typeof(entryHandle) !== 'function') {
      entryHandle.dispose()
      return {
        ok: false,
        error: { name: 'TypeError', message: `${name} is not a function`, code: 'ENTRY_NOT_CALLABLE' },
      }
    }
    const argHandles = []
    try {
      for (const arg of args) argHandles.push(bridge.toGuest(arg))
      const result = ctx.callFunction(entryHandle, ctx.global, argHandles)
      if (result.error) {
        const dumped = stealth?.sanitizeError ? stealth.sanitizeError(ctx.dump(result.error)) : ctx.dump(result.error)
        result.error.dispose()
        instrumentation?.exceptions?.reportUncaught(dumped, 'call', { entry: name })
        return { ok: false, error: dumped }
      }
      trace?.emit('code', 'after', { event: 'entry.called', name, args: args.length })
      return { ok: true, handle: result.value }
    } finally {
      for (const handle of argHandles) {
        try {
          handle.dispose()
        } catch {
          /* ignore */
        }
      }
      entryHandle.dispose()
    }
  }

  /**
   * Drive the guest forward: microtasks, promise jobs, then virtual timers.
   * This is the sandbox's equivalent of a browser event loop turn.
   * @param {{maxJobs?: number, maxTimerCallbacks?: number, maxVirtualMs?: number}} [options]
   */
  function settle(options = {}) {
    const maxJobs = options.maxJobs ?? limits.maxJobs
    const maxTimerCallbacks = options.maxTimerCallbacks ?? limits.maxTimerCallbacks
    const maxVirtualMs = options.maxVirtualMs ?? limits.maxVirtualMs
    let jobs = 0
    let timerCallbacks = 0
    let pendingRejections = 0
    let exhausted = false

    const drainMicro = () => {
      try {
        bridge.drainMicrotasks?.()
      } catch (error) {
        logger?.debug?.({ err: error.message }, 'microtask drain failed')
      }
    }

    for (let guard = 0; guard < 100_000; guard += 1) {
      drainMicro()
      if (runtime.hasPendingJob()) {
        if (jobs >= maxJobs) {
          exhausted = true
          break
        }
        const result = runtime.executePendingJobs(100)
        if (result.error) {
          const dumped = stealth?.sanitizeError ? stealth.sanitizeError(ctx.dump(result.error)) : ctx.dump(result.error)
          result.error.dispose()
          instrumentation?.exceptions?.reportPromiseJob(dumped)
          pendingRejections += 1
        } else {
          jobs += typeof result.value === 'number' ? result.value : 1
          result.value?.dispose?.()
        }
        continue
      }

      const dueIn = clock.nextDueIn()
      if (!Number.isFinite(dueIn)) break
      if (clock.elapsedMs + Math.max(dueIn, 0) > maxVirtualMs) {
        exhausted = true
        break
      }
      const remaining = Math.max(0, maxTimerCallbacks - timerCallbacks)
      if (remaining === 0) {
        exhausted = true
        break
      }
      const run = clock.runDue({ maxCallbacks: remaining, maxVirtualMs })
      timerCallbacks += run.executed
      for (const error of run.errors) {
        instrumentation?.exceptions?.reportUncaught(
          { name: 'Error', message: error.message },
          'timer',
          { timerId: error.timerId },
        )
      }
      if (run.executed === 0) break
    }

    if (exhausted) {
      trace?.emit('sandbox', 'error', { event: 'settle.exhausted', jobs, timerCallbacks, maxJobs, maxTimerCallbacks })
    }
    return {
      jobs,
      timerCallbacks,
      promiseErrors: pendingRejections,
      exhausted,
      pendingTimers: bridge.pendingTimers?.() ?? clock.pending(),
      virtualMs: Math.round(clock.elapsedMs),
    }
  }

  return {
    invoke,
    callEntry,
    settle,
    resolveFilename,
    stats() {
      return { invocations: invocationCount, virtualMs: Math.round(clock.elapsedMs) }
    },
  }
}

function safeProp(ctx, target, key) {
  try {
    const handle = ctx.getProp(target, key)
    return handle
  } catch {
    return null
  }
}

function classifyLimit(dumped, runtime, limits) {
  const message = String(dumped?.message ?? '')
  if (runtime.state?.reason === 'timeout') return 'timeout'
  if (runtime.state?.reason === 'virtual-time') return 'virtual-time'
  if (/interrupted/i.test(message)) return 'timeout'
  if (/out of memory|allocation failed|string too long|array too long|memory limit/i.test(message)) return 'memory'
  if (/stack overflow|too deep|Maximum call stack/i.test(message)) return 'stack'
  if (/source/i.test(message) && /too large/i.test(message)) return 'source-size'
  void limits
  return null
}

function summarizeResult(dumped) {
  if (dumped === undefined) return { type: 'undefined' }
  if (dumped === null) return { type: 'null', value: null }
  const type = Array.isArray(dumped) ? 'array' : typeof dumped
  if (type === 'string') {
    return {
      type,
      value: dumped.length <= 4096 ? dumped : undefined,
      preview: dumped.length > 4096 ? `${dumped.slice(0, 4096)}…` : dumped,
      length: dumped.length,
    }
  }
  if (type === 'number' || type === 'boolean') return { type, value: dumped, preview: String(dumped) }
  if (type === 'array') {
    let preview
    try {
      preview = JSON.stringify(dumped).slice(0, 4096)
    } catch {
      preview = '[array]'
    }
    return { type, preview, length: dumped.length }
  }
  if (type === 'object') {
    let preview
    try {
      preview = JSON.stringify(dumped).slice(0, 4096)
    } catch {
      preview = '[object]'
    }
    return { type, preview, keys: Object.keys(dumped).slice(0, 50) }
  }
  return { type }
}

export { summarizeResult }
