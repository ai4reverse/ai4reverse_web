#!/usr/bin/env node
/**
 * Recover the plaintext string table of the mssdk JavaScript VM.
 *
 * The bundle hides every readable string behind three layers:
 *
 *   T      an array literal of short base64-ish literals
 *   m      function m(raw, key) -> XOR(utf8(base64(raw)), key)
 *   R / D  a hand-written base64 decoder and a UTF-8 decoder
 *
 * Handlers in the dispatch table `C` do
 *
 *   var f = T[a], c = T[b]; S[f+":"+c] || (S[f+":"+c] = m(f, c))
 *
 * where `a` and `b` are *immediates read from the bytecode*. So the pairs that
 * are actually used are recoverable exactly, not by guessing: walk the bytecode
 * with the same instruction widths the interpreter uses, and read the operands
 * that the handler feeds into `T[...]`.
 *
 * Everything here is an independent re-implementation of the observed
 * behaviour. No minified source was copied: the base64 reader, the UTF-8
 * reader and the XOR are written from the semantics, then validated against
 * decoding the bundle itself performs (see VALIDATIONS in the output).
 *
 * Inputs
 *   resources/mssdk.min.js   target bundle (read only)
 *   tmp/bytecode.bin         inflated bytecode, if 04-disasm.mjs already ran
 *
 * Outputs
 *   tmp/strings.json         per-index record + the verified (i, j) pair list
 *   tmp/strings.md           human-readable table, most interesting first
 *
 *   node scripts/05-strings.mjs [input]
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import vm from 'node:vm'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const INPUT = process.argv[2] ?? path.join(ROOT, 'resources/mssdk.min.js')
const TMP = path.join(ROOT, 'tmp')

const source = fs.readFileSync(INPUT, 'utf8')

// ---------------------------------------------------------------------------
// 1. The decoder, re-implemented from observed semantics
// ---------------------------------------------------------------------------

/**
 * Base64 decode with the bundle's alphabet and its forgiving input handling.
 *
 * The last two symbols are `+` and `/`. Characters outside [A-Za-z0-9+/] are
 * skipped without advancing the quartet, which is how `=` padding and stray
 * whitespace are tolerated. A short final quartet is zero-padded, and the
 * output shrinks by one byte for each symbol missing from a full quartet.
 */
function base64Decode (text) {
  const PLUS = 43
  const SLASH = 47
  const out = new Uint8Array(Math.floor((text.length / 4) * 3))
  const quartet = [0, 0, 0, 0]
  let written = 0
  let read = 0

  while (read < text.length) {
    let count = 0
    while (count < 4 && read < text.length) {
      let code = text.charCodeAt(read++)
      if (code >= 65 && code <= 90) code -= 65
      else if (code >= 97 && code <= 122) code -= 71
      else if (code >= 48 && code <= 57) code += 4
      else if (code === PLUS) code = 62
      else if (code === SLASH) code = 63
      else continue
      quartet[count] = code
      count += 1
    }
    if (count !== 4) {
      for (let pad = count; pad < 4; pad++) quartet[pad] = 0
    }
    out[written] = (quartet[0] << 2) | (quartet[1] >> 4)
    out[written + 1] = ((quartet[1] & 15) << 4) | (quartet[2] >> 2)
    out[written + 2] = ((quartet[2] & 3) << 6) | quartet[3]
    written += count - 1
  }
  return out.subarray(0, written)
}

/**
 * UTF-8 decode matching the bundle's decoder exactly, including its two quirks:
 *
 *   - a byte above 0xF4 selects no continuation length and decodes to U+0000
 *   - a four-byte sequence is emitted with String.fromCharCode, which keeps
 *     only the low 16 bits of the code point (no surrogate pair is built)
 *
 * A truncated final sequence becomes U+FFFD.
 */
function utf8Decode (bytes) {
  let text = ''
  let index = 0
  while (index < bytes.length) {
    let lead = bytes[index]
    let extra = 0
    let code = 0
    if (lead <= 0x7f) { extra = 0; code = lead & 0xff } else if (lead <= 0xdf) { extra = 1; code = lead & 0x1f } else if (lead <= 0xef) { extra = 2; code = lead & 0x0f } else if (lead <= 0xf4) { extra = 3; code = lead & 0x07 }

    if (bytes.length - index - extra > 0) {
      for (let step = 0; step < extra; step++) {
        lead = bytes[index + step + 1]
        code = (code << 6) | (lead & 0x3f)
      }
    } else {
      code = 0xfffd
      extra = bytes.length - index
    }
    text += String.fromCharCode(code)
    index += extra + 1
  }
  return text
}

/** Repeating-key XOR. An empty key is the identity, as `i % 0` yields NaN. */
function repeatingXor (text, key) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length))
  }
  return out
}

/** The full decoder: base64 -> utf-8 -> repeating-key XOR. */
function decodePair (raw, key) {
  return repeatingXor(utf8Decode(base64Decode(raw)), key)
}

/** True when the text has no control bytes, no U+FFFD and no DEL. */
function isText (text) {
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return false
    if (code === 0x7f || code === 0xfffd) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 2. Pull the string table, the handler table and the bytecode out of the AST
// ---------------------------------------------------------------------------

const ast = parse(source, {
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
})

function findStringTable () {
  let best = null
  traverse(ast, {
    VariableDeclarator (p) {
      const { id, init } = p.node
      if (id.type !== 'Identifier' || !init || init.type !== 'ArrayExpression') return
      const literals = init.elements.filter((e) => e && e.type === 'StringLiteral')
      if (literals.length < 500) return
      if (!best || literals.length > best.literals) best = { name: id.name, node: init, literals: literals.length }
    },
  })
  if (!best) throw new Error('string table `T = [...]` not found')
  return best
}

function findHandlerTable () {
  let best = null
  traverse(ast, {
    AssignmentExpression (p) {
      const { left, right } = p.node
      if (left?.type !== 'Identifier' || right?.type !== 'ArrayExpression') return
      const els = right.elements.filter(Boolean)
      if (els.length < 16) return
      if (!els.every((e) => e.type === 'FunctionExpression')) return
      if (!best || els.length > best.els.length) best = { name: left.name, els }
    },
  })
  if (!best) throw new Error('handler table `C = [...]` not found')
  return best
}

const stringTable = findStringTable()
const handlerTable = findHandlerTable()
const tableNodes = stringTable.node.elements

/**
 * The bytecode lives in `X.dwAbA(R("<base64>"))`. Reuse tmp/bytecode.bin when a
 * previous stage already produced it; otherwise inflate it here.
 */
function readBytecode () {
  const cached = path.join(TMP, 'bytecode.bin')
  if (fs.existsSync(cached)) return fs.readFileSync(cached)
  const match = /=(\w+)\.dwAbA\(R\("([A-Za-z0-9+/=]{1000,})"\)\)/.exec(source)
  if (!match) throw new Error('bytecode assignment `X.dwAbA(R("..."))` not found')
  return zlib.inflateRawSync(Buffer.from(match[2], 'base64'))
}

// ---------------------------------------------------------------------------
// 3. The non-literal table entries
// ---------------------------------------------------------------------------

/**
 * T is not entirely literal. A few of its elements are bare identifiers that
 * reference strings assembled by the anti-tamper preamble and mutated again by
 * guarded bootstrap blocks. Those are replayed here in a throwaway `vm`
 * context: the blocks are pure string arithmetic (literals, `+`, `.slice`,
 * `.length`), so evaluating them is exact.
 *
 * A resolved value is only trusted when it is base64-shaped, because that is
 * the only shape a T entry can have and still decode. The decode check in the
 * validation section then confirms each one produces readable text.
 */
function resolvePreambleStrings (names) {
  const preambleNames = new Set()
  traverse(ast, {
    VariableDeclarator (p) {
      const { id, init, start } = p.node
      if (id.type === 'Identifier' && !init && start < 400) preambleNames.add(id.name)
    },
  })

  // Guarded blocks that assign to those bindings, in execution order.
  const blocks = []
  traverse(ast, {
    LogicalExpression (p) {
      const { operator, right, start, end } = p.node
      if (operator !== '&&' || !right || right.type !== 'SequenceExpression') return
      const assigns = right.expressions.filter(
        (e) => e.type === 'AssignmentExpression' && e.left.type === 'Identifier' && preambleNames.has(e.left.name),
      )
      if (assigns.length) blocks.push({ start, end })
    },
  })
  blocks.sort((a, b) => a.start - b.start)

  const context = vm.createContext({})
  // Literal constants that precede the first guarded block drive its guards.
  const head = source.slice(0, blocks[0]?.start ?? 0)
  const seed = /(?:^|[,(])\s*([A-Za-z_$][\w$]*)\s*=\s*(!?[01]|-?\d+|"(?:[^"\\]|\\.)*")/g
  let seeded = 0
  for (const m of head.matchAll(seed)) {
    if (!preambleNames.has(m[1])) continue
    try {
      vm.runInContext(`var ${m[1]} = ${m[2]};`, context)
      seeded += 1
    } catch {
      // A literal the sandbox refuses stays undefined; the base64 shape check
      // below decides whether the replayed result is trustworthy.
    }
  }

  const evaluated = []
  for (const block of blocks) {
    try {
      vm.runInContext(source.slice(block.start, block.end), context)
      evaluated.push({ start: block.start, ok: true })
    } catch (err) {
      evaluated.push({ start: block.start, ok: false, error: err.message })
    }
  }

  const resolved = new Map()
  const unresolved = []
  for (const name of names) {
    const value = context[name]
    if (typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) resolved.set(name, value)
    else unresolved.push(name)
  }
  return { resolved, unresolved, blocks: blocks.length, seeded, evaluated }
}

const nonLiteral = []
tableNodes.forEach((node, index) => {
  if (!node || node.type === 'StringLiteral') return
  nonLiteral.push({ index, type: node.type, name: node.type === 'Identifier' ? node.name : null })
})
const preamble = resolvePreambleStrings(nonLiteral.map((n) => n.name).filter(Boolean))

/** Raw value of every T entry, or null when it is not resolvable to a string. */
const rawValues = tableNodes.map((node, index) => {
  if (node && node.type === 'StringLiteral') return node.value
  const entry = nonLiteral.find((n) => n.index === index)
  if (entry?.name && preamble.resolved.has(entry.name)) return preamble.resolved.get(entry.name)
  return null
})

// ---------------------------------------------------------------------------
// 4. Which operand feeds which T slot, per decode handler
// ---------------------------------------------------------------------------

const OPERAND_WIDTH = { J: 2, L: 1, K: 3 }
const NESTED_FUNCTION = new Set(['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'])

/** Walk a function body without descending into nested functions. */
function walkOwnBody (fnNode, visit) {
  let nested = 0
  const step = (node) => {
    if (!node || typeof node !== 'object') return
    if (NESTED_FUNCTION.has(node.type)) {
      nested += 1
      for (const key in node) {
        if (key === 'loc' || key === 'start' || key === 'end') continue
        const value = node[key]
        if (Array.isArray(value)) value.forEach(step)
        else step(value)
      }
      nested -= 1
      return
    }
    if (nested === 0) visit(node)
    for (const key in node) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) value.forEach(step)
      else step(value)
    }
  }
  step(fnNode.body)
}

/** Operand readers seen in a handler, in source order, with their byte widths. */
function operandReads (fnNode) {
  const wrapper = parse(`(${source.slice(fnNode.start, fnNode.end)})`, { sourceType: 'script' }).program.body[0].expression
  const param = wrapper.params[0]?.name
  const isRead = (node) =>
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    OPERAND_WIDTH[node.callee.name] !== undefined &&
    node.arguments[0]?.type === 'Identifier' &&
    node.arguments[0].name === param

  const events = []
  let declaresOwnM = false
  walkOwnBody(wrapper, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'm') declaresOwnM = true
    if (node.type === 'VariableDeclarator' && node.id?.name === 'm') declaresOwnM = true
    if (isRead(node)) events.push({ kind: 'read', start: node.start, width: OPERAND_WIDTH[node.callee.name] })
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isRead(node.init)) {
      events.push({ kind: 'bind', start: node.start, name: node.id.name })
    }
  })

  // A declarator starts before its init, so sorting by source position puts the
  // bind ahead of the read it names. `index` at that moment is the slot the
  // read is about to occupy.
  events.sort((a, b) => a.start - b.start || (a.kind === 'bind' ? -1 : 1))
  const slotOf = new Map()
  const sizes = []
  for (const event of events) {
    if (event.kind === 'bind') slotOf.set(event.name, sizes.length)
    else sizes.push(event.width)
  }
  return { wrapper, slotOf, sizes, declaresOwnM }
}

/**
 * Analyse one dispatch handler.
 *
 * Returns the operand slots of every genuine `m(raw, key)` call, where
 * "genuine" means `m` is the outer decoder and not a same-named local: the
 * bundled regenerator runtime declares its own `m`.
 */
function analyseHandler (fnNode) {
  const { wrapper, slotOf, sizes, declaresOwnM } = operandReads(fnNode)

  // Which local stands for a T slot: `f = T[t]`, as a declaration or a later
  // assignment. Order matters: two handlers reuse the same local for a second
  // decode (`f = T[a]; ... m(f, k); f = T[b]; m(f, k2)`), so a call must be
  // resolved against the binding that is in effect *at that call*, not the
  // final one in the function.
  const bindings = []
  const noteBinding = (name, indexVar, at) => bindings.push({ name, indexVar, at })
  walkOwnBody(wrapper, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init &&
      node.init.type === 'MemberExpression' &&
      node.init.object.type === 'Identifier' &&
      node.init.object.name === 'T' &&
      node.init.computed &&
      node.init.property.type === 'Identifier'
    ) {
      noteBinding(node.id.name, node.init.property.name, node.start)
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left.type === 'Identifier' &&
      node.right.type === 'MemberExpression' &&
      node.right.object.type === 'Identifier' &&
      node.right.object.name === 'T' &&
      node.right.computed &&
      node.right.property.type === 'Identifier'
    ) {
      noteBinding(node.left.name, node.right.property.name, node.start)
    }
  })
  bindings.sort((a, b) => a.at - b.at)

  /** The T index variable an identifier held at `callStart`. */
  const indexVarAt = (name, callStart) => {
    let latest = null
    for (const binding of bindings) {
      if (binding.at >= callStart) break
      if (binding.name === name) latest = binding.indexVar
    }
    return latest
  }

  const resolveArgument = (arg, callStart) => {
    if (
      arg.type === 'MemberExpression' &&
      arg.object.type === 'Identifier' &&
      arg.object.name === 'T' &&
      arg.computed &&
      arg.property.type === 'Identifier'
    ) {
      return arg.property.name
    }
    if (arg.type === 'Identifier') return indexVarAt(arg.name, callStart)
    return null
  }

  const pairs = []
  let decodeCalls = 0
  walkOwnBody(wrapper, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'm' &&
      node.arguments.length === 2
    ) {
      decodeCalls += 1
      const rawVar = resolveArgument(node.arguments[0], node.start)
      const keyVar = resolveArgument(node.arguments[1], node.start)
      if (!rawVar || !keyVar) return
      const rawSlot = slotOf.get(rawVar)
      const keySlot = slotOf.get(keyVar)
      if (rawSlot === undefined || keySlot === undefined) return
      pairs.push([rawSlot, keySlot])
    }
  })

  return { declaresOwnM, pairs, decodeCalls, operandCount: sizes.length, sizes }
}

const decodeHandlers = []
const excludedHandlers = []
handlerTable.els.forEach((fnNode, opcode) => {
  const analysis = analyseHandler(fnNode)
  if (!analysis.decodeCalls) return
  if (analysis.declaresOwnM) {
    excludedHandlers.push({ opcode, reason: 'declares its own `m`; not the string decoder' })
    return
  }
  if (analysis.pairs.length !== analysis.decodeCalls) {
    excludedHandlers.push({ opcode, reason: 'a T index did not resolve to an operand' })
    return
  }
  decodeHandlers.push({ opcode, pairs: analysis.pairs, sizes: analysis.sizes })
})

// ---------------------------------------------------------------------------
// 5. Walk the bytecode and collect the pairs that really appear
// ---------------------------------------------------------------------------

const widthCache = new Map()
function instructionSizes (opcode) {
  if (!widthCache.has(opcode)) {
    widthCache.set(opcode, operandReads(handlerTable.els[opcode]).sizes)
  }
  return widthCache.get(opcode)
}

function disassemble (bytecode) {
  const instructions = []
  let at = 0
  while (at < bytecode.length) {
    if (at + 1 >= bytecode.length) throw new Error(`truncated opcode at byte ${at}`)
    const opcode = (bytecode[at] << 8) | bytecode[at + 1]
    const sizes = instructionSizes(opcode)
    const operands = []
    let cursor = at + 2
    for (const size of sizes) {
      if (cursor + size > bytecode.length) throw new Error(`operand overruns bytecode at byte ${at}`)
      let value = 0
      for (let i = 0; i < size; i++) value = (value << 8) | bytecode[cursor + i]
      operands.push(value)
      cursor += size
    }
    instructions.push({ at, opcode, operands, width: cursor - at })
    at = cursor
  }
  return { instructions, end: at }
}

const bytecode = readBytecode()
const disassembly = disassemble(bytecode)
const instructions = disassembly.instructions

const pairPositions = new Map(decodeHandlers.map((d) => [d.opcode, d.pairs]))
const usedPairs = new Map()

for (const instruction of instructions) {
  const positions = pairPositions.get(instruction.opcode)
  if (!positions) continue
  for (const [rawSlot, keySlot] of positions) {
    const rawIndex = instruction.operands[rawSlot]
    const keyIndex = instruction.operands[keySlot]
    if (rawIndex === undefined || keyIndex === undefined) continue
    const id = `${rawIndex},${keyIndex}`
    if (!usedPairs.has(id)) usedPairs.set(id, { rawIndex, keyIndex, count: 0, opcodes: new Set() })
    const entry = usedPairs.get(id)
    entry.count += 1
    entry.opcodes.add(instruction.opcode)
  }
}

// ---------------------------------------------------------------------------
// 6. Decode the verified pairs
// ---------------------------------------------------------------------------

const pairs = []
for (const entry of usedPairs.values()) {
  const raw = rawValues[entry.rawIndex]
  const key = rawValues[entry.keyIndex]
  const record = { ...entry, opcodes: [...entry.opcodes], raw: raw ?? null, key: key ?? null, plain: null }
  if (typeof raw === 'string' && typeof key === 'string') {
    record.plain = decodePair(raw, key)
    record.text = isText(record.plain)
  } else {
    record.error = 'table entry is not a resolvable string'
    record.text = null
  }
  pairs.push(record)
}
pairs.sort((a, b) => b.count - a.count || a.rawIndex - b.rawIndex)

// ---------------------------------------------------------------------------
// 7. Fallback for entries no verified pair covers
// ---------------------------------------------------------------------------

const allKeys = rawValues
  .map((value, index) => ({ value, index }))
  .filter((k) => typeof k.value === 'string' && k.value.length > 0)

/**
 * Score a candidate plaintext. The verified vocabulary is almost entirely
 * JavaScript identifiers and URL/header text, so letters and a small set of
 * punctuation are what a real decode looks like. Control bytes, replacement
 * characters and dense symbol soup score zero.
 */
function scoreText (text) {
  if (!text || !isText(text)) return 0
  let score = 0
  let letters = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (/[A-Za-z]/.test(ch)) { score += 3; letters += 1 } else if (/[0-9]/.test(ch)) score += 2
    else if (/[_$.:/?#&=%@+~^-]/.test(ch)) score += 1
    else if (/[\s,;!*()[\]{}<>|\\"']/.test(ch)) score += 0.5
    else if (code > 0x7e) score -= 2
  }
  score += letters >= Math.ceil(text.length / 2) ? 2 : -2
  return score
}

/** Best key by score, requiring a small margin over the runner-up. */
function guessKey (raw, rawIndex) {
  let best = null
  let second = -Infinity
  for (const candidate of allKeys) {
    if (candidate.index === rawIndex) continue
    let plain
    try {
      plain = decodePair(raw, candidate.value)
    } catch {
      continue
    }
    const score = scoreText(plain)
    if (!best || score > best.score) {
      if (best) second = best.score
      best = { key: candidate.value, keyIndex: candidate.index, plain, score }
    } else if (score > second && score < best.score) {
      second = score
    }
  }
  if (!best || best.score < Math.max(6, best.plain.length)) return null
  return best
}

// ---------------------------------------------------------------------------
// 8. Assemble per-index records
// ---------------------------------------------------------------------------

const byRawIndex = new Map()
for (const pair of pairs) {
  if (!byRawIndex.has(pair.rawIndex)) byRawIndex.set(pair.rawIndex, [])
  byRawIndex.get(pair.rawIndex).push(pair)
}

const records = {}
let verifiedEntries = 0
let guessedEntries = 0
const unresolvedEntries = []

for (let index = 0; index < rawValues.length; index++) {
  const raw = rawValues[index]
  const candidates = (byRawIndex.get(index) ?? []).filter((p) => typeof p.plain === 'string')
  const record = { raw: raw ?? (tableNodes[index]?.type ?? null) }

  if (candidates.length) {
    candidates.sort((a, b) => b.count - a.count || b.plain.length - a.plain.length)
    const primary = candidates[0]
    verifiedEntries += 1
    Object.assign(record, {
      key: primary.key,
      keyIndex: primary.keyIndex,
      plain: primary.plain,
      text: isText(primary.plain),
      verified: true,
      confidence: 'high',
      source: 'bytecode operand',
      uses: primary.count,
      opcodes: primary.opcodes,
    })
    if (candidates.length > 1) {
      record.alternates = candidates.slice(1).map((p) => ({ key: p.key, keyIndex: p.keyIndex, plain: p.plain, uses: p.count }))
    }
  } else if (typeof raw === 'string' && raw.length > 0) {
    const guess = guessKey(raw, index)
    if (guess) {
      guessedEntries += 1
      Object.assign(record, {
        key: guess.key,
        keyIndex: guess.keyIndex,
        plain: guess.plain,
        text: isText(guess.plain),
        verified: false,
        confidence: 'low',
        source: 'heuristic key search (no verified pair)',
      })
    } else {
      unresolvedEntries.push(index)
      Object.assign(record, { key: null, plain: null, verified: false, confidence: 'none', source: 'unresolved' })
    }
  } else {
    unresolvedEntries.push(index)
    Object.assign(record, {
      key: null,
      plain: null,
      verified: false,
      confidence: 'none',
      source: raw === null ? 'non-literal table entry, could not resolve' : 'empty table entry',
    })
  }
  records[String(index)] = record
}

// ---------------------------------------------------------------------------
// 9. VALIDATIONS — the checks that decide whether any of this is trustworthy
// ---------------------------------------------------------------------------

const validations = []
function check (name, ok, detail) {
  validations.push({ name, ok: Boolean(ok), detail })
}

const knownPair = typeof rawValues[0] === 'string' && typeof rawValues[1] === 'string'
  ? decodePair(rawValues[0], rawValues[1])
  : null
check('decoder reproduces a known table pair', knownPair === 'slice',
  `m(T[0], T[1]) = ${JSON.stringify(knownPair)} (expected "slice")`)

check('bytecode walk tiles exactly', disassembly.end === bytecode.length,
  `${instructions.length} instructions cover ${disassembly.end}/${bytecode.length} bytes`)

check('every decode handler resolved to operand slots',
  decodeHandlers.every((d) => d.pairs.every(([a, b]) => Number.isInteger(a) && Number.isInteger(b))),
  `${decodeHandlers.length} handlers, ${decodeHandlers.reduce((n, d) => n + d.pairs.length, 0)} decode sites, ${excludedHandlers.length} excluded`)

check('non-literal table entries resolved',
  nonLiteral.every((n) => preamble.resolved.has(n.name)),
  nonLiteral.length
    ? nonLiteral.map((n) => `${n.name}=${JSON.stringify(preamble.resolved.get(n.name) ?? null)}`).join(', ')
    : 'the table is fully literal')

const decodedCount = pairs.filter((p) => p.plain !== null).length
const controlCount = pairs.filter((p) => typeof p.plain === 'string' && !isText(p.plain)).length
check('every verified pair decoded', decodedCount === pairs.length,
  `${decodedCount}/${pairs.length} pairs decoded; ${controlCount} decode to control characters, which are real values rather than failures`)

const nonLiteralPlain = nonLiteral
  .map((n) => {
    const candidate = pairs.find((p) => p.rawIndex === n.index && typeof p.plain === 'string')
    return candidate ? { name: n.name, plain: candidate.plain, text: isText(candidate.plain) } : null
  })
  .filter(Boolean)
check('resolved non-literal entries decode to readable text',
  nonLiteralPlain.length === nonLiteral.length && nonLiteralPlain.every((c) => c.text),
  nonLiteralPlain.map((c) => `${c.name}->${JSON.stringify(c.plain)}`).join(', ') || 'no non-literal entry is used by a decode site')

// Every table entry is either decoded by a bytecode site or is one of the XOR
// keys themselves. Anything else would mean a decode site was missed.
const keyIndices = new Set(pairs.map((p) => p.keyIndex))
check('every entry is decoded, or is one of the XOR keys',
  unresolvedEntries.every((index) => keyIndices.has(index)),
  `undecoded: ${unresolvedEntries.map((index) => `${index}=${JSON.stringify(rawValues[index])}`).join(', ') || 'none'}`)

// ---------------------------------------------------------------------------
// 10. Output
// ---------------------------------------------------------------------------

fs.mkdirSync(TMP, { recursive: true })

const json = {
  meta: {
    bundle: path.relative(ROOT, INPUT).split(path.sep).join('/'),
    bundleBytes: source.length,
    stringTable: {
      name: stringTable.name,
      start: stringTable.node.start,
      end: stringTable.node.end,
      count: rawValues.length,
      literalElements: stringTable.literals,
      nonLiteral: nonLiteral.map((n) => ({ index: n.index, name: n.name, resolved: preamble.resolved.get(n.name) ?? null })),
      preamble: {
        blocks: preamble.blocks,
        seededConstants: preamble.seeded,
        evaluated: preamble.evaluated,
        unresolved: preamble.unresolved,
      },
    },
    decoder: {
      mAt: source.indexOf('function m(n,t)'),
      base64At: source.indexOf('function R(n,t){void 0===t&&(t="+/")'),
      utf8At: source.indexOf('D.prototype.decode=function(n)'),
    },
    handlerTable: { name: handlerTable.name, handlers: handlerTable.els.length },
    decodeHandlers: decodeHandlers.length,
    decodeSites: decodeHandlers.reduce((n, d) => n + d.pairs.length, 0),
    excludedHandlers,
    instructions: instructions.length,
    bytecodeBytes: bytecode.length,
    instructionsUsingDecode: instructions.filter((i) => pairPositions.has(i.opcode)).length,
    verifiedPairs: decodedCount,
    distinctKeys: [...new Set(pairs.map((p) => p.keyIndex))]
      .sort((a, b) => a - b)
      .map((index) => ({ index, value: rawValues[index] ?? null })),
    entries: {
      total: rawValues.length,
      verified: verifiedEntries,
      heuristic: guessedEntries,
      unresolved: unresolvedEntries.length,
      unresolvedIndices: unresolvedEntries,
    },
    validations,
  },
  pairs: pairs.map((p) => ({
    rawIndex: p.rawIndex,
    keyIndex: p.keyIndex,
    raw: p.raw,
    key: p.key,
    plain: p.plain,
    text: p.text ?? null,
    uses: p.count,
    opcodes: p.opcodes,
    verified: p.plain !== null,
  })),
}
for (const [index, record] of Object.entries(records)) json[index] = record

fs.writeFileSync(path.join(TMP, 'strings.json'), JSON.stringify(json, null, 2) + '\n')

// --- strings.md ------------------------------------------------------------

const CATEGORY_ORDER = [
  ['host or URL', /^https?:\/\/|:\/\//],
  ['protocol or scheme', /^(https?|ws|wss|ftp):?$/i],
  ['HTTP header', /^(x-(bogus|gnarly|ms-[a-z-]+|dynosaur)|sec-[a-z-]+|content-[a-z-]+|accept|accept-[a-z]+|origin|referer|referrer|referrer-policy|cookie|authorization|user-agent|set-cookie)$/i],
  ['signature or crypto label', /^(sign|signature|signed|timestamp|nonce|salt|iv|key|token|hash|digest|md5|sha1|sha256|hmac|aes|rsa|encrypt|decrypt|cipher|verify|base64|hex|crc|bogus|gnarly|msToken|_signature)/i],
  ['transport or encoding', /^(gzip|deflate|br|utf-8|utf8|json|form|multipart|urlencoded|base64url|hex)$/i],
  ['error or assertion text', /error|failed|invalid|not defined|not a |cannot|unexpected|illegal|unsupported|must be/i],
  ['field or parameter name', /^[A-Za-z_$][\w$]*$/],
  ['punctuation or short token', /^[^A-Za-z0-9]{1,3}$/],
]

function categorise (text) {
  if (!isText(text)) return 'non-text decode'
  if (!text) return 'empty'
  for (const [name, pattern] of CATEGORY_ORDER) {
    if (pattern.test(text)) return name
  }
  return 'other'
}

function interestWeight (record) {
  const text = record.plain
  if (typeof text !== 'string') return -1000
  let weight = 0
  if (/^https?:\/\/|:\/\//.test(text)) weight += 100
  if (/^(x-|sec-|content-|accept|origin|referer|cookie|authorization|user-agent)/i.test(text)) weight += 90
  if (/sign|bogus|gnarly|nonce|token|hmac|md5|sha|aes|encrypt|decrypt|base64|hash|salt/i.test(text)) weight += 80
  if (/error|failed|invalid|not defined/i.test(text)) weight += 40
  if (/^[A-Za-z_$][\w$]*$/.test(text)) weight += 10
  if (!isText(text)) weight -= 100
  weight += Math.min(record.uses ?? 0, 20)
  return weight
}

const ranked = Object.entries(records)
  .map(([index, record]) => ({ index: Number(index), record, weight: interestWeight(record) }))
  .sort((a, b) => b.weight - a.weight || a.index - b.index)

const esc = (value) => (value === null || value === undefined
  ? ''
  : String(value).replace(/\|/g, '\\|').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'))

const lines = []
lines.push('# mssdk string table — decoded')
lines.push('')
lines.push('Generated by `scripts/05-strings.mjs`.')
lines.push('')
lines.push('A row marked *verified* was reached by reading the operand immediates that a')
lines.push('dispatch handler feeds into `T[...]`, then running the bundle\'s own decoder')
lines.push('chain (base64 -> UTF-8 -> repeating-key XOR). A row marked *heuristic* has no')
lines.push('bytecode reference; its key was found by scoring candidate keys and should be')
lines.push('treated as a guess, not a result.')
lines.push('')
lines.push('## Summary')
lines.push('')
lines.push(`- table entries: **${rawValues.length}** (${stringTable.literals} literal, ${nonLiteral.length} preamble-resolved)`)
lines.push(`- entries with a verified plaintext: **${verifiedEntries}**`)
lines.push(`- entries decoded heuristically: **${guessedEntries}**`)
lines.push(`- entries unresolved: **${unresolvedEntries.length}**`)
lines.push(`- verified (raw, key) pairs seen in bytecode: **${decodedCount}**`)
lines.push(`- distinct XOR keys: **${json.meta.distinctKeys.length}** (${json.meta.distinctKeys.map((k) => `T[${k.index}] = \`${esc(k.value)}\``).join(', ')})`)
lines.push(`- decode handlers: **${decodeHandlers.length}** across **${json.meta.decodeSites}** decode sites`)
lines.push(`- instructions using a decode handler: **${json.meta.instructionsUsingDecode}** of ${instructions.length}`)
lines.push('')
lines.push('## Validations')
lines.push('')
for (const v of validations) lines.push(`- ${v.ok ? 'PASS' : 'FAIL'} — ${v.name}: ${v.detail}`)
lines.push('')
lines.push('## Most interesting strings')
lines.push('')
lines.push('| idx | plaintext | class | key idx | uses | verified |')
lines.push('|----:|-----------|-------|--------:|-----:|:--------:|')
for (const { index, record } of ranked.slice(0, 150)) {
  lines.push(`| ${index} | \`${esc(record.plain)}\` | ${categorise(record.plain ?? '')} | ${record.keyIndex ?? ''} | ${record.uses ?? ''} | ${record.verified ? 'yes' : 'no'} |`)
}
lines.push('')
lines.push('## Full table')
lines.push('')
lines.push('| idx | raw | key idx | plaintext | verified |')
lines.push('|----:|-----|--------:|-----------|:--------:|')
for (let index = 0; index < rawValues.length; index++) {
  const record = records[String(index)]
  lines.push(`| ${index} | \`${esc(record.raw)}\` | ${record.keyIndex ?? ''} | \`${esc(record.plain)}\` | ${record.verified ? 'yes' : 'no'} |`)
}
lines.push('')
lines.push('## Unresolved entries')
lines.push('')
if (!unresolvedEntries.length) lines.push('None.')
for (const index of unresolvedEntries) {
  const record = records[String(index)]
  lines.push(`- **${index}**: \`${esc(record.raw)}\` — ${record.source}`)
}
lines.push('')

fs.writeFileSync(path.join(TMP, 'strings.md'), lines.join('\n'))

// --- console summary -------------------------------------------------------

console.log(`table entries:        ${rawValues.length}`)
console.log(`verified plaintexts:  ${verifiedEntries}`)
console.log(`heuristic plaintexts: ${guessedEntries}`)
console.log(`unresolved:           ${unresolvedEntries.length}`)
console.log(`verified pairs:       ${decodedCount}`)
console.log(`decode handlers:      ${decodeHandlers.length} (${json.meta.decodeSites} sites, ${excludedHandlers.length} excluded)`)
console.log(`instructions decoded: ${json.meta.instructionsUsingDecode}/${instructions.length}`)
console.log('')
for (const v of validations) console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${v.name}: ${v.detail}`)
console.log('')
console.log(`wrote ${path.join(TMP, 'strings.json')}`)
console.log(`wrote ${path.join(TMP, 'strings.md')}`)
