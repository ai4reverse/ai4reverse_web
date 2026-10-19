/**
 * API-level traceless hooks.
 *
 * Each hook may return `{ block: value }` to answer the call without touching
 * the platform API, or `{ args: [...] }` to rewrite arguments. The guest cannot
 * tell a mock from a real platform response when the mock is coherent with the
 * profile (timing, status codes, headers) — that is the "traceless" contract
 * recorded on every registration.
 */

const TRACELESS = {
  addsGlobals: false,
  preservesIdentity: true,
  preservesStack: true,
  consistentAnswers: true,
}

/**
 * @param {object} [options]
 * @param {object} [options.trace]
 * @param {boolean} [options.suppressDialogs] answer alert/confirm/prompt locally
 * @param {boolean} [options.blockPopups] answer window.open with null
 * @param {Array<{api: string|RegExp, response: unknown, reason?: string}>} [options.mocks]
 */
export function createApiHooks(options = {}) {
  const { trace, suppressDialogs = true, blockPopups = true, mocks = [] } = options
  const hooks = []
  const fired = []

  const record = (api, reason, response) => {
    const entry = { api, reason, response: summarize(response) }
    if (fired.length < 500) fired.push(entry)
    trace?.emit('api', 'skip', { api, reason, mock: true, response: entry.response })
  }

  if (suppressDialogs) {
    hooks.push({
      phase: 'api:before',
      owner: 'api-hooks',
      priority: 50,
      id: 'suppress-dialogs',
      traceless: TRACELESS,
      handler(payload) {
        if (payload.api === 'window.alert') {
          record(payload.api, 'dialog-suppressed', undefined)
          return { block: undefined }
        }
        if (payload.api === 'window.confirm') {
          record(payload.api, 'dialog-suppressed', false)
          return { block: false }
        }
        if (payload.api === 'window.prompt') {
          record(payload.api, 'dialog-suppressed', null)
          return { block: null }
        }
        return undefined
      },
    })
  }

  if (blockPopups) {
    hooks.push({
      phase: 'api:before',
      owner: 'api-hooks',
      priority: 60,
      id: 'block-popups',
      traceless: TRACELESS,
      handler(payload) {
        if (payload.api === 'window.open') {
          record(payload.api, 'popup-blocked', null)
          return { block: null }
        }
        return undefined
      },
    })
  }

  for (const [index, mock] of mocks.entries()) {
    hooks.push({
      phase: 'api:before',
      owner: 'api-hooks',
      priority: 40,
      id: `mock-${index}`,
      traceless: TRACELESS,
      handler(payload) {
        const matches =
          typeof mock.api === 'string' ? payload.api === mock.api : mock.api instanceof RegExp ? mock.api.test(payload.api) : false
        if (!matches) return undefined
        record(payload.api, mock.reason ?? 'hooked', mock.response)
        return { block: mock.response }
      },
    })
  }

  // Observation of security-relevant API calls (never blocking).
  const SENSITIVE = [
    [/clipboard\.(writeText|readText)/, 'clipboard-access'],
    [/localStorage\.setItem/, 'storage-write'],
    [/getUserMedia|getDisplayMedia/, 'media-capture'],
    [/sendBeacon/, 'beacon'],
    [/WebSocket\.send/, 'websocket-send'],
    [/crypto\.subtle/, 'crypto'],
    [/document\.cookie:set/, 'cookie-write'],
  ]
  hooks.push({
    phase: 'api:before',
    owner: 'api-hooks',
    priority: 5,
    id: 'sensitive-api-observer',
    traceless: TRACELESS,
    handler(payload) {
      for (const [pattern, category] of SENSITIVE) {
        if (pattern.test(payload.api)) {
          trace?.emit('api', 'emit', { event: 'sensitive-api', api: payload.api, category })
          break
        }
      }
      return undefined
    },
  })

  return { hooks, fired, stats: () => ({ fired: fired.length, registered: hooks.length }) }
}

function summarize(value, depth = 0) {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string') return value.length > 256 ? `${value.slice(0, 256)}…` : value
  if (type === 'number' || type === 'boolean') return value
  if (depth > 1) return '[object]'
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}
