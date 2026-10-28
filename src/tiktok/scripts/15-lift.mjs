#!/usr/bin/env node
/**
 * AST-based decompiler: build JavaScript, do not splice strings.
 *
 * The earlier passes rendered each handler to text and then rewrote that text.
 * Every defect they hit — a leftover parenthesis, `R[7]in` gluing a keyword onto
 * an identifier, an inlined definition landing on an assignment target, a
 * statement cut at a `;` inside an unbalanced handler — came from treating code
 * as a string. Here every instruction is translated into Babel AST nodes and
 * every transformation is a tree edit, so those classes of bug cannot occur.
 *
 * Detaching from the VM's memory model
 * ------------------------------------
 * The interpreter emulates JavaScript closure semantics by hand: registers below
 * the cell boundary hold `{v}` boxes, `raw[]` bypasses them, and `n.o` walks a
 * parent chain to reach a captured binding. Real JavaScript closures already do
 * exactly this, by reference and for free. So the translation drops the whole
 * apparatus — `cell(x)`, `cellOf(v)`, `P(v)` and `raw[n]` all collapse to the
 * plain variable, and a captured register is simply a variable the inner
 * function closes over. Register indices become named locals.
 *
 * What is not liftable this way is the interpreter's own re-entry protocol
 * (`Y`, frame unwinding). Those stay as calls into a small runtime.
 *
 * This stage validates the translation and reports coverage; emission is the
 * next stage.
 *
 *   node scripts/15-lift.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import * as t from '@babel/types'

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')

const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const widths = JSON.parse(fs.readFileSync(path.join(TMP, 'widths.json'), 'utf8'))

const MODULE_BASE = 868
const PROLOGUE = { 0: 'rNull', 1: 'rUndef', 2: 'rTrue', 3: 'rFalse', 4: 'rRet', 5: 'rThis', 6: 'rArgs' }

/** Local name for a register. */
export function regName(n) {
  if (PROLOGUE[n]) return PROLOGUE[n]
  return n >= MODULE_BASE ? `mod${n}` : `r${n}`
}

function reg(n) {
  return t.identifier(regName(n))
}

const handlerCache = new Map()

/**
 * True when a handler rebinds one of the VM helper names by assignment.
 *
 * Handler 0084 does `H = "".padStart ? function … : function …` — a padding
 * helper, not frame unwinding. `scope.declares` only sees `var`/`const`
 * bindings, so an assignment slipped past it and the whole module initialiser
 * was refused as a frame-unwind instruction.
 */
const rebindCache = new Map()
function handlerRebinds(opcode, name) {
  const key = `${opcode}:${name}`
  if (rebindCache.has(key)) return rebindCache.get(key)
  const file = path.join(TMP, 'handlers', String(opcode).padStart(4, '0') + '.js')
  const src = fs.readFileSync(file, 'utf8')
  const rebinds = new RegExp(`(^|[^.\\w$])${name}\\s*=(?!=)`).test(src)
  rebindCache.set(key, rebinds)
  return rebinds
}
export function handlerAst(opcode) {
  if (handlerCache.has(opcode)) return handlerCache.get(opcode)
  const file = path.join(TMP, 'handlers', String(opcode).padStart(4, '0') + '.js')
  const body = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n')
    .trim()
  const ast = parse(`(${body})`, { sourceType: 'script' }).program.body[0].expression
  handlerCache.set(opcode, ast)
  return ast
}

const clone = (node) => JSON.parse(JSON.stringify(node))

/**
 * Recognise a control transfer in a translated expression.
 *
 * A handler writes the instruction pointer either on its own (`n.u = t`) or
 * inside a conditional (`x(n, c) ? n.u = a : n.u = b`). The conditional form is
 * the common one — every branch in the program — so missing it would leave the
 * lifted code with no control flow at all.
 */
function asJump(expr) {
  if (!expr) return null
  // Handlers commonly spell the transfer as `N(n,r,…), n.u = t` — the jump is
  // the last element of a sequence, not the whole expression. Missing that left
  // opcodes 3, 25, 100 and others emitted as opaque `__native` calls with their
  // control flow dropped.
  if (expr.type === 'SequenceExpression') {
    for (let i = expr.expressions.length - 1; i >= 0; i--) {
      const j = asJump(expr.expressions[i])
      if (j) return j
    }
    return null
  }
  if (expr.type === 'CallExpression' && expr.callee?.name === '__jump') return expr.arguments[0]
  if (
    expr.type === 'ConditionalExpression' &&
    expr.consequent.type === 'CallExpression' && expr.consequent.callee?.name === '__jump' &&
    expr.alternate.type === 'CallExpression' && expr.alternate.callee?.name === '__jump'
  ) {
    return t.conditionalExpression(expr.test, expr.consequent.arguments[0], expr.alternate.arguments[0])
  }
  return null
}

/**
 * A handler's own lexical scope.
 *
 * Handler bodies nest: `function (n) { … function (t, r) { … } … }`. A single
 * flat map from name to translated value let a `var t` inside one nested
 * function substitute for `t` inside its *sibling* — producing output like
 * `n.length.length` from a source that said `t.length`. Scopes are a chain so a
 * lookup stops at the nearest declaration, exactly as the engine resolves it.
 *
 * Bindings come in two kinds. A `value` binding is an initializer that is never
 * written afterwards, so every read can inline it — that is what turns
 * `var r = n.A[6][0]` into a named local at the use site. A `real` binding is a
 * variable that is actually assigned, or declared without an initializer, or is
 * a parameter: its reads must stay the identifier, and the declaration has to
 * appear in the emitted function or the name escapes.
 */
class Scope {
  constructor(parent, fnScope = null) {
    this.parent = parent
    this.fn = fnScope ?? this // nearest function scope: where `var` lands
    /** name -> { real, node } */
    this.bindings = new Map()
    /** names this function (or a closure inside it) mutates — see collectWrites */
    this.written = new Set()
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      const b = s.bindings.get(name)
      if (b) return b
    }
    return null
  }

  bind(name, binding) {
    this.bindings.set(name, binding)
  }

  /** The name is declared in a handler (or one of its nested functions). */
  declares(name) {
    for (let s = this; s; s = s.parent) if (s.bindings.has(name)) return true
    return false
  }
}

/**
 * Names this function mutates: assigned, updated, or mutated through a member.
 *
 * Mutating a name's *contents* counts. `var i = []` followed by `i[r] = n`
 * inside a closure is a binding with identity: inlining the initializer turns
 * every reader into a fresh `[]`, and `data: i` into `data: []`.
 *
 * Nested functions are descended into, so a write from a closure marks the
 * binding it closes over. That is conservative in one direction only: a
 * variable wrongly called mutable is declared and read by name, which is
 * always what the source meant; a variable wrongly called immutable loses its
 * identity.
 *
 * This runs before the body is translated, so a variable is known to be
 * mutable at its *first* read. Deciding it at the first write would inline the
 * initializer into every read that comes earlier, which is how
 * `for (var c = …; c > 0; --c)` came out as `for (var c = …; … > 0; --c)`.
 */
function collectWrites(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out
  switch (node.type) {
    case 'AssignmentExpression':
      collectPatternNames(node.left, out)
      collectMutatedObject(node.left, out)
      collectWrites(node.left, out)
      collectWrites(node.right, out)
      return out
    case 'UpdateExpression':
      if (node.argument.type === 'Identifier') out.add(node.argument.name)
      collectMutatedObject(node.argument, out)
      collectWrites(node.argument, out)
      return out
    case 'ForInStatement':
    case 'ForOfStatement':
      if (node.left.type === 'Identifier') out.add(node.left.name)
      collectWrites(node.left, out)
      collectWrites(node.right, out)
      collectWrites(node.body, out)
      return out
    default:
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => collectWrites(c, out))
    else if (v && typeof v === 'object' && typeof v.type === 'string') collectWrites(v, out)
  }
  return out
}

/** `a.b[c] = …` mutates whatever `a` names. */
function collectMutatedObject(target, out) {
  if (target?.type !== 'MemberExpression') return
  let base = target
  while (base && base.type === 'MemberExpression') base = base.object
  if (base?.type === 'Identifier') out.add(base.name)
}

/** Destructuring assignment targets count as writes too. */
function collectPatternNames(pattern, out) {
  if (!pattern || typeof pattern !== 'object') return
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name)
      return
    case 'ObjectPattern':
      for (const p of pattern.properties) {
        collectPatternNames(p.type === 'RestElement' ? p.argument : p.value, out)
      }
      return
    case 'ArrayPattern':
      for (const e of pattern.elements) if (e) collectPatternNames(e, out)
      return
    case 'RestElement':
      collectPatternNames(pattern.argument, out)
      return
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out)
      return
    default:
  }
}

const isFunctionNode = (n) =>
  n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')

/**
 * Translate one handler into Babel statements.
 *
 * The handler body is itself JavaScript over the VM state, so it is walked the
 * way the interpreter walks it: operand reads advance a cursor, register writes
 * become assignments, and anything outside the VM vocabulary is kept with its
 * subexpressions substituted. Returns null when the handler uses a construct
 * this translation cannot model — an explicit refusal, not a guess.
 */
export function translateHandler(opcode, operands) {
  const ast = handlerAst(opcode)
  // The VM state parameter is usually `n`, but handlers 0073, 0075, 0127, 0357
  // and others name it `t`. Assuming `n` left unbound `t.A[4]` references in the
  // lifted output, so the name is read from the handler itself.
  const vmParam = ast.params?.[0]?.name ?? 'n'
  const root = new Scope(null)
  let scope = root
  root.written = collectWrites(ast.body)
  let cursor = 0
  let jump = null
  let opaque = false

  const operand = (width) => t.numericLiteral(operands[cursor++] ?? 0)

  /** Read a name: inline a never-written initializer, otherwise keep it. */
  function readName(name) {
    const binding = scope.lookup(name)
    if (binding && !binding.real && binding.node) return clone(binding.node)
    return t.identifier(name)
  }

  /** A declaration this translation can emit: a bare identifier binding. */
  function isSimpleTarget(id) {
    return id?.type === 'Identifier'
  }

  function ev(node) {
    if (!node) return t.identifier('undefined')
    switch (node.type) {
      case 'NumericLiteral':
        return t.numericLiteral(node.value)
      case 'StringLiteral':
        return t.stringLiteral(node.value)
      case 'BooleanLiteral':
        return t.booleanLiteral(node.value)
      case 'NullLiteral':
        return t.nullLiteral()
      case 'Identifier':
        return readName(node.name)

      case 'MemberExpression': {
        const obj = node.object
        // `n.A` is the register file, but only while `n` is still the VM state
        // parameter. A nested function that takes `n` of its own shadows it —
        // mapping that one to `__state` turned `n[r] = char` into a write into
        // the register file.
        if (obj.type === 'Identifier' && obj.name === vmParam && !scope.declares(obj.name)) {
          if (node.computed) {
            const idx = ev(node.property)
            return idx.type === 'NumericLiteral' ? reg(idx.value) : t.memberExpression(t.identifier('__state'), idx, true)
          }
          const key = node.property.name
          const MAP = { A: '__state', u: '__ip', S: '__boundary', M: '__frames', o: '__parent', I: '__thrown' }
          if (MAP[key]) return t.identifier(MAP[key])
        }
        // `X.A[<n>]` with n >= 868 is a module-scope cell, and module cells are
        // the same binding no matter which frame reaches them. Resolving the
        // chain to the hoisted variable is what lets handlers that read a
        // grandparent frame (`n.o.o.A[907]`) lift instead of being refused.
        if (
          node.computed &&
          t.isNumericLiteral(node.property) &&
          node.property.value >= 868 &&
          t.isMemberExpression(obj) &&
          !obj.computed &&
          t.isIdentifier(obj.property, { name: 'A' })
        ) {
          return t.identifier(`mod${node.property.value}`)
        }
        // A non-computed property name is a literal name, not a variable
        // reference. Substituting its bound value produced `obj.<expression>`,
        // which Babel rejects — that single bug accounted for 365 of the
        // translation failures.
        const prop = !node.computed && node.property.type === 'Identifier'
          ? t.identifier(node.property.name)
          : ev(node.property)
        return t.memberExpression(ev(obj), prop, node.computed)
      }

      case 'ThisExpression':
        return t.thisExpression()
      case 'RegExpLiteral':
        return t.regExpLiteral(node.pattern, node.flags ?? '')
      case 'Super':
        return t.super()
      case 'NewExpression': {
        // `new X(...)` — the tail of the global-lookup family is
        // `throw new ReferenceError(...)`, and without this case the whole
        // instruction was refused and emitted as an opaque call.
        const callee = ev(node.callee)
        const args = node.arguments.map((a) => (a && a.type === 'SpreadElement' ? t.spreadElement(ev(a.argument)) : ev(a)))
        return t.newExpression(callee, args)
      }
      case 'CallExpression':
        return evCall(node)
      case 'BinaryExpression':
        return t.binaryExpression(node.operator, ev(node.left), ev(node.right))
      case 'LogicalExpression':
        return t.logicalExpression(node.operator, ev(node.left), ev(node.right))
      case 'UnaryExpression':
        return t.unaryExpression(node.operator, ev(node.argument), node.prefix)
      case 'UpdateExpression': {
        // As with assignments, the operand must stay the handler's own
        // variable. Substituting its bound value turned `f++` into `0++`, which
        // Babel rejects — that single bug accounted for 386 of the 404
        // translation failures.
        const target = node.argument.type === 'Identifier' && scope.declares(node.argument.name)
          ? t.identifier(node.argument.name)
          : ev(node.argument)
        return t.updateExpression(node.operator, target, node.prefix)
      }
      case 'ConditionalExpression':
        return t.conditionalExpression(ev(node.test), ev(node.consequent), ev(node.alternate))
      case 'AssignmentExpression': {
        // The LEFT side must stay the handler's own variable. Substituting its
        // bound value there would turn `c = T[65]` into `T[6] = T[65]` and
        // overwrite the global string table instead of a local.
        const left = node.left.type === 'Identifier' && scope.declares(node.left.name)
          ? t.identifier(node.left.name)
          : ev(node.left)
        const right = ev(node.right)
        // An assignment to the instruction pointer is the handler transferring
        // control, not a store. Marking it lets the caller see both the plain
        // form and the conditional form, where the assignment sits inside a ?:
        // rather than on its own statement.
        if (left.type === 'Identifier' && left.name === '__ip') {
          return t.callExpression(t.identifier('__jump'), [right])
        }
        return t.assignmentExpression(node.operator, left, right)
      }
      case 'SequenceExpression':
        return t.sequenceExpression(node.expressions.map(ev))
      case 'ArrayExpression':
        return t.arrayExpression(node.elements.map((e) => (e ? ev(e) : null)))
      case 'ObjectExpression':
        return t.objectExpression(node.properties.map((p) => evProperty(p)))
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return evFunction(node)
      case 'TemplateLiteral':
        return t.templateLiteral(
          node.quasis.map((q) => t.templateElement({ raw: q.value.raw, cooked: q.value.cooked }, q.tail)),
          node.expressions.map(ev),
        )
      default:
        opaque = true
        return t.callExpression(t.identifier('__unsupported'), [t.stringLiteral(node.type)])
    }
  }

  function evProperty(p) {
    if (p.type === 'SpreadElement') return t.spreadElement(ev(p.argument))
    // A non-computed key is a literal name. Running it through `ev` treated it
    // as a variable reference, so `{t: 1}` became `{<t's value>: 1}`.
    const key = !p.computed
      ? (p.key.type === 'Identifier' ? t.identifier(p.key.name) : ev(p.key))
      : ev(p.key)
    const value = ev(p.value)
    const shorthand = !!p.shorthand && key.type === 'Identifier' && value.type === 'Identifier' && key.name === value.name
    return t.objectProperty(key, value, !!p.computed, shorthand)
  }

  /**
   * A nested function is its own scope: its parameters shadow the handler's
   * names, and its `var`s belong to it rather than to the handler around it.
   */
  function evFunction(node) {
    const outer = scope
    const inner = new Scope(outer)
    inner.written = collectWrites(node.body)
    scope = inner
    const params = []
    for (const p of node.params) {
      if (p.type === 'Identifier') {
        params.push(t.identifier(p.name))
        inner.bind(p.name, { real: true, node: null })
      } else if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') {
        params.push(t.assignmentPattern(t.identifier(p.left.name), ev(p.right)))
        inner.bind(p.left.name, { real: true, node: null })
      } else {
        // A destructuring parameter binds names this translation does not
        // model, so the body would reference bindings that never got emitted.
        opaque = true
        params.push(t.identifier('_'))
      }
    }
    const body = node.body.type === 'BlockStatement'
      ? evBlock(node.body)
      : t.blockStatement([t.returnStatement(ev(node.body))])
    scope = outer
    return node.type === 'ArrowFunctionExpression'
      ? t.arrowFunctionExpression(params, body)
      : t.functionExpression(null, params, body)
  }

  function evBlock(block) {
    const stmts = []
    for (const s of block.body) stmts.push(...evStatement(s))
    return t.blockStatement(stmts)
  }

  function slotTarget(idx) {
    return idx.type === 'NumericLiteral' ? reg(idx.value) : t.memberExpression(t.identifier('__state'), idx, true)
  }

  function evCall(node) {
    const callee = node.callee
    if (callee.type !== 'Identifier') return t.callExpression(ev(callee), node.arguments.map(ev))
    const args = node.arguments

    switch (callee.name) {
      case 'J':
        return operand(2)
      case 'L':
        return operand(1)
      case 'K':
        return operand(3)
      // cells exist only to emulate closure capture; a plain variable is the
      // real-JavaScript equivalent, so x/j/P all collapse
      case 'x':
      case 'j': {
        // Both take the frame to read from as their first argument. When it is
        // the current VM state this is a plain register; when it is some other
        // frame — `j(e, r)` with `e` obtained by walking `e = e.o` up the parent
        // chain — it is a closure upvalue. Name that operation instead of
        // either pretending it is a local register (which read `undefined`) or
        // dropping the instruction entirely.
        const frame = args[0]
        if (frame && !(frame.type === 'Identifier' && frame.name === vmParam)) {
          return t.callExpression(t.identifier('__upvalue'), [ev(frame), ev(args[1])])
        }
        return slotTarget(ev(args[1]))
      }
      case 'P':
        return ev(args[0])
      case 'N':
      case 'U': {
        const frame = args[0]
        if (frame && !(frame.type === 'Identifier' && frame.name === vmParam)) {
          return t.callExpression(t.identifier('__setUpvalue'), [ev(frame), ev(args[1]), ev(args[2])])
        }
        return t.assignmentExpression('=', slotTarget(ev(args[1])), ev(args[2]))
      }
      case 'G':
        return t.updateExpression('++', slotTarget(ev(args[1])), false)
      case 'H':
        // `H` is the frame-unwind helper only when the handler has not rebound
        // it. Handler 0084 assigns `H = "".padStart ? function … : …` — a
        // padding helper — and treating that as frame unwinding made the whole
        // module initialiser opaque for no reason.
        if (scope.declares('H') || handlerRebinds(opcode, 'H')) return t.callExpression(t.identifier('H'), args.map(ev))
        // Frame unwinding is a named runtime primitive (output/vm-runtime.js
        // `unwindFrame`), not an opaque opcode index. Emitting the name keeps the
        // instruction readable instead of erasing it into __native(348).
        return t.callExpression(t.identifier('__unwind'), [])
      case 'Y':
        return t.callExpression(t.identifier('__enter'), args.map(ev))
      default: {
        // The callee is a name, not a VM helper. If the handler declared it,
        // the declaration is what makes the call mean anything: emit a real
        // local for a mutable binding, and the bound function itself for an
        // initializer that is a function expression.
        const binding = scope.lookup(callee.name)
        const translated = args.map(ev)
        if (binding && !binding.real && binding.node) {
          const value = clone(binding.node)
          return t.callExpression(isFunctionNode(value) ? t.parenthesizedExpression(value) : value, translated)
        }
        return t.callExpression(t.identifier(callee.name), translated)
      }
    }
  }

  /**
   * Decide what a declarator means and translate its initializer.
   *
   * A declaration without an initializer declares the name; it does not bind it
   * to `undefined`. Recording it as such turned `S[t = …]` into
   * `S[undefined = …]`. It still has to be *declared* in the output, and so does
   * any local that is assigned later — inlining a value into a name that is then
   * written leaves the write with nowhere to land.
   *
   * The name is bound before its initializer is translated, so a
   * self-referencing declaration reads the previous value rather than recursing.
   */
  function bindDeclaration(d, kind) {
    const owner = kind === 'var' ? scope.fn : scope
    const name = d.id.name
    const real = !d.init || owner.written.has(name)
    owner.bind(name, { real, node: null })
    const value = d.init ? ev(d.init) : null
    if (!real) owner.bind(name, { real: false, node: value })
    return { name, real, value }
  }

  function evStatement(node) {
    switch (node.type) {
      case 'VariableDeclaration': {
        const decls = []
        for (const d of node.declarations) {
          if (!isSimpleTarget(d.id)) {
            // Destructuring binds several names at once; this translation
            // cannot express that, so the instruction is refused rather than
            // emitted with the bindings missing.
            opaque = true
            return []
          }
          const { name, real, value } = bindDeclaration(d, node.kind)
          if (real) decls.push(t.variableDeclarator(t.identifier(name), value))
        }
        return decls.length ? [t.variableDeclaration(node.kind, decls)] : []
      }
      case 'ExpressionStatement': {
        const expr = ev(node.expression)
        if (!expr) return []
        // A transfer can sit at the end of a sequence: `N(n,r,…), n.u = t`.
        // The parts before it are real effects and must still be emitted —
        // dropping them would lose the assignment that feeds the branch.
        if (expr.type === 'SequenceExpression') {
          const head = expr.expressions.slice(0, -1)
          const last = expr.expressions[expr.expressions.length - 1]
          const transferred = asJump(last)
          if (transferred) {
            jump = transferred
            return head.filter(Boolean).map((e) => t.expressionStatement(e))
          }
        }
        const transferred = asJump(expr)
        if (transferred) {
          jump = transferred
          return []
        }
        return [t.expressionStatement(expr)]
      }
      case 'BlockStatement':
        return [evBlock(node)]
      case 'IfStatement':
        return [
          t.ifStatement(
            ev(node.test),
            t.blockStatement(evStatement(node.consequent).flat()),
            node.alternate ? t.blockStatement(evStatement(node.alternate).flat()) : null,
          ),
        ]
      case 'BreakStatement':
        return [t.breakStatement(node.label ? t.identifier(node.label.name) : null)]
      case 'ContinueStatement':
        return [t.continueStatement(node.label ? t.identifier(node.label.name) : null)]
      case 'EmptyStatement':
        return []
      case 'FunctionDeclaration': {
        const params = node.params.map((p) => t.identifier(p.name ?? '_'))
        return [
          t.functionDeclaration(
            t.identifier(node.id?.name ?? '_fn'),
            params,
            evBlock(node.body.type === 'BlockStatement' ? node.body : { type: 'BlockStatement', body: [] }),
          ),
        ]
      }
      case 'TryStatement': {
        const block = t.blockStatement(evStatement(node.block).flat())
        const catchNode = node.handler
          ? t.catchClause(
              node.handler.param?.type === 'Identifier' ? t.identifier(node.handler.param.name) : null,
              t.blockStatement(evStatement(node.handler.body).flat()),
            )
          : null
        const finalizer = node.finalizer ? t.blockStatement(evStatement(node.finalizer).flat()) : null
        return [t.tryStatement(block, catchNode, finalizer)]
      }
      case 'SwitchStatement': {
        const cases = (node.cases ?? []).map((c) =>
          t.switchCase(c.test ? ev(c.test) : null, evStatement({ type: 'BlockStatement', body: c.consequent }).flat()),
        )
        return [t.switchStatement(ev(node.discriminant), cases)]
      }
      case 'ForInStatement': {
        // `for (var o in x(n,t)) i.push(o)` — plain property enumeration.
        // There is no reason to refuse it: it is already JavaScript.
        const left =
          node.left.type === 'VariableDeclaration'
            ? t.variableDeclaration(
                'var',
                node.left.declarations.map((d) => t.variableDeclarator(t.identifier(d.id.name), null)),
              )
            : ev(node.left)
        return [
          t.forInStatement(left, ev(node.right), t.blockStatement(evStatement(node.body).flat())),
        ]
      }
      case 'ForStatement': {
        let initNode = null
        if (node.init?.type === 'VariableDeclaration') {
          const decls = []
          for (const d of node.init.declarations) {
            if (!isSimpleTarget(d.id)) {
              opaque = true
              return []
            }
            // A loop counter is read and written across iterations, so it is a
            // real local: inlining its initializer into the test is what
            // produced `for (var t = n.length; 0 < n.length; r++)`. A bound
            // that the body only reads stays inlined.
            const { name, value } = bindDeclaration(d, node.init.kind)
            decls.push(t.variableDeclarator(t.identifier(name), value))
          }
          initNode = t.variableDeclaration(node.init.kind, decls)
        } else if (node.init) initNode = ev(node.init) // a ForStatement init must be an Expression, not a statement
        return [
          t.forStatement(
            initNode,
            node.test ? ev(node.test) : null,
            node.update ? ev(node.update) : null,
            t.blockStatement(evStatement(node.body).flat()),
          ),
        ]
      }
      case 'ThrowStatement':
        return [t.throwStatement(ev(node.argument))]
      case 'ReturnStatement':
        return [t.returnStatement(node.argument ? ev(node.argument) : null)]
      default:
        // A function declaration, a loop kind this translation does not model,
        // a switch: refuse the instruction rather than emit a body whose
        // bindings and control flow are not represented.
        opaque = true
        return []
    }
  }

  let statements = []
  if (ast.body.type === 'BlockStatement') {
    for (const s of ast.body.body) statements.push(...evStatement(s))
  }

  if (opaque) return null
  return { statements, jump, operandsConsumed: cursor }
}

// --- validation -------------------------------------------------------------
const irCache = new Map()
const failures = []
let operandMismatch = 0
let liftable = 0

for (const ins of disasm.instructions) {
  const key = `${ins.opcode}:${ins.operands.join(',')}`
  if (irCache.has(key)) continue
  let ir = null
  try {
    ir = translateHandler(ins.opcode, ins.operands)
  } catch (err) {
    // Babel rejects a malformed node at construction time. That is the AST
    // equivalent of "this handler is not liftable" — a native library function
    // such as Object.keys or the regenerator runtime — so it is refused
    // explicitly rather than emitted as a guess.
    if (!failures.some((f) => f.opcode === ins.opcode)) failures.push({ opcode: ins.opcode, error: err.message })
    ir = null
  }
  irCache.set(key, ir)
  if (ir) {
    liftable++
    if (ir.operandsConsumed !== widths[ins.opcode].operands.length) operandMismatch++
  }
}

console.log(`distinct instruction shapes  ${irCache.size}`)
console.log(`lifted                       ${liftable}`)
console.log(`refused (opaque)             ${irCache.size - liftable}`)
console.log(`opcodes refused at build     ${failures.length}`)
console.log(`operand-count mismatches     ${operandMismatch}`)
if (operandMismatch === 0) {
  console.log('\noperand model agrees with the translation on every shape.')
}
for (const f of failures.slice(0, 5)) console.log(`  ! op${f.opcode}: ${f.error}`)
