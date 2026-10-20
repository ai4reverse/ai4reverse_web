import test from 'node:test'
import assert from 'node:assert/strict'

import { parse } from '../tools/restore/parse.js'
import { generateExpression, expressionGeneratorCallCount } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as constantFoldPass from '../tools/restore/passes/constant-fold.js'

const constantFold = { ...constantFoldPass.meta, run: constantFoldPass.run }

test('generateExpression memoizes per node and regenerates after an extra swap', () => {
  const { ast } = parse("captured = '\\x41';")
  const literal = ast.program.body[0].expression.right

  const baseline = expressionGeneratorCallCount()
  const escaped = generateExpression(literal)
  assert.equal(escaped, "'\\x41'")
  assert.equal(expressionGeneratorCallCount() - baseline, 1)

  // Second ask for the same node is a memo hit: no generator call, same text.
  assert.equal(generateExpression(literal), "'\\x41'")
  assert.equal(expressionGeneratorCallCount() - baseline, 1)

  // strings.js rewrites `node.extra` in place to drop the raw escape text; the
  // memo must notice and regenerate instead of serving the stale pre-rewrite
  // text.
  literal.extra = { rawValue: literal.value }
  assert.equal(generateExpression(literal), "'A'")
  assert.equal(expressionGeneratorCallCount() - baseline, 2)
})

test('generateExpression notices when a pass replaces a descendant of a cached node', () => {
  const { ast } = parse("captured = 'a' + 'b' + x;")
  const root = ast.program.body[0].expression.right
  const inner = root.left

  const baseline = expressionGeneratorCallCount()
  assert.equal(generateExpression(root), "'a' + 'b' + x")
  assert.equal(expressionGeneratorCallCount() - baseline, 1)

  // The strings pass replaces the inner concatenation with a single literal
  // while the root object stays in the tree; the root's memo entry must go
  // stale instead of serving the old text.
  inner.hoisted = true
  root.left = { type: 'StringLiteral', value: 'ab', extra: { rawValue: 'ab' } }
  assert.equal(generateExpression(root), "'ab' + x")
  assert.equal(expressionGeneratorCallCount() - baseline, 2)
})

test('constant-fold generates text only for candidates it actually folds', () => {
  const statements = []
  // 200 candidates that can never fold, so the pre-lazy behaviour (one
  // generated text per candidate per round) would dominate the call count.
  for (let index = 0; index < 200; index += 1) statements.push(`v${index} = x${index} + 1;`)
  // 5 candidates that fold: each costs exactly `from` + `to` generations.
  for (let index = 0; index < 5; index += 1) statements.push(`w${index} = ${index} + ${index};`)
  const { ast } = parse(statements.join('\n'))

  const baseline = expressionGeneratorCallCount()
  const result = runPass(constantFold, ast)
  const delta = expressionGeneratorCallCount() - baseline

  assert.equal(result.changed, true)
  assert.equal(result.changes.length, 5)
  // 5 folds x 2 generations, plus slack; laziness keeps rejects at zero.
  assert.ok(delta <= 12, `expected lazy generation, saw ${delta} generator calls`)
})
