import { parse } from '../restore/parse.js'
import { traverse } from '../util/babel.js'

/**
 * AST-level instrumentation and static analysis.
 *
 * This module is intentionally separate from `code.js`: `code.js` splices text
 * into the executed source (traceless runtime tracing), while this module walks
 * the AST to (a) emit `ast:*` hook phases for plugins, (b) produce the static
 * facts used by the report and the verdict, and (c) expose a visitor API other
 * modules (JSVMP detection, restoration) can reuse.
 */

const OBVIOUS_OBFUSCATION_PATTERNS = [
  { id: 'hex-identifiers', test: (facts) => facts.hexIdentifiers >= 10, weight: 18, detail: 'many _0x-style identifiers' },
  { id: 'string-array', test: (facts) => facts.stringArrayDeclarations >= 1, weight: 16, detail: 'string array with rotation/lookup' },
  { id: 'charcode-decode', test: (facts) => facts.charcodeCalls >= 3, weight: 12, detail: 'String.fromCharCode decoding' },
  { id: 'base64-decode', test: (facts) => facts.atobCalls >= 1, weight: 10, detail: 'atob/base64 decoding' },
  { id: 'jsfuck', test: (facts) => facts.jsfuckOperators >= 10, weight: 20, detail: 'JSFuck-style bracket/plus expressions' },
  { id: 'control-flow-switch', test: (facts) => facts.dispatchSwitches >= 1, weight: 18, detail: 'switch-based control-flow flattening or JSVMP dispatch' },
  { id: 'eval-chain', test: (facts) => facts.evalLike >= 2, weight: 16, detail: 'multiple eval/Function layers' },
  { id: 'unicode-escapes', test: (facts) => facts.unicodeEscapes >= 20, weight: 8, detail: 'heavy unicode escaping' },
  { id: 'long-string-blobs', test: (facts) => facts.longStringBlobs >= 1, weight: 10, detail: 'embedded encoded payload blob' },
  { id: 'debugger-probes', test: (facts) => facts.debuggerStatements >= 1, weight: 8, detail: 'debugger statements' },
]

const SENSITIVE_APIS = new Map([
  ['document.cookie', 'cookie-access'],
  ['localStorage.setItem', 'storage-write'],
  ['localStorage.getItem', 'storage-read'],
  ['indexedDB', 'indexeddb'],
  ['XMLHttpRequest', 'network'],
  ['fetch', 'network'],
  ['WebSocket', 'network'],
  ['navigator.sendBeacon', 'network'],
  ['eval', 'dynamic-code'],
  ['Function', 'dynamic-code'],
  ['atob', 'encoding'],
  ['btoa', 'encoding'],
  ['String.fromCharCode', 'encoding'],
  ['crypto.subtle', 'crypto'],
  ['crypto.getRandomValues', 'crypto'],
  ['clipboard.writeText', 'clipboard'],
  ['clipboard.readText', 'clipboard'],
  ['navigator.geolocation', 'geolocation'],
  ['getUserMedia', 'media-capture'],
  ['MediaRecorder', 'media-capture'],
  ['keydown', 'keylogging'],
  ['keyup', 'keylogging'],
  ['keypress', 'keylogging'],
  ['innerHTML', 'dom-injection'],
  ['insertAdjacentHTML', 'dom-injection'],
  ['document.write', 'dom-injection'],
  ['WebAssembly', 'wasm'],
  ['Worker', 'worker'],
  ['ServiceWorker', 'service-worker'],
  ['Notification', 'notification'],
])

/**
 * Static analysis of a source text.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {object} [options.hooks] hook bus (fires ast:enter/ast:exit/ast:node)
 * @param {object} [options.trace]
 * @param {string} [options.filename]
 * @param {number} [options.maxStrings] cap on string literal collection
 * @returns {{ok: boolean, facts: object, ast?: object, error?: string}}
 */
export function analyzeSource(source, options = {}) {
  const { hooks, trace, filename = 'sample.js', maxStrings = 2000 } = options
  let parsed
  try {
    parsed = parse(source, { sourceType: 'script', errorRecovery: false, filename })
  } catch (error) {
    return { ok: false, error: error.message, facts: emptyFacts() }
  }

  const facts = emptyFacts()
  facts.parse = { sourceType: parsed.sourceType, errors: parsed.errors?.length ?? 0 }
  facts.bytes = source.length
  facts.lines = source.split('\n').length
  const strings = []
  const identifiers = new Map()
  const callNames = new Map()
  const memberPaths = new Map()
  const domains = new Map()
  let jsfuckScore = 0
  let cryptoWalletLike = 0
  let stringCount = 0

  const bump = (map, key, amount = 1) => map.set(key, (map.get(key) ?? 0) + amount)
  const onExit = hooks
    ? (node) => hooks.emit('ast:exit', { type: node.type, line: node.loc?.start.line })
    : null

  traverse(parsed.ast, {
    enter(path) {
      const node = path.node
      if (hooks) {
        hooks.emit('ast:enter', {
          type: node.type,
          name: node.type === 'Identifier' ? node.name : undefined,
          line: node.loc?.start.line,
          column: node.loc?.start.column,
        })
      }

      switch (node.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ObjectMethod':
        case 'ClassMethod':
          facts.functions += 1
          if (node.async) facts.asyncFunctions += 1
          if (node.generator) facts.generatorFunctions += 1
          break
        case 'StringLiteral':
          stringCount += 1
          if (strings.length < maxStrings) strings.push(node.value)
          if (node.value.length >= 2048) facts.longStringBlobs += 1
          if (/\\x[0-9a-f]{2}/i.test(source.slice(node.start, node.end))) facts.hexEscapes += 1
          if (/\\u[0-9a-f]{4}/i.test(node.extra?.raw ?? source.slice(node.start, node.end))) facts.unicodeEscapes += 1
          extractDomains(node.value, domains)
          if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^0x[a-fA-F0-9]{40}$/.test(node.value)) cryptoWalletLike += 1
          break
        case 'TemplateLiteral':
          stringCount += node.quasis.length
          for (const quasi of node.quasis) extractDomains(quasi.value.cooked ?? '', domains)
          break
        case 'RegExpLiteral':
          facts.regexps += 1
          break
        case 'Identifier':
          bump(identifiers, node.name)
          if (/^_0x[0-9a-f]+$/i.test(node.name)) facts.hexIdentifiers += 1
          break
        case 'MemberExpression':
          facts.memberAccesses += 1
          bump(memberPaths, memberPathOf(node))
          break
        case 'CallExpression':
          facts.calls += 1
          if (node.callee.type === 'Identifier') bump(callNames, node.callee.name)
          else bump(callNames, memberPathOf(node.callee))
          classifyCall(node, facts)
          break
        case 'NewExpression':
          facts.calls += 1
          if (node.callee.type === 'Identifier') bump(callNames, `new ${node.callee.name}`)
          classifyCall(node, facts)
          break
        case 'SwitchStatement':
          if (node.cases.length >= 5) facts.dispatchSwitches += 1
          break
        case 'ArrayExpression':
          if (node.elements.length >= 8 && node.elements.every((element) => element?.type === 'StringLiteral')) {
            facts.stringArrayDeclarations += 1
          }
          break
        case 'AssignmentExpression':
          if (
            node.left?.type === 'MemberExpression' &&
            node.left.property &&
            (node.left.property.name === 'innerHTML' || node.left.property.name === 'outerHTML')
          ) {
            facts.domInjection = (facts.domInjection ?? 0) + 1
          }
          break
        case 'DebuggerStatement':
          facts.debuggerStatements += 1
          break
        case 'UnaryExpression':
          if (node.operator === '!') jsfuckScore += 0.5
          if (node.operator === '+' && node.argument?.type === 'ArrayExpression') jsfuckScore += 1
          break
        case 'BinaryExpression':
          if (node.operator === '+' && node.left?.type === 'ArrayExpression') jsfuckScore += 1
          break
        case 'WithStatement':
          facts.withStatements += 1
          break
        case 'AwaitExpression':
          facts.awaits += 1
          break
        default:
          break
      }
      if (hooks) hooks.emit('ast:node', { type: node.type, line: node.loc?.start.line })
    },
    exit(path) {
      if (onExit) onExit(path.node)
    },
  })

  facts.jsfuckOperators = Math.round(jsfuckScore)
  facts.uniqueIdentifiers = identifiers.size
  facts.identifiers = topEntries(identifiers, 30)
  facts.calls = Math.max(facts.calls, [...callNames.values()].reduce((a, b) => a + b, 0))
  facts.apiCalls = topEntries(callNames, 40)
  facts.memberPaths = topEntries(memberPaths, 40)
  facts.stringsTotal = stringCount
  facts.uniqueStrings = new Set(strings).size
  facts.strings = strings.slice(0, 200)
  facts.domains = [...domains.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([value, count]) => ({ value, count }))
  facts.walletLikeStrings = cryptoWalletLike
  facts.techniques = detectTechniques(facts)
  facts.obfuscation = scoreObfuscation(facts)
  return { ok: true, facts, ast: parsed.ast, sourceType: parsed.sourceType }
}

/**
 * Score obfuscation from static facts (0-100) with named indicators.
 * @param {object} facts
 */
export function scoreObfuscation(facts) {
  const indicators = []
  let score = 0
  for (const pattern of OBVIOUS_OBFUSCATION_PATTERNS) {
    if (pattern.test(facts)) {
      score += pattern.weight
      indicators.push({ id: pattern.id, weight: pattern.weight, detail: pattern.detail })
    }
  }
  const identifierEntropy = facts.hexIdentifiers / Math.max(1, facts.uniqueIdentifiers)
  if (identifierEntropy > 0.3) {
    score += 10
    indicators.push({ id: 'identifier-entropy', weight: 10, detail: 'majority obfuscated identifiers' })
  }
  return { score: Math.min(100, score), indicators }
}

/**
 * Behavioural technique labels from static facts.
 * @param {object} facts
 */
export function detectTechniques(facts) {
  const techniques = new Set()
  if (facts.evalLike > 0) techniques.add('dynamic-code-execution')
  if (facts.atobCalls > 0 || facts.charcodeCalls > 0) techniques.add('encoded-string-decoding')
  if (facts.stringArrayDeclarations > 0) techniques.add('string-array-obfuscation')
  if (facts.dispatchSwitches > 0) techniques.add('control-flow-dispatch')
  if (facts.debuggerStatements > 0) techniques.add('anti-debugging')
  if (facts.fetchCalls || facts.xhrCalls || facts.websocketCalls) techniques.add('network-communication')
  if (facts.cookieAccesses) techniques.add('cookie-access')
  if (facts.storageWrites || facts.storageReads) techniques.add('web-storage')
  if (facts.domInjection) techniques.add('dom-injection')
  if (facts.keyEventListeners) techniques.add('keylogging')
  if (facts.clipboardCalls) techniques.add('clipboard-access')
  if (facts.cryptoSubtleCalls || facts.getRandomValuesCalls) techniques.add('cryptography')
  if (facts.walletLikeStrings > 0) techniques.add('cryptocurrency-targeting')
  if (facts.withStatements > 0) techniques.add('with-scope-evasion')
  if (facts.longStringBlobs > 0) techniques.add('embedded-payload')
  if (facts.wasmReferences) techniques.add('webassembly')
  if (facts.workerReferences) techniques.add('worker-thread')
  if (facts.serviceWorkerReferences) techniques.add('service-worker')
  return [...techniques].sort()
}

function classifyCall(node, facts) {
  const name = node.callee.type === 'Identifier' ? node.callee.name : memberPathOf(node.callee)
  if (name === 'eval') facts.evalLike += 1
  if (name === 'Function') facts.evalLike += 1
  if (name === 'setTimeout' || name === 'setInterval') {
    facts.timers += 1
    if (node.arguments[0]?.type === 'StringLiteral') facts.stringTimerCallbacks += 1
  }
  if (name === 'atob' || name === 'unescape' || name === 'decodeURIComponent') facts.atobCalls += 1
  if (name === 'String.fromCharCode' || name === 'fromCharCode') facts.charcodeCalls += 1
  if (name === 'fetch') facts.fetchCalls = (facts.fetchCalls ?? 0) + 1
  if (name === 'XMLHttpRequest' || name === 'new XMLHttpRequest') facts.xhrCalls = (facts.xhrCalls ?? 0) + 1
  if (name === 'WebSocket' || name === 'new WebSocket') facts.websocketCalls = (facts.websocketCalls ?? 0) + 1
  if (
    /(?:document\.)?(?:write|writeln|insertAdjacentHTML|createElement|appendChild|insertBefore|replaceChild)$/.test(name)
  ) {
    facts.domInjection = (facts.domInjection ?? 0) + 1
  }
  if (/^document\.cookie/.test(name) || /cookie/.test(name)) facts.cookieAccesses = (facts.cookieAccesses ?? 0) + 1
  if (/localStorage\.(setItem|clear)/.test(name)) facts.storageWrites = (facts.storageWrites ?? 0) + 1
  if (/localStorage\.(getItem|key)/.test(name)) facts.storageReads = (facts.storageReads ?? 0) + 1
  if (/clipboard\./.test(name)) facts.clipboardCalls = (facts.clipboardCalls ?? 0) + 1
  if (/crypto\.subtle/.test(name)) facts.cryptoSubtleCalls = (facts.cryptoSubtleCalls ?? 0) + 1
  if (/crypto\.getRandomValues/.test(name)) facts.getRandomValuesCalls = (facts.getRandomValuesCalls ?? 0) + 1
  if (/serviceWorker\.(?:register|getRegistrations|ready)/.test(name)) facts.serviceWorkerReferences = (facts.serviceWorkerReferences ?? 0) + 1
  if (/addEventListener/.test(name)) {
    const event = node.arguments[0]?.value
    if (typeof event === 'string' && /^key/.test(event)) facts.keyEventListeners = (facts.keyEventListeners ?? 0) + 1
  }
  if (name === 'new WebAssembly' || name.startsWith('WebAssembly.') || name.startsWith('new WebAssembly')) {
    facts.wasmReferences = (facts.wasmReferences ?? 0) + 1
  }
  if (name === 'new Worker' || name === 'Worker') facts.workerReferences = (facts.workerReferences ?? 0) + 1
  if (SENSITIVE_APIS.has(name)) {
    const category = SENSITIVE_APIS.get(name)
    facts.sensitiveApis = facts.sensitiveApis ?? {}
    facts.sensitiveApis[category] = (facts.sensitiveApis[category] ?? 0) + 1
  }
}

function memberPathOf(node) {
  if (!node) return ''
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'MemberExpression') {
    const object = memberPathOf(node.object)
    const property = node.computed
      ? node.property?.type === 'StringLiteral'
        ? node.property.value
        : '[]'
      : node.property?.name ?? ''
    return object ? `${object}.${property}` : property
  }
  if (node.type === 'CallExpression') return `${memberPathOf(node.callee)}()`
  if (node.type === 'NewExpression') return `new ${memberPathOf(node.callee)}`
  return node.type
}

function extractDomains(text, domains) {
  const pattern = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,24})\b/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    const host = match[1].toLowerCase()
    domains.set(host, (domains.get(host) ?? 0) + 1)
  }
}

function topEntries(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

function emptyFacts() {
  return {
    functions: 0,
    asyncFunctions: 0,
    generatorFunctions: 0,
    strings: [],
    stringsTotal: 0,
    uniqueStrings: 0,
    regexps: 0,
    memberAccesses: 0,
    calls: 0,
    hexIdentifiers: 0,
    uniqueIdentifiers: 0,
    unicodeEscapes: 0,
    hexEscapes: 0,
    stringArrayDeclarations: 0,
    dispatchSwitches: 0,
    charcodeCalls: 0,
    atobCalls: 0,
    evalLike: 0,
    timers: 0,
    stringTimerCallbacks: 0,
    jsfuckOperators: 0,
    longStringBlobs: 0,
    debuggerStatements: 0,
    withStatements: 0,
    awaits: 0,
    walletLikeStrings: 0,
    domains: [],
  }
}

/**
 * Reusable AST walk with hook emission, for callers that already have an AST.
 * @param {object} ast
 * @param {{enter?: Function, exit?: Function}} visitor
 */
export function walkAst(ast, visitor = {}) {
  traverse(ast, {
    enter(path) {
      visitor.enter?.(path)
    },
    exit(path) {
      visitor.exit?.(path)
    },
  })
}
