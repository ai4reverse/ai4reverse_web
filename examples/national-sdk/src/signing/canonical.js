/**
 * Request canonicalisation.
 *
 * A signature is only as strong as the canonical form: if device and server
 * disagree about one byte, every request fails, and if the mapping is ambiguous
 * an attacker can move data between fields without breaking the signature.
 * Therefore:
 *
 *  - method is upper-cased,
 *  - the path is used verbatim (no normalisation by the SDK),
 *  - query pairs are percent-encoded with RFC 3986 rules, then sorted by encoded
 *    key and value, so `?a=1&b=2` and `?b=2&a=1` are the same request,
 *  - headers are lower-cased, OWS-trimmed, sorted, and only an explicit
 *    allow-list participates,
 *  - the body is hashed with SM3 over its exact transmitted bytes.
 *
 * The canonical string ends with a newline so a field cannot absorb the next
 * delimiter.
 */

import { sm3 } from '../core/hash.js'
import { toHex, utf8ToBytes } from '../core/bytes.js'
import { canonicalize } from '../fingerprint/canonical.js'

const DEFAULT_SIGNED_HEADERS = Object.freeze(['content-type'])

/**
 * RFC 3986 percent-encoding (`encodeURIComponent` leaves !'()* unescaped).
 * @param {string} value
 * @returns {string}
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * Split a URL/path into a path plus decoded query pairs.
 * A hand-written parser keeps behaviour identical without depending on `URL`.
 * @param {string} input
 * @returns {{path: string, query: Array<[string, string]>}}
 */
export function splitUrl(input) {
  const text = String(input ?? '/')
  const withoutOrigin = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/.test(text) ? text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '') : text
  const hashIndex = withoutOrigin.indexOf('#')
  const clean = hashIndex >= 0 ? withoutOrigin.slice(0, hashIndex) : withoutOrigin
  const questionIndex = clean.indexOf('?')
  const path = questionIndex >= 0 ? clean.slice(0, questionIndex) : clean
  const queryText = questionIndex >= 0 ? clean.slice(questionIndex + 1) : ''
  const query = []
  if (queryText.length > 0) {
    for (const pair of queryText.split('&')) {
      if (pair.length === 0) continue
      const equals = pair.indexOf('=')
      const rawKey = equals >= 0 ? pair.slice(0, equals) : pair
      const rawValue = equals >= 0 ? pair.slice(equals + 1) : ''
      query.push([decodeComponent(rawKey), decodeComponent(rawValue)])
    }
  }
  return { path: path.length === 0 ? '/' : path, query }
}

/** @param {string} value @returns {string} */
function decodeComponent(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '))
  } catch {
    return String(value)
  }
}

/**
 * Normalise the query into sorted, encoded pairs.
 * @param {Array<[string, string]>|Record<string, string|number|boolean|Array<string|number|boolean>>} query
 * @returns {Array<[string, string]>}
 */
export function normalizeQuery(query) {
  const pairs = []
  if (Array.isArray(query)) {
    for (const entry of query) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      pairs.push([String(entry[0]), String(entry[1])])
    }
  } else if (query && typeof query === 'object') {
    for (const key of Object.keys(query)) {
      const value = query[key]
      if (Array.isArray(value)) for (const item of value) pairs.push([key, String(item)])
      else pairs.push([key, String(value)])
    }
  }
  return pairs
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort((left, right) => (left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : left[0] < right[0] ? -1 : 1))
}

/**
 * Normalise headers: names lower-cased, values OWS-trimmed and internally
 * collapsed, sorted by name.
 * @param {Record<string, string>|Array<[string, string]>|undefined} headers
 * @param {string[]} [signedHeaders]
 * @returns {Array<[string, string]>}
 */
export function normalizeHeaders(headers, signedHeaders = DEFAULT_SIGNED_HEADERS) {
  const entries = []
  if (Array.isArray(headers)) {
    for (const pair of headers) if (Array.isArray(pair) && pair.length >= 2) entries.push([String(pair[0]), String(pair[1])])
  } else if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) entries.push([key, headers[key]])
  }
  const allow = new Set((signedHeaders ?? DEFAULT_SIGNED_HEADERS).map((name) => name.toLowerCase()))
  const seen = new Map()
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).trim().toLowerCase()
    if (!allow.has(name)) continue
    const value = String(rawValue).replace(/[\r\n]+/g, ' ').trim().replace(/\s+/g, ' ')
    seen.set(name, seen.has(name) ? `${seen.get(name)},${value}` : value)
  }
  return Array.from(seen.entries()).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
}

/**
 * Exact transmitted bytes for a body.
 * @param {unknown} body
 * @returns {Uint8Array}
 */
export function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array(0)
  if (body instanceof Uint8Array) return body
  if (typeof body === 'string') return utf8ToBytes(body)
  return utf8ToBytes(canonicalize(body))
}

/**
 * @param {object} request
 * @param {string} [request.method]
 * @param {string} [request.url]
 * @param {string} [request.path]
 * @param {object|Array} [request.query]
 * @param {object|Array} [request.headers]
 * @param {unknown} [request.body]
 * @param {string[]} [request.signedHeaders]
 * @returns {{canonical: string, path: string, query: string, bodyHash: string, headers: Array<[string,string]>, method: string}}
 */
export function canonicalRequest(request) {
  const method = String(request.method ?? 'GET').toUpperCase()
  const parsed = splitUrl(request.url ?? request.path ?? '/')
  const path = request.path && !request.url ? String(request.path) : parsed.path
  const queryPairs = request.query !== undefined ? normalizeQuery(request.query) : normalizeQuery(parsed.query)
  const query = queryPairs.map(([key, value]) => `${key}=${value}`).join('&')
  const bytes = bodyBytes(request.body)
  const bodyHash = toHex(sm3(bytes))
  const headers = normalizeHeaders(request.headers, request.signedHeaders)
  const headerLines = headers.map(([name, value]) => `${name}:${value}`).join('\n')
  const canonical = `${method}\n${path}\n${query}\n${bodyHash}\n${headerLines}\n`
  return { canonical, path, query, bodyHash, headers, method }
}

/**
 * The string that is actually signed: canonical request plus the anti-replay
 * and identity fields.
 * @param {{canonical: string, timestamp: number|string, nonce: string, fingerprint: string, risk: string}} fields
 * @returns {string}
 */
export function signatureBase(fields) {
  return `${fields.canonical}|${fields.timestamp}|${fields.nonce}|${fields.fingerprint}|${fields.risk}`
}

export { DEFAULT_SIGNED_HEADERS }
