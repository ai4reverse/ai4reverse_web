/**
 * Code-level hooks.
 *
 * Hooks observe or rewrite source at `code:before` / `code:after`. Rewrites are
 * allowed but must stay semantics-preserving; observation is always safe. The
 * default set is analysis-only: it never changes the sample.
 */

/** Anti-analysis markers scanned in delivered source (read-only detection). */
export const SUSPICIOUS_PATTERNS = Object.freeze([
  { id: 'debugger-statement', pattern: /\bdebugger\s*;/, detail: 'debugger statement' },
  { id: 'construct-return-this', pattern: /constructor\s*\(\s*['"]return\s+this['"]\s*\)/, detail: 'global escape via Function constructor' },
  { id: 'process-check', pattern: /\bprocess\b\s*(?:\.|\[)\s*(?:versions|env|binding|mainModule)/, detail: 'Node process probe' },
  { id: 'webdriver-check', pattern: /\bwebdriver\b/, detail: 'navigator.webdriver probe' },
  { id: 'phantom-check', pattern: /\b(?:_phantom|callPhantom|__nightmare|domAutomation)\b/, detail: 'analysis-farm honeypot probe' },
  { id: 'devtools-size', pattern: /(?:outerWidth\s*-\s*innerWidth|outerHeight\s*-\s*innerHeight)/, detail: 'devtools open detection' },
  { id: 'toString-brand', pattern: /Function\.prototype\.toString|\.toString\.call\s*\(\s*(?:window|document|navigator)/, detail: 'native brand check' },
  { id: 'stack-probe', pattern: /new\s+Error\s*\(\s*\)\s*\.\s*stack|Error\s*\(\s*\)\s*\.\s*stack/, detail: 'stack inspection' },
  { id: 'wasm-loader', pattern: /WebAssembly\s*\.\s*(?:instantiate|compile)/, detail: 'WebAssembly loader' },
  { id: 'keylogging', pattern: /addEventListener\s*\(\s*['"]key(?:down|press|up)['"]/, detail: 'keyboard listener' },
])

/**
 * @param {object} [options]
 * @param {object} [options.ioc] IOC extractor module (injected to avoid a cycle)
 * @param {object} [options.trace]
 */
export function createCodeHooks(options = {}) {
  const { trace, ioc } = options
  const seen = new Set()
  return [
    {
      phase: 'code:before',
      owner: 'code-hooks',
      priority: 100,
      traceless: { addsGlobals: false, preservesIdentity: true, preservesStack: true },
      handler(payload) {
        const source = typeof payload === 'string' ? payload : payload?.source ?? ''
        const hits = []
        for (const rule of SUSPICIOUS_PATTERNS) {
          if (rule.pattern.test(source)) {
            hits.push(rule.id)
            if (!seen.has(rule.id)) {
              seen.add(rule.id)
              trace?.emit('code', 'emit', { event: 'suspicious-pattern', rule: rule.id, detail: rule.detail })
            }
          }
        }
        if (hits.length > 0 && typeof payload === 'object' && payload) payload.suspiciousPatterns = hits
        return undefined // observation only: never rewrite
      },
    },
    {
      phase: 'code:after',
      owner: 'code-hooks',
      priority: 10,
      traceless: { addsGlobals: false, preservesIdentity: true, preservesStack: true },
      handler(payload) {
        if (!ioc || !payload?.source) return undefined
        try {
          const extracted = ioc.extractIOCs(String(payload.source).slice(0, 2_000_000))
          const urls = (extracted.urls ?? []).slice(0, 200)
          for (const entry of urls) {
            trace?.emit('ioc', 'emit', { source: 'static', iocKind: 'url', value: entry.value })
          }
        } catch {
          /* IOC extraction must never break a run */
        }
        return undefined
      },
    },
  ]
}
