import assert from 'node:assert/strict'
import { analyzeTaint, renderTaintReport } from '../tools/index.js'

// Source strings are parsed only. They are never executed on the host.
const source = [
  'const input = location.hash;',
  'const decoded = atob(input);',
  'eval(decoded);',
].join('\n')
const report = await analyzeTaint(source, { filename: 'loader.js' })
assert.equal(report.ok, true)
assert.ok(report.flows.some((flow) => flow.sink_type === 'code_injection'))
console.log(renderTaintReport(report))

const sanitized = await analyzeTaint([
  'const input = location.hash;',
  'const clean = DOMPurify.sanitize(input);',
  'document.body.innerHTML = clean;',
].join('\n'))
assert.equal(sanitized.ok, true)
assert.equal(sanitized.flows.length, 0)
assert.ok(sanitized.sanitizers.length > 0)
console.log('sanitized DOM example: no flows reported (not proof of safety)')
