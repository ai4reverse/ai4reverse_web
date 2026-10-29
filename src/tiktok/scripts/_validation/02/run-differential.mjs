#!/usr/bin/env node
/**
 * Per-function translation validation: bytecode semantics vs lifted JavaScript.
 *
 * For every recovered function the two sides are driven from one environment:
 *
 *   bytecode  the bundle's own handler table `C` over a frame, metered;
 *   lifted    `fn_<id>` from the pinned output/lifted.js snapshot.
 *
 * Environment (module cells, captured ancestor registers, arguments) is seeded
 * identically on both sides, so a difference can only come from the translation.
 *
 * Inputs are bounded concrete cases — small integers, short strings, null,
 * objects, arrays, functions — not a proof over all inputs. The status column
 * says exactly what was established; see REPORT.md.
 *
 *   node src/tiktok/scripts/_validation/02/run-differential.mjs [--only 44,340] [--cases 10] [--verbose]
 *
 * Writes validation/02-semantics/{tri-state.csv,results.json,counterexamples/}.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  loadVm,
  loadLifted,
  makeFrame,
  runFrame,
  meter,
  callLifted,
  BudgetError,
  describe,
  valueEqual,
  normalizeErrorMessage,
  errorShape,
  resetDeterminism,
  MODULE_BASE,
} from '../../../../tiktok/validation/02-semantics/interp.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const SRC = path.join(REPO, 'src/tiktok')
const TMP = path.join(SRC, 'tmp')
const VAL = path.join(SRC, 'validation/02-semantics')
const OUT_CSV = path.join(VAL, 'tri-state.csv')
const OUT_JSON = path.join(VAL, 'results.json')
const CE_DIR = path.join(VAL, 'counterexamples')

const ARGS = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name)
  return i >= 0 ? ARGS[i + 1] : fallback
}
const VERBOSE = ARGS.includes('--verbose')
const DUMP = ARGS.includes('--dump')
const ONLY = opt('--only', null)
const CASE_COUNT = Number(opt('--cases', '10'))
const STEP_BUDGET = Number(opt('--steps', '50000'))
const WALL_MS = Number(opt('--wall', '2500'))

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

/* ------------------------------------------------------------------ */
/* static metadata                                                     */
/* ------------------------------------------------------------------ */

const minSource = fs.readFileSync(path.join(SRC, 'resources/mssdk.min.js'), 'utf8')
const disasm = readJson(path.join(TMP, 'disasm.json'))
const cfg = readJson(path.join(TMP, 'cfg.json'))
const fnDoc = readJson(path.join(TMP, 'functions.json'))
const opcodeTable = readJson(path.join(TMP, 'opcode-table.json'))
const inventory = readJson(path.join(VAL, 'lifted-inventory.json'))

const functions = fnDoc.functions
const instructions = disasm.instructions
const cfgByAt = new Map(cfg.instructions.map((i) => [i.at, i]))
const opMeta = opcodeTable.opcodes
const inventoryById = new Map(inventory.functions.map((r) => [r.id, r]))
const liftedSource = fs.readFileSync(path.join(VAL, 'pinned/lifted.snapshot.js'), 'utf8')

const starts = new Set(functions.map((f) => f.start))
const fnById = new Map(functions.map((f) => [f.id, f]))

/** Register split of the callee frame, from its closure construction site. */
function buildSplitMap() {
  // op19 builds two closures in one instruction: [fnADst, entryB, entryA,
  // boundB, boundA, fnBDst]. Both (entry,boundary) pairs are needed.
  const ROLES = [
    [19, 2, 4],
    [19, 1, 3],
    [31, 2, 0],
    [124, 1, 2],
    [136, 3, 0],
    [138, 4, 3],
    [159, 1, 2],
  ]
  const map = new Map()
  for (const ins of instructions) {
    for (const [opcode, entryAt, boundaryAt] of ROLES) {
      if (ins.opcode !== opcode) continue
      const entry = ins.operands[entryAt]
      if (starts.has(entry) && ins.operands[boundaryAt] !== undefined) {
        map.set(entry, ins.operands[boundaryAt])
      }
    }
  }
  const re = /Y\((\d+),[^)]*?,0,(\d+)\)/g
  let m
  while ((m = re.exec(minSource)) !== null) {
    const entry = Number(m[1])
    if (starts.has(entry)) map.set(entry, Number(m[2]))
  }
  return map
}
const splitByEntry = buildSplitMap()

function fnIdAt(offset) {
  for (const f of functions) if (f.start <= offset && offset < f.end) return f.id
  return null
}

/** Block leaders, mirroring the emitter's heuristic. */
function leadersOf(fn) {
  const leaders = new Set([fn.start])
  const inRange = instructions.filter((i) => fn.start <= i.at && i.at < fn.end)
  const own = new Set(inRange.map((i) => i.at))
  for (const ins of inRange) {
    const c = cfgByAt.get(ins.at)
    for (const s of c?.successors ?? []) if (s >= fn.start && s < fn.end) leaders.add(s)
    if (cfg.controlHandlers.includes(ins.opcode)) {
      const next = ins.next
      if (own.has(next)) leaders.add(next)
    }
  }
  return leaders
}

/** True when this instruction writes register 4 (the return slot) by operand. */
function writesReg4(ins) {
  const meta = opMeta[ins.opcode]
  if (!meta) return false
  const writes = new Set(meta.writes)
  return meta.operands.some((o, k) => o.kind === 'u16' && writes.has(o.name) && ins.operands[k] === 4)
}

const coverage = (() => {
  const op218 = new Set()
  const back = new Set()
  const reg4 = new Set()
  for (const ins of instructions) {
    if (ins.opcode === 218) op218.add(fnIdAt(ins.at))
    for (const s of cfgByAt.get(ins.at)?.successors ?? []) if (s <= ins.at) back.add(fnIdAt(ins.at))
  }
  for (const fn of functions) {
    const leaders = leadersOf(fn)
    const own = new Set(instructions.filter((i) => fn.start <= i.at && i.at < fn.end).map((i) => i.at))
    for (const ins of instructions) {
      if (ins.at < fn.start || ins.at >= fn.end) continue
      if (!writesReg4(ins)) continue
      const nextIsLeader = !own.has(ins.next) || leaders.has(ins.next)
      const isLast = !own.has(ins.next)
      if (nextIsLeader || isLast) reg4.add(fn.id)
    }
  }
  return { op218, back, reg4 }
})()

const REQUIRED = new Set([44, 340, ...coverage.op218, ...coverage.back, ...coverage.reg4].filter((x) => x !== null))

/* ------------------------------------------------------------------ */
/* case generation                                                     */
/* ------------------------------------------------------------------ */

const BASE_VALUES = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['0', () => 0],
  ['1', () => 1],
  ['-1', () => -1],
  ['NaN', () => NaN],
  ['""', () => ''],
  ['"ab"', () => 'ab'],
  ['true', () => true],
  ['false', () => false],
  ['{}', () => ({})],
  ['{a:1,b:"x"}', () => ({ a: 1, b: 'x' })],
  ['[]', () => []],
  ['[1,2,3]', () => [1, 2, 3]],
  ['fn', () => function stub() { return 7 }],
  ['2', () => 2],
  ['"0123"', () => '0123'],
]

const MODULE_PROFILES = [
  ['undef', () => undefined],
  ['zero', () => 0],
  ['obj', () => ({})],
  ['fn', () => function moduleStub() { return 1 }],
  ['str', () => 'k'],
]

/** Deterministic argument tuples: rotate the value library across positions. */
function casesFor(argIndices, count, withDynamic) {
  const positions = argIndices.length ? argIndices : []
  if (withDynamic) {
    for (let extra = 0; extra < 2; extra++) {
      if (!positions.includes(positions.length + extra)) positions.push(Math.max(...positions, -1) + 1 + extra)
    }
  }
  const cases = []
  const target = Math.max(count, positions.length ? 1 : 1)
  for (let t = 0; t < target; t++) {
    const args = []
    for (let j = 0; j < positions.length; j++) {
      const idx = (t * 5 + j * 3) % BASE_VALUES.length
      args.push({ index: positions[j], label: BASE_VALUES[idx][0], make: BASE_VALUES[idx][1] })
    }
    cases.push(args)
  }
  // A few targeted tuples that exercise null/undefined guards first.
  for (const label of ['null', 'undefined', '{}', '[1,2,3]']) {
    const v = BASE_VALUES.find(([l]) => l === label)
    cases.push(positions.map((index) => ({ index, label: v[0], make: v[1] })))
  }
  // Mixed tuples: a guard on one argument and a live value on another. These
  // caught fn_44's `_objectSpread({}, null)` path, which uniform tuples miss.
  const MIXED = [
    ['{}', 'null'],
    ['null', '{}'],
    ['[]', 'null'],
    ['undefined', '{}'],
    ['{}', '[]'],
  ]
  for (const labels of MIXED) {
    cases.push(
      positions.map((index, j) => {
        const [label] = [labels[j % labels.length]]
        const v = BASE_VALUES.find(([l]) => l === label)
        return { index, label: v[0], make: v[1] }
      }),
    )
  }
  return cases
}

/* ------------------------------------------------------------------ */
/* environment construction                                            */
/* ------------------------------------------------------------------ */

function cloneValue(v) {
  if (v === null || typeof v !== 'object') return v
  if (typeof v === 'function') return v
  return structuredClone(v)
}

function argIndicesOf(id) {
  const inv = inventoryById.get(id)
  if (!inv) return { indices: [], dynamic: false }
  const body = liftedSource.slice(inv.start, inv.end)
  const indices = new Set()
  let dynamic = false
  const re = /rArgs\[([^\]]+)\]/g
  let m
  while ((m = re.exec(body)) !== null) {
    const expr = m[1].trim()
    if (/^\d+$/.test(expr)) indices.add(Number(expr))
    else dynamic = true
  }
  return { indices: [...indices].sort((a, b) => a - b), dynamic }
}

const HOST_GLOBALS = new Set([
  'window', 'document', 'navigator', 'localStorage', 'XMLHttpRequest', 'Event', 'Headers',
  'Request', 'URL', 'process', 'require', 'module', 'exports', 'define', 'Buffer', 'global',
  'self', 'console', 'fetch', 'HTMLElement', 'Element', 'PerformanceObserver', 'TextEncoder',
  'location', 'performance', 'screen', 'chrome', 'crypto', 'Worker', 'postMessage',
])

/** True when an outcome is just "this sandbox does not provide that host API". */
function hostBail(outcome) {
  if (outcome.kind !== 'throw') return null
  const shape = errorShape(outcome.value)
  if (!shape || shape.name !== 'ReferenceError') return null
  const m = /^(\w+) is not defined$/.exec(shape.message)
  return m && HOST_GLOBALS.has(m[1]) ? m[1] : null
}

const HOST_FREE = new Set([
  'window', 'document', 'navigator', 'localStorage', 'XMLHttpRequest', 'Event',
  'Headers', 'Request', 'URL', 'process', 'require', 'module', 'exports', 'define',
  'Buffer', 'global', 'self', 'console', 'fetch', 'HTMLElement', 'Element',
  'PerformanceObserver', 'TextEncoder', 'Date', '__dirname',
])

function unsupportedReason(id, inv) {
  if (!inv) return 'no lifted inventory row'
  if (id <= 3) return 'bootstrap/module-initialiser: executes host setup, out of per-function scope'
  const host = Object.keys(inv.free).filter((n) => HOST_FREE.has(n))
  if (host.length) return `host dependencies: ${host.join(',')}`
  if (inv.dynamicState) return 'dynamic register index (__state.A[expr])'
  if (!splitByEntry.has(fnById.get(id)?.start)) return 'no callee register split recorded for this entry'
  return null
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const vmState = loadVm(minSource)
const liftedFns = loadLifted(vmState, liftedSource)

const results = []
const counterexamples = []

function resetStringCache() {
  const S = vmState.S
  for (const k of Object.keys(S)) delete S[k]
}

function seedModuleCells(indices, profileIndex) {
  const cells = new Map()
  for (let r = MODULE_BASE; r <= 1145; r++) cells.set(r, { v: undefined })
  for (const [k, r] of indices.entries()) {
    const [, make] = MODULE_PROFILES[(profileIndex + k) % MODULE_PROFILES.length]
    cells.set(r, { v: make() })
  }
  return cells
}

/**
 * Ancestor registers are seeded at every depth 1..MAX_DEPTH.
 *
 * `__upvalue` has two forms: `__upvalue(f, depth, index)` walks `depth` frames
 * from `f`, while `__upvalue(f, index)` (two arguments) walks one. On top of
 * that the emitter prints an explicit `for (… f = f.o)` walk before the call,
 * so the *static* depth of a capture is the manual walk plus the helper's own
 * depth. Seeding every level with the same value makes the capture resolve
 * identically regardless of that split, on both sides. It is an environmental
 * input, not a claim about the translation.
 */
const MAX_DEPTH = 8
function seedUpvalues(upvalues, profileIndex) {
  const byDepth = new Map()
  for (let d = 1; d <= MAX_DEPTH; d++) byDepth.set(d, new Map())
  for (const [k, u] of upvalues.entries()) {
    if (u.index == null) continue
    const [, make] = MODULE_PROFILES[(profileIndex + k) % MODULE_PROFILES.length]
    for (let d = 1; d <= MAX_DEPTH; d++) byDepth.get(d).set(u.index, make())
  }
  return byDepth
}

/** Runtime names the emitter emits but no shipped bundle defines. */
const MISSING_RUNTIME = ['__frames', '__thrown', '__unwind', '__dispatchCompletion']
function missingRuntimeIn(err) {
  const msg = String(err && err.message)
  for (const name of MISSING_RUNTIME) if (msg.includes(`${name} is not defined`)) return name
  return null
}
function envCollapse(err) {
  return /Cannot read properties of (null|undefined) \(reading 'o'\)/.test(String(err && err.message))
}

function buildBytecodeFrame(fn, split, args, cells, byDepth) {
  let parent = null
  const maxDepth = Math.max(0, ...byDepth.keys())
  for (let d = maxDepth; d >= 1; d--) {
    const frame = { u: 0, A: [], M: [], I: [], o: parent, S: 14 }
    frame.A[0] = null
    frame.A[1] = undefined
    frame.A[2] = true
    frame.A[3] = false
    frame.A[4] = vmState.B
    // Ancestor frames carry module cells at every depth so a prologue copy at
    // any depth resolves to the same cell object.
    for (const [r, cell] of cells) frame.A[r] = cell
    // Ancestor frames use the bootstrap split S=14, so slots >=14 are cells.
    // A raw value there would be copied into a cell register and read as
    // `undefined.v` by the callee.
    for (const [index, value] of byDepth.get(d) ?? []) {
      frame.A[index] = index >= 14 ? { v: value } : value
    }
    parent = frame
  }
  const frame = makeFrame({ entry: fn.start, split, thisVal: undefined, args, parent })
  frame.A[4] = vmState.B
  for (const [r, cell] of cells) frame.A[r] = cell
  return frame
}

function seedLiftedState(byDepth, cells) {
  const context = vmState.context
  let parent = null
  const maxDepth = Math.max(0, ...byDepth.keys())
  for (let d = maxDepth; d >= 1; d--) {
    const frame = { A: [], M: [], I: [], o: parent, S: 14, u: 0 }
    for (const [index, value] of byDepth.get(d) ?? []) frame.A[index] = index >= 14 ? { v: value } : value
    parent = frame
  }
  context.__state.o = parent
  for (const [r, cell] of cells) context[`mod${r}`] = cell
}

function readModuleCells(indices) {
  const context = vmState.context
  const out = {}
  for (const r of indices) {
    const cell = context[`mod${r}`]
    out[r] = cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell
  }
  return out
}

function readBytecodeCells(frame, indices) {
  const out = {}
  for (const r of indices) {
    const cell = frame.A[r]
    out[r] = cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell
  }
  return out
}

function runBytecode(fn, split, args, cells, byDepth, profileIndex) {
  const frame = buildBytecodeFrame(fn, split, args, cells, byDepth)
  const metered = meter(vmState, STEP_BUDGET)
  const stats = { steps: 0, catches: 0 }
  const t0 = Date.now()
  try {
    const value = runFrame(vmState, frame, { deadline: t0 + WALL_MS, stats })
    metered.restore()
    return { kind: 'return', value, stats, cells: readBytecodeCells(frame, [...cells.keys()]) }
  } catch (err) {
    metered.restore()
    if (err instanceof BudgetError) return { kind: 'timeout', value: err, stats, cells: readBytecodeCells(frame, [...cells.keys()]) }
    return { kind: 'throw', value: err, stats, cells: readBytecodeCells(frame, [...cells.keys()]) }
  }
}

function runLiftedSide(id, args, cells, byDepth, profileIndex) {
  resetStringCache()
  resetDeterminism()
  seedLiftedState(byDepth, cells)
  try {
    const value = callLifted(vmState, id, undefined, args, WALL_MS)
    return { kind: 'return', value, cells: readModuleCells([...cells.keys()]) }
  } catch (err) {
    const msg = String(err && err.message)
    if (/Script execution timed out|step budget/.test(msg)) return { kind: 'timeout', value: err }
    return { kind: 'throw', value: err, cells: readModuleCells([...cells.keys()]) }
  }
}

function outcomesEqual(a, b, modIndices) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'timeout') return false
  if (a.kind === 'return' && !valueEqual(a.value, b.value)) return false
  if (a.kind === 'throw') {
    const ea = errorShape(a.value)
    const eb = errorShape(b.value)
    if (ea || eb) {
      if (!ea || !eb) return false
      if (ea.name !== eb.name) return false
      if (normalizeErrorMessage(ea.message) !== normalizeErrorMessage(eb.message)) return false
    } else if (!valueEqual(a.value, b.value)) return false
  }
  for (const r of modIndices) if (!valueEqual(a.cells?.[r], b.cells?.[r])) return false
  return true
}

function analyze(fn) {
  const id = fn.id
  const inv = inventoryById.get(id)
  const reason = unsupportedReason(id, inv)
  if (reason) return { id, status: 'unsupported', evidence: reason }

  const split = splitByEntry.get(fn.start)
  if (DUMP) {
    const seen = []
    for (let d = 1, f = vmState.context.__state?.o; f && d <= 10; d++, f = f.o) seen.push(`d${d}:A30=${describe(f.A[30])},A31=${describe(f.A[31])}`)
    console.log(`  [env] fn_${id} split=${split} upvalues=${JSON.stringify(inv.upvalues)} chain: ${seen.slice(0,4).join(' ')}`)
  }
  const { indices, dynamic } = argIndicesOf(id)
  const modIndices = inv.mods
  const upvalues = inv.upvalues.filter((u) => u.depth != null)

  const cases = casesFor(indices, CASE_COUNT, dynamic)
  let matched = 0
  let timeouts = 0
  let envCollapsed = 0
  let returned = 0
  let catches = 0
  let steps = 0
  let hostSkipped = 0
  const failures = []

  for (const [ci, caseArgs] of cases.entries()) {
    const profileIndex = ci
    // Each side gets its own module cells: the bytecode run mutates them, and a
    // shared map would hand the lifted side an already-modified environment.
    const cellsBc = seedModuleCells(modIndices, profileIndex)
    const cellsLf = seedModuleCells(modIndices, profileIndex)
    const byDepthBc = seedUpvalues(upvalues, profileIndex)
    const byDepthLf = seedUpvalues(upvalues, profileIndex)

    const bcArgs = caseArgs.map((a) => cloneValue(a.make()))
    const lfArgs = caseArgs.map((a) => cloneValue(a.make()))

    // Bytecode first on a cold string cache; the lifted run resets it again.
    resetStringCache()
    resetDeterminism()
    const bc = runBytecode(fn, split, bcArgs, cellsBc, byDepthBc, profileIndex)
    const lf = runLiftedSide(id, lfArgs, cellsLf, byDepthLf, profileIndex)

    if (DUMP) {
      const errOf = (o) => o.kind === 'throw' ? `${o.value?.name}: ${o.value?.message}` : '(none)'
      console.log(`  case ${ci} args=${JSON.stringify(caseArgs.map((a) => `${a.index}:${a.label}`))}`)
      console.log(`    bytecode ${bc.kind} ${bc.kind === 'throw' ? errOf(bc) : describe(bc.value)}`)
      console.log(`    lifted   ${lf.kind} ${lf.kind === 'throw' ? errOf(lf) : describe(lf.value)}`)
    }
    const bcHost = hostBail(bc)
    const lfHost = hostBail(lf)
    if (bcHost || lfHost) {
      hostSkipped++
      continue
    }
    const missing = lf.kind === 'throw' ? missingRuntimeIn(lf.value) : null
    if (missing) {
      failures.push({
        caseIndex: ci,
        kind: 'missing-runtime',
        args: caseArgs.map((a) => ({ index: a.index, label: a.label })),
        bytecode: { kind: bc.kind, value: describe(bc.value) },
        lifted: { kind: lf.kind, value: describe(lf.value) },
        mechanism: `lifted code calls ${missing}(), which no shipped runtime defines`,
      })
      continue
    }
    if (bc.kind === 'throw' && lf.kind === 'throw' && envCollapse(bc.value) && envCollapse(lf.value)) {
      envCollapsed++
      continue
    }
    if (outcomesEqual(bc, lf, modIndices)) {
      matched++
      if (bc.kind === 'return') returned++
      catches += bc.stats?.catches ?? 0
      steps += bc.stats?.steps ?? 0
      continue
    }
    if (bc.kind === 'timeout' || lf.kind === 'timeout') {
      timeouts++
      failures.push({
        caseIndex: ci,
        kind: 'timeout',
        args: caseArgs.map((a) => ({ index: a.index, label: a.label })),
        bytecode: { kind: bc.kind, value: describe(bc.value) },
        lifted: { kind: lf.kind, value: describe(lf.value) },
        mechanism: bc.kind !== 'timeout'
          ? `bytecode finished (${bc.kind}) but the lifted run exceeded the ${WALL_MS} ms bound`
          : `bytecode exceeded the ${STEP_BUDGET}-dispatch bound; lifted was ${lf.kind}`,
      })
      continue
    }
    failures.push({
      caseIndex: ci,
      kind: 'diff',
      args: caseArgs.map((a) => ({ index: a.index, label: a.label })),
      bytecode: { kind: bc.kind, value: describe(bc.value) },
      lifted: { kind: lf.kind, value: describe(lf.value) },
      moduleEffects: Object.fromEntries(modIndices.map((r) => [r, describe(bc.cells?.[r]) + ' | ' + describe(lf.cells?.[r])])),
    })
  }

  const moduleNote = modIndices.length ? `; ${modIndices.length} module cell(s) seeded by profile` : ''
  const upnote = upvalues.length ? `; ${upvalues.length} upvalue(s) seeded` : ''
  const shape = returned ? `${returned}/${matched} returned normally` : 'no case returned; error behaviour matched'
  const tryNote = inv.free.__frames || inv.free.__thrown || inv.free.__unwind || inv.free.__dispatchCompletion
    ? '; try-path runtime helpers unresolved'
    : ''
  const catchNote = catches ? `; ${catches} caught exception(s) exercised` : ''
  if (failures.length === 0) {
    if (returned === 0) {
      return {
        id,
        status: 'unsupported',
        evidence: `no normal-return case in ${matched} matched case(s)${hostSkipped ? `, ${hostSkipped} skipped on missing host APIs` : ''}; only error behaviour comparable, so no equivalence claim`,
      }
    }
    return {
      id,
      status: 'proved',
      evidence: `bounded concrete equivalence: ${matched} cases matched (${shape}${catchNote}; args ${indices.length ? indices.join(',') : 'none'}${moduleNote}${upnote}${tryNote}${hostSkipped ? `; ${hostSkipped} host-dependent case(s) skipped` : ''}); scope = generated inputs only`,
      cases: matched,
    }
  }
  if (failures.length === 0 && envCollapsed > 0 && matched === 0) {
    return {
      id,
      status: 'unsupported',
      evidence: `harness could not build the ancestor frame for ${envCollapsed} case(s); no semantic comparison happened`,
    }
  }
  const hard = failures.filter((f) => f.kind === 'diff' || f.kind === 'missing-runtime')
  return {
    id,
    status: hard.length ? 'refuted' : 'timeout',
    evidence: hard.length
      ? hard[0].kind === 'missing-runtime'
        ? `${hard.length}/${cases.length} cases hit ${hard[0].mechanism}`
        : `${hard.length}/${cases.length} cases differ; first: args ${JSON.stringify(hard[0].args)} bytecode=${hard[0].bytecode.kind}:${hard[0].bytecode.value} lifted=${hard[0].lifted.kind}:${hard[0].lifted.value}`
      : `${timeouts}/${cases.length} cases hit the execution bound; ${failures[0]?.mechanism ?? 'no difference observed before the bound'}`,
    failures,
    cases,
  }
}

/** Resolve a value label used by the case generator back to a fresh value. */
export function valueByLabel(label) {
  const found = BASE_VALUES.find(([l]) => l === label)
  if (!found) throw new Error(`unknown value label: ${label}`)
  return found[1]()
}

/**
 * Run one function on one explicit argument vector, both sides, and report.
 * Used by repro.mjs so a counterexample is reproducible from its own JSON.
 */
export function runOne(id, argValues, profileIndex = 0) {
  const fn = fnById.get(id)
  if (!fn) throw new Error(`no such function: fn_${id}`)
  const inv = inventoryById.get(id)
  const split = splitByEntry.get(fn.start)
  if (split === undefined) throw new Error(`fn_${id}: no register split recorded`)
  const modIndices = inv.mods
  const upvalues = inv.upvalues.filter((u) => u.index != null)
  const cellsBc = seedModuleCells(modIndices, profileIndex)
  const cellsLf = seedModuleCells(modIndices, profileIndex)
  const byDepthBc = seedUpvalues(upvalues, profileIndex)
  const byDepthLf = seedUpvalues(upvalues, profileIndex)
  resetStringCache()
  resetDeterminism()
  const bc = runBytecode(fn, split, argValues.map(cloneValue), cellsBc, byDepthBc, profileIndex)
  const lf = runLiftedSide(id, argValues.map(cloneValue), cellsLf, byDepthLf, profileIndex)
  return {
    id,
    entry: fn.start,
    split,
    args: argValues.map((v) => describe(v)),
    bytecode: { kind: bc.kind, value: describe(bc.value) },
    lifted: { kind: lf.kind, value: describe(lf.value) },
    moduleEffects: Object.fromEntries(
      modIndices.map((r) => [r, `${describe(bc.cells?.[r])} | ${describe(lf.cells?.[r])}`]),
    ),
    equal: outcomesEqual(bc, lf, modIndices),
  }
}

function main() {
const selected = ONLY
  ? ONLY.split(',').map(Number)
  : functions.map((f) => f.id)

for (const f of functions) {
  if (!selected.includes(f.id)) continue
  if (!VERBOSE) {
    // progress every 25 functions
    if (f.id % 25 === 0) process.stderr.write(`  fn_${f.id}…\n`)
  }
  let row
  if (!REQUIRED.has(f.id)) {
    row = { id: f.id, status: 'not_attempted', evidence: 'outside the required coverage sets (no try, no back edge, no block-final return-slot write, not fn_44/fn_340)' }
  } else {
    row = analyze(f)
  }
  results.push(row)
  if (row.status === 'refuted') {
    counterexamples.push({
      fn: row.id,
      entry: f.start,
      split: splitByEntry.get(f.start) ?? null,
      failures: row.failures,
      repro: `node src/tiktok/scripts/_validation/02/repro.mjs --from src/tiktok/validation/02-semantics/counterexamples/fn_${row.id}.json --case 0`,
    })
  }
  if (VERBOSE && row.status !== 'proved') console.log(row.id, row.status, row.evidence.slice(0, 160))
}

// Required-but-unselected rows are reported as-is by the full run; when --only
// is used the CSV still covers all 351 rows using the last full result if any.
const order = { proved: 0, refuted: 1, timeout: 2, unsupported: 3, not_attempted: 4 }
results.sort((a, b) => a.id - b.id)

if (ONLY) {
  // Focused runs must not clobber the full 351-row table.
  console.log(JSON.stringify(results.map((r) => ({ id: r.id, status: r.status, evidence: r.evidence })), null, 1))
  return
}

fs.rmSync(CE_DIR, { recursive: true, force: true })
fs.mkdirSync(CE_DIR, { recursive: true })
fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'bounded concrete equivalence, not a theorem', results }, null, 2) + '\n')

const csv = ['fn_id,status,evidence']
for (const r of results) {
  const evidence = String(r.evidence ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')
  csv.push(`${r.id},${r.status},"${evidence}"`)
}
fs.writeFileSync(OUT_CSV, csv.join('\n') + '\n')

if (counterexamples.length) {
  for (const ce of counterexamples) {
    fs.writeFileSync(path.join(CE_DIR, `fn_${ce.fn}.json`), JSON.stringify(ce, null, 2) + '\n')
  }
}

const tally = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
console.log(JSON.stringify(tally))
console.log(`rows ${results.length}  required ${REQUIRED.size}  written ${path.relative(REPO, OUT_CSV)}`)
if (VERBOSE) console.log('status order', order)
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('run-differential.mjs')
if (invokedDirectly) main()
