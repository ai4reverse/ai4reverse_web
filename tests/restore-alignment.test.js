import test from 'node:test'
import assert from 'node:assert/strict'

import { restore } from '../tools/restore/index.js'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

const CASES = [
  {
    id: 'H2', name: 'keeps the tail value after side effects',
    source: 'var n = 0; var value = (n++, 7);',
    result: 'JSON.stringify([n, value])', expected: '[1,7]',
  },
  {
    id: 'H2', name: 'keeps null, false, empty string and Unicode tails',
    source: 'var n = 0; var values = [(n++, null), (n++, false), (n++, ""), (n++, "雪")];',
    result: 'JSON.stringify([n, values])', expected: '[4,[null,false,"","雪"]]',
  },
  {
    id: 'H2', name: 'preserves order and exceptions before the tail',
    source: 'var seen = []; function fail() { seen.push("throw"); throw Error("bounded"); } try { (seen.push("first"), 0, fail(), 7); } catch (error) { seen.push(error.message); }',
    result: 'JSON.stringify(seen)', expected: '["first","throw","bounded"]',
  },
  {
    id: 'H3', name: 'keeps comma eval indirect',
    source: 'var value = "global"; function read() { var value = "local"; return (0, eval)("value"); }',
    result: 'read()', expected: 'global',
  },
  {
    id: 'H3', name: 'keeps identity proxy eval indirect',
    source: 'var value = "global"; function read() { var value = "local"; return ((item) => item)(eval)("value"); }',
    result: 'read()', expected: 'global',
  },
  {
    id: 'H3', name: 'keeps expression IIFE eval indirect',
    source: 'var value = "global"; function read() { var value = "local"; return (function () { return eval; })()("value"); }',
    result: 'read()', expected: 'global',
  },
  {
    id: 'H3', name: 'keeps member call receivers detached',
    source: 'var object = { read() { return this === object; } };',
    result: '(0, object.read)()', expected: false,
  },
  {
    id: 'H3', name: 'keeps tagged template receivers detached',
    source: 'var object = { tag() { return this === object; } };',
    result: '(0, object.tag)`text${object}`', expected: false,
  },
  {
    id: 'H3', name: 'keeps optional call receivers detached',
    source: 'var object = { read() { return this === object; } };',
    result: '(0, object.read)?.()', expected: false,
  },
  {
    id: 'H3', name: 'keeps with-scope identifier call receivers detached',
    source: 'var scope = { read() { return this === scope; } }; var outcome; with (scope) { outcome = (0, read)(); }',
    result: 'outcome', expected: false,
  },
  {
    id: 'H3', name: 'keeps with-scope identifier optional call receivers detached',
    source: 'var scope = { read() { return this === scope; } }; var outcome; with (scope) { outcome = (0, read)?.(); }',
    result: 'outcome', expected: false,
  },
  {
    id: 'H3', name: 'keeps with-scope identifier tag receivers detached',
    source: 'var scope = { read() { return this === scope; } }; var outcome; with (scope) { outcome = (0, read)`text`; }',
    result: 'outcome', expected: false,
  },
  {
    id: 'H3', name: 'does not turn a value into a delete reference',
    source: 'var object = { value: 1 }; var removed = delete (0, object.value);',
    result: 'JSON.stringify([removed, object.value])', expected: '[true,1]',
  },
  {
    id: 'H3', name: 'keeps getter evaluation when deleting a value',
    source: 'var reads = 0; var object = { get value() { reads++; return 1; } }; var removed = delete ((item) => item)(object.value);',
    result: 'JSON.stringify([removed, reads])', expected: '[true,1]',
  },
  {
    id: 'H3', name: 'keeps unresolved reads throwing inside typeof',
    source: 'var outcome; try { outcome = typeof (0, missingAlignmentValue); } catch (error) { outcome = error.name; }',
    result: 'outcome', expected: 'ReferenceError',
  },
  {
    id: 'M1', name: 'keeps the array receiver for identifier calls',
    source: 'function read() { return Array.isArray(this); }',
    result: '[read][0]()', expected: true,
  },
  {
    id: 'M1', name: 'keeps strict array receivers and evaluates arguments once',
    source: 'var count = 0; function read(value) { "use strict"; return [Array.isArray(this), this[0] === read, value, count]; }',
    result: 'JSON.stringify([read][0](++count))', expected: '[true,true,1,1]',
  },
  {
    id: 'M1', name: 'keeps array receivers for function expressions',
    source: '', result: '[function () { return Array.isArray(this); }][0]()', expected: true,
  },
  {
    id: 'H4', name: 'keeps strict function eval declarations local',
    source: 'function read() { "use strict"; 0; eval("var hidden = 1"); return typeof hidden; }',
    result: 'read()', expected: 'undefined', strictEval: true,
  },
  {
    id: 'H4', name: 'keeps inherited program strict eval declarations local',
    source: '"use strict"; function read() { 0; eval("var hidden = 1"); return typeof hidden; }',
    result: 'read()', expected: 'undefined', strictEval: true,
  },
  {
    id: 'H4', name: 'keeps class method eval declarations local',
    source: 'class Reader { read() { 0; eval("var hidden = 1"); return typeof hidden; } }',
    result: '(new Reader()).read()', expected: 'undefined', strictEval: true,
  },
  {
    id: 'H4', name: 'keeps class static block eval declarations local',
    source: 'var outcome; class Reader { static { 0; eval("var hidden = 1"); outcome = typeof hidden; } }',
    result: 'outcome', expected: 'undefined', strictEval: true,
  },
  {
    id: 'H4', name: 'keeps module eval declarations local',
    source: 'export {}; function read() { 0; eval("var hidden = 1"); return typeof hidden; }',
    result: 'read()', expected: 'undefined', strictEval: true, sourceType: 'module',
  },
  {
    id: 'H4', name: 'preserves strict eval syntax errors',
    source: 'function read() { "use strict"; var outcome = "not thrown"; try { eval("with ({}) {}"); } catch (error) { outcome = error.name; } return outcome; }',
    result: 'read()', expected: 'SyntaxError', strictEval: true,
  },
]

async function runInSandbox(sandbox, source, sourceType) {
  const result = await sandbox.run(source, { type: sourceType, entry: 'readAlignmentResult' })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.deepEqual(result.limitsHit, [])
  assert.equal(result.disposal.ok, true)
  return result.result.value
}

for (const selection of ['single pass', 'default pipeline']) {
  for (const fixture of CASES) {
    test(`${fixture.id}: ${fixture.name} (${selection})`, async () => {
      const pass = fixture.id === 'H4' ? 'eval-unwrap' : 'proxy-unwrap'
      const sourceType = fixture.sourceType ?? 'script'
      const source = `${fixture.source}\nglobalThis.readAlignmentResult = function () { return ${fixture.result}; };`
      const restored = restore(source, {
        sourceType,
        ...(selection === 'single pass' ? { only: [pass] } : {}),
      })
      const sandbox = await TracelessSandbox.create({
        logLevel: 'silent',
        instrumentation: { code: { level: 'off' }, api: false, ast: false, jsvmp: false },
      })
      try {
        const before = await runInSandbox(sandbox, source, sourceType)
        assert.equal(before, fixture.expected, 'baseline must demonstrate the intended behavior')
        assert.equal(restored.outputValid, true)
        assert.deepEqual(restored.parseErrors, [])
        assert.ok(restored.passes.every((entry) => !entry.error), JSON.stringify(restored.passes.filter((entry) => entry.error)))
        const after = await runInSandbox(sandbox, restored.code, sourceType)
        assert.equal(after, before, `restored behavior changed:\n${restored.code}`)
      } finally {
        sandbox.dispose()
      }
      if (fixture.strictEval) {
        assert.match(restored.code, /eval\(/)
        assert.ok(restored.passes.find((entry) => entry.id === pass).notes.some((note) => note.includes('strict')))
      }
    })
  }
}

test('jsfuck preserves tagged template quasis without pass errors', async () => {
  const source = 'function tag(parts) { return parts.raw[0]; } globalThis.readAlignmentResult = function () { return tag`雪`; };'
  const sandbox = await TracelessSandbox.create({
    logLevel: 'silent',
    instrumentation: { code: { level: 'off' }, api: false, ast: false, jsvmp: false },
  })
  try {
    assert.equal(await runInSandbox(sandbox, source, 'script'), '雪')
    for (const options of [{ only: ['jsfuck'] }, {}]) {
      const restored = restore(source, options)
      assert.equal(restored.outputValid, true)
      assert.ok(restored.passes.every((entry) => !entry.error), JSON.stringify(restored.passes))
      assert.match(restored.code, /tag`雪`/)
      assert.equal(await runInSandbox(sandbox, restored.code, 'script'), '雪')
    }
  } finally {
    sandbox.dispose()
  }
})

test('proxy-unwrap still removes safe literal heads and is idempotent', () => {
  const first = restore('var value = (0, 1, work(), 7);', { only: ['proxy-unwrap'] })
  const second = restore(first.code, { only: ['proxy-unwrap'] })
  assert.match(first.code, /\(work\(\), 7\)/)
  assert.equal(first.passes[0].changed, true)
  assert.equal(second.passes[0].changed, false)
  assert.equal(second.code, first.code)
})
