import test from 'node:test'
import assert from 'node:assert/strict'

import { extractIOCs, extractFromEvents, IOC_LIMITS } from '../tools/analysis/ioc.js'

const encodedUrl = Buffer.from('https://c2.example.org/beacon').toString('base64')

const SAMPLE = String.raw`
var load = "https://evil.example.com/gate.php?id=1";
var defanged = "hxxps://bad-domain[.]top/payload[.]js";
var encoded = "${encodedUrl}";
var btc = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
var eth = "0x52908400098527886E0F7030069857D2E4169EE7";
var md5 = "d41d8cd98f00b204e9800998ecf8427e";
var md5Again = "d41d8cd98f00b204e9800998ecf8427e";
var sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
var sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
var telegram = "123456789:AAHq7Y8zX9wV6uT5sR4pQ3oN2mL1kJ0hGfE";
var hook = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF";
var ip = "192.168.1.10";
var mail = "attacker@evil.example.com";
var cmd = "powershell -enc SQBFAFgA";
var benign = "https://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd";
var duplicate = "https://dedupe.example.net/a";
var duplicateAgain = "https://dedupe.example.net/a";
var chars = String.fromCharCode(104,116,116,112,115,58,47,47,102,114,111,109,99,104,97,114,46,101,120,97,109,112,108,101,46,110,101,116,47,120);
`

test('extractIOCs finds URLs, defanged URLs, decoded URLs and every category', () => {
  const result = extractIOCs(SAMPLE)
  const urls = result.urls.map((url) => url.value)

  assert.ok(urls.includes('https://evil.example.com/gate.php?id=1'))
  assert.ok(urls.includes('https://bad-domain.top/payload.js'), 'hxxp/[.] form is normalised')
  assert.ok(urls.includes('https://c2.example.org/beacon'), 'base64 payload is decoded')

  const decoded = result.urls.find((url) => url.value === 'https://c2.example.org/beacon')
  assert.equal(decoded.source, 'decoded')
  assert.equal(decoded.scheme, 'https')
  assert.equal(decoded.host, 'c2.example.org')
  assert.equal(decoded.path, '/beacon')

  const suspicious = result.domains.find((domain) => domain.value === 'bad-domain.top')
  assert.equal(suspicious.suspiciousTld, true)
  assert.ok(result.ips.some((ipValue) => ipValue.value === '192.168.1.10' && ipValue.version === 4))
  assert.ok(result.emails.some((email) => email.value === 'attacker@evil.example.com'))
  assert.deepEqual(
    result.hashes.map((hash) => hash.algo).sort(),
    ['md5', 'sha1', 'sha256'],
  )
  assert.ok(result.wallets.some((wallet) => wallet.kind === 'btc'))
  assert.ok(result.wallets.some((wallet) => wallet.kind === 'eth'))
  assert.ok(result.telegram.some((entry) => entry.kind === 'bot-token' && entry.value.startsWith('123456789:')))
  assert.equal(result.discordWebhooks.length, 1)
  assert.ok(result.shellCommands.some((command) => command.value.startsWith('powershell -enc')))
  assert.ok(result.base64.some((item) => item.value === encodedUrl && item.decodedKind === 'url'))
  assert.ok(result.other.some((item) => item.kind === 'fromCharCode'))
  assert.ok(urls.includes('https://fromchar.example.net/x'), 'String.fromCharCode output is scanned')
  assert.equal(result.meta.truncated, false)
})

test('extractIOCs deduplicates by value and keeps the first offset and count', () => {
  const result = extractIOCs(SAMPLE)

  const dedupedUrl = result.urls.filter((url) => url.value === 'https://dedupe.example.net/a')
  assert.equal(dedupedUrl.length, 1)
  assert.equal(dedupedUrl[0].offset, SAMPLE.indexOf('https://dedupe.example.net/a'))

  const dedupedDomain = result.domains.find((domain) => domain.value === 'dedupe.example.net')
  assert.equal(dedupedDomain.count, 2)

  const md5 = result.hashes.find((hash) => hash.algo === 'md5')
  assert.equal(md5.count, 2)
})

test('known-benign hosts are marked but excluded from the domain list', () => {
  const result = extractIOCs(SAMPLE)
  const benign = result.urls.find((url) => url.host === 'www.w3.org')

  assert.ok(benign, 'benign URL is still reported')
  assert.equal(benign.benignHost, true)
  assert.ok(!result.domains.some((domain) => domain.value === 'w3.org' || domain.value === 'www.w3.org'))
})

test('defanged URL offsets map back to the original text', () => {
  const result = extractIOCs('see hxxps://bad-domain[.]top/x now')
  const url = result.urls.find((item) => item.value === 'https://bad-domain.top/x')

  assert.ok(url)
  assert.equal(url.offset, 4)
  assert.equal(result.meta.truncated, false)
})

test('base64 decoding can be disabled for callers that only want static text', () => {
  const result = extractIOCs(SAMPLE, { decodeBase64: false })
  assert.ok(!result.urls.some((url) => url.value === 'https://c2.example.org/beacon'))
  assert.ok(result.base64.every((item) => item.decodedKind === undefined))
})

test('extractIOCs tolerates empty input and fills every category', () => {
  const empty = extractIOCs()

  for (const key of [
    'urls',
    'domains',
    'ips',
    'emails',
    'hashes',
    'wallets',
    'base64',
    'telegram',
    'discordWebhooks',
    'crypto',
    'shellCommands',
    'registryKeys',
    'filePaths',
    'mutexes',
    'other',
  ]) {
    assert.ok(Array.isArray(empty[key]), `${key} is an array`)
  }
  assert.deepEqual(empty.meta, { truncated: false })
})

test('extractIOCs enforces the candidate cap', () => {
  const many = 'https://cap.example/x '.repeat(IOC_LIMITS.maxCandidates + 500)
  const result = extractIOCs(many)

  assert.equal(result.meta.truncated, true)
  assert.equal(result.urls.length, 1, 'repeated value still deduplicates')
})

test('extractFromEvents reports network, eval and ioc event URLs as dynamic', () => {
  const dynamic = extractFromEvents([
    { kind: 'net', phase: 'before', url: 'https://c2.example.org/beacon' },
    { kind: 'eval', phase: 'before', payload: { code: 'fetch("https://second.example.net/x")' } },
    { kind: 'ioc', phase: 'emit', value: 'https://third.example.net/y' },
    { kind: 'api', phase: 'before', url: 'https://ignored.example.com/' },
  ])

  assert.equal(dynamic.urls.length, 3)
  assert.ok(dynamic.urls.every((url) => url.source === 'dynamic'))
  assert.ok(dynamic.urls.some((url) => url.value === 'https://second.example.net/x'))
  assert.ok(!dynamic.urls.some((url) => url.value.includes('ignored.example.com')))

  const empty = extractFromEvents(null)
  assert.deepEqual(empty.urls, [])
  assert.deepEqual(empty.meta, { truncated: false })
})

test('extractIOCs does not starve wallets when domains flood the candidate budget', () => {
  const btc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
  const hosts = Array.from({ length: 2100 }, (_, i) => `"host${i}.com"`).join(' ')
  const flooded = extractIOCs(`${hosts} "${btc}"`)
  assert.ok(flooded.wallets.some((wallet) => wallet.value === btc), 'wallet survives domain flood')
  assert.equal(flooded.meta.truncated, true)

  const alone = extractIOCs(`"${btc}"`)
  assert.equal(alone.wallets.length, 1)
  assert.equal(alone.wallets[0].value, btc)
})
