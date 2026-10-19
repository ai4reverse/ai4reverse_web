import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReport, renderMarkdown, scoreVerdict, VERDICT_WEIGHTS } from '../tools/analysis/report.js'

const maliciousIocs = {
  urls: [
    {
      value: 'https://evil.example.com/a',
      scheme: 'https',
      host: 'evil.example.com',
      path: '/a',
      source: 'static',
      offset: 0,
    },
  ],
  domains: [{ value: 'bad-domain.top', count: 1, offset: 0, suspiciousTld: true }],
  ips: [{ value: '192.168.1.10', version: 4, count: 1, offset: 0 }],
  emails: [],
  hashes: [{ value: 'd41d8cd98f00b204e9800998ecf8427e', algo: 'md5', count: 1, offset: 0 }],
  wallets: [{ value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', kind: 'btc', count: 1, offset: 0 }],
  base64: [
    {
      value: 'aHR0cHM6Ly9jMi5leGFtcGxlLm9yZy9iZWFjb24=',
      length: 40,
      count: 1,
      offset: 0,
      decodedKind: 'url',
      decodedPreview: 'https://c2.example.org/beacon',
    },
  ],
  telegram: [{ value: '123456789:AAHq7Y8zX9wV6uT5sR4pQ3oN2mL1kJ0hGfE', kind: 'bot-token', count: 1, offset: 0 }],
  discordWebhooks: [],
  crypto: [],
  shellCommands: [{ value: 'powershell -enc SQBFAFgA', count: 1, offset: 0 }],
  registryKeys: [],
  filePaths: [],
  mutexes: [],
  other: [],
  meta: { truncated: false },
}

const analysisFixture = {
  meta: {
    runId: 'run-42',
    startedAt: '2025-01-01T00:00:00.000Z',
    durationMs: 1234,
    seed: 7,
    profile: {
      browser: 'Chromium',
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 test',
      timezone: 'UTC',
      locale: 'en-US',
      screen: { width: 1920, height: 1080 },
    },
    limits: { timeoutMs: 5000, maxEvents: 1000 },
  },
  sample: {
    name: 'sample.js',
    size: 1024,
    sha256: 'a'.repeat(64),
    sourceUrl: 'https://samples.test/sample.js',
    sourceType: 'script',
    truncated: false,
  },
  code: 'eval("https://evil.example.com/a")',
  static: {
    parse: { ok: true, sourceType: 'script', errors: [] },
    restoration: {
      passes: [{ id: 'strings', changed: true, durationMs: 3, notes: ['decoded 2 strings'] }],
      code: 'eval("x")',
      sha256: 'b'.repeat(64),
      size: 9,
      reducedBy: 1015,
    },
    ast: {
      functions: 4,
      strings: 12,
      memberAccesses: 80,
      evalLike: 2,
      timers: 1,
      networkCalls: 3,
      obfuscation: { score: 75, indicators: ['hex strings', 'string array'] },
    },
    iocs: maliciousIocs,
    techniques: ['eval chain', 'base64 payload'],
  },
  dynamic: {
    ok: true,
    error: null,
    limitsHit: [],
    result: { type: 'string', preview: 'ok' },
    events: [{ seq: 1, kind: 'net', phase: 'before', url: 'https://evil.example.com/a' }],
    counts: { byKind: { net: 3, dom: 1, eval: 1, storage: 1 } },
    behavior: {
      apis: [
        { name: 'eval', count: 2 },
        { name: 'fetch', count: 1 },
      ],
      network: { requests: 3 },
      storage: { writes: 1 },
      dom: { nodes: 2 },
      timers: { scheduled: 1 },
    },
    exceptions: { uncaught: 0, caught: 1, promiseJobs: 0 },
    environment: { profile: { browser: 'Chromium' } },
  },
  tracing: { enabled: true, events: 25, dropped: 2, jsvmp: { detected: false, opcodes: 0, steps: 0 } },
  hooks: { active: 3, fired: 2, mocks: 1 },
  artifacts: [{ id: 'art-1', kind: 'network', sha256: 'c'.repeat(64), size: 12, preview: 'https://evil.example.com/a' }],
  recommendations: ['Block evil.example.com at the perimeter.'],
  integrity: { intact: true, drift: [] },
}

test('buildReport produces the full top-level schema', () => {
  const report = buildReport(analysisFixture)

  assert.deepEqual(Object.keys(report).sort(), [
    'artifacts',
    'dynamic',
    'hooks',
    'integrity',
    'meta',
    'recommendations',
    'sample',
    'static',
    'tracing',
    'verdict',
  ])
  assert.deepEqual(Object.keys(report.meta).sort(), [
    'durationMs',
    'limits',
    'profile',
    'runId',
    'seed',
    'startedAt',
    'tool',
    'version',
  ])
  assert.equal(report.meta.tool, 'ai4reverse')
  assert.equal(typeof report.meta.version, 'string')
  assert.deepEqual(Object.keys(report.meta.profile).sort(), [
    'browser',
    'locale',
    'platform',
    'screen',
    'timezone',
    'userAgent',
  ])
  assert.deepEqual(Object.keys(report.sample).sort(), [
    'name',
    'sha256',
    'size',
    'sourceType',
    'sourceUrl',
    'truncated',
  ])
  assert.deepEqual(Object.keys(report.static).sort(), ['ast', 'iocs', 'parse', 'restoration', 'techniques'])
  assert.deepEqual(Object.keys(report.static.ast).sort(), [
    'evalLike',
    'functions',
    'memberAccesses',
    'networkCalls',
    'obfuscation',
    'strings',
    'timers',
  ])
  assert.deepEqual(Object.keys(report.dynamic).sort(), [
    'behavior',
    'counts',
    'environment',
    'error',
    'events',
    'exceptions',
    'limitsHit',
    'ok',
    'result',
  ])
  assert.deepEqual(Object.keys(report.dynamic.behavior).sort(), ['apis', 'dom', 'network', 'storage', 'timers'])
  assert.deepEqual(Object.keys(report.tracing.jsvmp).sort(), ['detected', 'opcodes', 'steps'])
  assert.deepEqual(Object.keys(report.hooks).sort(), ['active', 'fired', 'mocks'])
  assert.deepEqual(Object.keys(report.integrity).sort(), ['drift', 'intact'])
  assert.equal(report.verdict.level, 'malicious')
  assert.equal(report.verdict.score, 100)
  assert.ok(Array.isArray(report.verdict.reasons))
})

test('scoreVerdict is monotonic, transparent and clamps to 0..100', () => {
  const empty = scoreVerdict({})
  const staticOnly = scoreVerdict({ staticSection: { ast: { evalLike: 1 } } })
  const plusIocs = scoreVerdict({
    staticSection: { ast: { evalLike: 1 } },
    iocs: {
      urls: [{ value: 'https://evil.example.com/a' }],
      wallets: [{ value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', kind: 'btc' }],
    },
  })
  const plusDynamic = scoreVerdict({
    staticSection: { ast: { evalLike: 1 } },
    iocs: {
      urls: [{ value: 'https://evil.example.com/a' }],
      wallets: [{ value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', kind: 'btc' }],
    },
    dynamicSection: {
      counts: { byKind: { net: 5 } },
      behavior: { apis: [{ name: 'eval', count: 1 }] },
      limitsHit: ['timeout'],
    },
  })

  assert.equal(empty.score, 0)
  assert.equal(empty.level, 'benign')
  assert.equal(empty.confidence, 0.05)
  assert.ok(staticOnly.score > empty.score)
  assert.ok(plusIocs.score >= staticOnly.score)
  assert.ok(plusDynamic.score >= plusIocs.score)
  assert.ok(plusDynamic.confidence >= plusIocs.confidence)
  assert.ok(plusDynamic.score <= 100)
  assert.equal(plusDynamic.level, 'suspicious')
  for (const reason of plusDynamic.reasons) {
    assert.equal(typeof reason.code, 'string')
    assert.ok(reason.weight > 0)
    assert.equal(typeof reason.detail, 'string')
  }
  assert.deepEqual(Object.keys(VERDICT_WEIGHTS).includes('iocWalletsBase'), true)
})

test('scoreVerdict classifies the malicious threshold from independent signals', () => {
  const huge = scoreVerdict({
    staticSection: {
      ast: { evalLike: 5, networkCalls: 5, timers: 2, obfuscation: { score: 100 } },
      restoration: { passes: [{ changed: true }, { changed: true }, { changed: true }] },
    },
    iocs: {
      urls: [{ value: 'https://a.example.com' }, { value: 'https://b.example.com' }, { value: 'https://c.example.com' }],
      domains: [{ suspiciousTld: true }, { suspiciousTld: true }],
      wallets: [{ kind: 'btc' }],
      base64: [{ decodedKind: 'script' }],
      telegram: [{ kind: 'bot-token' }],
      discordWebhooks: [{ value: 'https://discord.com/api/webhooks/1/x' }],
      shellCommands: [{ value: 'powershell -enc x' }],
      hashes: [{ algo: 'md5' }],
      mutexes: [{ value: 'Global\\x' }],
    },
    dynamicSection: {
      counts: { byKind: { net: 10, storage: 2, dom: 3, eval: 2 } },
      behavior: { apis: [{ name: 'eval', count: 1 }] },
      limitsHit: ['timeout'],
      exceptions: { uncaught: 1 },
    },
    tracing: { jsvmp: { detected: true } },
    hooks: { mocks: 1 },
  })

  assert.equal(huge.score, 100)
  assert.equal(huge.level, 'malicious')
  assert.ok(huge.confidence > 0.5)
  assert.ok(huge.families.includes('obfuscation'))
})

test('renderMarkdown includes every required heading and omits undefined', () => {
  const markdown = renderMarkdown(buildReport(analysisFixture))

  for (const heading of [
    '## Verdict',
    '## Sample',
    '## Static analysis',
    '## IOCs',
    '## Dynamic behaviour',
    '## Tracing/JSVMP',
    '## Integrity',
    '## Recommendations',
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`)
  }
  assert.ok(markdown.includes('Block evil.example.com'))
  assert.ok(markdown.includes('100 / 100'))
  assert.ok(!markdown.includes('undefined'))
  assert.ok(!markdown.includes('NaN'))
})

test('renderMarkdown escapes table pipes', () => {
  const report = buildReport({
    static: {
      iocs: {
        domains: [{ value: 'evil|domain.top', count: 1, suspiciousTld: true }],
        urls: [],
        ips: [],
        emails: [],
        hashes: [],
        wallets: [],
        base64: [],
        telegram: [],
        discordWebhooks: [],
        crypto: [],
        shellCommands: [],
        registryKeys: [],
        filePaths: [],
        mutexes: [],
        other: [],
        meta: { truncated: false },
      },
    },
  })
  const markdown = renderMarkdown(report)

  assert.ok(markdown.includes('evil\\|domain.top'))
})

test('buildReport and renderMarkdown survive empty or partial input', () => {
  const empty = buildReport({})
  assert.equal(empty.verdict.score, 0)
  assert.equal(empty.verdict.level, 'benign')
  assert.deepEqual(empty.static.iocs.urls, [])
  assert.equal(empty.dynamic.ok, false)
  assert.ok(Array.isArray(empty.artifacts))
  assert.ok(Array.isArray(empty.recommendations))

  const emptyMarkdown = renderMarkdown(empty)
  assert.ok(emptyMarkdown.includes('## Verdict'))
  assert.ok(emptyMarkdown.includes('No IOCs extracted.'))
  assert.ok(!emptyMarkdown.includes('undefined'))

  assert.doesNotThrow(() => buildReport())
  assert.doesNotThrow(() => buildReport(null))
  assert.doesNotThrow(() => renderMarkdown({}))
  assert.doesNotThrow(() => renderMarkdown(null))
})

test('buildReport extracts IOCs from provided source code when none are supplied', () => {
  const report = buildReport({ code: 'fetch("https://auto.example.com/x")' })

  assert.ok(report.static.iocs.urls.some((url) => url.value === 'https://auto.example.com/x'))
  assert.equal(report.static.iocs.meta.truncated, false)
})
