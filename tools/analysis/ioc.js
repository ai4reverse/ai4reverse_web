/**
 * Indicator-of-compromise extraction for malicious JavaScript.
 *
 * The extractor is deliberately offline and bounded: it never performs network
 * lookups, never evaluates the sample, and stops after `maxCandidates` matches
 * or `maxLength` characters. Extracted values are deduplicated by value while
 * retaining the first source offset and an occurrence count (where the report
 * schema uses one), so a report built from the same input is byte-stable.
 *
 * Two obfuscation forms are normalised before the static patterns run:
 *
 * - defanged notation (`hxxps://host[.]tld/path`)
 * - literals decoded by `String.fromCharCode(...)`
 *
 * Base64 candidates are decoded exactly one level deep; any indicator found in
 * the decoded text is merged back into the same result and marked with
 * `source: 'decoded'`. Decoded text is never decoded again.
 */

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

/** Default hard limits. Callers may lower them, but the report cites these. */
export const IOC_LIMITS = Object.freeze({
  maxCandidates: 2000,
  maxLength: 5 * 1024 * 1024,
})

/** Hosts that are overwhelmingly framework boilerplate rather than C2. */
export const BENIGN_HOST_SUFFIXES = Object.freeze(['w3.org', 'schema.org'])

const SUSPICIOUS_TLDS = new Set([
  'bar',
  'beer',
  'bid',
  'buzz',
  'cam',
  'cc',
  'cf',
  'click',
  'club',
  'cn',
  'cyou',
  'date',
  'download',
  'fit',
  'fun',
  'ga',
  'gq',
  'host',
  'icu',
  'link',
  'live',
  'loan',
  'men',
  'ml',
  'monster',
  'online',
  'party',
  'press',
  'pub',
  'pw',
  'qpon',
  'quest',
  'racing',
  'ren',
  'rest',
  'review',
  'rich',
  'ru',
  'sale',
  'science',
  'services',
  'shop',
  'site',
  'space',
  'stream',
  'su',
  'support',
  'tax',
  'team',
  'tk',
  'today',
  'tools',
  'top',
  'trade',
  'uno',
  'vip',
  'website',
  'wiki',
  'win',
  'work',
  'xin',
  'xyz',
  'zone',
])

/** Extensions that look like TLDs to the domain regex but are file suffixes. */
/**
 * Property/method names that look like a TLD when written as `obj.name`.
 * `e.message`, `a.length` and `x.toString` are not hosts; without this filter
 * every minified sample produces dozens of false positives.
 */
/** Object names that head `obj.prop` chains and are never real hosts. */
const JS_OBJECT_HEADS = new Set([
  'window', 'document', 'navigator', 'self', 'globalThis', 'this', 'console', 'location',
  'history', 'screen', 'performance', 'localStorage', 'sessionStorage', 'crypto', 'JSON',
  'Object', 'Array', 'Math', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Promise',
  'Symbol', 'Reflect', 'Proxy', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl',
  'process', 'module', 'exports', 'require', 'Buffer', 'event', 'event_target', 'target',
])

const MEMBER_TOKENS = new Set([
  'apply', 'assign', 'bind', 'call', 'catch', 'charat', 'charcodeat', 'classlist',
  'constructor', 'create', 'dataset', 'defineProperty', 'entries', 'exec', 'finally',
  'freeze', 'fromcharcode', 'getattribute', 'getelementbyid', 'getownpropertynames',
  'hasownproperty', 'includes', 'indexof', 'innerhtml', 'join', 'keys', 'length',
  'max', 'message', 'min', 'name', 'now', 'outerhtml',
  'parse', 'pop', 'preventdefault', 'prototype', 'push', 'queryselector', 'random',
  'reject', 'removechild', 'removeeventlistener', 'replace', 'resolve', 'setattribute',
  'shift', 'slice', 'splice', 'split', 'stoppropagation', 'stringify', 'style',
  'test', 'textcontent', 'then', 'tolowercase', 'tostring', 'touppercase', 'trim',
  'valueof', 'values',
])

const NON_TLD = new Set([
  'apk',
  'bak',
  'bat',
  'bin',
  'cmd',
  'css',
  'csv',
  'dat',
  'dll',
  'doc',
  'docx',
  'dtd',
  'fromcharcode',
  'exe',
  'gif',
  'htm',
  'html',
  'ico',
  'jar',
  'jpg',
  'jpeg',
  'js',
  'json',
  'log',
  'map',
  'random',
  'md',
  'msi',
  'pdf',
  'php',
  'png',
  'ps1',
  'py',
  'rar',
  'sh',
  'svg',
  'tmp',
  'ttf',
  'txt',
  'vbs',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'xml',
  'zip',
])

const EVENT_KINDS = new Set(['net', 'ioc', 'eval'])

/** Cheap pre-check so ordinary text skips the character-by-character normaliser. */
const DEFANG_HINT_RE = /hxxp|\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)|\{dot\}|\[:\]|\[\/\]|\[@|\[at\]/i

const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>\\]+/gi
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi
const EMAIL_RE = /[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,24}/gi
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6_RE = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi
const HASH_RE = /(?<![0-9a-f])([0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})(?![0-9a-f])/gi
const BASE64_RE = /(?:[A-Za-z0-9+/]{4}){4,}(?:[A-Za-z0-9+/]{2,3})?={0,2}/g
const FROM_CHAR_CODE_RE = /String\.fromCharCode\s*\(\s*(?:\[([^\]]*)\]|([^)]*))\)/g
const BTC_RE = /\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g
const ETH_RE = /\b0x[a-fA-F0-9]{40}\b/g
const XMR_RE = /\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/g
const TELEGRAM_TOKEN_RE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g
const TELEGRAM_CHANNEL_RE = /\bt\.me\/([A-Za-z0-9_]{4,32})\b/gi
const DISCORD_WEBHOOK_RE =
  /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{16,20}\/[\w-]{20,}\b/gi
const CRYPTO_TERM_RE = /\b(?:cryptonight|xmrig|coinhive|monero|bitcoin|ethereum|stratum\+tcp|stratum\+ssl)\b/gi
const STRATUM_RE = /\bstratum\+(?:tcp|ssl):\/\/[^\s"'`<>]+/gi
const SHELL_PATTERNS = [
  /\b(?:powershell(?:\.exe)?|pwsh)\b[^\n\r;]{0,200}/gi,
  /\bcmd(?:\.exe)?\s+\/[ck][^\n\r;]{0,200}/gi,
  /\b(?:certutil|bitsadmin|mshta|rundll32|regsvr32|schtasks|wmic|curl|wget|chmod|chattr)\b[^\n\r;]{0,200}/gi,
  /\b(?:Invoke-Expression|IEX)\b[^\n\r;]{0,200}/gi,
]
const REGISTRY_KEY_RE =
  /\b(?:HKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG)|HKLM|HKCU|HKCR|HKU|HKCC)\\[^\s"'`<>]+/gi
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"'`<>|*?\r\n]+/g
const UNC_PATH_RE = /\\\\[A-Za-z0-9_.-]+\\[^\s"'`<>|*?\r\n]+/g
const POSIX_PATH_RE = /\/(?:tmp|etc|var|home|root|opt|usr|bin|sbin|dev|proc)\/[^\s"'`<>|*?\r\n]+/g
const MUTEX_RE = /\b(?:Global|Local)\\[A-Za-z0-9_.{}-]{3,}/g
const MUTEX_LITERAL_RE = /(?:CreateMutex[AW]?|mutex)\s*[,:(]?\s*["']([^"'\r\n]{4,})["']/gi

/**
 * @typedef {object} UrlIOC
 * @property {string} value
 * @property {string} scheme
 * @property {string} host
 * @property {string} path
 * @property {'static'|'decoded'|'dynamic'} source
 * @property {number} offset first offset in the scanned text
 * @property {boolean} [benignHost]
 */

/**
 * @typedef {object} DomainIOC
 * @property {string} value
 * @property {number} count
 * @property {number} offset
 * @property {boolean} [suspiciousTld]
 */

/**
 * @typedef {object} SimpleIOC
 * @property {string} value
 * @property {number} count
 * @property {number} offset
 * @property {string} [kind]
 * @property {string} [algo]
 * @property {number} [version]
 */

/**
 * @typedef {object} Base64IOC
 * @property {string} value
 * @property {number} length
 * @property {number} count
 * @property {number} offset
 * @property {string} [decodedPreview]
 * @property {'url'|'script'|'json'|'text'} [decodedKind]
 */

/**
 * @typedef {object} IOCResult
 * @property {UrlIOC[]} urls
 * @property {DomainIOC[]} domains
 * @property {SimpleIOC[]} ips
 * @property {SimpleIOC[]} emails
 * @property {SimpleIOC[]} hashes
 * @property {SimpleIOC[]} wallets
 * @property {Base64IOC[]} base64
 * @property {SimpleIOC[]} telegram
 * @property {SimpleIOC[]} discordWebhooks
 * @property {SimpleIOC[]} crypto
 * @property {SimpleIOC[]} shellCommands
 * @property {SimpleIOC[]} registryKeys
 * @property {SimpleIOC[]} filePaths
 * @property {SimpleIOC[]} mutexes
 * @property {SimpleIOC[]} other
 * @property {{truncated: boolean}} meta
 */

/**
 * Extract indicators from a text sample.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxCandidates] stop after this many regex matches
 * @param {number} [options.maxLength] only scan the first N characters
 * @param {boolean} [options.decodeBase64] decode base64 candidates (one level)
 * @param {string[]} [options.benignHosts] extra benign host suffixes
 * @returns {IOCResult}
 */
export function extractIOCs(text, options = {}) {
  const state = createState(options)
  const result = createCollectors()
  const input = typeof text === 'string' ? text : text == null ? '' : String(text)
  const clipped = input.length > state.settings.maxLength ? input.slice(0, state.settings.maxLength) : input
  if (clipped.length < input.length) state.truncated = true
  if (clipped.length > 0) scanText(result, clipped, state, { source: 'static', depth: 0, offsetBase: null, charCodeDepth: 0 })
  return materialize(result, state)
}

/**
 * Extract indicators observed while running the sample. Only the trace kinds
 * that can carry network or eval indicators are considered, and every URL is
 * reported with `source: 'dynamic'`.
 *
 * @param {object[]} events trace events (see docs/CONTRACTS.md)
 * @param {object} [options] same options as {@link extractIOCs}
 * @returns {IOCResult}
 */
export function extractFromEvents(events, options = {}) {
  const state = createState(options)
  const result = createCollectors()
  if (!Array.isArray(events) || events.length === 0) return materialize(result, state)

  const seen = new Set()
  for (const event of events) {
    if (!event || typeof event !== 'object' || !EVENT_KINDS.has(event.kind)) continue
    if (state.candidates >= state.settings.maxCandidates) {
      state.truncated = true
      break
    }
    const strings = []
    collectStrings(event, strings, 0)
    for (const value of strings) {
      if (value.length < 4 || seen.has(value)) continue
      if (state.candidates >= state.settings.maxCandidates) {
        state.truncated = true
        break
      }
      seen.add(value)
      scanText(result, value, state, { source: 'dynamic', depth: 0, offsetBase: null, charCodeDepth: 0 })
    }
  }
  return materialize(result, state)
}

/**
 * @param {object} options
 */
function createState(options) {
  const maxCandidates = positiveInteger(options.maxCandidates, IOC_LIMITS.maxCandidates)
  const maxLength = positiveInteger(options.maxLength, IOC_LIMITS.maxLength)
  const extraBenign = Array.isArray(options.benignHosts)
    ? options.benignHosts.filter((host) => typeof host === 'string' && host.length > 0)
    : []
  return {
    candidates: 0,
    truncated: false,
    settings: {
      maxCandidates,
      maxLength,
      decodeBase64: options.decodeBase64 !== false,
      benignHosts: [...BENIGN_HOST_SUFFIXES, ...extraBenign].map((host) => host.toLowerCase()),
    },
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/** @returns {object} */
function createCollectors() {
  return {
    urls: new Map(),
    domains: new Map(),
    ips: new Map(),
    emails: new Map(),
    hashes: new Map(),
    wallets: new Map(),
    base64: new Map(),
    telegram: new Map(),
    discordWebhooks: new Map(),
    crypto: new Map(),
    shellCommands: new Map(),
    registryKeys: new Map(),
    filePaths: new Map(),
    mutexes: new Map(),
    other: new Map(),
  }
}

/**
 * Insert or update a value in a collector map.
 * @param {Map<string, object>} map
 * @param {string} value
 * @param {object} [extra]
 */
function add(map, value, extra = {}) {
  if (typeof value !== 'string' || value.length === 0) return
  const existing = map.get(value)
  if (existing) {
    existing.count += 1
    for (const [key, item] of Object.entries(extra)) {
      if (existing[key] === undefined && item !== undefined) existing[key] = item
    }
    return
  }
  map.set(value, { value, count: 1, offset: -1, ...extra })
}

/** @param {object} state */
function takeCandidate(state) {
  if (state.candidates >= state.settings.maxCandidates) {
    state.truncated = true
    return false
  }
  state.candidates += 1
  return true
}

/**
 * Iterate a global regex without depending on its mutable lastIndex.
 * @param {RegExp} regex
 * @param {string} text
 */
function* matches(regex, text) {
  // Clone so nested scans (base64 / fromCharCode recursion) cannot corrupt the
  // iteration state of an outer scan using the same pattern.
  const scanner = new RegExp(regex.source, regex.flags)
  let match = scanner.exec(text)
  while (match) {
    yield match
    if (match[0].length === 0) scanner.lastIndex += 1
    match = scanner.exec(text)
  }
}

/**
 * Scan one text region, writing indicators into the shared collectors.
 *
 * @param {object} result
 * @param {string} rawText
 * @param {object} state
 * @param {{source: string, depth: number, offsetBase: number|null, charCodeDepth: number}} context
 */
function scanText(result, rawText, state, context) {
  const { text, map } = normalizeDefanged(rawText)
  const offsetOf = (index) =>
    context.offsetBase == null ? (map ? (map[index] ?? index) : index) : context.offsetBase

  scanUrls(result, text, state, offsetOf, context.source)
  scanDomains(result, text, state, offsetOf)
  scanIps(result, text, state, offsetOf)
  scanEmails(result, text, state, offsetOf)
  scanHashes(result, text, state, offsetOf)
  scanWallets(result, text, state, offsetOf)
  scanTelegram(result, text, state, offsetOf)
  scanDiscordWebhooks(result, text, state, offsetOf)
  scanCrypto(result, text, state, offsetOf)
  scanShellCommands(result, text, state, offsetOf)
  scanRegistryKeys(result, text, state, offsetOf)
  scanFilePaths(result, text, state, offsetOf)
  scanMutexes(result, text, state, offsetOf)
  scanFromCharCode(result, text, state, offsetOf, context)

  if (context.depth > 0) return
  scanBase64(result, text, state, offsetOf, context)
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 * @param {string} source
 */
function scanUrls(result, text, state, offsetOf, source) {
  for (const match of matches(URL_RE, text)) {
    if (!takeCandidate(state)) return
    const value = stripUrlTrailing(match[0])
    if (value.length === 0) continue
    const record = describeUrl(value, offsetOf(match.index), source, state.settings.benignHosts)
    add(result.urls, value, record)
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanDomains(result, text, state, offsetOf) {
  // One quote/comment mask per scanned text: a domain is only credible inside a
  // string literal, comment, URL context, or as a standalone token. This is what
  // separates `"c2.example.test"` from `window.top` / `document.body.style`.
  const literalMask = buildLiteralMask(text)
  for (const match of matches(DOMAIN_RE, text)) {
    if (!takeCandidate(state)) return
    const value = match[0].toLowerCase()
    if (isBenignHost(value, state.settings.benignHosts)) continue
    const tld = value.slice(value.lastIndexOf('.') + 1)
    if (NON_TLD.has(tld) || MEMBER_TOKENS.has(tld)) continue
    const firstLabel = value.slice(0, value.indexOf('.'))
    if (JS_OBJECT_HEADS.has(firstLabel)) continue
    if (text[match.index + match[0].length] === '(') continue
    if (match.index > 0 && /[A-Za-z0-9_$.\])]/.test(text[match.index - 1])) continue
    const inLiteral = literalMask[match.index] === 1
    const urlContext = /(?:\/\/|@)$/.test(text.slice(Math.max(0, match.index - 3), match.index))
    const standalone =
      text.slice(0, match.index).trim() === '' &&
      /^(?:\s|$)/.test(text.slice(match.index + match[0].length, match.index + match[0].length + 1))
    if (!inLiteral && !urlContext && !standalone) continue
    const record = { offset: offsetOf(match.index) }
    if (isSuspiciousTld(value)) record.suspiciousTld = true
    add(result.domains, value, record)
  }
}

/**
 * Mark positions that are inside a string literal, template literal, line
 * comment or block comment. Domain extraction uses it to reject member-access
 * chains (`window.top`, `rect.top`) that the regex would otherwise see as hosts.
 * @param {string} text
 * @returns {Uint8Array}
 */
function buildLiteralMask(text) {
  const mask = new Uint8Array(text.length)
  let quote = ''
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (quote) {
      mask[index] = 1
      if (character === '\\') {
        if (index + 1 < text.length) mask[index + 1] = 1
        index += 2
        continue
      }
      if (character === quote) quote = ''
      index += 1
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      mask[index] = 1
      index += 1
      continue
    }
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index)
      const end = newline < 0 ? text.length : newline
      mask.fill(1, index, end)
      index = end
      continue
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      const end = close < 0 ? text.length : close + 2
      mask.fill(1, index, end)
      index = end
      continue
    }
    index += 1
  }
  return mask
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanIps(result, text, state, offsetOf) {
  for (const match of matches(IPV4_RE, text)) {
    if (!takeCandidate(state)) return
    if (isIP(match[0]) !== 4) continue
    add(result.ips, match[0], { version: 4, offset: offsetOf(match.index) })
  }
  for (const match of matches(IPV6_RE, text)) {
    if (!takeCandidate(state)) return
    const value = match[0].toLowerCase()
    if (isIP(value) !== 6) continue
    add(result.ips, value, { version: 6, offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanEmails(result, text, state, offsetOf) {
  for (const match of matches(EMAIL_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.emails, match[0], { offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanHashes(result, text, state, offsetOf) {
  for (const match of matches(HASH_RE, text)) {
    if (!takeCandidate(state)) return
    const value = match[1].toLowerCase()
    const index = match.index + match[0].indexOf(match[1])
    // An Ethereum address is 40 hex characters; it is a wallet, not a SHA-1.
    if (text.slice(Math.max(0, index - 2), index).toLowerCase() === '0x') continue
    add(result.hashes, value, { algo: hashAlgorithm(value.length), offset: offsetOf(index) })
  }
}

/** @param {number} length */
function hashAlgorithm(length) {
  if (length === 32) return 'md5'
  if (length === 40) return 'sha1'
  if (length === 64) return 'sha256'
  return 'sha512'
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanWallets(result, text, state, offsetOf) {
  for (const match of matches(BTC_RE, text)) {
    if (!takeCandidate(state)) return
    const value = match[0]
    if (!isValidBitcoinAddress(value)) continue
    add(result.wallets, value, { kind: 'btc', offset: offsetOf(match.index) })
  }
  for (const match of matches(ETH_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.wallets, match[0], { kind: 'eth', offset: offsetOf(match.index) })
  }
  for (const match of matches(XMR_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.wallets, match[0], { kind: 'xmr', offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanTelegram(result, text, state, offsetOf) {
  for (const match of matches(TELEGRAM_TOKEN_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.telegram, match[0], { kind: 'bot-token', offset: offsetOf(match.index) })
  }
  for (const match of matches(TELEGRAM_CHANNEL_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.telegram, `t.me/${match[1]}`, { kind: 'channel', offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanDiscordWebhooks(result, text, state, offsetOf) {
  for (const match of matches(DISCORD_WEBHOOK_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.discordWebhooks, match[0], { offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanCrypto(result, text, state, offsetOf) {
  for (const match of matches(STRATUM_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.crypto, match[0], { kind: 'mining-pool', offset: offsetOf(match.index) })
  }
  for (const match of matches(CRYPTO_TERM_RE, text)) {
    if (!takeCandidate(state)) return
    const value = match[0].toLowerCase()
    const insidePool = [...result.crypto.values()].some(
      (record) => record.kind === 'mining-pool' && record.value.includes(value),
    )
    if (insidePool) continue
    add(result.crypto, value, { kind: 'crypto-term', offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanShellCommands(result, text, state, offsetOf) {
  for (const pattern of SHELL_PATTERNS) {
    for (const match of matches(pattern, text)) {
      if (!takeCandidate(state)) return
      const value = match[0].trim().slice(0, 200)
      if (value.length > 0) add(result.shellCommands, value, { offset: offsetOf(match.index) })
    }
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanRegistryKeys(result, text, state, offsetOf) {
  for (const match of matches(REGISTRY_KEY_RE, text)) {
    if (!takeCandidate(state)) return
    const value = collapseBackslashes(match[0])
    add(result.registryKeys, value, { offset: offsetOf(match.index) })
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanFilePaths(result, text, state, offsetOf) {
  for (const pattern of [WINDOWS_PATH_RE, UNC_PATH_RE, POSIX_PATH_RE]) {
    for (const match of matches(pattern, text)) {
      if (!takeCandidate(state)) return
      const value = collapseBackslashes(match[0])
      add(result.filePaths, value, { offset: offsetOf(match.index) })
    }
  }
}

/**
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 */
function scanMutexes(result, text, state, offsetOf) {
  for (const match of matches(MUTEX_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.mutexes, collapseBackslashes(match[0]), { offset: offsetOf(match.index) })
  }
  for (const match of matches(MUTEX_LITERAL_RE, text)) {
    if (!takeCandidate(state)) return
    add(result.mutexes, match[1], { offset: offsetOf(match.index) })
  }
}

/**
 * Decode literal `String.fromCharCode` sequences and scan their output.
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 * @param {{source: string, depth: number, charCodeDepth: number}} context
 */
function scanFromCharCode(result, text, state, offsetOf, context) {
  for (const match of matches(FROM_CHAR_CODE_RE, text)) {
    if (!takeCandidate(state)) return
    const args = match[1] ?? match[2] ?? ''
    const decoded = decodeCharCodes(args)
    if (!decoded) continue
    add(result.other, decoded.slice(0, 200), { kind: 'fromCharCode', offset: offsetOf(match.index) })
    if (context.charCodeDepth >= 1) continue
    scanText(result, decoded, state, {
      source: 'decoded',
      depth: context.depth + 1,
      offsetBase: offsetOf(match.index),
      charCodeDepth: context.charCodeDepth + 1,
    })
  }
}

/**
 * @param {string} args
 * @returns {string|null}
 */
/** Above this many numeric tokens a fromCharCode chain is hostile bulk, not a decodable string. */
const MAX_CHAR_CODE_TOKENS = 10_000

function decodeCharCodes(args) {
  const tokens = args.match(/0x[0-9a-f]+|\d+/gi)
  if (!tokens || tokens.length === 0) return null
  if (tokens.length > MAX_CHAR_CODE_TOKENS) return null
  let out = ''
  for (const token of tokens) {
    const code = Number.parseInt(token, token.toLowerCase().startsWith('0x') ? 16 : 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null
    out += String.fromCodePoint(code)
  }
  return out.length > 0 ? out : null
}

/**
 * Detect and decode base64 candidates, then merge indicators from the decoded
 * text. Recursion is limited to this single level.
 * @param {object} result
 * @param {string} text
 * @param {object} state
 * @param {(index: number) => number} offsetOf
 * @param {{source: string, depth: number, charCodeDepth: number}} context
 */
function scanBase64(result, text, state, offsetOf, context) {
  for (const match of matches(BASE64_RE, text)) {
    if (!takeCandidate(state)) return
    const value = match[0]
    if (value.length < 16) continue
    if (/^[0-9a-f]+$/i.test(value)) continue
    if (isCoveredByHigherConfidence(value, result)) continue
    const offset = offsetOf(match.index)
    const record = { value, length: value.length, offset }
    const decoded = state.settings.decodeBase64 ? decodeBase64Text(value) : null
    if (!decoded && !/[+/=]/.test(value)) continue
    if (decoded) {
      record.decodedPreview = decoded.preview
      record.decodedKind = decoded.kind
    }
    add(result.base64, value, record)
    if (!decoded) continue
    scanText(result, decoded.text, state, {
      source: 'decoded',
      depth: context.depth + 1,
      offsetBase: offset,
      charCodeDepth: context.charCodeDepth,
    })
  }
}

/**
 * A base64 candidate that is only a slice of an address, token or URL already
 * extracted by a higher-confidence pattern is noise, not a payload.
 * @param {string} value
 * @param {object} result
 */
function isCoveredByHigherConfidence(value, result) {
  const maps = [result.urls, result.hashes, result.wallets, result.telegram, result.discordWebhooks, result.emails]
  for (const map of maps) {
    for (const known of map.keys()) {
      if (known.length > value.length && known.includes(value)) return true
    }
  }
  return false
}

/**
 * @param {string} value
 * @returns {{text: string, preview: string, kind: 'url'|'script'|'json'|'text'}|null}
 */
function decodeBase64Text(value) {
  let buffer
  try {
    buffer = Buffer.from(value, 'base64')
  } catch {
    return null
  }
  if (buffer.length < 4) return null
  if (printableRatio(buffer) < 0.85) return null
  const text = buffer.toString('utf8')
  if (text.length === 0) return null
  const preview = text.replace(/[^\x20-\x7E]/g, '.').slice(0, 120)
  return { text, preview, kind: classifyDecoded(text) }
}

/**
 * @param {Buffer} buffer
 */
function printableRatio(buffer) {
  let printable = 0
  for (const byte of buffer) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable += 1
  }
  return buffer.length === 0 ? 0 : printable / buffer.length
}

/**
 * @param {string} text
 * @returns {'url'|'script'|'json'|'text'}
 */
function classifyDecoded(text) {
  if (/https?:\/\//i.test(text)) return 'url'
  if (/\b(?:function|var|let|const|document\.|window\.|eval\s*\()/i.test(text)) return 'script'
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      /* not JSON */
    }
  }
  return 'text'
}

/**
 * Normalise defanged notation while keeping a map back to original offsets.
 * @param {string} input
 * @returns {{text: string, map: number[]|null}}
 */
function normalizeDefanged(input) {
  if (!DEFANG_HINT_RE.test(input)) return { text: input, map: null }
  const tokens = [
    ['[.]', '.'],
    ['(.)', '.'],
    ['{.}', '.'],
    ['[dot]', '.'],
    ['(dot)', '.'],
    ['{dot}', '.'],
    ['[:]', ':'],
    ['[/]', '/'],
    ['[@]', '@'],
    ['[at]', '@'],
    ['hxxps', 'https'],
    ['hxxp', 'http'],
  ]
  let text = ''
  const map = []
  let index = 0
  while (index < input.length) {
    let replaced = false
    for (const [token, replacement] of tokens) {
      const candidate = input.slice(index, index + token.length)
      if (candidate.toLowerCase() !== token) continue
      // `hxxp` is a word prefix; do not rewrite it inside an identifier.
      if (token.startsWith('hxxp') && index > 0 && /[A-Za-z0-9_]/.test(input[index - 1])) continue
      for (let offset = 0; offset < replacement.length; offset += 1) {
        text += replacement[offset]
        map.push(token.length === replacement.length ? index + offset : index)
      }
      index += token.length
      replaced = true
      break
    }
    if (!replaced) {
      text += input[index]
      map.push(index)
      index += 1
    }
  }
  return { text, map }
}

/**
 * @param {string} value
 * @param {number} offset
 * @param {string} source
 * @param {string[]} benignHosts
 */
function describeUrl(value, offset, source, benignHosts) {
  const parsed = parseUrl(value)
  const record = {
    value,
    scheme: parsed.scheme,
    host: parsed.host,
    path: parsed.path,
    source,
    offset,
  }
  if (isBenignHost(parsed.host, benignHosts)) record.benignHost = true
  return record
}

/**
 * @param {string} value
 * @returns {{scheme: string, host: string, path: string}}
 */
function parseUrl(value) {
  try {
    const url = new URL(value)
    return {
      scheme: url.protocol.replace(/:$/, '').toLowerCase(),
      host: url.hostname.toLowerCase(),
      path: `${url.pathname}${url.search}${url.hash}`,
    }
  } catch {
    const separator = value.indexOf('://')
    const scheme = separator === -1 ? '' : value.slice(0, separator).toLowerCase()
    const rest = separator === -1 ? value : value.slice(separator + 3)
    const boundary = rest.search(/[/?#]/)
    const authority = boundary === -1 ? rest : rest.slice(0, boundary)
    const path = boundary === -1 ? '/' : rest.slice(boundary)
    const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase()
    return { scheme, host, path }
  }
}

/**
 * @param {string} value
 */
function stripUrlTrailing(value) {
  return value.replace(/[.,;:!?)\]}>]+$/, '')
}

/**
 * @param {string} host
 * @param {string[]} benignHosts
 */
function isBenignHost(host, benignHosts) {
  if (!host) return false
  const lower = host.toLowerCase()
  return benignHosts.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))
}

/** @param {string} domain */
function isSuspiciousTld(domain) {
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  return SUSPICIOUS_TLDS.has(tld)
}

/**
 * @param {string} value
 */
function collapseBackslashes(value) {
  return value.replace(/\\\\/g, '\\')
}

/** Base58 alphabet for Bitcoin address checksum validation. */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Validate legacy Bitcoin addresses with Base58Check. Bech32 addresses are
 * accepted on shape alone because mixed-case rules make a full check noisy for
 * an IOC extractor.
 * @param {string} value
 */
function isValidBitcoinAddress(value) {
  if (value.toLowerCase().startsWith('bc1')) return true
  const bytes = decodeBase58(value)
  if (!bytes || bytes.length !== 25) return false
  const payload = bytes.subarray(0, 21)
  const checksum = bytes.subarray(21)
  const digest = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest()
  return checksum[0] === digest[0] && checksum[1] === digest[1] && checksum[2] === digest[2] && checksum[3] === digest[3]
}

/**
 * @param {string} value
 * @returns {Uint8Array|null}
 */
function decodeBase58(value) {
  let number = 0n
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit === -1) return null
    number = number * 58n + BigInt(digit)
  }
  const bytes = []
  while (number > 0n) {
    bytes.unshift(Number(number % 256n))
    number /= 256n
  }
  for (const char of value) {
    if (char !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

/**
 * Collect string leaves from a trace event, bounded in depth and count.
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 */
function collectStrings(value, out, depth) {
  if (out.length >= 200 || depth > 4) return
  if (typeof value === 'string') {
    if (value.length <= 8192) out.push(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'stack') continue
    collectStrings(item, out, depth + 1)
  }
}

/**
 * @param {object} result
 * @param {object} state
 * @returns {IOCResult}
 */
function materialize(result, state) {
  return {
    urls: [...result.urls.values()].map((record) => {
      const url = {
        value: record.value,
        scheme: record.scheme,
        host: record.host,
        path: record.path,
        source: record.source,
        offset: record.offset,
      }
      if (record.benignHost) url.benignHost = true
      return url
    }),
    domains: [...result.domains.values()].map((record) => {
      const domain = { value: record.value, count: record.count, offset: record.offset }
      if (record.suspiciousTld) domain.suspiciousTld = true
      return domain
    }),
    ips: [...result.ips.values()],
    emails: [...result.emails.values()],
    hashes: [...result.hashes.values()],
    wallets: [...result.wallets.values()],
    base64: [...result.base64.values()].map((record) => {
      const item = {
        value: record.value,
        length: record.length,
        count: record.count,
        offset: record.offset,
      }
      if (record.decodedPreview) item.decodedPreview = record.decodedPreview
      if (record.decodedKind) item.decodedKind = record.decodedKind
      return item
    }),
    telegram: [...result.telegram.values()],
    discordWebhooks: [...result.discordWebhooks.values()],
    crypto: [...result.crypto.values()],
    shellCommands: [...result.shellCommands.values()],
    registryKeys: [...result.registryKeys.values()],
    filePaths: [...result.filePaths.values()],
    mutexes: [...result.mutexes.values()],
    other: [...result.other.values()],
    meta: { truncated: state.truncated },
  }
}
