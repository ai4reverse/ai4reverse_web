#!/usr/bin/env node
/**
 * V2 equivalence harness: run the original and the decompiled program under the
 * same seeded sandbox and compare their outputs byte-for-byte.
 *
 * Why the sandbox and not a browser: the SDK's signature depends on the wall
 * clock, on `Math.random` and on an internal call counter, so two calls in a
 * real browser never agree — the Chrome harness measured five distinct X-Bogus
 * values for five identical calls. The repo sandbox seeds the clock and the
 * PRNG, which makes the same script deterministic: three consecutive runs
 * produced the identical X-Bogus. Determinism is the prerequisite for a
 * byte-exact gate, so the gate runs here and the browser is used only to
 * confirm the API surface.
 *
 * Both sides are executed through `tools/cli.js run` — never with a bare
 * `node` — because the target is untrusted and the sandbox is what contains it.
 *
 * Writes `src/tiktok/work/08-verify/verify-report.md` and prints a verdict.
 *
 *   node scripts/29-verify.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const VERIFY = path.join(ROOT, 'work', '08-verify')
const CLI = path.join(REPO, 'tools', 'cli.js')

const SEED = '0x5eed'
const CASES = ['seed 0x5eed']

/**
 * The wrapper appended to each side so both expose the same entry point.
 *
 * The catch reports the guest stack and the shape of `byted_acrawler` as well as
 * the message: once the bootstrap stopped throwing, the only failure left was
 * inside `init`, and a bare "TypeError" threw the stack away.
 */
const WRAPPER = `
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

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

/** Build a runnable file for one side and execute it in the sandbox. */
function runSide(label, bodyFile, outFile) {
  const body = fs.readFileSync(bodyFile, 'utf8')
  const composed = body + WRAPPER
  fs.mkdirSync(VERIFY, { recursive: true })
  fs.writeFileSync(outFile, composed)

  const result = spawnSync(
    process.execPath,
    [CLI, 'run', outFile, '--json', '--timeout', '60000', '--seed', SEED, '--entry', '__run'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 },
  )

  const start = result.stdout.indexOf('{')
  let parsed = null
  if (start >= 0) {
    try {
      parsed = JSON.parse(result.stdout.slice(start))
    } catch {
      parsed = null
    }
  }
  const value = parsed?.result?.value ?? parsed?.error?.message ?? null
  return {
    label,
    file: path.relative(REPO, outFile),
    sha256: sha256(composed),
    ok: parsed?.ok ?? false,
    value,
    raw: value,
  }
}

const original = runSide('original', path.join(ROOT, 'resources', 'mssdk.min.js'), path.join(VERIFY, 'original-run.js'))
const decompiled = runSide('decompiled', path.join(ROOT, 'output', 'runnable.min.js'), path.join(VERIFY, 'decompiled-run.js'))

const matched = original.value !== null && original.value === decompiled.value
const originalSig = (() => {
  try {
    return JSON.parse(original.value)?.sig ?? null
  } catch {
    return null
  }
})()
const decompiledSig = (() => {
  try {
    return JSON.parse(decompiled.value)?.sig ?? null
  } catch {
    return null
  }
})()

const verdict = matched ? 'PASS' : 'FAIL'

const md = [
  '# 等价性验收报告（V2）',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  `| 目标 | \`src/tiktok/resources/mssdk.min.js\` |`,
  `| 用例 | ${CASES.join(', ')} |`,
  `| 环境 | 仓库沙箱，\`--seed ${SEED}\`（固定 Math.random 与时间源） |`,
  `| 原 VM | \`${original.file}\` sha256 \`${original.sha256.slice(0, 16)}\` |`,
  `| 自实现 | \`${decompiled.file}\` sha256 \`${decompiled.sha256.slice(0, 16)}\` |`,
  '',
  '## 结果',
  '',
  '| 侧 | sandbox ok | 输出 |',
  '| --- | --- | --- |',
  `| 原 VM | ${original.ok} | \`${original.value ?? '(null)'}\` |`,
  `| 自实现 | ${decompiled.ok} | \`${decompiled.value ?? '(null)'}\` |`,
  '',
  `逐字节一致：**${matched ? '是' : '否'}**`,
  '',
  '## 判定',
  '',
  matched
    ? `**PASS** — \`${JSON.stringify(originalSig)}\` 两侧完全相同。`
    : '**FAIL** — 两侧输出不同，见上表。差异定位应回到 M1 trace 或 O1 定位（漏掉的模块作用域）。',
  '',
  '## 环境说明',
  '',
  '- 真 Chrome 中同一调用连续 5 次得到 5 个不同 X-Bogus（时间 + RNG + 内部调用计数器），',
  '  因此字节级对拍只在固定种子的沙箱中进行；Chrome 只用于确认 API 面与行为形状。',
  '- 每一侧都通过 `tools/cli.js run` 执行，目标代码从不以裸 `node` 运行。',
  '',
].join('\n')

fs.mkdirSync(VERIFY, { recursive: true })
fs.writeFileSync(path.join(VERIFY, 'verify-report.md'), md)

console.log(`original    ${original.ok ? 'ok' : 'ERR'}  ${original.value ?? '(null)'}`)
console.log(`decompiled  ${decompiled.ok ? 'ok' : 'ERR'}  ${decompiled.value ?? '(null)'}`)
console.log(`match       ${matched ? 'YES' : 'NO'}`)
console.log(`verdict     ${verdict}`)
console.log(`report      ${path.join(VERIFY, 'verify-report.md')}`)
process.exit(matched ? 0 : 1)
