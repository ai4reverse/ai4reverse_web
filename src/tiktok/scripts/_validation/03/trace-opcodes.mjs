#!/usr/bin/env node
/**
 * Dynamically recover which VM opcodes the frozen gate call actually executes.
 *
 * The interpreter dispatches `C[f](u)` where `f` is a big-endian u16 read from
 * the bytecode. A tracing copy of the snapshot increments a per-opcode counter
 * at that exact site; the wrapper then reports the nonzero entries. This is the
 * only trustworthy source of "is this code on the gate's path" — static
 * reachability cannot answer it.
 *
 *   node src/tiktok/scripts/_validation/03/trace-opcodes.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { WORK, GATE, runSide } from './lib.mjs'

const ORIG = path.join(WORK, 'snapshot-original.js')
const source = fs.readFileSync(ORIG, 'utf8')

const DISPATCH = 'try{C[f](u)}catch(n){'
// `u.u` has already advanced past the two opcode bytes, so the instruction's
// start is `u.u - 2`. Record both the opcode and the exact PC that ran: opcode
// counts alone do not say *which* instruction of that opcode executed.
const TRACED =
  'try{(globalThis.__ops=globalThis.__ops||new Uint32Array(365))[f]++;' +
  '(globalThis.__pc=globalThis.__pc||new Uint8Array(98961))[u.u-2]=1;C[f](u)}catch(n){'
if (!source.includes(DISPATCH)) throw new Error('dispatch site not found')
const traced = source.replace(DISPATCH, TRACED)

const WRAPPER = `
function __run(){
  try{
    var ac = (typeof byted_acrawler!=='undefined'&&byted_acrawler) || (typeof window!=='undefined'&&window.byted_acrawler);
    if(!ac) return JSON.stringify({error:'no acrawler', boot:(globalThis.__bootError||'none')});
    ac.init({aid:1233});
    var sig = ac.frontierSign({url:'https://www.tiktok.com/api/'});
    var ops = globalThis.__ops || [];
    var used = [];
    for (var i=0;i<ops.length;i++) if (ops[i]) used.push([i, ops[i]]);
    var pcs = [];
    var pc = globalThis.__pc || [];
    for (var j=0;j<pc.length;j++) if (pc[j]) pcs.push(j);
    return JSON.stringify({sig:sig, used:used, pcCount:pcs.length, pcSample:pcs.slice(0,120)});
  }catch(e){ return JSON.stringify({error:(e&&e.name)+': '+(e&&e.message), stack:String(e&&e.stack)}); }
}
`

const tracedFile = path.join(WORK, 'traced-original.js')
fs.writeFileSync(tracedFile, traced)

const side = runSide(tracedFile, WRAPPER, { outFile: path.join(WORK, 'traced-run.js'), seed: GATE.seed, timeout: 60000 })
console.log('ok', side.ok, 'exit', side.exit)
console.log('value head:', String(side.value).slice(0, 300))

let payload = null
try { payload = JSON.parse(side.value) } catch { payload = null }
if (payload && payload.used) {
  const used = payload.used
  const pcs = payload.pcSample ?? []
  fs.writeFileSync(path.join(WORK, 'opcode-coverage.json'), JSON.stringify({
    gateInput: GATE,
    sig: payload.sig,
    opcodesUsed: used.length,
    totalHandlers: 365,
    instructionsExecuted: payload.pcCount,
    totalInstructions: 8515,
    counts: Object.fromEntries(used),
    pcSample: pcs,
  }, null, 2))
  console.log('opcodes used:', used.length, '/ 365')
  console.log('instructions executed:', payload.pcCount, '/ 8515')
  console.log('top:', used.sort((a, b) => b[1] - a[1]).slice(0, 15))
} else {
  console.log('no coverage payload')
}
