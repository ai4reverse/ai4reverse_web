import assert from 'node:assert/strict'
import { snapshot, diff, assertIntact, createGuard, TamperError } from './src/index.js'

let passed = 0
let total = 0
function check(name, fn) {
  total += 1
  try { fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

const subject = {
  greet(name) { return `hello ${name}` },
  version: '1.0.0',
  get computed() { return 42 },
}
const targets = { subject, math: Math, fnProto: Function.prototype, arrayProto: Array.prototype }

check('clean baseline has no drift', () => {
  const baseline = snapshot(targets)
  assert.deepEqual(diff(baseline, snapshot(targets)), [])
  assert.equal(assertIntact(baseline, snapshot(targets)), true)
})

check('method replacement is detected', () => {
  const baseline = snapshot(targets)
  const original = subject.greet
  subject.greet = function evil() { return 'owned' }
  const drift = diff(baseline, snapshot(targets))
  assert.ok(drift.some((entry) => entry.target === 'subject.greet' && entry.kind === 'descriptor-changed'), JSON.stringify(drift))
  subject.greet = original
})

check('descriptor flag change is detected', () => {
  const baseline = snapshot(targets)
  Object.defineProperty(subject, 'version', { value: '1.0.0', writable: true, configurable: true, enumerable: false })
  const drift = diff(baseline, snapshot(targets))
  assert.ok(drift.some((entry) => entry.target === 'subject.version'))
  Object.defineProperty(subject, 'version', { value: '1.0.0', writable: true, configurable: true, enumerable: true })
})

check('prototype pollution is detected', () => {
  const baseline = snapshot(targets)
  Array.prototype.__tamper = function () {}
  try {
    const drift = diff(baseline, snapshot(targets))
    assert.ok(drift.some((entry) => entry.target === 'arrayProto.__tamper' && entry.kind === 'property-added'), JSON.stringify(drift))
  } finally {
    delete Array.prototype.__tamper
  }
})

check('assertIntact throws TamperError with drift', () => {
  const baseline = snapshot(targets)
  subject.extra = true
  try {
    assert.throws(() => assertIntact(baseline, snapshot(targets)), (error) => error instanceof TamperError && error.drift.length > 0)
  } finally {
    delete subject.extra
  }
})

check('guard reports and can rebaseline', () => {
  const local = { value: 1 }
  const guard = createGuard({ local })
  assert.equal(guard.check(), true)
  local.value = 2
  assert.equal(guard.check(), true) // data value changes are not descriptor tampering
  local.injected = true
  assert.equal(guard.check(), false)
  assert.ok(guard.drift().length > 0)
  delete local.injected
  assert.equal(guard.check(), true)
})

check('snapshot is JSON stable', () => {
  assert.equal(JSON.stringify(snapshot(targets)), JSON.stringify(snapshot(targets)))
})

console.log(`checks: ${passed}/${total}`)
