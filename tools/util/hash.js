import { createHash } from 'node:crypto'

/** @param {string|Uint8Array} data */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Short stable id for artifacts. */
export function shortHash(data, length = 16) {
  return sha256(data).slice(0, length)
}

/**
 * JSON with sorted keys, used for deterministic fingerprints and snapshots.
 * Handles cycles by replacing repeats with `"[Circular]"`.
 * @param {unknown} value
 */
export function stableStringify(value) {
  const seen = new WeakSet()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'number' && !Number.isFinite(node)) return `"${String(node)}"`
      if (typeof node === 'bigint') return `"${node.toString()}n"`
      if (typeof node === 'function') return `"[Function ${node.name || 'anonymous'}]"`
      if (typeof node === 'undefined') return '"[undefined]"'
      return node
    }
    if (seen.has(node)) return '"[Circular]"'
    seen.add(node)
    if (Array.isArray(node)) return node.map(walk)
    const out = {}
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key])
    return out
  }
  return JSON.stringify(walk(value))
}

/** @param {unknown} value */
export function hashObject(value) {
  return sha256(stableStringify(value))
}
