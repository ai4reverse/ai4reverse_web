#!/usr/bin/env node
/**
 * Detection Rule Generator — turn an analysis report into YARA and Sigma-style
 * rules plus a JSON IOC bundle.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSample } from '../../../tools/index.js'

function ruleName(report) {
  const base = (report.sample?.name ?? 'sample').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_')
  return `${base}_${report.sample.sha256.slice(0, 8)}`
}

function stringLiterals(report) {
  const values = new Set()
  for (const url of report.static.iocs.urls ?? []) values.add(url.value)
  for (const domain of report.static.iocs.domains ?? []) values.add(domain.value)
  for (const hash of report.static.iocs.hashes ?? []) values.add(hash.value)
  for (const technique of report.static.techniques ?? []) values.add(technique)
  return [...values].filter((value) => value.length >= 4).slice(0, 20)
}

export function generateRules(report) {
  const name = ruleName(report)
  const strings = stringLiterals(report)
  const yaraStrings = strings
    .map((value, index) => `        $s${index + 1} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join('\n')
  const yara = `rule ${name}
{
    meta:
        description = "${report.sample?.name ?? 'sample'}"
        sha256 = "${report.sample?.sha256 ?? ''}"
        verdict = "${report.verdict?.level ?? 'unknown'}"
        score = ${report.verdict?.score ?? 0}
        family = "${(report.verdict?.families ?? []).join(',')}"
    strings:
${yaraStrings || '        $s1 = "malicious"'}
    condition:
        uint16(0) == 0x5a4d or any of them
}`

  const iocs = report.static.iocs ?? {}
  const detection = {
    selection_urls: (iocs.urls ?? []).map((entry) => entry.value),
    selection_domains: (iocs.domains ?? []).map((entry) => entry.value),
    selection_hashes: (iocs.hashes ?? []).map((entry) => entry.value),
    selection_techniques: report.static.techniques ?? [],
    condition: 'selection_urls or selection_domains or selection_hashes',
  }
  const sigma = `title: ${report.sample?.name ?? 'malicious JavaScript'} (${report.verdict?.level ?? 'unknown'})
id: ${report.sample?.sha256?.slice(0, 32) ?? name}
status: experimental
description: Generated from ai4reverse report ${report.sample?.sha256 ?? ''}
logsource:
    category: webserver
detection:
${Object.entries(detection)
  .filter(([, value]) => value !== undefined)
  .map(([key, value]) => `    ${key}:\n${Array.isArray(value) ? value.map((item) => `        - '${String(item).replace(/'/g, "''")}'`).join('\n') : `        - '${value}'`}`)
  .join('\n')}
    condition: selection_urls or selection_domains or selection_hashes
level: ${report.verdict?.level === 'malicious' ? 'critical' : 'high'}
tags:
${(report.static.techniques ?? []).map((tag) => `    - attack.${tag.replace(/[^a-z0-9]+/g, '_')}`).join('\n') || '    - attack.javascript'}
`
  const json = { name, sha256: report.sample?.sha256 ?? '', verdict: report.verdict ?? null, iocs, techniques: report.static.techniques ?? [] }
  return { yara, sigma, json }
}

async function selfTest() {
  const sample = 'var u = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");\nfetch(u).catch(function(){});\neval(atob("Y29uc29sZS5sb2coMSk="));\n'
  const result = await analyzeSample(sample, { name: 'rule-sample.js', logLevel: 'silent', network: { policy: 'deny' } })
  const rules = generateRules(result.report)
  if (!rules.yara.includes('rule rule_sample_')) throw new Error('YARA rule name missing')
  if (!rules.yara.includes(result.report.sample.sha256)) throw new Error('YARA hash missing')
  if (!rules.yara.includes('c2.example.test')) throw new Error('YARA IOC missing')
  if (!rules.sigma.includes('title:')) throw new Error('Sigma title missing')
  if (!rules.sigma.includes('detection:')) throw new Error('Sigma detection missing')
  if (rules.json.verdict.level !== result.report.verdict.level) throw new Error('JSON bundle mismatch')
  const directory = await mkdtemp(join(tmpdir(), 'rules-'))
  try {
    const yaraPath = join(directory, 'rule.yar')
    await writeFile(yaraPath, rules.yara, 'utf8')
    const written = await readFile(yaraPath, 'utf8')
    if (!written.includes('condition:')) throw new Error('YARA file write failed')
    const sigmaPath = join(directory, 'rule.yml')
    await writeFile(sigmaPath, rules.sigma, 'utf8')
    if (!(await readFile(sigmaPath, 'utf8')).includes('logsource:')) throw new Error('Sigma file write failed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  console.log(`rules: yara=${rules.yara.length}b sigma=${rules.sigma.length}b json=${Object.keys(rules.json).length} keys`)
  console.log('SELFTEST OK')
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  if (process.argv.includes('--help') || !process.argv[2]) {
    console.log('Detection Rule Generator\n  <sample.js> [--out <dir>] [--json]\n  --self-test')
    if (!process.argv[2]) process.exitCode = 2
    return
  }
  const source = await readFile(process.argv[2], 'utf8')
  const result = await analyzeSample(source, { name: process.argv[2], logLevel: 'silent', network: { policy: 'deny' } })
  const rules = generateRules(result.report)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rules, null, 2))
    return
  }
  console.log(rules.yara)
  console.log(rules.sigma)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
