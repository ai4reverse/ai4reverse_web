/**
 * Constraint-solving analysis of a JavaScript source.
 *
 * The analyzer is static: it parses the sample, collects the conditions a
 * control-flow decision depends on, and asks z3 whether any of them is
 * constant. It reports three kinds of evidence:
 *
 *  - `opaquePredicates`: a branch/loop/ternary condition proven true or false
 *    for every input in the modeled domain (`unsat` of the negation, or of the
 *    condition itself).
 *  - `unreachableBranches`: an `if` arm whose path condition is unsatisfiable.
 *  - `simplifications`: a z3 normal form for an MBA/bitwise condition, with the
 *    equivalence query that checked it.
 *
 * Soundness is explicit. Only `exact` translations are proven by default; a
 * symbolic number may be fractional/NaN/Infinity, and treating it as an `Int`
 * is an assumption, not a fact. `assumeIntegers: true` opts into that model and
 * every finding carries the assumption.
 *
 * The analyzer never executes the sample and never lets a z3 failure escape:
 * an unsupported construct or a solver timeout is a counted, reported outcome.
 */

import { parse } from '../restore/parse.js'
import { traverse } from '../util/babel.js'
import { createZ3Context, z3Version } from './z3.js'
import { createTranslator, expressionText } from './translate.js'
import { normalizeConstraintLimits } from './limits.js'

const FINDING_LIMIT = 100

/**
 * @param {string} source
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'script'|'module'|'unambiguous'} [options.sourceType]
 * @param {boolean} [options.assumeIntegers] allow integer-model proofs
 * @param {boolean} [options.assumeInt32] tie Int/BitVec to signed int32
 * @param {object} [options.limits]
 * @param {number} [options.maxPredicates]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.budgetMs]
 * @param {boolean} [options.dynamic] unused; accepted for option-bag symmetry
 * @returns {Promise<object>}
 */
export async function analyzeConstraints(source, options = {}) {
  const started = Date.now()
  const limitOverrides = options.limits && typeof options.limits === 'object' ? options.limits : {}
  const limits = normalizeConstraintLimits({
    ...limitOverrides,
    ...(options.maxPredicates !== undefined ? { maxPredicates: options.maxPredicates } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.solverRlimit !== undefined ? { solverRlimit: options.solverRlimit } : {}),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  })
  const text = String(source ?? '')
  const assumeIntegers = options.assumeIntegers === true
  const assumeInt32 = options.assumeInt32 === true
  const assumptions = []
  if (assumeInt32) assumptions.push('int32')
  if (assumeIntegers) assumptions.push('integers')

  /** @type {object} */
  const report = {
    enabled: true,
    ok: false,
    engine: 'z3-solver',
    parse: { ok: false, sourceType: null, errors: [] },
    stats: emptyStats(),
    opaquePredicates: [],
    unreachableBranches: [],
    simplifications: [],
    assumptions,
    limits: {
      maxPredicates: limits.maxPredicates,
      maxBranches: limits.maxBranches,
      maxPathConditions: limits.maxPathConditions,
      timeoutMs: limits.timeoutMs,
      solverRlimit: limits.solverRlimit,
      budgetMs: limits.budgetMs,
    },
    truncated: false,
    notes: [],
    error: null,
    elapsedMs: 0,
  }

  if (text.trim().length === 0) {
    report.ok = true
    report.parse = { ok: true, sourceType: 'script', errors: [] }
    report.notes.push('empty source')
    report.elapsedMs = Date.now() - started
    return report
  }

  let parsed
  try {
    parsed = parse(text, {
      sourceType: options.sourceType ?? 'script',
      filename: options.filename,
      errorRecovery: true,
    })
  } catch (error) {
    report.error = { message: error.message }
    report.parse = { ok: false, sourceType: null, errors: [{ message: error.message }] }
    report.elapsedMs = Date.now() - started
    return report
  }
  report.parse = {
    ok: parsed.errors.length === 0,
    sourceType: parsed.sourceType,
    errors: parsed.errors.slice(0, 10).map((error) => ({ message: String(error.message ?? error) })),
  }

  let contextInfo
  try {
    contextInfo = await createZ3Context('constraint-analyze')
  } catch (error) {
    report.error = { message: `cannot load z3-solver: ${error.message}` }
    report.elapsedMs = Date.now() - started
    return report
  }
  const { api, context } = contextInfo
  report.engineVersion = z3Version(api)
  const translator = createTranslator(api, context, {
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
    assumeIntegers,
    assumeInt32,
  })

  const collected = collectCandidates(parsed.ast, text, limits)
  report.stats.candidates = collected.candidates.length
  report.stats.branches = collected.branches.length
  if (collected.truncated) {
    report.truncated = true
    report.notes.push(`candidate/branch collection stopped at a configured limit`)
  }

  let solverCalls = 0
  const budget = makeBudget(started, limits.budgetMs)

  for (const candidate of collected.candidates) {
    if (report.opaquePredicates.length >= limits.maxFindings || report.simplifications.length >= limits.maxFindings) {
      report.truncated = true
      break
    }
    if (!budget.remaining()) {
      report.truncated = true
      report.notes.push(`solver budget of ${limits.budgetMs}ms exhausted`)
      break
    }
    const translated = translator.translateConditionSafe(candidate.node, { scope: candidate.scope })
    if (!translated.supported) {
      report.stats.unsupported += 1
      continue
    }
    report.stats.predicates += 1
    if (!translated.exact && !assumeIntegers) {
      report.stats.inexact += 1
      continue
    }
    const proof = await proveConstant(context, translated.expr, {
      timeoutMs: budget.timeout(limits.timeoutMs),
      rlimit: limits.solverRlimit,
      onCall: () => { solverCalls += 1 },
    })
    if (!proof) {
      report.truncated = true
      continue
    }
    if (proof.status === 'always-true' || proof.status === 'always-false') {
      report.stats.proven += 1
      report.stats.opaque += 1
      report.opaquePredicates.push({
        kind: proof.status,
        role: candidate.kind,
        line: candidate.line,
        column: candidate.column,
        text: candidate.text,
        variables: translated.variables.slice(0, limits.maxVariables),
        exact: translated.exact,
        pure: translated.pure,
        assumptions,
        proof: proof.status === 'always-true' ? 'unsat-negation' : 'unsat-positive',
      })
    } else if (proof.status === 'unknown') {
      report.stats.undecided += 1
    }

    // A condition that is not opaque can still have an MBA normal form worth
    // recording. Only exact bitwise-heavy terms are simplified.
    if (translated.exact && bitwiseWeight(candidate.node) >= 2 && report.simplifications.length < limits.maxFindings) {
      const simplified = await simplifyTerm(context, translated.expr, {
        timeoutMs: budget.timeout(limits.timeoutMs),
        rlimit: limits.solverRlimit,
        onCall: () => { solverCalls += 1 },
      })
      if (simplified?.changed) {
        report.stats.simplifications += 1
        report.simplifications.push({
          role: candidate.kind,
          line: candidate.line,
          column: candidate.column,
          text: candidate.text,
          simplified: truncate(simplified.text, limits.maxTextLength),
          variables: translated.variables.slice(0, limits.maxVariables),
          exact: translated.exact,
          pure: translated.pure,
          assumptions,
          verification: simplified.verification,
        })
      }
    }
  }

  const mutationCache = new WeakMap()
  for (const branch of collected.branches) {
    if (report.unreachableBranches.length >= limits.maxFindings) {
      report.truncated = true
      break
    }
    if (!budget.remaining()) {
      report.truncated = true
      break
    }
    // Sharing identifier symbols between the conditions of one path is only
    // sound when no executing statement before the arm can reassign one. If
    // anything on the path mutates or calls out, each condition gets a fresh
    // symbol scope: weaker, but never a false `unsat`.
    const canSharePathSymbols = !pathHasMutation(branch.path, {
      assumeNumeric: assumeIntegers || assumeInt32,
      cache: mutationCache,
    })
    const conditions = enclosingConditions(branch.path, limits, text)
    const base = []
    let supported = true
    for (const condition of conditions) {
      if (!canSharePathSymbols) translator.resetSymbols()
      const translated = translator.translateConditionSafe(condition.node, { scope: condition.scope })
      if (!translated.supported || (!translated.exact && !assumeIntegers)) {
        supported = false
        break
      }
      base.push({ translated, truth: condition.truth, text: condition.text })
    }
    if (!supported) {
      report.stats.unsupportedBranches += 1
      continue
    }

    if (!canSharePathSymbols) translator.resetSymbols()
    const test = translator.translateConditionSafe(branch.node.test, { scope: branch.scope })
    if (!test.supported || (!test.exact && !assumeIntegers)) {
      report.stats.unsupportedBranches += 1
      continue
    }
    const arms = [
      { role: 'if-consequent', truth: true, present: true },
      { role: 'if-alternate', truth: false, present: Boolean(branch.node.alternate) },
    ]
    for (const arm of arms) {
      if (!arm.present) continue
      if (!budget.remaining()) {
        report.truncated = true
        break
      }
      const terms = base.map((condition) =>
        condition.truth ? condition.translated.expr : context.Not(condition.translated.expr),
      )
      terms.push(arm.truth ? test.expr : context.Not(test.expr))
      const conjunction = terms.length === 1 ? terms[0] : context.And(...terms)
      const answer = await checkStatus(context, conjunction, {
        timeoutMs: budget.timeout(limits.timeoutMs),
        rlimit: limits.solverRlimit,
        onCall: () => { solverCalls += 1 },
      })
      if (answer === 'unsat') {
        report.stats.unreachable += 1
        report.unreachableBranches.push({
          kind: arm.role,
          line: nodeLine(branch.node),
          column: nodeColumn(branch.node),
          text: truncate(branch.text, limits.maxTextLength),
          path: base.map((condition) => condition.text).slice(0, limits.maxPathConditions),
          variables: [...new Set([...test.variables, ...base.flatMap((item) => item.translated.variables)])]
            .sort()
            .slice(0, limits.maxVariables),
          exact: test.exact && base.every((item) => item.translated.exact),
          pure: test.pure && base.every((item) => item.translated.pure),
          assumptions: assumptions,
          proof: 'unsat-path',
        })
      } else if (answer === 'unknown') {
        report.stats.undecidedBranches += 1
      }
    }
  }

  report.stats.solverCalls = solverCalls
  report.ok = true
  report.elapsedMs = Date.now() - started
  return report
}

/**
 * Extract the syntactic path conditions for every `if` arm without solving.
 *
 * This is the readable half of branch feasibility: each entry lists the
 * enclosing facts (outer `if`/ternary polarity, short-circuit facts, loop
 * guards) plus the arm's own test. Feed the texts to `solveConstraints()` to
 * ask whether an arm is reachable.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'script'|'module'|'unambiguous'} [options.sourceType]
 * @param {object} [options.limits]
 * @returns {{ok: boolean, parse: object, branches: object[], truncated: boolean, notes: string[], error: {message: string}|null}}
 */
export function collectPathConditions(source, options = {}) {
  const limits = normalizeConstraintLimits(options.limits ?? {})
  const text = String(source ?? '')
  const result = {
    ok: false,
    parse: { ok: false, sourceType: null, errors: [] },
    branches: [],
    truncated: false,
    notes: [],
    error: null,
  }
  if (text.trim().length === 0) {
    result.ok = true
    result.parse = { ok: true, sourceType: 'script', errors: [] }
    result.notes.push('empty source')
    return result
  }
  let parsed
  try {
    parsed = parse(text, {
      sourceType: options.sourceType ?? 'script',
      filename: options.filename,
      errorRecovery: true,
    })
  } catch (error) {
    result.error = { message: error.message }
    return result
  }
  result.parse = {
    ok: parsed.errors.length === 0,
    sourceType: parsed.sourceType,
    errors: parsed.errors.slice(0, 10).map((error) => ({ message: String(error.message ?? error) })),
  }

  try {
    traverse(parsed.ast, {
      IfStatement(path) {
        if (result.branches.length >= limits.maxBranches) {
          result.truncated = true
          return
        }
        const enclosing = enclosingConditions(path, limits, text)
        const branchText = nodeText(text, path.node.test, limits.maxTextLength)
        const consequent = [
          ...enclosing.map(conditionEntry),
          { text: branchText, truth: true, line: nodeLine(path.node.test), column: nodeColumn(path.node.test) },
        ]
        const alternate = [
          ...enclosing.map(conditionEntry),
          { text: branchText, truth: false, line: nodeLine(path.node.test), column: nodeColumn(path.node.test) },
        ]
        result.branches.push({
          line: nodeLine(path.node),
          column: nodeColumn(path.node),
          text: branchText,
          consequent,
          alternate,
          hasAlternate: Boolean(path.node.alternate),
        })
      },
    })
  } catch (error) {
    result.truncated = true
    result.notes.push(`path collection stopped: ${error.message}`)
  }
  result.ok = true
  return result
}

function conditionEntry(condition) {
  return {
    text: condition.text,
    truth: condition.truth,
    line: nodeLine(condition.node),
    column: nodeColumn(condition.node),
  }
}

function emptyStats() {
  return {
    candidates: 0,
    predicates: 0,
    proven: 0,
    opaque: 0,
    undecided: 0,
    unsupported: 0,
    inexact: 0,
    branches: 0,
    unreachable: 0,
    unsupportedBranches: 0,
    undecidedBranches: 0,
    simplifications: 0,
    solverCalls: 0,
  }
}

/**
 * Collect condition nodes and `if` branches in one traversal.
 *
 * @param {object} ast
 * @param {string} source
 * @param {object} limits
 */
function collectCandidates(ast, source, limits) {
  const candidates = []
  const branches = []
  const seen = new Set()
  let truncated = false

  const add = (node, kind, path) => {
    if (!node || typeof node.type !== 'string') return
    if (candidates.length >= limits.maxPredicates || branches.length >= limits.maxBranches) {
      truncated = true
      return
    }
    const key = `${node.start ?? '?'}:${node.end ?? '?'}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      node,
      kind,
      scope: path?.scope ?? null,
      line: nodeLine(node),
      column: nodeColumn(node),
      text: nodeText(source, node, limits.maxTextLength),
    })
  }

  try {
    traverse(ast, {
      IfStatement(path) {
        if (branches.length >= limits.maxBranches) {
          truncated = true
          return
        }
        branches.push({
          node: path.node,
          path,
          scope: path.scope,
          text: nodeText(source, path.node.test, limits.maxTextLength),
        })
        add(path.node.test, 'if-test', path)
      },
      ConditionalExpression(path) {
        add(path.node.test, 'conditional-test', path)
      },
      WhileStatement(path) {
        add(path.node.test, 'while-test', path)
      },
      DoWhileStatement(path) {
        add(path.node.test, 'do-while-test', path)
      },
      ForStatement(path) {
        add(path.node.test, 'for-test', path)
      },
      LogicalExpression(path) {
        add(path.node, 'logical', path)
      },
    })
  } catch {
    truncated = true
  }

  return { candidates, branches, truncated }
}

/**
 * Collect the conditions that must hold for `path` to be reached, outermost
 * first. Function boundaries stop the walk: an outer branch does not constrain
 * the body of a function that may be called later.
 *
 * @param {object} path Babel NodePath
 * @param {object} limits
 * @returns {Array<{node: object, truth: boolean, scope: object|null, text: string}>}
 */
function enclosingConditions(path, limits, source = '') {
  const conditions = []
  let child = path
  let parent = path.parentPath
  while (parent && conditions.length < limits.maxPathConditions) {
    if (isFunction(parent.node)) break
    if (parent.isIfStatement?.()) {
      if (child.key === 'consequent') add(parent.node.test, true, parent.scope)
      else if (child.key === 'alternate') add(parent.node.test, false, parent.scope)
    } else if (parent.isConditionalExpression?.()) {
      if (child.key === 'consequent') add(parent.node.test, true, parent.scope)
      else if (child.key === 'alternate') add(parent.node.test, false, parent.scope)
    } else if (parent.isLogicalExpression?.()) {
      if (child.key === 'right') add(parent.node.left, parent.node.operator === '&&', parent.scope)
    } else if (parent.isWhileStatement?.() && child.key === 'body') {
      add(parent.node.test, true, parent.scope)
    } else if (parent.isForStatement?.() && child.key === 'body') {
      add(parent.node.test, true, parent.scope)
    }
    child = parent
    parent = parent.parentPath
  }
  // Reverse to outermost-first for readable paths.
  return conditions.reverse()

  function add(node, truth, scope) {
    if (!node) return
    if (conditions.length >= limits.maxPathConditions) return
    conditions.push({
      node,
      truth,
      scope,
      text: truncate(nodeText(source, node, limits.maxTextLength), limits.maxTextLength),
    })
  }
}

/**
 * True when a statement/expression can assign a binding or run arbitrary code.
 * Function/class bodies are skipped: defining them does not run them.
 *
 * @param {object} root
 * @returns {boolean}
 */
function containsMutation(root, options = {}) {
  if (!root || typeof root !== 'object') return false
  const cache = options.cache
  if (cache && cache.has(root)) return cache.get(root)
  const result = containsMutationUncached(root, options)
  if (cache) cache.set(root, result)
  return result
}

function containsMutationUncached(root, options = {}) {
  const assumeNumeric = options.assumeNumeric === true
  if (!root || typeof root.type !== 'string') return false
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node.type !== 'string') continue
    if (isFunction(node)) {
      // Static blocks and static field initializers run at class definition;
      // instance fields/methods do not run until construction/call.
      const runsAtDefinition =
        node.type === 'StaticBlock' ||
        ((node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty' || node.type === 'ClassAccessorProperty') &&
          node.static === true)
      if (!runsAtDefinition) {
        // A computed key still evaluates when the class is defined.
        if (node.key && containsMutation(node.key, options)) return true
        continue
      }
    }
    switch (node.type) {
      case 'AssignmentExpression':
      case 'UpdateExpression':
      case 'CallExpression':
      case 'NewExpression':
      case 'TaggedTemplateExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'ImportExpression':
      case 'WithStatement':
      case 'MemberExpression':
      case 'OptionalMemberExpression':
      case 'SpreadElement':
      case 'ForInStatement':
      case 'ForOfStatement':
      // Creating these does not run code, but coercing them can. Treat them as
      // mutation carriers so a preceding expression cannot be assumed inert.
      case 'ObjectExpression':
      case 'ArrayExpression':
      case 'RegExpLiteral':
      case 'ClassExpression':
      // Destructuring reads properties/iterators, which can run getters.
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'RestElement':
        return true
      case 'UnaryExpression':
        if (node.operator === 'delete') return true
        if (!assumeNumeric && ['+', '-', '~'].includes(node.operator)) return true
        break
      case 'TemplateLiteral':
        if (!assumeNumeric && node.expressions.length > 0) return true
        break
      case 'BinaryExpression':
        // `in` and `instanceof` can run proxy/`Symbol.hasInstance` code.
        if (node.operator === 'in' || node.operator === 'instanceof') return true
        if (
          !assumeNumeric &&
          ['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '<', '<=', '>', '>=', '==', '!='].includes(
            node.operator,
          )
        ) {
          return true
        }
        break
      default:
        break
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === 'string') stack.push(item)
      } else if (value && typeof value.type === 'string') {
        stack.push(value)
      }
    }
  }
  return false
}

/**
 * True when code executed before `path` can change a variable the path
 * conditions read. Sibling statements before the branch, enclosing condition
 * tests, loop headers and short-circuit left operands are all evaluated first;
 * statements after the branch are not.
 *
 * @param {object} path Babel NodePath of an IfStatement
 * @returns {boolean}
 */
function pathHasMutation(path, options = {}) {
  if (containsMutation(path.node.test, options)) return true
  let child = path
  let parent = path.parentPath
  while (parent) {
    if (isFunction(parent.node)) break

    // Preceding array siblings (Program/Block/SwitchCase bodies) execute first.
    if (child.listKey && Number.isInteger(child.key)) {
      const list = parent.node[child.listKey]
      if (Array.isArray(list)) {
        for (let index = 0; index < child.key; index += 1) {
          if (containsMutation(list[index], options)) return true
        }
      }
    }

    if (parent.isIfStatement?.() || parent.isConditionalExpression?.()) {
      if (child.key !== 'test' && containsMutation(parent.node.test, options)) return true
    } else if (parent.isWhileStatement?.() || parent.isDoWhileStatement?.() || parent.isForStatement?.()) {
      // A second iteration can change a value after an outer condition ran.
      // Do not share symbols across a loop boundary.
      if (child.key === 'body') return true
      if (child.key === 'test' && containsMutation(parent.node.test, options)) return true
      if (parent.isForStatement?.() && containsMutation(parent.node.init, options)) return true
      if (parent.isForStatement?.() && containsMutation(parent.node.update, options)) return true
    } else if (parent.isForInStatement?.() || parent.isForOfStatement?.()) {
      if (child.key === 'body') return true
      if (containsMutation(parent.node.right, options)) return true
    } else if (parent.isLogicalExpression?.()) {
      if (child.key === 'right' && containsMutation(parent.node.left, options)) return true
    } else if (parent.isSwitchCase?.()) {
      // The current case test runs before this case body.
      if (containsMutation(parent.node.test, options)) return true
    } else if (parent.isSwitchStatement?.()) {
      if (child.key !== 'discriminant' && containsMutation(parent.node.discriminant, options)) return true
    } else if (parent.isTryStatement?.()) {
      // A catch/finally block runs after the try block; mutations there can
      // change values that an outer condition saw.
      if (child.key === 'handler' && containsMutation(parent.node.block, options)) return true
      if (
        child.key === 'finalizer' &&
        (containsMutation(parent.node.block, options) || containsMutation(parent.node.handler, options))
      ) {
        return true
      }
    }

    child = parent
    parent = parent.parentPath
  }
  return false
}

function isFunction(node) {
  return Boolean(node) && [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
    'ClassProperty',
    'ClassPrivateProperty',
    'ClassAccessorProperty',
    'StaticBlock',
  ].includes(node.type)
}

/**
 * @param {object} context
 * @param {object} expr
 * @param {{timeoutMs: number, onCall: () => void}} options
 * @returns {Promise<{status: 'always-true'|'always-false'|'contingent'|'unknown'}|null>}
 */
async function proveConstant(context, expr, options) {
  let notStatus
  let yesStatus
  let notSolver
  let yesSolver
  try {
    options.onCall()
    notSolver = new context.Solver()
    notSolver.set('timeout', options.timeoutMs)
    if (options.rlimit) notSolver.set('rlimit', options.rlimit)
    notSolver.add(context.Not(expr))
    notStatus = await notSolver.check()

    options.onCall()
    yesSolver = new context.Solver()
    yesSolver.set('timeout', options.timeoutMs)
    if (options.rlimit) yesSolver.set('rlimit', options.rlimit)
    yesSolver.add(expr)
    yesStatus = await yesSolver.check()

    if (notStatus === 'unsat') return { status: 'always-true' }
    if (yesStatus === 'unsat') return { status: 'always-false' }
    if (notStatus === 'unknown' || yesStatus === 'unknown') return { status: 'unknown' }
    return { status: 'contingent' }
  } catch {
    // A z3 internal failure is an undecided query, not an analysis crash.
    return { status: 'unknown' }
  } finally {
    release(notSolver)
    release(yesSolver)
  }
}

/**
 * @param {object} context
 * @param {object} expr
 * @param {{timeoutMs: number, onCall: () => void}} options
 * @returns {Promise<{changed: boolean, text: string, verification: string}|null>}
 */
async function simplifyTerm(context, expr, options) {
  try {
    options.onCall()
    const simplified = await context.simplify(expr)
    const before = expr.toString()
    const text = simplified.toString()
    if (before === text) return { changed: false, text, verification: 'unchanged' }
    const solver = new context.Solver()
    try {
      options.onCall()
      solver.set('timeout', options.timeoutMs)
      if (options.rlimit) solver.set('rlimit', options.rlimit)
      solver.add(context.Not(expr.eq(simplified)))
      const status = await solver.check()
      if (status === 'unsat') return { changed: true, text, verification: 'unsat-negation' }
      // A normal form whose equivalence could not be checked is not evidence.
      return { changed: false, text, verification: status === 'sat' ? 'counterexample' : 'unknown' }
    } finally {
      release(solver)
    }
  } catch {
    return null
  }
}

async function checkStatus(context, expr, options) {
  options.onCall()
  const solver = new context.Solver()
  try {
    solver.set('timeout', options.timeoutMs)
    if (options.rlimit) solver.set('rlimit', options.rlimit)
    solver.add(expr)
    const status = await solver.check()
    return status === 'sat' || status === 'unsat' || status === 'unknown' ? status : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    release(solver)
  }
}

function release(solver) {
  try {
    solver?.release?.()
  } catch {
    // Nothing to do: the solver is already gone.
  }
}

function makeBudget(started, budgetMs) {
  return {
    remaining() {
      return Date.now() - started < budgetMs
    },
    timeout(requested) {
      const left = budgetMs - (Date.now() - started)
      return Math.max(1, Math.min(requested, left))
    },
  }
}

/**
 * Count bitwise operators and boolean connectives in an expression subtree.
 * Used only to decide whether a z3 normal form is worth showing.
 */
function bitwiseWeight(node, depth = 0) {
  if (!node || typeof node.type !== 'string' || depth > 32) return 0
  let weight = 0
  if (node.type === 'BinaryExpression' && ['&', '|', '^', '<<', '>>', '>>>'].includes(node.operator)) weight += 1
  if (node.type === 'UnaryExpression' && node.operator === '~') weight += 1
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) weight += bitwiseWeight(item, depth + 1)
    } else if (value && typeof value.type === 'string') {
      weight += bitwiseWeight(value, depth + 1)
    }
  }
  return weight
}

function nodeLine(node) {
  return Number.isInteger(node?.loc?.start?.line) ? node.loc.start.line : null
}

function nodeColumn(node) {
  return Number.isInteger(node?.loc?.start?.column) ? node.loc.start.column + 1 : null
}

function nodeText(source, node, limit) {
  if (typeof source === 'string' && Number.isInteger(node?.start) && Number.isInteger(node?.end) && node.end > node.start) {
    return truncate(source.slice(node.start, node.end).replace(/\s+/g, ' ').trim(), limit)
  }
  return expressionText(node, limit)
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

export { FINDING_LIMIT }
