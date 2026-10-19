/**
 * Dead-code elimination pass.
 *
 * Obfuscators pad samples with branches and statements that can never run.
 * Removing them shrinks the code the analyst has to read without touching
 * anything observable:
 *
 * - `if (<constant>)` keeps only the reachable branch;
 * - `while (<constant falsy>)` is dropped;
 * - statements after `return`/`throw`/`break`/`continue` are unreachable;
 * - empty statements disappear.
 *
 * Guards: a branch is only dropped when its test is a side-effect free constant
 * (so nothing is skipped at runtime), and never when the dropped code declares
 * `var`/function/class bindings that hoisting would otherwise keep alive.
 * Directives are kept because Babel stores them separately from the body.
 */

import { generateExpression } from '../generate.js'

export const meta = {
  id: 'dead-code',
  order: 65,
  description: 'remove constant-dead branches, unreachable statements and empty statements',
  idempotent: true,
}

/** Branch replacement can expose new dead code; repeat until stable. */
const MAX_ROUNDS = 16

/** @param {object} context */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/**
 * Truthiness of a side-effect free constant expression.
 *
 * @param {object} t
 * @param {object} node
 * @param {object} scope - scope of the statement, used to detect shadowed globals
 * @returns {boolean|null} `null` when the test is not a provable constant
 */
function constantTruthiness(t, node, scope) {
  if (!node) return null
  if (t.isBooleanLiteral(node)) return node.value
  if (t.isNumericLiteral(node)) return node.value !== 0
  if (t.isStringLiteral(node)) return node.value.length > 0
  if (t.isNullLiteral(node)) return false
  if (t.isBigIntLiteral(node)) return node.value !== '0'
  if (t.isArrayExpression(node)) return node.elements.every((element) => !element || t.isPureish(element)) ? true : null
  if (t.isObjectExpression(node)) return node.properties.length === 0 ? true : null
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true
  if (t.isIdentifier(node)) {
    if (scope?.hasBinding(node.name, true)) return null
    if (node.name === 'undefined' || node.name === 'NaN') return false
    if (node.name === 'Infinity') return true
    return null
  }
  if (t.isUnaryExpression(node)) {
    if (node.operator === 'void') return t.isPureish(node.argument) ? false : null
    if (node.operator === '!') {
      const inner = constantTruthiness(t, node.argument, scope)
      return inner === null ? null : !inner
    }
  }
  return null
}

/**
 * @param {object} t
 * @param {object} node
 * @returns {boolean} true when dropping `node` could remove a hoisted binding
 */
function declaresBindings(t, node) {
  let found = false
  t.traverseFast(node, (child) => {
    if (
      t.isVariableDeclaration(child) ||
      t.isFunctionDeclaration(child) ||
      t.isClassDeclaration(child) ||
      t.isImportDeclaration(child)
    ) {
      found = true
    }
  })
  return found
}

/**
 * @param {object} t
 * @param {object} node
 * @returns {boolean} true when control flow never continues past `node`
 */
function isTerminating(t, node) {
  return (
    t.isReturnStatement(node) || t.isThrowStatement(node) || t.isBreakStatement(node) || t.isContinueStatement(node)
  )
}

/**
 * Remove statements that follow a terminating statement in a block.
 *
 * @param {object} t
 * @param {object} blockPath - Program or BlockStatement path
 * @param {function} report
 * @returns {number} removed statement count
 */
function pruneUnreachable(t, blockPath, report) {
  const body = blockPath.node.body
  let terminator = -1
  for (let index = 0; index < body.length; index += 1) {
    if (isTerminating(t, body[index])) {
      terminator = index
      break
    }
  }
  if (terminator === -1) return 0
  let removed = 0
  for (let index = body.length - 1; index > terminator; index -= 1) {
    if (declaresBindings(t, body[index])) continue
    report({ rule: 'unreachable', from: body[index].type, to: 'removed' })
    blockPath.get(`body.${index}`).remove()
    removed += 1
  }
  return removed
}

/**
 * Remove a statement, keeping the AST valid when a loop or branch owns it.
 *
 * @param {object} t
 * @param {object} path
 */
/**
 * True when the statement occupies a directive-prologue slot, so replacing it
 * with a bare string would change strictness.
 * @param {object} path
 */
function inPrologueSlot(path) {
  const body = path.parentPath?.node?.body
  const index = Array.isArray(body) ? body.indexOf(path.node) : -1
  if (index < 0) return false
  return body.slice(0, index).every(isPrologueEntry)
}

function removeStatement(t, path) {
  const parent = path.parentPath
  if (parent.isProgram() || parent.isBlockStatement() || parent.isSwitchCase()) {
    path.remove()
    return
  }
  path.replaceWith(t.emptyStatement())
}

/**
 * @param {object} ast
 * @param {object} context
 * @param {object} context.types
 * @param {object} context.traverse
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const { types: t, traverse } = context
  const report = createReporter(context)
  /** @type {string[]} */
  const notes = []
  let removed = 0

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let roundRemoved = 0

    traverse(ast, {
      IfStatement(path) {
        const truthiness = constantTruthiness(t, path.node.test, path.scope)
        if (truthiness === null) return
        const kept = truthiness ? path.node.consequent : path.node.alternate
        const dropped = truthiness ? path.node.alternate : path.node.consequent
        if (dropped && declaresBindings(t, dropped)) return
        if (kept && t.isFunctionDeclaration(kept)) return
        if (kept && kept.type === 'ExpressionStatement' && kept.expression?.type === 'StringLiteral' && inPrologueSlot(path)) return
        report({
          rule: 'constant-branch',
          from: generateExpression(path.node.test),
          to: truthiness ? 'then' : 'else',
        })
        if (kept) {
          path.replaceWith(kept)
        } else {
          removeStatement(t, path)
        }
        roundRemoved += 1
      },

      WhileStatement(path) {
        if (constantTruthiness(t, path.node.test, path.scope) !== false) return
        if (declaresBindings(t, path.node.body)) return
        report({ rule: 'while-false', from: generateExpression(path.node.test), to: 'removed' })
        removeStatement(t, path)
        roundRemoved += 1
      },

      EmptyStatement(path) {
        if (!path.parentPath.isProgram() && !path.parentPath.isBlockStatement() && !path.parentPath.isSwitchCase()) {
          return
        }
        report({ rule: 'empty-statement', from: ';', to: 'removed' })
        path.remove()
        roundRemoved += 1
      },
    })

    // Block pruning runs after branch removal so newly exposed blocks are handled.
    /** @type {object[]} */
    const blocks = []
    traverse(ast, {
      Program(path) {
        blocks.push(path)
      },
      BlockStatement(path) {
        blocks.push(path)
      },
    })
    for (const blockPath of blocks) {
      // A previous pruning round may have detached this block.
      if (!blockPath.node || blockPath.removed) continue
      roundRemoved += pruneUnreachable(t, blockPath, report)
    }

    removed += roundRemoved
    if (roundRemoved === 0) break
  }

  if (removed > 0) notes.push(`removed ${removed} dead statement${removed === 1 ? '' : 's'}`)
  return { changed: removed > 0, notes }
}
