/**
 * Anti-analysis pass (order 75).
 *
 * Two rules govern everything in this file:
 *
 * 1. **Transformations are limited to provably safe rewrites.** The only edits
 *    are (a) deleting `debugger` statements, which are pure no-ops outside a
 *    debugger, and (b) deleting loops whose body is empty and whose test is
 *    statically always truthy (`while (true) {}`, `for (;;) {}`), i.e. spins
 *    that can never produce an observable effect or termination. Both rewrites
 *    are single statements, never touch expressions, and are skipped when they
 *    cannot be proven (labelled loops, loops in single-statement positions that
 *    would leave a dangling label).
 * 2. **Detection is observation only.** Self-defence, anti-debug and
 *    sandbox-probe fingerprints are reported through `context.note()` and left
 *    in the code untouched. Rewriting them would require reasoning about
 *    reachability and side effects that a local AST pass cannot do, and a wrong
 *    guess silently changes behaviour — the opposite of what an analysis
 *    platform must guarantee.
 *
 * Detected families:
 * - timing checks built on `Date.now()` / `performance.now()` / `new Date().getTime()`
 *   compared against a threshold,
 * - `Function.prototype.toString` brand checks,
 * - dynamic global access such as `Function('return this')()` or
 *   `(function(){}).constructor('return this')()`,
 * - environment probes for `process`, `navigator.webdriver`, `phantom`,
 *   `_phantom`, `callPhantom`, `nightmare`, `domAutomation`,
 * - `Error().stack` / `new Error().stack` length checks,
 * - the string `debugger` (used to make devtools pause on demand).
 */

/** Identifier/property names that only malware and detection libraries look for. */
const SANDBOX_PROBE_NAMES = Object.freeze([
  'process',
  'webdriver',
  'phantom',
  '_phantom',
  'callPhantom',
  'nightmare',
  'domAutomation',
])

const SANDBOX_PROBE_SET = new Set(SANDBOX_PROBE_NAMES)

/** Comparison operators used by timing gates. */
const COMPARISON_OPERATORS = new Set(['<', '>', '<=', '>=', '==', '!=', '===', '!=='])

/** `return this` / `return window` style payloads of a dynamic-global grab. */
const GLOBAL_ESCAPE_LITERAL = /\breturn\s+(?:this|globalThis|window|global|self)\b/

/** Human-readable report text per detection family. */
const DETECTION_LABELS = Object.freeze({
  timing: 'timing check against Date/performance clock',
  'function-tostring': 'Function.prototype.toString brand check',
  'dynamic-global': "dynamic global access (Function/constructor('return ...'))",
  'sandbox-probe': 'sandbox/environment probe',
  stack: 'Error().stack length check',
  'debugger-string': "the string 'debugger' (devtools trap)",
})

/** Per-family limit before line numbers are summarised as "+N more". */
const MAX_LINES_PER_DETECTION = 6

export const meta = {
  id: 'anti-analysis',
  order: 75,
  description: 'strip safe anti-analysis no-ops (debugger, empty spins) and report anti-debug probes',
  idempotent: true,
}

/**
 * @param {object} ast Babel File/Program node, mutated in place
 * @param {object} context see docs/CONTRACTS.md ("Restoration pass contract")
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const { types: t } = context
  const notes = []
  const note = createNoteRecorder(context, notes)
  const report = createReporter(context)
  const detections = createDetectionCollector()

  let removedDebugger = 0
  let removedSpins = 0

  context.traverse(ast, {
    DebuggerStatement(path) {
      path.remove()
      removedDebugger += 1
    },

    WhileStatement(path) {
      if (removeEmptySpin(path, context)) removedSpins += 1
    },

    ForStatement(path) {
      if (removeEmptySpin(path, context)) removedSpins += 1
    },

    BinaryExpression(path) {
      if (!COMPARISON_OPERATORS.has(path.node.operator)) return
      if (relativeToClock(path.node.left, path, context) || relativeToClock(path.node.right, path, context)) {
        detections.add('timing', path.node)
      }
    },

    CallExpression(path) {
      const callee = path.node.callee
      if (
        t.isCallExpression(callee) &&
        t.isMemberExpression(callee.callee) &&
        !callee.callee.computed &&
        t.isIdentifier(callee.callee.property, { name: 'constructor' }) &&
        hasGlobalEscapeArgument(callee.arguments, t)
      ) {
        detections.add('dynamic-global', path.node)
      }
      if (t.isIdentifier(callee, { name: 'Function' }) && hasGlobalEscapeArgument(path.node.arguments, t)) {
        detections.add('dynamic-global', path.node)
      }
    },

    NewExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: 'Function' }) && hasGlobalEscapeArgument(path.node.arguments, t)) {
        detections.add('dynamic-global', path.node)
      }
    },

    MemberExpression(path) {
      const { node } = path
      const property = memberPropertyName(node, t)
      if (property === null) return

      if (property === 'toString' && isFunctionPrototypeBase(node.object, t)) {
        detections.add('function-tostring', node)
        return
      }
      if (property === 'stack' && isErrorAllocation(node.object, t)) {
        detections.add('stack', node)
        return
      }
      if (SANDBOX_PROBE_SET.has(property) && !node.computed) {
        detections.add('sandbox-probe', node, property)
      }
    },

    Identifier(path) {
      if (!SANDBOX_PROBE_SET.has(path.node.name)) return
      if (!path.isReferencedIdentifier()) return
      detections.add('sandbox-probe', path.node, path.node.name)
    },

    StringLiteral(path) {
      if (SANDBOX_PROBE_SET.has(path.node.value)) {
        detections.add('sandbox-probe', path.node, path.node.value)
      }
      if (GLOBAL_ESCAPE_LITERAL.test(path.node.value)) {
        detections.add('dynamic-global', path.node)
      }
      if (/\bdebugger\b/.test(path.node.value)) {
        detections.add('debugger-string', path.node)
      }
    },

    TemplateElement(path) {
      const text = path.node.value?.cooked ?? path.node.value?.raw ?? ''
      if (/\bdebugger\b/.test(text)) detections.add('debugger-string', path.node)
    },
  })

  if (removedDebugger > 0) {
    note(`anti-analysis: removed ${removedDebugger} debugger statement(s)`)
    report({ rule: 'debugger', from: `${removedDebugger} debugger statement(s)`, to: '' })
  }
  if (removedSpins > 0) {
    note(`anti-analysis: removed ${removedSpins} empty infinite loop(s)`)
    report({ rule: 'empty-spin', from: `${removedSpins} while(true){}/for(;;){} loop(s)`, to: '' })
  }

  for (const detection of detections.summary()) note(detection)

  return { changed: removedDebugger > 0 || removedSpins > 0, notes }
}

/**
 * Passes report through `context.note` when the pipeline provides it and
 * through the returned notes otherwise, so a message is never recorded twice.
 * @param {object} context
 * @param {string[]} notes
 * @returns {(message: string) => void}
 */
function createNoteRecorder(context, notes) {
  const sink = typeof context.note === 'function' ? (message) => context.note(message) : (message) => notes.push(message)
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    sink(message)
  }
}

/**
 * Record one change in the pass report when the pipeline provides a reporter.
 * @param {object} context
 * @returns {(change: {rule: string, from: string, to: string}) => void}
 */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/**
 * Remove `while (true) {}` / `for (;;) {}` when the loop provably never runs a
 * statement. A labelled loop is skipped because deleting it would leave the
 * label attached to the following statement.
 * @param {object} path NodePath of a WhileStatement/ForStatement
 * @param {object} context
 * @returns {boolean} true when the loop was removed
 */
function removeEmptySpin(path, context) {
  const { types: t } = context
  if (path.parentPath?.isLabeledStatement()) return false
  if (!isEmptyBody(path.node.body, t)) return false
  if (!isAlwaysTruthyTest(path.node, t)) return false
  path.remove()
  return true
}

/**
 * @param {object|null|undefined} body
 * @param {object} t
 * @returns {boolean}
 */
function isEmptyBody(body, t) {
  if (!body) return false
  if (t.isEmptyStatement(body)) return true
  if (!t.isBlockStatement(body)) return false
  return body.body.every((statement) => t.isEmptyStatement(statement))
}

/**
 * Statically truthy loop test, recognising the obfuscator spellings
 * `true`, `!![]`, `!0` and the absent test of `for (;;)`.
 * @param {object} node WhileStatement or ForStatement
 * @param {object} t
 * @returns {boolean}
 */
function isAlwaysTruthyTest(node, t) {
  if (t.isForStatement(node)) {
    if (node.init || node.update) return false
    if (!node.test) return true
    return staticTruthiness(node.test, t) === true
  }
  if (t.isWhileStatement(node)) return staticTruthiness(node.test, t) === true
  return false
}

/**
 * @param {object|null|undefined} node
 * @param {object} t
 * @returns {boolean|null} true / false / null when not statically known
 */
function staticTruthiness(node, t) {
  if (!node) return null
  if (t.isBooleanLiteral(node)) return node.value
  if (t.isNumericLiteral(node)) return node.value !== 0
  if (t.isStringLiteral(node)) return node.value.length > 0
  if (t.isNullLiteral(node)) return false
  if (t.isArrayExpression(node) || t.isObjectExpression(node)) return true
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true
  if (t.isUnaryExpression(node) && node.operator === 'void') return false
  if (t.isUnaryExpression(node) && node.operator === '!') {
    const inner = staticTruthiness(node.argument, t)
    return inner === null ? null : !inner
  }
  return null
}

/**
 * Property name of a member expression when it is statically known, otherwise null.
 * @param {object} node MemberExpression
 * @param {object} t
 * @returns {string|null}
 */
function memberPropertyName(node, t) {
  if (!t.isMemberExpression(node)) return null
  if (node.computed) {
    if (t.isStringLiteral(node.property)) return node.property.value
    return null
  }
  if (t.isIdentifier(node.property)) return node.property.name
  return null
}

/**
 * True for the `Function` / `Function.prototype` base of a brand check.
 * @param {object} node
 * @param {object} t
 * @returns {boolean}
 */
function isFunctionPrototypeBase(node, t) {
  if (t.isIdentifier(node, { name: 'Function' })) return true
  return (
    t.isMemberExpression(node) &&
    t.isIdentifier(node.object, { name: 'Function' }) &&
    memberPropertyName(node, t) === 'prototype'
  )
}

/**
 * True for `Error()` / `new Error()` used inline (the stack-length probe).
 * @param {object} node
 * @param {object} t
 * @returns {boolean}
 */
function isErrorAllocation(node, t) {
  if (t.isCallExpression(node)) return t.isIdentifier(node.callee, { name: 'Error' })
  if (t.isNewExpression(node)) return t.isIdentifier(node.callee, { name: 'Error' })
  return false
}

/**
 * True when an argument list carries a `'return this'`-style payload.
 * @param {object[]} args
 * @param {object} t
 * @returns {boolean}
 */
function hasGlobalEscapeArgument(args, t) {
  return args.some((argument) => t.isStringLiteral(argument) && GLOBAL_ESCAPE_LITERAL.test(argument.value))
}

/**
 * True when an operand is (or came from) a clock read:
 * `Date.now() - start > 50` inline, or `var elapsed = Date.now() - start;
 * if (elapsed > 50)` through a local declarator.
 * @param {object|null|undefined} node
 * @param {object} path NodePath of the comparison
 * @param {object} context
 * @returns {boolean}
 */
function relativeToClock(node, path, context) {
  const { types: t } = context
  if (!node) return false
  if (containsTimingCall(node, t, 0)) return true
  if (!t.isIdentifier(node)) return false
  const binding = path.scope.getBinding(node.name)
  if (!binding || !binding.path.isVariableDeclarator()) return false
  const init = binding.path.node.init
  return Boolean(init) && containsTimingCall(init, t, 0)
}

/**
 * Look for a clock read inside `node` without walking the whole tree
 * (`Date.now() - start > 50` is enough to identify a timing gate).
 * @param {object|undefined|null} node
 * @param {object} t
 * @param {number} depth
 * @returns {boolean}
 */
function containsTimingCall(node, t, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return false
  if (t.isNewExpression(node) && t.isIdentifier(node.callee, { name: 'Date' })) return true
  if (t.isCallExpression(node)) {
    const callee = node.callee
    if (t.isMemberExpression(callee)) {
      const property = memberPropertyName(callee, t)
      if (property === 'now' && (t.isIdentifier(callee.object, { name: 'Date' }) || t.isIdentifier(callee.object, { name: 'performance' }))) {
        return true
      }
      if (property === 'getTime' && isDateAllocation(callee.object, t)) return true
    }
  }
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && containsTimingCall(item, t, depth + 1)) return true
      }
    } else if (child && containsTimingCall(child, t, depth + 1)) {
      return true
    }
  }
  return false
}

/**
 * @param {object} node
 * @param {object} t
 * @returns {boolean}
 */
function isDateAllocation(node, t) {
  return t.isNewExpression(node) && t.isIdentifier(node.callee, { name: 'Date' })
}

/**
 * Group detections by family so a sample with hundreds of probes reports one
 * note per family instead of hundreds.
 * @returns {{add: (family: string, node: object, detail?: string) => void, summary: () => string[]}}
 */
function createDetectionCollector() {
  /** @type {Map<string, {lines: Set<number>, details: Set<string>}>} */
  const families = new Map()

  return {
    add(family, node, detail) {
      let entry = families.get(family)
      if (!entry) {
        entry = { lines: new Set(), details: new Set() }
        families.set(family, entry)
      }
      const line = node?.loc?.start?.line
      if (typeof line === 'number') entry.lines.add(line)
      if (detail) entry.details.add(detail)
    },

    summary() {
      const messages = []
      for (const [family, entry] of families) {
        const label = DETECTION_LABELS[family] ?? family
        const details = [...entry.details].sort().join(', ')
        const lines = [...entry.lines].sort((a, b) => a - b)
        const shown = lines.slice(0, MAX_LINES_PER_DETECTION)
        const lineText =
          lines.length === 0
            ? ''
            : ` (line ${shown.join(', ')}${lines.length > shown.length ? ` +${lines.length - shown.length} more` : ''})`
        messages.push(`anti-analysis: detected ${label}${details ? ` [${details}]` : ''}${lineText}`)
      }
      return messages
    },
  }
}
