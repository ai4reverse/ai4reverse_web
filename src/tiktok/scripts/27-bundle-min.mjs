#!/usr/bin/env node
/**
 * Emit a compact, execution-only twin of `output/final.js`.
 *
 * The readable artifact is 7.5 MB: comments, one instruction per line, and
 * names chosen for a human. That size is fine for reading and fatal for
 * execution here — the QuickJS sandbox aborts while evaluating it, before any
 * code runs, so the differential test never gets a first instruction.
 *
 * This stage produces the same program in compact form, with comments dropped
 * and whitespace collapsed, purely so the equivalence harness has something it
 * can load. It is a twin, not a replacement: `final.js` stays the deliverable
 * and `runnable.min.js` is only ever executed, never read.
 *
 * The program text is parsed and re-generated; if that round trip fails the
 * stage refuses rather than emitting a file that might differ.
 *
 *   node scripts/27-bundle-min.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _generate from '@babel/generator'

const generate = _generate.default ?? _generate

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'output')

const runtime = `var __state={A:[],M:[],I:[],o:null,S:14,u:0};
function __cellValue(s){return s&&typeof s==='object'&&'v' in s?s.v:s}
function __upvalue(f,d,i){if(i===undefined){i=d;d=1}for(var k=0;k<d&&f;k++)f=f.o;return f?__cellValue(f.A[i]):void 0}
function __setUpvalue(f,d,i,v){if(arguments.length===3){v=i;i=d;d=1}for(var k=0;k<d&&f;k++)f=f.o;if(!f)throw new Error('__setUpvalue: no frame');f.A[i]=f.A[i]&&typeof f.A[i]==='object'?Object.assign(f.A[i],{v:v}):v;return v}
function __native(o,a){throw new Error('unlifted opcode '+o+' ('+String(a)+')')}
`

// The decompiled functions reference the bundle's module scope (the UMD
// variables, the string table `T`, its memo `S` and the decoder `m`). Those
// live outside every function, so they are recovered separately by
// `28-module-scope.mjs` and prepended when present. Without them the program
// throws `ReferenceError` on its second call.
const moduleScopePath = path.join(OUT, 'module-scope.js')
const moduleScope = fs.existsSync(moduleScopePath) ? fs.readFileSync(moduleScopePath, 'utf8') : ''

const source = fs.readFileSync(path.join(OUT, 'final.js'), 'utf8')
const ast = parse(source, { sourceType: 'script' })
const code = generate(ast, { comments: false, compact: true, minified: true }).code
const bootstrap = ';try{fn_0(void 0,[])}catch(e){globalThis.__bootError=String(e&&e.stack||e)}'

const bundleAst = parse(`${moduleScope}${runtime}${code}${bootstrap}`, { sourceType: 'script' })
const outCode = generate(bundleAst, { comments: false, compact: true, minified: true }).code
fs.writeFileSync(path.join(OUT, 'runnable.min.js'), outCode)
const bytes = fs.statSync(path.join(OUT, 'runnable.min.js')).size

console.log(`readable bytes    ${source.length}`)
console.log(`module scope      ${moduleScope.length} bytes`)
console.log(`compact bytes     ${bytes}  (${((bytes / source.length) * 100).toFixed(1)}% of readable)`)
console.log(`output            ${path.join(OUT, 'runnable.min.js')}`)
