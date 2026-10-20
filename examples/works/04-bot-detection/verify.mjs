import assert from 'node:assert/strict'
import { createDetector, scoreEvents, RULES } from './src/index.js'

let passed = 0
let total = 0
function check(name, fn) {
  total += 1
  try { fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

check('human-like interaction scores low', () => {
  const detector = createDetector()
  detector.ingest({ type: 'focus' })
  for (let index = 0; index < 12; index += 1) detector.ingest({ type: 'pointer', x: 100 + index * 7, y: 200 + (index % 3) * 11 })
  for (let index = 0; index < 8; index += 1) detector.ingest({ type: 'key', at: 1000 + index * 130 })
  detector.ingest({ type: 'form:start', at: 5000 })
  detector.ingest({ type: 'form:submit', at: 9500 })
  const result = detector.score()
  assert.ok(result.score < 30, JSON.stringify(result))
  assert.equal(detector.verdict(), 'human')
})

check('automation and instant form fill score as bot', () => {
  const result = scoreEvents(
    [{ type: 'form:start', at: 1000 }, { type: 'form:submit', at: 1050 }, { type: 'honeypot', filled: true }],
    { webdriver: true, headless: true },
  )
  assert.ok(result.score >= 60, JSON.stringify(result))
  assert.ok(result.reasons.includes('webdriver'))
  assert.ok(result.reasons.includes('honeypot'))
})

check('linear pointer path is reported', () => {
  const detector = createDetector()
  for (let index = 0; index < 5; index += 1) detector.ingest({ type: 'pointer', x: index * 10, y: index * 10 })
  assert.ok(detector.score().reasons.includes('linearPointer'))
})

check('robotic key timing is reported', () => {
  const detector = createDetector()
  for (let index = 0; index < 5; index += 1) detector.ingest({ type: 'key', at: index * 100 })
  assert.ok(detector.score().reasons.includes('roboticTiming'))
})

check('explain exposes weights and labels', () => {
  const detector = createDetector({ automation: { webdriver: true } })
  const explanation = detector.explain()
  assert.equal(explanation.verdict, 'suspicious')
  assert.equal(explanation.reasons[0].key, 'webdriver')
  assert.equal(explanation.reasons[0].weight, RULES.webdriver.weight)
  assert.match(explanation.reasons[0].label, /webdriver/)
})

check('reset clears accumulated signals', () => {
  const detector = createDetector({ automation: { webdriver: true } })
  detector.ingest({ type: 'honeypot', filled: true })
  assert.ok(detector.score().score > 0)
  detector.reset()
  assert.equal(detector.score().score, 0)
})

console.log(`checks: ${passed}/${total}`)
