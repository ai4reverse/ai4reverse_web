import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyzeConstraints,
  solveConstraints,
  solvePredicate,
  provePredicate,
  proveEquivalent,
  simplifyExpression,
  parseExpression,
  renderConstraintReport,
  CONSTRAINT_LIMITS,
  ConstraintError,
  ConstraintSyntaxError,
} from '../tools/constraint/index.js'
import { analyzeSample } from '../tools/analysis/orchestrator.js'
import { buildReport } from '../tools/analysis/report.js'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'tools', 'cli.js')

const OPAQUE_SOURCE = `var stager = function () {
  if ((x & 1) === 0 || (x & 1) === 1) { console.log('always'); }
  else { console.log('never'); }
};
if (false) { stager(); }
if (x > 10 && x < 5) { console.log('impossible'); }
`

test('bitwise opaque predicates are proven without assuming integer arithmetic', async () => {
  const proof = await provePredicate('(x & 1) === 0 || (x & 1) === 1')
  assert.equal(proof.status, 'always-true')
  assert.equal(proof.proved, true)
  assert.equal(proof.exact, true)
  assert.deepEqual(proof.assumptions, [])
  assert.deepEqual(proof.variables, ['x'])
})

test('reflexivity is not claimed for a possibly-NaN number', async () => {
  const proof = await provePredicate('x !== x')
  assert.equal(proof.proved, false)
  assert.equal(proof.status, 'contingent', JSON.stringify(proof))
})

test('integer-only arithmetic requires an explicit assumption', async () => {
  const sound = await provePredicate('x + 1 > x')
  assert.equal(sound.proved, false, 'a sound default must not assume integers')

  const assumed = await provePredicate('x + 1 > x', { assumeIntegers: true })
  assert.equal(assumed.status, 'always-true')
  assert.deepEqual(assumed.assumptions, ['integers'])

  const contradiction = await provePredicate('x > 10 && x < 5', { assumeIntegers: true })
  assert.equal(contradiction.status, 'always-false')
})

test('typeof is modelled as a deterministic tag, not a free boolean', async () => {
  const proof = await provePredicate("typeof value === 'number' || typeof value !== 'number'")
  assert.equal(proof.status, 'always-true')
  assert.equal(proof.exact, true)
})

test('solving returns a deterministic model for a unique integer solution', async () => {
  const result = await solveConstraints(['x * 2 === 42'])
  assert.equal(result.ok, true)
  assert.equal(result.status, 'sat')
  assert.equal(result.satisfiable, true)
  assert.equal(result.model.x, 21)
  assert.equal(result.modelSafe, true)
  // Arithmetic-only constraints use the unbounded Int model; no bitwise
  // interpretation is involved, so no int32 assumption is recorded.
  assert.deepEqual(result.assumptions, ['integers'])
  assert.equal(result.elapsedMs >= 0, true)
})

test('solving a bitwise condition reports the vector and integer interpretations', async () => {
  const result = await solveConstraints(['(x & 1) === 1'])
  assert.equal(result.status, 'sat')
  assert.equal(result.modelSafe, true)
  assert.deepEqual(result.assumptions, ['int32', 'integers'])
  const bits = Number(result.modelBitVec.x) & 1
  assert.equal(bits, 1, JSON.stringify(result.modelBitVec))
  assert.equal(Number(result.model.x) & 1, 1, JSON.stringify(result.model))
})

test('unsatisfiable constraints are reported without a model', async () => {
  const result = await solveConstraints(['x > 10', 'x < 5'], { assumeIntegers: true })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'unsat')
  assert.equal(result.satisfiable, false)
  assert.equal(result.model, null)
})

test('a model is only reported when the translation can support it', async () => {
  const arithmetic = await solveConstraints(['x * y === 12'])
  assert.equal(arithmetic.status, 'sat')
  assert.equal(arithmetic.modelSafe, true)
  assert.equal(arithmetic.model.x * arithmetic.model.y, 12)
  assert.equal(arithmetic.modelBitVec, null)

  const unsupported = await solveConstraints(['(x & 1) === 1'], { assumeInt32: false })
  assert.equal(unsupported.status, 'sat')
  assert.equal(unsupported.modelSafe, false)
  assert.equal(unsupported.model, null)
  assert.equal(Number(unsupported.modelBitVec.x) & 1, 1)
})

test('contingent conditions return both a model and a counterexample', async () => {
  const proof = await provePredicate('x > 5', { assumeIntegers: true })
  assert.equal(proof.status, 'contingent')
  assert.equal(proof.proved, false)
  assert.ok(proof.model && Number(proof.model.x) > 5, JSON.stringify(proof.model))
  assert.ok(proof.counterexample && Number(proof.counterexample.x) <= 5, JSON.stringify(proof.counterexample))
})

test('equivalence and simplification are verified, not asserted', async () => {
  const equivalent = await proveEquivalent('x + y', 'y + x', { assumeIntegers: true })
  assert.equal(equivalent.status, 'equivalent')
  assert.equal(equivalent.equivalent, true)

  const different = await proveEquivalent('x + y', 'x - y', { assumeIntegers: true })
  assert.equal(different.status, 'different')
  assert.equal(different.equivalent, false)
  assert.ok(different.counterexample)

  const simplified = await simplifyExpression('(x & 1) === 0 || (x & 1) === 1')
  assert.equal(simplified.ok, true)
  assert.equal(simplified.equivalent, true)
  assert.equal(simplified.verification, 'unsat-negation')
  assert.ok(simplified.simplified.length > 0)
})

test('expression parsing is strict and typed', () => {
  assert.equal(parseExpression('x + 1').type, 'BinaryExpression')
  assert.throws(() => parseExpression('x +'), ConstraintSyntaxError)
  assert.throws(() => parseExpression(''), ConstraintSyntaxError)
  assert.ok(new ConstraintError('x') instanceof Error)
})

test('the analyzer reports opaque predicates, dead branches and their locations', async () => {
  const report = await analyzeConstraints(OPAQUE_SOURCE)
  assert.equal(report.ok, true)
  assert.equal(report.engine, 'z3-solver')
  assert.match(report.engineVersion, /^\d+\.\d+/)
  assert.equal(report.parse.ok, true)
  assert.ok(report.stats.candidates >= 3)
  assert.ok(report.stats.opaque >= 2, JSON.stringify(report.stats))

  const kinds = new Map(report.opaquePredicates.map((finding) => [finding.text, finding]))
  const bitwise = [...kinds.values()].find((finding) => finding.text.includes('x & 1'))
  assert.ok(bitwise, JSON.stringify(report.opaquePredicates))
  assert.equal(bitwise.kind, 'always-true')
  assert.equal(bitwise.exact, true)
  assert.deepEqual(bitwise.assumptions, [])
  assert.equal(bitwise.line, 2)
  assert.equal(bitwise.column, 7)
  assert.deepEqual(bitwise.variables, ['x'])

  const dead = report.opaquePredicates.find((finding) => finding.text === 'false')
  assert.ok(dead, JSON.stringify(report.opaquePredicates))
  assert.equal(dead.kind, 'always-false')

  const unreachable = report.unreachableBranches.find((finding) => finding.kind === 'if-consequent' && finding.text === 'false')
  assert.ok(unreachable, JSON.stringify(report.unreachableBranches))
  assert.equal(unreachable.proof, 'unsat-path')
})

test('integer-model analysis labels every finding with its assumption', async () => {
  const report = await analyzeConstraints('if (x + 1 > x) { console.log(1) }', { assumeIntegers: true })
  const finding = report.opaquePredicates.find((entry) => entry.kind === 'always-true')
  assert.ok(finding, JSON.stringify(report))
  assert.deepEqual(finding.assumptions, ['integers'])
  assert.deepEqual(report.assumptions, ['integers'])
})

test('fresh solver atoms do not conflate unrelated path conditions', async () => {
  const report = await analyzeConstraints(`if (x === 5) {
    if (y !== 5) { console.log('reachable') }
  }`)
  assert.deepEqual(
    report.unreachableBranches,
    [],
    'an unrelated equality must not become a false unsat via a reused fresh name',
  )
})

test('typeof is always truthy, so the else arm is unreachable', async () => {
  const report = await analyzeConstraints('if (typeof x) { console.log(1) } else { console.log(2) }')
  assert.ok(report.opaquePredicates.some((finding) => finding.kind === 'always-true'))
  assert.ok(
    report.unreachableBranches.some((finding) => finding.kind === 'if-alternate'),
    JSON.stringify(report.unreachableBranches),
  )
})

test('a function boundary stops outer path conditions from leaking inward', async () => {
  const report = await analyzeConstraints(`if (flag) {
    function inner() { if (!flag) { console.log('reachable when called later') } }
  }`)
  assert.equal(
    report.unreachableBranches.some((finding) => finding.column > 1),
    false,
    JSON.stringify(report.unreachableBranches),
  )
})

test('path symbol sharing stops at mutation, loops and try boundaries', async () => {
  const pure = await analyzeConstraints(
    'if (x > 10) { if (x < 5) { console.log(1) } }',
    { assumeIntegers: true },
  )
  assert.equal(pure.unreachableBranches.length, 1, 'a mutation-free path can be proven unreachable')

  const mutated = await analyzeConstraints(
    'if (x > 10) { x = 0; if (x < 5) { console.log(1) } }',
    { assumeIntegers: true },
  )
  assert.equal(mutated.unreachableBranches.length, 0, 'the assignment invalidates outer x')

  const loop = await analyzeConstraints(
    'if (x === 0) { while (c) { if (x === 1) {} x = 1 } }',
    { assumeIntegers: true },
  )
  assert.equal(loop.unreachableBranches.length, 0, 'a later loop iteration can change x')

  const tryCatch = await analyzeConstraints(
    'if (x === 0) { try { x = 1; f() } catch (e) { if (x === 1) {} } }',
    { assumeIntegers: true },
  )
  assert.equal(tryCatch.unreachableBranches.length, 0, 'the try block runs before catch')

  const getter = await analyzeConstraints(
    'if (obj.x === 0) { if (obj.x === 1) {} }',
    { assumeIntegers: true },
  )
  assert.equal(getter.unreachableBranches.length, 0, 'a property read may run a getter')

  // Without a numeric assumption, ToInt32 may invoke valueOf on a non-number.
  // The same path is provable once int32 values are assumed.
  const bitwiseDefault = await analyzeConstraints('if ((x & 1) === 0) { if ((x & 1) === 1) {} }')
  assert.equal(bitwiseDefault.unreachableBranches.length, 0)
  const bitwiseInt32 = await analyzeConstraints(
    'if ((x & 1) === 0) { if ((x & 1) === 1) {} }',
    { assumeInt32: true },
  )
  assert.equal(bitwiseInt32.unreachableBranches.length, 1)
})

test('malformed source is reported, not thrown', async () => {
  const report = await analyzeConstraints('function (')
  assert.equal(typeof report.ok, 'boolean')
  assert.equal(report.enabled, true)
  assert.doesNotThrow(() => JSON.stringify(report))
})

test('analysis reports the constraint section as evidence', async () => {
  const result = await analyzeSample(OPAQUE_SOURCE, {
    name: 'opaque.js',
    logLevel: 'silent',
    dynamic: false,
    restore: false,
  })
  assert.ok(result.report.static.constraint.enabled)
  assert.ok(result.report.static.constraint.opaquePredicates.length >= 2)
  // Constraint findings are evidence in the report. They do not silently move
  // the weighted verdict: the example contracts pin their expected levels.
  assert.equal(result.report.verdict.reasons.some((reason) => reason.code === 'STATIC_OPAQUE_PREDICATE'), false)
  assert.match(result.markdown, /## Constraint solving/)
  assert.doesNotThrow(() => JSON.stringify(result.report))
  assert.deepEqual(result.report.static.constraint, JSON.parse(JSON.stringify(result.report.static.constraint)))
})

test('constraint analysis can be disabled and the report keeps a stable empty shape', async () => {
  const result = await analyzeSample('if (false) { console.log(1) }', {
    name: 'disabled.js',
    logLevel: 'silent',
    dynamic: false,
    restore: false,
    constraints: false,
  })
  const section = result.report.static.constraint
  assert.equal(section.enabled, false)
  assert.deepEqual(section.opaquePredicates, [])
  assert.deepEqual(section.unreachableBranches, [])
  assert.deepEqual(section.simplifications, [])
  assert.equal(result.constraint, null)

  const empty = buildReport({}).static.constraint
  assert.equal(empty.enabled, false)
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.stats.opaque, 0)
})

test('the analyzer is deterministic apart from elapsed time', async () => {
  const first = await analyzeConstraints(OPAQUE_SOURCE)
  const second = await analyzeConstraints(OPAQUE_SOURCE)
  const strip = (report) => ({ ...report, elapsedMs: 0 })
  assert.deepEqual(strip(second), strip(first))
})

test('the renderer is bounded and never emits object placeholders', async () => {
  const report = await analyzeConstraints(OPAQUE_SOURCE)
  const text = renderConstraintReport(report)
  assert.match(text, /# Constraint solving report/)
  assert.match(text, /Opaque predicates/)
  assert.doesNotMatch(text, /\[object Object\]/)
  assert.doesNotMatch(text, /: NaN/)
  assert.ok(text.length < 20_000)
})

test('published limits are bounded and positive', () => {
  for (const [key, value] of Object.entries(CONSTRAINT_LIMITS)) {
    assert.ok(Number.isFinite(value) && value > 0, `${key} must be a positive bound`)
  }
})

test('cli constraint --json emits the report and exits zero for parseable input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-constraint-'))
  const file = join(dir, 'opaque.js')
  await writeFile(file, OPAQUE_SOURCE, 'utf8')
  const { stdout, stderr } = await exec(process.execPath, [CLI, 'constraint', file, '--json'], {
    cwd: ROOT,
    timeout: 60_000,
  })
  const report = JSON.parse(stdout)
  assert.equal(report.enabled, true)
  assert.ok(report.opaquePredicates.length >= 2)
  assert.equal(stderr, '')
})

test('cli constraint prints a human summary with --assume-integers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-constraint-'))
  const file = join(dir, 'arithmetic.js')
  await writeFile(file, 'if (x + 1 > x) { console.log(1) }', 'utf8')
  const { stdout } = await exec(process.execPath, [CLI, 'constraint', file, '--assume-integers'], {
    cwd: ROOT,
    timeout: 60_000,
  })
  assert.match(stdout, /always-true/)
  assert.match(stdout, /Assumptions:\*\* integers/)
})

test('cli rejects assumption flags on other commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai4r-constraint-'))
  const file = join(dir, 'x.js')
  await writeFile(file, 'var a = 1', 'utf8')
  await assert.rejects(
    () => exec(process.execPath, [CLI, 'analyze', file, '--assume-integers'], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /only valid with the constraint command/)
      return true
    },
  )
})
