/**
 * Lazy access to the z3 WASM module.
 *
 * `z3-solver` is a CommonJS package that loads a ~34 MB WASM module. A static
 * import would pay that cost for every consumer of the root barrel, including
 * callers that only run the sandbox, so the module is loaded on first use and
 * the initialisation promise is shared. Concurrent callers await the same
 * promise; a failed load clears it so a later call can retry instead of
 * poisoning the process forever.
 *
 * The package's ESM interop exposes `init` as a named export (and the CJS
 * object as `default`), so both shapes are accepted.
 */

/** @type {Promise<{init: Function}> | null} */
let modulePromise = null

/** @type {Promise<object> | null} */
let apiPromise = null

/** @type {number} */
let contextCounter = 0

async function importModule() {
  const loaded = await import('z3-solver')
  const candidate = loaded?.default && typeof loaded.default.init === 'function' ? loaded.default : loaded
  if (!candidate || typeof candidate.init !== 'function') {
    throw new Error('z3-solver does not expose init()')
  }
  return candidate
}

/**
 * Load the z3 high-level API once per process.
 *
 * @returns {Promise<object>} the object returned by `init()`
 */
export function loadZ3() {
  if (!apiPromise) {
    if (!modulePromise) {
      modulePromise = importModule().catch((error) => {
        modulePromise = null
        throw error
      })
    }
    apiPromise = modulePromise
      .then((module) => module.init())
      .catch((error) => {
        apiPromise = null
        throw error
      })
  }
  return apiPromise
}

/**
 * Create a private z3 context. A context owns its ASTs; callers that translate
 * one sample should create one context and release the solvers they create.
 *
 * @param {string} [name] context name, for z3 diagnostics
 * @returns {Promise<{api: object, context: object, name: string}>}
 */
export async function createZ3Context(name = 'ai4reverse-constraint') {
  const api = await loadZ3()
  contextCounter += 1
  const contextName = `${name}-${contextCounter}`
  return { api, context: new api.Context(contextName), name: contextName }
}

/**
 * True when a solver answer is a decision (`sat`/`unsat`) rather than
 * `unknown` (timeout, incomplete theory, resource limit).
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDecision(status) {
  return status === 'sat' || status === 'unsat'
}

/**
 * Best-effort z3 version string for the report. The API exposes several
 * spellings across builds; a missing version is `null`, never a throw.
 *
 * @param {object} api
 * @returns {string|null}
 */
export function z3Version(api) {
  try {
    if (typeof api?.getVersionString === 'function') return String(api.getVersionString())
    if (typeof api?.getFullVersion === 'function') return String(api.getFullVersion())
    if (typeof api?.getVersion === 'function') return JSON.stringify(api.getVersion())
  } catch {
    // Version reporting is metadata, not a reason to fail an analysis.
  }
  return null
}
