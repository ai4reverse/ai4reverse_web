#!/usr/bin/env node
/**
 * Incident-Response Playbook — derive a prioritised IR plan from an analysis
 * report: containment, eradication, recovery and post-incident actions.
 */
import { readFile } from 'node:fs/promises'
import { analyzeSample } from '../../../tools/index.js'

const PHASES = [
  ['triage', 'Triage & scoping'],
  ['containment', 'Containment'],
  ['eradication', 'Eradication'],
  ['recovery', 'Recovery'],
  ['post', 'Post-incident'],
]

export function generatePlaybook(report) {
  const verdict = report.verdict ?? {}
  const iocs = report.static?.iocs ?? {}
  const behavior = report.dynamic?.behavior ?? {}
  const killChain = (behavior.killChain ?? []).map((stage) => stage.stage)
  const exceptions = report.dynamic?.exceptions ?? {}
  const steps = []
  const add = (phase, priority, action, owner, timebox) => steps.push({ phase, priority, action, owner, timebox })

  add('triage', 1, `Confirm verdict "${verdict.level}" (${verdict.score}/100) with a second analysis seed/profile.`, 'SOC L1', '15m')
  add('triage', 1, `Record sample hash ${report.sample?.sha256 ?? 'unknown'} and preserve the original bytes.`, 'SOC L1', '5m')
  if ((iocs.urls ?? []).length > 0) add('triage', 1, `Extract and block ${iocs.urls.length} URL IOC(s): ${(iocs.urls ?? []).slice(0, 5).map((entry) => entry.value).join(', ')}`, 'SOC L2', '30m')
  if (killChain.includes('command-and-control')) add('containment', 1, 'Block C2 domains/URLs at proxy, DNS and egress firewall.', 'Network', '30m')
  if (killChain.includes('persistence')) add('containment', 1, 'Invalidate sessions and clear attacker-controlled storage/cookies.', 'Identity', '1h')
  if (killChain.includes('execution')) add('containment', 2, 'Isolate affected browsers/hosts and collect memory/network captures.', 'Endpoint', '1h')
  if ((iocs.wallets ?? []).length > 0) add('containment', 1, 'Warn finance/affected users about wallet-address replacement; verify recent transfers.', 'Finance', '1h')
  if ((iocs.telegram ?? []).length + (iocs.discordWebhooks ?? []).length + (iocs.slack ?? []).length > 0) {
    add('eradication', 1, 'Report/disable attacker bot/webhook channels and rotate related tokens.', 'Threat Intel', '2h')
  }
  if ((behavior.apis ?? []).some((api) => /localStorage|sessionStorage|setItem/.test(api.name))) {
    add('eradication', 2, 'Purge poisoned browser storage and force re-authentication for impacted users.', 'Identity', '2h')
  }
  if ((exceptions.uncaught ?? []).length > 0) add('eradication', 3, 'Reproduce uncaught errors under a matching profile to reveal hidden stages.', 'Malware Analysis', '4h')
  add('recovery', 2, 'Rotate credentials/tokens exposed to the sample and monitor for reuse.', 'Identity', '4h')
  add('recovery', 2, 'Restore affected systems from known-good backups and verify integrity.', 'IT Ops', '8h')
  add('post', 3, 'Ship detection rules (YARA/Sigma) and add IOCs to the intel platform.', 'Detection Eng', '1d')
  add('post', 3, 'Write an incident timeline and update the phishing/malware playbook.', 'IR Lead', '2d')

  const ordered = steps.sort((a, b) => a.priority - b.priority || PHASES.findIndex(([key]) => key === a.phase) - PHASES.findIndex(([key]) => key === b.phase))
  const markdown = [
    `# Incident Response Playbook — ${report.sample?.name ?? 'sample'}`,
    '',
    `- Verdict: **${verdict.level ?? 'unknown'}** (${verdict.score ?? 0}/100)`,
    `- SHA-256: \`${report.sample?.sha256 ?? ''}\``,
    `- Kill chain: ${killChain.join(' → ') || 'none observed'}`,
    `- URL IOCs: ${(iocs.urls ?? []).length} | domains: ${(iocs.domains ?? []).length} | wallets: ${(iocs.wallets ?? []).length}`,
    '',
  ]
  for (const [key, title] of PHASES) {
    const phaseSteps = ordered.filter((step) => step.phase === key)
    if (phaseSteps.length === 0) continue
    markdown.push(`## ${title}`, '')
    for (const step of phaseSteps) {
      markdown.push(`- [ ] **P${step.priority}** ${step.action} _(${step.owner}, ${step.timebox})_`)
    }
    markdown.push('')
  }
  markdown.push('## Verification', '', '- [ ] IOCs blocked and monitored for 72h', '- [ ] Credentials rotated', '- [ ] Detection rules deployed and tested')
  return { steps: ordered, markdown: markdown.join('\n'), phases: PHASES.map(([key]) => key) }
}

async function selfTest() {
  const sample = 'var u = atob("aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u");\nfetch(u).catch(function(){});\nlocalStorage.setItem("token", "demo");\neval(atob("Y29uc29sZS5sb2coMSk="));\n'
  const result = await analyzeSample(sample, { name: 'ir-sample.js', logLevel: 'silent', network: { policy: 'deny' } })
  const playbook = generatePlaybook(result.report)
  if (playbook.steps.length < 5) throw new Error('too few steps')
  for (const key of ['triage', 'containment', 'recovery', 'post']) {
    if (!playbook.markdown.includes(`## ${PHASES.find(([phase]) => phase === key)[1]}`)) throw new Error(`missing ${key} section`)
  }
  if (!playbook.markdown.includes(result.report.sample.sha256)) throw new Error('hash missing')
  if (!playbook.markdown.includes('c2.example.test')) throw new Error('IOC missing')
  if (!playbook.steps.every((step) => step.priority >= 1 && step.owner && step.timebox)) throw new Error('step metadata incomplete')
  console.log(`playbook: steps=${playbook.steps.length} phases=${[...new Set(playbook.steps.map((step) => step.phase))].join(',')}`)
  console.log('SELFTEST OK')
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  if (process.argv.includes('--help') || !process.argv[2]) {
    console.log('Incident-Response Playbook\n  <sample.js> [--json]\n  --self-test')
    if (!process.argv[2]) process.exitCode = 2
    return
  }
  const source = await readFile(process.argv[2], 'utf8')
  const result = await analyzeSample(source, { name: process.argv[2], logLevel: 'silent', network: { policy: 'deny' } })
  const playbook = generatePlaybook(result.report)
  if (process.argv.includes('--json')) console.log(JSON.stringify(playbook, null, 2))
  else console.log(playbook.markdown)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
