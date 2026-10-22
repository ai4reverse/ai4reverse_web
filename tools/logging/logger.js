import pino from 'pino'

/**
 * Logging is pino-only (the objective explicitly requires pino / pino-pretty).
 * Nothing in `tools/` writes to stdout directly except the CLI renderer, which
 * receives already-serialised log lines.
 */

/**
 * Credential and header spellings that are not covered by camelCase field
 * names. Header keys are matched in their canonical spellings because pino
 * path matching is case-sensitive.
 */
const CREDENTIAL_FIELD_NAMES = [
  'Set-Cookie',
  'setCookie',
  'set-cookie',
  'x-api-key',
  'X-Api-Key',
  'Proxy-Authorization',
  'access_token',
  'refresh_token',
  'api_key',
  'credential',
  'credentials',
]

/** Every credential spelling at the top level and at one and two wildcard depths. */
const CREDENTIAL_REDACT_PATHS = CREDENTIAL_FIELD_NAMES.flatMap((name) => [
  name,
  `*.${name}`,
  `*.*.${name}`,
])

/** Fields that must never reach a log sink verbatim. */
export const redactPaths = [
  'cookie',
  'document.cookie',
  'headers.cookie',
  'headers.authorization',
  'authorization',
  'Authorization',
  'apiKey',
  'session',
  'jwt',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'payload.password',
  'body.password',
  '*.cookie',
  '*.authorization',
  '*.Authorization',
  '*.password',
  '*.token',
  '*.set-cookie',
  '*.apiKey',
  '*.session',
  '*.jwt',
  '*.*.cookie',
  '*.*.authorization',
  '*.*.Authorization',
  '*.*.apiKey',
  '*.*.session',
  '*.*.jwt',
  '*.*.password',
  '*.*.token',
  '*.*.set-cookie',
  ...CREDENTIAL_REDACT_PATHS,
]

const DEFAULT_LEVEL = process.env.AI4REVERSE_LOG_LEVEL || 'info'

/**
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {boolean} [options.pretty]  force pretty output (default: TTY detection)
 * @param {NodeJS.WritableStream} [options.destination]
 * @param {string} [options.name]
 * @param {object} [options.base]
 * @param {boolean} [options.redact]
 * @returns {import('pino').Logger}
 */
export function createLogger(options = {}) {
  const {
    level = DEFAULT_LEVEL,
    pretty = process.stdout.isTTY && !process.env.NO_COLOR,
    destination,
    name = 'ai4reverse',
    base = {},
    redact = true,
    transport,
  } = options

  /** @type {import('pino').LoggerOptions} */
  const config = {
    name,
    level,
    base: { pid: process.pid, ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label }
      },
    },
    ...(redact ? { redact: { paths: redactPaths, censor: '[redacted]' } } : {}),
  }

  if (transport) {
    return pino({ ...config, transport })
  }

  if (pretty && (destination === undefined || typeof destination === 'number')) {
    return pino({
      ...config,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: process.stdout.isTTY && !process.env.NO_COLOR,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
          messageFormat: '{if name}[{name}] {end}{msg}',
          ...(typeof destination === 'number' ? { destination } : {}),
        },
      },
    })
  }

  if (destination !== undefined && destination !== null) {
    if (typeof destination === 'number') {
      return pino(config, pino.destination({ dest: destination, sync: true }))
    }
    return pino(config, destination)
  }

  return pino(config)
}

/**
 * A pino destination that collects log records in memory. Tests and the
 * analysis orchestrator use it to assert on emitted traces without spawning a
 * worker thread for pino-pretty.
 */
export function createMemoryDestination() {
  /** @type {string[]} */
  const lines = []
  const stream = {
    write(chunk) {
      lines.push(String(chunk))
      return true
    },
    lines,
    /** @returns {object[]} parsed JSON records */
    records() {
      return lines
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { msg: line }
          }
        })
    },
    clear() {
      lines.length = 0
    },
    end() {},
  }
  return stream
}

/**
 * Bridge between the structured trace recorder and pino.
 *
 * Each trace event becomes one log line whose `msg` is stable and greppable
 * (`trace.api`, `trace.exception`, ...) and whose payload stays structured.
 *
 * @param {{logger: import('pino').Logger, level?: string, maxEvents?: number}} options
 */
export function createEventSink({ logger, level = 'trace', maxEvents = 0 } = {}) {
  const counts = new Map()
  const buffer = []
  const child = logger.child({ component: 'trace' })

  return {
    /** @param {object} event */
    write(event) {
      const kind = event.kind ?? 'unknown'
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      if (maxEvents > 0) {
        if (buffer.length >= maxEvents) buffer.shift()
        buffer.push(event)
      }
      const method = typeof child[level] === 'function' ? level : 'trace'
      child[method]({ evt: event }, `trace.${kind}.${event.phase ?? 'emit'}`)
    },
    /** @param {object[]} events */
    writeAll(events) {
      for (const event of events) this.write(event)
    },
    flush() {
      // pino flushes synchronously for sync destinations; transports are async
      // but hold their own queue. Nothing to do beyond an explicit flush call
      // when a transport is configured.
      if (typeof child.flush === 'function') child.flush()
    },
    counts() {
      return Object.fromEntries(counts)
    },
    buffer,
  }
}

/**
 * Child logger scoped to one analysis run.
 * @param {import('pino').Logger} logger
 * @param {{runId: string, sample?: string}} scope
 */
export function scopeLogger(logger, scope) {
  const child = logger.child(scope)
  return {
    logger: child,
    info: (...args) => child.info(...args),
    warn: (...args) => child.warn(...args),
    error: (...args) => child.error(...args),
    debug: (...args) => child.debug(...args),
    trace: (...args) => child.trace(...args),
    child: (bindings) => scopeLogger(child, bindings),
  }
}
