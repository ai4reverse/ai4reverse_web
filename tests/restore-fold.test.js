import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generate, generateExpression } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as stringsPass from '../tools/restore/passes/strings.js'
import * as constantFoldPass from '../tools/restore/passes/constant-fold.js'
import * as memberFoldPass from '../tools/restore/passes/member-fold.js'
import * as jsfuckPass from '../tools/restore/passes/jsfuck.js'

const strings = { ...stringsPass.meta, run: stringsPass.run }
const constantFold = { ...constantFoldPass.meta, run: constantFoldPass.run }
const memberFold = { ...memberFoldPass.meta, run: memberFoldPass.run }
const jsfuck = { ...jsfuckPass.meta, run: jsfuckPass.run }

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

/**
 * Expression corpus for the fold passes.
 *
 * Every entry is side-effect free, so the invariant below is exact: whatever a
 * pass rewrites must still evaluate to the same value. The corpus deliberately
 * mixes the shapes the passes support (arithmetic, comparisons, members, string
 * decoders, literals) with the shapes they must refuse (calls, templates with
 * expressions, spread, shadowed globals, oversized payloads) so a guard cannot
 * silently start folding something unsafe.
 */
const FOLD_CORPUS = [
  // arithmetic and coercion
  '1 + 2', "'a' + 'b'", "'a' + 1", '1 + "a"', '[] + []', '[] + {}', '{} + []',
  '1 - 2', '2 * 3', '7 / 2', '7 % 2', '2 ** 10', '-1 + 1', '+true', '+null',
  '+undefined', '+""', '+[]', '1 * undefined', '-Infinity', '0 / 0',
  // bitwise, shift, unary
  '~0', '~-1', '1 << 4', '255 >> 4', '-8 >>> 28', '!0', '!{}', '!!"x"', 'void 0',
  // comparisons and equality
  '1 < 2', '2 <= 2', '3 > 1', '3 >= 4', '1 == "1"', '1 === "1"', 'null == undefined',
  'null === undefined', 'NaN === NaN',
  // logical, nullish and conditional
  '1 && 2', '0 || 5', 'null ?? 3', 'undefined ?? "fallback"', '1 ? "yes" : "no"',
  '0 ? "yes" : "no"', 'false && call()',
  // typeof / instanceof-shaped (never folded when dynamic)
  'typeof 1', 'typeof "s"', 'typeof undefined', 'typeof null',
  // strings and member access
  "'abc'.length", "'abc'[1]", "'abc'[0]", "[1, 2, 3].length", '[1, 2, 3][1]',
  '[][0]', "'abc'['length']", "'abc'[3]", '"ABC".toLowerCase()', '"abc".toUpperCase()',
  '"a,b,c".split(",").length', '" a ".trim().length', '"abc".indexOf("b")',
  '"abc".charCodeAt(0)', '"abc".slice(1)', '"abc".replace("a", "z")',
  // escapes and decoder-shaped literals
  '"\\x41\\x42"', '"\\u0041\\u0042"', '"\\n\\t"', "'\\u00e9'",
  "atob('SGVsbG8=')", "atob('')", "String.fromCharCode(72, 105)",
  "String.fromCharCode(0x48, 0x69)",
  // Math over literals
  'Math.max(1, 2)', 'Math.min(1, 2)', 'Math.abs(-3)', 'Math.floor(1.9)',
  'Math.round(1.5)', 'Math.sqrt(9)', 'Math.pow(2, 8)',
  // grouping and sequences
  '(1 + 2) * 3', '(1, 2, 3)', '((((1))))',
  // things no pass may fold
  'dynamic()', 'dynamic + 1', 'dynamic.length', 'String.fromCharCode(dynamic)',
  'atob(dynamicBase64)', '(`tpl ${dynamic}`)', '[1, ...[2]]', '({ a: 1 })',
  '`plain template`', '"a" + "b" + dynamic', 'NaN', 'Infinity', 'undefined',
  '123456789012345678901234567890n',
]

/** Deterministic stand-ins for the corpus's `dynamic`/`call` placeholders. */
function evaluateCorpus(source) {
  // eslint-disable-next-line no-new-func
  return new Function('dynamic', 'call', 'dynamicBase64', 'return (' + source + ')')(
    () => 7,
    (...args) => args.length,
    'SGk=',
  )
}

test('fold passes never change the value of an expression they rewrite', () => {
  for (const pass of [constantFold, memberFold, jsfuck, strings]) {
    for (const expression of FOLD_CORPUS) {
      const { original, folded, result } = fold(pass, expression)
      assert.equal(result.error, undefined, `${pass.id} threw on ${expression}: ${result.error?.message ?? ''}`)
      const expected = evaluateCorpus(original)
      const actual = evaluateCorpus(folded)
      if (typeof expected === 'number' && Number.isNaN(expected)) {
        assert.ok(Number.isNaN(actual), `${pass.id}: ${expression} -> ${folded} should stay NaN`)
      } else {
        assert.deepEqual(actual, expected, `${pass.id}: ${expression} -> ${folded}`)
      }
      // A pass that reports a change must have produced different text.
      if (result.changed) assert.notEqual(folded, original, `${pass.id}: ${expression} reported an identical rewrite`)
    }
  }
})

test('jsfuck folds every supported literal shape and refuses the rest', () => {
  assertFolded(jsfuck, '![] + []', 'false', "'false'")
  assertFolded(jsfuck, '[] + []', '', "''")
  assertFolded(jsfuck, '[] + {}', '[object Object]', "'[object Object]'")
  assertFolded(jsfuck, '+null', 0, '0')
  assertFolded(jsfuck, '+true', 1, '1')
  assertFolded(jsfuck, '~null', -1, '-1')
  assertFolded(jsfuck, '1 * undefined', NaN)
  assertFolded(jsfuck, '2 ** 3', 8, '8')
  assertFolded(jsfuck, '7 % 4', 3, '3')
  assertFolded(jsfuck, '10 / 4', 2.5, '2.5')
  assertFolded(jsfuck, '"abc"[1]', 'b', "'b'")
  assertFolded(jsfuck, '"abc".length', 3, '3')
  assertFolded(jsfuck, '[1, 2, 3][1]', 2, '2')
  assertFolded(jsfuck, '`plain`', 'plain', "'plain'")
  assertFolded(jsfuck, '(1, 2)', 2, '2')

  // Refusals: every shape outside the evaluator's subset is left intact.
  for (const expression of [
    '"abc"[true]',
    '`${1}`',
    '[1, ...[2]]',
    '[, 1]',
    '(() => 1)',
    'dynamic[0]',
    '"abc"[dynamic]',
  ]) {
    assertUnchanged(jsfuck, `captured = ${expression};`)
  }
})

test('fold passes skip a directive-prologue position and say why', () => {
  // A fold in the first statement of a function would turn that statement into a
  // directive, so `'\x41'` style escapes and member reads must stay put there.
  const cases = [
    { pass: memberFold, code: `function f(){ 'abc'[0]; return 'body' }`, note: /directive/i },
    { pass: strings, code: "function f(){ ('\\x41'); return 'body' }", note: /directive|strictness/i },
    { pass: strings, code: `function f(){ 'a' + 'b'; return 'body' }`, note: /directive/i },
  ]
  for (const testCase of cases) {
    const { ast } = parse(testCase.code)
    const before = generate(ast).code
    const result = runPass(testCase.pass, ast)
    assert.equal(result.changed, false, `${testCase.pass.id}: ${JSON.stringify(result.notes)}`)
    assert.equal(generate(ast).code, before)
    assert.ok(
      result.notes.some((note) => testCase.note.test(note)),
      `${testCase.pass.id}: ${JSON.stringify(result.notes)}`,
    )
  }

  // jsfuck refuses the position silently (the note would repeat per statement).
  const jsfuckCase = parse(`function f(){ 'a' + 'b'; return 'body' }`)
  const jsfuckResult = runPass(jsfuck, jsfuckCase.ast)
  assert.equal(jsfuckResult.changed, false)
  assert.match(generate(jsfuckCase.ast).code, /'a' \+ 'b'/)
})

test('constant-fold refuses to fold inside a with scope', () => {
  const code = `var scope = { dynamic: 1 }; var out; with (scope) { out = 1 + 2 } captured = out;`
  const { ast } = parse(code)
  const result = runPass(constantFold, ast)
  assert.equal(result.error, undefined)
  assert.ok(
    result.notes.some((note) => /with statement/i.test(note)),
    JSON.stringify(result.notes),
  )
  assert.equal(result.changed, false, generate(ast).code)
})

/** Run the `strings` pass on one expression and return the folded source. */
function decodeExpression(expression) {
  const { folded, result } = fold(strings, expression)
  return { folded, result }
}

test('strings: decodes every literal-built decoder idiom', () => {
  const decodable = [
    ['String.fromCharCode(104, 105)', "'hi'"],
    ["String['fromCharCode'](104, 105)", "'hi'"],
    ['String.fromCharCode.apply(null, [104, 105])', "'hi'"],
    ['String.fromCharCode.apply(undefined, [104, 105])', "'hi'"],
    ["[104, 105].map(function (c) { return String.fromCharCode(c) }).join('')", "'hi'"],
    ["[104, 105].map((c) => String.fromCharCode(c)).join('')", "'hi'"],
    ["atob('aGk=')", "'hi'"],
    ["window.atob('aGk=')", "'hi'"],
    ["self.atob('aGk=')", "'hi'"],
    ["globalThis.atob('aGk=')", "'hi'"],
    ["decodeURIComponent('%41%42')", "'AB'"],
    ["unescape('%41%42')", "'AB'"],
    ["window.decodeURIComponent('%41')", "'A'"],
  ]
  for (const [expression, expected] of decodable) {
    const { folded, result } = decodeExpression(expression)
    assert.equal(result.changed, true, `expected a decode for ${expression}`)
    assert.equal(folded, expected, `unexpected decode for ${expression}`)
  }

  // Refusals: a decoder the pass cannot prove is the built-in is left alone.
  const refusals = [
    'String.fromCharCode(dynamic)',
    "String.fromCharCode.apply(null, dynamic)",
    "String.fromCharCode.apply('not-null', [104])",
    "String.fromCharCode.apply(null, 'not an array')",
    "[104].map((a, b) => String.fromCharCode(a)).join('')",
    "[104].map((c) => String.fromCharCode(c)).join('x')",
    "[104].map((c) => String.fromCharCode(c)).join('', 1)",
    // `join()` defaults to ',' and `join(',')` keeps that separator, so
    // neither may be folded to the empty-separator result.
    '[104, 105].map((c) => String.fromCharCode(c)).join()',
    "[104, 105].map((c) => String.fromCharCode(c)).join(',')",
    '[dynamic].map((c) => String.fromCharCode(c)).join()',
    "atob('aGk=', 'extra')",
    'atob(dynamicBase64)',
    "other.atob('aGk=')",
    'member.fromCharCode(104)',
  ]
  for (const expression of refusals) {
    const { result } = decodeExpression(expression)
    assert.equal(result.changed, false, `unexpected decode for ${expression}: ${JSON.stringify(result.changes)}`)
  }

  // A shadowed decoder name is never decoded either.
  const shadowSources = [
    "function f(atob) { return atob('aGk=') }",
    "function f(String) { return String.fromCharCode(104) }",
    "function f(window) { return window.atob('aGk=') }",
  ]
  for (const source of shadowSources) {
    const { ast } = parse(source)
    const result = runPass(strings, ast)
    assert.equal(result.changed, false, source)
  }
})

test('strings: reports oversized literals and lone surrogates instead of rewriting them', () => {
  const oversized = `captured = '\\\\x41${'a'.repeat(100_000)}';`
  const { ast } = parse(oversized)
  const result = runPass(strings, ast)
  assert.equal(result.changed, false)
  assert.ok(
    result.notes.some((note) => /too large/.test(note)),
    JSON.stringify(result.notes),
  )

  const surrogate = parse("captured = '\\uD800';")
  const surrogateResult = runPass(strings, surrogate.ast)
  assert.equal(surrogateResult.changed, false)
  assert.ok(
    surrogateResult.notes.some((note) => /lone surrogate/.test(note)),
    JSON.stringify(surrogateResult.notes),
  )
})
