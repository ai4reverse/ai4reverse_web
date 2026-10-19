/**
 * Exception hooks.
 *
 * They cannot suppress an exception (that would change sample behaviour) but
 * they can stop it from aborting analysis, classify it, and hand it to a
 * callback. `onUncaught` is the integration point used by the orchestrator to
 * trigger stage extraction when a loader throws after decrypting its payload.
 */

export function createExceptionHooks(options = {}) {
  const { trace, onUncaught, onCaught, onPromiseJob, maxCalls = 1000 } = options
  let calls = 0
  const seen = new Set()

  const guard = () => calls < maxCalls

  return [
    {
      phase: 'exception:uncaught',
      owner: 'exception-hooks',
      priority: 100,
      traceless: { addsGlobals: false, preservesIdentity: true, preservesStack: true },
      handler(payload) {
        if (!guard()) return undefined
        calls += 1
        const key = `${payload.origin}:${payload.error?.name}:${payload.error?.message}`
        if (!seen.has(key)) {
          seen.add(key)
          trace?.emit('exception', 'emit', {
            event: 'uncaught',
            origin: payload.origin,
            name: payload.error?.name,
            message: payload.error?.message,
            stack: payload.error?.stack,
          })
        }
        try {
          onUncaught?.(payload)
        } catch (error) {
          trace?.emit('hook', 'error', { hook: 'exception-hooks', message: error.message })
        }
        return undefined
      },
    },
    {
      phase: 'exception:catch',
      owner: 'exception-hooks',
      priority: 10,
      handler(payload) {
        if (!guard()) return undefined
        calls += 1
        try {
          onCaught?.(payload)
        } catch (error) {
          trace?.emit('hook', 'error', { hook: 'exception-hooks', message: error.message })
        }
        return undefined
      },
    },
  ]
}
