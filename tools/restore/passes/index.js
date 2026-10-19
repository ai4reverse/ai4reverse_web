import * as strings from './strings.js'
import * as constantFold from './constant-fold.js'
import * as memberFold from './member-fold.js'
import * as stringArray from './string-array.js'
import * as jsfuck from './jsfuck.js'
import * as proxyUnwrap from './proxy-unwrap.js'
import * as deadCode from './dead-code.js'
import * as controlFlow from './control-flow.js'
import * as antiAnalysis from './anti-analysis.js'
import * as evalUnwrap from './eval-unwrap.js'
import * as rename from './rename.js'

/**
 * Restoration pass registry.
 *
 * Every pass is independently testable, conservative, and reports what it
 * changed. Order is `meta.order`; the pipeline may run several rounds because
 * one pass often enables another (e.g. `strings` unlocks `string-array`).
 */
const MODULES = [
  strings,
  constantFold,
  memberFold,
  stringArray,
  jsfuck,
  proxyUnwrap,
  deadCode,
  controlFlow,
  antiAnalysis,
  evalUnwrap,
  rename,
]

export const PASSES = MODULES.map((module) => ({
  meta: module.meta,
  run: module.run,
})).sort((a, b) => (a.meta.order ?? 500) - (b.meta.order ?? 500))

/**
 * True when a pass is deferred to the final round. `meta.deferred` is the pass
 * contract (see docs/EVALUATION-TOOLS.md D12); the `rename` id is the fallback
 * for passes that do not declare it yet.
 *
 * @param {{meta?: {id?: string, deferred?: boolean}}} pass
 * @returns {boolean}
 */
export function isDeferredPass(pass) {
  const declared = pass.meta?.deferred
  if (typeof declared === 'boolean') return declared
  return pass.meta?.id === 'rename'
}

/** Metadata for docs/CLI listing. */
export function listPasses() {
  return PASSES.map((pass) => ({
    id: pass.meta.id,
    order: pass.meta.order,
    description: pass.meta.description,
    idempotent: pass.meta.idempotent !== false,
    deferred: isDeferredPass(pass),
  }))
}

/**
 * Select passes by id/only/exclude.
 * @param {{only?: string[], exclude?: string[], ids?: string[]}} [options]
 */
export function selectPasses(options = {}) {
  const { only = null, exclude = [], ids = null } = options
  return PASSES.filter((pass) => {
    if (ids && !ids.includes(pass.meta.id)) return false
    if (only && only.length > 0 && !only.includes(pass.meta.id)) return false
    if (exclude.includes(pass.meta.id)) return false
    return true
  })
}
