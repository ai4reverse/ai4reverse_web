/**
 * Babel AST → z3 term translation.
 *
 * The translator models the *exact* JS fragment it can justify:
 *
 *  - `& | ^ ~ << >>` and `| 0` are translated through signed 32-bit
 *    bit-vectors (ToInt32). They are exact for primitive values, including
 *    `NaN`, `Infinity` and strings. An object's `ToPrimitive`/`valueOf` call is
 *    not modelled: the translator never executes it. `>>>` is converted back
 *    to an unsigned integer.
 *  - `!`, `&&`, `||`, `?:`, `typeof`, and equality/comparison of exact values
 *    are exact.
 *  - Integer arithmetic (`+ - * % ** /`) is translated over z3 `Int`. That is
 *    the integer model: a JS number can be fractional, `NaN`, `Infinity`, or
 *    lose precision above 2^53. Those terms therefore carry `exact: false`.
 *    Opaque-predicate proofs are claimed only for `exact` terms unless the
 *    caller explicitly sets `assumeIntegers: true`, which labels the result.
 *  - A construct the translator cannot model becomes a fresh uninterpreted
 *    symbol per AST node. Booleans are safely over-approximated by an
 *    unconstrained Bool; integer/string leaves are not exact. For a pure
 *    expression, repeated occurrences share one atom, so `p || !p` is still
 *    proven without pretending that `p` has a known value.
 *
 * Identifiers are always `Int` symbols. Restricting a variable to `String` or
 * `Bool` because one use looks like a string/boolean would shrink its domain
 * and could turn `x !== x` into a false "always false" claim.
 */

import { generateExpression } from '../restore/generate.js'

const INT = 'int'
const BV32 = 'bv32'
const BOOL = 'bool'
const STRING = 'string'
const TYPE = 'type'
const UNDEFINED = 'undefined'
const NULL = 'null'

/** Reserved `typeof` tags. Distinct tags are distinct integers. */
const TYPE_TAGS = Object.freeze({
  undefined: 0,
  object: 1,
  boolean: 2,
  number: 3,
  string: 4,
  function: 5,
  symbol: 6,
  bigint: 7,
})

const PURE_MATH = new Map([
  ['abs', 'abs'],
  ['floor', 'floor'],
  ['ceil', 'ceil'],
  ['round', 'round'],
  ['trunc', 'trunc'],
  ['sign', 'sign'],
  ['min', 'min'],
  ['max', 'max'],
  ['imul', 'imul'],
])

class BudgetExceeded extends Error {}

/**
 * Create a translator bound to one z3 context.
 *
 * @param {object} api z3 high-level API
 * @param {object} context z3 Context
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxNodes]
 * @param {boolean} [options.assumeIntegers] treat symbolic numbers as exact
 *   integers (disables the NaN/fraction/precision guard; callers must label it)
 * @param {boolean} [options.assumeInt32] treat symbolic numbers as signed
 *   32-bit integers, tying the Int and BitVec representations together
 */
export function createTranslator(api, context, options = {}) {
  const maxDepth = positive(options.maxDepth, 96)
  const maxNodes = positive(options.maxNodes, 4096)
  const assumeIntegers = options.assumeIntegers === true
  const assumeInt32 = options.assumeInt32 === true
  /** @type {Map<string, {expr: object, label: string}>} */
  const symbols = new Map()
  /** @type {Map<string, number>} */
  const labels = new Map()
  /**
   * Fresh names are unique across the whole context, not per translated
   * expression. Reusing `b0`/`eq0` for two path conditions would make z3
   * conflate them and could turn an unrelated pair into a false `unsat`.
   */
  let freshCounter = 0
  let typeSymbolCounter = 0
  /** Binding identity is per translator so symbol names are process-independent. */
  const bindingIds = new WeakMap()
  let nextBindingId = 1

  /**
   * @param {object} node
   * @param {object} [translateOptions]
   * @param {object|null} [translateOptions.scope] Babel scope for binding identity
   * @param {'any'|'int'|'bool'|'string'} [translateOptions.expected]
   * @returns {Translation}
   */
  function translate(node, translateOptions = {}) {
    const state = createState()
    return translateInner(node, translateOptions.scope ?? null, translateOptions.expected ?? 'any', state, 0)
  }

  /**
   * Never throws for an unsupported expression; returns `supported: false`
   * only when the structural budget was exhausted.
   *
   * @param {object} node
   * @param {object} [translateOptions]
   * @returns {SafeTranslation}
   */
  function translateSafe(node, translateOptions = {}) {
    try {
      const result = translate(node, translateOptions)
      return {
        supported: true,
        reason: null,
        ...result,
        variables: [...result.variables].sort(),
      }
    } catch (error) {
      // Structural budget or a z3 sort/encoding rejection: the expression is
      // unsupported, not a reason to crash the analysis.
      return {
        supported: false,
        reason: error.message,
        expr: null,
        sort: null,
        exact: false,
        nanSafe: false,
        integral: false,
        pure: false,
        uninterpreted: 0,
        variables: [],
      }
    }
  }

  /** @returns {object} */
  function createState() {
    return {
      nodes: 0,
      variables: new Set(),
      fresh: new WeakMap(),
      equalityAtoms: new Map(),
      relationalAtoms: new Map(),
      truthAtoms: new Map(),
      typeofBindings: new Map(),
      typeofNodes: new WeakMap(),
    }
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function translateInner(node, scope, expected, state, depth) {
    if (!node || typeof node.type !== 'string') {
      return soft(node, expected, state, 'not an AST node')
    }
    if (depth > maxDepth) throw new BudgetExceeded(`expression nesting exceeds ${maxDepth}`)
    state.nodes += 1
    if (state.nodes > maxNodes) throw new BudgetExceeded(`expression exceeds ${maxNodes} nodes`)

    switch (node.type) {
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
        return translateInner(node.expression, scope, expected, state, depth + 1)

      case 'NumericLiteral':
        return numericLiteral(node.value, node, state)
      case 'BooleanLiteral':
        return term(context.Bool.val(node.value), BOOL, { exact: true, integral: true })
      case 'StringLiteral':
        return term(context.String.val(node.value), STRING, { exact: true })
      case 'NullLiteral':
        return term(context.Int.val(0), NULL, { exact: true })
      case 'BigIntLiteral':
        return soft(node, expected, state, 'bigint arithmetic is not modelled')
      case 'TemplateLiteral':
        if (node.expressions.length === 0) {
          const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
          return term(context.String.val(text), STRING, { exact: true })
        }
        return soft(node, expected, state, 'template substitution is not modelled')

      case 'RegExpLiteral':
      case 'ArrayExpression':
      case 'ObjectExpression':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassExpression':
      case 'NewExpression':
      case 'TaggedTemplateExpression':
        return soft(node, expected, state, `${node.type} is not modelled`)

      case 'Identifier':
        return identifier(node, scope, state)

      case 'UnaryExpression':
        return unary(node, scope, expected, state, depth)
      case 'BinaryExpression':
        return binary(node, scope, expected, state, depth)
      case 'LogicalExpression':
        return logical(node, scope, expected, state, depth)
      case 'ConditionalExpression':
        return conditional(node, scope, expected, state, depth)
      case 'SequenceExpression':
        return sequence(node, scope, expected, state, depth)
      case 'AssignmentExpression': {
        const value = translateInner(node.right, scope, expected, state, depth + 1)
        return withPure(value, false)
      }
      case 'UpdateExpression':
        return soft(node, expected, state, 'update expression has an unmodelled side effect')
      case 'CallExpression':
        return call(node, scope, expected, state, depth)

      case 'ThisExpression':
      case 'Super':
      case 'MetaProperty':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'ImportExpression':
      case 'MemberExpression':
      case 'OptionalMemberExpression':
      case 'OptionalCallExpression':
      case 'AssignmentPattern':
      default:
        return soft(node, expected, state, `${node.type} is not modelled`)
    }
  }

  /**
   * @param {number} value
   * @param {object} node
   * @param {object} state
   * @returns {Translation}
   */
  function numericLiteral(value, node, state) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      return soft(node, INT, state, 'only finite integer literals are modelled', true)
    }
    return term(context.Int.val(value), INT, { exact: true, integral: true })
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {object} state
   * @returns {Translation}
   */
  function identifier(node, scope, state) {
    const name = node.name
    const binding = scope && typeof scope.getBinding === 'function' ? scope.getBinding(name) : null
    if (!binding && name === 'undefined') return term(context.Int.val(0), UNDEFINED, { exact: true })
    if (!binding && (name === 'NaN' || name === 'Infinity')) {
      return soft(node, INT, state, `${name} has no integer model`, true)
    }
    const key = binding ? `binding:${bindingKey(binding, name)}` : `global:${name}`
    let symbol = symbols.get(key)
    if (!symbol) {
      const unique = uniqueName(name)
      const bvExpr = context.BitVec.const(`${unique}_bv`, 32)
      symbol = {
        expr: assumeInt32 ? context.BV2Int(bvExpr, true) : context.Int.const(unique),
        bvExpr,
        label: displayLabel(name, key),
      }
      symbols.set(key, symbol)
    }
    state.variables.add(symbol.label)
    return term(symbol.expr, INT, {
      exact: assumeIntegers || assumeInt32,
      integral: assumeIntegers || assumeInt32,
      nanSafe: assumeIntegers || assumeInt32,
      variable: symbol.label,
      pure: true,
      bvExpr: symbol.bvExpr,
    })
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function unary(node, scope, expected, state, depth) {
    const operator = node.operator
    if (operator === 'typeof') {
      const argumentPure = isPureNode(node.argument)
      const tag = typeofTag(node.argument, scope, state)
      return term(tag, TYPE, { exact: true, pure: argumentPure })
    }
    if (operator === 'void') {
      const argument = translateInner(node.argument, scope, 'any', state, depth + 1)
      if (!argument.pure) return soft(node, expected, state, 'void operand has side effects')
      return term(context.Int.val(0), UNDEFINED, { exact: true })
    }
    if (operator === '!') {
      const argument = asBool(translateInner(node.argument, scope, 'any', state, depth + 1), state)
      return term(context.Not(argument.expr), BOOL, {
        exact: true,
        integral: true,
        pure: argument.pure,
        variables: argument.variables,
        uninterpreted: argument.uninterpreted,
      })
    }
    if (operator === '~') {
      const argument = translateInner(node.argument, scope, 'int', state, depth + 1)
      const bv = toBV(argument, state)
      return fromBV(bv.not(), true, {
        pure: argument.pure,
        variables: argument.variables,
        uninterpreted: argument.uninterpreted,
      })
    }
    if (operator === '+' || operator === '-') {
      const argument = asInt(translateInner(node.argument, scope, 'int', state, depth + 1), state)
      return term(operator === '-' ? argument.expr.neg() : argument.expr, INT, {
        exact: argument.exact,
        integral: argument.integral,
        nanSafe: argument.nanSafe,
        pure: argument.pure,
        variables: argument.variables,
        uninterpreted: argument.uninterpreted,
      })
    }
    if (operator === 'delete') return soft(node, expected, state, 'delete is not modelled')
    return soft(node, expected, state, `unary ${operator} is not modelled`)
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function binary(node, scope, expected, state, depth) {
    const operator = node.operator

    if (operator === 'instanceof' || operator === 'in') {
      return soft(node, BOOL, state, `${operator} is not modelled`)
    }

    const left = translateInner(node.left, scope, 'any', state, depth + 1)
    const right = translateInner(node.right, scope, 'any', state, depth + 1)

    if (operator === '+' && (left.sort === STRING || right.sort === STRING)) {
      if (left.sort !== STRING || right.sort !== STRING) {
        return soft(node, expected, state, 'mixed string/number concatenation is not modelled')
      }
      return term(left.expr.concat(right.expr), STRING, {
        exact: left.exact && right.exact,
        pure: left.pure && right.pure,
        variables: mergeVars(left, right),
        uninterpreted: left.uninterpreted + right.uninterpreted,
      })
    }

    if (['&', '|', '^', '<<', '>>', '>>>'].includes(operator)) {
      return bitwise(operator, left, right, state)
    }

    if (['==', '===', '!=', '!=='].includes(operator)) {
      return equality(operator, left, right, node, state)
    }

    if (['<', '<=', '>', '>='].includes(operator)) {
      return comparison(operator, left, right, node, state)
    }

    if (['+', '-', '*', '/', '%', '**'].includes(operator)) {
      return arithmetic(operator, left, right, node, state)
    }

    return soft(node, expected, state, `binary ${operator} is not modelled`)
  }

  /**
   * @param {string} operator
   * @param {Translation} left
   * @param {Translation} right
   * @param {object} state
   * @returns {Translation}
   */
  function bitwise(operator, left, right, state) {
    const a = toBV(left, state)
    const b = toBV(right, state)
    const pure = left.pure && right.pure
    const flags = {
      pure,
      variables: mergeVars(left, right),
      uninterpreted: left.uninterpreted + right.uninterpreted,
    }
    if (operator === '&') return fromBV(a.and(b), true, flags)
    if (operator === '|') return fromBV(a.or(b), true, flags)
    if (operator === '^') return fromBV(a.xor(b), true, flags)
    const masked = b.and(context.BitVec.val(31, 32))
    if (operator === '<<') return fromBV(a.shl(masked), true, flags)
    if (operator === '>>') return fromBV(a.ashr(masked), true, flags)
    return fromBV(a.lshr(masked), false, flags)
  }

  /**
   * @param {string} operator
   * @param {Translation} left
   * @param {Translation} right
   * @param {object} node
   * @param {object} state
   * @returns {Translation}
   */
  function equality(operator, left, right, node, state) {
    const strict = operator === '===' || operator === '!=='
    const negated = operator === '!==' || operator === '!='
    const pure = left.pure && right.pure
    const variables = mergeVars(left, right)
    const uninterpreted = left.uninterpreted + right.uninterpreted

    const tagged = coerceTypeLiteral(left, right, node)
    const a = tagged ? tagged.left : left
    const b = tagged ? tagged.right : right

    if (a.sort === b.sort && a.exact && b.exact) {
      const eq = a.expr.eq(b.expr)
      return term(negated ? context.Not(eq) : eq, BOOL, {
        exact: true,
        integral: true,
        pure,
        variables,
        uninterpreted,
      })
    }

    // A 32-bit bit-vector and an Int are both exact numeric values; compare
    // them as integers. Booleans are deliberately excluded: `1 === true` is
    // false in JS even though `1 == true` is true.
    if (a.exact && b.exact && isArith(a) && isArith(b)) {
      const bvConstant = bvSideConstant(a, b, node)
      if (bvConstant) {
        if (bvConstant.outOfRange) {
          const eq = context.Bool.val(false)
          return term(negated ? context.Not(eq) : eq, BOOL, {
            exact: true, integral: true, pure, variables, uninterpreted,
          })
        }
        const eq = a.sort === BV32
          ? a.expr.eq(context.BitVec.val(bvConstant.value, 32))
          : b.expr.eq(context.BitVec.val(bvConstant.value, 32))
        return term(negated ? context.Not(eq) : eq, BOOL, {
          exact: true, integral: true, pure, variables, uninterpreted,
        })
      }
      const ai = asInt(a, state)
      const bi = asInt(b, state)
      const eq = ai.expr.eq(bi.expr)
      return term(negated ? context.Not(eq) : eq, BOOL, {
        exact: true,
        integral: true,
        pure,
        variables,
        uninterpreted,
      })
    }

    if (a.exact && b.exact) {
      const typeString = classifyTypeStringEquality(a, b, node)
      if (typeString !== null) {
        const eq = context.Bool.val(typeString)
        return term(negated ? context.Not(eq) : eq, BOOL, {
          exact: true, integral: true, pure, variables, uninterpreted,
        })
      }
      const typeStringMix =
        (a.sort === TYPE && b.sort === STRING) || (a.sort === STRING && b.sort === TYPE)
      if (strict && a.sort !== b.sort && !typeStringMix && !(isArith(a) && isArith(b))) {
        // Strict equality across different JS types is always false.
        const eq = context.Bool.val(false)
        return term(negated ? context.Not(eq) : eq, BOOL, {
          exact: true, integral: true, pure, variables, uninterpreted,
        })
      }
      if (!strict) {
        const nullish =
          (a.sort === NULL && b.sort === UNDEFINED) || (a.sort === UNDEFINED && b.sort === NULL)
        if (nullish) {
          const eq = context.Bool.val(true)
          return term(negated ? context.Not(eq) : eq, BOOL, {
            exact: true, integral: true, pure, variables, uninterpreted,
          })
        }
        if (a.sort === BOOL && isArith(b)) {
          const leftInt = asInt(a, state)
          const rightInt = asInt(b, state)
          const eq = leftInt.expr.eq(rightInt.expr)
          return term(negated ? context.Not(eq) : eq, BOOL, {
            exact: true, integral: true, pure, variables, uninterpreted,
          })
        }
        if (b.sort === BOOL && isArith(a)) {
          const leftInt = asInt(a, state)
          const rightInt = asInt(b, state)
          const eq = leftInt.expr.eq(rightInt.expr)
          return term(negated ? context.Not(eq) : eq, BOOL, {
            exact: true, integral: true, pure, variables, uninterpreted,
          })
        }
      }
    }

    // A pure, non-exact equality is still a deterministic boolean. Sharing one
    // atom per operator family + operand pair keeps `p !== p` the complement of
    // `p === p` without claiming either one is constant.
    if (pure) {
      const key = `${strict ? 'strict' : 'loose'}:${atomKey(a)}:${atomKey(b)}`
      let atom = state.equalityAtoms.get(key)
      if (!atom) {
        atom = context.Bool.const(freshName('eq'))
        state.equalityAtoms.set(key, atom)
      }
      return term(negated ? context.Not(atom) : atom, BOOL, {
        exact: true,
        integral: true,
        pure: true,
        variables,
        uninterpreted: uninterpreted + 1,
      })
    }

    // Impure expressions can change between the two evaluations; do not share.
    return term(negated ? context.Not(freshBool(state)) : freshBool(state), BOOL, {
      exact: true,
      integral: true,
      pure: false,
      variables,
      uninterpreted: uninterpreted + 1,
    })
  }

  /**
   * @param {string} operator
   * @param {Translation} left
   * @param {Translation} right
   * @param {object} node
   * @param {object} state
   * @returns {Translation}
   */
  function comparison(operator, left, right, node, state) {
    const pure = left.pure && right.pure
    const variables = mergeVars(left, right)
    const uninterpreted = left.uninterpreted + right.uninterpreted

    if (left.exact && right.exact) {
      if (left.sort === STRING && right.sort === STRING) {
        // JS orders strings by UTF-16 code unit; z3 orders code points. For
        // non-ASCII (especially astral) text those differ, so only ASCII
        // literals are compared as an exact fragment.
        if (!asciiStringNode(node.left) || !asciiStringNode(node.right)) {
          return soft(node, BOOL, state, 'non-ASCII string ordering is not modelled', pure)
        }
        const expr =
          operator === '<' ? left.expr.lt(right.expr)
            : operator === '<=' ? left.expr.le(right.expr)
              : operator === '>' ? right.expr.lt(left.expr)
                : right.expr.le(left.expr)
        return term(expr, BOOL, { exact: true, integral: true, pure, variables, uninterpreted })
      }
      if (left.sort === BV32 && right.sort === BV32) {
        const expr =
          operator === '<' ? left.expr.slt(right.expr)
            : operator === '<=' ? left.expr.sle(right.expr)
              : operator === '>' ? left.expr.sgt(right.expr)
                : left.expr.sge(right.expr)
        return term(expr, BOOL, { exact: true, integral: true, pure, variables, uninterpreted })
      }
      if (isNumeric(left) && isNumeric(right)) {
        const a = asInt(left, state)
        const b = asInt(right, state)
        const expr =
          operator === '<' ? a.expr.lt(b.expr)
            : operator === '<=' ? a.expr.le(b.expr)
              : operator === '>' ? a.expr.gt(b.expr)
                : a.expr.ge(b.expr)
        return term(expr, BOOL, { exact: true, integral: true, pure, variables, uninterpreted })
      }
    }

    if (pure) {
      const key = `${operator}:${atomKey(left)}:${atomKey(right)}`
      let atom = state.relationalAtoms.get(key)
      if (!atom) {
        atom = context.Bool.const(freshName('rel'))
        state.relationalAtoms.set(key, atom)
      }
      return term(atom, BOOL, {
        exact: true,
        integral: true,
        pure: true,
        variables,
        uninterpreted: uninterpreted + 1,
      })
    }

    return term(freshBool(state), BOOL, {
      exact: true,
      integral: true,
      pure: false,
      variables,
      uninterpreted: uninterpreted + 1,
    })
  }

  /**
   * @param {string} operator
   * @param {Translation} left
   * @param {Translation} right
   * @param {object} node
   * @param {object} state
   * @returns {Translation}
   */
  function arithmetic(operator, left, right, node, state) {
    const a = asInt(left, state)
    const b = asInt(right, state)
    const pure = a.pure && b.pure
    const variables = mergeVars(a, b)
    const uninterpreted = a.uninterpreted + b.uninterpreted

    const constant = constantArithmetic(node, operator)
    if (constant !== null) {
      if (Number.isFinite(constant) && Number.isInteger(constant)) {
        return term(context.Int.val(constant), INT, { exact: true, integral: true, pure, variables, uninterpreted })
      }
      return soft(node, INT, state, 'constant result is not a finite integer', pure)
    }

    if (operator === '**') {
      const exponent = constantInt(node.right)
      if (exponent === null || exponent < 0 || exponent > 8) {
        return soft(node, INT, state, 'only constant exponents 0..8 are modelled', pure)
      }
      let expr = context.Int.val(1)
      for (let index = 0; index < exponent; index += 1) expr = expr.mul(a.expr)
      return term(expr, INT, {
        exact: a.exact, nanSafe: a.nanSafe, integral: a.integral, pure, variables, uninterpreted,
      })
    }

    if (operator === '/' || operator === '%') {
      const divisor = constantInt(node.right)
      if (divisor === null || divisor === 0) {
        return soft(node, INT, state, `symbolic or zero divisor in ${operator}`, pure)
      }
      const absA = context.If(a.expr.ge(0), a.expr, a.expr.neg())
      const absB = Math.abs(divisor)
      if (operator === '%') {
        const remainder = absA.mod(absB)
        const signed = context.If(a.expr.ge(0), remainder, remainder.neg())
        return term(signed, INT, {
          exact: a.exact && b.exact, nanSafe: a.nanSafe, integral: a.integral, pure, variables, uninterpreted,
        })
      }
      const quotient = absA.div(absB)
      const signed = context.If(a.expr.ge(0), quotient, quotient.neg())
      const expr = divisor < 0 ? signed.neg() : signed
      // The truncating Int quotient is not JS `/` unless the division is exact.
      return term(expr, INT, {
        exact: false, nanSafe: a.nanSafe, integral: a.integral, pure, variables, uninterpreted,
      })
    }

    const expr = operator === '-' ? a.expr.sub(b.expr)
      : operator === '*' ? a.expr.mul(b.expr)
        : a.expr.add(b.expr)
    return term(expr, INT, {
      exact: a.exact && b.exact,
      nanSafe: a.nanSafe && b.nanSafe,
      integral: a.integral && b.integral,
      pure,
      variables,
      uninterpreted,
    })
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function logical(node, scope, expected, state, depth) {
    if (node.operator === '??') {
      return soft(node, BOOL, state, 'nullish coalescing is not modelled')
    }
    const left = asBool(translateInner(node.left, scope, 'any', state, depth + 1), state)
    const right = asBool(translateInner(node.right, scope, 'any', state, depth + 1), state)
    const expr = node.operator === '&&' ? context.And(left.expr, right.expr) : context.Or(left.expr, right.expr)
    return term(expr, BOOL, {
      exact: true,
      integral: true,
      pure: left.pure && right.pure,
      variables: mergeVars(left, right),
      uninterpreted: left.uninterpreted + right.uninterpreted,
    })
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function conditional(node, scope, expected, state, depth) {
    const test = asBool(translateInner(node.test, scope, 'any', state, depth + 1), state)
    const consequent = translateInner(node.consequent, scope, expected, state, depth + 1)
    const alternate = translateInner(node.alternate, scope, expected, state, depth + 1)
    const sort = unify(consequent, alternate)
    if (!sort) return soft(node, expected, state, 'conditional branches have different sorts')
    const a = coerce(consequent, sort, state)
    const b = coerce(alternate, sort, state)
    return term(context.If(test.expr, a.expr, b.expr), sort, {
      exact: test.exact && a.exact && b.exact,
      nanSafe: a.nanSafe && b.nanSafe,
      integral: a.integral && b.integral,
      pure: test.pure && a.pure && b.pure,
      variables: mergeVars(test, a, b),
      uninterpreted: test.uninterpreted + a.uninterpreted + b.uninterpreted,
    })
  }

  /**
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function sequence(node, scope, expected, state, depth) {
    if (!Array.isArray(node.expressions) || node.expressions.length === 0) {
      return soft(node, expected, state, 'empty sequence')
    }
    const value = translateInner(node.expressions[node.expressions.length - 1], scope, expected, state, depth + 1)
    // Earlier elements may assign or call; do not treat the value as pure.
    return withPure(value, false)
  }

  /**
   * A small pure-call whitelist. Anything else is uninterpreted, never executed.
   *
   * @param {object} node
   * @param {object|null} scope
   * @param {string} expected
   * @param {object} state
   * @param {number} depth
   * @returns {Translation}
   */
  function call(node, scope, expected, state, depth) {
    const callee = node.callee
    if (callee?.type !== 'MemberExpression' || callee.computed) {
      return soft(node, expected, state, 'call is not modelled')
    }
    const object = callee.object
    const property = callee.property?.type === 'Identifier' ? callee.property.name : null
    if (!property) return soft(node, expected, state, 'computed property call is not modelled')

    const mathBinding = scope && typeof scope.getBinding === 'function' ? scope.getBinding('Math') : null
    if (object?.type === 'Identifier' && object.name === 'Math' && !mathBinding && PURE_MATH.has(property)) {
      const rawArgs = (node.arguments ?? []).map((argument) =>
        translateInner(argument, scope, 'int', state, depth + 1),
      )
      const args = rawArgs.map((argument) => asInt(argument, state))
      const pure = args.every((argument) => argument.pure)
      const variables = args.reduce((set, argument) => mergeVars({ variables: set }, argument), new Set())
      const uninterpreted = args.reduce((sum, argument) => sum + argument.uninterpreted, 0)
      const name = PURE_MATH.get(property)
      if (name === 'min' || name === 'max') {
        if (args.length === 0) return soft(node, INT, state, `Math.${property} needs an argument`)
        const expr = args.slice(1).reduce((acc, item) => {
          const pair = name === 'min' ? context.If(acc.expr.le(item.expr), acc.expr, item.expr)
            : context.If(acc.expr.ge(item.expr), acc.expr, item.expr)
          return {
            expr: pair,
            exact: acc.exact && item.exact,
            integral: acc.integral && item.integral,
            nanSafe: acc.nanSafe && item.nanSafe,
          }
        }, args[0])
        return term(expr.expr, INT, {
          exact: expr.exact, integral: expr.integral, nanSafe: expr.nanSafe, pure, variables, uninterpreted,
        })
      }
      if (name === 'imul') {
        if (args.length !== 2) return soft(node, INT, state, 'Math.imul needs two arguments')
        const a = toBV(rawArgs[0], state)
        const b = toBV(rawArgs[1], state)
        return fromBV(a.mul(b), true, { pure, variables, uninterpreted })
      }
      if (name === 'abs') {
        const arg = args[0]
        if (!arg) return soft(node, INT, state, 'Math.abs needs an argument')
        return term(context.If(arg.expr.ge(0), arg.expr, arg.expr.neg()), INT, {
          exact: arg.exact, integral: arg.integral, nanSafe: arg.nanSafe, pure, variables, uninterpreted,
        })
      }
      if (name === 'sign') {
        const arg = args[0]
        if (!arg) return soft(node, INT, state, 'Math.sign needs an argument')
        const expr = context.If(
          arg.expr.gt(0),
          context.Int.val(1),
          context.If(arg.expr.lt(0), context.Int.val(-1), context.Int.val(0)),
        )
        return term(expr, INT, {
          exact: arg.exact, integral: arg.integral, nanSafe: arg.nanSafe, pure, variables, uninterpreted,
        })
      }
      // floor/ceil/trunc/round are identity on integers.
      const arg = args[0]
      if (!arg) return soft(node, INT, state, `Math.${name} needs an argument`)
      return term(arg.expr, INT, {
        exact: arg.exact, integral: arg.integral, nanSafe: arg.nanSafe, pure, variables, uninterpreted,
      })
    }

    return soft(node, expected, state, 'call is not modelled')
  }

  /**
   * `typeof` is a deterministic function of its operand. Keying the tag by the
   * operand binding (not by the AST node) keeps `typeof x === 'number' ||
   * typeof x !== 'number'` a tautology without pretending any tag is known.
   *
   * @param {object} node
   * @param {object|null} scope
   * @param {object} state
   * @returns {object} a `type`-sorted expression
   */
  function typeofTag(node, scope, state) {
    const literal = literalTypeof(node, scope)
    if (literal) return context.Int.val(TYPE_TAGS[literal])
    if (node?.type === 'Identifier') {
      const binding = scope && typeof scope.getBinding === 'function' ? scope.getBinding(node.name) : null
      const key = binding ? `typeof:binding:${bindingKey(binding, node.name)}` : `typeof:global:${node.name}`
      let symbol = state.typeofBindings.get(key)
      if (!symbol) {
        symbol = context.Int.const(`c_type_${typeSymbolCounter}`)
        typeSymbolCounter += 1
        state.typeofBindings.set(key, symbol)
      }
      return symbol
    }
    // Identity, not source offsets: a programmatic AST may have no positions,
    // and two distinct expressions must never share a type tag. The map lives
    // in one translation state: sharing a tag across path conditions would be
    // unsound when a variable can be reassigned between them.
    let symbol = state.typeofNodes.get(node)
    if (!symbol) {
      symbol = context.Int.const(`c_type_node_${typeSymbolCounter}`)
      typeSymbolCounter += 1
      state.typeofNodes.set(node, symbol)
    }
    return symbol
  }

  /**
   * A `typeof` tag compared with a literal string that is not a tag can never
   * be equal. A non-literal string expression may evaluate to a tag, so it is
   * left as an atom.
   *
   * @param {Translation} left
   * @param {Translation} right
   * @param {object} node
   * @returns {boolean|null} equality value, or null when not decidable here
   */
  function classifyTypeStringEquality(left, right, node) {
    const cases = [
      { typeSide: left, stringSide: right, stringNode: node.right },
      { typeSide: right, stringSide: left, stringNode: node.left },
    ]
    for (const item of cases) {
      if (item.typeSide.sort !== TYPE || item.stringSide.sort !== STRING) continue
      const value = stringLiteralOf(item.stringNode)
      if (value !== null && !Object.hasOwn(TYPE_TAGS, value)) return false
    }
    return null
  }

  /**
   * Convert a `typeof` tag compared with a literal string into the same sort.
   *
   * @param {Translation} left
   * @param {Translation} right
   * @param {object} node
   * @returns {{left: Translation, right: Translation}|null}
   */
  function coerceTypeLiteral(left, right, node) {
    if (left.sort === TYPE && right.sort === STRING) {
      const value = stringLiteralOf(node.right)
      if (value !== null && Object.hasOwn(TYPE_TAGS, value)) {
        return { left, right: term(context.Int.val(TYPE_TAGS[value]), TYPE, { exact: true }) }
      }
    }
    if (right.sort === TYPE && left.sort === STRING) {
      const value = stringLiteralOf(node.left)
      if (value !== null && Object.hasOwn(TYPE_TAGS, value)) {
        return { left: term(context.Int.val(TYPE_TAGS[value]), TYPE, { exact: true }), right }
      }
    }
    return null
  }

  /**
   * @param {string} expectedSort
   * @param {Translation} value
   * @param {object} state
   * @returns {Translation}
   */
  function coerce(value, expectedSort, state) {
    if (value.sort === expectedSort) return value
    if (expectedSort === INT) return asInt(value, state)
    if (expectedSort === BV32) {
      const integer = asInt(value, state)
      return term(context.Int2BV(integer.expr, 32), BV32, {
        exact: integer.exact,
        integral: integer.integral,
        nanSafe: integer.nanSafe,
        pure: integer.pure,
        variables: integer.variables,
        uninterpreted: integer.uninterpreted,
      })
    }
    return soft(null, expectedSort, state, `cannot coerce ${value.sort} to ${expectedSort}`)
  }

  /** @param {Translation} left @param {Translation} right */
  function unify(left, right) {
    if (left.sort === right.sort) return left.sort
    if (isNumeric(left) && isNumeric(right)) return INT
    return null
  }

  function isNumeric(value) {
    return value.sort === INT || value.sort === BV32 || value.sort === BOOL
  }

  function isArith(value) {
    return value.sort === INT || value.sort === BV32
  }

  /**
   * When one side is a signed 32-bit vector and the other is an integer
   * constant, compare inside the bit-vector world instead of bit-blasting an
   * `Int2BV`/`BV2Int` round trip.
   *
   * @returns {{value: number, outOfRange?: boolean}|null}
   */
  function bvSideConstant(left, right, node) {
    if (left.sort === BV32 && right.sort === INT) {
      return classifyBvConstant(constantInt(node.right))
    }
    if (right.sort === BV32 && left.sort === INT) {
      return classifyBvConstant(constantInt(node.left))
    }
    return null
  }

  function classifyBvConstant(value) {
    if (value === null) return null
    if (value < -2147483648 || value > 2147483647) return { value, outOfRange: true }
    return { value }
  }

  /**
   * @param {Translation} value
   * @param {object} state
   * @returns {Translation}
   */
  function asInt(value, state) {
    if (value.sort === INT) return value
    if (value.sort === BV32) {
      return term(context.BV2Int(value.expr, true), INT, {
        exact: true,
        integral: true,
        nanSafe: true,
        pure: value.pure,
        variables: value.variables,
        uninterpreted: value.uninterpreted,
      })
    }
    if (value.sort === BOOL) {
      return term(context.If(value.expr, context.Int.val(1), context.Int.val(0)), INT, {
        exact: value.exact,
        integral: true,
        nanSafe: value.nanSafe,
        pure: value.pure,
        variables: value.variables,
        uninterpreted: value.uninterpreted,
      })
    }
    return soft(null, INT, state, `cannot read a ${value.sort} as a number`, value.pure)
  }

  /**
   * JavaScript truthiness.
   *
   * @param {Translation} value
   * @param {object} state
   * @returns {Translation}
   */
  function asBool(value, state) {
    if (value.sort === BOOL) return value
    if (value.sort === INT || value.sort === BV32) {
      if (value.exact) {
        const expr = value.sort === BV32
          ? value.expr.neq(context.BitVec.val(0, 32))
          : value.expr.neq(0)
        return term(expr, BOOL, {
          exact: true,
          integral: true,
          pure: value.pure,
          variables: value.variables,
          uninterpreted: value.uninterpreted,
        })
      }
      if (value.pure) {
        const key = `truth:${atomKey(value)}`
        let atom = state.truthAtoms.get(key)
        if (!atom) {
          atom = context.Bool.const(freshName('truth'))
          state.truthAtoms.set(key, atom)
        }
        return term(atom, BOOL, {
          exact: true,
          integral: true,
          pure: true,
          variables: value.variables,
          uninterpreted: value.uninterpreted + 1,
        })
      }
    }
    if (value.sort === STRING) {
      if (value.exact) {
        return term(value.expr.length().gt(0), BOOL, {
          exact: true, integral: true, pure: value.pure, variables: value.variables,
        })
      }
    }
    if (value.sort === UNDEFINED || value.sort === NULL) {
      return term(context.Bool.val(false), BOOL, { exact: true, integral: true })
    }
    if (value.sort === TYPE) {
      // `typeof x` is one of eight non-empty strings, so it is always truthy.
      return term(context.Bool.val(true), BOOL, { exact: true, integral: true, pure: value.pure })
    }
    return soft(null, BOOL, state, `cannot test the truthiness of a ${value.sort}`, value.pure)
  }

  /**
   * Convert a translated value to a 32-bit vector. Identifiers carry a native
   * BitVec symbol, so a bitwise-only predicate never bit-blasts an unbounded
   * Int (which makes z3 return `unknown` on ordinary identities).
   *
   * @param {Translation} value
   * @param {object} state
   * @returns {object}
   */
  function toBV(value, state) {
    if (value.sort === BV32) return value.expr
    if (value.sort === BOOL) {
      return context.Int2BV(context.If(value.expr, context.Int.val(1), context.Int.val(0)), 32)
    }
    if (value.sort === UNDEFINED || value.sort === NULL) return context.BitVec.val(0, 32)
    if (value.bvExpr) return value.bvExpr
    const integer = value.sort === INT ? value : asInt(value, state)
    return context.Int2BV(integer.expr, 32)
  }

  /**
   * @param {object} bv
   * @param {boolean} signed
   * @param {object} flags
   * @returns {Translation}
   */
  function fromBV(bv, signed, flags = {}) {
    const common = {
      exact: true,
      integral: true,
      nanSafe: true,
      pure: flags.pure !== false,
      variables: flags.variables,
      uninterpreted: flags.uninterpreted,
    }
    if (signed) return term(bv, BV32, common)
    return term(context.BV2Int(bv, false), INT, common)
  }

  /**
   * Uninterpreted value for a node. One symbol per (node, sort) so the same
   * syntactic occurrence is one value, while different occurrences stay
   * independent (never conflated into a false proof).
   *
   * @param {object|null} node
   * @param {string} expected
   * @param {object} state
   * @param {string} reason
   * @param {boolean} [pure]
   * @returns {Translation}
   */
  function soft(node, expected, state, reason, pure = false) {
    const sort = expected === 'string' ? STRING : expected === 'bool' ? BOOL : INT
    let perNode = null
    if (node && typeof node === 'object') {
      perNode = state.fresh.get(node) ?? null
      if (!perNode) {
        perNode = new Map()
        state.fresh.set(node, perNode)
      }
      const cached = perNode.get(sort)
      if (cached) return { ...cached, reason }
    }
    const name = freshName('u')
    const expr = sort === STRING ? context.String.const(name)
      : sort === BOOL ? context.Bool.const(name)
        : context.Int.const(name)
    const result = term(expr, sort, {
      exact: sort === BOOL,
      nanSafe: sort === BOOL,
      integral: sort === BOOL,
      pure,
      uninterpreted: 1,
      reason,
    })
    if (perNode) perNode.set(sort, result)
    return result
  }

  /**
   * @param {object} expr
   * @param {string} sort
   * @param {object} flags
   * @returns {Translation}
   */
  function term(expr, sort, flags = {}) {
    return {
      expr,
      sort,
      exact: flags.exact === true,
      nanSafe: flags.nanSafe ?? (flags.exact === true && (sort === INT || sort === BV32 || sort === BOOL)),
      integral: flags.integral ?? (flags.exact === true && (sort === INT || sort === BV32 || sort === BOOL)),
      pure: flags.pure ?? true,
      uninterpreted: flags.uninterpreted ?? 0,
      variables: new Set(flags.variables ?? (flags.variable ? [flags.variable] : [])),
      bvExpr: flags.bvExpr ?? null,
      reason: flags.reason ?? null,
    }
  }

  /**
   * @param {object} state
   * @returns {object}
   */
  function freshBool(state) {
    return context.Bool.const(freshName('u'))
  }

  function bindingKey(binding, name) {
    if (!bindingIds.has(binding)) bindingIds.set(binding, nextBindingId++)
    return `${name}:${bindingIds.get(binding)}`
  }

  function freshName(prefix) {
    const name = `c_${prefix}${freshCounter}`
    freshCounter += 1
    return name
  }

  function uniqueName(label) {
    const base = sanitizeName(label)
    const count = labels.get(base) ?? 0
    labels.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  }

  function displayLabel(label, key) {
    const count = labels.get(`display:${label}`) ?? 0
    labels.set(`display:${label}`, count + 1)
    return count === 0 ? label : `${label}#${count + 1}`
  }

  /**
   * Translate a value and coerce it to a boolean using JS truthiness.
   *
   * @param {object} node
   * @param {object} [translateOptions]
   * @returns {Translation}
   */
  function translateCondition(node, translateOptions = {}) {
    const state = createState()
    const value = translateInner(node, translateOptions.scope ?? null, 'any', state, 0)
    return asBool(value, state)
  }

  /**
   * @param {object} node
   * @param {object} [translateOptions]
   * @returns {SafeTranslation}
   */
  function translateConditionSafe(node, translateOptions = {}) {
    try {
      const result = translateCondition(node, translateOptions)
      return { supported: true, reason: null, ...result, variables: [...result.variables].sort() }
    } catch (error) {
      return {
        supported: false,
        reason: error.message,
        expr: null,
        sort: null,
        exact: false,
        nanSafe: false,
        integral: false,
        pure: false,
        uninterpreted: 0,
        variables: [],
      }
    }
  }

  return {
    api,
    context,
    translate,
    translateSafe,
    translateCondition,
    translateConditionSafe,
    /**
     * Coerce a translated value to an integer term (BV2Int for a vector,
     * If(0/1) for a boolean). The returned `exact` flag says whether the
     * coercion preserves the JS value.
     */
    asIntValue(value) {
      const state = createState()
      return asInt(value, state)
    },
    /**
     * Coerce a translated value to a boolean term using JS truthiness.
     */
    asBoolValue(value) {
      const state = createState()
      return asBool(value, state)
    },
    /** Symbol table for callers that need model values by label. */
    symbols,
    /**
     * Give the next translations fresh identifier symbols. Fresh/type/atom
     * names already use global counters, so clearing this map cannot collide;
     * callers use it when a shared variable may have been reassigned between
     * two path conditions.
     */
    resetSymbols() {
      symbols.clear()
    },
  }
}

/**
 * Translate one expression node.
 *
 * @param {object} api
 * @param {object} context
 * @param {object} node
 * @param {object} [options]
 * @param {object} [options.scope]
 * @param {'any'|'int'|'bool'|'string'} [options.expected]
 * @param {boolean} [options.assumeIntegers]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxNodes]
 * @returns {SafeTranslation}
 */
export function translateExpression(api, context, node, options = {}) {
  const translator = createTranslator(api, context, options)
  return translator.translateSafe(node, options)
}

/**
 * Readable text for a node; generator output is deterministic and bounded.
 *
 * @param {object} node
 * @param {number} [limit]
 * @returns {string}
 */
export function expressionText(node, limit = 240) {
  let text
  try {
    text = generateExpression(node)
  } catch {
    text = node?.type ?? 'unknown'
  }
  const value = String(text).replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Small constant evaluator used for divisors/exponents and literal typing.
 *
 * @param {object} node
 * @returns {number|null}
 */
export function constantInt(node) {
  if (!node) return null
  if (node.type === 'NumericLiteral') {
    return Number.isFinite(node.value) && Number.isInteger(node.value) ? node.value : null
  }
  if (node.type === 'ParenthesizedExpression') return constantInt(node.expression)
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const value = constantInt(node.argument)
    if (value === null) return null
    return node.operator === '-' ? -value : value
  }
  if (node.type === 'BinaryExpression' && ['+', '-', '*', '**'].includes(node.operator)) {
    const left = constantInt(node.left)
    const right = constantInt(node.right)
    if (left === null || right === null) return null
    if (node.operator === '+') return left + right
    if (node.operator === '-') return left - right
    if (node.operator === '*') return left * right
    if (right < 0 || right > 8) return null
    return left ** right
  }
  return null
}

/**
 * Evaluate a constant arithmetic subtree with JavaScript semantics. Returns
 * `null` when the operands are not constants or the operation is unsupported.
 *
 * @param {object} node
 * @param {string} operator
 * @returns {number|null}
 */
function constantArithmetic(node, operator) {
  const left = constantInt(node.left)
  const right = constantInt(node.right)
  if (left === null || right === null) return null
  if (operator === '+') return left + right
  if (operator === '-') return left - right
  if (operator === '*') return left * right
  if (operator === '%') return right === 0 ? null : left % right
  if (operator === '/') return right === 0 ? null : left / right
  if (operator === '**') return left ** right
  return null
}

function isPureNode(node) {
  if (!node || typeof node.type !== 'string') return false
  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'Identifier':
    case 'ThisExpression':
      return true
    case 'ParenthesizedExpression':
      return isPureNode(node.expression)
    case 'UnaryExpression':
      return node.operator !== 'delete' && isPureNode(node.argument)
    case 'BinaryExpression':
      return isPureNode(node.left) && isPureNode(node.right)
    case 'LogicalExpression':
      return isPureNode(node.left) && isPureNode(node.right)
    case 'ConditionalExpression':
      return isPureNode(node.test) && isPureNode(node.consequent) && isPureNode(node.alternate)
    case 'TemplateLiteral':
      return node.expressions.every(isPureNode)
    default:
      return false
  }
}

/**
 * @param {object} node
 * @param {object|null} scope
 * @returns {string|null}
 */
function literalTypeof(node, scope) {
  if (!node) return null
  switch (node.type) {
    case 'StringLiteral':
    case 'TemplateLiteral':
      return 'string'
    case 'NumericLiteral':
      return 'number'
    case 'BooleanLiteral':
      return 'boolean'
    case 'NullLiteral':
      return 'object'
    case 'BigIntLiteral':
      return 'bigint'
    case 'Identifier': {
      const binding = scope && typeof scope.getBinding === 'function' ? scope.getBinding(node.name) : null
      return !binding && node.name === 'undefined' ? 'undefined' : null
    }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'FunctionDeclaration':
    case 'ClassExpression':
      return 'function'
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'RegExpLiteral':
      return 'object'
    default:
      return null
  }
}

/**
 * @param {object} node
 * @returns {string|null}
 */
/**
 * True for a string literal whose UTF-16 code units are all ASCII. Only such
 * literals have the same ordering under JS and z3 string comparison.
 *
 * @param {object} node
 * @returns {boolean}
 */
function asciiStringNode(node) {
  const value = stringLiteralOf(node)
  return value !== null && /^[\x00-\x7F]*$/.test(value)
}

function stringLiteralOf(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  return null
}

/**
 * @param {object} value
 * @returns {string}
 */
function atomKey(value) {
  try {
    return `${value.sort}:${value.expr.sexpr?.() ?? value.expr.toString()}`
  } catch {
    return value.sort
  }
}

/**
 * @param {Translation[]} values
 * @returns {Set<string>}
 */
function mergeVars(...values) {
  const merged = new Set()
  for (const value of values) {
    if (!value?.variables) continue
    for (const name of value.variables) merged.add(name)
  }
  return merged
}

/**
 * @param {Translation} value
 * @param {boolean} pure
 * @returns {Translation}
 */
function withPure(value, pure) {
  return { ...value, pure }
}

function sanitizeName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9_$]/g, '_')
  // Identifier symbols get their own `v_` namespace so a sample variable
  // called `c_u0` cannot collide with a fresh atom.
  return `v_${/^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`}`
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

/**
 * @typedef {object} Translation
 * @property {object} expr
 * @property {string} sort
 * @property {boolean} exact
 * @property {boolean} nanSafe
 * @property {boolean} integral
 * @property {boolean} pure
 * @property {number} uninterpreted
 * @property {Set<string>} variables
 * @property {string|null} reason
 */

/**
 * @typedef {Translation & {supported: boolean, reason: string|null, variables: string[]}} SafeTranslation
 */
