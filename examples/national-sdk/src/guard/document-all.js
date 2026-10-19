/**
 * `document.all` — the strongest browser invariant available to pure JS.
 *
 * In every real browser `document.all` is an `HTMLAllCollection` carrying the
 * `[[IsHTMLDDA]]` internal slot. That slot produces a combination no ordinary
 * JavaScript value can imitate:
 *
 *   typeof document.all === 'undefined'   // true
 *   document.all === undefined            // false
 *   Boolean(document.all)                 // false
 *   document.all == null                  // true
 *   Object.prototype.toString.call(...)   // '[object HTMLAllCollection]'
 *   document.all.length                   // works
 *
 * A QuickJS/Node/jsdom environment can fake at most one side of that
 * combination: `typeof` cannot be intercepted in ECMAScript, so a value that is
 * a real object always reports `'object'`, and a value that reports
 * `'undefined'` is literally `undefined` (falsy, equal to null both loosely and
 * strictly). This is why the check is *proof-grade*: failing it proves the code
 * is not running in a browser, independent of every other signal.
 */

import { brand, read } from './probe.js'

/**
 * @param {ReturnType<typeof import('./probe.js').createProbe>} probe
 * @returns {{status: 'pass'|'fail'|'unknown', checks: Array<{id: string, ok: boolean|null, detail: string}>, detail: string}}
 */
export function probeDocumentAll(probe) {
  const doc = probe.document
  if (!doc) {
    return {
      status: 'fail',
      checks: [{ id: 'document-present', ok: false, detail: 'no document object' }],
      detail: 'document is missing',
    }
  }

  const checks = []
  /** @param {string} id @param {() => boolean} fn @param {string} detail */
  const check = (id, fn, detail) => {
    const ok = read(() => Boolean(fn()), false)
    checks.push({ id, ok, detail })
  }

  const hasAll = read(() => 'all' in doc, false)
  checks.push({ id: 'property-exists', ok: hasAll, detail: "'all' in document" })

  // The critical invariant: typeof must be 'undefined' while the value is
  // still a usable object.
  const typeOfAll = read(() => typeof doc.all, 'missing')
  checks.push({ id: 'typeof-undefined', ok: typeOfAll === 'undefined', detail: `typeof document.all === ${typeOfAll}` })

  const referenceIsDefined = read(() => doc.all !== undefined && doc.all !== null, false)
  checks.push({ id: 'reference-defined', ok: referenceIsDefined, detail: 'document.all !== undefined && !== null' })

  const falsy = read(() => !doc.all, false)
  checks.push({ id: 'falsy', ok: falsy, detail: 'Boolean(document.all) === false' })

  const looseNull = read(() => doc.all == null, false)
  checks.push({ id: 'loose-null', ok: looseNull, detail: 'document.all == null' })

  const strictUndefined = read(() => doc.all === undefined, false)
  checks.push({ id: 'strict-undefined', ok: strictUndefined === false, detail: 'document.all === undefined is false' })

  const tag = read(() => brand(doc.all), '')
  checks.push({ id: 'brand', ok: tag === '[object HTMLAllCollection]', detail: `brand ${tag}` })

  const lengthType = read(() => typeof doc.all.length, 'missing')
  checks.push({ id: 'length', ok: lengthType === 'number', detail: `typeof document.all.length === ${lengthType}` })

  const itemType = read(() => typeof doc.all.item, 'missing')
  checks.push({ id: 'item', ok: itemType === 'function', detail: `typeof document.all.item === ${itemType}` })

  const namedItemType = read(() => typeof doc.all.namedItem, 'missing')
  checks.push({ id: 'named-item', ok: namedItemType === 'function', detail: `typeof document.all.namedItem === ${namedItemType}` })

  const failed = checks.filter((entry) => entry.ok === false)
  if (failed.length === 0) {
    return { status: 'pass', checks, detail: 'every HTMLAllCollection/IsHTMLDDA invariant holds' }
  }
  return {
    status: 'fail',
    checks,
    detail: `failed: ${failed.map((entry) => entry.id).join(', ')}`,
  }
}
