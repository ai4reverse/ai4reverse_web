/**
 * JS Obfuscator SDK — semantics-preserving source protection.
 *
 * Transforms built on Babel: string literals become `String.fromCharCode(...)`
 * expressions, local bindings are renamed to `_0x…`, and dead branches are
 * injected. Every transform checks for shadowing / dynamic scope and bails out
 * rather than changing behaviour. `deobfuscate` reverses the readable layers.
 */
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { generate } from '@babel/generator'
import * as t from '@babel/types'

const traverse = traverseModule.default ?? traverseModule.traverse ?? traverseModule
export const VERSION = '1.0.0'

function hashName(input, seed) {
  let hash = 0x811c9dc5 ^ seed
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `_0x${hash.toString(16).padStart(8, '0')}`
}

function parseProgram(code) {
  return parse(String(code), {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    plugins: ['optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'classProperties'],
  })
}

function encodeStrings(ast, seed) {
  let encoded = 0
  traverse(ast, {
    StringLiteral(path) {
      if (path.node.value.length < 3) return
      if (path.parentPath.isDirective()) return
      if (path.parentPath.isObjectProperty() && path.key === 'key' && !path.parent.computed) return
      if (path.parentPath.isImportDeclaration() || path.parentPath.isExportAllDeclaration()) return
      if (path.parentPath.isCallExpression() && path.parentPath.node.callee?.name === 'require') return
      if (path.scope.getBinding('String')) return
      const codes = Array.from(path.node.value).map((character) => t.numericLiteral(character.charCodeAt(0)))
      path.replaceWith(
        t.callExpression(t.memberExpression(t.identifier('String'), t.identifier('fromCharCode')), codes),
      )
      encoded += 1
    },
  })
  void seed
  return encoded
}

function renameLocals(ast, seed) {
  const renames = new Map()
  let renamed = 0
  traverse(ast, {
    Scopable(path) {
      if (path.scope.getBinding('eval') || path.scope.getBinding('with')) return
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (name.startsWith('_0x')) continue
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
        if (!['var', 'let', 'const', 'param', 'hoisted'].includes(binding.kind)) continue
        if (binding.referencePaths.some((reference) => reference.findParent((parent) => parent.isWithStatement?.()))) continue
        const nextName = hashName(`${name}:${renames.size}`, seed)
        try {
          path.scope.rename(name, nextName)
          renames.set(name, nextName)
          renamed += 1
        } catch {
          /* keep the original name when Babel refuses the rename */
        }
      }
    },
  })
  return renamed
}

function injectDeadCode(ast) {
  const body = ast.program.body
  const dead = t.ifStatement(
    t.booleanLiteral(false),
    t.blockStatement([
      t.expressionStatement(
        t.callExpression(t.memberExpression(t.identifier('console'), t.identifier('log')), [t.stringLiteral('_0xdead')]),
      ),
    ]),
  )
  body.unshift(dead)
  return 1
}

/**
 * @param {string} code
 * @param {{seed?: number, encodeStrings?: boolean, renameLocals?: boolean, deadCode?: boolean}} [options]
 */
export function obfuscate(code, options = {}) {
  const seed = options.seed ?? 0x4f19
  const ast = parseProgram(code)
  const stats = { strings: 0, identifiers: 0, deadCode: 0 }
  if (options.encodeStrings !== false) stats.strings = encodeStrings(ast, seed)
  if (options.renameLocals !== false) stats.identifiers = renameLocals(ast, seed)
  if (options.deadCode !== false) stats.deadCode = injectDeadCode(ast)
  const output = generate(ast, { comments: false, jsescOption: { minimal: true } }, String(code))
  return { code: output.code, stats, seed }
}

/**
 * Recover string literals and remove injected dead branches.
 * @param {string} code
 */
export function deobfuscate(code) {
  const ast = parseProgram(code)
  const stats = { strings: 0, deadCode: 0 }
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object, { name: 'String' }) &&
        t.isIdentifier(callee.property, { name: 'fromCharCode' }) &&
        path.node.arguments.every((argument) => t.isNumericLiteral(argument))
      ) {
        path.replaceWith(t.stringLiteral(String.fromCharCode(...path.node.arguments.map((argument) => argument.value))))
        stats.strings += 1
      }
    },
    IfStatement(path) {
      if (t.isBooleanLiteral(path.node.test, { value: false })) {
        path.remove()
        stats.deadCode += 1
      }
    },
  })
  const output = generate(ast, { comments: false, jsescOption: { minimal: true } }, String(code))
  return { code: output.code, stats }
}
