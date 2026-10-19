/**
 * AST hooks.
 *
 * The analysis pass emits `ast:enter` / `ast:node` / `ast:exit` for every node.
 * These hooks turn that stream into cheap structural counters and pattern
 * detectors that are useful in a report, without modifying the AST.
 */

const INTERESTING_APIS = new Set([
  'eval',
  'Function',
  'atob',
  'btoa',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'sendBeacon',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'crypto',
  'Worker',
  'ServiceWorker',
  'WebAssembly',
  'postMessage',
  'document',
  'window',
  'top',
  'parent',
  'opener',
])

export function createAstHooks(options = {}) {
  const { trace, maxNodes = 200_000 } = options
  const counts = new Map()
  const apiIdentifiers = new Map()
  let nodes = 0
  let callSites = 0
  let memberExpressions = 0
  let truncated = false

  const state = {
    get nodes() {
      return nodes
    },
    get truncated() {
      return truncated
    },
    get counts() {
      return counts
    },
    get apiIdentifiers() {
      return apiIdentifiers
    },
    get callSites() {
      return callSites
    },
    get memberExpressions() {
      return memberExpressions
    },
  }

  const registrations = [
    {
      phase: 'ast:node',
      owner: 'ast-hooks',
      priority: 1,
      traceless: { addsGlobals: false, preservesIdentity: true, preservesStack: true },
      handler(payload) {
        if (truncated) return undefined
        nodes += 1
        if (nodes > maxNodes) {
          truncated = true
          trace?.emit('ast', 'error', { event: 'ast.node.budget', maxNodes })
          return undefined
        }
        counts.set(payload.type, (counts.get(payload.type) ?? 0) + 1)
        return undefined
      },
    },
    {
      phase: 'ast:enter',
      owner: 'ast-hooks',
      priority: 2,
      handler(payload) {
        if (payload.type === 'Identifier' && INTERESTING_APIS.has(payload.name)) {
          apiIdentifiers.set(payload.name, (apiIdentifiers.get(payload.name) ?? 0) + 1)
        }
        if (payload.type === 'CallExpression') callSites += 1
        if (payload.type === 'MemberExpression') memberExpressions += 1
        return undefined
      },
    },
  ]
  registrations.state = state
  return registrations
}

/** Snapshot of the AST hook counters (usable in reports). */
export function astHookStats(state) {
  return {
    nodes: state.nodes,
    truncated: state.truncated,
    types: Object.fromEntries(state.counts ?? []),
    apiIdentifiers: Object.fromEntries(state.apiIdentifiers ?? []),
    callSites: state.callSites ?? 0,
    memberExpressions: state.memberExpressions ?? 0,
  }
}
