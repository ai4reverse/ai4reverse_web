/**
 * JSVMP analyzer.
 *
 * The analyzer is deliberately structural rather than signature-based: a real
 * JSVMP is a loop containing a dispatch `switch` whose discriminant is an
 * index into a bytecode array, plus a value stack and a program counter. It
 * also handles generated builders with per-build opcode numbers by accepting
 * a `dispatchTable` / `opcodes` hint.
 *
 * Every entry point is defensive: malformed samples return
 * `{ detected: false, note }` instead of throwing.
 */

import { parse as babelParse } from '@babel/parser'
import { generate } from '../restore/generate.js'
import { BASE_PLUGINS, parse } from '../restore/parse.js'
import { traverse } from '../util/babel.js'

/** Names that plausibly denote a VM program counter / instruction pointer. */
const PC_NAME_PATTERN = /^(?:_|\$)?(?:pc|ip|sp|idx|ptr|pointer|programcounter)$/i

/** Declared arrays that can hold bytecode or the constant pool. */
const BYTECODE_ARRAY_PATTERN = /bytecode|program|ops|instructions|pool|const|table/i

/** Parameter names that denote a program even without seeing the call site. */
const BYTECODE_PARAMETER_PATTERN = /bytecode|program|instructions|(?:^|_)(?:inst|instr|ops)(?:$|_)/i

const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'comments',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'tokens',
  'errors',
])

const LOOP_TYPES = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
])

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
])

/** @param {unknown} node */
function isNode(node) {
  return Boolean(node) && typeof node === 'object' && typeof node.type === 'string'
}

/**
 * Iterative AST walk. Iterative traversal keeps deeply nested hostile input
 * from overflowing the stack before the outer try/catch can report it.
 *
 * @param {object} root
 * @param {(node: object, context: {inLoop: number, loopNode: object|null, loopChain: object[], scope: object}) => void} visit
 */
function walk(root, visit) {
  /** @type {Array<{node: object, context: {inLoop: number, loopNode: object|null, loopChain: object[], scope: object}}>} */
  const pending = [{ node: root, context: { inLoop: 0, loopNode: null, loopChain: [], scope: root } }]
  while (pending.length > 0) {
    const { node, context } = pending.pop()
    if (!isNode(node)) continue
    visit(node, context)

    let childContext = context
    if (FUNCTION_TYPES.has(node.type) || node.type === 'Program') {
      childContext = { inLoop: 0, loopNode: null, loopChain: [], scope: node }
    } else if (LOOP_TYPES.has(node.type)) {
      childContext = {
        ...context,
        inLoop: context.inLoop + 1,
        loopNode: node,
        loopChain: [...context.loopChain, node],
      }
    }

    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          if (isNode(value[index])) pending.push({ node: value[index], context: childContext })
        }
      } else if (isNode(value)) {
        pending.push({ node: value, context: childContext })
      }
    }
  }
}

/**
 * @typedef {object} Signals
 * @property {Array<{node: object, inLoop: boolean, loopNode: object|null, advancesPc: boolean}>} switches
 * @property {Map<string, object|null>} declarations
 * @property {Set<string>} updates
 * @property {Set<string>} assignments
 * @property {Set<string>} pushPopVars
 * @property {Map<string, Set<object>>} pushPopLoops Stack-shaped names ->
 *   loops in which they receive a push/pop call.
 * @property {object[]} loops
 * @property {Map<string, object>} referencedPools
 * @property {Map<string, Set<string>>} pcIndexedArrays pc-like name ->
 *   declared bytecode/pool arrays it is used to index.
 * @property {Array<{pcName: string, arrayName: string, loopNode: object|null, assignedTo: string|null}>} pcIndexEvents
 */

/** @returns {Signals} */
function createSignals() {
  return {
    switches: [],
    declarations: new Map(),
    updates: new Set(),
    assignments: new Set(),
    pushPopVars: new Set(),
    pushPopLoops: new Map(),
    loops: [],
    referencedPools: new Map(),
    pcIndexedArrays: new Map(),
    pcIndexEvents: [],
  }
}

/**
 * Resolve only pool names actually referenced in each interpreter's lexical
 * scope. Keep these separate from pc/stack/bytecode detection evidence.
 * @param {object} ast
 * @returns {Map<object, Map<string, object>>}
 */
function collectReferencedPools(ast) {
  const pools = new Map()
  if (!isNode(ast)) return pools
  const file = ast.type === 'Program' ? { type: 'File', program: ast } : ast
  traverse(file, {
    ReferencedIdentifier(path) {
      const name = path.node.name
      if (!/const|pool|table/i.test(name)) return
      const binding = path.scope.getBinding(name)
      if (!binding?.path.isVariableDeclarator()) return
      const init = binding.path.node.init
      if (init?.type !== 'ArrayExpression') return
      const owner = path.getFunctionParent()?.node ?? path.scope.getProgramParent().path.node
      const previous = pools.get(owner) ?? new Map()
      pools.set(owner, new Map([...previous, [name, init]]))
    },
  })
  return pools
}

/**
 * A declared array that can plausibly hold bytecode or a constant pool.
 * @param {string} name
 * @param {object|null|undefined} init
 */
function looksLikeBytecodeArray(name, init) {
  // A bytecode-like name is evidence on its own: real samples often build the
  // program with a call (`var BYTECODE = decode()`) rather than an array
  // literal, so the name check must precede the initializer shape check.
  if (BYTECODE_ARRAY_PATTERN.test(name)) return true
  if (init?.type !== 'ArrayExpression') return false
  return init.elements.some((element) => element?.type === 'ArrayExpression')
}

/**
 * The parameter position a binding occupies, when the binding is a parameter.
 * Handles both plain identifiers and default-valued patterns.
 * @param {object} bindingPath
 * @returns {number} -1 when the binding is not a parameter.
 */
function parameterIndex(bindingPath) {
  if (bindingPath.listKey === 'params') return bindingPath.key
  if (bindingPath.parentPath?.listKey === 'params') return bindingPath.parentPath.key
  return -1
}

/**
 * Whether a parameter's value is visibly an array: a default parameter literal
 * or an array literal argument at a directly invoked call site (an IIFE or an
 * immediately invoked function expression).
 * @param {object} bindingPath
 * @returns {boolean}
 */
function parameterTakesArray(bindingPath) {
  const parent = bindingPath.parentPath
  if (parent?.isAssignmentPattern?.() && parent.node.right?.type === 'ArrayExpression') return true

  const functionPath = bindingPath.getFunctionParent?.()
  const callPath = functionPath?.parentPath
  if (!callPath?.isCallExpression?.() || callPath.node.callee !== functionPath.node) return false
  const index = parameterIndex(bindingPath)
  if (index < 0) return false
  return callPath.node.arguments[index]?.type === 'ArrayExpression'
}

/**
 * Whether a binding can hold bytecode. Variable declarators are checked through
 * their initializer; function parameters are checked through their name or
 * through the array value supplied by the caller (ACCEPTANCE H5).
 * @param {object|null|undefined} binding
 * @param {string} name
 * @returns {boolean}
 */
function bindingHoldsBytecode(binding, name) {
  const bindingPath = binding?.path
  if (!bindingPath) return false
  if (bindingPath.isVariableDeclarator()) {
    return looksLikeBytecodeArray(name, bindingPath.node.init)
  }
  if (binding.kind !== 'param') return false
  if (BYTECODE_PARAMETER_PATTERN.test(name)) return true
  return parameterTakesArray(bindingPath)
}

/**
 * pc-like identifiers appearing inside an index expression (`pc`, `pc++`,
 * `pc = pc + 1`).
 * @param {object|null|undefined} node
 * @returns {string[]}
 */
function pcNamesIn(node) {
  if (!isNode(node)) return []
  if (node.type === 'Identifier') return PC_NAME_PATTERN.test(node.name) ? [node.name] : []
  if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
    return PC_NAME_PATTERN.test(node.argument.name) ? [node.argument.name] : []
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
    return PC_NAME_PATTERN.test(node.left.name) ? [node.left.name] : []
  }
  return []
}

/**
 * Whether a subtree updates a pc-like variable (`pc++`, `pc += 1`). A dispatch
 * loop that advances its own program counter is interpreter evidence even when
 * it has no value stack. Iterative to stay safe on deeply nested input.
 * @param {object|null|undefined} node
 * @returns {boolean}
 */
function updatesPcIn(node) {
  if (!isNode(node)) return false
  const pending = [node]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isNode(current)) continue
    if (current.type === 'UpdateExpression' && current.argument?.type === 'Identifier') {
      if (PC_NAME_PATTERN.test(current.argument.name)) return true
    }
    if (current.type === 'AssignmentExpression' && current.left?.type === 'Identifier') {
      if (PC_NAME_PATTERN.test(current.left.name)) return true
    }
    for (const key of Object.keys(current)) {
      if (SKIP_KEYS.has(key)) continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) pending.push(child)
      } else if (isNode(value)) {
        pending.push(value)
      }
    }
  }
  return false
}

/**
 * Whether a switch advances a program counter, either in its discriminant
 * (`switch (inst[pc++])`) or in one of its case bodies (`case 1: pc += 1`).
 * @param {object} node
 * @returns {boolean}
 */
function switchAdvancesPc(node) {
  if (updatesPcIn(node.discriminant)) return true
  return (node.cases ?? []).some((switchCase) =>
    (switchCase.consequent ?? []).some((statement) => updatesPcIn(statement)),
  )
}

/**
 * The variable that receives an indexed read, when the read is an initializer
 * or assignment (`var inst = BYTECODE[pc++]`).
 * @param {object|null|undefined} node
 */
function assignedTarget(node) {
  if (!isNode(node)) return null
  if (node.type === 'VariableDeclarator') return node.id?.type === 'Identifier' ? node.id.name : null
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') return node.left.name
  return null
}

/**
 * Positive program-counter evidence: a pc-like variable used to index a
 * bytecode/pool array. The array may be declared locally, declared by an
 * enclosing IIFE, or supplied as a function parameter (name-shaped or backed
 * by an array literal argument). An ordinary `rows[idx]` whose binding carries
 * no array evidence produces none. Scope resolution follows bindings, so an
 * inner interpreter function may index a `BYTECODE` array declared by its
 * enclosing IIFE.
 *
 * @param {object} ast
 * @returns {Map<object, {pcIndexedArrays: Map<string, Set<string>>, pcIndexEvents: Array<{pcName: string, arrayName: string, loopNode: object|null, assignedTo: string|null}>}>}
 */
function collectPcIndexEvidence(ast) {
  const evidenceByScope = new Map()
  if (!isNode(ast)) return evidenceByScope
  const file = ast.type === 'Program' ? { type: 'File', program: ast } : ast
  traverse(file, {
    MemberExpression(path) {
      const node = path.node
      if (!node.computed || node.object?.type !== 'Identifier') return
      const binding = path.scope.getBinding(node.object.name)
      if (!bindingHoldsBytecode(binding, node.object.name)) return
      const pcNames = pcNamesIn(node.property)
      if (pcNames.length === 0) return

      const owner = path.getFunctionParent()?.node ?? path.scope.getProgramParent().path.node
      const loopPath = path.findParent((parent) => parent.isLoop && parent.isLoop())
      const loopNode = loopPath?.node ?? null
      const assignedTo = assignedTarget(path.parent)
      const previous = evidenceByScope.get(owner) ?? { pcIndexedArrays: new Map(), pcIndexEvents: [] }
      const pcIndexedArrays = new Map(previous.pcIndexedArrays)
      const pcIndexEvents = [...previous.pcIndexEvents]
      for (const pcName of pcNames) {
        pcIndexedArrays.set(
          pcName,
          new Set([...(pcIndexedArrays.get(pcName) ?? []), node.object.name]),
        )
        pcIndexEvents.push({ pcName, arrayName: node.object.name, loopNode, assignedTo })
      }
      evidenceByScope.set(owner, { pcIndexedArrays, pcIndexEvents })
    },
  })
  return evidenceByScope
}

/**
 * Collect evidence separately for each program/function scope. An unrelated
 * interpreter must not lend its stack or program counter to an ordinary loop.
 * @param {object} ast
 * @returns {Signals[]}
 */
function collectSignals(ast) {
  const scopes = new Map()
  walk(ast?.program ?? ast, (node, context) => {
    if (!scopes.has(context.scope)) scopes.set(context.scope, createSignals())
    const signals = scopes.get(context.scope)
    if (node.type === 'SwitchStatement' && isNode(node.discriminant)) {
      signals.switches.push({
        node,
        inLoop: context.inLoop > 0,
        loopNode: context.loopNode,
        advancesPc: switchAdvancesPc(node),
      })
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && !signals.declarations.has(node.id.name)) {
      signals.declarations.set(node.id.name, node.init ?? null)
    }
    if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
      signals.updates.add(node.argument.name)
    }
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
      signals.assignments.add(node.left.name)
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const { object, property } = node.callee
      if (
        object?.type === 'Identifier' &&
        property?.type === 'Identifier' &&
        (property.name === 'push' || property.name === 'pop')
      ) {
        signals.pushPopVars.add(object.name)
        const previous = signals.pushPopLoops.get(object.name) ?? new Set()
        signals.pushPopLoops.set(object.name, new Set([...previous, ...context.loopChain]))
      }
    }
    if (LOOP_TYPES.has(node.type)) signals.loops.push(node)
  })

  const referencedPools = collectReferencedPools(ast)
  const pcEvidence = collectPcIndexEvidence(ast)
  return [...scopes.entries()].map(([scope, signals]) => {
    const evidence = pcEvidence.get(scope)
    return {
      ...signals,
      referencedPools: referencedPools.get(scope) ?? new Map(),
      pcIndexedArrays: evidence?.pcIndexedArrays ?? new Map(),
      pcIndexEvents: evidence?.pcIndexEvents ?? [],
    }
  })
}

/** @param {object|null|undefined} node */
function isIndexedDiscriminant(node) {
  if (!isNode(node)) return false
  if (node.type === 'MemberExpression') {
    if (node.computed) return true
    return node.property?.type === 'Identifier' && /^(op|opcode|code|instruction|instr|operation)$/i.test(node.property.name)
  }
  return node.type === 'Identifier' && /^(op|opcode|code|instruction|instr|operation)$/i.test(node.name)
}

/**
 * The base identifier of a switch discriminant (`inst` for `inst[0]`).
 * @param {object|null|undefined} node
 */
function discriminantRootName(node) {
  if (!isNode(node)) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') return node.object.name
  return null
}

/** @param {object|null|undefined} node @param {Signals} signals */
function discriminantIndexesDeclaredArray(node, signals) {
  if (!isNode(node) || node.type !== 'MemberExpression' || !node.computed) return false
  if (node.object?.type !== 'Identifier') return false
  return [...signals.pcIndexedArrays.values()].some((arrays) => arrays.has(node.object.name))
}

/**
 * Evidence that a switch is the dispatcher the pc/bytecode variables belong
 * to. Two switches in one function can tie on shape; linkage breaks the tie.
 * @param {{node: object, inLoop: boolean, loopNode: object|null}} candidate
 * @param {Signals} signals
 */
function dispatchLinkage(candidate, signals) {
  let linkage = 0
  const discriminant = candidate.node.discriminant
  if (discriminantIndexesDeclaredArray(discriminant, signals)) linkage += 4
  if (!candidate.loopNode) return linkage

  const loopPcNames = signals.pcIndexEvents
    .filter((event) => event.loopNode === candidate.loopNode)
    .map((event) => event.pcName)
  if (loopPcNames.length > 0) linkage += 3

  // `var inst = BYTECODE[pc++]; switch (inst[0])`: the discriminant is fed by
  // the loop's pc-indexed bytecode read.
  const root = discriminantRootName(discriminant)
  if (
    root &&
    signals.pcIndexEvents.some(
      (event) => event.assignedTo === root && (event.loopNode === candidate.loopNode || event.loopNode === null),
    )
  ) {
    linkage += 2
  }
  return linkage
}

/**
 * Pick the switch that most looks like a bytecode dispatcher.
 * @param {Signals} signals
 */
function pickDispatch(signals) {
  if (signals.switches.length === 0) return null
  let best = null
  let bestWeight = -1
  let bestLinkage = -1
  for (const candidate of signals.switches) {
    const indexed = isIndexedDiscriminant(candidate.node.discriminant)
    const linkage = dispatchLinkage(candidate, signals)
    const weight = (candidate.inLoop ? 3 : 0) + (indexed ? 2 : 0) + linkage
    if (weight > bestWeight || (weight === bestWeight && linkage > bestLinkage)) {
      best = candidate
      bestWeight = weight
      bestLinkage = linkage
    }
  }
  return best
}

/** @param {object|null|undefined} node */
function renderNode(node) {
  if (!isNode(node)) return ''
  try {
    return generate(node, '', { comments: false }).code.trim()
  } catch {
    return ''
  }
}

/** @param {object[]} statements */
function renderStatements(statements) {
  if (!Array.isArray(statements) || statements.length === 0) return ''
  return renderNode({ type: 'Program', sourceType: 'script', body: statements, directives: [] })
}

/**
 * Evaluate a literal AST node without executing any code.
 * @param {object|null|undefined} node
 * @returns {{ok: boolean, value?: unknown}}
 */
function readLiteral(node) {
  if (!isNode(node)) return { ok: false }
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return { ok: true, value: node.value }
    case 'NullLiteral':
      return { ok: true, value: null }
    case 'BigIntLiteral':
      try {
        return { ok: true, value: BigInt(node.value) }
      } catch {
        return { ok: false }
      }
    case 'Identifier':
      if (node.name === 'undefined') return { ok: true, value: undefined }
      if (node.name === 'NaN') return { ok: true, value: NaN }
      if (node.name === 'Infinity') return { ok: true, value: Infinity }
      return { ok: false }
    case 'UnaryExpression': {
      if (node.operator === 'void') return { ok: true, value: undefined }
      if ((node.operator === '-' || node.operator === '+') && node.argument?.type === 'NumericLiteral') {
        return { ok: true, value: node.operator === '-' ? -node.argument.value : node.argument.value }
      }
      return { ok: false }
    }
    case 'TemplateLiteral': {
      if (node.expressions.length > 0) return { ok: false }
      return { ok: true, value: node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('') }
    }
    case 'ArrayExpression': {
      const values = []
      for (const element of node.elements) {
        if (!element) {
          values.push(undefined)
          continue
        }
        const literal = readLiteral(element)
        if (!literal.ok) return { ok: false }
        values.push(literal.value)
      }
      return { ok: true, value: values }
    }
    case 'ObjectExpression': {
      // Null prototype plus defineProperty avoids `__proto__` being treated as
      // a prototype setter while reading untrusted constant pools.
      const value = Object.create(null)
      for (const property of node.properties) {
        if (property.type !== 'ObjectProperty' || property.computed || property.kind !== 'init') return { ok: false }
        let key
        if (property.key.type === 'Identifier') key = property.key.name
        else if (property.key.type === 'StringLiteral') key = property.key.value
        else if (property.key.type === 'NumericLiteral') key = String(property.key.value)
        else return { ok: false }
        const literal = readLiteral(property.value)
        if (!literal.ok) return { ok: false }
        Object.defineProperty(value, key, { value: literal.value, enumerable: true, writable: true, configurable: true })
      }
      return { ok: true, value }
    }
    default:
      return { ok: false }
  }
}

/**
 * Find the constant pool declared in the interpreter. The generated builder
 * uses `var consts = [...]`; real samples often use `pool`, `table` or
 * `constants`.
 * @param {Signals} signals
 * @returns {unknown[]}
 */
function findConsts(signals) {
  const arrays = [...signals.declarations.entries(), ...signals.referencedPools.entries()]
    .filter(([, init]) => init?.type === 'ArrayExpression')
  const chosen =
    arrays.find(([name]) => name === 'consts') ??
    arrays.find(([name]) => /const|pool|table/i.test(name))
  if (!chosen) return []
  const values = []
  for (const element of chosen[1].elements) {
    if (!element) {
      values.push(undefined)
      continue
    }
    const literal = readLiteral(element)
    if (literal.ok) values.push(literal.value)
  }
  return values
}

/**
 * @param {Signals} signals
 */
function collectPcVariables(signals) {
  // Keep names that look like a VM program counter. Broad tokens like `index`,
  // `offset`, `step`, and `cursor` are ordinary loop counters and caused
  // false-positive JSVMP detections (ACCEPTANCE H5).
  const names = new Set([
    ...signals.updates,
    ...signals.assignments,
    ...signals.declarations.keys(),
  ])
  return [...names].filter((name) => PC_NAME_PATTERN.test(name)).sort()
}

/**
 * A stack-shaped variable only counts when it actually receives push/pop
 * inside the dispatch loop; `var stack = []` that is never used is not
 * interpreter evidence (ACCEPTANCE H5).
 * @param {Signals} signals
 * @param {object|null} dispatchLoop
 */
function findStackVariables(signals, dispatchLoop) {
  if (!isNode(dispatchLoop)) return []
  return [...signals.declarations.keys()].filter(
    (name) =>
      /stack|stk/i.test(name) &&
      signals.pushPopVars.has(name) &&
      signals.pushPopLoops.get(name)?.has(dispatchLoop) === true,
  )
}

/**
 * @param {Signals} signals
 */
function findBytecodeVariable(signals) {
  for (const [name, init] of signals.declarations) {
    if (init?.type !== 'ArrayExpression') continue
    if (/bytecode|program|ops|instructions/i.test(name)) return name
    if (init.elements.some((element) => element?.type === 'ArrayExpression')) return name
  }
  return null
}

/** @param {object|null|undefined} node */
function caseValue(node) {
  if (!isNode(node)) return null
  if (node.type === 'NumericLiteral' || node.type === 'StringLiteral') return node.value
  if (
    node.type === 'UnaryExpression' &&
    (node.operator === '-' || node.operator === '+') &&
    node.argument?.type === 'NumericLiteral'
  ) {
    return node.operator === '-' ? -node.argument.value : node.argument.value
  }
  return null
}

/**
 * @param {object} options
 * @returns {Map<number, string>}
 */
function buildOpcodeMap(options) {
  const map = new Map()
  if (Array.isArray(options.opcodes)) {
    for (const spec of options.opcodes) {
      if (!spec || typeof spec !== 'object') continue
      const code = Number(spec.code)
      if (Number.isInteger(code) && typeof spec.name === 'string') map.set(code, spec.name)
    }
  }
  return map
}

/**
 * Recognisable handler shapes produced by `builder.js`. This is only a
 * fallback for obfuscated builds without a dispatch-table hint: it lets the
 * analyzer recover mnemonic names even when numeric codes are shifted.
 * @type {Array<[string, RegExp]>}
 */
const OPCODE_SIGNATURES = [
  ['LOAD_CONST', /stack\.push\(readConst\(inst\[1\]\)\)/],
  ['LOAD_UNDEF', /stack\.push\(void 0\)/],
  ['LOAD_ARG', /stack\.push\(args\[inst\[1\]\]\)/],
  ['PUSH', /stack\.push\(inst\[1\]\)/],
  ['JMP_IF_NOT', /if \(!stack\.pop\(\)\) pc = inst\[1\]/],
  ['JMP_IF', /if \(stack\.pop\(\)\) pc = inst\[1\]/],
  ['JMP', /pc = inst\[1\];/],
  ['GET_PROP', /stack\.push\(a\[key\]\)/],
  ['SET_PROP', /a\[key\] = b;/],
  ['NEW_ARR', /arr\.unshift\(stack\.pop\(\)\)/],
  ['CALL', /callee\.apply\(void 0, callArgs\)/],
  ['NEW_OBJ', /stack\.push\(\{\}\)/],
  ['RET', /return stack\.length \? stack\.pop\(\) : void 0/],
  ['HALT', /return stack\.length \? stack\[stack\.length - 1\] : void 0/],
  ['DUP', /stack\.push\(stack\[stack\.length - 1\]\)/],
  ['TOSTR', /String\(stack\.pop\(\)\)/],
  ['TONUM', /Number\(stack\.pop\(\)\)/],
  ['ADD', /stack\.push\(a \+ b\)/],
  ['SUB', /stack\.push\(a - b\)/],
  ['MUL', /stack\.push\(a \* b\)/],
  ['DIV', /stack\.push\(a \/ b\)/],
  ['MOD', /stack\.push\(a % b\)/],
  ['NEG', /stack\.push\(-a\)/],
  ['NOT', /stack\.push\(!a\)/],
  ['EQ', /stack\.push\(a == b\)/],
  ['NEQ', /stack\.push\(a != b\)/],
  ['LTE', /stack\.push\(a <= b\)/],
  ['GTE', /stack\.push\(a >= b\)/],
  ['LT', /stack\.push\(a < b\)/],
  ['GT', /stack\.push\(a > b\)/],
  ['AND', /stack\.push\(a && b\)/],
  ['OR', /stack\.push\(a \|\| b\)/],
  ['SWAP', /stack\.push\(a\);\s*stack\.push\(b\)/],
  ['POP', /^stack\.pop\(\);?(?: break;)?$/],
]

/** @param {string} body */
function inferOpcode(body) {
  const normalized = body.replace(/\s+/g, ' ').trim()
  for (const [name, pattern] of OPCODE_SIGNATURES) {
    if (pattern.test(normalized)) return name
  }
  return null
}

/**
 * @param {unknown} code
 * @param {Record<string, {name?: string, code?: number}>|null} dispatchTable
 * @param {Map<number, string>} opcodeMap
 * @param {string} body
 * @param {number} caseIndex
 * @param {boolean} isDefault
 */
function resolveOpcode(code, dispatchTable, opcodeMap, body, caseIndex, isDefault) {
  if (isDefault) return 'default'
  const key = String(code)
  const entry = dispatchTable && typeof dispatchTable === 'object' ? dispatchTable[key] : null
  if (entry && typeof entry.name === 'string') return entry.name
  if (typeof code === 'number' && opcodeMap.has(code)) return opcodeMap.get(code)
  const inferred = inferOpcode(body)
  if (inferred) return inferred
  // Without a dispatch-table hint, an opcode hint, or a recognised handler
  // shape there is no evidence this body implements this project's ISA. A
  // canonical numeric code would fabricate a mnemonic and collapse distinct
  // foreign handlers, so fall back to a positionally unique case label.
  return `case_${caseIndex}`
}

/**
 * Parse a rendered case body into a BlockStatement. The body is wrapped in a
 * loop so that trailing `break` / `continue` statements remain syntactically
 * valid while the original statements are preserved.
 * @param {string} source
 * @returns {object|null}
 */
function parseHandlerBody(source) {
  try {
    const wrapped = `while (true) {\n${source}\n}`
    const ast = babelParse(wrapped, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: false,
      ranges: true,
      plugins: BASE_PLUGINS,
    })
    const loop = ast.program.body[0]
    return loop?.body ?? null
  } catch {
    return null
  }
}

/**
 * @param {object} switchNode
 * @param {object} options
 */
function extractCases(switchNode, options) {
  const opcodeMap = buildOpcodeMap(options)
  const dispatchTable = options.dispatchTable && typeof options.dispatchTable === 'object' ? options.dispatchTable : null
  /** @type {Array<{opcode:string,test:string|null,body:string,start:number|null,end:number|null,ast:object|null}>} */
  const cases = []
  const switchCases = switchNode.cases ?? []
  for (const [caseIndex, caseNode] of switchCases.entries()) {
    const test = caseNode.test ? renderNode(caseNode.test) : null
    const code = caseValue(caseNode.test)
    const body = renderStatements(caseNode.consequent)
    cases.push({
      opcode: resolveOpcode(code, dispatchTable, opcodeMap, body, caseIndex, caseNode.test == null),
      test,
      body,
      start: typeof caseNode.start === 'number' ? caseNode.start : null,
      end: typeof caseNode.end === 'number' ? caseNode.end : null,
      ast: parseHandlerBody(body),
    })
  }
  return cases
}

/**
 * @param {object|null} loopNode
 */
function describeLoop(loopNode) {
  if (!isNode(loopNode)) return null
  return {
    type: loopNode.type,
    start: typeof loopNode.start === 'number' ? loopNode.start : null,
    end: typeof loopNode.end === 'number' ? loopNode.end : null,
    test: loopNode.test ? renderNode(loopNode.test) : null,
  }
}

/**
 * Shared structural detection for static analysis and runtime instrumentation.
 * @param {object} ast Babel File/Program
 * @returns {{detected: boolean, score: number, kind: string, dispatchInfo: object|null, consts: unknown[], interpreter: object}}
 */
export function analyzeVMStructure(ast) {
  const candidates = collectSignals(ast).map(analyzeScope)
  return candidates.reduce((best, candidate) => {
    if (candidate.detected !== best.detected) return candidate.detected ? candidate : best
    if (Boolean(candidate.dispatchInfo) !== Boolean(best.dispatchInfo)) {
      return candidate.dispatchInfo ? candidate : best
    }
    return candidate.score > best.score ? candidate : best
  }, analyzeScope(createSignals()))
}

/** @param {Signals} signals */
function analyzeScope(signals) {
  const dispatchInfo = pickDispatch(signals)
  const hasSwitch = signals.switches.length > 0
  const hasWhile = signals.loops.some(
    (loop) => loop.type === 'WhileStatement' || loop.type === 'DoWhileStatement',
  )
  const stackVariables = findStackVariables(signals, dispatchInfo?.loopNode)
  const pcVariables = collectPcVariables(signals)
  // A pc-like name is only a program counter when it indexes something that
  // looks like bytecode; `idx` over ordinary caller data is not (ACCEPTANCE H5).
  const linkedPcVariables = pcVariables.filter(
    (name) => (signals.pcIndexedArrays.get(name)?.size ?? 0) > 0,
  )
  const bytecodeVariable = findBytecodeVariable(signals)
  const consts = findConsts(signals)
  const indexed = Boolean(dispatchInfo && isIndexedDiscriminant(dispatchInfo.node.discriminant))
  const inLoop = Boolean(dispatchInfo?.inLoop)

  let score = 0
  if (hasSwitch) score += 10
  if (inLoop) score += 25
  if (indexed) score += 20
  if (stackVariables.length > 0) score += 15
  if (linkedPcVariables.length > 0) score += 10
  if (bytecodeVariable) score += 15
  if (consts.length > 0) score += 5
  score = Math.min(100, score)

  // Detection needs pc/bytecode linkage plus either a value stack that is
  // actually pushed/popped inside the dispatch loop or a self-advancing program
  // counter. An ordinary `while` + `switch(rows[idx])` over a local
  // array-of-arrays has neither (ACCEPTANCE H5).
  const hasPcEvidence = linkedPcVariables.length > 0
  const hasStackEvidence = stackVariables.length > 0
  // A stackless interpreter is still a dispatcher when it advances its program
  // counter itself (`switch (inst[pc++])`, `case: pc += 1`). An ordinary table
  // walk has pc/array linkage but neither a used stack nor a self-advancing
  // counter, so it stays undetected (ACCEPTANCE H5).
  const advancesPc = Boolean(dispatchInfo?.advancesPc)
  const detected =
    hasSwitch &&
    inLoop &&
    indexed &&
    score >= 50 &&
    ((hasPcEvidence && hasStackEvidence) || (hasPcEvidence && advancesPc))
  return {
    detected,
    score,
    kind: detected ? (score >= 80 ? 'stack-vm' : 'switch-dispatch') : 'none',
    dispatchInfo,
    consts,
    interpreter: { hasSwitch, hasWhile, pcVariables },
  }
}

/**
 * Analyze a candidate JSVMP source string.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {Record<string, {name?: string, code?: number}>} [options.dispatchTable]
 *   Encoded opcode -> canonical metadata, as returned by `buildVM`.
 * @param {Array<{code: number, name: string}>} [options.opcodes]
 *   Optional canonical opcode list hint.
 * @returns {object} Analysis result. Malformed input yields
 *   `{detected:false, note}`.
 */
export function analyzeVM(source, options = {}) {
  try {
    if (typeof source !== 'string' || source.trim() === '') {
      return { detected: false, note: 'source must be a non-empty string' }
    }

    let parsed
    try {
      parsed = parse(source, { sourceType: 'script', ranges: true, errorRecovery: true })
    } catch (error) {
      return { detected: false, note: `parse failed: ${error.message}` }
    }

    const { detected, score, kind, dispatchInfo, consts, interpreter } = analyzeVMStructure(parsed.ast)

    if (!dispatchInfo) {
      return {
        detected,
        score,
        kind,
        dispatch: { discriminant: null, cases: [], loop: null },
        handlers: {},
        consts,
        interpreter,
      }
    }

    const extracted = extractCases(dispatchInfo.node, options)
    /** @type {Record<string, {source: string, ast: object|null}>} */
    const handlers = {}
    for (const entry of extracted) {
      if (!handlers[entry.opcode]) handlers[entry.opcode] = { source: entry.body, ast: entry.ast }
    }
    const cases = extracted.map(({ ast, ...rest }) => {
      void ast
      return rest
    })

    return {
      detected,
      score,
      kind,
      dispatch: {
        discriminant: renderNode(dispatchInfo.node.discriminant),
        cases,
        loop: describeLoop(dispatchInfo.loopNode),
      },
      handlers,
      consts,
      interpreter,
    }
  } catch (error) {
    return { detected: false, note: `analysis failed: ${error.message}` }
  }
}

/**
 * Extract `{ [opcode]: { source, ast } }` from a candidate source string.
 * Case bodies are rendered with Babel and re-parsed into BlockStatement ASTs.
 *
 * @param {string} source
 * @param {object} [options] same options as {@link analyzeVM}
 * @returns {Record<string, {source: string, ast: object|null}>}
 */
export function extractHandlers(source, options = {}) {
  try {
    const analysis = analyzeVM(source, options)
    return analysis && typeof analysis.handlers === 'object' && analysis.handlers !== null
      ? analysis.handlers
      : {}
  } catch {
    return {}
  }
}

/**
 * Boolean convenience wrapper around {@link analyzeVM}.
 * @param {string} source
 * @param {object} [options]
 * @returns {boolean}
 */
export function isJSVMP(source, options = {}) {
  try {
    return analyzeVM(source, options).detected === true
  } catch {
    return false
  }
}

/** @param {unknown[]} values */
function jsonSample(values) {
  return values.slice(0, 10).map((value) => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null
    if (typeof value === 'bigint') return value.toString()
    try {
      const serialized = JSON.stringify(value)
      return serialized === undefined ? null : JSON.parse(serialized)
    } catch {
      return String(value)
    }
  })
}

/**
 * Compact, JSON-safe summary suitable for reports and traces. Never includes
 * AST nodes or full handler bodies.
 *
 * @param {object} analysis
 * @returns {object}
 */
export function summarizeVM(analysis) {
  try {
    const dispatch = analysis?.dispatch
    const cases = Array.isArray(dispatch?.cases) ? dispatch.cases : []
    const handlers = analysis?.handlers && typeof analysis.handlers === 'object' ? analysis.handlers : {}
    const consts = Array.isArray(analysis?.consts) ? analysis.consts : []
    const interpreter = analysis?.interpreter && typeof analysis.interpreter === 'object' ? analysis.interpreter : {}

    const summary = {
      detected: Boolean(analysis?.detected),
      score: Number.isFinite(analysis?.score) ? analysis.score : 0,
      kind: typeof analysis?.kind === 'string' ? analysis.kind : 'none',
      dispatch: dispatch && typeof dispatch === 'object'
        ? {
            discriminant: typeof dispatch.discriminant === 'string' ? dispatch.discriminant : '',
            caseCount: cases.length,
            opcodes: cases.map((entry) => String(entry?.opcode ?? 'unknown')),
            loop: dispatch.loop && typeof dispatch.loop === 'object' ? String(dispatch.loop.type ?? '') : null,
          }
        : null,
      handlers: Object.entries(handlers).map(([opcode, handler]) => ({
        opcode,
        sourceLength: typeof handler?.source === 'string' ? handler.source.length : 0,
        parsed: Boolean(handler?.ast),
      })),
      consts: {
        count: consts.length,
        sample: jsonSample(consts),
      },
      interpreter: {
        hasSwitch: Boolean(interpreter.hasSwitch),
        hasWhile: Boolean(interpreter.hasWhile),
        pcVariables: Array.isArray(interpreter.pcVariables)
          ? interpreter.pcVariables.map((name) => String(name)).slice(0, 10)
          : [],
      },
    }
    if (typeof analysis?.note === 'string') summary.note = analysis.note
    return summary
  } catch {
    return {
      detected: false,
      score: 0,
      kind: 'none',
      dispatch: null,
      handlers: [],
      consts: { count: 0, sample: [] },
      interpreter: { hasSwitch: false, hasWhile: false, pcVariables: [] },
    }
  }
}
