/**
 * Shared helpers for the oracle-mutation study (Agent 3).
 *
 * Everything here runs the *untrusted* sample only through `tools/cli.js run`;
 * nothing executes sample code in this host process.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

export const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
export const TIKTOK = path.resolve(REPO, 'src', 'tiktok')
export const ORIGINAL = path.join(TIKTOK, 'resources', 'mssdk.min.js')
export const DECOMPILED = path.join(TIKTOK, 'output', 'runnable.min.js')
export const OUT_DIR = path.join(TIKTOK, 'validation', '03-oracle')
export const WORK = path.join(OUT_DIR, 'work')
export const CLI = path.join(REPO, 'tools', 'cli.js')

/** Frozen word from 29-verify.mjs: the one and only gate input. */
export const GATE = { seed: '0x5eed', aid: 1233, url: 'https://www.tiktok.com/api/', times: 1 }

/**
 * Verbatim wrapper from 29-verify.mjs. The gate predicate is reproduced with
 * this exact text so the comparison is the same one the real gate makes.
 */
export const GATE_WRAPPER = `
function __run(){
  try{
    var ac = (typeof byted_acrawler!=='undefined'&&byted_acrawler) || (typeof window!=='undefined'&&window.byted_acrawler);
    if(!ac) return JSON.stringify({error:'no acrawler', boot:(globalThis.__bootError||'none')});
    ac.init({aid:1233});
    var sig = ac.frontierSign({url:'https://www.tiktok.com/api/'});
    return JSON.stringify({sig:sig});
  }catch(e){
    var keys = [];
    try { keys = (typeof byted_acrawler==='object' && byted_acrawler) ? Object.keys(byted_acrawler) : []; } catch (_) {}
    return JSON.stringify({
      error:(e&&e.name)+': '+(e&&e.message),
      stack:String(e&&e.stack),
      acType:typeof byted_acrawler,
      acKeys:keys,
      initType:(typeof byted_acrawler==='object'&&byted_acrawler)?typeof byted_acrawler.init:'n/a',
      boot:(globalThis.__bootError||'none')
    });
  }
}
`

/**
 * Configurable wrapper for the extended matrix. Mirrors GATE_WRAPPER's shape
 * but takes `{aid,url,times}` so one artifact can be observed on many inputs.
 */
export const MATRIX_WRAPPER = `
function __run(cfg){
  cfg = cfg || {};
  var aid = (cfg.aid === undefined) ? 1233 : cfg.aid;
  var url = cfg.url || 'https://www.tiktok.com/api/';
  var times = cfg.times || 1;
  try{
    var ac = (typeof byted_acrawler!=='undefined'&&byted_acrawler) || (typeof window!=='undefined'&&window.byted_acrawler);
    if(!ac) return JSON.stringify({error:'no acrawler', boot:(globalThis.__bootError||'none')});
    ac.init({aid:aid});
    var sigs = [];
    for(var k=0;k<times;k++){ sigs.push(ac.frontierSign({url:url})); }
    return JSON.stringify({sigs:sigs});
  }catch(e){
    return JSON.stringify({error:(e&&e.name)+': '+(e&&e.message), stack:String(e&&e.stack)});
  }
}
`

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/**
 * Compose `body` + wrapper into `outFile` and execute it in the sandbox.
 * Returns the same fields 29-verify derives: `ok` and `value`.
 */
export function runSide(bodyFile, wrapper, { outFile, seed, args, level, timeout = 60000 }) {
  const body = fs.readFileSync(bodyFile, 'utf8')
  const composed = body + wrapper
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, composed)

  const argv = [CLI, 'run', outFile, '--json', '--timeout', String(timeout), '--seed', String(seed), '--entry', '__run']
  if (args !== undefined) argv.push('--arg', JSON.stringify(args))
  if (level) argv.push('--level', level)

  const result = spawnSync(process.execPath, argv, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeout + 120000,
  })
  const start = (result.stdout ?? '').indexOf('{')
  let parsed = null
  if (start >= 0) {
    try { parsed = JSON.parse(result.stdout.slice(start)) } catch { parsed = null }
  }
  const value = parsed?.result?.value ?? parsed?.error?.message ?? null
  return {
    file: path.relative(REPO, outFile),
    sha256: sha256(composed),
    ok: parsed?.ok ?? false,
    value,
    raw: value,
    exit: result.status,
    stderr: (result.stderr ?? '').trim().split('\n').slice(-3).join(' | '),
  }
}

/** The gate predicate, reproduced from 29-verify.mjs:104. */
export function gateMatched(reference, candidate) {
  return reference.value !== null && reference.value === candidate.value
}

/** Stable JSON of a run's observable payload (parsed when possible). */
export function observable(value) {
  if (value === null || value === undefined) return null
  try { return JSON.parse(value) } catch { return value }
}
