/**
 * Satisfiability, validity and model helpers over the AST → z3 translator.
 *
 * Three questions are exposed:
 *
 *  - `solveConstraints(conditions)` asks whether a conjunction is satisfiable
 *    and, when it is, returns one model. This is the primitive behind branch
 *    feasibility and string-array index recovery.
 *  - `provePredicate(condition)` asks whether a condition is true (or false)
 *    for *every* value, and returns a counterexample when it is neither.
 *  - `proveEquivalent(left, right)` / `simplifyExpression(expression)` compare
 *    and simplify two terms.
 *
 * Every call creates a private z3 context and solver, sets a timeout, and
 * releases the solver afterwards. `unknown` is a first-class answer: z3 is not
 * required to decide a query, and a timeout must never be reported as a proof.
 */

import { parse } from '../restore/parse.js'
import { createZ3Context } from './z3.js'
import { createTranslator, expressionText } from './translate.js'
import { ConstraintError, ConstraintSyntaxError } from './errors.js'
import { normalizeConstraintLimits } from './limits.js'

const MAX_CONSTRAINTS = 256

/**
 * Parse one JS expression source. Wrapping in parentheses keeps an object
 * literal from being read as a block, and is removed by the parser.
 *
 * @param {string} source
 * @param {object} [options]
 * @returns {object} Babel expression node
 */
export function parseExpression(source, options = {}) {
  const text = String(source ?? '').trim()
  if (text.length === 0) throw new ConstraintSyntaxError('expression source is empty')
  let parsed
  try {
    // The newline keeps a trailing `// comment` from swallowing the wrapper.
    parsed = parse(`(\n${text}\n);`, {
      sourceType: 'script',
      errorRecovery: false,
      filename: options.filename,
    })
  } catch (error) {
    throw new ConstraintSyntaxError(`cannot parse expression: ${error.message}`, {
      cause: error,
      details: { source: text.slice(0, 240) },
    })
  }
  const statement = parsed.ast.program.body[0]
  if (!statement || statement.type !== 'ExpressionStatement') {
    throw new ConstraintSyntaxError('source is not an expression statement')
  }
  return statement.expression
}

/**
 * Normalize a constraint argument into `{source|node, scope}` items.
 *
 * @param {string|object|Array<string|object>} constraints
 * @returns {Array<{source?: string, node?: object, scope?: object|null}>}
 */
function normalizeConstraints(constraints) {
  const list = Array.isArray(constraints)
    ? constraints
    : constraints && typeof constraints === 'object' && Array.isArray(constraints.constraints)
      ? constraints.constraints
      : [constraints]
  if (list.length === 0) throw new ConstraintError('at least one constraint is required')
  if (list.length > MAX_CONSTRAINTS) {
    throw new ConstraintError(`too many constraints (${list.length} > ${MAX_CONSTRAINTS})`)
  }
  return list.map((item, index) => {
    if (typeof item === 'string') return { source: item }
    if (item && typeof item === 'object') {
      if (item.node && typeof item.node.type === 'string') return { node: item.node, scope: item.scope ?? null }
      if (typeof item.source === 'string') return { source: item.source, scope: item.scope ?? null }
    }
    throw new ConstraintError(`constraint ${index} is neither a source string nor an expression node`)
  })
}

/**
 * Solve a conjunction of JS conditions.
 *
 * @param {string|object|Array<string|object>} constraints
 * @param {object} [options]
 * @param {number} [options.timeoutMs] per-query solver timeout
 * @param {boolean} [options.assumeIntegers] solve over exact integers (default true)
 * @param {boolean} [options.assumeInt32] solve over signed 32-bit values
 * @param {object} [options.limits]
 * @returns {Promise<{ok: boolean, status: 'sat'|'unsat'|'unknown'|'error', satisfiable: boolean, model: object|null, variables: string[], expressions: string[], assumptions: string[], elapsedMs: number, reason: string|null, error: {message: string}|null}>}
 */
export async function solveConstraints(constraints, options = {}) {
  const started = Date.now()
  const limits = normalizeConstraintLimits(options.limits ?? options)
  const timeoutMs = positive(options.timeoutMs, limits.timeoutMs)
  const assumeIntegers = options.assumeIntegers !== false
  let assumptions = []
  const items = normalizeConstraints(constraints)

  // Parse before choosing the domain: arithmetic-only constraints use the
  // unbounded Int model (nonlinear solving stays cheap and models are plain
  // integers), while a bitwise constraint needs the tied int32 interpretation
  // for one coherent `x`. An explicit `assumeInt32` always wins.
  const prepared = []
  for (const item of items) {
    if (item.node) {
      prepared.push(item)
      continue
    }
    try {
      prepared.push({ ...item, node: parseExpression(item.source) })
    } catch (error) {
      return result({ ok: false, status: 'error', error: { message: error.message, code: error.code ?? null } })
    }
  }
  const usesBitwise = prepared.some((item) => containsBitwise(item.node))
  const assumeInt32 = options.assumeInt32 !== undefined ? options.assumeInt32 === true : usesBitwise
  assumptions = assumptionsFor({ assumeIntegers, assumeInt32 })

  let contextInfo
  try {
    contextInfo = await createZ3Context('constraint-solve')
  } catch (error) {
    return result({ ok: false, status: 'error', error: { message: `cannot load z3-solver: ${error.message}` } })
  }
  const { api, context } = contextInfo
  const translator = createTranslator(api, context, {
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
    assumeIntegers,
    assumeInt32,
  })
  const solver = new context.Solver()
  const variables = new Set()
  const expressions = []
  let modelSafe = true
  try {
    solver.set('timeout', timeoutMs)
    solver.set('rlimit', limits.solverRlimit)
    for (const item of prepared) {
      const node = item.node
      const translated = translator.translateConditionSafe(node, { scope: item.scope ?? null })
      if (!translated.supported) {
        return result({
          ok: false,
          status: 'error',
          error: { message: translated.reason ?? 'constraint is not translatable', code: 'CONSTRAINT_UNSUPPORTED' },
        })
      }
      for (const name of translated.variables) variables.add(name)
      expressions.push(item.source ?? expressionText(node, limits.maxTextLength))
      modelSafe = modelSafe && isModelUsable(node, translated, assumeInt32)
      solver.add(translated.expr)
    }

    const status = await solver.check()
    if (status === 'sat') {
      const model = solver.model()
      return result({
        ok: true,
        status,
        satisfiable: true,
        modelSafe,
        model: modelSafe ? readModel(translator, model) : null,
        modelBitVec: usesBitwise ? readBitVecModel(translator, model) : null,
        variables: [...variables].sort(),
        expressions,
        durationMs: Date.now() - started,
      })
    }
    if (status === 'unsat') {
      return result({
        ok: true,
        status,
        satisfiable: false,
        model: null,
        variables: [...variables].sort(),
        expressions,
        durationMs: Date.now() - started,
      })
    }
    return result({
      ok: false,
      status: 'unknown',
      satisfiable: false,
      model: null,
      variables: [...variables].sort(),
      expressions,
      durationMs: Date.now() - started,
      reason: safeReason(solver),
    })
  } catch (error) {
    return result({
      ok: false,
      status: 'error',
      satisfiable: false,
      model: null,
      variables: [...variables].sort(),
      expressions,
      durationMs: Date.now() - started,
      error: { message: error.message, code: error.code ?? null },
    })
  } finally {
    release(solver)
  }

  function result(value) {
    return {
      ok: value.ok ?? false,
      status: value.status ?? 'error',
      satisfiable: value.satisfiable ?? false,
      modelSafe: value.modelSafe ?? false,
      model: value.model ?? null,
      modelBitVec: value.modelBitVec ?? null,
      variables: value.variables ?? [],
      expressions: value.expressions ?? [],
      assumptions,
      timeoutMs,
      elapsedMs: value.durationMs ?? Date.now() - started,
      reason: value.reason ?? null,
      error: value.error ?? null,
    }
  }
}

/**
 * Prove whether one condition is constant.
 *
 * `always-true` is established by `unsat(not P)`; `always-false` by
 * `unsat(P)`. A satisfiable counterexample is returned when the condition is
 * contingent. Defaults are deliberately sound: integer arithmetic is only
 * assumed when the caller asks for it.
 *
 * @param {string|object} condition
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.assumeIntegers]
 * @param {boolean} [options.assumeInt32]
 * @param {object} [options.scope]
 * @param {object} [options.limits]
 * @returns {Promise<{ok: boolean, status: 'always-true'|'always-false'|'contingent'|'unknown'|'unsupported'|'error', alwaysTrue: boolean, alwaysFalse: boolean, proved: boolean, model: object|null, counterexample: object|null, variables: string[], expression: string, exact: boolean, assumptions: string[], elapsedMs: number, reason: string|null, error: {message: string}|null}>}
 */
export async function provePredicate(condition, options = {}) {
  const started = Date.now()
  const limits = normalizeConstraintLimits(options.limits ?? options)
  const timeoutMs = positive(options.timeoutMs, limits.timeoutMs)
  const assumeIntegers = options.assumeIntegers === true
  const assumeInt32 = options.assumeInt32 === true
  const assumptions = assumptionsFor({ assumeIntegers, assumeInt32 })
  let modelSafe = false

  let contextInfo
  try {
    contextInfo = await createZ3Context('constraint-prove')
  } catch (error) {
    return finish({ ok: false, status: 'error', error: { message: `cannot load z3-solver: ${error.message}` } })
  }
  const { api, context } = contextInfo
  const translator = createTranslator(api, context, {
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
    assumeIntegers,
    assumeInt32,
  })

  let node = condition
  let text = typeof condition === 'string' ? condition.trim() : expressionText(node, limits.maxTextLength)
  if (typeof condition === 'string') {
    try {
      node = parseExpression(condition)
    } catch (error) {
      return finish({
        ok: false,
        status: 'error',
        error: { message: error.message, code: error.code ?? null },
      })
    }
  }
  if (!node || typeof node.type !== 'string') {
    return finish({ ok: false, status: 'error', error: { message: 'condition is not an AST node' } })
  }

  const translated = translator.translateConditionSafe(node, { scope: options.scope ?? null })
  if (!translated.supported) {
    return finish({
      ok: false,
      status: 'unsupported',
      reason: translated.reason,
      variables: translated.variables,
    })
  }

  const variables = translated.variables
  modelSafe = isModelUsable(node, translated, assumeInt32)
  let notSolver
  let yesSolver
  try {
    notSolver = new context.Solver()
    notSolver.set('timeout', timeoutMs)
    notSolver.set('rlimit', limits.solverRlimit)
    notSolver.add(context.Not(translated.expr))
    const notStatus = await notSolver.check()
    if (notStatus === 'unsat') {
      return finish({
        ok: true,
        status: 'always-true',
        alwaysTrue: true,
        proved: true,
        variables,
        exact: translated.exact,
      })
    }

    yesSolver = new context.Solver()
    yesSolver.set('timeout', timeoutMs)
    yesSolver.set('rlimit', limits.solverRlimit)
    yesSolver.add(translated.expr)
    const yesStatus = await yesSolver.check()
    if (yesStatus === 'unsat') {
      return finish({
        ok: true,
        status: 'always-false',
        alwaysFalse: true,
        proved: true,
        variables,
        exact: translated.exact,
      })
    }

    if (notStatus === 'unknown' || yesStatus === 'unknown') {
      return finish({
        ok: false,
        status: 'unknown',
        variables,
        exact: translated.exact,
        reason: safeReason(notStatus === 'unknown' ? notSolver : yesSolver),
      })
    }

    // Both branches are satisfiable: report values that make P true and values
    // that make P false, so the caller can audit the verdict.
    const counterexample = modelSafe && notStatus === 'sat' && notSolver.model()
      ? readModel(translator, notSolver.model())
      : null
    const model = modelSafe && yesStatus === 'sat' && yesSolver.model()
      ? readModel(translator, yesSolver.model())
      : null
    return finish({
      ok: true,
      status: 'contingent',
      model,
      counterexample,
      variables,
      exact: translated.exact,
    })
  } catch (error) {
    return finish({
      ok: false,
      status: 'error',
      variables,
      error: { message: error.message, code: error.code ?? null },
    })
  } finally {
    release(notSolver)
    release(yesSolver)
  }

  function finish(value) {
    const status = value.status ?? 'error'
    return {
      ok: value.ok ?? false,
      status,
      alwaysTrue: value.alwaysTrue ?? status === 'always-true',
      alwaysFalse: value.alwaysFalse ?? status === 'always-false',
      proved: value.proved ?? false,
      modelSafe: value.modelSafe ?? modelSafe,
      model: value.model ?? null,
      counterexample: value.counterexample ?? null,
      variables: value.variables ?? [],
      expression: text,
      exact: value.exact ?? false,
      assumptions,
      timeoutMs,
      elapsedMs: Date.now() - started,
      reason: value.reason ?? null,
      error: value.error ?? null,
    }
  }
}

/**
 * Prove `left === right` for every value in the modeled domain.
 *
 * @param {string|object} left
 * @param {string|object} right
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.assumeIntegers]
 * @param {boolean} [options.assumeInt32]
 * @param {object} [options.limits]
 * @returns {Promise<{ok: boolean, equivalent: boolean, status: 'equivalent'|'different'|'unknown'|'unsupported'|'error', left: string, right: string, counterexample: object|null, exact: boolean, assumptions: string[], elapsedMs: number, reason: string|null, error: {message: string}|null}>}
 */
export async function proveEquivalent(left, right, options = {}) {
  const started = Date.now()
  const limits = normalizeConstraintLimits(options.limits ?? options)
  const timeoutMs = positive(options.timeoutMs, limits.timeoutMs)
  const assumeIntegers = options.assumeIntegers === true
  const assumeInt32 = options.assumeInt32 === true
  const assumptions = assumptionsFor({ assumeIntegers, assumeInt32 })

  let leftNode = left
  let rightNode = right
  let leftText = expressionText(left, limits.maxTextLength)
  let rightText = expressionText(right, limits.maxTextLength)
  try {
    if (typeof left === 'string') {
      leftNode = parseExpression(left)
      leftText = left.trim()
    }
    if (typeof right === 'string') {
      rightNode = parseExpression(right)
      rightText = right.trim()
    }
  } catch (error) {
    return equivalencesFinish({
      ok: false,
      status: 'error',
      error: { message: error.message, code: error.code ?? null },
    })
  }

  let contextInfo
  try {
    contextInfo = await createZ3Context('constraint-equivalent')
  } catch (error) {
    return equivalencesFinish({
      ok: false,
      status: 'error',
      error: { message: `cannot load z3-solver: ${error.message}` },
    })
  }
  const { api, context } = contextInfo
  const translator = createTranslator(api, context, {
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
    assumeIntegers,
    assumeInt32,
  })
  const leftValue = translator.translateSafe(leftNode, { scope: options.leftScope ?? null })
  const rightValue = translator.translateSafe(rightNode, { scope: options.rightScope ?? null })
  if (!leftValue.supported || !rightValue.supported) {
    return equivalencesFinish({
      ok: false,
      status: 'unsupported',
      reason: leftValue.reason ?? rightValue.reason,
    })
  }

  let leftTerm = leftValue
  let rightTerm = rightValue
  if (leftValue.sort !== rightValue.sort) {
    if (isNumericValue(leftValue) && isNumericValue(rightValue)) {
      leftTerm = translator.asIntValue(leftValue)
      rightTerm = translator.asIntValue(rightValue)
    } else {
      return equivalencesFinish({
        ok: false,
        status: 'unsupported',
        reason: `cannot compare ${leftValue.sort} with ${rightValue.sort}`,
      })
    }
  }

  const solver = new context.Solver()
  try {
    solver.set('timeout', timeoutMs)
    solver.set('rlimit', limits.solverRlimit)
    solver.add(context.Not(leftTerm.expr.eq(rightTerm.expr)))
    const status = await solver.check()
    if (status === 'unsat') {
      const exact = leftTerm.exact && rightTerm.exact
      return equivalencesFinish({
        ok: true,
        status: 'equivalent',
        equivalent: true,
        // A model equivalence is not a JS proof unless every term is exact.
        proved: exact,
        modelSafe: isModelUsable(leftNode, leftTerm, assumeInt32) &&
          isModelUsable(rightNode, rightTerm, assumeInt32),
        exact,
        variables: union(leftTerm.variables, rightTerm.variables),
      })
    }
    if (status === 'sat') {
      const modelSafe = isModelUsable(leftNode, leftTerm, assumeInt32) &&
        isModelUsable(rightNode, rightTerm, assumeInt32)
      return equivalencesFinish({
        ok: true,
        status: 'different',
        equivalent: false,
        modelSafe,
        counterexample: modelSafe ? readModel(translator, solver.model()) : null,
        exact: leftTerm.exact && rightTerm.exact,
        variables: union(leftTerm.variables, rightTerm.variables),
      })
    }
    return equivalencesFinish({
      ok: false,
      status: 'unknown',
      reason: safeReason(solver),
      variables: union(leftTerm.variables, rightTerm.variables),
    })
  } catch (error) {
    return equivalencesFinish({
      ok: false,
      status: 'error',
      error: { message: error.message, code: error.code ?? null },
    })
  } finally {
    release(solver)
  }

  function equivalencesFinish(value) {
    return {
      ok: value.ok ?? false,
      equivalent: value.equivalent === true,
      proved: value.proved === true,
      status: value.status ?? 'error',
      left: leftText,
      right: rightText,
      counterexample: value.counterexample ?? null,
      modelSafe: value.modelSafe ?? false,
      exact: value.exact ?? false,
      assumptions,
      variables: [...(value.variables ?? [])].sort(),
      timeoutMs,
      elapsedMs: Date.now() - started,
      reason: value.reason ?? null,
      error: value.error ?? null,
    }
  }
}

/**
 * Simplify an expression with z3's simplifier and verify that the result is
 * equivalent to the input in the same model.
 *
 * The result is SMT-LIB text (`(+ x 1)`), not reconstructed JS: z3's
 * normal form is evidence, and generating JS from it would reintroduce the
 * precedence/coercion decisions this component exists to avoid guessing.
 *
 * @param {string|object} expression
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, status: string, original: string, simplified: string, changed: boolean, equivalent: boolean, sort: string|null, exact: boolean, assumptions: string[], variables: string[], verification: string, elapsedMs: number, reason: string|null, error: {message: string}|null}>}
 */
export async function simplifyExpression(expression, options = {}) {
  const started = Date.now()
  const limits = normalizeConstraintLimits(options.limits ?? options)
  const timeoutMs = positive(options.timeoutMs, limits.timeoutMs)
  // Simplification defaults to the integer model (arithmetic needs it) but
  // keeps the Int/BitVec interpretations separate unless asked.
  const assumeIntegers = options.assumeIntegers !== false
  const assumeInt32 = options.assumeInt32 === true
  const assumptions = assumptionsFor({ assumeIntegers, assumeInt32 })

  let node = expression
  let sourceText = typeof expression === 'string' ? expression.trim() : expressionText(node, limits.maxTextLength)
  try {
    if (typeof expression === 'string') {
      node = parseExpression(expression)
    }
  } catch (error) {
    return simplifyFinish({
      ok: false,
      status: 'error',
      error: { message: error.message, code: error.code ?? null },
    })
  }

  let contextInfo
  try {
    contextInfo = await createZ3Context('constraint-simplify')
  } catch (error) {
    return simplifyFinish({ ok: false, status: 'error', error: { message: `cannot load z3-solver: ${error.message}` } })
  }
  const { api, context } = contextInfo
  const translator = createTranslator(api, context, {
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxNodes,
    assumeIntegers,
    assumeInt32,
  })
  const translated = translator.translateSafe(node, { scope: options.scope ?? null })
  if (!translated.supported) {
    return simplifyFinish({ ok: false, status: 'unsupported', reason: translated.reason })
  }

  try {
    const simplified = await context.simplify(translated.expr)
    const original = translated.expr.toString()
    const text = simplified.toString()
    let equivalent = false
    let verification = 'not-run'
    const solver = new context.Solver()
    try {
      solver.set('timeout', timeoutMs)
      solver.set('rlimit', limits.solverRlimit)
      solver.add(context.Not(translated.expr.eq(simplified)))
      const status = await solver.check()
      if (status === 'unsat') {
        equivalent = true
        verification = 'unsat-negation'
      } else if (status === 'sat') {
        verification = 'counterexample'
      } else {
        verification = 'unknown'
      }
    } finally {
      release(solver)
    }
    const changed = original !== text
    return simplifyFinish({
      ok: verification !== 'counterexample' && verification !== 'unknown',
      status: !changed ? 'unchanged' : equivalent ? 'simplified' : verification,
      original,
      simplified: text,
      changed,
      equivalent,
      proved: equivalent && translated.exact,
      sort: translated.sort,
      exact: translated.exact,
      variables: translated.variables,
      verification,
    })
  } catch (error) {
    return simplifyFinish({
      ok: false,
      status: 'error',
      error: { message: error.message, code: error.code ?? null },
    })
  }

  function simplifyFinish(value) {
    return {
      ok: value.ok ?? false,
      status: value.status ?? 'error',
      original: value.original ?? sourceText,
      simplified: value.simplified ?? sourceText,
      changed: value.changed ?? false,
      equivalent: value.equivalent === true,
      proved: value.proved === true,
      sort: value.sort ?? null,
      exact: value.exact ?? false,
      assumptions,
      variables: [...(value.variables ?? [])].sort(),
      verification: value.verification ?? 'not-run',
      timeoutMs,
      elapsedMs: Date.now() - started,
      reason: value.reason ?? null,
      error: value.error ?? null,
    }
  }
}

/**
 * Convenience: solve a single condition and return its model.
 *
 * @param {string|object} condition
 * @param {object} [options]
 */
export function solvePredicate(condition, options = {}) {
  return solveConstraints([condition], options)
}

/**
 * Read a model into a JSON-safe label → value map. BigInts become numbers when
 * they fit and decimal strings otherwise, so the result always serializes.
 *
 * @param {object} translator
 * @param {object} model
 * @returns {Record<string, number|string|boolean>}
 */
function readModel(translator, model) {
  const values = {}
  for (const symbol of sortedSymbols(translator)) {
    try {
      const evaluated = model.eval(symbol.expr, true)
      values[symbol.label] = z3Value(evaluated)
    } catch {
      // An unconstrained symbol may be absent from a partial model.
    }
  }
  return values
}

/**
 * Signed 32-bit interpretation of every symbol's native BitVec. This is the
 * value the bitwise fragment actually constrains when `assumeInt32` is off.
 *
 * @param {object} translator
 * @param {object} model
 * @returns {Record<string, number|string>}
 */
function readBitVecModel(translator, model) {
  const values = {}
  for (const symbol of sortedSymbols(translator)) {
    if (!symbol.bvExpr) continue
    try {
      const evaluated = model.eval(symbol.bvExpr, true)
      const raw = typeof evaluated.asSignedValue === 'function' ? evaluated.asSignedValue() : evaluated.value?.()
      if (typeof raw === 'bigint') values[symbol.label] = bigintValue(raw)
    } catch {
      // A vector that does not occur in the constraints may be unassigned.
    }
  }
  return values
}

function sortedSymbols(translator) {
  return [...translator.symbols.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

/**
 * @param {object} expr
 * @returns {number|string|boolean|null}
 */
function z3Value(expr) {
  try {
    if (typeof expr.value === 'function') {
      const value = expr.value()
      if (typeof value === 'bigint') return bigintValue(value)
      if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
      if (value && typeof value === 'object' && 'numerator' in value && 'denominator' in value) {
        const numerator = Number(value.numerator)
        const denominator = Number(value.denominator)
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
          return numerator / denominator
        }
      }
    }
    const text = expr.toString()
    if (text === 'true') return true
    if (text === 'false') return false
    return text
  } catch {
    return null
  }
}

function bigintValue(value) {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value)
  }
  return value.toString()
}

function assumptionsFor({ assumeIntegers, assumeInt32 }) {
  const assumptions = []
  if (assumeInt32) assumptions.push('int32')
  if (assumeIntegers) assumptions.push('integers')
  return assumptions
}

/**
 * A solver model is only meaningful to the caller when the translation did not
 * abstract values away (uninterpreted atoms, `typeof` tags) and, for bitwise
 * terms, when the Int and BitVec interpretations are tied (`assumeInt32`).
 *
 * @param {object} node
 * @param {object} translated
 * @param {boolean} assumeInt32
 * @returns {boolean}
 */
function isModelUsable(node, translated, assumeInt32) {
  if (!translated || translated.exact !== true || translated.uninterpreted > 0) return false
  if (translated.pure === false) return false
  if (containsNode(node, 'UnaryExpression', (item) => item.operator === 'typeof')) return false
  if (!assumeInt32 && containsBitwise(node)) return false
  return true
}

function containsBitwise(node, depth = 0) {
  if (!node || typeof node.type !== 'string') return false
  // Too deep to inspect safely: assume the conservative answer.
  if (depth > 64) return true
  if (node.type === 'BinaryExpression' && ['&', '|', '^', '<<', '>>', '>>>'].includes(node.operator)) return true
  if (node.type === 'UnaryExpression' && node.operator === '~') return true
  if (node.type === 'CallExpression') {
    const callee = node.callee
    if (
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'Math' &&
      callee.property?.type === 'Identifier' &&
      callee.property.name === 'imul'
    ) {
      return true
    }
  }
  return childNodes(node).some((child) => containsBitwise(child, depth + 1))
}

function containsNode(node, type, predicate = () => true, depth = 0) {
  if (!node || typeof node.type !== 'string') return false
  if (depth > 64) return true
  if (node.type === type && predicate(node)) return true
  return childNodes(node).some((child) => containsNode(child, type, predicate, depth + 1))
}

function childNodes(node) {
  const children = []
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') children.push(item)
    } else if (value && typeof value.type === 'string') {
      children.push(value)
    }
  }
  return children
}

function isNumericValue(value) {
  // Booleans are deliberately excluded: `true === 1` is false in JS, so
  // coercing a Bool to Int for an equivalence query would be unsound.
  return value.sort === 'int' || value.sort === 'bv32'
}

function union(left, right) {
  return new Set([...(left ?? []), ...(right ?? [])])
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

function safeReason(solver) {
  try {
    return typeof solver.reasonUnknown === 'function' ? solver.reasonUnknown() : null
  } catch {
    return null
  }
}

function release(solver) {
  try {
    solver?.release?.()
  } catch {
    // Releasing an already-collected solver is not a result.
  }
}
