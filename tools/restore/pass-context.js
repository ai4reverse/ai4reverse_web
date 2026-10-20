import { generateExpression } from './generate.js'

import { traverse, template, types } from '../util/babel.js'

export { traverse, template, types }

// The helpers below say `t` for the Babel types namespace, as the passes do.
const t = types

/**
 * Build the `context` object handed to every restoration pass. Centralising it
 * means passes only depend on this contract (see docs/CONTRACTS.md) and can be
 * unit-tested in isolation.
 *
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {object} [options.passOptions]
 * @param {(change: object) => void} [options.report]
 */
export function createPassContext(options = {}) {
  const notes = []
  const changes = []
  const report =
    options.report ??
    ((change) => {
      changes.push(change)
    })

  return {
    types,
    traverse,
    template,
    logger: options.logger ?? null,
    options: options.passOptions ?? {},
    report,
    /** Record a human-readable note in the pass report. */
    note(message) {
      notes.push(String(message))
    },
    /** Convenience: replace a node and count it as a change. */
    replace(path, node) {
      path.replaceWith(node)
      report({ action: 'replace', type: node.type })
      path.skip?.()
    },
    notes,
    changes,
  }
}

/**
 * Standard pass execution wrapper: runs `run`, gathers `{changed, notes}` and
 * never lets a pass crash the pipeline unless `strict` is set.
 *
 * @param {{id?: string, meta?: {id: string}, run: Function}} pass
 * @param {object} ast
 * @param {object} [options]
 */
export function runPass(pass, ast, options = {}) {
  const id = pass.id ?? pass.meta?.id ?? 'unknown'
  const context = createPassContext(options)
  const started = Date.now()
  let result
  try {
    result = pass.run(ast, context)
  } catch (error) {
    // Fail-closed (P0-8): surface the error and mark the pass failed rather
    // than silently reporting changed:false after a partial AST mutation.
    if (options.strict) throw error
    context.note(`pass threw: ${error.message}`)
    return {
      id,
      changed: context.changes.length > 0,
      notes: context.notes,
      changes: context.changes,
      error: { message: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') },
      failed: true,
      durationMs: Date.now() - started,
    }
  }
  const normalized =
    result && typeof result === 'object'
      ? { changed: Boolean(result.changed), notes: [...(result.notes ?? []), ...context.notes] }
      : { changed: false, notes: context.notes }
  return {
    id,
    changed: normalized.changed,
    notes: normalized.notes,
    changes: result?.changes ?? context.changes,
    durationMs: Date.now() - started,
  }
}

/**
 * True when replacing `path` with a string literal would turn the statement into
 * a directive prologue entry (changing strictness). Shared by every pass that can
 * materialise a string.
 * @param {object} path Babel NodePath
 */
export function isDirectiveSlot(path) {
  const statement = path.parentPath
  if (!statement || statement.node.type !== 'ExpressionStatement') return false
  if (statement.node.directive != null) return true
  const body = statement.parentPath?.node.body
  const index = Array.isArray(body) ? body.indexOf(statement.node) : -1
  if (index < 0) return false
  return body.slice(0, index).every(isPrologueEntry)
}

/** One entry of a possible directive prologue. */
export function isPrologueEntry(node) {
  if (!node) return false
  if (node.type === 'Directive') return true
  return node.type === 'ExpressionStatement' && node.expression?.type === 'StringLiteral'
}

/**
 * True when the path is inside a `with` block. Static scope lookups cannot
 * prove anything there, so fold passes must bail out.
 * @param {object} path Babel NodePath
 */
export function inWithScope(path) {
  if (!path || typeof path.findParent !== 'function') return false
  return Boolean(path.findParent((parent) => parent.isWithStatement?.()))
}

/**
 * Compare the source text a node generates with the text its replacement would
 * generate.
 *
 * `changed` feeds the `STATIC_RESTORATION` verdict weight and
 * `stopOnNoChange`, and every pass declares `idempotent: true`. A pass may
 * therefore only claim a change when the generated text actually differs:
 * rewriting a node into textually identical output is not a change, and
 * reporting one makes the pipeline miss its own fixed point (see
 * docs/EVALUATION-TOOLS.md D5).
 *
 * @param {object} node - node currently in the AST
 * @param {object} replacement - node that would replace it
 * @returns {{from: string, to: string, changed: boolean}}
 */
export function compareGeneratedText(node, replacement) {
  const from = generateExpression(node)
  const to = generateExpression(replacement)
  return { from, to, changed: from !== to }
}

/** Convert a JS value to a Babel expression node. */
export function valueToNode(value) {
  if (value === undefined) return t.identifier('undefined')
  if (value === null) return t.nullLiteral()
  if (typeof value === 'string') return t.stringLiteral(value)
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return t.identifier('NaN')
    if (!Number.isFinite(value)) return value > 0 ? t.identifier('Infinity') : t.unaryExpression('-', t.identifier('Infinity'))
    return value < 0 ? t.unaryExpression('-', t.numericLiteral(-value)) : t.numericLiteral(value)
  }
  if (typeof value === 'boolean') return t.booleanLiteral(value)
  if (typeof value === 'bigint') return t.bigIntLiteral(value.toString())
  if (Array.isArray(value)) return t.arrayExpression(value.map(valueToNode))
  if (typeof value === 'object') {
    return t.objectExpression(
      Object.entries(value).map(([key, item]) =>
        t.objectProperty(t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key), valueToNode(item)),
      ),
    )
  }
  return t.identifier('undefined')
}
