import { createArtifactStore } from './artifact.js'

/**
 * Stage extraction: recover the payloads a loader evaluates.
 *
 * This is the core of "溯源" (tracing back): a dropper almost never contains the
 * final malware in clear text. It decodes/evaluates it at runtime. The code
 * instrumentation records the value passed to `eval`/`Function`, decoding APIs
 * record their result, and network mocks record response bodies. Each becomes a
 * content-addressed artifact, so the analyst can follow stage1 -> stage2.
 */
export function extractStagedPayloads(events = [], sourceText = '', options = {}) {
  const store = createArtifactStore({ logger: options.logger })
  const { minLength = 16 } = options

  for (const event of events) {
    if (event.kind === 'code' && (event.event === 'eval' || event.event === 'Function')) {
      const value = typeof event.value === 'string' ? event.value : event.value?.value
      if (typeof value === 'string' && value.length >= minLength) {
        store.add({
          kind: event.event === 'eval' ? 'eval-payload' : 'function-body',
          data: value,
          source: `dynamic:${event.filename ?? 'eval'}@${event.seq}`,
          meta: { line: event.line, column: event.column, seq: event.seq },
        })
      }
    }

    if (event.kind === 'api' && (event.api === 'atob' || event.api === 'btoa') && typeof event.value === 'string') {
      if (event.value.length >= minLength) {
        store.add({
          kind: 'decoded-string',
          data: event.value,
          source: `dynamic:${event.api}@${event.seq}`,
          meta: { api: event.api, seq: event.seq },
        })
      }
    }

    if (event.kind === 'net' && typeof event.bodyText === 'string' && event.bodyText.length >= minLength) {
      store.add({
        kind: 'network-body',
        data: event.bodyText,
        source: `network:${event.url ?? 'unknown'}@${event.seq}`,
        meta: { url: event.url, status: event.status, method: event.method },
      })
    }

    if (event.kind === 'api' && event.api?.startsWith('console.')) {
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length >= minLength) {
        store.add({
          kind: 'console-output',
          data: text,
          source: `console@${event.seq}`,
          meta: { method: event.api, seq: event.seq },
        })
      }
    }

    if (event.kind === 'net' && event.websocketMessage && typeof event.websocketMessage === 'string') {
      store.add({
        kind: 'websocket-message',
        data: event.websocketMessage,
        source: `websocket@${event.seq}`,
        meta: { url: event.url, seq: event.seq },
      })
    }
  }

  // Embedded blobs in the delivered source: long base64 runs and long string
  // literals that look like encoded payloads.
  const blobPattern = /(?:[A-Za-z0-9+/]{4}){32,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g
  let match
  let embedded = 0
  while ((match = blobPattern.exec(sourceText)) !== null && embedded < 50) {
    if (match[0].length < 128) continue
    embedded += 1
    let decoded = ''
    try {
      decoded = Buffer.from(match[0], 'base64').toString('utf8')
    } catch {
      decoded = ''
    }
    store.add({
      kind: 'embedded-blob',
      data: match[0],
      source: `static:offset=${match.index}`,
      meta: { decodedPreview: decoded.slice(0, 300), offset: match.index, decodedLength: decoded.length },
    })
  }

  return store
}
