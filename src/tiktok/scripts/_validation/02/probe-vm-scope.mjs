#!/usr/bin/env node
/**
 * Probe: build the VM scope without running the target.
 *
 * The whole interpreter — helpers J..Y, the 365-entry handler table C, the
 * bytecode O, the string table T, the memo S and decoder m — lives in one
 * function expression that ends with `Y(0, void 0, l, [], 0, 14)`, the target's
 * bootstrap. Replacing only that call with a capture of the scope lets the
 * validator use the real handler source as its bytecode oracle while the
 * bootstrap never runs.
 *
 * Read-only; prints a few sanity facts.
 *
 *   node src/tiktok/scripts/_validation/02/probe-vm-scope.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const INPUT = path.join(REPO, 'src/tiktok/resources/mssdk.min.js')
const source = fs.readFileSync(INPUT, 'utf8')

const BOOT = 'Y(0,void 0,l,[],0,14)'
const at = source.lastIndexOf(BOOT)
if (at < 0) throw new Error('bootstrap call not found')

const capture =
  'globalThis.__vm = { J, L, K, N, U, j, P, x, G, H, Y, B, C, O, T, S, m, l }'
const patched = source.slice(0, at) + capture + source.slice(at + BOOT.length)

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  atob,
  btoa,
  TextDecoder,
  Uint8Array,
  Uint16Array,
  Int32Array,
  Math,
  JSON,
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,
})
vm.runInContext(patched, context, { filename: 'mssdk.min.js' })

const v = context.__vm
console.log('captured keys      ', Object.keys(v).join(','))
console.log('handlers           ', v.C.length)
console.log('bytecode bytes     ', v.O.length)
console.log('string table       ', v.T.length)
console.log('B is object        ', typeof v.B, Object.keys(v.B).length === 0)
console.log('l === globalThis   ', v.l === context)

// A string the lift inlines as `ReferenceError`: decode with the bundle's own m.
const idx = 63
const keyIdx = 1
console.log('T[63]              ', v.T[idx])
console.log('m(T[63],T[1])      ', JSON.stringify(v.m(v.T[idx], v.T[keyIdx])))
console.log('J/L/K/U/x typeof   ', [v.J, v.L, v.K, v.U, v.x].map((f) => typeof f).join(','))
