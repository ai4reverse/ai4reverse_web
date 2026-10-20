import { parse } from '../restore/parse.js'
import { traverse } from '../restore/pass-context.js'

/**
 * Code-level traceless instrumentation.
 *
 * KEY DESIGN: instrumentation is applied by **splicing text into the original
 * source**, never by regenerating it with a printer. Every inserted fragment is
 * wrapped in `/*#token*​/ ... /*#/token*​/` markers; the stealth
 * `Function.prototype.toString` masker strips exactly those spans, so a sample
 * that reads its own source (self-checksums, anti-tamper, `toString` brand
 * checks) sees byte-identical original code.
 *
 * The trace channel is a host function reached through a run-unique
 * `Symbol.for(...)` stored on `document` (or the global object when there is no
 * document). It is not a named global: `Object.getOwnPropertyNames(window)` is
 * unchanged and `for...in` sees nothing.
 *
 * Levels:
 *   'function'   function enter/exit, catch clauses, eval/Function call sites
 *   'branch'     + loop iteration counters
 *   'statement'  + every statement (default)
 *   'off'
 */

const LEVEL_RANK = { off: 0, function: 1, branch: 2, statement: 3 }

export function createCodeInstrumenter(options) {
  const {
    ctx,
    bridge,
    stealth,
    trace,
    hooks,
    level = 'statement',
    marker = 'q',
    maxEvents = 20_000,
    maxInsertions = 40_000,
    logger,
    exception,
  } = options

  const rank = LEVEL_RANK[level] ?? 3
  let channel = null
  let channelSymbol = null
  let channelKey = null
  let bindingSuffix = 'q'
  let channelTarget = null
  let channelExpression = null
  let currentPlan = null
  let pendingPlan = new Map()
  let emitted = 0
  let truncated = false
  let invocation = 0
  const stats = { invocations: 0, insertions: 0, functions: 0, statements: 0, loops: 0, catches: 0, evalSites: 0, skipped: 0, parseFailures: 0 }

  const begin = () => `/*#${marker}*/`
  const end = () => `/*#/${marker}*/`
  const wrap = (code) => `${begin()}${code}${end()}`

  function install() {
    // Register the marker token so the stealth toString masker strips exactly
    // the spans this instrumenter inserts.
    stealth?.registerMarker?.(marker)
    channel = bridge.fn('', 3, ({ args }) => {
      const plan = currentPlan
      if (!plan) return args[2]
      const kind = bridge.int(args, 0, -1)
      const id = bridge.int(args, 1, -1)
      const meta = plan.get(id)
      // Never dump arbitrary guest objects here: that would run getters and
      // change observable behaviour. Primitives are summarised; objects are
      // reported by type only.
      const value = args.length > 2 ? summarizeArgument(ctx, bridge, args[2]) : undefined
      if (emitted >= maxEvents) {
        if (!truncated) {
          truncated = true
          trace?.emit('code', 'error', { event: 'trace-truncated', maxEvents })
        }
        return args[2]
      }
      if (meta) {
        // A caught error is about to be observed by guest code: rewrite its
        // stack in place so `<eval>`/host paths never reach the sample.
        bridge.clock?.tick?.(0.01)
        if (meta.event === 'catch' && stealth && value && typeof value === 'object' && typeof value.stack === 'string') {
          try {
            const stackHandle = args[2]
            ctx.setProp(stackHandle, 'stack', ctx.newString(stealth.sanitizeStack(value.stack)))
          } catch {
            /* best effort: never break the guest for a stack rewrite */
          }
        }
        emitted += 1
        trace?.emit('code', 'step', {
          event: meta.event,
          id,
          line: meta.line,
          column: meta.column,
          fn: meta.fn,
          opcode: meta.opcode,
          caseIndex: meta.caseIndex,
          value: value === undefined ? undefined : summarize(value),
        })
        if (meta.event === 'catch' && exception) exception.reportCaught(value, meta)
        if (meta.event === 'throw' && exception) exception.reportThrown(value, meta)
        if (hooks) {
          hooks.emit(meta.event === 'catch' ? 'exception:catch' : 'code:step', {
            site: meta,
            value: value === undefined ? undefined : summarize(value),
            origin: 'code-instrumentation',
          })
        }
      }
      return args[2]
    })

    channelKey = `ai4r.channel.${nonceFrom(stealth, 0)}`
    bindingSuffix = `${marker}${shortBinding(channelKey)}`
    channelSymbol = ctx.newSymbolFor(channelKey)
    const documentHandle = safeProp(ctx, ctx.global, 'document')
    try {
      if (documentHandle && ctx.typeof(documentHandle) === 'object') {
        ctx.setProp(documentHandle, channelSymbol, channel)
        channelTarget = 'document'
        channelExpression = `globalThis.document[Symbol.for("${channelKey}")]`
      } else {
        ctx.setProp(ctx.global, channelSymbol, channel)
        channelTarget = null
        channelExpression = `globalThis[Symbol.for("${channelKey}")]`
      }
    } finally {
      documentHandle?.dispose?.()
    }
    trace?.emit('sandbox', 'emit', {
      event: 'code.instrumentation.installed',
      level,
      channel: channelTarget ? 'document[symbol]' : 'global[symbol]',
    })
  }

  /**
   * Instrument one source text.
   * @param {string} source
   * @param {{filename?: string, level?: string, sourceType?: 'script'|'module'}} [options]
   * @returns {{code: string, plan: Map<number, object>, stats: object}}
   */
  function instrument(source, options = {}) {
    const {
      filename = 'script.js',
      level: overrideLevel,
      sourceType = 'script',
    } = options
    const activeRank = LEVEL_RANK[overrideLevel] ?? rank
    if (activeRank === 0) return { code: source, plan: new Map(), stats: { ...stats, skipped: 1 } }

    let ast
    let parseError = null
    try {
      ast = parse(source, { sourceType, errorRecovery: false, filename }).ast
    } catch (error) {
      parseError = error
      stats.parseFailures += 1
      trace?.emit('code', 'error', { event: 'instrument.parse.failed', message: error.message, filename })
      return { code: source, plan: new Map(), stats: { ...stats, parseError: error.message } }
    }

    invocation += 1
    const plan = new Map(pendingPlan)
    pendingPlan = new Map()
    /** @type {Array<{offset: number, priority: number, text: string}>} */
    const insertions = []
    let nextId = plan.size > 0 ? Math.max(...plan.keys()) : 0
    let insertionCount = 0
    let budgetExceeded = false

    const add = (offset, priority, code) => {
      if (budgetExceeded) return
      if (insertionCount >= maxInsertions) {
        budgetExceeded = true
        trace?.emit('code', 'error', { event: 'instrument.budget', maxInsertions, filename })
        return
      }
      insertionCount += 1
      insertions.push({ offset, priority, text: wrap(code) })
    }

    const record = (event, node, fnName) => {
      nextId += 1
      plan.set(nextId, {
        event,
        id: nextId,
        line: node.loc?.start.line ?? 0,
        column: node.loc?.start.column ?? 0,
        endLine: node.loc?.end?.line ?? 0,
        fn: fnName ?? '',
      })
      return nextId
    }

    const isDirective = (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'StringLiteral' &&
      node.directive !== undefined

    const offsetAfterDirectives = (body) => {
      let offset = (body.start ?? 0) + 1
      for (const statement of body.body ?? []) {
        if (isDirective(statement)) offset = statement.end
        else break
      }
      return offset
    }

    let currentFunctionName = ''

    traverse(ast, {
      Function: {
        enter(path) {
          const node = path.node
          if (!node.body || node.body.type !== 'BlockStatement') return
          if (activeRank < LEVEL_RANK.function) return
          const name =
            node.id?.name ??
            (path.parent?.type === 'VariableDeclarator' && path.parent.id?.type === 'Identifier'
              ? path.parent.id.name
              : path.parent?.type === 'AssignmentExpression' && path.parent.left?.type === 'Identifier'
                ? path.parent.left.name
                : `anonymous@${node.loc?.start.line ?? 0}`)
          currentFunctionName = name
          stats.functions += 1
          const enterId = record('function:enter', node.body, name)
          const exitId = record('function:exit', node.body, name)
          const bodyOffset = offsetAfterDirectives(node.body)
          // Leading newline: a directive prologue without a semicolon needs a
          // line terminator before the injected statement, or ASI never fires.
          add(bodyOffset, 100, `\nvar ${bindingName()} = ${channelExpression};`)
          add(bodyOffset, 95, `\ntry{`)
          add(bodyOffset, 90, `${bindingName()}(${kind('function:enter')},${enterId});`)
          add((node.body.end ?? 1) - 1, 90, `}finally{${bindingName()}(${kind('function:exit')},${exitId});}`)
          // The exit visitor needs to know whether this node was instrumented; a
          // node flag is enough (no depth counter: nothing reads it).
          path.node.__ai4rFnName = name
        },
        exit(path) {
          if (path.node.body?.type === 'BlockStatement' && path.node.__ai4rFnName) {
            currentFunctionName = ''
          }
        },
      },

      BlockStatement(path) {
        if (activeRank < LEVEL_RANK.statement) return
        // Skip catch bodies and switch-case consequent arrays; those are handled
        // by their own visitors.
        if (path.parent?.type === 'CatchClause') return
        const body = path.node.body ?? []
        for (const statement of body) {
          if (isDirective(statement)) continue
          const id = record('statement', statement, currentFunctionName)
          add(statement.start, 70, `${bindingName()}(${kind('statement')},${id});`)
          stats.statements += 1
        }
      },

      Program(path) {
        if (activeRank < LEVEL_RANK.statement) return
        const body = path.node.body ?? []
        for (const statement of body) {
          if (isDirective(statement)) continue
          const id = record('statement', statement, '<top-level>')
          add(statement.start, 70, `${bindingName()}(${kind('statement')},${id});`)
          stats.statements += 1
        }
        // Program-level channel binding: `let` creates a lexical binding that
        // is invisible to globalThis enumeration.
        let offset = 0
        for (const statement of body) {
          if (isDirective(statement)) offset = statement.end
          else break
        }
        add(offset, 100, `\nlet ${bindingName()} = ${channelExpression};`)
      },

      Loop(path) {
        if (activeRank < LEVEL_RANK.branch) return
        const body = path.node.body
        if (!body || body.type !== 'BlockStatement') return
        const id = record('loop', body, currentFunctionName)
        add(offsetAfterDirectives(body), 80, `${bindingName()}(${kind('loop')},${id});`)
        stats.loops += 1
      },

      CatchClause(path) {
        if (activeRank < LEVEL_RANK.function) return
        const node = path.node
        if (!node.body || node.body.type !== 'BlockStatement') return
        const param = node.param?.type === 'Identifier' ? node.param.name : 'undefined'
        const id = record('catch', node.body, currentFunctionName)
        add((node.body.start ?? 0) + 1, 85, `${bindingName()}(${kind('catch')},${id},${param});`)
        stats.catches += 1
      },

      CallExpression(path) {
        const callee = path.node.callee
        if (callee.type !== 'Identifier') return
        if (callee.name === 'eval') {
          if (path.scope.getBinding('eval')) return
          if (activeRank < LEVEL_RANK.function) return
          const argument = path.node.arguments[0]
          if (!argument || path.node.arguments.length !== 1) return
          const id = record('eval', path.node, currentFunctionName)
          add(argument.start, 60, `${bindingName()}(${kind('eval')},${id},`)
          add(argument.end, 60, ')')
          stats.evalSites += 1
        } else if (callee.name === 'Function' && !path.scope.getBinding('Function')) {
          if (activeRank < LEVEL_RANK.function) return
          const id = record('Function', path.node, currentFunctionName)
          add(callee.start, 60, `(${bindingName()}(${kind('Function')},${id}),`)
          add(callee.end, 60, ')')
          stats.evalSites += 1
        }
      },

      ThrowStatement(path) {
        if (activeRank < LEVEL_RANK.function) return
        const argument = path.node.argument
        if (!argument) return
        const id = record('throw', path.node, currentFunctionName)
        add(argument.start, 55, `${bindingName()}(${kind('throw')},${id},`)
        add(argument.end, 55, ')')
      },

      NewExpression(path) {
        const callee = path.node.callee
        if (callee.type === 'Identifier' && callee.name === 'Function' && !path.scope.getBinding('Function')) {
          if (activeRank < LEVEL_RANK.function) return
          const id = record('Function', path.node, currentFunctionName)
          add(callee.start, 60, `(${bindingName()}(${kind('Function')},${id}),`)
          add(callee.end, 60, ')')
          stats.evalSites += 1
        }
      },
    })

    const code = applyInsertions(source, insertions)
    const result = {
      code,
      plan,
      filename,
      stats: {
        insertions: insertions.length,
        functions: stats.functions,
        statements: stats.statements,
        loops: stats.loops,
        catches: stats.catches,
        evalSites: stats.evalSites,
        planSize: plan.size,
      },
    }
    currentPlan = plan
    stats.invocations += 1
    stats.insertions += insertions.length
    trace?.emit('code', 'before', {
      event: 'instrumented',
      filename,
      insertions: insertions.length,
      planSize: plan.size,
      level,
      bytes: code.length,
    })
    return result
  }

  function bindingName() {
    return `_$${bindingSuffix}`
  }

  function channelExpressionForGuest() {
    return channelExpression
  }

  function mergePlan(extra) {
    if (!extra) return
    for (const [id, meta] of extra) pendingPlan.set(id, meta)
  }

  function kind(name) {
    return KINDS[name] ?? 0
  }

  return {
    install,
    instrument,
    mergePlan,
    channelExpression: channelExpressionForGuest,
    /** Plan for the most recent instrumentation call. */
    get plan() {
      return currentPlan
    },
    stats() {
      return { ...stats, emitted, truncated, level }
    },
    dispose() {
      try {
        channel?.dispose()
      } catch {
        /* already gone */
      }
      try {
        channelSymbol?.dispose()
      } catch {
        /* already gone */
      }
      channel = null
      channelSymbol = null
    },
  }
}

const KINDS = {
  statement: 0,
  loop: 1,
  function: 2,
  'function:enter': 3,
  'function:exit': 4,
  catch: 5,
  eval: 6,
  Function: 7,
  throw: 8,
}

function summarizeArgument(ctx, bridge, handle) {
  try {
    const type = ctx.typeof(handle)
    if (type === 'string' || type === 'number' || type === 'boolean') return bridge.value([handle], 0)
    if (type === 'undefined') return undefined
    if (type === 'object') {
      // Errors are the one object class worth reading (catch/throw tracing).
      try {
        const stack = ctx.getProp(handle, 'stack')
        if (ctx.typeof(stack) === 'string') {
          const message = ctx.getProp(handle, 'message')
          const name = ctx.getProp(handle, 'name')
          const summary = {
            name: ctx.typeof(name) === 'string' ? ctx.getString(name) : 'Error',
            message: ctx.typeof(message) === 'string' ? ctx.getString(message) : '',
            stack: ctx.getString(stack),
          }
          name.dispose()
          message.dispose()
          stack.dispose()
          return summary
        }
        stack.dispose()
      } catch {
        /* not an error */
      }
    }
    return { type }
  } catch {
    return undefined
  }
}

function shortBinding(key) {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) >>> 0
  }
  return hash.toString(36).slice(0, 5)
}

function summarize(value) {
  if (value === null || value === undefined) return { type: String(value) }
  const type = typeof value
  if (type === 'string') {
    return { type, length: value.length, value: value.length > 4096 ? value.slice(0, 4096) : value }
  }
  if (type === 'number' || type === 'boolean') return { type, value }
  if (type === 'object') {
    if (value.message || value.stack) {
      return { type: 'error', name: value.name, message: String(value.message ?? '').slice(0, 1024), stack: String(value.stack ?? '').slice(0, 2048) }
    }
    return { type, keys: Object.keys(value).slice(0, 20) }
  }
  return { type }
}

function applyInsertions(source, insertions) {
  if (insertions.length === 0) return source
  insertions.sort((a, b) => b.offset - a.offset || a.priority - b.priority)
  let output = source
  let lastOffset = Number.POSITIVE_INFINITY
  for (const insertion of insertions) {
    if (insertion.offset > lastOffset) continue
    output = output.slice(0, insertion.offset) + insertion.text + output.slice(insertion.offset)
    lastOffset = insertion.offset
  }
  return output
}

function safeProp(ctx, target, key) {
  try {
    return ctx.getProp(target, key)
  } catch {
    return null
  }
}

function nonceFrom(stealth, invocation) {
  return `${stealth?.nonce ?? 'q'}.${invocation}`
}
