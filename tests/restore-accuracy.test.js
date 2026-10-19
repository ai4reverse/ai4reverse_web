import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { restore, restoreWithPass, listPasses, validateOutput, isDeferredPass } from '../tools/restore/index.js'

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples')

/** Every `examples/*.js` sample, sorted so failures are reproducible. */
const SAMPLES = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith('.js'))
  .sort()

/**
 * @param {string} name
 * @returns {string}
 */
function sample(name) {
  return readFileSync(join(EXAMPLES, name), 'utf8')
}

test('every pass declares idempotence and the claim is checked below', () => {
  const passes = listPasses()
  assert.ok(passes.length > 0)
  for (const pass of passes) {
    assert.equal(pass.idempotent, true, `${pass.id} must keep declaring idempotent: true`)
  }
})

test('a deferred pass is read from meta.deferred with the rename fallback', () => {
  // L5 adds `deferred: true` to rename's meta; until it does, the id is the
  // fallback, so the pipeline behaviour cannot depend on the flag landing.
  assert.equal(isDeferredPass({ meta: { id: 'rename' } }), true)
  assert.equal(isDeferredPass({ meta: { id: 'rename', deferred: true } }), true)
  assert.equal(isDeferredPass({ meta: { id: 'rename', deferred: false } }), false)
  assert.equal(isDeferredPass({ meta: { id: 'strings' } }), false)
  assert.equal(isDeferredPass({ meta: { id: 'strings', deferred: true } }), true)
  const listed = listPasses()
  assert.equal(listed.find((pass) => pass.id === 'rename').deferred, true)
  assert.equal(listed.find((pass) => pass.id === 'strings').deferred, false)
})

test('default pipeline reaches a fixed point for every example', () => {
  assert.ok(SAMPLES.length > 0, 'examples/*.js must exist for the fixed point check')
  for (const name of SAMPLES) {
    const first = restore(sample(name))
    assert.equal(first.outputValid, true, `${name}: generated output must parse`)
    const second = restore(first.code, { maxRounds: 1 })
    assert.equal(second.changed, false, `${name}: a second run must report no change`)
    assert.equal(second.code, first.code, `${name}: a second run must not move the source`)
    assert.equal(second.outputValid, true, `${name}: the fixed point must parse`)
    assert.deepEqual(
      second.passes.filter((pass) => pass.changed).map((pass) => pass.id),
      [],
      `${name}: no pass may claim a change at the fixed point`,
    )
  }
})

test('every pass separately reaches a fixed point for every example', () => {
  const ids = listPasses().map((pass) => pass.id)
  let checked = 0
  for (const name of SAMPLES) {
    const source = sample(name)
    for (const id of ids) {
      const first = restoreWithPass(id, source)
      const second = restoreWithPass(id, first.code)
      assert.equal(second.changed, false, `${name}/${id}: second application must report changed: false`)
      assert.equal(second.code, first.code, `${name}/${id}: second application must be text-identical`)
      assert.equal(second.outputValid, true, `${name}/${id}: output must parse`)
      checked += 1
    }
  }
  assert.equal(checked, SAMPLES.length * ids.length)
})

test('D5 reproducer: strings reports no change on already-restored code', () => {
  const source = sample('sample-loader.js')
  const first = restore(source, { only: ['strings'], maxRounds: 1 })
  // The sample really does contain escape-encoded literals: the first run is a
  // change, and `changed` must say so.
  assert.equal(first.passes[0].changed, true)
  const second = restore(first.code, { only: ['strings'], maxRounds: 1 })
  assert.equal(second.code, first.code, 're-applying strings must not move the source')
  assert.equal(second.passes[0].changed, false, 're-applying strings must report changed: false')
})

test('D5 reproducer: jsfuck reports no change on already-restored code', () => {
  const source = sample('anti-analysis.js')
  const first = restore(source, { only: ['jsfuck'], maxRounds: 1 })
  const second = restore(first.code, { only: ['jsfuck'], maxRounds: 1 })
  assert.equal(second.code, first.code, 're-applying jsfuck must not move the source')
  assert.equal(second.passes[0].changed, false, 're-applying jsfuck must report changed: false')
})

test('changed means a text change, not a rewrite', () => {
  // `'a\nb'` regenerates exactly as written: clearing the raw text is a no-op.
  const escapedNewline = restoreWithPass('strings', "var text = 'a\\nb';")
  assert.equal(escapedNewline.code, "var text = 'a\\nb';")
  assert.equal(escapedNewline.passes[0].changed, false)

  // `'-1'` folds to the same text, and jsfuck must not claim a change for it.
  const negative = restoreWithPass('jsfuck', 'var value = -1;')
  assert.equal(negative.code, 'var value = -1;')
  assert.equal(negative.passes[0].changed, false)

  // Real work still reports a change.
  const hexEscape = restoreWithPass('strings', "var text = '\\x41';")
  assert.equal(hexEscape.code, "var text = 'A';")
  assert.equal(hexEscape.passes[0].changed, true)

  const jsfuck = restoreWithPass('jsfuck', 'var text = ![] + [];')
  assert.equal(jsfuck.code, "var text = 'false';")
  assert.equal(jsfuck.passes[0].changed, true)
})

test('validateOutput accepts parsed code and rejects broken code', () => {
  assert.equal(validateOutput("var a = 'ok';"), true)
  assert.equal(validateOutput('function ('), false)
  assert.equal(validateOutput('var a = ;'), false)
  assert.equal(validateOutput('let x = `abc'), false)
  assert.equal(validateOutput('import x from "y"; export default x'), true)
})

test('restore falls back to the input when a pass would generate broken code', () => {
  const source = "var a = 'ok';\n"
  const result = restore(source, {
    // Simulate a pass that writes a literal whose raw text does not parse. The
    // AST hook is the only injection point a test has without editing a pass.
    hooks: {
      pipeline: (phase, ast) => {
        const literal = ast.program.body[0].declarations[0].init
        literal.value = "'broken"
        literal.extra = { raw: "'broken", rawValue: "'broken" }
        return { value: ast }
      },
    },
    // No pass may repair the injected node.
    exclude: listPasses().map((pass) => pass.id),
  })
  assert.equal(result.outputValid, false)
  assert.equal(result.code, source, 'the input source must be returned unchanged')
  assert.equal(result.changed, false)
  assert.ok(result.outputError?.message, 'the failure must carry a message')
  assert.match(result.outputError.message, /Unterminated|Unexpected|parse/i)
  assert.equal(result.notes.length, 1)
  assert.match(result.notes[0], /output validation failed/)
  assert.match(result.notes[0], /returned the input source/)
  assert.equal(result.stats.beforeHash, result.stats.afterHash)
})

test('restored output is always reported as valid', () => {
  const result = restore(sample('sample-loader.js'))
  assert.equal(result.outputValid, true)
  assert.equal(result.outputError, null)
  assert.deepEqual(result.notes, [])
})
