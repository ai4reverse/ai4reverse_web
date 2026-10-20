/**
 * Engine layer: QuickJS runtime lifecycle and execution limits.
 *
 * Shared downward dependency of the sandbox (which composes a runtime into a
 * sandboxed environment) and the invocation layer (which needs the limit
 * vocabulary and the host-side stack-exhaustion classifier). Nothing in here
 * imports from a sibling subsystem, so the sandbox <-> invocation layering
 * stays a DAG.
 */
export { loadQuickJS, createRuntime, isHostStackExhaustion, guardHostStackExhaustion } from './runtime.js'
export { normalizeLimits, DEFAULT_LIMITS, limitMessage } from './limits.js'
