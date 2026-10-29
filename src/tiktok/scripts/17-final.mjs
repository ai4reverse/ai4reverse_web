#!/usr/bin/env node
/**
 * Final code generation: strings → rename → emit.
 *
 * Stages measured on the real 528 KB tree: parse 81 ms, string substitution
 * 122 ms, generate 27 ms. A previous version of this script appeared to hang
 * because it generated and re-parsed the whole tree to *predict* whether each
 * refinement helped, which cost far more than the refinements themselves.
 *
 * `substituteStringIdioms` rebuilds changed subtrees and returns a new tree; it
 * does not mutate in place. Ignoring that return value was why an earlier run
 * still carried 2,684 undecoded strings while the module was correct in
 * isolation.
 *
 * Each stage is optional and reports its own failure: a missing or broken
 * module degrades the output and says so, it never fails silently.
 *
 * Emits output/final.js.
 *
 *   node scripts/17-final.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const strings = JSON.parse(fs.readFileSync(path.join(TMP, 'strings.json'), 'utf8'))
const plainByIndex = {}
for (const [k, v] of Object.entries(strings)) {
  if (!/^\d+$/.test(k)) continue
  if (v && typeof v.plain === 'string') plainByIndex[k] = v.plain
}

async function tryImport(spec) {
  try {
    return await import(spec)
  } catch (err) {
    console.warn(`  ! ${spec}: ${err.message}`)
    return null
  }
}

const stringsMod = await tryImport('./lib/strings-ast.mjs')
const renameMod = await tryImport('./lib/rename.mjs')

let ast = parse(fs.readFileSync(path.join(OUT, 'lifted.js'), 'utf8'), { sourceType: 'script' })

// 0. Inline `var x = T[<n>]` before string substitution.
//
// After the lift stage began emitting proper declarations for handler locals,
// the decrypt idiom arrives as
//
//   var t, c = T[11], a = T[5];
//   S[t = c + ":" + a] || (S[t] = m(c, a))
//
// The substitution module keys on `T[<n>]` appearing inside the call, so with
// the indices hidden behind locals it cannot resolve the idiom and leaves it
// whole. Propagating the table reads puts the indices back where the module
// looks for them.
let propagated = 0
let propagationFailures = 0
{
  const traverse = _traverse.default ?? _traverse

  /**
   * Reaching definitions for `x = T[<n>]` over one straight-line statement
   * list.
   *
   * `c` and `a` are reassigned (`c = T[11]` … `c = T[12]`), so Babel reports
   * them as non-constant and a binding-level propagation skips them. What is
   * wanted is the value reaching each *use*, which is well defined here because
   * the list is straight-line.
   */
  const propagateInList = (statements, initial) => {
    const known = initial ? new Map(initial) : new Map()

    /** An expression built only from table slots and string literals. */
    const isConstKey = (node, depth = 0) => {
      if (!node || depth > 4) return false
      if (node.type === 'StringLiteral') return true
      if (
        node.type === 'MemberExpression' &&
        node.object?.name === 'T' &&
        node.computed &&
        node.property.type === 'NumericLiteral'
      ) {
        return true
      }
      // Only a bare table slot is propagated. A compound key such as
      // `T[a] + ":" + T[b]` is a BinaryExpression, and substituting it into
      // every position the identifier occupied produced trees that do not parse
      // (a member expression is invalid as a shorthand key or a `new` callee).
      // Those sites keep their idiom instead.
      if (node.type === 'BinaryExpression' && node.operator === '+') {
        return isConstKey(node.left, depth + 1) && isConstKey(node.right, depth + 1)
      }
      return false
    }
    const nestedLists = (stmt) => {
      const out = []
      const take = (node) => {
        if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
        if (node.type === 'BlockStatement') out.push(node.body)
        else if (node.type.endsWith('Statement') || node.type === 'VariableDeclaration') out.push([node])
      }
      take(stmt.consequent)
      take(stmt.alternate)
      // Loop bodies are included again; the caller enters them with an empty
      // reaching map, which is what makes the recursion safe.
      take(stmt.body)
      take(stmt.handler?.body)
      take(stmt.finalizer)
      for (const c of stmt.cases ?? []) out.push(c.consequent)
      return out
    }

    const settle = (expr) => {
      // Names this expression assigns are not substituted from `known`: the
      // value reaching the read is the one assigned here, not the earlier one.
      // Without this, `S[t = c + ":" + a] || (S[t] = m(c, a))` became
      // `S[t = …] || (S[T[3]] = …)` — a memo that caches under a different key
      // than it reads, which is wrong at run time and not merely unreadable.
      const assignedHere = new Set()
      const collectAssignments = (n) => {
        if (!n || typeof n !== 'object') return
        if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') assignedHere.add(n.left.name)
        for (const k of Object.keys(n)) {
          if (k === 'loc' || k === 'start' || k === 'end') continue
          const v = n[k]
          if (Array.isArray(v)) for (const c of v) collectAssignments(c)
          else if (v && typeof v === 'object' && v.type) collectAssignments(v)
        }
      }
      collectAssignments(expr)
      // A manual walk rather than Babel's traverse: traverse wants a node with
      // a proper parent context, and handing it a bare expression silently
      // visits nothing.
      const walk = (node, parent, key) => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'Identifier' && known.has(node.name) && !assignedHere.has(node.name)) {
          if (parent && parent.type === 'AssignmentExpression' && key === 'left') return
          // `i++` with `i` bound to a constant produced `""++`.
          if (parent && parent.type === 'UpdateExpression') return
          if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return
          // Positions where a member expression is not valid, or would change
          // meaning: a shorthand object key, and the callee of a call or new
          // (which needs parentheses the substitution does not add).
          if (parent && parent.type === 'ObjectProperty' && parent.shorthand) return
          // A non-shorthand object key is a property name, not a reference.
          // Substituting it produced `{h: r24, T[97]: false}`, which does not
          // parse — the cause of every reverted function.
          if (parent && parent.type === 'ObjectProperty' && key === 'key' && !parent.computed) return
          if (parent && (parent.type === 'ObjectMethod' || parent.type === 'ClassMethod') && key === 'key' && !parent.computed) return
          if (parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'callee') return
          if (parent && parent.type === 'VariableDeclarator' && key === 'id') return
          // `Function` is a Babel virtual type, never a node type, so the earlier guard
          // never fired and a parameter got replaced by a table slot.
          if (parent && key === 'params') return
          const replacement = JSON.parse(JSON.stringify(known.get(node.name)))
          Object.keys(node).forEach((k) => delete node[k])
          Object.assign(node, replacement)
          propagated++
          return
        }
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'start' || k === 'end') continue
          const v = node[k]
          if (Array.isArray(v)) for (const c of v) walk(c, node, k)
          else if (v && typeof v === 'object' && v.type) walk(v, node, k)
        }
      }
      walk(expr, null, null)
      // A name assigned anywhere inside this expression no longer holds the
      // value `known` recorded for it. Leaving the stale entry let a later read
      // take the *old* key: `S[c = T[669] + ":" + T[5]] || (S[c] = m(…))`
      // writes the memo under the compound key while `r19 = S[c]` was rewritten
      // to the earlier `S[T[1]]`, so the memo was never found and `Math["imul"]`
      // came out `undefined`.
      for (const name of assignedHere) known.delete(name)
    }

    for (const stmt of statements) {
      // A condition is an expression position too, and the decrypt idiom lives
      // inside `if (!(S[f] in l))` and friends. Settling only expression
      // statements left every such test with its key still hidden behind a
      // local, which is where the bulk of the surviving `S[` reads came from.
      // A for-loop's init declaration rebinds its counters; the reaching value
      // inside the loop is the one bound here, not whatever the enclosing
      // statement left behind. This must happen BEFORE the test is settled, or
      // `c < 2` comes out as `T[5] < 2`.
      if (stmt.init && stmt.init.type === 'VariableDeclaration') {
        for (const d of stmt.init.declarations) if (d.id.type === 'Identifier') known.delete(d.id.name)
      }
      if (stmt.test) settle(stmt.test)
      // The argument of a throw or return is an expression position too. The
      // unresolved reads sat inside `throw new ReferenceError(S[f] + …)` while
      // the guarding condition had already been resolved.
      if (stmt.argument) settle(stmt.argument)
      if (stmt.init && stmt.init.type !== 'VariableDeclaration') settle(stmt.init)
      if (stmt.update) settle(stmt.update)
      if (stmt.right && stmt.type === 'ForInStatement') settle(stmt.right)
      // A branch or loop body may or may not run, so it cannot extend what is
      // known afterwards; it recurses with a copy. Without this the decrypt
      // idiom inside a nested block kept its table indices hidden behind locals
      // and the string substitution could not resolve it.
      // A loop body is entered with an EMPTY reaching map, not the enclosing
      // one: the loop rebinds the names it carries (`f = f.o`), so an inherited
      // value is stale and substituting it produced `f = T[84].o`. Entering
      // empty keeps the body's own definitions resolving while never leaking an
      // outer value in.
      const isLoop =
        stmt.type === 'WhileStatement' ||
        stmt.type === 'ForStatement' ||
        stmt.type === 'DoWhileStatement' ||
        stmt.type === 'ForInStatement' ||
        stmt.type === 'ForOfStatement'
      for (const list of nestedLists(stmt)) propagateInList(list, isLoop ? new Map() : known)

      if (stmt.type !== 'ExpressionStatement' && stmt.type !== 'VariableDeclaration') continue
      if (stmt.type === 'VariableDeclaration') {
        // `var c = T[11]` is a declarator, not an assignment, so it has to be
        // recorded explicitly or the index stays hidden behind `c`.
        for (const d of stmt.declarations) {
          if (!d.init) continue
          const value = d.init
          if (d.id.type === 'Identifier' && isConstKey(value)) {
            known.set(d.id.name, value)
            continue
          }
          // The initialiser itself may read a name whose reaching definition is
          // a table slot: `var _name = S[_key]` with `_key = T[21]` must become
          // `S[T[21]]` before the string substitution can resolve it. Skipping
          // this left every `_name = S[_key]` unresolved.
          settle(value)
          if (d.id.type === 'Identifier') known.delete(d.id.name)
        }
        continue
      }

      const exprs =
        stmt.type === 'ExpressionStatement'
          ? stmt.expression.type === 'SequenceExpression'
            ? stmt.expression.expressions
            : [stmt.expression]
          : []

      for (const e of exprs) {
        if (e.type === 'AssignmentExpression' && e.left.type === 'Identifier') {
          const value = e.right
          // Settle the right-hand side first: `value4 = S[_cacheKey]` reads a
          // name whose reaching definition is a key expression, and skipping
          // the walk here left every such cache read unresolved.
          if (!isConstKey(value)) settle(value)
          if (isConstKey(value)) known.set(e.left.name, value)
          else known.delete(e.left.name)
          continue
        }
        settle(e)
      }
    }
  }

  // No top-level pass: the program body is almost entirely function
  // declarations, and `nestedLists` would descend into each function body and
  // then the per-function loop below would process it a second time. The
  // double substitution is what produced trees that do not parse.
  for (const fn of ast.program.body) {
    if (fn.type !== 'FunctionDeclaration') continue
    const snapshot = JSON.parse(JSON.stringify(fn))
    try {
      propagateInList(fn.body.body)
      // Validate this function on its own. A substitution that produces an
      // invalid tree in one function must not cost the whole file its
      // propagation, and it must not be shipped either.
      parse(`(${generate(fn).code})`, { sourceType: 'script' })
    } catch (err) {
      propagationFailures++
      Object.keys(fn).forEach((k) => delete fn[k])
      Object.assign(fn, snapshot)
    }
  }
  // Re-parse so the string substitution gets a tree with fresh scopes. If the
  // propagated tree does not parse, the substitution is skipped rather than the
  // whole stage — leaving some idioms unresolved is recoverable, crashing is not.
  try {
    ast = parse(generate(ast, { compact: true }).code, { sourceType: 'script' })
  } catch (err) {
    console.warn(`  ! propagation produced an unparseable tree, skipping: ${err.message}`)
    ast = parse(fs.readFileSync(path.join(OUT, 'lifted.js'), 'utf8'), { sourceType: 'script' })
  }
}

let stringHits = 0
if (stringsMod?.substituteStringIdioms) {
  const rewritten = stringsMod.substituteStringIdioms(ast, plainByIndex)
  if (rewritten) ast = rewritten
  const report = ast?.stringSubstitutionReport ?? rewritten?.stringSubstitutionReport
  if (report && typeof report === 'object') {
    stringHits = Object.values(report).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0)
  }
} else {
  console.warn('  ! string substitution skipped')
}

// 2. registers -> names describing what they hold
let renamed = 0
let renameFailures = 0
if (renameMod?.nameRegisters) {
  for (const node of ast.program.body) {
    if (node.type !== 'FunctionDeclaration') continue
    try {
      renamed += renameMod.nameRegisters(node)?.renamed ?? 0
    } catch (err) {
      renameFailures++
      if (renameFailures === 1) console.warn(`  ! rename failed: ${err.message}`)
    }
  }
} else {
  console.warn('  ! register renaming skipped')
}

// 3. emit
const header = [
  '/*',
  ' * Final decompilation — TikTok mssdk / byted_acrawler JSVMP',
  ' *',
  ' * Built from output/lifted.js by scripts/17-final.mjs.',
  ' *',
  ' * There is no register file, no cell boxes, no frame stack and no instruction',
  ' * pointer: those existed only to emulate what JavaScript closures already do.',
  ' *',
  ` * string idioms resolved  ${stringHits}`,
  ` * registers renamed       ${renamed}`,
  ` * rename failures         ${renameFailures}`,
  ' *',
  ' * A transcription of third-party code, kept as evidence; it preserves the',
  ' * target’s behaviour, weaknesses included.',
  ' */',
  '',
  '',
].join('\n')

const code = generate(ast, { comments: true, compact: false }).code
// Ensure the program starts on its own line. A header that ends flush against
// `*/` glues the first declaration onto the closing comment, which hides that
// function from anything matching `^function` — the bootstrap `fn_0` vanished
// from the count this way.
const outText = header.replace(/\*\/\s*$/, '*/\n\n') + code + '\n'
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'final.js'), outText)

let parses = true
try {
  parse(outText, { sourceType: 'script' })
} catch (e) {
  parses = false
  console.log(`parse error: ${e.message}`)
}

const tally = (re) => (outText.match(re) ?? []).length
console.log(`string idioms resolved  ${stringHits}`)
console.log(`registers renamed       ${renamed}`)
console.log(`propagation failures    ${propagationFailures}`)
console.log(`m(T[ remaining          ${tally(/m\(T\[/g)}`)
console.log(`S[  remaining           ${tally(/S\[/g)}`)
console.log(`r<N> remaining          ${tally(/\br\d+\b/g)}`)
console.log(`while / if              ${tally(/while \(/g)} / ${tally(/\bif \(/g)}`)
console.log(`functions               ${tally(/^function /gm)}`)
console.log(`parses                  ${parses}`)
console.log(`output                  ${path.join(OUT, 'final.js')}`)
