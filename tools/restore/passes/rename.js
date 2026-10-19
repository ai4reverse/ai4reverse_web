/**
 * Cosmetic renaming of obfuscated `_0x...` locals (order 90).
 *
 * The pass only renames *local* bindings declared with `var`/`let`/`const`
 * inside a function, and only when the name matches `/_0x[0-9a-f]+/i`. The new
 * name is derived from the declarator's first (and, because the binding must be
 * constant, only) assignment:
 *
 *   var _0x1a = function init() {}   ->  init
 *   var _0x2b = 'getElementById'     ->  str_getElementById
 *   var _0x3c = new XMLHttpRequest() ->  obj_XMLHttpRequest
 *
 * Collisions are resolved with `_1`, `_2`, ... against every identifier that
 * already occurs in the file, so a rename can never capture a reference in a
 * nested scope. Rejected cases (left untouched, no risk):
 *
 * - program-level declarations: they are globals (in a classic script a top
 *   level `var` even creates a property on the global object),
 * - bindings that are reassigned anywhere (`binding.constant === false`), so
 *   "first assignment" is unambiguous,
 * - bindings referenced before the declarator,
 * - initialisers that are not a function, a string literal or `new X`,
 * - functions whose subtree contains a direct `eval` or a `with` statement,
 *   where static binding information is not trustworthy,
 * - properties and exports are never touched because only scope bindings are
 *   renamed (`scope.rename` rewrites references, never member names).
 */

/** Names produced by the obfuscator this pass targets. */
const OBFUSCATED_NAME = /^_0x[0-9a-f]+$/i

/** Longest identifier fragment taken from a string literal / callee name. */
const MAX_NAME_FRAGMENT = 24

/** Mappings listed verbatim in the summary note before it is truncated. */
const MAX_REPORTED_MAPPINGS = 10

export const meta = {
  id: 'rename',
  order: 90,
  description: 'rename obfuscated _0x[0-9a-f]+ locals from their first assignment',
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
  const usedNames = collectIdentifierNames(ast, context)
  const unsafeScopes = new WeakMap()
  const mappings = []
  let changed = false

  context.traverse(ast, {
    VariableDeclarator(path) {
      const name = path.node.id?.name
      if (!name || !OBFUSCATED_NAME.test(name)) return
      if (!path.node.init) return

      const functionPath = path.getFunctionParent()
      if (!functionPath) return

      const binding = path.scope.getBinding(name)
      if (!binding || binding.path.node !== path.node) return
      if (binding.kind !== 'var' && binding.kind !== 'let' && binding.kind !== 'const') return
      if (!binding.constant) return
      if (isReferencedBeforeDeclaration(binding)) return
      if (hasDynamicScope(functionPath, unsafeScopes)) return

      const base = deriveName(path.node.init, t)
      if (!base) return

      const next = uniqueName(base, usedNames)
      usedNames.add(next)
      path.scope.rename(name, next)
      report({ rule: 'rename', from: name, to: next })
      mappings.push(`${name} -> ${next}`)
      changed = true
    },
  })

  if (mappings.length > 0) {
    const shown = mappings.slice(0, MAX_REPORTED_MAPPINGS).join(', ')
    const rest = mappings.length > MAX_REPORTED_MAPPINGS ? ` (+${mappings.length - MAX_REPORTED_MAPPINGS} more)` : ''
    note(`rename: ${mappings.length} local binding(s) renamed: ${shown}${rest}`)
  }

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
 * @param {object} context
 * @returns {(change: {rule: string, from: string, to: string}) => void}
 */
function createReporter(context) {
  if (typeof context.report !== 'function') return () => {}
  return (change) => context.report({ pass: meta.id, ...change })
}

/**
 * Every identifier spelled anywhere in the file. Using the file-wide set (not
 * just the target scope) keeps generated names from shadowing anything.
 * @param {object} ast
 * @param {object} context
 * @returns {Set<string>}
 */
function collectIdentifierNames(ast, context) {
  const names = new Set()
  context.traverse(ast, {
    Identifier(path) {
      names.add(path.node.name)
    },
    PrivateName(path) {
      names.add(`#${path.node.id.name}`)
    },
  })
  return names
}

/**
 * @param {object} binding
 * @returns {boolean} true when a reference appears before the declarator
 */
function isReferencedBeforeDeclaration(binding) {
  const declarationStart = binding.identifier?.start
  if (typeof declarationStart !== 'number') return false
  return binding.referencePaths.some((reference) => typeof reference.node.start === 'number' && reference.node.start < declarationStart)
}

/**
 * Direct `eval` or `with` anywhere inside the function makes static bindings
 * unreliable, so the whole function is skipped.
 * @param {object} functionPath
 * @param {WeakMap<object, boolean>} cache
 * @returns {boolean}
 */
function hasDynamicScope(functionPath, cache) {
  const node = functionPath.node
  const cached = cache.get(node)
  if (cached !== undefined) return cached

  let found = false
  functionPath.traverse({
    WithStatement() {
      found = true
    },
    CallExpression(path) {
      if (path.node.callee?.type !== 'Identifier' || path.node.callee.name !== 'eval') return
      if (path.scope.getBinding('eval')) return
      found = true
    },
  })
  cache.set(node, found)
  return found
}

/**
 * Derive a readable identifier from the first assignment, or null when the
 * initialiser is not one of the supported shapes.
 * @param {object} init declarator initialiser
 * @param {object} t
 * @returns {string|null}
 */
function deriveName(init, t) {
  if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
    const functionName = t.isFunctionExpression(init) ? init.id?.name : null
    return withPrefix('fn', functionName ?? 'anonymous')
  }
  const literal = stringLiteralValue(init, t)
  if (literal !== null) return withPrefix('str', literal)
  if (t.isNewExpression(init) && t.isIdentifier(init.callee)) return withPrefix('obj', init.callee.name)
  return null
}

/**
 * @param {object} node
 * @param {object} t
 * @returns {string|null}
 */
function stringLiteralValue(node, t) {
  if (t.isStringLiteral(node)) return node.value
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  return null
}

/**
 * Build `<prefix>_<slug>`, never returning something that still looks like an
 * obfuscated name (otherwise the pass would rename its own output).
 * @param {string} prefix
 * @param {string} source
 * @returns {string}
 */
function withPrefix(prefix, source) {
  const slug = slugify(source)
  const candidate = `${prefix}_${slug}`
  return OBFUSCATED_NAME.test(candidate) ? `${prefix}_local_${slug}` : candidate
}

/**
 * @param {string} text
 * @returns {string} an identifier-safe fragment
 */
function slugify(text) {
  const cleaned = String(text)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_NAME_FRAGMENT)
  if (cleaned === '') return 'value'
  return /^[0-9]/.test(cleaned) ? `v${cleaned}` : cleaned
}

/**
 * @param {string} base
 * @param {Set<string>} usedNames
 * @returns {string} `base` or `base_1`, `base_2`, ... when already taken
 */
function uniqueName(base, usedNames) {
  if (!usedNames.has(base)) return base
  let index = 1
  while (usedNames.has(`${base}_${index}`)) index += 1
  return `${base}_${index}`
}
