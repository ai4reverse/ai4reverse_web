#!/usr/bin/env node
/**
 * Recover the original bundle's module scope.
 *
 * `output/final.js` is a lift of the bundle's *functions* only: 351 top-level
 * `fn_N` declarations with no dispatch loop, no bytecode array and no
 * instruction pointer. Those functions still read a handful of bindings that
 * lived in the bundle's enclosing scopes — the host object `l`, the string
 * table `T`, the decoder memo `S`, the string decoder `m`, its UTF-8
 * constructor `D`, the base64 helper `R`, the constant table `k` and the
 * `typeof` helper `n`. None of them survive in `final.js`, so booting it dies
 * on the first such read.
 *
 * This stage walks the bundle's IIFEs and copies out exactly those statements:
 *
 *   1. `resources/mssdk.min.js` is parsed (script mode, error recovery on).
 *   2. The "program IIFE" is located structurally — the deepest immediately
 *      invoked function whose own top-level statements include the handler
 *      table (an array literal of ≥100 function expressions). Its enclosing
 *      scope supplies the UMD variables and the `typeof` helper.
 *   3. Each top-level statement is split into one unit per declarator and per
 *      comma-expression element, so a `var B = {}, O = …, T = […]` declaration
 *      can give up the bytecode blob while keeping the table.
 *   4. Units are selected from the free identifiers of `final.js` — plus the
 *      module-scope bindings this stage exists to recover — and closed over
 *      their own free references. Two shapes are dropped unconditionally,
 *      whatever they are named: an array literal of function expressions (the
 *      handler table) and a call chain carrying a very long encoded string
 *      (the inflated bytecode). Anything that cannot be classified is reported
 *      rather than guessed.
 *
 * Output: `output/module-scope.js`, a plain script fragment with no wrapper,
 * meant to be prepended to `final.js`. It parses on its own.
 *
 *   node src/tiktok/scripts/28-module-scope.mjs
 *   node src/tiktok/scripts/28-module-scope.mjs --trace T,S,l
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'

const generate = _generate.default ?? _generate
const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const RESOURCE = path.join(ROOT, 'resources', 'mssdk.min.js')
const FINAL = path.join(ROOT, 'output', 'final.js')
const OUT = path.join(ROOT, 'output', 'module-scope.js')

/** Array literal with at least this many function elements is the handler table. */
const HANDLER_TABLE_MIN = 100
/** Array literal with at least this many numeric elements is a bytecode table. */
const NUMERIC_TABLE_MIN = 1000

/**
 * Identifiers that exist without being declared by either file. The list is
 * deliberately explicit: the gap report is only honest if "global" means the
 * hosts we actually expect, not whatever Babel's built-in table contains.
 */
const GLOBALS = new Set([
  'window', 'self', 'globalThis', 'document', 'navigator', 'location', 'console',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'ReferenceError', 'Symbol', 'Promise', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'decodeURIComponent', 'encodeURIComponent',
  'escape', 'unescape', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'undefined',
  'NaN', 'Infinity', 'arguments', 'eval', 'Function', 'Proxy', 'Reflect',
  'BigInt', 'Intl', 'performance', 'crypto', 'XMLHttpRequest', 'atob', 'btoa',
  'exports', 'module', 'define',
])

/**
 * Bindings the recovery contract names explicitly. They are kept even when
 * `final.js` happens not to read them: a later lift pass may resolve a string
 * lazily and start reading one, and each is small next to the table.
 */
const CONTRACT_BINDINGS = new Set(['l', 'r', 'R', 'D', 'm', 'S', 'T'])

const read = (file) => fs.readFileSync(file, 'utf8')
const parseScript = (source) => parse(source, { sourceType: 'script', errorRecovery: true })
const nodeSize = (node) => (node.end ?? 0) - (node.start ?? 0)

const resourceAst = parseScript(read(RESOURCE))
const finalSource = read(FINAL)
const finalAst = parseScript(finalSource)

/* ------------------------------------------------------------------ */
/* Free identifiers of the lifted program                              */
/* ------------------------------------------------------------------ */

/** Names passed as `--trace a,b,c` are printed with a source excerpt. */
const traceArg = process.argv.indexOf('--trace')
const traced = new Set(
  traceArg === -1 ? [] : (process.argv[traceArg + 1] ?? '').split(',').map((name) => name.trim()).filter(Boolean),
)
const traceSites = new Map()

/**
 * Collect every identifier reference in `final.js` that no declaration in the
 * file binds. Babel's scope crawl resolves function parameters, hoisted `var`,
 * block-scoped `let`/`const` and catch parameters, so a name that is a local in
 * one function is not reported, while a genuine module-scope read is.
 *
 * @param {import('@babel/types').File} ast
 * @returns {Map<string, number>} free name → number of unbound references
 */
const collectFreeIdentifiers = (ast) => {
  const free = new Map()
  traverse(ast, {
    ReferencedIdentifier(p) {
      const { name } = p.node
      if (p.scope.hasBinding(name, true)) return
      free.set(name, (free.get(name) ?? 0) + 1)
      if (traced.has(name)) {
        const sites = traceSites.get(name) ?? []
        if (sites.length < 3) sites.push(p.node.start ?? 0)
        traceSites.set(name, sites)
      }
    },
  })
  return free
}

const freeCounts = collectFreeIdentifiers(finalAst)
const freeInFinal = new Set(freeCounts.keys())

/* ------------------------------------------------------------------ */
/* Structural discovery                                                */
/* ------------------------------------------------------------------ */

/** Is `node` an `(function () { … })()` call expression? */
const isIifeCall = (node) => t.isCallExpression(node) && t.isFunctionExpression(node.callee)

/** Array-literal element census. */
const arrayShape = (node) => {
  let functions = 0
  let numbers = 0
  let strings = 0
  let other = 0
  let holes = 0
  for (const element of node.elements) {
    if (!element) holes += 1
    else if (t.isFunctionExpression(element) || t.isArrowFunctionExpression(element)) functions += 1
    else if (t.isNumericLiteral(element)) numbers += 1
    else if (t.isUnaryExpression(element) && t.isNumericLiteral(element.argument)) numbers += 1
    else if (t.isStringLiteral(element)) strings += 1
    else other += 1
  }
  return { total: node.elements.length, functions, numbers, strings, other, holes }
}

/** Longest string literal anywhere under `node`. */
const longestString = (node) => {
  let longest = 0
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (t.isStringLiteral(value)) longest = Math.max(longest, value.value.length)
    for (const key of Object.keys(value)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = value[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object' && child.type) visit(child)
    }
  }
  visit(node)
  return longest
}

/** Readable callee path, e.g. `dwInfl.dwAbA`. */
const describeCallee = (call) => {
  const parts = []
  let node = call.callee
  while (t.isMemberExpression(node)) {
    parts.unshift(t.isIdentifier(node.property) ? node.property.name : '[…]')
    node = node.object
  }
  if (t.isIdentifier(node)) parts.unshift(node.name)
  return parts.length > 0 ? parts.join('.') : call.callee.type
}

/**
 * Shape verdict for a statement's initialiser.
 *
 * @param {import('@babel/types').Node | null} init
 * @returns {{ drop: string } | { shape: string } | null}
 */
const classifyShape = (init) => {
  if (!init) return null
  if (t.isArrayExpression(init)) {
    const shape = arrayShape(init)
    if (shape.total >= HANDLER_TABLE_MIN && shape.functions / shape.total >= 0.5) {
      return { drop: `handler table: ${shape.functions} function elements of ${shape.total}` }
    }
    if (shape.total >= NUMERIC_TABLE_MIN && shape.numbers / shape.total >= 0.9) {
      return { drop: `bytecode table: ${shape.numbers} numeric elements of ${shape.total}` }
    }
    return {
      shape: `array(${shape.total}): ${shape.strings} string, ${shape.numbers} numeric, ${shape.functions} function, ${shape.other} other`,
    }
  }
  if (t.isCallExpression(init)) {
    const longest = longestString(init)
    if (longest >= 10_000) {
      return { drop: `inflated bytecode: ${describeCallee(init)}() over a ${longest}-byte encoded string` }
    }
    return { shape: `call: ${describeCallee(init)}` }
  }
  if (t.isObjectExpression(init)) return { shape: `object(${init.properties.length})` }
  if (t.isFunctionExpression(init)) return { shape: `function(${init.params.length} params)` }
  if (t.isStringLiteral(init)) return { shape: `string(${init.value.length})` }
  if (t.isNumericLiteral(init)) return { shape: `number(${init.value})` }
  return { shape: init.type }
}

/** Root identifier of an assignment target: `D.prototype.decode` → `D`. */
const rootIdentifier = (node) => {
  let current = node
  while (t.isMemberExpression(current)) current = current.object
  return t.isIdentifier(current) ? current.name : null
}

/**
 * Names a unit assigns. Function bodies are not entered: a table of handlers
 * must not look like it binds every register its handlers touch.
 */
const assignedNames = (node) => {
  const names = new Set()
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (t.isFunctionExpression(value) || t.isFunctionDeclaration(value) || t.isArrowFunctionExpression(value)) return
    if (t.isAssignmentExpression(value)) {
      const root = rootIdentifier(value.left)
      if (root) names.add(root)
    }
    for (const key of Object.keys(value)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = value[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object' && child.type) visit(child)
    }
  }
  visit(node)
  return names
}

/**
 * Split one function body into units: one per declarator, one per element of a
 * comma expression. Splitting is what lets a blob and a table that share a
 * `var` statement be judged apart.
 *
 * @param {import('@babel/types').Statement[]} statements
 * @param {string} scope
 */
const extractUnits = (statements, scope) => {
  const units = []
  let group = 0
  for (const statement of statements) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      units.push({ scope, kind: 'func', defines: new Set([statement.id.name]), node: statement, group: null })
      continue
    }
    if (t.isVariableDeclaration(statement)) {
      const declGroup = `${scope}:${group++}`
      for (const declarator of statement.declarations) {
        const defines = new Set(t.isIdentifier(declarator.id) ? [declarator.id.name] : [])
        units.push({ scope, kind: 'var', declKind: statement.kind, defines, node: declarator, group: declGroup })
      }
      continue
    }
    if (t.isExpressionStatement(statement)) {
      const parts = t.isSequenceExpression(statement.expression)
        ? statement.expression.expressions
        : [statement.expression]
      for (const expression of parts) {
        units.push({ scope, kind: 'expr', defines: assignedNames(expression), node: expression, group: null })
      }
      continue
    }
    units.push({ scope, kind: 'other', defines: new Set(), node: statement, group: null })
  }
  return units
}

/** Initialiser of a unit, when it has one. */
const initializerOf = (unit) => {
  if (unit.kind === 'var') return unit.node.init
  if (unit.kind === 'expr' && t.isAssignmentExpression(unit.node)) return unit.node.right
  return null
}

/** Every immediately invoked function call inside a statement list. */
const iifeCallsIn = (statements) => {
  const found = []
  for (const statement of statements) {
    if (t.isExpressionStatement(statement) && isIifeCall(statement.expression)) found.push(statement.expression)
    if (t.isExpressionStatement(statement) && t.isSequenceExpression(statement.expression)) {
      for (const expression of statement.expression.expressions) if (isIifeCall(expression)) found.push(expression)
    }
  }
  return found
}

/** True when this function body's own statements hold the handler table. */
const holdsHandlerTable = (bodyStatements) =>
  extractUnits(bodyStatements, 'probe').some((unit) => {
    const verdict = classifyShape(initializerOf(unit))
    return Boolean(verdict?.drop?.startsWith('handler table'))
  })

/**
 * Find the program IIFE: the deepest immediately invoked function that holds
 * the handler table in its own body.
 *
 * @param {import('@babel/types').Node} root
 * @returns {import('@babel/types').FunctionExpression | null}
 */
const findProgramIife = (root) => {
  let best = null
  let bestDepth = -1
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return
    if (isIifeCall(node) && holdsHandlerTable(node.callee.body.body)) {
      if (depth > bestDepth) {
        best = node.callee
        bestDepth = depth
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) for (const item of child) walk(item, depth + 1)
      else if (child && typeof child === 'object' && child.type) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return best
}

const outerIife = resourceAst.program.body.find(
  (statement) => t.isExpressionStatement(statement) && isIifeCall(statement.expression),
)?.expression.callee
if (!outerIife) {
  console.error('resource: no top-level IIFE found')
  process.exit(1)
}

const programIife = findProgramIife(resourceAst.program)
if (!programIife) {
  console.error('resource: no IIFE holding a handler table found')
  process.exit(1)
}

/**
 * The program IIFE sits inside the pako wrapper, whose guarded prologue is the
 * only place that gives `d`, `s` and `i` their values. That prologue is a
 * statement of the wrapper, so the wrapper's own statement list is a scope too.
 *
 * @param {import('@babel/types').Node} root
 * @param {import('@babel/types').FunctionExpression} target
 * @returns {import('@babel/types').FunctionExpression | null}
 */
const findEnclosingIife = (root, target) => {
  let found = null
  const stack = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const call = isIifeCall(node)
    if (call) stack.push(node.callee)
    if (node === target && stack.length >= 2) found = stack[stack.length - 2]
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child === 'object' && child.type) walk(child)
    }
    if (call) stack.pop()
  }
  walk(root)
  return found
}

const pakoIife = findEnclosingIife(resourceAst.program, programIife)
if (!pakoIife) {
  console.error('resource: no enclosing IIFE around the program found')
  process.exit(1)
}

const outerUnits = extractUnits(outerIife.body.body, 'outer')
const pakoUnits = extractUnits(pakoIife.body.body, 'pako')
const programUnits = extractUnits(programIife.body.body, 'program')
const allUnits = [...outerUnits, ...pakoUnits, ...programUnits]

// A nested IIFE is not a binding; its body is represented by its own units, so
// the wrapper statement itself is removed from the unit list.
const nestedIifeNodes = new Set(
  [
    ...iifeCallsIn(outerIife.body.body),
    ...iifeCallsIn(pakoIife.body.body),
    ...iifeCallsIn(programIife.body.body),
  ].map((node) => node.callee),
)
const isNestedIifeUnit = (unit) => unit.kind === 'expr' && nestedIifeNodes.has(unit.node.callee)

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const candidateNames = new Set(allUnits.flatMap((unit) => [...unit.defines]))

for (const unit of allUnits) {
  const verdict = classifyShape(initializerOf(unit))
  unit.shape = verdict?.shape ?? null
  unit.structuralDrop = verdict?.drop ?? null
  unit.references = new Set()
  // Only reads pull in a provider. A pure write (`C = 0`, `l = "…"`) must not
  // drag in another writer of the same name: the prologue blocks write far
  // more than they read, and pulling every writer would reassemble the pako
  // library. Property writes still read their object (`D.prototype.decode`).
  const collect = (node, parent, key) => {
    if (!node || typeof node !== 'object') return
    if (t.isIdentifier(node) && candidateNames.has(node.name)) {
      const isWrite =
        (t.isAssignmentExpression(parent) && key === 'left' && parent.left === node)
        || (t.isVariableDeclarator(parent) && key === 'id')
        || ((t.isFunctionDeclaration(parent) || t.isFunctionExpression(parent)) && key === 'id')
      if (!isWrite) unit.references.add(node.name)
    }
    for (const childKey of Object.keys(node)) {
      if (childKey === 'loc' || childKey === 'start' || childKey === 'end') continue
      const child = node[childKey]
      if (Array.isArray(child)) child.forEach((item) => collect(item, node, childKey))
      else if (child && typeof child === 'object' && child.type) collect(child, node, childKey)
    }
  }
  collect(unit.node, null, null)
}

// The handler table and the inflated bytecode are dropped unconditionally by
// `classifyShape`. Their *names* are not poisoned: the guards around the
// initialisation prologue (`C && (…)`) still need `C` to hold its scalar
// header value, and nothing may reintroduce the table itself.

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Identifier occurrences a statement would dereference at load time: the
 * object of a property access or the callee of a call. A binding may be
 * *declared* and still be `undefined` when such a statement runs; that is a
 * TypeError at load, not a missing module binding.
 *
 * @param {import('@babel/types').Node} node
 * @returns {{ name: string, start: number }[]}
 */
const dangerousReads = (node) => {
  const reads = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (t.isFunctionExpression(value) || t.isFunctionDeclaration(value) || t.isArrowFunctionExpression(value)) return
    if (t.isMemberExpression(value) && t.isIdentifier(value.object) && candidateNames.has(value.object.name)) {
      reads.push({ name: value.object.name, start: value.object.start ?? value.start ?? 0 })
    }
    if (t.isCallExpression(value) && t.isIdentifier(value.callee) && candidateNames.has(value.callee.name)) {
      reads.push({ name: value.callee.name, start: value.callee.start ?? value.start ?? 0 })
    }
    for (const key of Object.keys(value)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = value[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object' && child.type) visit(child)
    }
  }
  visit(node)
  return reads
}

/**
 * A unit that gives its names a real value when it runs unconditionally.
 *
 * A guarded block counts when its flag is known-settable: `b && (…)` runs iff
 * `b` has a definite value source before it (`b = 25`). Without that rule the
 * block that installs `c`, `d`, `f`, `o`, `s` reads as conditional and the
 * guards it depends on get dropped as dead.
 */
const isDefiniteProvider = (unit) => {
  if (unit.kind === 'var') return unit.node.init !== null
  if (unit.kind !== 'expr') return false
  const node = unit.node
  if (t.isAssignmentExpression(node)) return true
  if (t.isLogicalExpression(node)) {
    if (isLiteralTruthy(node.left)) return true
    if (t.isIdentifier(node.left)) return nameHasProviderBefore(node.left.name, unit)
    return false
  }
  return false
}

const isLiteralTruthy = (node) => {
  if (t.isBooleanLiteral(node)) return node.value
  if (t.isNumericLiteral(node)) return node.value !== 0
  if (t.isStringLiteral(node)) return node.value.length > 0
  if (t.isUnaryExpression(node, { operator: '!' }) && t.isNumericLiteral(node.argument)) return node.argument.value === 0
  return false
}

/** Names with a value source strictly before `unit` (excluding `unit` itself). */
const hasValueBefore = (name, unit) =>
  allUnits.some((candidate) => candidate !== unit && candidate.defines.has(name)
    && candidate.node.start < unit.node.start && isDefiniteProvider(candidate))

/** Recursion guard for `flag && (…)` chains (`guardStack` is name-scoped). */
const guardStack = new Set()
const nameHasProviderBefore = (name, unit) => {
  if (guardStack.has(name)) return false
  guardStack.add(name)
  const found = hasValueBefore(name, unit)
  guardStack.delete(name)
  return found
}

/** True when `unit` assigns `name` earlier in its own evaluation than `at`. */
const assignsBeforeInside = (unit, name, at) => {
  let found = false
  const visit = (value) => {
    if (found || !value || typeof value !== 'object') return
    if (t.isFunctionExpression(value) || t.isFunctionDeclaration(value) || t.isArrowFunctionExpression(value)) return
    // A read is covered only after the assignment has completed: `x = x.slice()`
    // still reads the old value while its right-hand side is evaluated.
    if (t.isAssignmentExpression(value) && rootIdentifier(value.left) === name && (value.end ?? 0) <= at) {
      found = true
      return
    }
    for (const key of Object.keys(value)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = value[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object' && child.type) visit(child)
    }
  }
  visit(unit.node)
  return found
}

/** True when a dereference of `name` at `at` inside `unit` is guaranteed a value. */
const isSafeRead = (unit, name, at) =>
  hasValueBefore(name, unit) || assignsBeforeInside(unit, name, at)

/** Guard statements whose reads would throw because a value source is missing. */
const unsafeGuards = (units) =>
  units.filter((unit) => {
    if (unit.kind !== 'expr' || !t.isLogicalExpression(unit.node)) return false
    return dangerousReads(unit.node).some((read) => !isSafeRead(unit, read.name, read.start))
  })

/**
 * A unit is a root when it binds something the lifted program reads. Contract
 * bindings are roots only outside the pako wrapper: that scope has its own
 * `m`, `D` and `S`, and rooting them would let the pako library overwrite the
 * string decoder the program actually uses.
 */
const isRoot = (unit) =>
  unit.scope !== 'pako'
  && [...unit.defines].some((name) => freeInFinal.has(name) || CONTRACT_BINDINGS.has(name))

/**
 * The pako wrapper contributes exactly one kind of statement: its guarded
 * initialisation prologue (`C && (…)`), which is the only source of `d`, `s`
 * and `i`. Its library code (the inflate function bound to `m`, the UMD
 * wrapper) is not module scope and must never be pulled in.
 */
const isEligible = (unit) =>
  unit.scope !== 'pako' || (unit.kind === 'expr' && t.isLogicalExpression(unit.node))

/** Roots plus dependency closure, skipping units in `blocked`. */
const select = (blocked) => {
  const selection = new Map()
  for (const unit of allUnits) {
    if (!isRoot(unit) || !isEligible(unit) || isNestedIifeUnit(unit) || blocked.has(unit)) continue
    if (unit.structuralDrop) continue
    const names = [...unit.defines]
    const contract = names.filter((name) => !freeInFinal.has(name) && CONTRACT_BINDINGS.has(name))
    selection.set(unit, contract.length > 0 && names.every((name) => !freeInFinal.has(name))
      ? `kept by contract (${contract.join(', ')})`
      : `referenced by final.js (${names.filter((name) => freeInFinal.has(name)).join(', ')})`)
  }
  const pending = [...selection.keys()]
  while (pending.length > 0) {
    const unit = pending.pop()
    for (const name of unit.references) {
      const candidates = allUnits.filter((candidate) => candidate !== unit
        && candidate.defines.has(name)
        && isEligible(candidate)
        && !isNestedIifeUnit(candidate)
        && !blocked.has(candidate)
        && !candidate.structuralDrop)
      if (candidates.length === 0) continue
      // The value a reader sees comes from the nearest writer before it. Keep
      // that one only: keeping every writer would reassemble the pako library.
      const before = candidates.filter((candidate) => candidate.node.start < unit.node.start
        && isDefiniteProvider(candidate))
      const chosen = before.length > 0
        ? before.reduce((left, right) => (left.node.start > right.node.start ? left : right))
        : candidates.find((candidate) => candidate.kind === 'func' || candidate.kind === 'var') ?? candidates[0]
      if (selection.has(chosen)) continue
      selection.set(chosen, `value source for ${name} read by ${[...unit.defines].join('/') || 'kept statement'}`)
      pending.push(chosen)
    }
  }
  return selection
}

const conflicts = []
const blocked = new Set()
let kept = select(blocked)
for (;;) {
  const unsafe = unsafeGuards([...kept.keys()])
  if (unsafe.length === 0) break
  for (const unit of unsafe) blocked.add(unit)
  kept = select(blocked)
}

// Every name a kept statement assigns must also be declared. In the original
// bundle these are the outer `var` cells; keeping the assignments without the
// declarations works only while the concatenation stays sloppy-mode, and a
// strict evaluation would turn them into ReferenceErrors. Pako's own `var D, m`
// are never borrowed: they belong to a different scope.
for (const unit of [...kept.keys()]) {
  for (const name of unit.defines) {
    const declaration = [unit.scope, 'outer', 'program']
      .map((scope) => allUnits.find((candidate) => candidate.kind === 'var'
        && candidate.scope === scope && candidate.defines.has(name) && !blocked.has(candidate)))
      .find(Boolean)
    if (declaration && !kept.has(declaration)) kept.set(declaration, `declaration for ${name}`)
  }
}

// A unit the VM rules refuse is reported even though it is dropped.
for (const unit of allUnits) {
  if (!unit.structuralDrop) continue
  for (const name of unit.defines) {
    if (freeInFinal.has(name)) conflicts.push(`${name}: final.js reads it, but it is the ${unit.structuralDrop}`)
  }
}

/* ------------------------------------------------------------------ */
/* Report table                                                        */
/* ------------------------------------------------------------------ */

const label = (unit) => ([...unit.defines].length > 0 ? [...unit.defines].join('+') : '·')
const keptUnits = allUnits.filter((unit) => kept.has(unit))
const droppedUnits = allUnits.filter((unit) => !kept.has(unit))

/** How a bare call is understood once its callee is a dropped VM function. */
const describeBareCall = (unit) => {
  if (!t.isCallExpression(unit.node) || !t.isIdentifier(unit.node.callee)) return null
  const callee = unit.node.callee.name
  const defining = allUnits.find((candidate) => candidate.defines.has(callee))
  if (!defining || kept.has(defining)) return null
  return `entry call into ${callee}(), which is dropped VM machinery`
}

const reasonFor = (unit) => {
  if (kept.has(unit)) return kept.get(unit)
  if (unit.structuralDrop) return `dropped by rule — ${unit.structuralDrop}`
  if (blocked.has(unit)) {
    const missing = [...new Set(
      dangerousReads(unit.node)
        .filter((read) => !isSafeRead(unit, read.name, read.start))
        .map((read) => read.name),
    )]
    return `dropped — load-unsafe prologue: it dereferences ${missing.join(', ')}, whose only value source is inside the dropped pako module; running it would throw at load`
  }
  if (isNestedIifeUnit(unit)) return 'dropped — nested IIFE wrapper (its own statements are extracted separately)'
  const bare = describeBareCall(unit)
  if (bare) return `dropped — ${bare}`
  if (unit.kind === 'other') return 'UNCLASSIFIED — statement binds nothing and has no recognised shape'
  if (unit.defines.size === 0) {
    if (t.isCallExpression(unit.node) || t.isLogicalExpression(unit.node) || t.isConditionalExpression(unit.node)) {
      return 'dropped — expression with no binding; nothing in final.js refers to it'
    }
    return 'UNCLASSIFIED — expression binds nothing and has no recognised shape'
  }
  return 'dropped — not referenced by final.js or by any kept statement'
}

console.log('=== module-scope binding table ===')
console.log('scope   name       bytes  free-refs  state  shape / reason')
const scopeOrder = { outer: 0, pako: 1, program: 2 }
const rows = [...allUnits].sort(
  (a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.node.start - b.node.start,
)
for (const unit of rows) {
  const names = [...unit.defines]
  const refs = names.reduce((sum, name) => sum + (freeCounts.get(name) ?? 0), 0)
  console.log(
    [
      unit.scope.padEnd(7),
      label(unit).padEnd(10),
      String(nodeSize(unit.node)).padStart(6),
      String(refs).padStart(9),
      (kept.has(unit) ? 'KEEP' : 'DROP').padEnd(6),
      unit.shape ? `${unit.shape} — ${reasonFor(unit)}` : reasonFor(unit),
    ].join(' '),
  )
}

console.log(`\nkept ${keptUnits.length} / dropped ${droppedUnits.length} of ${allUnits.length} units`)

const unclassified = droppedUnits.filter((unit) => reasonFor(unit).startsWith('UNCLASSIFIED'))
if (unclassified.length > 0) {
  console.log('\n=== unclassified units ===')
  for (const unit of unclassified) {
    console.log(`  ${unit.scope} @${unit.node.start}: ${generate(unit.node).code.slice(0, 140)}`)
  }
} else {
  console.log('unclassified units: none')
}
if (conflicts.length > 0) {
  console.log('\n=== bindings final.js needs that the VM rules refuse ===')
  for (const line of conflicts) console.log(`  ${line}`)
}

/* ------------------------------------------------------------------ */
/* Emit                                                                */
/* ------------------------------------------------------------------ */

const emitUnits = (units) => {
  const lines = []
  let index = 0
  while (index < units.length) {
    const unit = units[index]
    if (unit.kind === 'var') {
      const declarators = []
      while (index < units.length && units[index].kind === 'var' && units[index].group === unit.group) {
        declarators.push(units[index].node)
        index += 1
      }
      lines.push(generate(t.variableDeclaration(unit.declKind, declarators)).code)
      continue
    }
    if (unit.kind === 'func') {
      lines.push(generate(unit.node).code)
      index += 1
      continue
    }
    if (unit.kind === 'expr') {
      lines.push(generate(t.expressionStatement(unit.node)).code)
      index += 1
      continue
    }
    lines.push(generate(unit.node).code)
    index += 1
  }
  return lines
}

const header = [
  '/*',
  ' * Module scope recovered from resources/mssdk.min.js.',
  ' *',
  ' * The lift of the bundle\'s functions (output/final.js) reads bindings that',
  ' * lived in the bundle\'s enclosing scopes. This fragment restores those: the',
  ' * host object, the typeof helper, the UMD variables, the base64 helper, the',
  ' * UTF-8 decoder, the string decoder, the decoder memo and the string table.',
  ' * The virtual machine — bytecode array and handler table — is absent.',
  ' *',
  ` * kept ${keptUnits.length} statements, dropped ${droppedUnits.length};`,
  ' * emitted by scripts/28-module-scope.mjs.',
  ' */',
  '',
].join('\n')

const emitted = emitUnits(keptUnits)
const output = `${header}${emitted.join('\n')}\n`
fs.writeFileSync(OUT, output)

let parses = true
let parseError = ''
try {
  parseScript(output)
} catch (error) {
  parses = false
  parseError = error.message
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

const definedByFragment = new Set(keptUnits.flatMap((unit) => [...unit.defines]))
const referenced = [...definedByFragment].filter((name) => freeInFinal.has(name)).sort()
const unreferenced = [...definedByFragment].filter((name) => !freeInFinal.has(name)).sort()

const freeSorted = [...freeInFinal].sort()
const allowlisted = freeSorted.filter((name) => GLOBALS.has(name))
const gap = freeSorted.filter((name) => !GLOBALS.has(name) && !definedByFragment.has(name))

/**
 * Why a gap name is still missing, decided from the bundle itself:
 *   - `__*`               the compressed runtime supplied by runnable.min.js;
 *   - declared in bundle  declared somewhere in the resource, but inside a
 *                         nested function, so it is a lost local, not module scope;
 *   - host API            never declared by the bundle; the host must supply it.
 */
const declaredInBundle = new Set()
{
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) declaredInBundle.add(node.id.name)
    if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isClassDeclaration(node)) && node.id) {
      declaredInBundle.add(node.id.name)
    }
    if (t.isAssignmentExpression(node)) {
      const root = rootIdentifier(node.left)
      if (root) declaredInBundle.add(root)
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child === 'object' && child.type) walk(child)
    }
  }
  walk(resourceAst.program)
}

/**
 * Helpers the compressed runtime prefix in `runnable.min.js` defines, and
 * helpers `final.js` calls that nothing defines. Both lists are read off that
 * file: the first is its `__*` preamble, the second is every `__*` call in
 * `final.js` that the preamble does not declare.
 */
const RUNTIME_PROVIDED = new Set(['__state', '__upvalue', '__cellValue', '__setUpvalue', '__native'])
const RUNTIME_MISSING = new Set(['__frames', '__thrown', '__boundary', '__unwind', '__dispatchCompletion'])

const explainGap = (name) => {
  if (RUNTIME_PROVIDED.has(name)) return 'runtime'
  if (RUNTIME_MISSING.has(name)) return 'missing-runtime'
  if (declaredInBundle.has(name)) return 'lost-local'
  return 'host'
}
const gapGroups = { runtime: [], 'missing-runtime': [], 'lost-local': [], host: [] }
for (const name of gap) gapGroups[explainGap(name)].push(name)

console.log('\n=== verification ===')
console.log(`final.js free identifiers        ${freeInFinal.size}`)
console.log(`  supplied by JS globals         ${allowlisted.length}`)
console.log(`  defined by module-scope.js     ${definedByFragment.size} (${referenced.length} directly referenced)`)
console.log(`  still unresolved               ${gap.length}`)
console.log(`kept bindings final.js never reads ${unreferenced.length}${unreferenced.length > 0 ? `: ${unreferenced.join(', ')}` : ''}`)
if (conflicts.length > 0) console.log(`contract conflicts               ${conflicts.length}`)

console.log(`\nremaining free identifiers (${gap.length}):`)
console.log(gap.length === 0 ? '  (empty)' : `  ${gap.join(', ')}`)
console.log(`  runtime provided by runnable.min.js ${gapGroups.runtime.length}: ${gapGroups.runtime.join(', ')}`)
console.log(`  runtime helper nothing defines      ${gapGroups['missing-runtime'].length}: ${gapGroups['missing-runtime'].join(', ')}`)
console.log(`  lost handler-local declarations     ${gapGroups['lost-local'].length}: ${gapGroups['lost-local'].join(', ')}`)
console.log(`  host APIs the host must provide     ${gapGroups.host.length}: ${gapGroups.host.join(', ')}`)
console.log(`  unexplained                         ${gap.length - gapGroups.runtime.length - gapGroups['missing-runtime'].length - gapGroups['lost-local'].length - gapGroups.host.length}`)

if (traced.size > 0) {
  console.log('\n=== traced free references in final.js ===')
  for (const name of traced) {
    console.log(`${name}: ${freeCounts.get(name) ?? 0} free reference(s)`)
    for (const start of traceSites.get(name) ?? []) {
      console.log(`  @${start}: …${finalSource.slice(Math.max(0, start - 80), start + 80).replace(/\s+/g, ' ')}…`)
    }
  }
}

const duplicateNames = (() => {
  const seen = new Map()
  for (const unit of keptUnits) {
    for (const name of unit.defines) seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([name, count]) => `${name}×${count}`)
})()

console.log('\n=== output ===')
console.log(`statements emitted               ${emitted.length}`)
console.log(`parses on its own                ${parses}${parses ? '' : ` (${parseError})`}`)
console.log(`bytes                            ${output.length}`)
console.log(`re-declared names (var, legal)   ${duplicateNames.length === 0 ? 'none' : duplicateNames.join(', ')}`)
console.log(`file                             ${OUT}`)
