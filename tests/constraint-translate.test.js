import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeConstraints,
  collectPathConditions,
  solveConstraints,
  provePredicate,
  proveEquivalent,
  simplifyExpression,
  parseExpression,
  expressionText,
  constantInt,
  createTranslator,
  translateExpression,
  createZ3Context,
  normalizeConstraintLimits,
  ConstraintError,
  ConstraintSyntaxError,
} from '../tools/constraint/index.js'
import { CONSTRAINT_LIMITS } from '../tools/constraint/limits.js'

test('literal arithmetic, remainder sign and comparisons are decided', async () => {
  for (const source of ['2 + 3 === 5', '7 % 3 === 1', '-7 % 3 === -1', '2 ** 5 === 32']) {
    const proof = await provePredicate(source)
    assert.equal(proof.status, 'always-true', `${source}: ${JSON.stringify(proof)}`)
    assert.equal(proof.exact, true, source)
  }
})

test('fractional arithmetic is not claimed just because JS computes it', async () => {
  const proof = await provePredicate('1 / 2 === 0.5')
  assert.equal(proof.proved, false)
  assert.notEqual(proof.status, 'always-true')
})

test('32-bit shifts mask the count exactly like ToUint32(count) & 31', async () => {
  const shifted = await provePredicate('(x << 32) === x', { assumeInt32: true })
  assert.equal(shifted.status, 'always-true', JSON.stringify(shifted))
  assert.equal(shifted.proved, true)

  const unsigned = await provePredicate('(x >>> 1) >= 0')
  assert.equal(unsigned.status, 'always-true')
})

test('bitwise identities and constants use the exact fragment', async () => {
  for (const source of [
    '(x & 0) === 0',
    '(x | 0) <= 2147483647',
    'Math.imul(x, 1) === (x | 0)',
    'Math.imul(x, y) === Math.imul(y, x)',
  ]) {
    const proof = await provePredicate(source)
    assert.equal(proof.status, 'always-true', `${source}: ${JSON.stringify(proof)}`)
    assert.equal(proof.exact, true, source)
  }
})

test('boolean structure is short-circuit-correct and does not execute the sample', async () => {
  assert.equal((await provePredicate('true || f()')).status, 'always-true')
  assert.equal((await provePredicate('false && f()')).status, 'always-false')
  assert.equal((await provePredicate('(true ? 1 : 2) === 1')).status, 'always-true')
  assert.equal((await provePredicate('x === x || x !== x')).status, 'always-true')
  assert.equal((await provePredicate('x !== x')).proved, false)
})

test('strings, typeof tags and Math helpers are translated', async () => {
  for (const source of [
    "'a' + 'b' === 'ab'",
    "'a' < 'b'",
    "typeof x === 'number' && typeof x === 'string'",
    'Math.abs(-5) === 5',
    'Math.min(2, 3) === 2',
    'Math.max(2, 3) === 3',
    'Math.floor(2) === 2',
    'Math.ceil(2) === 2',
    'Math.trunc(-2) === -2',
    'Math.round(2) === 2',
    'Math.sign(-2) === -1',
  ]) {
    const expected = source.includes("typeof x === 'number' && typeof x === 'string'") ? 'always-false' : 'always-true'
    const proof = await provePredicate(source)
    assert.equal(proof.status, expected, `${source}: ${JSON.stringify(proof)}`)
  }
})

test('astral string ordering is not claimed from code-point semantics', async () => {
  const ascii = await provePredicate("'a' < 'b'")
  assert.equal(ascii.status, 'always-true')
  const astral = await provePredicate(String.raw`'\u{1F600}' < '\uFFFF'`)
  assert.equal(astral.proved, false, 'JS compares UTF-16 code units, z3 compares code points')
  assert.notEqual(astral.status, 'always-true')
})

test('unsupported constructs become uninterpreted leaves, not thrown errors', async () => {
  const { api, context } = await createZ3Context('translate-test')
  for (const source of [
    'foo(x)',
    'obj.value',
    'new Thing()',
    '[1, 2, 3]',
    '({ a: 1 })',
    '`template ${x}`',
    '/re/g',
    '1n',
  ]) {
    const node = parseExpression(source)
    const translated = translateExpression(api, context, node)
    assert.equal(translated.supported, true, source)
    assert.equal(translated.exact, false, `${source} must not claim exactness`)
    assert.ok(translated.uninterpreted >= 1, source)
  }
})

test('translator budgets fail closed instead of overflowing the host stack', async () => {
  const { api, context } = await createZ3Context('budget-test')
  const node = parseExpression('((1 + 2) * 3) + 4')
  const translated = translateExpression(api, context, node, { maxDepth: 1 })
  assert.equal(translated.supported, false)
  assert.match(translated.reason, /nesting exceeds/)
})

test('translator exposes condition coercion and the symbol table', async () => {
  const { api, context } = await createZ3Context('translator-test')
  const translator = createTranslator(api, context)
  const node = parseExpression('x + 1')
  const value = translator.translateSafe(node)
  assert.equal(value.supported, true)
  assert.equal(value.sort, 'int')
  assert.deepEqual(value.variables, ['x'])
  const condition = translator.translateConditionSafe(parseExpression('x'))
  assert.equal(condition.sort, 'bool')
  const asInt = translator.asIntValue(translator.translateCondition(parseExpression('true')))
  assert.equal(asInt.sort, 'int')
  const asBool = translator.asBoolValue(translator.translateSafe(parseExpression('x + 1')))
  assert.equal(asBool.sort, 'bool')
  assert.ok(translator.symbols.size >= 1)
})

test('expression helpers are deterministic and bounded', () => {
  assert.equal(constantInt(parseExpression('2 + 3 * 4')), 14)
  assert.equal(constantInt(parseExpression('x + 1')), null)
  assert.equal(expressionText(parseExpression('x + 1')), 'x + 1')
  assert.ok(expressionText(parseExpression('x + 1'), 2).endsWith('…'))
})

test('solveConstraints validates its input and reports parse failures', async () => {
  await assert.rejects(() => solveConstraints([]), ConstraintError)
  await assert.rejects(() => solveConstraints([42]), ConstraintError)
  await assert.rejects(
    () => solveConstraints(Array.from({ length: 257 }, () => 'x === 0')),
    ConstraintError,
  )

  const parseFailure = await solveConstraints(['x +'])
  assert.equal(parseFailure.ok, false)
  assert.equal(parseFailure.status, 'error')
  assert.equal(parseFailure.error.code, 'CONSTRAINT_SYNTAX')

  const node = parseExpression('x * 3 === 9')
  const solvedNode = await solveConstraints([{ node }])
  assert.equal(solvedNode.status, 'sat')
  assert.equal(solvedNode.model.x, 3)
})

test('provePredicate and proveEquivalent surface parse/sort failures', async () => {
  const parseFailure = await provePredicate('x +')
  assert.equal(parseFailure.ok, false)
  assert.equal(parseFailure.status, 'error')

  const mismatch = await proveEquivalent('true', '1')
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.status, 'unsupported')
  assert.match(mismatch.reason, /cannot compare bool with int/)
})

test('models are withheld when the translation abstracts the values away', async () => {
  const abstract = await provePredicate('x * y === 12')
  assert.equal(abstract.status, 'contingent')
  assert.equal(abstract.modelSafe, false)
  assert.equal(abstract.model, null)
  assert.equal(abstract.counterexample, null)

  const integer = await provePredicate('x * y === 12', { assumeIntegers: true })
  assert.equal(integer.modelSafe, true)
  assert.equal(integer.model.x * integer.model.y, 12)
  assert.notEqual(integer.counterexample.x * integer.counterexample.y, 12)

  const bitwise = await provePredicate('(x & 1) === 0')
  assert.equal(bitwise.modelSafe, false)
  const bitwiseInt32 = await provePredicate('(x & 1) === 0', { assumeInt32: true })
  assert.equal(bitwiseInt32.modelSafe, true)
  assert.equal(Number(bitwiseInt32.model.x) & 1, 0)
})

test('equivalence separates model equivalence from a JS proof', async () => {
  const modelOnly = await proveEquivalent('x + y', 'y + x')
  assert.equal(modelOnly.equivalent, true)
  assert.equal(modelOnly.exact, false)
  assert.equal(modelOnly.proved, false)

  const exact = await proveEquivalent('x + y', 'y + x', { assumeIntegers: true })
  assert.equal(exact.equivalent, true)
  assert.equal(exact.proved, true)
})

test('simplification reports unchanged constants and exactness', async () => {
  const unchanged = await simplifyExpression('1 + 2')
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.equivalent, true)
  assert.equal(unchanged.exact, true)

  const inexact = await simplifyExpression('x + y', { assumeIntegers: false })
  assert.equal(inexact.exact, false)
  assert.equal(inexact.proved, false)
})

test('empty source and candidate limits produce a stable, bounded report', async () => {
  const empty = await analyzeConstraints('   ')
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.notes, ['empty source'])

  const bounded = await analyzeConstraints('if (a) { b() } if (c) { d() } if (e) { f() }', {
    maxPredicates: 1,
  })
  assert.equal(bounded.ok, true)
  assert.equal(bounded.stats.candidates, 1)
  assert.equal(bounded.truncated, true)
})

test('path extraction lists enclosing facts and both arm polarities', () => {
  const result = collectPathConditions('if (a) { if (b) { run() } else { stop() } } else { done() }')
  assert.equal(result.ok, true)
  assert.equal(result.branches.length, 2)
  assert.deepEqual(
    result.branches[1].consequent.map((condition) => [condition.text, condition.truth]),
    [['a', true], ['b', true]],
  )
  assert.deepEqual(
    result.branches[1].alternate.map((condition) => [condition.text, condition.truth]),
    [['a', true], ['b', false]],
  )
  assert.equal(result.branches[0].hasAlternate, true)
})

test('loop and ternary conditions are candidates with their own roles', async () => {
  const report = await analyzeConstraints(`
    while (false) { body() }
    for (; false; ) { body() }
    do { body() } while (false)
    const value = false ? 1 : 2
  `)
  const roles = new Set(report.opaquePredicates.map((finding) => finding.role))
  assert.ok(roles.has('while-test'), JSON.stringify(report.opaquePredicates))
  assert.ok(roles.has('for-test'), JSON.stringify(report.opaquePredicates))
  assert.ok(roles.has('do-while-test'), JSON.stringify(report.opaquePredicates))
  assert.ok(roles.has('conditional-test'), JSON.stringify(report.opaquePredicates))
})

test('invalid limits are ignored instead of disabling a bound', () => {
  const limits = normalizeConstraintLimits({ timeoutMs: 0, budgetMs: -1, maxPredicates: 5, maxDepth: 1.9 })
  assert.equal(limits.timeoutMs, CONSTRAINT_LIMITS.timeoutMs)
  assert.equal(limits.budgetMs, CONSTRAINT_LIMITS.budgetMs)
  assert.equal(limits.maxPredicates, 5)
  assert.equal(limits.maxDepth, 1)
})

test('an invalid expression is a typed syntax error, not a generic failure', () => {
  assert.throws(() => parseExpression('x +'), ConstraintSyntaxError)
})
