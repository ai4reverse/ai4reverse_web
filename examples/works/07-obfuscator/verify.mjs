import assert from 'node:assert/strict'
import { obfuscate, deobfuscate } from './src/index.js'

let passed = 0
let total = 0
function check(name, fn) {
  total += 1
  try { fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

function run(code) {
  const lines = []
  new Function('console', code)({ log: (...args) => lines.push(args.map(String).join(' ')) })
  return lines
}

const samples = [
  'var greeting = "hello world"; console.log(greeting);',
  'function add(a, b) { return a + b } console.log(add(2, 3));',
  'var items = ["alpha", "beta", "gamma"]; items.forEach(function (item) { console.log(item.toUpperCase()) });',
  'if (true) { console.log("kept branch") } else { console.log("dead branch") }',
]

for (const [index, source] of samples.entries()) {
  check(`semantics preserved #${index + 1}`, () => {
    const original = run(source)
    const result = obfuscate(source, { seed: 100 + index })
    const transformed = run(result.code)
    assert.deepEqual(transformed, original)
  })
}

check('strings are encoded and identifiers renamed', () => {
  const result = obfuscate(samples[0], { seed: 7 })
  assert.match(result.code, /String\.fromCharCode/)
  assert.match(result.code, /_0x[0-9a-f]{8}/)
  assert.match(result.code, /if \(false\)/)
  assert.ok(result.stats.strings >= 1)
  assert.ok(result.stats.identifiers >= 1)
})

check('output is deterministic per seed and differs across seeds', () => {
  const first = obfuscate(samples[1], { seed: 1 })
  const second = obfuscate(samples[1], { seed: 1 })
  const other = obfuscate(samples[1], { seed: 2 })
  assert.equal(first.code, second.code)
  assert.notEqual(first.code, other.code)
})

check('deobfuscation recovers strings and dead code', () => {
  const result = obfuscate(samples[0], { seed: 3 })
  const restored = deobfuscate(result.code)
  assert.ok(restored.stats.strings >= 1)
  assert.ok(restored.stats.deadCode >= 1)
  assert.match(restored.code, /hello world/)
  assert.deepEqual(run(restored.code), run(samples[0]))
})

check('shadowed String is never rewritten', () => {
  const source = 'var String = { fromCharCode: function () { return "shadow" } }; console.log("hello".toUpperCase());'
  const result = obfuscate(source, { encodeStrings: true, renameLocals: false, deadCode: false })
  assert.doesNotMatch(result.code, /String\.fromCharCode\("hello"\)/)
  assert.deepEqual(run(result.code), run(source))
})

console.log(`checks: ${passed}/${total}`)
