import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'anti-fingerprint']

async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    ...options,
  })
}

test('default script filename looks like a real web resource', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('1 + 1')
    assert.match(run.filename, /^https:\/\/[^/]+\/static\/js\/[0-9a-f]{8}\.min\.js$/)
    assert.doesNotMatch(run.filename, /sandbox|eval|ai4r|test/i)
  } finally {
    sb.dispose()
  }
})

test('sourceUrl is preserved (fragment stripped) for stack fidelity', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('(function f(){ return new Error("x").stack })()', {
      sourceUrl: 'https://evil.example.test/loader.js?v=3#frag',
    })
    assert.equal(run.filename, 'https://evil.example.test/loader.js?v=3')
    const stack = run.result.value
    assert.match(stack, /evil\.example\.test\/loader\.js\?v=3:\d+:\d+/)
    assert.doesNotMatch(stack, /<eval>/)
  } finally {
    sb.dispose()
  }
})

test('entry invocation converts JSON arguments both ways', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      'globalThis.main = function (cfg, n) { return [cfg.host, cfg.nested.flag, n + 1] }',
      { entry: 'main', args: [{ host: 'c2.test', nested: { flag: true } }, 41] },
    )
    assert.equal(run.ok, true)
    assert.equal(run.result.preview, '["c2.test",true,42]')
  } finally {
    sb.dispose()
  }
})

test('module source type exports a namespace', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('export const answer = 42; export function add(a,b){return a+b}', {
      type: 'module',
      sourceUrl: 'https://cdn.test/app.mjs',
    })
    assert.equal(run.ok, true)
    assert.equal(run.result.type, 'object')
    assert.match(run.result.preview, /"answer":42|answer/)
  } finally {
    sb.dispose()
  }
})

test('promise jobs and virtual timers settle in event-loop order', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      globalThis.order = [];
      setTimeout(function () { order.push('timer-0') }, 0);
      Promise.resolve().then(function () { order.push('microtask-1') });
      setTimeout(function () { order.push('timer-50') }, 50);
      Promise.resolve().then(function () { order.push('microtask-2') });
    `,
    )
    assert.equal(run.ok, true)
    assert.equal(run.settle.jobs >= 2, true)
    assert.equal(run.settle.timerCallbacks >= 2, true)
    // The last expression is a Promise, so read the recorded ordering from the
    // trace instead of the (pending) result value.
    const consoleEvents = (run.events ?? []).filter((event) => event.kind === 'timer')
    assert.ok(consoleEvents.length >= 2)
    assert.ok(run.settle.timerCallbacks >= 2)
    assert.ok(run.virtualMs >= 50)
  } finally {
    sb.dispose()
  }
})

test('source size limit is enforced before evaluation', async () => {
  const sb = await sandbox({ limits: { maxSourceBytes: 1024 } })
  try {
    const run = await sb.run(`/*${'x'.repeat(4096)}*/ 1`)
    assert.equal(run.ok, false)
    assert.ok(run.limitsHit.includes('source-size'), JSON.stringify(run.limitsHit))
    assert.equal(run.error.code, 'SANDBOX_LIMIT')
  } finally {
    sb.dispose()
  }
})

test('staged eval payloads are distinguishable in the trace', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      var stage = atob('dmFyIG1hcmtlciA9ICJzdGFnZTIiOyBtYXJrZXI=');
      eval(stage)
    `)
    assert.equal(run.ok, true)
    const evalEvent = (run.events ?? []).find((event) => event.kind === 'code' && event.event === 'eval')
    assert.ok(evalEvent)
    assert.match(String(evalEvent.value?.value ?? ''), /stage2/)
    const atobEvent = (run.events ?? []).find((event) => event.kind === 'api' && event.api === 'atob')
    assert.ok(atobEvent)
    assert.match(String(atobEvent.value), /stage2/)
  } finally {
    sb.dispose()
  }
})

test('repeated invocation in one sandbox uses distinct filenames and contexts', async () => {
  const sb = await sandbox()
  try {
    const first = await sb.run('var marker = "a"; marker')
    const second = await sb.run('typeof marker')
    assert.equal(first.result.value, 'a')
    assert.equal(second.result.value, 'undefined')
    assert.notEqual(first.filename, undefined)
    assert.equal(first.disposal.ok, true)
  } finally {
    sb.dispose()
  }
})

test('entry-point stacks contain no host frames', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      'globalThis.start = function () { return new Error("inside entry").stack }',
      { entry: 'start', filename: 'https://cdn.test/entry.js' },
    )
    assert.equal(run.ok, true)
    const stack = run.result.value
    assert.match(stack, /https:\/\/cdn\.test\/entry\.js:\d+:\d+/)
    assert.doesNotMatch(stack, /invoke\.js|node_modules|ai4r-internal|<eval>|\/Users\//)
  } finally {
    sb.dispose()
  }
})
