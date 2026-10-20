import assert from 'node:assert/strict'
import { compile, createVM, protect, toJSON, fromJSON, CompileError } from './src/index.js'

let passed = 0
let total = 0
function check(name, fn) {
  total += 1
  try { fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

check('precedence and arithmetic', () => {
  assert.equal(protect('1 + 2 * 3').run(), 7)
  assert.equal(protect('(1 + 2) * 3').run(), 9)
  assert.equal(protect('10 / 4').run(), 2.5)
  assert.equal(protect('10 % 3').run(), 1)
})

check('variables from environment', () => {
  assert.equal(protect('(a + b) * 2').run({ a: 3, b: 4 }), 14)
  assert.throws(() => protect('missing + 1').run({}), (error) => error instanceof CompileError)
})

check('string concatenation and literals', () => {
  assert.equal(protect('"hello" + " " + name').run({ name: 'world' }), 'hello world')
})

check('unary operators', () => {
  assert.equal(protect('-value + 2').run({ value: 5 }), -3)
  assert.equal(protect('!flag').run({ flag: true }), false)
})

check('bytecode is obfuscated, semantics are not', () => {
  const program = compile('1 + 2 * 3')
  assert.ok(program.bytecode.every((instruction) => instruction.op !== 0x21 || program.key === 0x21))
  assert.equal(createVM(program).run(), 7)
  assert.equal(createVM(program).run(), protect('1 + 2 * 3').run())
})

check('programs serialize and restore', () => {
  const restored = fromJSON(toJSON(compile('x * (y + 1)')))
  assert.equal(createVM(restored).run({ x: 3, y: 4 }), 15)
})

check('invalid syntax is rejected', () => {
  assert.throws(() => compile('1 +'), (error) => error instanceof CompileError)
  assert.throws(() => compile('a b'), (error) => error instanceof CompileError)
  assert.throws(() => compile('('), (error) => error instanceof CompileError)
})

console.log(`checks: ${passed}/${total}`)
