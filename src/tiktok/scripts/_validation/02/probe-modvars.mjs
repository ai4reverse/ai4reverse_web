#!/usr/bin/env node
/** Print the module-scope bindings captured from the bundle's VM closure. */
import fs from 'node:fs'
import path from 'node:path'
import { loadVm } from '../../../../tiktok/validation/02-semantics/interp.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const v = loadVm(fs.readFileSync(path.join(REPO, 'src/tiktok/resources/mssdk.min.js'), 'utf8'))

console.log('captured keys:', Object.keys(v).join(','))
const names = ['k', 't', 'r', 'i', 'o', 'e', 'u', 'f', 'c', 'a', 'v', 's', 'd', 'h', 'w', 'g', 'A', 'I', 'p', 'Q', 'M', 'y', 'E', 'b', 'n', 'l']
for (const name of names) {
  const val = v[name]
  const shown = Array.isArray(val)
    ? `array[${val.length}]`
    : typeof val === 'string'
      ? JSON.stringify(val.slice(0, 28))
      : String(val).slice(0, 48)
  console.log(name.padEnd(3), typeof val, shown)
}
