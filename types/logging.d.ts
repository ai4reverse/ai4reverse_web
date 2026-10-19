/**
 * Declarations for the `ai4reverse-web/logging` subpath.
 *
 * A pino factory with deterministic redaction, an in-memory destination for
 * tests, a trace sink and a run-scoped child logger.
 */

export {
  createLogger,
  createEventSink,
  createMemoryDestination,
  redactPaths,
  scopeLogger,
} from './ai4reverse.js'

export type {
  Logger,
  LoggerOptions,
  MemoryDestination,
  EventSink,
} from './ai4reverse.js'
