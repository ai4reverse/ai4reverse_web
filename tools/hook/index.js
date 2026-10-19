import { createHookBus, HOOK_PHASES } from './hookbus.js'
import { createCodeHooks, SUSPICIOUS_PATTERNS } from './code-hook.js'
import { createApiHooks } from './api-hook.js'
import { createExceptionHooks } from './exception-hook.js'
import { createAstHooks } from './ast-hook.js'

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
 * Register a list of hook descriptors on a bus.
 * @param {object} bus
 * @param {Array<{phase: string, handler: Function, options?: object, priority?: number, id?: string, owner?: string}>} registrations
 */
export function registerHooks(bus, registrations) {
  const ids = []
  for (const registration of registrations ?? []) {
    if (!registration || typeof registration.handler !== 'function' || !registration.phase) continue
    const {
      phase,
      handler,
      id,
      owner,
      priority = 0,
      once = false,
      traceless,
      context,
    } = registration
    const unsubscribe = bus.on(phase, handler, { id, owner, priority, once, traceless, context })
    ids.push(id ?? 'anonymous')
    void unsubscribe
  }
  return ids
}
