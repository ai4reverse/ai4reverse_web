/**
 * Barrel for the logging subpath (`ai4reverse-web/logging`).
 *
 * The package `exports` map points here so a consumer can import the logging
 * surface without reaching into `tools/logging/logger.js`.
 */
export { createLogger, createEventSink, createMemoryDestination, redactPaths, scopeLogger } from './logger.js'
