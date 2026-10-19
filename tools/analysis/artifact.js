import { sha256, shortHash } from '../util/hash.js'

/**
 * Artifact store.
 *
 * Loaders stage payloads: base64 blobs, decoded strings passed to `eval`, HTTP
 * response bodies, console dumps. Each recovered blob is content-addressed and
 * kept with its provenance so an analyst can pivot from a trace event to bytes.
 */

export const ARTIFACT_KINDS = Object.freeze([
  'eval-payload',
  'function-body',
  'decoded-string',
  'network-body',
  'console-output',
  'embedded-blob',
  'websocket-message',
])

/**
 * @param {{maxBytes?: number, maxArtifacts?: number, logger?: object}} [options]
 */
export function createArtifactStore(options = {}) {
  const { maxBytes = 4 * 1024 * 1024, maxArtifacts = 200, logger } = options
  /** @type {Map<string, object>} */
  const byHash = new Map()
  let totalBytes = 0

  const store = {
    /**
     * Add a payload. Returns the artifact record (existing one on duplicate).
     * @param {{kind: string, data: string|Uint8Array, source?: string, meta?: object}} input
     */
    add({ kind, data, source = 'dynamic', meta = {} }) {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
      if (bytes.length === 0) return null
      if (bytes.length > maxBytes) {
        logger?.debug?.({ kind, size: bytes.length }, 'artifact too large; truncated preview only')
      }
      const text = bytes.subarray(0, Math.min(bytes.length, maxBytes)).toString('utf8')
      const hash = sha256(bytes)
      const existing = byHash.get(hash)
      if (existing) {
        existing.count += 1
        return existing
      }
      if (byHash.size >= maxArtifacts) return null
      const artifact = {
        id: shortHash(hash, 12),
        kind,
        sha256: hash,
        size: bytes.length,
        source,
        count: 1,
        preview: previewText(text),
        text: text.length > 65_536 ? text.slice(0, 65_536) : text,
        meta,
      }
      byHash.set(hash, artifact)
      totalBytes += bytes.length
      return artifact
    },

    /** @param {object[]} artifacts */
    addAll(artifacts) {
      const out = []
      for (const artifact of artifacts) {
        const added = store.add(artifact)
        if (added) out.push(added)
      }
      return out
    },

    list() {
      return [...byHash.values()].sort((a, b) => b.size - a.size)
    },

    summary() {
      return store.list().map(({ text, ...rest }) => rest)
    },

    stats() {
      return { count: byHash.size, bytes: totalBytes }
    },
  }

  return store
}

function previewText(text, max = 300) {
  return text.length > max ? `${text.replace(/\s+/g, ' ').slice(0, max)}…` : text.replace(/\s+/g, ' ')
}
