import assert from 'node:assert/strict'
import { scan, redactText, summarize, shannonEntropy, RULES } from './src/index.js'

let passed = 0
let total = 0
function check(name, fn) {
  total += 1
  try { fn(); passed += 1 } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error }
}

const aws = 'AKIAIOSFODNN7EXAMPLE'
const github = `ghp_${'a'.repeat(36)}`
const telegram = `123456789:${'A'.repeat(35)}`
const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`
const text = [
  `const awsKey = "${aws}";`,
  `const gh = "${github}";`,
  `const bot = "${telegram}";`,
  `const token = "${jwt}";`,
  `const db = "postgres://user:password123@db.example.test/app";`,
  `password = "super-secret-value";`,
  '-----BEGIN PRIVATE KEY-----',
].join('\n')

check('detects critical credential families', () => {
  const findings = scan(text)
  const rules = new Set(findings.map((finding) => finding.rule))
  for (const rule of ['aws-access-key', 'github-token', 'telegram-bot', 'jwt', 'basic-auth-url', 'password-assignment']) {
    assert.ok(rules.has(rule), `missing ${rule}: ${[...rules].join(',')}`)
  }
})

check('findings include position, entropy and redacted preview', () => {
  const findings = scan(text)
  const awsFinding = findings.find((finding) => finding.rule === 'aws-access-key')
  assert.equal(awsFinding.line, 1)
  assert.ok(awsFinding.column > 0)
  assert.equal(awsFinding.length, aws.length)
  assert.doesNotMatch(awsFinding.preview, new RegExp(aws))
  assert.match(awsFinding.preview, /\*/)
  assert.ok(awsFinding.entropy > 2)
})

check('benign text produces no findings', () => {
  const findings = scan('const message = "hello world";\nconsole.log(message);\nhttps://example.test/docs')
  assert.deepEqual(findings, [])
})

check('entropy filter suppresses low-entropy blobs', () => {
  const noisy = `const blob = "${'a'.repeat(48)}";`
  assert.equal(scan(noisy, { minEntropy: 3.6 }).length, 0)
})

check('allowlist suppresses known test fixtures', () => {
  const findings = scan(`AKIAIOSFODNN7EXAMPLE`, { allowlist: [aws] })
  assert.equal(findings.length, 0)
})

check('custom rules are supported', () => {
  const findings = scan('internal-key=abcd-1234-efgh-5678', {
    rules: [{ id: 'internal-key', pattern: /internal-key=[a-z0-9-]+/g, severity: 'high' }],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'internal-key')
})

check('redaction removes secrets but keeps structure', () => {
  const redacted = redactText(text)
  assert.doesNotMatch(redacted, new RegExp(aws))
  assert.doesNotMatch(redacted, new RegExp(github))
  assert.match(redacted, /const awsKey =/)
  assert.match(redacted, /const gh =/)
})

check('entropy calculation and summary', () => {
  assert.equal(shannonEntropy('aaaa'), 0)
  assert.ok(shannonEntropy('abcdefghijklmnop') > 3.9)
  const summary = summarize(scan(text))
  assert.ok(summary.total >= 6)
  assert.ok(summary.bySeverity.critical >= 3)
  assert.ok(summary.rules.length >= 5)
  assert.ok(RULES.length >= 8)
})

console.log(`checks: ${passed}/${total}`)
