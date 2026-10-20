import { createHookBus, HOOK_PHASES } from './hookbus.js'
import { createCodeHooks, SUSPICIOUS_PATTERNS } from './code-hook.js'
import { createApiHooks } from './api-hook.js'
import { createExceptionHooks } from './exception-hook.js'
import { createAstHooks } from './ast-hook.js'
import { HookError } from '../util/errors.js'

export { createHookBus, HOOK_PHASES } from './hookbus.js'
export { createCodeHooks, SUSPICIOUS_PATTERNS } from './code-hook.js'
export { createApiHooks } from './api-hook.js'
export { createExceptionHooks } from './exception-hook.js'
export { createAstHooks } from './ast-hook.js'

/**
 * Build the default hook set.
 *
 * Defaults are deliberately conservative: they observe everything and mock only
 * surfaces whose mock cannot change the sample's observable behaviour (dialogs,
 * popups). Everything else is recorded and left to the analyst to enable.
 *
 * @param {object} [options]
 * @param {object} [options.trace]
 * @param {object} [options.ioc]
 * @param {Function} [options.onUncaught]
 * @param {Array} [options.mocks]
 */
export function createDefaultHooks(options = {}) {
  const { trace, ioc, onUncaught, onCaught, mocks = [], suppressDialogs = true, blockPopups = true } = options
  const api = createApiHooks({ trace, mocks, suppressDialogs, blockPopups })
  const ast = createAstHooks({ trace })
  return {
    registrations: [
      ...createCodeHooks({ trace, ioc }),
      ...api.hooks,
      ...createExceptionHooks({ trace, onUncaught, onCaught }),
      ...ast,
    ],
    api,
    ast,
  }
}

/**
 * Normalize one hook registration.
 *
 * Two shapes are accepted because both are natural to write and only one used
 * to be:
 *   `{ phase, handler, … }` — the documented descriptor;
 *   `[phase, handler]` / `[phase, handler, options]` — the tuple form, which
 *   used to be dropped without a word (audit F6). A hook meant to *block* a
 *   behaviour then never ran and nothing reported it.
 *
 * @param {unknown} registration
 * @returns {{phase: string, handler: Function, options: object}}
 */
function normalizeRegistration(registration) {
  if (Array.isArray(registration)) {
    const [phase, handler, options] = registration
    if (registration.length < 2 || registration.length > 3 || typeof handler !== 'function'
      || (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))) {
      throw new HookError('hook tuple must be [phase, handler, options?] with a function handler', {
        details: { registration: describeRegistration(registration) },
      })
    }
    return { phase, handler, options: options ?? {} }
  }
  if (!registration || typeof registration !== 'object') {
    throw new HookError('hook registration must be an object or a [phase, handler] tuple', {
      details: { registration: describeRegistration(registration) },
    })
  }
  if (typeof registration.handler !== 'function') {
    throw new HookError(`hook ${JSON.stringify(registration.phase ?? null)} has no handler function`, {
      details: { registration: describeRegistration(registration) },
    })
  }
  if (!registration.phase) {
    throw new HookError('hook registration has no phase', {
      details: { registration: describeRegistration(registration) },
    })
  }
  return { phase: registration.phase, handler: registration.handler, options: registration }
}

/**
 * Is this array a single registration tuple rather than a list of them?
 *
 * `[phase, handler]` and `[phase, handler, options]`; a list such as
 * `[['code:after', fn], {…}]` is not. Keeps a nested array from being flattened
 * into its parts ("code:after" would then be read as a registration), and lets
 * a wrong handler be reported as a tuple mistake rather than a shape mistake.
 * @param {unknown[]} value
 */
function isTuple(value) {
  return typeof value[0] === 'string' && value.length >= 2
}

/** Short, serialisable description for an error's `details` (never the function). */
function describeRegistration(registration) {
  if (registration === null || typeof registration !== 'object') return typeof registration
  if (Array.isArray(registration)) {
    return registration.map((item) => (typeof item === 'function' ? 'function' : typeof item))
  }
  return { phase: registration.phase ?? null, handler: typeof registration.handler }
}

/**
 * Register a list of hook descriptors on a bus.
 *
 * Descriptors may be `{ phase, handler, … }` objects or `[phase, handler,
 * options?]` tuples, and an entry may itself be a list (flattened) or a
 * `{ registrations: [...] }` hook set. A malformed entry throws a `HookError`
 * instead of being skipped, so "0 hooks
 * registered" is never the silent result of a shape mistake.
 *
 * @param {object} bus
 * @param {Array<object|Array>|object} registrations
 * @returns {string[]} registered ids
 */
export function registerHooks(bus, registrations) {
  const ids = []
  /** @param {unknown} entry */
  const visit = (entry) => {
    if (entry === undefined || entry === null) return
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'registrations' in entry) {
      if (!Array.isArray(entry.registrations)) {
        throw new HookError('hook set registrations must be an array', {
          details: { registration: describeRegistration(entry) },
        })
      }
      visit(entry.registrations)
      return
    }
    if (Array.isArray(entry) && !isTuple(entry)) {
      for (const nested of entry) visit(nested)
      return
    }
    const { phase, handler, options } = normalizeRegistration(entry)
    const { id, owner, priority = 0, once = false, traceless, context } = options
    // `bus.on` owns phase validation (including strict mode); the returned
    // unsubscribe closure is owned by the bus, not by the caller of this helper.
    bus.on(phase, handler, { id, owner, priority, once, traceless, context })
    ids.push(id ?? 'anonymous')
  }
  visit(registrations)
  return ids
}
