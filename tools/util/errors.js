/**
 * Typed errors so callers can branch on failure class without string matching.
 *
 * Every class below is thrown by a real code path; the list is deliberately
 * short so `catch (error) { if (error instanceof X) }` stays meaningful.
 * `SandboxError` covers initialisation and run failures, `ParseError` a source
 * that no parser configuration accepts, `HookError` a malformed hook phase or
 * handler registration.
 */

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

export class ParseError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'PARSE_ERROR', ...options })
  }
}

export class HookError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'HOOK_ERROR', ...options })
  }
}
