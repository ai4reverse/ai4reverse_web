/**
 * Rule compilation: Sigma-style YAML -> predicate over normalised observations.
 *
 * A rule is split into `detection.<selection>` maps and one boolean
 * `condition`. Selections compile to field tests; the condition compiles to a
 * small AST over selection names (`and`, `or`, `not`, parentheses,
 * `1 of selection*`, `all of them`). Compilation is strict: unknown fields,
 * missing selections and malformed expressions fail loudly at load time, never
 * at query time.
 */

import { parseYaml, parseYamlDocuments } from './yaml.js'

/** Every field a rule may select on, with the observation layer it comes from. */
export const FIELDS = Object.freeze({
  layer: 'static | dynamic | ioc | technique | artifact | verdict | behavior',
  kind: 'event kind, e.g. net, api, storage, dom, code, ioc',
  action: 'event name or observation action, e.g. net.request, eval',
  api: 'browser API name observed or referenced',
  url: 'absolute URL indicator or request URL',
  host: 'host component of a URL indicator',
  domain: 'registrable domain of an indicator',
  path: 'path component of a URL indicator',
  value: 'primary value of the observation (indicator string, verdict level, …)',
  technique: 'behaviour technique id from the static analyser',
  category: 'indicator category, e.g. urls, wallets, telegram',
  artifact: 'captured artifact kind',
  stage: 'kill-chain stage label',
  seq: 'dynamic trace sequence number',
  offset: 'byte offset of a static indicator',
  count: 'occurrence count or numeric weight',
  score: 'verdict score (verdict layer only)',
  confidence: 'verdict confidence (verdict layer only)',
  suspiciousTld: 'true when an indicator domain uses a high-abuse TLD',
  text: 'lower-cased haystack of every textual field on the observation',
})

const STRING_MODIFIERS = new Set(['contains', 'startswith', 'endswith', 're'])
const NUMERIC_MODIFIERS = new Set(['gt', 'gte', 'lt', 'lte'])
const MODIFIERS = new Set(['all', 'neq', ...STRING_MODIFIERS, ...NUMERIC_MODIFIERS])

const RULE_LEVELS = new Set(['informational', 'low', 'medium', 'high', 'critical'])

/** Field lookup; `text` is the composite haystack built during normalisation. */
function resolveField(observation, field) {
  if (field === 'text') return observation.text
  return observation[field]
}

function compareNumber(actual, expected, modifier) {
  switch (modifier) {
    case 'gt':
      return actual > expected
    case 'gte':
      return actual >= expected
    case 'lt':
      return actual < expected
    case 'lte':
      return actual <= expected
    default:
      return actual === expected
  }
}

/** Match one expected value against one field value under the given modifiers. */
function matchOne(actual, expected, modifier, compiled) {
  if (actual === undefined || actual === null) return false
  if (modifier === 're') return compiled.test(String(actual))
  if (modifier === 'contains') return String(actual).toLowerCase().includes(String(expected).toLowerCase())
  if (modifier === 'startswith') return String(actual).toLowerCase().startsWith(String(expected).toLowerCase())
  if (modifier === 'endswith') return String(actual).toLowerCase().endsWith(String(expected).toLowerCase())
  if (typeof expected === 'number') {
    const numeric = Number(actual)
    return Number.isFinite(numeric) ? compareNumber(numeric, expected, modifier) : false
  }
  if (typeof expected === 'boolean') return actual === expected
  const left = String(actual).toLowerCase()
  const right = String(expected).toLowerCase()
  return modifier === 'neq' ? left !== right : left === right
}

function compileTest(selectionName, rawKey, expected) {
  const [field, ...modifiers] = rawKey.split('|')
  if (!Object.hasOwn(FIELDS, field)) {
    throw new Error(`selection "${selectionName}" selects unknown field "${field}" (known: ${Object.keys(FIELDS).join(', ')})`)
  }
  for (const modifier of modifiers) {
    if (!MODIFIERS.has(modifier)) throw new Error(`selection "${selectionName}" uses unknown modifier "${modifier}"`)
  }
  const values = Array.isArray(expected) ? expected : [expected]
  if (values.length === 0) throw new Error(`selection "${selectionName}" field "${rawKey}" has no values`)
  const requireAll = modifiers.includes('all')
  const modifier = modifiers.find((name) => name !== 'all') ?? 'equals'
  const compiled = values.map((value) => {
    if (modifier !== 're') return null
    try {
      return new RegExp(String(value), 'i')
    } catch (error) {
      throw new Error(`selection "${selectionName}" has an invalid regular expression "${value}": ${error.message}`)
    }
  })
  return {
    field,
    modifiers,
    expected: values,
    match(observation) {
      const actual = resolveField(observation, field)
      const hits = values.map((value, index) => matchOne(actual, value, modifier, compiled[index]))
      return {
        field,
        matched: requireAll ? hits.every(Boolean) : hits.some(Boolean),
        expected: values,
        actual,
      }
    },
  }
}

function compileSelection(name, definition) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error(`selection "${name}" must be a map of field: value pairs`)
  }
  const tests = Object.entries(definition).map(([key, value]) => compileTest(name, key, value))
  return {
    name,
    tests,
    match(observation) {
      const details = tests.map((test) => test.match(observation))
      return { matched: details.every((detail) => detail.matched), details }
    },
  }
}

function tokenizeCondition(text) {
  const tokens = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: char })
      index += 1
      continue
    }
    const word = /^[A-Za-z0-9_.*\-]+/.exec(text.slice(index))
    if (!word) throw new Error(`unexpected character "${char}" in condition`)
    index += word[0].length
    const lower = word[0].toLowerCase()
    if (['and', 'or', 'not', 'of', 'them'].includes(lower)) tokens.push({ type: lower })
    else if (lower === 'all' || lower === 'any') tokens.push({ type: lower })
    else if (/^\d+$/.test(word[0])) tokens.push({ type: 'number', value: Number(word[0]) })
    else tokens.push({ type: 'ident', value: word[0] })
  }
  return tokens
}

function createConditionParser(tokens, conditionText) {
  let cursor = 0
  const peek = () => tokens[cursor]
  const fail = (message) => {
    throw new Error(`cannot parse condition "${conditionText}": ${message}`)
  }
  const expect = (type) => {
    if (!peek() || peek().type !== type) fail(`expected ${type}`)
    return tokens[cursor++]
  }
  const parseAtom = () => {
    const token = peek()
    if (!token) fail('unexpected end of expression')
    if (token.type === '(') {
      cursor += 1
      const inner = parseOr()
      expect(')')
      return inner
    }
    if (token.type === 'not') {
      cursor += 1
      return { type: 'not', item: parseAtom() }
    }
    if (token.type === 'ident') {
      cursor += 1
      return { type: 'selection', name: token.value }
    }
    const quantifier =
      token.type === 'number' ? String(token.value) : token.type === 'all' ? 'all' : token.type === 'any' ? 'any' : null
    if (!quantifier) fail(`unexpected token "${token.type}"`)
    cursor += 1
    expect('of')
    const target = peek()
    if (!target) fail('missing selection after "of"')
    if (target.type === 'them') {
      cursor += 1
      return { type: 'quantifier', quantifier, pattern: '*' }
    }
    if (target.type !== 'ident') fail(`unexpected token "${target.type}" after "of"`)
    cursor += 1
    return { type: 'quantifier', quantifier, pattern: target.value }
  }
  const parseAnd = () => {
    const items = [parseAtom()]
    while (peek() && peek().type === 'and') {
      cursor += 1
      items.push(parseAtom())
    }
    return items.length === 1 ? items[0] : { type: 'and', items }
  }
  const parseOr = () => {
    const items = [parseAnd()]
    while (peek() && peek().type === 'or') {
      cursor += 1
      items.push(parseAnd())
    }
    return items.length === 1 ? items[0] : { type: 'or', items }
  }
  return () => {
    const expression = parseOr()
    if (cursor !== tokens.length) fail(`unexpected token "${tokens[cursor].type}"`)
    return expression
  }
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function evaluateCondition(node, matchedNames, selectionNames) {
  switch (node.type) {
    case 'selection':
      return { value: matchedNames.has(node.name), used: [node.name] }
    case 'not': {
      const inner = evaluateCondition(node.item, matchedNames, selectionNames)
      return { value: !inner.value, used: inner.used }
    }
    case 'and': {
      const results = node.items.map((item) => evaluateCondition(item, matchedNames, selectionNames))
      return { value: results.every((item) => item.value), used: results.flatMap((item) => item.used) }
    }
    case 'or': {
      const results = node.items.map((item) => evaluateCondition(item, matchedNames, selectionNames))
      const used = results.filter((item) => item.value).flatMap((item) => item.used)
      return { value: results.some((item) => item.value), used: used.length > 0 ? used : results.flatMap((item) => item.used) }
    }
    case 'quantifier': {
      const regex = globToRegExp(node.pattern)
      const candidates = selectionNames.filter((name) => regex.test(name))
      const used = candidates.filter((name) => matchedNames.has(name))
      if (node.quantifier === 'all') return { value: candidates.length > 0 && used.length === candidates.length, used }
      if (node.quantifier === 'any') return { value: used.length > 0, used }
      return { value: used.length >= Number(node.quantifier), used }
    }
    default:
      throw new Error(`unknown condition node "${node.type}"`)
  }
}

function normalizeRuleDocument(document, fallbackId) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`rule "${fallbackId}" is not a mapping`)
  }
  if (typeof document.title !== 'string' || document.title.trim().length === 0) {
    throw new Error(`rule "${fallbackId}" is missing "title"`)
  }
  const detection = document.detection
  if (!detection || typeof detection !== 'object' || Array.isArray(detection)) {
    throw new Error(`rule "${document.title}" is missing "detection"`)
  }
  if (typeof detection.condition !== 'string' || detection.condition.trim().length === 0) {
    throw new Error(`rule "${document.title}" is missing "detection.condition"`)
  }
  const level = document.level === undefined || document.level === null ? 'medium' : String(document.level)
  if (!RULE_LEVELS.has(level)) {
    throw new Error(`rule "${document.title}" has unsupported level "${level}" (allowed: ${[...RULE_LEVELS].join(', ')})`)
  }
  const tags = Array.isArray(document.tags) ? document.tags.map(String) : document.tags ? [String(document.tags)] : []
  return {
    id: document.id ? String(document.id) : fallbackId,
    title: document.title.trim(),
    level,
    status: document.status ? String(document.status) : 'experimental',
    description: document.description ? String(document.description) : '',
    author: document.author ? String(document.author) : 'unknown',
    tags,
    logsource: document.logsource && typeof document.logsource === 'object' ? document.logsource : {},
    falsepositives: Array.isArray(document.falsepositives) ? document.falsepositives.map(String) : [],
    detection,
  }
}

/** Minimal observation projection so rules.js stays independent of engine.js. */
function project(observation) {
  return {
    id: observation.id,
    layer: observation.layer,
    kind: observation.kind,
    action: observation.action,
    api: observation.api,
    url: observation.url,
    value: observation.value,
    technique: observation.technique,
    category: observation.category,
    stage: observation.stage,
    seq: observation.seq,
  }
}

const EVIDENCE_PER_SELECTION = 5

/**
 * Compile a validated rule into a report-scope evaluator.
 * @param {object} document parsed rule mapping
 * @param {string} [fallbackId] id used when the rule omits one
 */
export function compileRule(document, fallbackId = 'rule') {
  const rule = normalizeRuleDocument(document, fallbackId)
  const selectionNames = Object.keys(rule.detection).filter((key) => key !== 'condition' && key !== 'timeframe')
  if (selectionNames.length === 0) throw new Error(`rule "${rule.title}" has no selections`)
  const selections = selectionNames.map((name) => compileSelection(name, rule.detection[name]))
  const condition = createConditionParser(tokenizeCondition(rule.detection.condition), rule.detection.condition)()
  for (const name of referencedSelections(condition)) {
    if (!selectionNames.includes(name)) {
      throw new Error(`rule "${rule.title}" condition references undefined selection "${name}"`)
    }
  }
  return {
    rule,
    selections,
    condition,
    selectionNames,
    /**
     * Evaluate the rule against every observation, then combine the selection
     * outcomes with the condition. Evidence keeps the first matching
     * observations per selection so output stays bounded and deterministic.
     */
    collect(observations) {
      const matchedNames = new Set()
      const evidence = []
      for (const selection of selections) {
        const hits = []
        for (const observation of observations) {
          if (hits.length >= EVIDENCE_PER_SELECTION) break
          const result = selection.match(observation)
          if (result.matched) {
            hits.push({ observation: project(observation), details: result.details.filter((detail) => detail.matched) })
          }
        }
        if (hits.length === 0) continue
        matchedNames.add(selection.name)
        evidence.push({ name: selection.name, observations: hits.map((hit) => hit.observation), details: hits[0].details })
      }
      const outcome = evaluateCondition(condition, matchedNames, selectionNames)
      if (!outcome.value) return { matched: false, selections: [], evidence: [], unusedSelections: [] }
      const required = new Set(outcome.used)
      return {
        matched: true,
        selections: [...required].sort(),
        evidence: evidence.filter((entry) => required.has(entry.name)),
        unusedSelections: selectionNames.filter((name) => !required.has(name)),
      }
    },
  }
}

function referencedSelections(node) {
  switch (node.type) {
    case 'selection':
      return [node.name]
    case 'not':
      return referencedSelections(node.item)
    case 'and':
    case 'or':
      return node.items.flatMap(referencedSelections)
    default:
      return []
  }
}

/** Parse a rule bundle (one rule per YAML document, or one JSON object). */
export function compileRuleText(text, fallbackId = 'rule') {
  const trimmed = String(text).trim()
  const documents = trimmed.startsWith('{') ? [JSON.parse(trimmed)] : parseYamlDocuments(trimmed)
  if (documents.length === 0) throw new Error('rule text is empty')
  return documents.map((document, index) => compileRule(document, `${fallbackId}#${index + 1}`))
}

/** Re-exported so the CLI can parse rule bundles without importing two modules. */
export { parseYaml }
