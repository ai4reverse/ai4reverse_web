import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generate, generateExpression } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as stringsPass from '../tools/restore/passes/strings.js'
import * as constantFoldPass from '../tools/restore/passes/constant-fold.js'
import * as memberFoldPass from '../tools/restore/passes/member-fold.js'

const strings = { ...stringsPass.meta, run: stringsPass.run }
const constantFold = { ...constantFoldPass.meta, run: constantFoldPass.run }
const memberFold = { ...memberFoldPass.meta, run: memberFoldPass.run }

/**
 * Evaluate a JS expression source string the way the guest engine would.
 * @param {string} source
 * @returns {*}
 */
function evaluate(source) {
  return new Function('return (' + source + ')')()
}

/**
 * Run a pass over `<assignment> = <expression>;` and return both sources. The
 * assignment wrapper keeps the expression out of the directive-prologue slot.
 *
 * @param {object} pass
 * @param {string} expression
 * @returns {{original: string, folded: string, result: object}}
 */
function fold(pass, expression) {
  const { ast } = parse(`captured = ${expression};`)
  const original = generateExpression(ast.program.body[0].expression.right)
  const result = runPass(pass, ast)
  const folded = generateExpression(ast.program.body[0].expression.right)
  return { original, folded, result }
}

/**
 * Assert a pass rewrote the expression while preserving its value, optionally
 * pinning the folded value and/or the folded source text.
 *
 * @param {object} pass
 * @param {string} expression
 * @param {*} [expected] expected value of the folded expression
 * @param {string} [expectedSource] expected generated source of the folded expression
 * @returns {string}
 */
function assertFolded(pass, expression, expected, expectedSource) {
  const { original, folded, result } = fold(pass, expression)
  assert.equal(result.changed, true, `expected a reported change for ${expression}`)
  assert.deepEqual(evaluate(folded), evaluate(original), `semantics changed for ${expression}`)
  if (arguments.length > 2) assert.deepEqual(evaluate(folded), expected, `unexpected value for ${expression}`)
  if (arguments.length > 3) assert.equal(folded, expectedSource, `unexpected source for ${expression}`)
  return folded
}

/**
 * Assert a pass left the whole program untouched (and optionally recorded a note).
 *
 * @param {object} pass
 * @param {string} code
 * @param {RegExp} [notePattern]
 */
function assertUnchanged(pass, code, notePattern) {
  const { ast } = parse(code)
  const before = generate(ast).code
  const result = runPass(pass, ast)
  const after = generate(ast).code
  assert.equal(after, before, `expected no rewrite for ${code}`)
  assert.equal(result.changed, false, `expected no reported change for ${code}`)
  if (notePattern) {
    assert.ok(
      result.notes.some((note) => notePattern.test(note)),
      `expected a note matching ${notePattern}, got ${JSON.stringify(result.notes)}`,
    )
  }
}

test('constant-fold: folds arithmetic with the correct operator precedence', () => {
  assertFolded(constantFold, '1 + 2 * 3', 7, '7')
  assertFolded(constantFold, '(2 + 3) ** 2', 25, '25')
  assertFolded(constantFold, '10 % 4', 2)
  assertFolded(constantFold, '-(-5)', 5)
  assertFolded(constantFold, '0.1 + 0.2', 0.1 + 0.2, '0.30000000000000004')
})

test('constant-fold: folds concatenation and mixed-type coercion', () => {
  assertFolded(constantFold, "'a' + 1 + 2", 'a12', "'a12'")
  assertFolded(constantFold, "1 + 2 + 'a'", '3a')
  assertFolded(constantFold, "'a' + 1 * 2", 'a2')
  assertFolded(constantFold, "'5' * 2", 10)
  assertFolded(constantFold, '+true', 1)
})

test('constant-fold: folds bitwise, shift and unary operators', () => {
  assertFolded(constantFold, '~5', -6)
  assertFolded(constantFold, '5 >>> 1', 2)
  assertFolded(constantFold, '-8 >> 1', -4)
  assertFolded(constantFold, '1 << 10', 1024)
  assertFolded(constantFold, '6 & 3', 2)
  assertFolded(constantFold, '6 | 3', 7)
  assertFolded(constantFold, '6 ^ 3', 5)
  assertFolded(constantFold, '!0', true)
})

test('constant-fold: folds typeof and void over literal operands', () => {
  assertFolded(constantFold, 'typeof 5', 'number')
  assertFolded(constantFold, 'typeof null', 'object')
  assertFolded(constantFold, "typeof 'x'", 'string')
  assertFolded(constantFold, 'void 1', undefined, 'void 0')
})

test('constant-fold: folds comparisons and equality', () => {
  assertFolded(constantFold, "'5' == 5", true)
  assertFolded(constantFold, "'5' === 5", false)
  assertFolded(constantFold, '1 < 2 && 3 >= 3', true)
  assertFolded(constantFold, "'a' < 'b'", true)
})

test('constant-fold: folds logical, nullish and conditional operators', () => {
  assertFolded(constantFold, "0 || 'x'", 'x')
  assertFolded(constantFold, "1 && 'y'", 'y')
  assertFolded(constantFold, "null ?? 'd'", 'd')
  assertFolded(constantFold, "1 < 2 ? 'y' : 'n'", 'y')
  assertFolded(constantFold, "0 ? 'y' : 'n'", 'n')
  assertFolded(constantFold, 'undefined ?? 1', 1)
})

test('constant-fold: refuses non-finite results', () => {
  assertUnchanged(constantFold, 'captured = 1 / 0;')
  assertUnchanged(constantFold, 'captured = 0 / 0;')
  assertUnchanged(constantFold, 'captured = (2 ** 1024);')
})

test('constant-fold: leaves side-effecting or dynamic operands untouched', () => {
  assertUnchanged(constantFold, 'captured = f() + 1;')
  assertUnchanged(constantFold, 'captured = a + 1;')
  assertUnchanged(constantFold, "captured = 'a' + x;")
  assertUnchanged(constantFold, 'captured = typeof x;')
  assertUnchanged(constantFold, 'captured = 1 + obj.value;')
  assertUnchanged(constantFold, 'var undefined = 5; captured = undefined ?? 1;')
})

test('constant-fold: is idempotent across two runs', () => {
  const { ast } = parse("captured = ('a' + 1) + (2 * 3);")
  const first = runPass(constantFold, ast)
  assert.equal(first.changed, true)
  assert.equal(generateExpression(ast.program.body[0].expression.right), "'a16'")
  const second = runPass(constantFold, ast)
  assert.equal(second.changed, false)
})

test('member-fold: folds literal length and index reads', () => {
  assertFolded(memberFold, "'abc'['length']", 3, '3')
  assertFolded(memberFold, "'abc'.length", 3)
  assertFolded(memberFold, "'abc'[0]", 'a', "'a'")
  assertFolded(memberFold, "'abc'[2]", 'c')
  assertFolded(memberFold, '[1, 2, 3].length', 3)
  assertFolded(memberFold, '[1, 2, 3][1]', 2, '2')
  assertFolded(memberFold, "[1, 2, 3]['0']", 1)
})

test('member-fold: folds literal object property reads', () => {
  assertFolded(memberFold, "{'a': 1}['a']", 1, '1')
  assertFolded(memberFold, "({'a': 1, 'b': 'x'}).a", 1)
  assertFolded(memberFold, "({'a': true}).a", true)
  assertFolded(memberFold, "({'a': null}).a", null)
})

test('member-fold: folds pure string methods on literal receivers', () => {
  assertFolded(memberFold, "'hello'.charCodeAt(1)", 101, '101')
  assertFolded(memberFold, "'hello'.charAt(4)", 'o', "'o'")
  assertFolded(memberFold, "'hello'.indexOf('ll')", 2)
  assertFolded(memberFold, "'hello'.slice(1, 3)", 'el', "'el'")
  assertFolded(memberFold, "'hello'.slice(-3)", 'llo')
})

test('member-fold: folds pure Math functions on literal numbers', () => {
  assertFolded(memberFold, 'Math.max(3, 7, 5)', 7, '7')
  assertFolded(memberFold, 'Math.min(3, 7, 5)', 3)
  assertFolded(memberFold, 'Math.pow(2, 10)', 1024)
  assertFolded(memberFold, 'Math.sqrt(81)', 9)
  assertFolded(memberFold, 'Math.floor(-1.5)', -2, '-2')
  assertFolded(memberFold, 'Math.hypot(3, 4)', 5)
})

test('member-fold: folds nested literal chains', () => {
  assertFolded(memberFold, "'abc'.slice(1).length", 2, '2')
  assertFolded(memberFold, "'abc'.slice(1)[0]", 'b', "'b'")
  assertFolded(memberFold, '[10, 20, 30][2]', 30)
})

test('member-fold: leaves dynamic or unsafe members untouched', () => {
  assertUnchanged(memberFold, 'captured = s.length;')
  assertUnchanged(memberFold, 'captured = obj.prop;')
  assertUnchanged(memberFold, 'captured = [1, 2][i];')
  assertUnchanged(memberFold, 'captured = [1, f()][0];')
  assertUnchanged(memberFold, 'captured = [1, 2][-1];')
  assertUnchanged(memberFold, "captured = {'a': x}['a'];")
  // Inherited properties must not be materialised as `undefined`.
  assertUnchanged(memberFold, "captured = {'a': 1}['toString'];")
  assertUnchanged(memberFold, "captured = [1]['constructor'];")
  // Out of range code units are NaN, which has no literal spelling.
  assertUnchanged(memberFold, "captured = 'abc'.charCodeAt(9);")
  assertUnchanged(memberFold, 'captured = Math.random();')
  assertUnchanged(memberFold, 'captured = Math.max(1, x);')
  assertUnchanged(memberFold, 'var Math = fake; captured = Math.max(1, 2);')
})

test('member-fold: refuses to fold assignment targets', () => {
  assertUnchanged(memberFold, "'abc'[0] = 1;")
  assertUnchanged(memberFold, "'abc'.length = 1;")
  assertUnchanged(memberFold, "delete 'abc'[0];")
})

test('member-fold: is idempotent across two runs', () => {
  const { ast } = parse("captured = 'abcd'['length'] + Math.max(1, 2);")
  const first = runPass(memberFold, ast)
  assert.equal(first.changed, true)
  assert.equal(generateExpression(ast.program.body[0].expression.right), '4 + 2')
  const second = runPass(memberFold, ast)
  assert.equal(second.changed, false)
})

test('folds compose across the pass order', () => {
  // strings (30) -> constant-fold (35) -> member-fold (40) on one program.
  const { ast } = parse("captured = String.fromCharCode(72, 105) + '!' + 'abc'.length;")
  runPass(strings, ast)
  runPass(constantFold, ast)
  runPass(memberFold, ast)
  // Each pass runs once: member-fold turns `'abc'.length` into `3` after
  // constant-fold already visited the concatenation.
  const source = generateExpression(ast.program.body[0].expression.right)
  assert.equal(source, "'Hi!' + 3")
  assert.deepEqual(evaluate(source), 'Hi!3')
})
