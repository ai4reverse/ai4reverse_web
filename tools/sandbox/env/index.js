import { SandboxError } from '../../util/errors.js'

/**
 * Environment module registry.
 *
 * Modules are loaded dynamically so a partially implemented analysis platform
 * still runs (non-strict mode), while the integration test suite asserts
 * `strict: true` — no module may be missing in a valid installation.
 *
 * Each module owns one platform surface and exports
 * `meta = { id, order, requires }` plus `install(bridge)`.
 */

export const ENV_MODULE_IDS = Object.freeze([
  'globals',
  'console',
  'time',
  'stack',
  'random',
  'dom',
  'navigator',
  'screen',
  'location',
  'storage',
  'timers',
  'encoding',
  'performance',
  'crypto',
  'network',
  'xhr',
  'fetch',
  'websocket',
  'observers',
  'misc',
  'intl',
  'chrome',
  'canvas',
  'anti-fingerprint',
])

/** @type {Map<string, {meta: object, install: Function}>} */
const moduleCache = new Map()

/**
 * Load one environment module.
 * @param {string} id
 */
export async function loadEnvModule(id) {
  if (moduleCache.has(id)) return moduleCache.get(id)
  const url = new URL(`./${id}.js`, import.meta.url)
  const loaded = await import(url.href)
  if (typeof loaded.install !== 'function') {
    throw new SandboxError(`environment module ${id} does not export install()`)
  }
  const meta = { id, order: 500, requires: [], ...(loaded.meta ?? {}) }
  if (meta.id !== id) {
    throw new SandboxError(`environment module ${id} declares mismatched meta.id ${meta.id}`)
  }
  const entry = { meta, install: loaded.install, module: loaded }
  moduleCache.set(id, entry)
  return entry
}

/**
 * Install the environment onto a bridge.
 *
 * @param {object} bridge
 * @param {object} [options]
 * @param {boolean} [options.strict] throw when a module is missing/failing
 * @param {string[]} [options.only] install only these ids
 * @param {string[]} [options.exclude]
 * @param {object} [options.logger]
 */
export async function installEnvironment(bridge, options = {}) {
  const { strict = true, only = null, exclude = [], logger } = options
  const started = Date.now()
  const selected = ENV_MODULE_IDS.filter(
    (id) => (!only || only.includes(id)) && !exclude.includes(id),
  )

  /** @type {Array<{id: string, order: number, ms: number}>} */
  const installed = []
  /** @type {Array<{id: string, reason: string}>} */
  const missing = []
  const loaded = []

  for (const id of selected) {
    try {
      const entry = await loadEnvModule(id)
      loaded.push(entry)
    } catch (error) {
      const reason = error?.code === 'ERR_MODULE_NOT_FOUND' ? 'not-implemented' : error?.message ?? 'load-failed'
      missing.push({ id, reason })
      if (strict) {
        throw new SandboxError(`environment module "${id}" unavailable: ${reason}`, {
          details: { missing, installed: installed.map((item) => item.id) },
        })
      }
      logger?.warn?.({ module: id, reason }, 'environment module skipped')
    }
  }

  loaded.sort((a, b) => a.meta.order - b.meta.order || a.meta.id.localeCompare(b.meta.id))

  const installedIds = new Set()
  for (const entry of loaded) {
    for (const requirement of entry.meta.requires ?? []) {
      if (!installedIds.has(requirement)) {
        const reason = `missing requirement ${requirement}`
        if (strict) {
          throw new SandboxError(`environment module "${entry.meta.id}" ${reason}`, {
            details: { requires: entry.meta.requires, installed: [...installedIds] },
          })
        }
        logger?.warn?.({ module: entry.meta.id, reason }, 'environment requirement missing')
      }
    }
    const moduleStarted = Date.now()
    entry.install(bridge)
    installedIds.add(entry.meta.id)
    installed.push({ id: entry.meta.id, order: entry.meta.order, ms: Date.now() - moduleStarted })
  }

  return {
    installed,
    missing,
    requested: selected,
    tookMs: Date.now() - started,
    complete: missing.length === 0,
  }
}
