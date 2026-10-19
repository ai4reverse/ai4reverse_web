import { createTraceRecorder } from './trace.js'
import { createCodeInstrumenter } from './code.js'
import { createApiInstrumenter } from './api.js'
import { createExceptionInstrumenter } from './exception.js'
import { analyzeSource, scoreObfuscation, detectTechniques } from './ast.js'
import { detectDispatch, instrumentDispatch, locateInterpreter, summarizeOpcodeTrace } from './jsvmp.js'

export { createTraceRecorder, TRACE_KINDS } from './trace.js'
export { createCodeInstrumenter } from './code.js'
export { createApiInstrumenter } from './api.js'
export { createExceptionInstrumenter } from './exception.js'
export { analyzeSource, scoreObfuscation, detectTechniques, walkAst } from './ast.js'
export { detectDispatch, instrumentDispatch, locateInterpreter, summarizeOpcodeTrace } from './jsvmp.js'

/**
 * Unified instrumentation facade used by the sandbox.
 *
 * Composition order matters:
 *   1. `install()`   – create the trace channel, wrap platform APIs.
 *   2. `prepare()`   – hook pipeline -> static analysis -> JSVMP dispatch
 *                      instrumentation -> statement/function instrumentation.
 *   3. analysis      – facts collected during `prepare` feed the report.
 *
 * JSVMP instrumentation runs before general instrumentation because it needs
 * the original dispatch-loop offsets; the general instrumenter then parses the
 * JSVMP-instrumented text (markers are comments, so positions stay valid for
 * the new text).
 */
export function createInstrumentation(options) {
  const {
    ctx,
    bridge,
    stealth,
    trace,
    hooks,
    profile,
    clock,
    logger,
    config = {},
    environment = null,
  } = options

  const exceptionInstrumenter = createExceptionInstrumenter({ bridge, stealth, trace, hooks, logger })

  const codeInstrumenter = createCodeInstrumenter({
    ctx,
    bridge,
    stealth,
    trace,
    hooks,
    level: config.code?.level ?? 'statement',
    marker: config.code?.marker ?? 'q',
    maxEvents: config.code?.maxEvents ?? 20_000,
    maxInsertions: config.code?.maxInsertions ?? 40_000,
    logger,
    exception: exceptionInstrumenter,
  })

  const apiInstrumenter = createApiInstrumenter({ ctx, bridge, trace, hooks, logger })

  const state = {
    installed: false,
    analyses: 0,
    jsvmpDetections: 0,
    lastFacts: null,
    lastVm: null,
  }

  return {
    exceptions: exceptionInstrumenter,
    code: codeInstrumenter,
    api: apiInstrumenter,

    install({ wrapApis = config.api !== false } = {}) {
      if (state.installed) return this.describe()
      codeInstrumenter.install()
      if (wrapApis) {
        const result = apiInstrumenter.install(config.api?.targets ?? [])
        trace?.emit('sandbox', 'emit', {
          event: 'api.instrumentation.installed',
          wrapped: result.wrapped.length,
        })
      }
      state.installed = true
      hooks?.emit('lifecycle:init', { instrumentation: this.describe() })
      return this.describe()
    },

    /**
     * Analyse + instrument one source text.
     * @param {string} source
     * @param {{filename?: string, level?: string, sourceType?: 'script'|'module', traceCode?: boolean}} [runOptions]
     */
    prepare(source, runOptions = {}) {
      const { filename = 'script.js', level, sourceType = 'script' } = runOptions
      // 1. hook pipeline may rewrite the source (code:before)
      const pipeline = hooks
        ? hooks.pipeline('code:before', source, { filename, profile })
        : { value: source, changed: false }
      let code = pipeline.value ?? source

      // 2. static analysis (also drives JSVMP detection)
      const analysis = analyzeSource(code, { hooks, trace, filename })
      if (analysis.ok) {
        state.analyses += 1
        state.lastFacts = analysis.facts
        // normalise: `strings` is a count in facts; samples live separately
        analysis.facts.stringSamples = analysis.facts.strings
        analysis.facts.strings = analysis.facts.stringsTotal
        trace?.emit('ast', 'after', {
          event: 'analysis.complete',
          functions: analysis.facts.functions,
          obfuscation: analysis.facts.obfuscation.score,
          techniques: analysis.facts.techniques,
        })
      } else {
        trace?.emit('ast', 'error', { event: 'analysis.failed', message: analysis.error })
      }

      // 3. JSVMP dispatch instrumentation (traceless, opcode-level)
      let vm = null
      if (config.jsvmp !== false && analysis.ok) {
        stealth?.registerMarker?.(config.jsvmp?.marker ?? 'v')
        const detected = detectDispatch(analysis.ast)
        if (detected.found) {
          state.jsvmpDetections += 1
          const interpreter = locateInterpreter(code, detected.dispatch)
          const channelExpression = codeInstrumenter.channelExpression()
          if (channelExpression) {
            try {
              const instrumented = instrumentDispatch(code, {
                dispatch: detected.dispatch,
                channelExpression,
                bindingName: config.jsvmp?.binding ?? '_$v',
                marker: config.jsvmp?.marker ?? 'v',
                interpreter,
              })
              if (instrumented.stats.skipped) {
                trace?.emit('jsvmp', 'skip', {
                  event: 'jsvmp.instrument.skipped',
                  reason: instrumented.stats.skipped,
                })
              } else {
              code = instrumented.code
              codeInstrumenter.mergePlan(instrumented.plan)
              vm = {
                detected: true,
                kind: detected.kind,
                score: detected.score,
                cases: detected.dispatch.cases.length,
                discriminant: detected.dispatch.discriminant,
                loopKind: detected.dispatch.loopKind,
                opcodes: instrumented.stats.opcodesInstrumented,
                interpreter,
                plan: [...instrumented.plan.values()],
              }
              trace?.emit('jsvmp', 'enter', {
                event: 'jsvmp.detected',
                cases: vm.cases,
                loopKind: vm.loopKind,
                discriminant: vm.discriminant,
              })
              }
            } catch (error) {
              logger?.warn?.({ err: error.message }, 'jsvmp instrumentation failed')
              trace?.emit('jsvmp', 'error', { event: 'jsvmp.instrument.failed', message: error.message })
            }
          }
        }
      }
      state.lastVm = vm

      // 4. code/statement instrumentation on the (possibly VM-instrumented) text
      const instrumented = codeInstrumenter.instrument(code, { filename, level, sourceType })
      return {
        code: instrumented.code,
        plan: instrumented.plan,
        facts: analysis.ok ? analysis.facts : null,
        vm,
        sourceChangedByHooks: pipeline.changed,
        stats: instrumented.stats,
      }
    },

    /** Static analysis without executing. */
    analyze(source, options = {}) {
      return analyzeSource(source, { hooks, trace, ...options })
    },

    /** Summarize a recorded opcode trace. */
    summarizeVm(events, semantics) {
      return summarizeOpcodeTrace(events, { semantics })
    },

    describe() {
      return {
        installed: state.installed,
        code: codeInstrumenter.stats(),
        api: apiInstrumenter.stats(),
        exceptions: exceptionInstrumenter.stats(),
        jsvmpDetections: state.jsvmpDetections,
        analyses: state.analyses,
        lastVm: state.lastVm,
        environment: environment?.installed?.map((entry) => entry.id) ?? null,
      }
    },

    stats() {
      return this.describe()
    },

    dispose() {
      try {
        apiInstrumenter.dispose()
      } catch {
        /* already gone */
      }
      try {
        codeInstrumenter.dispose()
      } catch {
        /* already gone */
      }
    },
  }
}
