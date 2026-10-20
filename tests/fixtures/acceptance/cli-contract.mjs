import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const dir = '/tmp/pi/01a1597d-73d6-7696-a150-4fa6e050d798/verify'
function require_hash(p){ try { return JSON.stringify(p).slice(0,60)+':'+JSON.stringify(p).length } catch { return null } }
const cli = (args) => {
  try {
    return { code: 0, stdout: execFileSync('node', ['tools/cli.js', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: (e.stderr ?? '').split('\n').slice(0, 2).join(' | ') }
  }
}

// seed spelling: default vs explicit 0x5eed
const a = JSON.parse(cli(['analyze', 'examples/benign.js', '--json']).stdout)
const b = JSON.parse(cli(['analyze', 'examples/benign.js', '--json', '--seed', '0x5eed']).stdout)
const pick = (r) => ({ seed: r.meta?.seed, profileHash: require_hash(r.meta?.profile), ua: r.meta?.profile?.navigator?.userAgent ?? r.meta?.profile?.userAgent })
console.log('seed-default-vs-explicit', JSON.stringify({ default: pick(a), explicit: pick(b) }))

// analyze exit code on a throwing sample
const throwFile = `${dir}/throwing.js`
writeFileSync(throwFile, `throw new Error('guest-boom')\n`)
const runRes = cli(['run', throwFile])
const analyzeRes = cli(['analyze', throwFile, '--no-restore'])
console.log('throwing', JSON.stringify({ run: { code: runRes.code, stderr: runRes.stderr }, analyze: { code: analyzeRes.code, stderr: analyzeRes.stderr } }))

// --events outside run
const ev = cli(['analyze', 'examples/benign.js', '--events', '--json', '--no-dynamic'])
console.log('events-analyze', JSON.stringify({ code: ev.code, stderr: ev.stderr }))
const evRestore = cli(['restore', 'examples/benign.js', '--events'])
console.log('events-restore', JSON.stringify({ code: evRestore.code, stderr: evRestore.stderr }))

// no-args
const none = cli([])
console.log('no-args', JSON.stringify({ code: none.code, firstLine: (none.stdout || '').split('\n')[0] }))
