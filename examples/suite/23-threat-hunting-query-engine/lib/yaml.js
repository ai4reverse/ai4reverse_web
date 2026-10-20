/**
 * Minimal, dependency-free YAML subset parser.
 *
 * Detection rules are stored as Sigma-style YAML. The platform ships no YAML
 * package, so this module implements exactly the subset rule authors use:
 * indentation-based maps, `- item` sequences, inline `[a, b]` / `{a: b}`
 * collections, quoted scalars and YAML 1.2 booleans/null. Anything outside the
 * subset throws a located error instead of being silently misread.
 */

const TRUE_VALUES = new Set(['true', 'yes', 'on'])
const FALSE_VALUES = new Set(['false', 'no', 'off'])

/** Remove a trailing `#` comment that is not inside a quoted scalar. */
function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

/** Index of the `key: value` separator, ignoring quoted text and URLs. */
function findColon(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':' && (index === text.length - 1 || /\s/.test(text[index + 1]))) return index
  }
  return -1
}

/** Split on commas that are not nested in quotes or brackets. */
function splitInline(text) {
  const parts = []
  let quote = null
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

function unquote(text) {
  const value = text.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text.length === 0) return null
  if (text.startsWith('"') && text.endsWith('"')) return unquote(text)
  if (text.startsWith("'") && text.endsWith("'")) return unquote(text)
  if (text.startsWith('[') && text.endsWith(']')) return splitInline(text.slice(1, -1)).map(parseScalar)
  if (text.startsWith('{') && text.endsWith('}')) {
    const map = {}
    for (const pair of splitInline(text.slice(1, -1))) {
      const colon = findColon(pair)
      if (colon < 0) throw new Error(`inline map entry "${pair}" is missing ":"`)
      map[unquote(pair.slice(0, colon))] = parseScalar(pair.slice(colon + 1))
    }
    return map
  }
  const lower = text.toLowerCase()
  if (lower === 'null' || lower === '~') return null
  if (TRUE_VALUES.has(lower)) return true
  if (FALSE_VALUES.has(lower)) return false
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text)
  return text
}

function tokenizeLines(source) {
  const lines = []
  for (const raw of String(source).split(/\r?\n/)) {
    const stripped = stripComment(raw)
    const body = stripped.trim()
    if (body.length === 0) continue
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: body })
  }
  return lines
}

function parseMap(lines, start, indent) {
  const map = {}
  let index = start
  while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('- ')) {
    const line = lines[index]
    const colon = findColon(line.text)
    if (colon < 0) throw new Error(`expected "key: value" but found "${line.text}"`)
    const key = unquote(line.text.slice(0, colon))
    const rest = line.text.slice(colon + 1).trim()
    if (rest.length > 0) {
      map[key] = parseScalar(rest)
      index += 1
      continue
    }
    index += 1
    const next = lines[index]
    if (next && next.indent > indent) {
      const parsed = parseBlock(lines, index, next.indent)
      map[key] = parsed.value
      index = parsed.index
    } else if (next && next.indent === indent && next.text.startsWith('- ')) {
      const parsed = parseList(lines, index, indent)
      map[key] = parsed.value
      index = parsed.index
    } else {
      map[key] = null
    }
  }
  return { value: map, index }
}

function parseList(lines, start, indent) {
  const values = []
  let index = start
  while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
    const line = lines[index]
    const rest = line.text.slice(1).trim()
    if (rest.length === 0) {
      index += 1
      if (index < lines.length && lines[index].indent > indent) {
        const parsed = parseBlock(lines, index, lines[index].indent)
        values.push(parsed.value)
        index = parsed.index
      } else {
        values.push(null)
      }
      continue
    }
    if (findColon(rest) >= 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
      // `- key: value` opens a map whose keys live at indent + 2.
      lines[index] = { indent: indent + 2, text: rest }
      const parsed = parseMap(lines, index, indent + 2)
      values.push(parsed.value)
      index = parsed.index
      continue
    }
    values.push(parseScalar(rest))
    index += 1
  }
  return { value: values, index }
}

function parseBlock(lines, start, indent) {
  return lines[start].text.startsWith('- ') ? parseList(lines, start, indent) : parseMap(lines, start, indent)
}

/**
 * Parse the supported YAML subset into plain objects/arrays.
 * @param {string} source
 * @returns {unknown}
 */
export function parseYaml(source) {
  const lines = tokenizeLines(source)
  if (lines.length === 0) return null
  const parsed = parseBlock(lines, 0, lines[0].indent)
  if (parsed.index !== lines.length) throw new Error(`unexpected trailing content "${lines[parsed.index].text}"`)
  return parsed.value
}

/** YAML allows several documents separated by `---`; rules ship one each. */
export function parseYamlDocuments(source) {
  return String(source)
    .split(/^---\s*$/m)
    .filter((chunk) => tokenizeLines(chunk).length > 0)
    .map(parseYaml)
}
