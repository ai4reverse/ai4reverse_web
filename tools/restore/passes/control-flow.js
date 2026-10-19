/**
 * Control-flow unflattening (order 70).
 *
 * The classic obfuscator emits a dispatch loop whose case bodies are the real
 * basic blocks and whose execution order lives in a literal sequence:
 *
 *   var order = '3|1|2|0'.split('|'), idx = 0;
 *   while (true) {
 *     switch (order[idx++]) {
 *       case '0': a(); continue;
 *       case '1': b(); continue;
 *       case '2': c(); continue;
 *       case '3': d(); continue;
 *     }
 *     break;
 *   }
 *
 * Because the sequence literal is the program order, the loop is equivalent to
 * `d(); b(); c(); a();` and can be replaced by those statements with no
 * semantic change. Only that provable case is transformed. Every other shape
 * (fall-through cases, early `break`/labelled `continue`, `let`/`const` case
 * declarations, `order`/`idx` read inside a case body, a reassigned binding, a
 * non-literal sequence) is left untouched and reported through a note, because
 * guessing would risk changing behaviour.
 */

/** Upper bound on flattened sites per run; a file never needs more, and the
 * bound keeps a pathological input from looping forever. */
const MAX_FLATTEN_ITERATIONS = 64

export const meta = {
  id: 'control-flow',
  order: 70,
  description: 'unflatten order/idx switch dispatch loops into sequential statements',
  idempotent: true,
}

/**
 * @param {object} ast Babel File/Program node, mutated in place
 * @param {object} context see docs/CONTRACTS.md ("Restoration pass contract")
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const notes = []
  const note = createNoteRecorder(context, notes)
  const report = createReporter(context)
  let changed = false

  // One site per traversal: replacing a loop invalidates the paths collected
  // during that traversal, so the scan restarts after each rewrite.
  for (let iteration = 0; iteration < MAX_FLATTEN_ITERATIONS; iteration += 1) {
    const match = findDispatchLoop(ast, context, note)
    if (!match) break
    const { path, statements } = match
    const loopType = path.node.type
    if (statements.length === 0) {
      path.remove()
    } else {
      path.replaceWithMultiple(statements)
    }
    report({ rule: 'switch-dispatch', from: loopType, to: `${statements.length} sequential statement(s)` })
    changed = true
  }

  return { changed, notes }
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
 * Scan the whole file and return the first flattener site that can be safely
 * rewritten. Unsafe-but-recognised sites are reported once through `note`.
 * @param {object} ast
 * @param {object} context
 * @param {(message: string) => void} note
 * @returns {{path: object, statements: object[]}|null}
 */
function findDispatchLoop(ast, context, note) {
  let found = null
  context.traverse(ast, {
    'WhileStatement|ForStatement'(path) {
      if (found) return
      const result = analyzeDispatchLoop(path, context)
      if (result.statements) {
        found = { path, statements: result.statements }
        path.stop()
        return
      }
      if (result.reason) note(describeSkip(path.node, result.reason))
    },
  })
  return found
}

/**
 * @param {object} node
 * @param {string} reason
 * @returns {string}
 */
function describeSkip(node, reason) {
  const line = node.loc?.start?.line
  return `control-flow: dispatch loop at line ${line ?? '?'} left untouched (${reason})`
}

/**
 * Decide whether a loop is the dispatch pattern and, if so, produce the
 * statements that replace it.
 *
 * Returns `{}` when the loop is not a dispatch loop at all (silent: ordinary
 * loops are none of this pass's business) and `{reason}` when it looks like one
 * but a safety condition fails.
 *
 * @param {object} path NodePath of the WhileStatement/ForStatement
 * @param {object} context
 * @returns {{statements?: object[], reason?: string}}
 */
function analyzeDispatchLoop(path, context) {
  const { types: t } = context
  const loop = path.node

  if (!isInfiniteLoop(loop, t)) return {}

  const body = loop.body
  if (!t.isBlockStatement(body)) return {}

  const bodyStatements = body.body.filter((statement) => !t.isEmptyStatement(statement))
  if (bodyStatements.length === 0 || bodyStatements.length > 2) return {}
  const [first, second] = bodyStatements
  if (!t.isSwitchStatement(first)) return {}
  if (second && !t.isBreakStatement(second)) return {}

  const discriminant = readDispatchDiscriminant(first.discriminant, t)
  if (!discriminant) return {}

  if (!second) return { reason: 'loop body has no trailing break after the switch' }
  if (second.label) return { reason: 'trailing break carries a label' }

  const { orderName, idxName, orderNode, idxNode, discriminantNode } = discriminant

  const orderBinding = path.scope.getBinding(orderName)
  const idxBinding = path.scope.getBinding(idxName)
  if (!orderBinding || !idxBinding) return { reason: `dispatch bindings '${orderName}'/'${idxName}' are not declared in scope` }
  if (!orderBinding.path.isVariableDeclarator() || !idxBinding.path.isVariableDeclarator()) {
    return { reason: 'dispatch bindings are not plain variable declarators' }
  }
  // A `var` declared inside a block is hoisted to the function scope, so Babel
  // records the declarator itself as a constant violation of the same binding.
  // That self entry is benign; anything else means the dispatch state is written
  // somewhere this pass does not model.
  for (const violation of orderBinding.constantViolations) {
    if (violation.node === orderBinding.path.node) continue
    return { reason: `'${orderName}' is reassigned` }
  }
  for (const violation of idxBinding.constantViolations) {
    if (violation.node === idxBinding.path.node || violation.node === discriminantNode) continue
    return { reason: `'${idxName}' is reassigned` }
  }

  const declarationStart = orderBinding.path.node.start
  if (typeof declarationStart === 'number' && typeof loop.start === 'number' && declarationStart > loop.start) {
    return { reason: 'sequence declaration follows the loop' }
  }

  const sequence = readSequenceValues(orderBinding.path.node.init, t)
  if (!sequence) return { reason: 'sequence literal is not a literal array or string split' }
  if (sequence.length === 0) return { reason: 'sequence literal is empty' }

  for (const reference of orderBinding.referencePaths) {
    if (reference.node !== orderNode) return { reason: `case body references '${orderName}'` }
  }
  for (const reference of idxBinding.referencePaths) {
    if (reference.node !== idxNode) return { reason: `case body references '${idxName}'` }
  }

  const cases = new Map()
  for (const switchCase of first.cases) {
    if (!switchCase.test) return { reason: 'switch has a default clause' }
    const key = readLabelKey(switchCase.test, t)
    if (key === null) return { reason: 'case label is not a literal' }
    if (cases.has(key)) return { reason: `duplicate case label ${key}` }
    const extracted = readCaseBody(switchCase, t)
    if (extracted.reason) return { reason: extracted.reason }
    cases.set(key, extracted.statements)
  }

  const emitted = []
  const usedLabels = new Set()
  for (const value of sequence) {
    const key = labelKeyForValue(value)
    usedLabels.add(key)
    const statements = cases.get(key)
    if (!statements) return { reason: `sequence label ${key} has no case` }
    emitted.push(...statements)
  }
  if (cases.size !== usedLabels.size) return { reason: 'switch has a case label the sequence never selects' }

  return { statements: emitted }
}

/**
 * Recognise `order[idx++]` (computed member read of a post-incremented index).
 * @param {object} node switch discriminant
 * @param {object} t
 * @returns {{orderName: string, idxName: string, orderNode: object, idxNode: object, discriminantNode: object}|null}
 */
function readDispatchDiscriminant(node, t) {
  if (!t.isMemberExpression(node) || !node.computed) return null
  if (!t.isIdentifier(node.object)) return null
  const property = node.property
  if (!t.isUpdateExpression(property) || property.operator !== '++' || property.prefix) return null
  if (!t.isIdentifier(property.argument)) return null
  return {
    orderName: node.object.name,
    idxName: property.argument.name,
    orderNode: node.object,
    idxNode: property.argument,
    discriminantNode: property,
  }
}

/**
 * Read the literal dispatch order from `['3','1']` or `'3|1'.split('|')`.
 * @param {object|undefined|null} node declarator initialiser
 * @param {object} t
 * @returns {(string|number)[]|null}
 */
function readSequenceValues(node, t) {
  if (!node) return null
  if (t.isArrayExpression(node)) {
    const values = []
    for (const element of node.elements) {
      const primitive = readPrimitive(element, t)
      if (!primitive) return null
      values.push(primitive.value)
    }
    return values
  }
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return null
  const callee = node.callee
  if (!t.isMemberExpression(callee) || callee.computed) return null
  if (!t.isIdentifier(callee.property, { name: 'split' })) return null
  const source = readPrimitive(callee.object, t)
  const separator = readPrimitive(node.arguments[0], t)
  if (!source || typeof source.value !== 'string') return null
  if (!separator || typeof separator.value !== 'string') return null
  return source.value.split(separator.value)
}

/**
 * @param {object|null|undefined} node
 * @param {object} t
 * @returns {{value: string|number}|null}
 */
function readPrimitive(node, t) {
  if (!node) return null
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return { value: node.value }
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return { value: node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('') }
  }
  if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
    return { value: -node.argument.value }
  }
  return null
}

/**
 * @param {object} node a case test literal
 * @param {object} t
 * @returns {string|null} stable key, or null when the label is not literal
 */
function readLabelKey(node, t) {
  const primitive = readPrimitive(node, t)
  return primitive ? labelKeyForValue(primitive.value) : null
}

/**
 * @param {string|number} value
 * @returns {string}
 */
function labelKeyForValue(value) {
  return `${typeof value}:${String(value)}`
}

/**
 * Validate one case body and strip the trailing `continue` that only exists to
 * restart the dispatch loop.
 * @param {object} switchCase
 * @param {object} t
 * @returns {{statements?: object[], reason?: string}}
 */
function readCaseBody(switchCase, t) {
  const statements = switchCase.consequent
  for (const statement of statements) {
    if (t.isVariableDeclaration(statement) && statement.kind !== 'var') {
      return { reason: 'case declares let/const' }
    }
  }

  const last = statements[statements.length - 1]
  const tailIsContinue = Boolean(last) && t.isContinueStatement(last) && !last.label
  if (!tailIsContinue && !isTerminating(last, t)) {
    return { reason: 'case body falls through to the next case' }
  }

  const kept = tailIsContinue ? statements.slice(0, -1) : statements
  for (const statement of kept) {
    if (hasEscapingJump(statement, t, 0)) {
      return { reason: 'case body jumps out of the switch' }
    }
  }
  return { statements: kept }
}

/**
 * True when `node` always leaves the enclosing function (so a case body ending
 * in it cannot fall through).
 * @param {object|undefined} node
 * @param {object} t
 * @returns {boolean}
 */
function isTerminating(node, t) {
  return Boolean(node) && (t.isReturnStatement(node) || t.isThrowStatement(node))
}

/**
 * True when a statement contains a jump that would leave the dispatch switch,
 * i.e. one the flattened form could not reproduce. Jumps that target a nested
 * loop/switch inside the case body stay valid and are allowed; labelled jumps
 * are rejected because their target cannot be decided locally.
 * @param {object} node
 * @param {object} t
 * @param {number} breakableDepth number of enclosing loops/switches inside the case
 * @returns {boolean}
 */
function hasEscapingJump(node, t, breakableDepth) {
  if (!node || typeof node !== 'object') return false
  if (t.isBreakStatement(node) || t.isContinueStatement(node)) {
    return Boolean(node.label) || breakableDepth === 0
  }
  const nested = breakableDepth + (t.isLoop(node) || t.isSwitchStatement(node) ? 1 : 0)
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && hasEscapingJump(item, t, nested)) return true
      }
    } else if (child && hasEscapingJump(child, t, nested)) {
      return true
    }
  }
  return false
}

/**
 * Statically decide whether a loop test is always truthy, so `while (true)`,
 * `while (!![])` and friends are recognised without evaluating anything.
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
 * @param {object} loop WhileStatement or ForStatement
 * @param {object} t
 * @returns {boolean}
 */
function isInfiniteLoop(loop, t) {
  if (t.isWhileStatement(loop)) return staticTruthiness(loop.test, t) === true
  if (t.isForStatement(loop)) {
    if (loop.init || loop.update) return false
    if (!loop.test) return true
    return staticTruthiness(loop.test, t) === true
  }
  return false
}
