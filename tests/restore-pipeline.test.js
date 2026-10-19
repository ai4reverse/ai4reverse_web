import test from 'node:test'
import assert from 'node:assert/strict'
import { restore, restoreWithPass, listPasses, PASSES } from '../tools/restore/index.js'
import { parse } from '../tools/restore/parse.js'
import { generate } from '../tools/restore/generate.js'

/** Execute a snippet in plain Node with a captured console and return output. */
function execute(code) {
  const lines = []
  const sandboxConsole = {
    log: (...args) => lines.push(args.map(String).join(' ')),
    warn: (...args) => lines.push(args.map(String).join(' ')),
    error: (...args) => lines.push(args.map(String).join(' ')),
  }
  // eslint-disable-next-line no-new-func
  new Function('console', 'atob', 'btoa', 'setTimeout', code)(sandboxConsole, atob, btoa, setTimeout)
  return lines
}

test('pipeline lists passes in deterministic order', () => {
  const passes = listPasses()
  assert.ok(passes.length >= 10)
  const orders = passes.map((pass) => pass.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
  assert.ok(passes.some((pass) => pass.id === 'strings'))
  assert.ok(passes.some((pass) => pass.id === 'control-flow'))
  assert.ok(passes.some((pass) => pass.id === 'eval-unwrap'))
})

test('restoration decodes strings, string arrays, dead code and eval literals', () => {
  const source = `
    var table = ['\\x68\\x69', '\\x21', '\\x3f', '\\x2e'];
    var message = table[0] + table[1];
    if (false) { console.log('dead'); }
    eval('console.log("literal-eval")');
    console.log(message);
  `
  const before = execute(source)
  const result = restore(source, { filename: 'sample.js' })
  assert.equal(result.changed, true)
  assert.ok(result.passes.some((pass) => pass.id === 'strings' && pass.changed))
  assert.ok(result.passes.some((pass) => pass.id === 'string-array' && pass.changed))
  assert.ok(result.passes.some((pass) => pass.id === 'dead-code' && pass.changed))
  assert.ok(result.passes.some((pass) => pass.id === 'eval-unwrap' && pass.changed), JSON.stringify(result.passes.map((p) => p.id)))
  assert.doesNotMatch(result.code, /if \(false\)/)
  const after = execute(result.code)
  assert.deepEqual(after, before)
})

test('control-flow flattening is removed', () => {
  const source = `
    var order = '2|0|1'.split('|'), idx = 0;
    var log = [];
    while (true) {
      switch (order[idx++]) {
        case '0': log.push('b'); continue;
        case '1': log.push('c'); continue;
        case '2': log.push('a'); continue;
      }
      break;
    }
    console.log(log.join(''));
  `
  const before = execute(source)
  const result = restore(source)
  assert.equal(before.join(''), 'abc')
  assert.ok(result.passes.some((pass) => pass.id === 'control-flow' && pass.changed))
  assert.equal(execute(result.code).join(''), 'abc')
  assert.doesNotMatch(result.code, /switch \(order\[idx\+\+\]\)/)
})

test('renaming is cosmetic and preserves binding identity', () => {
  const source = `
    var _0xabc = { value: 7 };
    function _0xdef(_0x1) { return _0x1 + _0xabc.value }
    console.log(_0xdef(35));
  `
  const result = restore(source, { only: ['rename'] })
  assert.equal(execute(result.code).join(''), '42')
})

test('pass selection only/exclude is honoured', () => {
  const source = "var a = '\\x41'; console.log(a)"
  const only = restore(source, { only: ['strings'], maxRounds: 1 })
  assert.deepEqual(only.passes.map((pass) => pass.id), ['strings'])
  const excluded = restore(source, { exclude: ['strings'] })
  assert.ok(!excluded.passes.some((pass) => pass.id === 'strings'))
})

test('restoration is idempotent on an already-restored sample', () => {
  const source = "var table = ['\\x61','\\x62']; console.log(table[0] + table[1]);"
  const first = restore(source)
  const second = restore(first.code, { exclude: ['rename'] })
  assert.equal(second.code, first.code)
})

test('parse and generate round-trip preserves semantics', () => {
  const code = 'const f = (a, b) => a ** b; console.log(f(2, 10));'
  const { ast } = parse(code, { sourceType: 'script' })
  const regenerated = generate(ast, code).code
  assert.equal(execute(regenerated).join(''), '1024')
})

test('malformed source fails with a ParseError instead of crashing', () => {
  assert.throws(() => restore('function {{{'), /unable to parse|ParseError/)
})

test('single-pass helper runs exactly one pass', () => {
  const result = restoreWithPass('member-fold', "console.log('abc'['length'])")
  assert.equal(result.passes.length, 1)
  assert.equal(result.passes[0].id, 'member-fold')
  assert.equal(result.passes[0].changed, true)
})

test('registry entries expose the documented contract', () => {
  for (const pass of PASSES) {
    assert.equal(typeof pass.run, 'function')
    assert.equal(typeof pass.meta.id, 'string')
    assert.equal(typeof pass.meta.order, 'number')
    assert.equal(pass.meta.idempotent, true)
  }
})

test('ast:transform hooks can rewrite the tree before passes run', async () => {
  const { createHookBus } = await import('../tools/hook/hookbus.js')
  const { traverse } = await import('../tools/restore/pass-context.js')
  const bus = createHookBus()
  bus.on(
    'ast:transform',
    (ast) => {
      traverse(ast, {
        Identifier(path) {
          if (path.node.name === 'oldName' && path.isReferencedIdentifier()) path.node.name = 'newName'
        },
        VariableDeclarator(path) {
          if (path.node.id.type === 'Identifier' && path.node.id.name === 'oldName') path.node.id.name = 'newName'
        },
      })
      return ast
    },
    { priority: 10, id: 'rename-hook' },
  )
  const result = restore('var oldName = 41; console.log(oldName + 1)', { hooks: bus, only: ['dead-code'] })
  assert.match(result.code, /newName/)
  assert.equal(execute(result.code).join(''), '42')
})

test('eval bodies with illegal return/await/super are never spliced', () => {
  const source = "function f(){ try { eval('return 1'); } catch (e) { return 'threw' } return 'fell' }"
  const original = execute(`${source}; console.log(f())`)
  const restored = restore(source)
  assert.doesNotThrow(() => parse(restored.code))
  assert.deepEqual(execute(`${restored.code}; console.log(f())`), original)
})

test('passes never materialise a directive prologue', async () => {
  const { createHookBus } = await import('../tools/hook/hookbus.js')
  void createHookBus
  const sources = [
    "function f(){ (0, 'use strict'); undeclaredDirective = 1; return typeof this }",
    "function f(){ ('use strict' + ''); undeclaredDirective = 1; return typeof this }",
    "function f(){ String.fromCharCode(117,115,101,32,115,116,114,105,99,116); undeclaredDirective = 1; return typeof this }",
    "function f(){ if (1) 'use strict'; undeclaredDirective = 1; return typeof this }",
  ]
  for (const source of sources) {
    const result = restore(source)
    // The transformed code must still be sloppy: `this` is the global object.
    const evaluated = new Function(`${result.code}; return f()`)()
    assert.equal(evaluated, 'object', `strictness changed for: ${source}\n${result.code}`)
    delete globalThis.undeclaredDirective
  }
})

test('rename runs even when it is the only selected pass', () => {
  const result = restore("function f(){ var _0xabc = 'el'; return _0xabc }", { only: ['rename'] })
  assert.equal(result.passes.length, 1)
  assert.equal(result.passes[0].id, 'rename')
  assert.equal(execute(`${result.code}; console.log(f())`).join(''), 'el')
})

test('with-scope folds are refused', () => {
  const source = "var scope = { atob: function () { return 'fake' } }; var out; with (scope) { out = atob('YQ==') } console.log(out)"
  const result = restore(source)
  assert.equal(execute(result.code).join(''), 'fake')
})

test('jsfuck leaves assignment targets alone and still folds siblings', () => {
  const result = restoreWithPass('jsfuck', "[1,2,3][0] = 9; console.log(![] + [])")
  assert.equal(result.passes[0].error ?? null, null)
  assert.equal(execute(result.code).join(''), 'false')
})

test('string-array does not inline reads before the declaration', () => {
  const source = "try { console.log(a[0]) } catch (e) { console.log('threw') } var a = ['x','y','z','w']"
  const result = restoreWithPass('string-array', source)
  assert.equal(execute(result.code).join(''), 'threw')
})
