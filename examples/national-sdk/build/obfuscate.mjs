/**
 * Polymorphic obfuscator.
 *
 * Seven passes, each parameterised by a build seed:
 *
 *   1. identifier mangling (scope-aware, via Babel's binding table)
 *   2. control-flow flattening of function bodies into a shuffled state machine
 *   3. opaque predicates (`n*n-n` is even) and never-executed dead branches
 *   4. numeric literal encoding (`a ^ b` where `a ^ b` is the original)
 *   5. switch-case shuffling
 *   6. decoy functions
 *   7. string-table extraction with a per-build XOR mask over UTF-16 units
 *
 * The passes are deliberately conservative: every transformation preserves
 * evaluation order and scope, because the build verifies the result by *running*
 * the bundle and checking signatures, not by inspecting the output. A pass that
 * cannot prove safety (e.g. wrapping a `let` declaration in a block) does not
 * run on that node.
 */

import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import generate from '@babel/generator'
import * as t from '@babel/types'
import { createPrng } from '../src/core/prng.js'

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected',
  'interface', 'private', 'public', 'null', 'true', 'false', 'arguments', 'eval', 'undefined',
  'NaN', 'Infinity', 'globalThis', 'window', 'self', 'document', 'navigator', 'crypto', 'Math',
])

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$'

/** @param {ReturnType<typeof createPrng>} prng @param {Set<string>} used */
function freshName(prng, used) {
  for (;;) {
    const length = 3 + prng.int(4)
    let name = ''
    for (let index = 0; index < length; index += 1) name += ALPHABET[prng.int(ALPHABET.length)]
    if (RESERVED.has(name) || used.has(name) || /^__/.test(name)) continue
    used.add(name)
    return name
  }
}

/**
 * 1. Scope-aware identifier mangling.
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function mangle(ast, prng) {
  // Reserve every identifier that already exists anywhere in the program,
  // including unbound global references and property keys. A renamed binding
  // must not be able to shadow a global or an identifier in a nested scope that
  // has not been visited yet: shadowing changes resolution and silently breaks
  // the bundle.
  const reserved = new Set()
  traverse(ast, {
    Identifier(path) {
      reserved.add(path.node.name)
    },
  })
  const used = new Set(reserved)
  traverse(ast, {
    Scopable(path) {
      const bindings = path.scope.bindings
      for (const name of Object.keys(bindings)) {
        if (RESERVED.has(name)) continue
        const binding = bindings[name]
        if (!binding || binding.kind === 'module') continue
        if (binding.identifier && binding.identifier.name === 'arguments') continue
        const replacement = freshName(prng, used)
        try {
          path.scope.rename(name, replacement)
        } catch {
          /* a binding Babel cannot rename safely keeps its name */
        }
      }
    },
  })
}

/**
 * 4. Numeric literal encoding.
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function encodeNumbers(ast, prng) {
  traverse(ast, {
    NumericLiteral(path) {
      const { node } = path
      if (!Number.isInteger(node.value) || node.value < 2 || node.value > 0xffff) return
      const parent = path.parentPath
      if (parent.isObjectProperty() && parent.node.key === node && !parent.node.computed) return
      if (parent.isUnaryExpression({ operator: '-' })) {
        // `-5` becomes `-(a^b)`, still correct.
      }
      const left = prng.int(0x10000)
      const right = (left ^ node.value) & 0xffff
      path.replaceWith(t.binaryExpression('^', t.numericLiteral(left), t.numericLiteral(right)))
      path.skip()
    },
  })
}

/**
 * 2. Control-flow flattening.
 *
 * Only the top-level statement list of a function is flattened. Nested loops,
 * `break`/`continue` and `return` keep their normal semantics because their
 * enclosing constructs move into a case unchanged.
 *
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function flatten(ast, prng) {
  traverse(ast, {
    Function(path) {
      const body = path.node.body
      if (!t.isBlockStatement(body)) return
      const statements = body.body
      if (statements.length < 4 || statements.length > 64) return
      if (body.directives && body.directives.length > 0) return
      if (statements.some((statement) => t.isFunctionDeclaration(statement))) return
      if (statements.some((statement) => t.isClassDeclaration(statement))) return
      // Top-level `let`/`const` become `var`: the state machine re-enters the
      // switch block on every transition, which would re-create block-scoped
      // bindings and make a later case hit the TDZ. `var` is function-scoped
      // and preserves the original initialisation order.
      for (const statement of statements) {
        if (t.isVariableDeclaration(statement) && statement.kind !== 'var') statement.kind = 'var'
      }
      const stateName = freshName(prng, new Set())
      // Unique state ids: duplicate case labels would make the switch order
      // observable once the cases are shuffled.
      const usedIds = new Set()
      const ids = statements.map(() => {
        for (;;) {
          const id = 1000 + prng.int(8000)
          if (!usedIds.has(id)) {
            usedIds.add(id)
            return id
          }
        }
      })
      let endId = 9001
      while (usedIds.has(endId)) endId += 1
      const cases = statements.map((statement, index) => {
        const next = index + 1 < statements.length ? ids[index + 1] : endId
        return t.switchCase(t.numericLiteral(ids[index]), [
          statement,
          t.expressionStatement(
            t.assignmentExpression('=', t.identifier(stateName), t.numericLiteral(next)),
          ),
          t.continueStatement(),
        ])
      })
      cases.push(t.switchCase(t.numericLiteral(endId), [t.returnStatement()]))
      const shuffled = prng.shuffle(cases)
      const machine = t.forStatement(
        null,
        null,
        null,
        t.blockStatement([
          t.switchStatement(t.identifier(stateName), shuffled),
        ]),
      )
      body.body = [
        t.variableDeclaration('var', [t.variableDeclarator(t.identifier(stateName), t.numericLiteral(ids[0]))]),
        machine,
      ]
      path.skip()
    },
  })
}

/**
 * 3. Opaque predicates and dead branches.
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function opaquePredicates(ast, prng) {
  let counter = 0
  traverse(ast, {
    BlockStatement(path) {
      const statements = path.node.body
      if (statements.length === 0) return
      const rewritten = []
      for (const statement of statements) {
        if (t.isExpressionStatement(statement) && prng.int(10) < 3) {
          const value = 2 + prng.int(997)
          const predicate = t.binaryExpression(
            '===',
            t.binaryExpression(
              '%',
              t.binaryExpression('-', t.binaryExpression('*', t.numericLiteral(value), t.numericLiteral(value)), t.numericLiteral(value)),
              t.numericLiteral(2),
            ),
            t.numericLiteral(0),
          )
          rewritten.push(t.ifStatement(predicate, t.blockStatement([statement])))
        } else {
          rewritten.push(statement)
        }
      }
      if (prng.int(10) < 5) {
        counter += 1
        const probe = 2 + prng.int(997)
        const junkName = `__junk_${counter}_${prng.int(1e6)}`
        const dead = t.ifStatement(
          t.binaryExpression('!==', t.numericLiteral(probe), t.numericLiteral(probe)),
          t.blockStatement([
            t.variableDeclaration('var', [t.variableDeclarator(t.identifier(junkName), t.numericLiteral(0))]),
            t.whileStatement(
              t.binaryExpression('<', t.identifier(junkName), t.numericLiteral(3)),
              t.expressionStatement(
                t.assignmentExpression('=', t.identifier(junkName), t.binaryExpression('+', t.identifier(junkName), t.numericLiteral(1))),
              ),
            ),
          ]),
        )
        rewritten.unshift(dead)
      }
      path.node.body = rewritten
    },
  })
}

/**
 * 5. Switch-case shuffling.
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function shuffleSwitches(ast, prng) {
  traverse(ast, {
    SwitchStatement(path) {
      const cases = path.node.cases
      const defaults = cases.filter((entry) => entry.test === null)
      const normal = cases.filter((entry) => entry.test !== null)
      path.node.cases = [...prng.shuffle(normal), ...defaults]
    },
  })
}

/**
 * 6. Decoy functions.
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function decoyFunctions(ast, prng) {
  const count = 2 + prng.int(3)
  for (let index = 0; index < count; index += 1) {
    const name = freshName(prng, new Set())
    const a = 2 + prng.int(97)
    const b = 2 + prng.int(97)
    const fn = parse(
      `function ${name}(x){var y=x*${a}+${b};while(y>${a}){y=(y^${b})-${a}}return y%${b}}`,
      { sourceType: 'script' },
    ).program.body[0]
    ast.program.body.push(fn)
  }
}

/**
 * 7. String extraction and template flattening.
 *
 * Object keys are converted to computed keys (they carry internal API names);
 * destructuring-pattern keys are left alone because computed keys are not valid
 * in a binding pattern. Template literals are rewritten into a `+` chain so the
 * static quasis can be encoded too.
 *
 * @param {object} ast
 * @param {ReturnType<typeof createPrng>} prng
 */
function encodeStrings(ast, prng) {
  const decoderName = `__${Array.from({ length: 8 }, () => ALPHABET[prng.int(ALPHABET.length)]).join('')}`
  const maskMul = 7919
  const maskAdd = 13 + prng.int(1000)
  const encode = (value) => {
    let encoded = ''
    for (let index = 0; index < value.length; index += 1) {
      // The decoder walks the hex string in steps of four, so the mask must be
      // keyed by the *hex offset* (index * 4), not by the character index.
      const mask = ((index * 4) * maskMul + maskAdd) & 0xffff
      encoded += ((value.charCodeAt(index) ^ mask) & 0xffff).toString(16).padStart(4, '0')
    }
    return encoded
  }
  const encodedLiteral = (value) => {
    const literal = t.stringLiteral(encode(value))
    literal.extra = { ...(literal.extra ?? {}), nsdkEncoded: true }
    return literal
  }

  // 1. Template literals -> "quasi" + expr + "quasi" ...
  traverse(ast, {
    TemplateLiteral(path) {
      const quasis = path.node.quasis
      const expressions = path.node.expressions
      const cooked = (index) => {
        const value = quasis[index]?.value
        return value?.cooked ?? value?.raw ?? ''
      }
      let node = t.callExpression(t.identifier(decoderName), [encodedLiteral(cooked(0))])
      for (let index = 0; index < expressions.length; index += 1) {
        node = t.binaryExpression('+', node, expressions[index])
        node = t.binaryExpression('+', node, t.callExpression(t.identifier(decoderName), [encodedLiteral(cooked(index + 1))]))
      }
      path.replaceWith(node)
    },
  })

  // 2. Plain strings.
  const paths = []
  traverse(ast, {
    StringLiteral(path) {
      if (path.node.extra && path.node.extra.nsdkEncoded) return
      const parent = path.parentPath
      if (parent.isDirective()) return
      if (parent.isMemberExpression() && parent.node.property === path.node && !parent.node.computed) return
      if (path.node.value.length === 0) return
      paths.push(path)
    },
  })
  for (const path of paths) {
    const parent = path.parentPath
    const encoded = encode(path.node.value)
    if (
      parent.isObjectProperty() &&
      parent.node.key === path.node &&
      !parent.node.computed &&
      !parent.parentPath.isObjectPattern()
    ) {
      parent.node.key = t.callExpression(t.identifier(decoderName), [t.stringLiteral(encoded)])
      parent.node.computed = true
      continue
    }
    path.replaceWith(t.callExpression(t.identifier(decoderName), [t.stringLiteral(encoded)]))
    path.skip()
  }
  const decoder = parse(
    `function ${decoderName}(h){var s="";for(var i=0;i<h.length;i+=4){var c=parseInt(h.substr(i,4),16)^((i*${maskMul}+${maskAdd})&65535);s+=String.fromCharCode(c)}return s}`,
    { sourceType: 'script' },
  ).program.body[0]
  ast.program.body.unshift(decoder)
}

/**
 * @param {string} code
 * @param {string|number} seed
 * @param {{passes?: string[]}} [options]
 * @returns {string}
 */
export function obfuscate(code, seed, options = {}) {
  const prng = createPrng(seed, 'obfuscate')
  const ast = parse(code, { sourceType: 'script', allowAwaitOutsideFunction: false })
  const enabled = new Set(options.passes ?? ['flatten', 'opaque', 'shuffle', 'decoy', 'mangle', 'numbers', 'strings'])
  if (enabled.has('flatten')) flatten(ast, prng)
  if (enabled.has('opaque')) opaquePredicates(ast, prng)
  if (enabled.has('shuffle')) shuffleSwitches(ast, prng)
  if (enabled.has('decoy')) decoyFunctions(ast, prng)
  if (enabled.has('mangle')) mangle(ast, prng)
  if (enabled.has('numbers')) encodeNumbers(ast, prng)
  if (enabled.has('strings')) encodeStrings(ast, prng)
  const output = generate(ast, {
    comments: false,
    compact: false,
    jsescOption: { minimal: true },
    retainLines: false,
  }).code
  // The build must never emit code it cannot parse again.
  parse(output, { sourceType: 'script' })
  return output
}
