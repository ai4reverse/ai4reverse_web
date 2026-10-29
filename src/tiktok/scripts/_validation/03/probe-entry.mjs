#!/usr/bin/env node
/**
 * Locate the *actual* entry function the sandbox calls, and the code region that
 * owns the SHA-256 IV table. Read-only probes; runs go through the CLI.
 *
 *   node src/tiktok/scripts/_validation/03/probe-entry.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { WORK, GATE, runSide } from './lib.mjs'

const PROBE = `
function __run(){
  try{
    var ac = (typeof byted_acrawler!=='undefined'&&byted_acrawler) || (typeof window!=='undefined'&&window.byted_acrawler);
    if(!ac) return JSON.stringify({error:'no acrawler'});
    return JSON.stringify({
      acKeys: Object.keys(ac),
      fs: String(ac.frontierSign).slice(0, 400),
      init: String(ac.init).slice(0, 300),
      fsName: ac.frontierSign.name,
      initName: ac.init.name,
    });
  }catch(e){ return JSON.stringify({error:(e&&e.name)+': '+(e&&e.message), stack:String(e&&e.stack)}); }
}
`

for (const [label, file] of [['original', 'snapshot-original.js'], ['decompiled', 'snapshot-decompiled.min.js']]) {
  const side = runSide(path.join(WORK, file), PROBE, { outFile: path.join(WORK, `entry-${label}.js`), seed: GATE.seed })
  console.log(`== ${label} ok=${side.ok}`)
  console.log(side.value)
}

// Which function encloses the SHA-256 IV table in the original?
const src = fs.readFileSync(path.join(WORK, 'snapshot-original.js'), 'utf8')
const at = src.indexOf('1779033703')
let fn = src.lastIndexOf('function', at)
console.log('\n== original SHA-256 region ==')
console.log('IV at', at, 'nearest function keyword at', fn)
console.log(src.slice(Math.max(0, at - 900), at + 500))
