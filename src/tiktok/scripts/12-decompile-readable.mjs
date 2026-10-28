#!/usr/bin/env node
/**
 * Readable decompilation layer.
 *
 * `decompiled-faithful.js` is exact but speaks in the interpreter's own
 * vocabulary: operand locals, `x(n,7)`, `N(n,8,0)`, and the memoised string
 * certificate `S[T[a]+':'+T[b]]||(S[T[a]+':'+T[b]]=m(T[a],T[b]))`. This pass
 * keeps the semantics identical while removing that vocabulary:
 *
 *   1. operands are substituted for the J/L/K reads, then constant-propagated,
 *      so `var t=8,r=0; … N(n,t,r)` becomes `N(n,8,0)`;
 *   2. the VM helper calls are rewritten into one readable register algebra
 *      (`V(N)` read, `V(N)=` write, `cell(N)`, `ip = …`);
 *   3. every string-decrypt idiom is replaced by its decrypted literal, which
 *      is what turns `S[T[62]+':'+T[5]]||…` into `"includes"`;
 *   4. the per-instruction IIFE wrapper is dropped.
 *
 * Nothing here interprets an opcode — the meaning still comes from the handler
 * body. Only the surface syntax changes.
 *
 * Emits output/readable.js.
 *
 *   node scripts/12-decompile-readable.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'

const generate = _generate.default ?? _generate
const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const TMP = path.join(ROOT, 'tmp')
const OUT = path.join(ROOT, 'output')

const disasm = JSON.parse(fs.readFileSync(path.join(TMP, 'disasm.json'), 'utf8'))
const fnDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'functions.json'), 'utf8'))
const table = JSON.parse(fs.readFileSync(path.join(TMP, 'opcode-table.json'), 'utf8'))
const strings = JSON.parse(fs.readFileSync(path.join(TMP, 'strings.json'), 'utf8'))
const byOpcode = new Map(table.opcodes.map((o) => [o.opcode, o]))

// index -> decrypted literal, for the string substitution below
const plain = new Map()
for (const [k, v] of Object.entries(strings)) {
  if (!/^\d+$/.test(k)) continue
  if (v && typeof v.plain === 'string') plain.set(Number(k), v.plain)
}

const READER = { J: 2, L: 1, K: 3 }
const handlerCache = new Map()
const reparseFailures = new Set()
const renderFailures = new Set()

function handlerSource(opcode) {
  if (handlerCache.has(opcode)) return handlerCache.get(opcode)
  const file = path.join(TMP, 'handlers', String(opcode).padStart(4, '0') + '.js')
  const body = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n')
    .trim()
  handlerCache.set(opcode, body)
  return body
}

/**
 * Rewrite the VM helper vocabulary into a register algebra, on the AST.
 *
 * Registers are spelled as array elements (`R[9]` read, `R[9] = v` write). That
 * is the register machine's natural shape, it is valid JavaScript, and unlike
 * `V(9) = v` it does not require a call on the left of an assignment.
 */
function normalizeHelpers(ast) {
  const REPLACE = {
    x: (a) => (a[1] ? reg(a[1]) : null),
    j: (a) => (a[1] ? call('cell', a[1]) : null),
    U: (a) => (a[1] && a[2] ? assign(raw(a[1]), a[2]) : null),
    N: (a) => (a[1] && a[2] ? assign(reg(a[1]), a[2]) : null),
    G: (a) => (a[1] ? { type: 'UpdateExpression', operator: '++', prefix: false, argument: reg(a[1]) } : null),
    P: (a) => (a[0] ? call('cellOf', a[0]) : null),
  }
  traverse(
    { type: 'File', program: { type: 'Program', sourceType: 'script', body: [ast], directives: [] } },
    {
      CallExpression(p) {
        const callee = p.node.callee
        if (callee?.type !== 'Identifier') return
        const build = REPLACE[callee.name]
        if (!build) return
        // A handler that calls a helper with an unexpected shape keeps its
        // original form: rewriting it with a missing operand produced `R[]`,
        // which is not JavaScript.
        const replacement = build(p.node.arguments)
        if (replacement) p.replaceWith(replacement)
      },
    },
  )
}

const ident = (name) => ({ type: 'Identifier', name })
const call = (name, ...args) => ({
  type: 'CallExpression',
  callee: ident(name),
  arguments: args.filter(Boolean),
})
const member = (obj, idx) => ({ type: 'MemberExpression', object: ident(obj), property: idx, computed: true })
const reg = (idx) => member('R', idx)
const raw = (idx) => member('raw', idx)
const assign = (left, right) => ({ type: 'AssignmentExpression', operator: '=', left, right })

/** Replace a string-decrypt idiom with its literal. */
function substituteStrings(code) {
  // 1. the decrypt call itself, whichever local name the handler used
  code = code.replace(/\b(m|dec|strdec|decrypt)\(\s*T\[(\d+)\]\s*,\s*T\[(\d+)\]\s*\)/g, (whole, fn, a) => {
    const v = plain.get(Number(a))
    return v === undefined ? whole : JSON.stringify(v)
  })
  // 2. every cache read `S[T[a] + Q + T[b]]` becomes the literal too. Without
  //    this the memo below would collapse but later reads of the same key would
  //    be left pointing at an array entry nothing writes any more.
  code = code.replace(
    /S\[T\[(\d+)\]\s*\+\s*("[^"]*"|'[^']*')\s*\+\s*T\[(\d+)\]\]/g,
    (whole, a) => {
      const v = plain.get(Number(a))
      return v === undefined ? whole : JSON.stringify(v)
    },
  )
  // 3. single-slot keys `S[T[n]]` resolve the same way.
  code = code.replace(/S\[T\[(\d+)\]\]/g, (whole, a) => {
    const v = plain.get(Number(a))
    return v === undefined ? whole : JSON.stringify(v)
  })
  // 4. the memo wrapper is now `"literal" || ("literal" = "literal")` — a no-op.
  code = code.replace(/"((?:[^"\\]|\\.)*)"\s*\|\|\s*\(\s*"(?:[^"\\]|\\.)*"\s*=\s*"(?:[^"\\]|\\.)*"\s*\)/g, '"$1"')
  // 5. a leading bare literal left behind by the collapse is a dead expression
  //    statement; drop it so the line starts at the real effect.
  code = code.replace(/(^|[{;,])\s*"(?:[^"\\]|\\.)*"\s*,\s*/g, '$1')
  return code
}

/** True for an expression built only from `T[<n>]` slots and string literals. */
function isConstKeyExpression(node, depth = 0) {
  if (!node || depth > 4) return false
  if (node.type === 'StringLiteral') return true
  if (node.type === 'MemberExpression') return node.object?.name === 'T' && node.computed && node.property.type === 'NumericLiteral'
  if (node.type === 'BinaryExpression') return isConstKeyExpression(node.left, depth + 1) && isConstKeyExpression(node.right, depth + 1)
  return false
}

function literal(a, b, fallback) {
  const payload = plain.get(Number(a))
  if (payload === undefined) return fallback
  return JSON.stringify(payload)
}

/**
 * Last-resort rendering: substitute operands textually and emit the handler
 * body unchanged. Less readable than the normalized form, but it still states
 * exactly what the instruction does, so a normalization failure degrades
 * readability rather than losing the instruction.
 */
function fallbackRender(ins) {
  let cursor = 0
  const code = handlerSource(ins.opcode).replace(/\b[JLK]\(n\)/g, () => String(ins.operands[cursor++] ?? 0))
  return substituteStrings(code.replace(/\n/g, ' '))
}

/** Render one instruction with operands substituted and syntax normalized. */
function renderInstruction(ins) {
  const body = handlerSource(ins.opcode)
  let ast = parse(`(${body})`, { sourceType: 'script' }).program.body[0].expression

  // Each phase mutates the tree structurally, which invalidates Babel's cached
  // scope binding information. Regenerating and re-parsing between phases keeps
  // every pass working against a tree with correct scope data — without it the
  // constant-propagation passes silently find no bindings and do nothing.
  const reparse = (node) => {
    try {
      return parse(`(${generate(node, { compact: true }).code})`, { sourceType: 'script' }).program.body[0]
        .expression
    } catch {
      // A generated expression can be unparseable when a handler's body is not
      // a single expression. Keep the node as-is and record it; silently
      // dropping the instruction would be worse than a less-normalized line.
      reparseFailures.add(ins.opcode)
      return node
    }
  }
  // 1. replace J/L/K with the real operands, in byte-stream order
  let cursor = 0
  const values = ins.operands
  traverse(
    { type: 'File', program: { type: 'Program', sourceType: 'script', body: [ast], directives: [] } },
    {
      CallExpression(p) {
        if (p.node.callee?.type !== 'Identifier') return
        if (!READER[p.node.callee.name]) return
        p.replaceWith({ type: 'NumericLiteral', value: values[cursor++] ?? 0 })
      },
    },
  )
  ast = reparse(ast)

  // 2. `n.u` / `n.A[i]` / `n.S` / `n.M` / `n.o` — only where `n` is this
  // handler's own parameter, never inside a nested closure that rebinds it.
  traverse(
    { type: 'File', program: { type: 'Program', sourceType: 'script', body: [ast], directives: [] } },
    {
      MemberExpression(p) {
        const obj = p.node.object
        if (obj?.type !== 'Identifier' || obj.name !== 'n') return
        if (p.getFunctionParent()?.node !== ast) return
        const prop = p.node.property
        const key = prop.type === 'Identifier' ? prop.name : prop.value
        const MAP = { u: 'ip', S: 'cellBoundary', M: 'frames', o: 'parent', A: 'slot' }
        const name = MAP[key]
        if (!name) return
        if (name === 'slot') {
          p.replaceWith(member('raw', p.node.computed ? prop : { type: 'StringLiteral', value: prop.name }))
        } else {
          p.replaceWith(ident(name))
        }
      },
    },
  )
  normalizeHelpers(ast)
  ast = reparse(ast)

  // 3. numeric operand locals first: `var t=62` must become a literal before
  //    the T-propagation below can recognise `T[62]` (it would otherwise see
  //    the index still spelled as the variable `t`).
  ast = propagate(ast, (init) => init?.type === 'NumericLiteral')

  // 4. `var X = T[<n>]` so the string idiom sees `T[<n>]`
  ast = propagate(ast, (init) => init?.type === 'MemberExpression' && init.object?.name === 'T' && init.computed && init.property.type === 'NumericLiteral')

  // 5. the memo key `var a = T[62] + ":" + T[5]` — a constant expression built
  //    only from table slots and string literals — so `S[a]` can be spelled out.
  ast = propagate(ast, (init) => isConstKeyExpression(init), 3)

  let code = generate(ast.body, { compact: true, concise: true }).code
  code = substituteStrings(code)
  return code
}

/** Inline every single-assignment local whose initializer matches `match`. */
function propagate(ast, match) {
  traverse(
    { type: 'File', program: { type: 'Program', sourceType: 'script', body: [ast], directives: [] } },
    {
      VariableDeclarator(p) {
        const { id, init } = p.node
        if (id?.type !== 'Identifier' || !match(init)) return
        const binding = p.scope.getBinding(id.name)
        if (!binding || !binding.constant) return
        const replacement = JSON.parse(JSON.stringify(init))
        for (const ref of binding.referencePaths) ref.replaceWith({ ...replacement })
        const decl = p.parentPath
        if (decl?.isVariableDeclaration() && decl.node.declarations.length === 1) decl.remove()
        else p.remove()
      },
    },
  )
  try {
    return parse(`(${generate(ast, { compact: true }).code})`, { sourceType: 'script' }).program.body[0]
      .expression
  } catch {
    return ast
  }
}

// --- emit -------------------------------------------------------------------
const out = []
out.push('/*')
out.push(' * Readable decompilation — TikTok mssdk / byted_acrawler JSVMP')
out.push(' *')
out.push(' * This is a transcription of third-party code (byted_acrawler), kept as')
out.push(' * evidence. It is not written to be executed, and it deliberately preserves')
out.push(' * the target’s own behaviour — including its weaknesses — rather than fixing')
out.push(' * them. See the README section on seed entropy.')
out.push(' *')
out.push(` *   bytecode      ${disasm.bytecodeBytes} bytes`)
out.push(` *   instructions  ${disasm.instructionCount}`)
out.push(` *   functions     ${fnDoc.functions.length}`)
out.push(' *')
out.push(' * Register algebra used below:')
out.push(' *   V(n)          read register n through the cell boundary')
out.push(' *   V(n) = x      write register n through the cell boundary')
out.push(' *   slot(n)       the raw slot, bypassing cell indirection')
out.push(' *   cell(n)       the cell object itself (closure capture by reference)')
out.push(' *   cellOf(v)     allocate a cell around v')
out.push(' *   ip            instruction pointer; assigning it branches')
out.push(' *   frames/parent frame stack and enclosing frame')
out.push(' *   cellBoundary  registers below this hold cells {v}, at or above hold plain values')
out.push(' *')
out.push(' * Every statement is derived mechanically from the real handler for that')
out.push(' * opcode, with its real operands substituted — no opcode meaning is invented')
out.push(' * here. String-decrypt idioms are replaced by the decrypted literal.')
out.push(' */')
out.push('')

for (const fn of fnDoc.functions) {
  const body = disasm.instructions.filter((i) => i.at >= fn.start && i.at < fn.end)
  out.push(
    `// fn ${fn.id} — entry ${fn.start}, ${fn.instructionCount} instructions${
      fn.calledVia.length ? `, created by ${fn.calledVia.join('/')}` : ', bootstrap'
    }`,
  )
  out.push(`function fn_${fn.id}() {`)
  for (const ins of body) {
    const spec = byOpcode.get(ins.opcode)
    const label = spec?.mnemonic ?? `op${ins.opcode}`
    let code
    try {
      code = renderInstruction(ins)
    } catch (err) {
      renderFailures.add(ins.opcode)
      code = fallbackRender(ins)
    }
    out.push(`  /* @${ins.at} */ ${code}   // ${label}`)
  }
  out.push('}')
  out.push('')
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'readable.js'), out.join('\n') + '\n')

const text = fs.readFileSync(path.join(OUT, 'readable.js'), 'utf8')
console.log(`instructions rendered ${disasm.instructionCount}`)
console.log(`functions             ${fnDoc.functions.length}`)
console.log(`bytes                 ${text.length}`)
console.log(`string idioms left    ${(text.match(/S\[T\[/g) ?? []).length}`)
console.log(`bare decrypts left    ${(text.match(/\b(m|dec|strdec)\(T\[/g) ?? []).length}`)
console.log(`V( occurrences        ${(text.match(/\bV\(/g) ?? []).length}`)
console.log(`render fallbacks      ${renderFailures.size}${renderFailures.size ? ' opcodes: ' + [...renderFailures].sort((a,b)=>a-b).join(',') : ''}`)
console.log(`reparse fallbacks     ${reparseFailures.size}${reparseFailures.size ? ' opcodes: ' + [...reparseFailures].join(',') : ''}`)
console.log(`output                ${path.join(OUT, 'readable.js')}`)
