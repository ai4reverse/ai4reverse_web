/**
 * Rewrite the interpreter's cell-initialisation loop into real initialisers.
 *
 * The VM installs a box (`{ v: … }`) for every register in a contiguous range
 * before a function body runs:
 *
 *   for (var t = n, i = t.A[6][0], o = 868; o < 1146; o++) t.A[o] = { v: void 0 }
 *
 * The lift turns `t.A[<literal>]` into a register name, but the loop index is
 * computed at run time, so the store stayed as a write into the *lifted* state
 * object. Nothing reads that object, so the boxes the rest of the body expects
 * — `mod947.v = { … }`, `r22.v = …` — were never created and the first store
 * threw `TypeError` on `undefined`.
 *
 * The range is static in every occurrence (the interpreter must know which
 * registers to clear), so the loop is replaced by one assignment per cell. The
 * counter is left holding its post-loop value, and the rest of the init
 * declaration (`t = __state`, `i = t.A[6][0]`) is preserved verbatim, because
 * handlers read those aliases later.
 *
 * A loop whose bounds are not numeric literals is left untouched and counted:
 * a dynamic range means the index-to-name mapping is not statically knowable,
 * and silently dropping the initialisation would be worse than a visible count.
 */

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/**
 * Match `for (<init>; <counter> < <end>; <counter>++) <body>` where the body is
 * exactly `<state>[<counter>] = <value>`.
 */
export function matchCellInitLoop(node, t) {
  if (!t.isForStatement(node)) return null
  if (!t.isVariableDeclaration(node.init, { kind: 'var' })) return null
  if (!t.isBinaryExpression(node.test, { operator: '<' })) return null
  if (!t.isUpdateExpression(node.update, { operator: '++', prefix: false })) return null
  if (!t.isIdentifier(node.test.left)) return null
  if (!t.isNumericLiteral(node.test.right)) return null
  const counter = node.test.left.name
  if (!t.isIdentifier(node.update.argument, { name: counter })) return null

  // The emitter always wraps the body in a block; a bare statement is the same
  // shape. More than one statement means the loop is not a pure initialiser.
  const bodyStatements = t.isBlockStatement(node.body) ? node.body.body : [node.body]
  if (bodyStatements.length !== 1) return null
  const [single] = bodyStatements
  if (!t.isExpressionStatement(single)) return null

  const assign = single.expression
  if (!t.isAssignmentExpression(assign, { operator: '=' })) return null
  const left = assign.left
  if (!t.isMemberExpression(left, { computed: true })) return null
  if (!t.isIdentifier(left.object, { name: '__state' })) return null
  if (!t.isIdentifier(left.property, { name: counter })) return null

  const startDeclarator = node.init.declarations.find((d) => t.isIdentifier(d.id, { name: counter }))
  if (!startDeclarator || !t.isNumericLiteral(startDeclarator.init)) return null

  return {
    init: node.init,
    counter,
    start: startDeclarator.init.value,
    end: node.test.right.value,
    value: assign.right,
  }
}

/**
 * Rewrite every matched loop inside a function body.
 *
 * @param {object} body  a BlockStatement (the function body)
 * @param {object} t     @babel/types
 * @param {object} options
 * @param {(index: number) => string} options.nameOf    cell name for a register index
 * @param {number} options.moduleBase                   first module-scope index
 * @param {(name: string) => void} options.onFrameName  report a frame-local cell name
 * @param {(name: string) => void} options.onModuleName report a module-scope cell name
 * @returns {{ rewritten: number, cells: number }}
 */
export function rewriteCellInitLoops(body, t, options) {
  const { nameOf, moduleBase, onFrameName, onModuleName } = options
  const stats = { rewritten: 0, cells: 0 }

  const expand = (match) => {
    const statements = []
    if (match.init.declarations.length) statements.push(t.variableDeclaration('var', match.init.declarations))
    for (let index = match.start; index < match.end; index++) {
      const name = nameOf(index)
      if (index >= moduleBase) onModuleName(name)
      else onFrameName(name)
      statements.push(
        t.expressionStatement(t.assignmentExpression('=', t.identifier(name), t.cloneNode(match.value, true))),
      )
      stats.cells++
    }
    // The counter survives a real `for` loop holding its exit value.
    statements.push(
      t.expressionStatement(t.assignmentExpression('=', t.identifier(match.counter), t.numericLiteral(match.end))),
    )
    stats.rewritten++
    return statements
  }

  /** Rewrite a statement list in place. */
  const processList = (list) => {
    for (let i = 0; i < list.length; i++) {
      const statement = list[i]
      if (FUNCTION_TYPES.has(statement.type)) continue
      const match = matchCellInitLoop(statement, t)
      if (match) {
        const replacements = expand(match)
        list.splice(i, 1, ...replacements)
        i += replacements.length - 1
        continue
      }
      processNode(statement)
    }
  }

  /** Walk a node's children; a matched loop in a single-statement slot becomes a block. */
  const processNode = (node) => {
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const value = node[key]
      if (Array.isArray(value)) {
        if (value.length && value[0] && typeof value[0].type === 'string') processList(value)
        continue
      }
      if (!value || typeof value.type !== 'string') continue
      if (FUNCTION_TYPES.has(value.type)) continue
      const nested = matchCellInitLoop(value, t)
      if (nested) node[key] = t.blockStatement(expand(nested))
      else processNode(value)
    }
  }

  processList(body.body)
  return stats
}
