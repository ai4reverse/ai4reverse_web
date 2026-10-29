#!/usr/bin/env node
/**
 * Build a marker-instrumented twin of `output/runnable.min.js` so a sandbox
 * stack trace can be bisected to a single statement.
 *
 * Every top-level statement of the chosen function gets a leading
 * `globalThis.__mark = "<index>:<source snippet>";` probe, so the last marker
 * observed identifies the statement that threw.
 *
 * The file reuses the exact preamble and bootstrap of `27-bundle-min.mjs`, so
 * the instrumented program differs from the shipped twin only by the probes.
 *
 *   node src/tiktok/scripts/dbg-mark.mjs <fnName> [outFile]
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'

const generate = _generate.default ?? _generate
const traverse = _traverse.default ?? _traverse

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'output')
const WORK = path.join(ROOT, 'work', '06-boot')

const argv = process.argv.slice(2)
const scopeIndex = argv.indexOf('--scope')
/** Extra module-scope text, for testing a suspected gap in the fragment. */
const scopePrefix = scopeIndex >= 0 ? argv[scopeIndex + 1] : null
const scopeFileIndex = argv.indexOf('--scope-file')
/** Alternative module-scope fragment (an experimental copy, never the artifact). */
const scopeFile = scopeFileIndex >= 0 ? argv[scopeFileIndex + 1] : null
const positional = argv.filter(
  (arg, index) => !arg.startsWith('--') && index !== scopeIndex + 1 && index !== scopeFileIndex + 1,
)
const fnName = positional[0] ?? 'fn_3'
const dump = argv.includes('--dump')
// `tools/cli.js run` serves a stale program for a path it has already seen in
// this process tree, so every build gets a fresh path.
const outFile = positional[1] ?? path.join(WORK, `dbg-${fnName}-${Date.now().toString(36)}.js`)

const runtime = `var __state={A:[],M:[],I:[],o:null,S:14,u:0};
function __cellValue(s){return s&&typeof s==='object'&&'v' in s?s.v:s}
function __upvalue(f,d,i){if(i===undefined){i=d;d=1}for(var k=0;k<d&&f;k++)f=f.o;return f?__cellValue(f.A[i]):void 0}
function __setUpvalue(f,d,i,v){if(arguments.length===3){v=i;i=d;d=1}for(var k=0;k<d&&f;k++)f=f.o;if(!f)throw new Error('__setUpvalue: no frame');f.A[i]=f.A[i]&&typeof f.A[i]==='object'?Object.assign(f.A[i],{v:v}):v;return v}
function __native(o,a){throw new Error('unlifted opcode '+o+' ('+String(a)+')')}
`

const moduleScopePath = path.join(OUT, 'module-scope.js')
const moduleScopeBase = fs.readFileSync(scopeFile ?? moduleScopePath, 'utf8')
const moduleScope = scopePrefix ? `${scopePrefix}\n${moduleScopeBase}` : moduleScopeBase

const source = fs.readFileSync(path.join(OUT, 'final.js'), 'utf8')
const ast = parse(source, { sourceType: 'script' })

// A comma expression at statement level is a sequence of effects in source
// order, so splitting it into separate statements is behaviour-preserving and
// gives the bisect one probe per effect instead of one per 200-line statement.
const splitSequence = (statement) => {
  if (!t.isExpressionStatement(statement) || !t.isSequenceExpression(statement.expression)) return [statement]
  return statement.expression.expressions.map((expression) => t.expressionStatement(expression))
}

let instrumented = 0
traverse(ast, {
  FunctionDeclaration(nodePath) {
    if (nodePath.node.id?.name !== fnName) return
    if (dump) {
      nodePath.node.body.body.forEach((statement, index) => {
        const text = generate(statement, { comments: false }).code.replace(/\s+/g, ' ')
        console.log(`${index}\t${statement.type}\t${t.isExpressionStatement(statement) ? statement.expression.type : '-'}\t${text.length}\t${text.slice(0, 70)}`)
      })
      nodePath.stop()
      return
    }
    const body = nodePath.node.body.body.flatMap(splitSequence)
    const next = []
    body.forEach((statement, index) => {
      if (!t.isStatement(statement)) {
        next.push(statement)
        return
      }
      const text = generate(statement, { comments: false }).code.replace(/\s+/g, ' ').slice(0, 90)
      next.push(
        t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(t.identifier('globalThis'), t.identifier('__mark')),
            t.stringLiteral(`P${index}: ${text}`),
          ),
        ),
        statement,
      )
      instrumented += 1
    })
    nodePath.node.body.body = next
    nodePath.stop()
  },
})

const code = generate(ast, { comments: false, compact: true, minified: true }).code
const bootstrap =
  ';try{fn_0(void 0,[])}catch(e){globalThis.__bootError=String(e&&e.stack||e);' +
  'globalThis.__bootMsg=String((e&&e.name)+": "+(e&&e.message))}'
const probe =
  ';function __probe(){try{return JSON.stringify({mark:globalThis.__mark||null,' +
  'msg:globalThis.__bootMsg||null,boot:globalThis.__bootError||null})}catch(e){return String(e)}}'

const bundle = `${moduleScope}${runtime}${code}${bootstrap}${probe}`
const bundleAst = parse(bundle, { sourceType: 'script' })
const outCode = generate(bundleAst, { comments: false, compact: true, minified: true }).code

fs.mkdirSync(WORK, { recursive: true })
fs.writeFileSync(outFile, outCode)
console.log(`function        ${fnName}`)
console.log(`probes          ${instrumented}`)
console.log(`bytes           ${outCode.length}`)
console.log(`output          ${outFile}`)
