/** Typed errors so callers can branch on failure class without string matching. */

export class AnalyzerError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown, details?: object}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = new.target.name
    this.code = options.code ?? 'ANALYZER_ERROR'
    this.details = options.details ?? {}
  }
}

export class SandboxError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'SANDBOX_ERROR', ...options })
  }
}

/** The guest script exceeded an execution limit. */
export class LimitationError extends SandboxError {
  /**
   * @param {'timeout'|'memory'|'stack'|'steps'} limit
   * @param {string} message
   * @param {object} [details]
   */
  constructor(limit, message, details = {}) {
    super(message, { code: 'SANDBOX_LIMIT', details: { limit, ...details } })
    this.limit = limit
  }
}

export class ParseError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'PARSE_ERROR', ...options })
  }
}

export class PassError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'PASS_ERROR', ...options })
  }
}

export class HookError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'HOOK_ERROR', ...options })
  }
}
