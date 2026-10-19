/**
 * Literal `eval` / `Function` unwrapping and one-layer literal decoding (order 80).
 *
 * What is rewritten, and why it is safe:
 *
 * - `eval('<literal>')` used as a whole expression statement: the statement's
 *   value is discarded, so its only effect is running the parsed program. The
 *   parsed statements are spliced in as a BlockStatement, which reproduces the
 *   eval-local `let`/`const` scope. Skipped (with a note) when the literal has
 *   a directive prologue (a `'use strict'` inside a block would stop applying),
 *   a top-level function declaration (Annex B block semantics), when `eval` is
 *   shadowed locally, or when the literal does not parse cleanly.
 * - `new Function('a', 'b', 'return a + b')` / `Function(...)` with literal
 *   arguments: replaced by an equivalent function expression. The function
 *   constructor always creates *sloppy* functions that resolve free variables
 *   against the global scope; a function expression inherits the enclosing
 *   strictness and resolves free variables lexically. The rewrite therefore
 *   only fires in sloppy code whose body does not close over a local binding of
 *   an enclosing function. Accepted cosmetic difference: an assigned function
 *   expression gets an inferred `.name` where the constructor's result was
 *   `anonymous`.
 * - One layer of trivially literal decoding: `atob('<base64>')` when it decodes
 *   to printable ASCII, and `String.fromCharCode(<numbers>)` when every code
 *   unit is printable ASCII. Binary payloads are left alone (a string literal
 *   round-trip would lose the byte semantics) and noted.
 *
 * `eval` used as a value (`x = eval`, `(0, eval)(...)`, `foo(eval('...'))`) is
 * never rewritten: the value of the call or of `eval` itself is observable there.
 */

import { parse } from '../parse.js'
import { isDirectiveSlot, inWithScope } from '../pass-context.js'

/** Base64 alphabet check; `atob` rejects anything else. */
const BASE64_LITERAL = /^[A-Za-z0-9+/]*={0,2}$/

/** Code units that survive a string-literal round-trip unchanged. */
function isPrintableCodeUnit(code) {
  return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e)
}

/** Identifiers created by `new Function(a, b, body)` must be plain parameter names. */
const PARAMETER_LIST = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\s*,\s*[A-Za-z_$][A-Za-z0-9_$]*)*$/

export const meta = {
  id: 'eval-unwrap',
  order: 80,
  description: 'unwrap literal eval/Function bodies and decode trivially literal base64/charCode strings',
  idempotent: true,
}

/**
 * @param {object} ast Babel File/Program node, mutated in place
 * @param {object} context see docs/CONTRACTS.md ("Restoration pass contract")
 * @returns {{changed: boolean, notes: string[]}}
 */
export function run(ast, context) {
  const { types: t } = context
  const notes = []
  const note = createNoteRecorder(context, notes)
  const report = createReporter(context)
  let changed = false

  context.traverse(ast, {
    ExpressionStatement(path) {
      const expression = path.node.expression
      if (!t.isCallExpression(expression)) return
      if (!t.isIdentifier(expression.callee, { name: 'eval' })) return
      const statements = readDirectEvalStatements(expression, path, context, note)
      if (!statements) return
      if (statements.length === 0) {
        path.remove()
      } else {
        path.replaceWith(t.blockStatement(statements))
        path.skip()
      }
      report({ rule: 'eval', from: 'eval(<string literal>)', to: `${statements.length} statement(s)` })
      changed = true
    },

    CallExpression(path) {
      if (unwrapFunctionConstructor(path, context, note, report)) {
        changed = true
        return
      }
      if (decodeAtob(path, context, note, report) || decodeFromCharCode(path, context, note, report)) changed = true
    },

    NewExpression(path) {
      if (unwrapFunctionConstructor(path, context, note, report)) changed = true
    },
  })

  return { changed, notes }
}

/**
 * Passes report through `context.note` when the pipeline provides it and
 * through the returned notes otherwise, so a message is never recorded twice.
 * @param {object} context
 * @param {string[]} notes
 * @returns {(message: string) => void}
 */
function createNoteRecorder(context, notes) {
  const sink = typeof context.note === 'function' ? (message) => context.note(message) : (message) => notes.push(message)
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    sink(message)
  }
}

/**
 * Record one change in the pass report when the pipeline provides a reporter.
 * Only used where a rewrite actually happens, so the report never claims a
 * change that was skipped for safety.
 * @param {object} context
 * @returns {(change: {rule: string, from: string, to: string}) => void}
 */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/**
 * @param {object} node
 * @param {object} t
 * @returns {string|null} the string value of a literal string / plain template
 */
function literalString(node, t) {
  if (!node) return null
  if (t.isStringLiteral(node)) return node.value
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  return null
}

/**
 * @param {object} node
 * @param {string} line
 * @returns {string}
 */
/**
 * Reject `await`, `super` and `new.target` anywhere in a Function-constructor
 * body: those are syntax errors in `new Function('...')`.
 * @param {object} program
 */
function containsScopeEscape(program) {
  const stack = [program]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === 'AwaitExpression' || node.type === 'Super' || node.type === 'MetaProperty') return true
    for (const value of Object.values(node)) {
      if (!value || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') stack.push(item)
      } else if (value.type) {
        stack.push(value)
      }
    }
  }
  return false
}

function atLine(node, line) {
  return `${line}${node.loc?.start?.line ? ` at line ${node.loc.start.line}` : ''}`
}

/**
 * Parse a literal program body, reporting why it was rejected.
 * @param {string} source
 * @param {string} what description used in the note
 * @param {(message: string) => void} note
 * @returns {object|null} parsed Program node
 */
function parseLiteralProgram(source, what, note, mode = 'eval') {
  try {
    // `eval` bodies are strict about return/await/super/new.target; `Function`
    // bodies allow `return` but nothing else from the enclosing scope.
    const parsed = parse(source, {
      sourceType: 'script',
      allowReturnOutsideFunction: mode === 'function',
      allowAwaitOutsideFunction: false,
      allowSuperOutsideMethod: false,
      allowNewTargetOutsideFunction: false,
    })
    if (parsed.errors.length > 0) {
      note(`eval-unwrap: ${what} left untouched (concatenated literal does not parse cleanly)`)
      return null
    }
    if (mode === 'function' && containsScopeEscape(parsed.ast.program)) {
      note(`eval-unwrap: ${what} left untouched (uses await/super/new.target, which an eval body cannot)`)
      return null
    }
    return parsed.ast.program
  } catch (error) {
    note(`eval-unwrap: ${what} left untouched (parse failed: ${error.message})`)
    return null
  }
}

/**
 * Statements produced by a direct `eval('<literal>')` expression statement.
 * @param {object} expression the CallExpression
 * @param {object} path NodePath of the enclosing ExpressionStatement
 * @param {object} context
 * @param {(message: string) => void} note
 * @returns {object[]|null} statements to splice, or null to leave the node
 */
function readDirectEvalStatements(expression, path, context, note) {
  const { types: t } = context
  if (expression.arguments.length !== 1) return null
  const source = literalString(expression.arguments[0], t)
  if (source === null) return null

  if (path.scope.getBinding('eval')) {
    note(atLine(expression, 'eval-unwrap: local binding shadows eval, call left untouched'))
    return null
  }

  if (isDirectiveSlot(path)) {
    note(atLine(expression, 'eval-unwrap: statement is a directive prologue slot, left untouched'))
    return null
  }

  const program = parseLiteralProgram(source, 'eval(...) call', note, 'eval')
  if (!program) return null

  if (program.directives.length > 0) {
    note(atLine(expression, "eval-unwrap: eval body starts with a directive, left untouched (strictness would change)"))
    return null
  }
  if (program.body.some((statement) => t.isFunctionDeclaration(statement))) {
    note(atLine(expression, 'eval-unwrap: eval body declares a function, left untouched (block scoping would change)'))
    return null
  }
  for (const statement of program.body) stripPositions(statement, t)
  return program.body
}

/**
 * Nodes parsed from a *different* source keep offsets that belong to that
 * source. Leaving them in place would make positional heuristics in later
 * passes ("referenced before the declaration", "declaration precedes loop")
 * draw wrong conclusions, so spliced nodes are left position-less instead.
 * @param {object} node
 * @param {object} t
 */
function stripPositions(node, t) {
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    delete current.start
    delete current.end
    delete current.loc
    delete current.range
    for (const key of t.VISITOR_KEYS[current.type] ?? []) {
      const child = current[key]
      if (Array.isArray(child)) {
        for (const item of child) stack.push(item)
      } else if (child) {
        stack.push(child)
      }
    }
  }
}

/**
 * Replace `new Function(...)` / `Function(...)` with a literal function expression.
 * @param {object} path NodePath of a CallExpression or NewExpression
 * @param {object} context
 * @param {(message: string) => void} note
 * @param {(change: object) => void} report
 * @returns {boolean} true when the node was replaced
 */
function unwrapFunctionConstructor(path, context, note, report) {
  const { types: t } = context
  const node = path.node
  if (!t.isIdentifier(node.callee, { name: 'Function' })) return false
  if (node.arguments.length === 0) return false

  const sources = []
  for (const argument of node.arguments) {
    const value = literalString(argument, t)
    if (value === null) return false
    sources.push(value)
  }

  if (path.scope.getBinding('Function')) {
    note(atLine(node, 'eval-unwrap: local binding shadows Function, call left untouched'))
    return false
  }

  const parameterSource = sources.slice(0, -1).join(',')
  const bodySource = sources[sources.length - 1]
  if (parameterSource.trim() !== '' && !PARAMETER_LIST.test(parameterSource.trim())) {
    note(atLine(node, 'eval-unwrap: Function() parameters are not plain identifiers, left untouched'))
    return false
  }
  const parameterNames = parameterSource
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

  if (path.isInStrictMode()) {
    note(atLine(node, 'eval-unwrap: Function() in strict code left untouched (created function would inherit strictness)'))
    return false
  }

  const program = parseLiteralProgram(bodySource, 'Function() body', note, 'function')
  if (!program) return false

  const closedOver = findClosedOverLocal(program, path, new Set(parameterNames), context)
  if (closedOver) {
    note(atLine(node, `eval-unwrap: Function() body reads local '${closedOver}', left untouched (scope would change)`))
    return false
  }

  for (const statement of program.body) stripPositions(statement, t)
  const functionExpression = t.functionExpression(
    null,
    parameterNames.map((name) => t.identifier(name)),
    t.blockStatement(program.body, program.directives),
  )
  path.replaceWith(functionExpression)
  path.skip()
  report({ rule: 'function-constructor', from: 'new Function(...)', to: 'function expression' })
  return true
}

/**
 * Names the parsed program reads from the global scope that are also bound by
 * an enclosing *function* scope at the call site. Program-level bindings are
 * globals in both forms, so they are not conflicts.
 * @param {object} program parsed Program node
 * @param {object} path NodePath of the constructor call
 * @param {Set<string>} parameterNames names bound by the created function
 * @param {object} context
 * @returns {string|null}
 */
function findClosedOverLocal(program, path, parameterNames, context) {
  const { types: t, traverse } = context
  const freeNames = new Set()

  traverse(t.file(t.program(program.body)), {
    ReferencedIdentifier(referencePath) {
      const name = referencePath.node.name
      if (parameterNames.has(name)) return
      if (referencePath.scope.getBinding(name)) return
      freeNames.add(name)
    },
  })

  for (const name of freeNames) {
    let scope = path.scope
    while (scope && !scope.path.isProgram()) {
      if (scope.hasOwnBinding(name)) return name
      scope = scope.parent
    }
  }
  return null
}

/**
 * `atob('<base64>')` -> string literal, when the payload is printable ASCII.
 * @param {object} path NodePath of a CallExpression
 * @param {object} context
 * @param {(message: string) => void} note
 * @param {(change: object) => void} report
 * @returns {boolean}
 */
function decodeAtob(path, context, note, report) {
  const { types: t } = context
  if (isDirectiveSlot(path)) return false
  const callee = path.node.callee
  if (!isGlobalCallee(callee, 'atob', path, context)) return false
  if (path.node.arguments.length !== 1) return false
  const encoded = literalString(path.node.arguments[0], t)
  if (encoded === null) return false
  const compact = encoded.replace(/\s+/g, '')
  if (!BASE64_LITERAL.test(compact) || compact.length % 4 !== 0) {
    note(atLine(path.node, 'eval-unwrap: atob() argument is not plain base64, left untouched'))
    return false
  }
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.toString('base64') !== compact) {
    note(atLine(path.node, 'eval-unwrap: atob() argument is not canonical base64, left untouched'))
    return false
  }
  for (const byte of bytes) {
    if (!isPrintableCodeUnit(byte)) {
      note(atLine(path.node, 'eval-unwrap: atob() decodes to non-printable bytes, left untouched'))
      return false
    }
  }
  path.replaceWith(t.stringLiteral(bytes.toString('latin1')))
  report({ rule: 'atob', from: compact, to: bytes.toString('latin1') })
  return true
}

/**
 * `String.fromCharCode(104, 105)` -> `'hi'`, when every unit is printable ASCII.
 * @param {object} path NodePath of a CallExpression
 * @param {object} context
 * @param {(message: string) => void} note
 * @param {(change: object) => void} report
 * @returns {boolean}
 */
function decodeFromCharCode(path, context, note, report) {
  const { types: t } = context
  if (isDirectiveSlot(path)) return false
  const callee = path.node.callee
  if (!t.isMemberExpression(callee) || callee.computed) return false
  if (!t.isIdentifier(callee.property, { name: 'fromCharCode' })) return false
  if (!t.isIdentifier(callee.object, { name: 'String' })) return false
  if (path.scope.getBinding('String')) return false
  if (path.node.arguments.length === 0) return false

  const codes = []
  for (const argument of path.node.arguments) {
    if (t.isNumericLiteral(argument)) {
      codes.push(argument.value)
      continue
    }
    if (t.isUnaryExpression(argument) && argument.operator === '-' && t.isNumericLiteral(argument.argument)) {
      codes.push(-argument.argument.value)
      continue
    }
    return false
  }
  const units = codes.map((code) => Math.trunc(code) & 0xffff)
  if (!units.every(isPrintableCodeUnit)) {
    note(atLine(path.node, 'eval-unwrap: String.fromCharCode() produces non-printable units, left untouched'))
    return false
  }
  path.replaceWith(t.stringLiteral(String.fromCharCode(...units)))
  report({ rule: 'fromCharCode', from: units.join(','), to: String.fromCharCode(...units) })
  return true
}

/**
 * True when `callee` is `<name>(` or `<window|self|globalThis>.<name>(` and the
 * name is not shadowed at the call site.
 * @param {object} callee
 * @param {string} name
 * @param {object} path
 * @param {object} context
 * @returns {boolean}
 */
function isGlobalCallee(callee, name, path, context) {
  const { types: t } = context
  if (inWithScope(path)) return false
  if (t.isIdentifier(callee, { name })) return !path.scope.getBinding(name)
  if (!t.isMemberExpression(callee) || callee.computed) return false
  if (!t.isIdentifier(callee.property, { name })) return false
  if (!t.isIdentifier(callee.object)) return false
  if (!['window', 'self', 'globalThis'].includes(callee.object.name)) return false
  return !path.scope.getBinding(callee.object.name)
}
