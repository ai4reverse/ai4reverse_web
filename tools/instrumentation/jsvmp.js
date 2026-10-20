import { parse } from '../restore/parse.js'
import { traverse } from '../util/babel.js'
import { OPCODE_BY_CODE, SEMANTICS } from '../jsvmp/spec.js'

/**
 * JSVMP (JavaScript Virtual Machine Protection) instrumentation.
 *
 * A JSVMP is an interpreter written in JavaScript: a dispatch loop
 * (`while` + `switch(pc)`) executes an encoded bytecode program. Tracing it at
 * opcode granularity recovers the *virtual* program, which is often the real
 * malware logic.
 *
 * The instrumentation follows the same traceless rules as `code.js`:
 *  - text splicing into the original dispatch loop, never AST regeneration
 *  - marker-wrapped insertions, stripped by the `toString` masker
 *  - channel reached through a run-unique registered symbol, not a global
 *  - handler bodies, stack array and `pc` semantics are untouched
 */

const JSVMP_EVENT_KIND = 10
const JSVMP_LOOP_KIND = 11
const ID_BASE = 1_000_000

/**
 * Detect a dispatch loop without a full analysis pass (used when
 * tools/jsvmp/analyze.js is unavailable or the caller wants a quick check).
 * @param {object} ast Babel Program/File
 * @returns {{found: boolean, dispatch?: object}}
 */
export function detectDispatch(ast) {
  let best = null

  traverse(ast, {
    SwitchStatement(path) {
      const node = path.node
      if (!node.cases || node.cases.length < 5) return
      if (!isInsideLoop(path)) return
      const cases = node.cases.map((switchCase, index) => {
        const consequent = switchCase.consequent ?? []
        const first = consequent[0]
        const label =
          switchCase.test?.type === 'NumericLiteral'
            ? String(switchCase.test.value)
            : switchCase.test?.type === 'StringLiteral'
              ? switchCase.test.value
              : switchCase.test?.type === 'MemberExpression'
                ? memberPath(switchCase.test)
                : `case#${index}`
        return {
          index,
          label,
          start: switchCase.start,
          end: switchCase.end,
          bodyStart: first?.start ?? switchCase.start,
          bodyEnd: switchCase.end,
          consequentCount: consequent.length,
        }
      })
      if (!best || cases.length > best.cases.length) {
        best = {
          switchStart: node.start,
          switchEnd: node.end,
          discriminant: memberPath(node.discriminant),
          cases,
          loopKind: loopKindOf(path),
        }
      }
    },
  })

  if (!best) return { found: false }
  return {
    found: true,
    score: Math.min(100, best.cases.length * 4 + (best.discriminant ? 20 : 0)),
    kind: 'switch-dispatch',
    dispatch: best,
  }
}

/**
 * Instrument a detected dispatch loop.
 *
 * @param {string} source
 * @param {object} options
 * @param {object} options.dispatch dispatch descriptor (from detectDispatch or analyzeVM)
 * @param {string} options.channelExpression guest expression yielding the trace channel
 * @param {string} [options.bindingName]
 * @param {string} [options.marker]
 * @param {{functionStart?: number, functionBodyStart?: number, functionBodyEnd?: number}} [options.interpreter]
 * @returns {{code: string, plan: Map<number, object>, stats: object}}
 */
export function instrumentDispatch(source, options) {
  const {
    dispatch,
    channelExpression,
    bindingName = '_$v',
    marker = 'v',
    interpreter = null,
  } = options
  const begin = `/*#${marker}*/`
  const end = `/*#/${marker}*/`
  const wrap = (code) => `${begin}${code}${end}`

  // Without a function-scoped binding the per-case probes would throw
  // ReferenceError at the first dispatch; refuse rather than corrupt the run.
  if (!interpreter || interpreter.functionBodyStart === undefined) {
    return {
      code: source,
      plan: new Map(),
      stats: { opcodesInstrumented: 0, insertions: 0, bindingName, skipped: 'no-interpreter-binding' },
    }
  }

  const insertions = []
  const plan = new Map()
  let nextId = ID_BASE
  const record = (event, meta, line, column) => {
    nextId += 1
    plan.set(nextId, { event, id: nextId, line, column, ...meta })
    return nextId
  }

  const lineOf = (offset) => source.slice(0, offset).split('\n').length

  let instrumentedCases = 0
  for (const switchCase of dispatch.cases) {
    // Accept both detectDispatch and analyzeVM shapes; without a numeric body
    // start there is nowhere safe to insert.
    const bodyStart = Number.isFinite(switchCase.bodyStart) ? switchCase.bodyStart : null
    const caseStart = Number.isFinite(switchCase.start) ? switchCase.start : null
    if (bodyStart === null) continue
    if (switchCase.consequentCount === 0) continue
    if (caseStart !== null && bodyStart === caseStart) continue
    const id = record(
      'jsvmp:opcode',
      { opcode: switchCase.label, caseIndex: switchCase.index },
      lineOf(switchCase.start),
      0,
    )
    insertions.push({
      offset: bodyStart,
      priority: 100,
      text: wrap(`${bindingName}(${JSVMP_EVENT_KIND},${id});`),
    })
    instrumentedCases += 1
  }

  // Loop iteration counter at the head of the dispatch loop body.
  if (interpreter?.loopBodyStart !== undefined) {
    const id = record('jsvmp:step', { opcode: 'pc' }, lineOf(interpreter.loopBodyStart), 0)
    insertions.push({
      offset: interpreter.loopBodyStart,
      priority: 90,
      text: wrap(`${bindingName}(${JSVMP_LOOP_KIND},${id});`),
    })
  }

  // Channel binding inside the interpreter function keeps the binding local.
  insertions.push({
    offset: interpreter.functionBodyStart,
    priority: 110,
    // Leading newline keeps a directive prologue intact when it has no semicolon.
    text: wrap(`\nvar ${bindingName} = ${channelExpression};`),
  })

  const code = applyInsertions(source, insertions)
  return {
    code,
    plan,
    stats: {
      opcodesInstrumented: instrumentedCases,
      insertions: insertions.length,
      bindingName,
      skipped: instrumentedCases === 0 ? 'no-instrumentable-cases' : null,
    },
  }
}

/**
 * Locate the interpreter function and loop positions around a switch.
 * @param {string} source
 * @param {object} dispatch
 */
export function locateInterpreter(source, dispatch) {
  let ast
  try {
    ast = parse(source, { sourceType: 'script', errorRecovery: false }).ast
  } catch {
    return null
  }
  let interpreter = null
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.start !== dispatch.switchStart) return
      const loop = path.findParent((parent) => parent.isLoop && parent.isLoop())
      const fn = path.findParent((parent) => parent.isFunction && parent.isFunction())
      if (!loop || !fn) return
      const body = fn.node.body
      const loopBody = loop.node.body
      // Both bodies must be blocks: inserting into a braceless loop body (or a
      // single-expression arrow) would splice text into the middle of a token.
      if (body?.type !== 'BlockStatement' || loopBody?.type !== 'BlockStatement') return
      interpreter = {
        functionStart: fn.node.start,
        functionBodyStart: offsetAfterDirectives(body),
        functionBodyEnd: (body.end ?? 0) - 1,
        loopStart: loop.node.start,
        loopBodyStart: offsetAfterDirectives(loopBody),
        loopBodyEnd: (loopBody.end ?? 0) - 1,
      }
    },
  })
  return interpreter
}

/**
 * Turn raw opcode trace events into a human-readable pseudo-program.
 *
 * The recovered stream answers the questions an analyst asks first: which
 * operations run, in what order, with which constants, and which property
 * names / call arities appear.
 *
 * @param {object[]} events trace events
 * @param {object} [options]
 * @param {Record<string, string>} [options.semantics] opcode label -> description
 */
export function summarizeOpcodeTrace(events, options = {}) {
  const opcodeEvents = events.filter(
    (event) => event.kind === 'code' && (event.event === 'jsvmp:opcode' || event.event === 'jsvmp:step'),
  )
  const counts = new Map()
  const sequence = []
  for (const event of opcodeEvents) {
    const opcode = event.opcode ?? 'unknown'
    counts.set(opcode, (counts.get(opcode) ?? 0) + 1)
    if (sequence.length < 2000) sequence.push(opcode)
  }
  const semantics = options.semantics ?? {}
  const semanticFor = (label) => {
    if (semantics[label]) return semantics[label]
    const opcode = OPCODE_BY_CODE.get(Number(label))
    return opcode ? SEMANTICS[opcode.name] ?? null : null
  }
  return {
    steps: opcodeEvents.length,
    distinctOpcodes: counts.size,
    opcodes: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([opcode, count]) => ({ opcode, count, semantics: semanticFor(opcode) })),
    sequence,
    devirtualized: devirtualize(sequence, semantics, semanticFor),
  }
}

/**
 * Very conservative devirtualisation: turn an opcode stream into readable
 * pseudo-statements for the report. It never claims to reconstruct exact
 * expressions; it reconstructs the *shape* of the virtual program.
 */
export function devirtualize(sequence, semantics = {}, resolve = null) {
  const lines = []
  for (let i = 0; i < sequence.length && lines.length < 500; i += 1) {
    const opcode = sequence[i]
    const name = semantics[opcode] ?? (resolve ? resolve(opcode) : null) ?? opcode
    lines.push(name)
  }
  return lines
}

/**
 * Offset just after a block's directive prologue.
 * @param {{start?: number, body?: object[]}} block
 */
function offsetAfterDirectives(block) {
  let offset = (block.start ?? 0) + 1
  for (const statement of block.body ?? []) {
    const isDirective =
      statement.type === 'Directive' ||
      (statement.type === 'ExpressionStatement' &&
        statement.directive !== undefined &&
        statement.expression?.type === 'StringLiteral')
    if (!isDirective) break
    offset = statement.end
  }
  return offset
}

function applyInsertions(source, insertions) {
  if (insertions.length === 0) return source
  insertions.sort((a, b) => b.offset - a.offset || a.priority - b.priority)
  // Emit in a single pass: rebuilding the whole string per insertion cost
  // O(k·n) on large dispatch loops.
  const parts = []
  let cursor = 0
  for (let index = insertions.length - 1; index >= 0; index -= 1) {
    const insertion = insertions[index]
    parts.push(source.slice(cursor, insertion.offset))
    parts.push(insertion.text)
    cursor = insertion.offset
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

function isInsideLoop(path) {
  let current = path
  while (current) {
    if (current.isLoop && current.isLoop()) return true
    current = current.parentPath
  }
  return false
}

function loopKindOf(path) {
  let current = path
  while (current) {
    if (current.isWhileStatement?.()) return 'while'
    if (current.isForStatement?.()) return 'for'
    if (current.isDoWhileStatement?.()) return 'do-while'
    current = current.parentPath
  }
  return 'unknown'
}

function memberPath(node) {
  if (!node) return ''
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') {
    const object = memberPath(node.object)
    const property = node.computed ? `[${node.property?.value ?? '?'}]` : node.property?.name ?? ''
    return `${object}${node.computed ? property : `.${property}`}`
  }
  return node.type
}
