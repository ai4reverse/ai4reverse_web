/**
 * Secret Scanner SDK — detects credentials and high-entropy secrets in text.
 *
 * Rules combine anchored patterns with Shannon entropy, produce redacted
 * findings with line/column, and never retain the raw secret in `preview`.
 */
export const VERSION = '1.0.0'

export const RULES = Object.freeze([
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, severity: 'critical' },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, severity: 'critical' },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, severity: 'critical' },
  { id: 'telegram-bot', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, severity: 'high' },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: 'critical' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, severity: 'high' },
  { id: 'basic-auth-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gi, severity: 'high' },
  { id: 'password-assignment', pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*['"]([^'"]{8,})['"]/gi, severity: 'high', capture: 1 },
  { id: 'high-entropy', pattern: /\b[A-Za-z0-9+/=_-]{32,}\b/g, severity: 'medium', entropy: 3.6 },
])

export function shannonEntropy(value) {
  if (!value) return 0
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return Number(entropy.toFixed(3))
}

function lineColumn(text, index) {
  const before = text.slice(0, index)
  const line = before.split('\n').length
  const column = index - before.lastIndexOf('\n')
  return { line, column }
}

function redact(value) {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`
}

/**
 * @param {string} text
 * @param {{rules?: object[], minEntropy?: number, allowlist?: string[]}} [options]
 */
export function scan(text, options = {}) {
  const rules = options.rules ?? RULES
  const minEntropy = options.minEntropy ?? 0
  const allowlist = options.allowlist ?? []
  const source = String(text ?? '')
  const findings = []
  const seen = new Set()
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`)
    let match
    while ((match = pattern.exec(source)) !== null) {
      const raw = rule.capture ? match[rule.capture] : match[0]
      if (!raw) continue
      if (allowlist.some((allowed) => raw.includes(allowed))) continue
      const entropy = shannonEntropy(raw)
      const threshold = Math.max(rule.entropy ?? 0, minEntropy)
      if (entropy < threshold) continue
      const key = `${rule.id}:${raw}`
      if (seen.has(key)) continue
      seen.add(key)
      const { line, column } = lineColumn(source, match.index)
      findings.push({ rule: rule.id, severity: rule.severity ?? 'medium', line, column, entropy, length: raw.length, preview: redact(raw) })
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** Replace every detected secret with a redaction marker. */
export function redactText(text, options = {}) {
  let output = String(text ?? '')
  const rules = options.rules ?? RULES
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`)
    output = output.replace(pattern, (match) => redact(match))
  }
  return output
}

export function summarize(findings) {
  const bySeverity = {}
  for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
  return { total: findings.length, bySeverity, rules: [...new Set(findings.map((finding) => finding.rule))] }
}
