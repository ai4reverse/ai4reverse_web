/**
 * Typed errors for the constraint-solving component.
 *
 * The analyzer is deliberately tolerant: an expression it cannot translate is
 * a *result* (`supported: false`), not a thrown error. These classes cover the
 * programming errors a caller makes — a malformed expression source, an
 * unsupported option, or a solver that cannot be loaded — so callers can branch
 * on the failure class without matching message text.
 */

import { AnalyzerError } from '../util/errors.js'

export class ConstraintError extends AnalyzerError {
  constructor(message, options = {}) {
    super(message, { code: 'CONSTRAINT_ERROR', ...options })
  }
}

export class ConstraintSyntaxError extends ConstraintError {
  constructor(message, options = {}) {
    super(message, { code: 'CONSTRAINT_SYNTAX', ...options })
  }
}

export class ConstraintUnsupportedError extends ConstraintError {
  constructor(message, options = {}) {
    super(message, { code: 'CONSTRAINT_UNSUPPORTED', ...options })
  }
}
