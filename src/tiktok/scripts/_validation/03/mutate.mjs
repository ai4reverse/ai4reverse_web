#!/usr/bin/env node
/**
 * Oracle-mutation study of the V2 equivalence gate (29-verify.mjs).
 *
 * The gate is the object under test. It runs the *original* and the
 * *decompiled* program under a frozen wrapper (seed 0x5eed, init({aid:1233}),
 * one frontierSign({url:'https://www.tiktok.com/api/'})) and declares PASS iff
 * the two `value` strings are byte-identical. `ok` is computed but unused.
 *
 * We ask two questions of every single-point mutation:
 *   1. gate_detected      — does the frozen call's observable output change?
 *   2. behavior_changed   — does the artifact's output change on ANY input in
 *                           the extended matrix (seed/aid/url/repeat-call)?
 * A mutation with gate_detected=false but behavior_changed=true is a blind
 * spot: real behaviour changed and the gate's one fixed input did not see it.
 *
 * Artifacts are read from immutable snapshots in work/ (the live output/ tree
 * is being rebuilt by other agents; see REPORT.md for hashes).
 *
 *   node src/tiktok/scripts/_validation/03/mutate.mjs [matrix|mutants|all]
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import {
  REPO, GATE, GATE_WRAPPER, MATRIX_WRAPPER, WORK, OUT_DIR,
  runSide, gateMatched, observable,
} from './lib.mjs'

const traverse = _traverse.default ?? _traverse

const SNAP_ORIG = path.join(WORK, 'snapshot-original.js')
const SNAP_DEC = path.join(WORK, 'snapshot-decompiled.min.js')
const MUT_DIR = path.join(WORK, 'mutants')

const U1 = 'https://www.tiktok.com/api/'
const U2 = 'https://www.tiktok.com/api/search/general/full/?keyword=abc'

/** One dimension at a time around the frozen point; `times:2` exercises the internal call counter. */
const MATRIX = [
  { id: 'base', seed: '0x5eed', aid: 1233, url: U1, times: 1 },
  { id: 'seed-0x1', seed: '0x1', aid: 1233, url: U1, times: 1 },
  { id: 'aid-424242', seed: '0x5eed', aid: 424242, url: U1, times: 1 },
  { id: 'url-alt', seed: '0x5eed', aid: 1233, url: U2, times: 1 },
  { id: 'times-2', seed: '0x5eed', aid: 1233, url: U1, times: 2 },
]

// ---------------------------------------------------------------------------
// Structure locators
// ---------------------------------------------------------------------------

function findTables(source) {
  const ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true })
  let handlers = null
  let strings = null
  const consider = (name, arr) => {
    const els = arr.elements.filter(Boolean)
    const fnLike = els.filter((e) => e.type === 'FunctionExpression').length
    const strLike = els.filter((e) => e.type === 'StringLiteral').length
    if (els.length >= 16 && fnLike === els.length) {
      if (!handlers || els.length > handlers.els.length) handlers = { name, els, start: arr.start, end: arr.end }
    }
    if (els.length >= 100 && strLike >= els.length - 8) {
      if (!strings || els.length > strings.els.length) strings = { name, els, start: arr.start, end: arr.end }
    }
  }
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.id?.type === 'Identifier' && p.node.init?.type === 'ArrayExpression') consider(p.node.id.name, p.node.init)
    },
    AssignmentExpression(p) {
      if (p.node.left?.type === 'Identifier' && p.node.right?.type === 'ArrayExpression') consider(p.node.left.name, p.node.right)
    },
  })
  return { handlers, strings }
}

function findFunctions(source, names) {
  const ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true })
  const found = {}
  traverse(ast, {
    FunctionDeclaration(p) {
      const n = p.node.id?.name
      if (n && names.includes(n)) found[n] = { start: p.node.start, end: p.node.end }
    },
  })
  return found
}

const BYTECODE_RE = /(\w+)\.dwAbA\(R\("([A-Za-z0-9+/=]{1000,})"\)\)/

function readBytecode(source) {
  const m = BYTECODE_RE.exec(source)
  if (!m) throw new Error('bytecode blob not found')
  const b64 = m[2]
  const b64Start = m.index + m[0].indexOf(b64)
  const infl = zlib.inflateRawSync(Buffer.from(b64, 'base64'))
  return { b64Start, b64Len: b64.length, infl }
}

function writeBytecode(source, bc, inflated) {
  const nb = zlib.deflateRawSync(Buffer.from(inflated)).toString('base64')
  return source.slice(0, bc.b64Start) + nb + source.slice(bc.b64Start + bc.b64Len)
}

function replaceAt(source, start, end, text) {
  return source.slice(0, start) + text + source.slice(end)
}

// ---------------------------------------------------------------------------
// Single-point mutations. Each returns { source, detail } and edits exactly one site.
// ---------------------------------------------------------------------------

function bytecodeFlip(source, instructionAt, operandIndex, widths, disasm) {
  const ins = disasm.find((i) => i.at === instructionAt)
  if (!ins) throw new Error(`instruction not found at ${instructionAt}`)
  let pos = ins.at + 2
  for (let k = 0; k < operandIndex; k++) pos += widths[ins.opcode][k].width
  const width = widths[ins.opcode][operandIndex].width
  const bc = readBytecode(source)
  const bytes = Buffer.from(bc.infl)
  const target = pos + width - 1 // low byte (big-endian operand)
  const before = bytes[target]
  bytes[target] = before ^ 0x01
  return {
    source: writeBytecode(source, bc, bytes),
    detail: `bytecode[${target}] 0x${before.toString(16)}->0x${bytes[target].toString(16)} at instr ${instructionAt} (opcode ${ins.opcode}, operand ${operandIndex})`,
  }
}

function recompressOnly(source) {
  const bc = readBytecode(source)
  return { source: writeBytecode(source, bc, bc.infl), detail: 'deflate/rebase64 round-trip, zero byte changes (control)' }
}

function swapHandlers(source, i, j) {
  const { handlers } = findTables(source)
  if (!handlers) throw new Error('handler table not found')
  const a = handlers.els[i]
  const b = handlers.els[j]
  if (!a || !b) throw new Error(`handler ${i}/${j} missing`)
  const [lo, hi] = a.start < b.start ? [a, b] : [b, a]
  const textLo = source.slice(lo.start, lo.end)
  const textHi = source.slice(hi.start, hi.end)
  const next = source.slice(0, lo.start) + textHi + source.slice(lo.end, hi.start) + textLo + source.slice(hi.end)
  return { source: next, detail: `C[${i}] <-> C[${j}] (handler bodies swapped)` }
}

function changeString(source, index, charIndex, replacement) {
  const { strings } = findTables(source)
  if (!strings) throw new Error('string table not found')
  const el = strings.els[index]
  if (!el || el.type !== 'StringLiteral') throw new Error(`T[${index}] is not a string literal`)
  const text = source.slice(el.start, el.end)
  // text includes quotes; charIndex is relative to the inner value.
  const inner = text.slice(1, -1)
  if (charIndex < 0 || charIndex >= inner.length) throw new Error('charIndex out of range')
  const mutatedInner = inner.slice(0, charIndex) + replacement + inner.slice(charIndex + 1)
  const next = replaceAt(source, el.start, el.end, JSON.stringify(mutatedInner))
  return { source: next, detail: `T[${index}] "${inner}" -> "${mutatedInner}" (${el.start})` }
}

function changeLiteral(source, needle, replacement, label) {
  const at = source.indexOf(needle)
  if (at < 0) throw new Error(`literal not found: ${needle}`)
  if (source.indexOf(needle, at + 1) >= 0) throw new Error(`literal not unique: ${needle}`)
  return { source: replaceAt(source, at, at + needle.length, replacement), detail: `${label}: "${needle}" -> "${replacement}" at ${at}` }
}

function changeLiteralIn(source, needle, replacement, label, occurrence = 0) {
  let at = -1
  for (let k = 0; k <= occurrence; k++) {
    at = source.indexOf(needle, at + 1)
    if (at < 0) throw new Error(`literal occurrence ${occurrence} not found: ${needle}`)
  }
  return { source: replaceAt(source, at, at + needle.length, replacement), detail: `${label}: "${needle}" -> "${replacement}" at ${at}` }
}

function swapFunctions(source, nameA, nameB) {
  const spans = findFunctions(source, [nameA, nameB])
  const a = spans[nameA]
  const b = spans[nameB]
  if (!a || !b) throw new Error(`function ${nameA}/${nameB} not found`)
  const [lo, hi] = a.start < b.start ? [a, b] : [b, a]
  const textLo = source.slice(lo.start, lo.end)
  const textHi = source.slice(hi.start, hi.end)
  const next = source.slice(0, lo.start) + textHi + source.slice(lo.end, hi.start) + textLo + source.slice(hi.end)
  return { source: next, detail: `${nameA} <-> ${nameB} (function bodies swapped)` }
}

// ---------------------------------------------------------------------------
// Mutant catalogue
// ---------------------------------------------------------------------------

const DEC_FN = 'fn_241' // f3_X (frontierSign) -> fn_241 in the snapshot

function decDeleteStatement(source) {
  const needle = 'f241_r7=f241_r8[f241_r9];'
  const at = source.indexOf(needle)
  if (at < 0) throw new Error('statement not found')
  return { source: replaceAt(source, at, at + needle.length, ''), detail: `deleted lifted statement "${needle}" at ${at}` }
}

function deleteStatementIn(source, fnName, needle) {
  const sp = findFunctions(source, [fnName])[fnName]
  if (!sp) throw new Error(`function ${fnName} not found`)
  const seg = source.slice(sp.start, sp.end)
  const at = seg.indexOf(needle)
  if (at < 0) throw new Error(`statement not in ${fnName}: ${needle}`)
  return { source: replaceAt(source, sp.start + at, sp.start + at + needle.length, ''), detail: `deleted statement "${needle}" in ${fnName} at ${sp.start + at}` }
}

function dropFinalReturnIn(source, fnName) {
  const sp = findFunctions(source, [fnName])[fnName]
  if (!sp) throw new Error(`function ${fnName} not found`)
  const prefix = fnName.replace(/^fn_/, 'f')
  const literal = `return ${prefix}_rRet`
  const seg = source.slice(sp.start, sp.end)
  const at = seg.lastIndexOf(literal)
  if (at < 0) throw new Error(`${literal} not in ${fnName}`)
  return { source: replaceAt(source, sp.start + at, sp.start + at + literal.length, literal.replace('return ', '')), detail: `dropped "${literal}" in ${fnName} at ${sp.start + at}` }
}

function decReturnToAssignment(source) {
  const literal = 'return f241_rRet'
  const at = source.lastIndexOf(literal)
  if (at < 0) throw new Error('return not found')
  return { source: replaceAt(source, at, at + literal.length, 'f241_rRet'), detail: `"return f241_rRet" -> "f241_rRet" (return dropped) at ${at}` }
}

function buildMutants(origSource, decSource) {
  const disasm = JSON.parse(fs.readFileSync(path.join(REPO, 'src/tiktok/tmp/disasm.json'), 'utf8')).instructions
  const widthRows = JSON.parse(fs.readFileSync(path.join(REPO, 'src/tiktok/tmp/widths.json'), 'utf8'))
  const widths = Object.fromEntries(widthRows.map((r) => [r.opcode, r.operands]))

  const defs = []
  const add = (id, artifact, kind, apply, note) => defs.push({ id, artifact, kind, apply, note })

  // --- original (reference) side -------------------------------------------
  add('O-control-recompress', 'original', 'control',
    (s) => recompressOnly(s),
    'Control: identical bytecode, re-deflated. A change here means the harness, not the mutation, moved the output.')

  // Operand byte flips at decode sites: slot 5 is the XOR-key index (1/3/5).
  for (const [at, op] of [[111, 304], [431, 304], [579, 304], [1607, 163], [1660, 163], [1774, 163]]) {
    add(`O1-operand-${at}`, 'original', 'bytecode-operand-flip',
      (s) => bytecodeFlip(s, at, 5, widths, disasm),
      `Flip the low byte of the immediate key index at instruction ${at} (opcode ${op}); the site decodes a runtime string.`)
  }

  add('O2-handler-swap-304-316', 'original', 'handler-swap',
    (s) => swapHandlers(s, 304, 316),
    'Swap two dispatch handlers that both execute on the gate call (coverage counts 733 and 725).')

  add('O3a-string-key-byte', 'original', 'string-table-key-byte',
    (s) => changeString(s, 1, 0, 'k'),
    'T[1] is the XOR key "jRJLqZAv"; one byte change corrupts every string decoded with key 1, including X-Bogus.')
  add('O3b-string-cipher-byte', 'original', 'string-table-cipher-byte',
    (s) => changeString(s, 686, 0, 'A'),
    'T[686] is the ciphertext for "X-Bogus"; one byte change makes the emitted header name garbage.')

  add('O5-sha256-iv', 'original', 'sha256-iv-bit',
    (s) => changeLiteral(s, '1779033703', '1779033704', 'SHA-256 IV[0]'),
    'Change SHA-256 IV[0] by one (0x6a09e667 -> 0x6a09e668) in the only occurrence.')
  add('O5b-sha256-k', 'original', 'sha256-round-constant',
    (s) => changeLiteral(s, '1116352408', '1116352409', 'SHA-256 K[0]'),
    'Change SHA-256 round constant K[0] (0x428a2f98 -> 0x428a2f99) in the only occurrence.')

  add('O8-append-noop', 'original', 'control',
    (s) => ({ source: `${s}\n;`, detail: 'append a no-op statement (control)' }),
    'Control: appending an inert statement must not change value or ok.')

  add('O7-deferred-throw', 'original', 'ok-ignored',
    (s) => ({
      source: `${s}\nsetTimeout(function(){throw new Error("deferred-mutant")},0);`,
      detail: 'append a timer that throws after __run returns; the sig value is untouched but the sandbox ok flag should become false',
    }),
    'The gate compares only `value` (29-verify.mjs:104); it reads `ok` (lines 90,95) and never uses it. A program that returns the right bytes and then fails asynchronously passes.')

  // --- decompiled side ------------------------------------------------------
  add('D5-sha256-iv', 'decompiled', 'sha256-iv-bit',
    (s) => changeLiteral(s, '1779033703', '1779033704', 'SHA-256 IV[0]'),
    'Same SHA-256 IV change on the decompiled side.')

  // The real observable path is f3_X -> fn_241 (shim) -> fn_242 (object
  // assembly) -> mod1096.v -> fn_239 (signature body). fn_239 falls through to
  // the sentinel, which is why the snapshot prints X-Bogus:25. Mutants below
  // target that real path; the fn_241 shim mutants above are controls showing
  // that its internals are dead for this call.
  add('D1b-fn239-operand', 'decompiled', 'operand-constant',
    (s) => changeLiteral(s, 'f239_r35=0', 'f239_r35=1', 'lifted numeric operand in fn_239'),
    'Change one lifted numeric constant in the signature body fn_239.')
  add('D4b-fn239-delete-statement', 'decompiled', 'delete-lifted-statement',
    (s) => deleteStatementIn(s, 'fn_239', 'f239_r7=f239_r9!==f239_r15;'),
    'Delete one lifted comparison statement in fn_239.')
  add('D6b-fn239-return', 'decompiled', 'return-to-assignment',
    (s) => dropFinalReturnIn(s, 'fn_239'),
    'Drop the final return of the signature body fn_239.')
  add('D3b-fn242-xbogus-literal', 'decompiled', 'string-literal-byte',
    (s) => changeLiteral(s, 'f242_r13="X-Bogus"', 'f242_r13="X-BogusX"', 'X-Bogus header name'),
    'Change the header name the lifted assembler writes; this is the exact string the original gets from T[686].')
  add('D2b-fn239-240-swap', 'decompiled', 'function-body-swap',
    (s) => swapFunctions(s, 'fn_239', 'fn_240'),
    'Swap the signature body fn_239 with its helper fn_240 (handler-swap analogue).')

  add('D6-return-to-assignment', 'decompiled', 'return-to-assignment',
    (s) => decReturnToAssignment(s),
    'Drop the return of the lifted frontierSign body (fn_241): "return f241_rRet" becomes a bare expression.')

  add('D4-delete-lifted-statement', 'decompiled', 'delete-lifted-statement',
    (s) => decDeleteStatement(s),
    'Delete one lifted statement in fn_241 (the argument lookup that feeds the branch).')

  add('D3-string-literal', 'decompiled', 'string-literal-byte',
    (s) => changeLiteral(s, 'f241_r12="X-MS-STUB"', 'f241_r12="X-MS-STUBX"', 'lifted header literal'),
    'Change the lifted plaintext literal that the original obtains from the encoded string table.')

  add('D2-function-swap', 'decompiled', 'function-body-swap',
    (s) => swapFunctions(s, 'fn_241', 'fn_242'),
    'Swap the two lifted functions on the frontierSign path (handler-swap analogue).')

  add('D1-numeric-literal', 'decompiled', 'operand-constant',
    (s) => changeLiteralIn(s, 'f241_r15=0', 'f241_r15=1', 'lifted numeric operand'),
    'Change one lifted numeric operand in fn_241.')

  return defs.map((d) => {
    let result
    try {
      result = d.apply(d.artifact === 'original' ? origSource : decSource)
    } catch (error) {
      result = { error: String(error && error.message) }
    }
    return { ...d, why: WHY[d.id] ?? null, ...result }
  })
}

/**
 * Mechanism for each mutant that survives every matrix point. These are the
 * "why the gate cannot see it" statements the report requires; each is
 * consistent with the measured `changed=[]` and with the source structure.
 */
const WHY = {
  'O-control-recompress': 'Control: the decoded bytecode is unchanged; deflate/base64 re-encoding alone must not move the output.',
  'O1-operand-1607': 'Opcode 163 executes elsewhere, but this particular instruction (PC 1607) is not on the init+frontierSign path; flipping its key index never runs.',
  'O1-operand-1660': 'Opcode 163 executes elsewhere, but this particular instruction (PC 1660) is not on the init+frontierSign path; flipping its key index never runs.',
  'O5-sha256-iv': 'SHA-256 IV[0] is one element of a module-scope crypto constant table that also holds MD5 constants; no code on the frontierSign path reads it, so the digest is never computed.',
  'O5b-sha256-k': 'SHA-256 K[0] in the same unused constant table; mutating it is invisible for the same reason as the IV — the SHA-256 routine is not called.',
  'O8-append-noop': 'Control: an appended no-op statement is inert.',
  'O7-deferred-throw': 'The timer is left pending (settle reports pendingTimers=2, jobs=0) so the throw never runs; and `ok` mirrors only the entry invocation, which the wrapper catches — the unused-ok defect stays latent rather than observable.',
  'D5-sha256-iv': 'Same unused SHA-256 constant table as the original; the decompiled frontierSign never reaches the digest.',
  'D1b-fn239-operand': 'The constant f239_r35 feeds a branch that never reaches a guarded return; fn_239 still falls through to the sentinel 25, so the output is unchanged.',
  'D4b-fn239-delete-statement': 'Deleting the comparison leaves the same state recomputed on the taken path; execution still falls through to the sentinel.',
  'D2b-fn239-240-swap': 'fn_240 is only reached via f239_r50 and does not feed the returned value; the fall-through sentinel survives the swap.',
  'D6-return-to-assignment': 'fn_241 returns early through if(f241_rRet!==25){return f241_rRet} once fn_242 yields the object; the dropped final return is dead code.',
  'D4-delete-lifted-statement': 'The deleted assignment is in the if(f241_r7) branch; the call argument has no X-MS-STUB key, so the else branch is taken and the statement never executes.',
  'D3-string-literal': 'Changing the lookup key from X-MS-STUB to X-MS-STUBX still yields undefined from the argument object, so control takes the same else path.',
  'D2-function-swap': 'Whichever body fn_241 carries still ends by returning the object built with the sentinel X-Bogus value, so the observable is identical.',
  'D1-numeric-literal': 'f241_r15 is passed into fn_242 but does not influence the value it returns in the current artifact.',
}

// `changeLiteral` needs the source it is editing; the wrapper above passes the
// live source through so the unique-literal check runs on the right artifact.
function source0(s) { return s }

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const INTERRUPTED = /interrupted|timed out|timeout|host-stack/i

function safeRun(file, wrapper, seed, args, tag) {
  let last = null
  // The sandbox's limit is host wall-clock, so a loaded host can report
  // `interrupted` for a program that normally finishes in <1 s. Retry those;
  // a genuinely looping mutant will exhaust all attempts and stay interrupted.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = runSide(file, wrapper, { outFile: path.join(WORK, 'runs', `${tag}.js`), seed, args, timeout: 60000 })
      last = { ok: r.ok, value: r.value, exit: r.exit, stderr: r.stderr, attempts: attempt }
    } catch (error) {
      last = { ok: false, value: `HARNESS_ERROR: ${error && error.message}`, exit: -1, stderr: '', attempts: attempt }
    }
    if (last.value !== null && !INTERRUPTED.test(String(last.value))) return last
  }
  return last
}

function observeArtifact(label, file) {
  const gate = safeRun(file, GATE_WRAPPER, GATE.seed, undefined, `${label}-gate`)
  const matrix = {}
  for (const cfg of MATRIX) {
    matrix[cfg.id] = safeRun(file, MATRIX_WRAPPER, cfg.seed, { aid: cfg.aid, url: cfg.url, times: cfg.times }, `${label}-m-${cfg.id}`)
  }
  return { gate, matrix }
}

function writeArtifact(id, source) {
  fs.mkdirSync(MUT_DIR, { recursive: true })
  const file = path.join(MUT_DIR, `${id}.js`)
  fs.writeFileSync(file, source)
  return file
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] ?? 'all'
fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(path.join(WORK, 'runs'), { recursive: true })

const origSource = fs.readFileSync(SNAP_ORIG, 'utf8')
const decSource = fs.readFileSync(SNAP_DEC, 'utf8')

let original = null
let decompiled = null
if (command !== 'dry') {
  console.error('baseline: original')
  original = observeArtifact('base-original', SNAP_ORIG)
  console.error('baseline: decompiled')
  decompiled = observeArtifact('base-decompiled', SNAP_DEC)
}

const baselines = { original, decompiled }
const report = {
  gate: GATE,
  matrixConfigs: MATRIX,
  snapshots: {
    original: { file: path.relative(REPO, SNAP_ORIG), sha256: crypto.createHash('sha256').update(origSource).digest('hex') },
    decompiled: { file: path.relative(REPO, SNAP_DEC), sha256: crypto.createHash('sha256').update(decSource).digest('hex') },
  },
  baselines: {
    original: original && { gate: original.gate, matrix: original.matrix },
    decompiled: decompiled && { gate: decompiled.gate, matrix: decompiled.matrix },
    literalGate: original && decompiled && {
      matched: gateMatched(original.gate, decompiled.gate),
      original: observable(original.gate.value),
      decompiled: observable(decompiled.gate.value),
    },
  },
  mutants: [],
}

if (command === 'dry') {
  const { writeFileSync } = fs
  const mutants = buildMutants(origSource, decSource)
  writeFileSync(path.join(WORK, 'dry-mutants.json'), JSON.stringify(mutants.map((m) => ({
    id: m.id, artifact: m.artifact, kind: m.kind, error: m.error ?? null, detail: m.detail,
    bytes: m.source ? m.source.length : null,
    syntaxOk: m.source ? (() => {
      try {
        parse(m.source, { sourceType: 'script', allowReturnOutsideFunction: true })
        return true
      } catch (e) { return String(e.message) }
    })() : null,
  })), null, 2))
  console.log('dry: built', mutants.length, 'mutants ->', path.join(WORK, 'dry-mutants.json'))
  process.exit(0)
}

if (command === 'matrix' || command === 'all') {
  const { writeFileSync } = fs
  writeFileSync(path.join(OUT_DIR, 'matrix.json'), JSON.stringify({
    gate: GATE,
    configs: MATRIX,
    baselines: report.baselines,
    predicate: {
      source: 'src/tiktok/scripts/29-verify.mjs:104 (matched = original.value !== null && original.value === decompiled.value)',
      ignoresOk: true,
      demonstration: {
        reference: { value: 'same-bytes', ok: true },
        candidate: { value: 'same-bytes', ok: false },
        matched: gateMatched({ value: 'same-bytes', ok: true }, { value: 'same-bytes', ok: false }),
      },
    },
  }, null, 2))
  console.error('matrix.json written')
}

if (command === 'mutants' || command === 'all') {
  const mutants = buildMutants(origSource, decSource)
  for (const m of mutants) {
    if (m.error) {
      report.mutants.push({ id: m.id, artifact: m.artifact, kind: m.kind, error: m.error, note: m.note })
      console.error(`SKIP ${m.id}: ${m.error}`)
      continue
    }
    const file = writeArtifact(m.id, m.source)
    const run = observeArtifact(`mut-${m.id}`, file)
    const base = baselines[m.artifact]
    const selfGateDelta = run.gate.value !== base.gate.value
    const okDelta = run.gate.ok !== base.gate.ok
    const valueChangedAny =
      selfGateDelta ||
      MATRIX.some((cfg) => run.matrix[cfg.id].value !== base.matrix[cfg.id].value)
    const changedConfigs = MATRIX
      .filter((cfg) => run.matrix[cfg.id].value !== base.matrix[cfg.id].value || run.matrix[cfg.id].ok !== base.matrix[cfg.id].ok)
      .map((c) => c.id)
    const literalGateFail = m.artifact === 'decompiled'
      ? !gateMatched(original.gate, run.gate)
      : !gateMatched(run.gate, decompiled.gate)
    const row = {
      id: m.id,
      artifact: m.artifact,
      kind: m.kind,
      gate_detected: selfGateDelta,
      behavior_changed: changedConfigs.length > 0,
      ok_changed: okDelta,
      value_changed: valueChangedAny,
      changed_configs: changedConfigs,
      self_gate_delta: selfGateDelta,
      literal_gate_fail: literalGateFail,
      detail: m.detail,
      note: m.note,
      why: m.why ?? null,
      gate_value: run.gate.value,
      matrix_values: Object.fromEntries(MATRIX.map((c) => [c.id, run.matrix[c.id].value])),
    }
    report.mutants.push(row)
    console.error(`${selfGateDelta ? 'DETECTED' : 'SURVIVED'} ${m.id} changed=[${changedConfigs.join(',')}]`)
  }

  const rows = report.mutants.filter((m) => !m.error)
  const detected = rows.filter((m) => m.gate_detected).length
  const blind = rows.filter((m) => !m.gate_detected && m.behavior_changed)
  report.summary = {
    mutants: rows.length,
    detected,
    survived: rows.length - detected,
    killRate: rows.length ? Number((detected / rows.length).toFixed(4)) : null,
    blindSpots: blind.map((m) => m.id),
  }

  const csv = [
    'mutant_id,artifact,kind,gate_detected,behavior_changed,mechanism',
    ...rows.map((m) => `${m.id},${m.artifact},${m.kind},${m.gate_detected},${m.behavior_changed},"${mechanism(m)}"`),
  ].join('\n') + '\n'
  fs.writeFileSync(path.join(OUT_DIR, 'kill-matrix.csv'), csv)
  fs.writeFileSync(path.join(OUT_DIR, 'mutants.json'), JSON.stringify(report, null, 2))
  console.error(`wrote kill-matrix.csv (${report.summary.killRate} kill rate, ${blind.length} blind spots)`)
}

function mechanism(m) {
  if (m.gate_detected) {
    return m.behavior_changed
      ? 'frozen call observes the change; the same change also lands on other matrix points'
      : 'frozen call observes the change even though it is invisible at the other matrix points (single point is decisive here)'
  }
  if (m.behavior_changed) {
    const why = m.ok_changed && !m.value_changed
      ? 'the sandbox ok flag changed while the compared value stayed identical (29-verify.mjs:104 compares value only and discards ok)'
      : `change is invisible at the frozen input but visible at ${m.changed_configs.join('/')}`
    return `blind spot: ${why}`
  }
  return m.why ?? 'equivalent at every matrix point tested: the edit does not reach the observable output'
}

console.log(JSON.stringify({
  summary: report.summary,
  literalGate: report.baselines.literalGate,
}, null, 2))
