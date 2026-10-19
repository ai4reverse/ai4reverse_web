#!/usr/bin/env node
/**
 * Hook walkthrough: run the network C2 sample with
 *   - a traceless API mock (sendBeacon is answered locally),
 *   - a synthetic network route (fetch gets a realistic JSON response),
 *   - observation hooks for suspicious code, caught/uncaught exceptions,
 *   - and a full audit of what fired.
 *
 * Run: node examples/hooks-demo.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { TracelessSandbox } from '../tools/index.js'

const file = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))
const source = await readFile(file('network-c2.js'), 'utf8')

const fired = []
const exceptions = []
const suspicious = []

const sandbox = await TracelessSandbox.create({
  seed: 21,
  logLevel: 'silent',
  env: { strict: true },
  hooks: [
    {
      phase: 'api:before',
      priority: 100,
      owner: 'examples',
      handler(payload) {
        if (payload.api === 'navigator.sendBeacon') {
          fired.push({ api: payload.api, action: 'mocked', args: payload.args })
          return { block: true }
        }
        if (payload.api === 'document.write') {
          fired.push({ api: payload.api, action: 'blocked' })
          return { block: undefined }
        }
        return undefined
      },
    },
    {
      phase: 'exception:uncaught',
      owner: 'examples',
      handler(payload) {
        exceptions.push({ origin: payload.origin, name: payload.error?.name, message: payload.error?.message })
      },
    },
    {
      phase: 'exception:catch',
      owner: 'examples',
      handler(payload) {
        exceptions.push({ origin: 'catch', name: payload.error?.name, message: payload.error?.message })
      },
    },
    {
      phase: 'code:before',
      owner: 'examples',
      handler(payload) {
        const source = typeof payload === 'string' ? payload : payload?.source ?? ''
        for (const pattern of ['webdriver', 'phantom', 'debugger', 'Function(']) {
          if (source.includes(pattern)) suspicious.push(pattern)
        }
        return undefined
      },
    },
  ],
})

try {
  const run = await sandbox.run(source, {
    filename: 'https://cdn.example.test/assets/c2.js',
    network: {
      policy: 'deny',
      routes: [
        {
          match: 'c2.example.test/beacon',
          response: {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            bodyText: '{"ok":true,"command":"none"}',
          },
        },
      ],
    },
  })

  console.log('run ok:', run.ok, '| error:', run.error?.message ?? 'none')
  console.log('network events:')
  for (const event of (run.events ?? []).filter((item) => item.kind === 'net')) {
    console.log(`  ${event.method ?? '?'} ${event.url} -> ${event.status} ${event.error ?? ''}`)
  }
  console.log('network IOCs:', (run.events ?? []).filter((event) => event.kind === 'ioc').map((event) => event.value))
  console.log('hooks fired:', fired)
  console.log('caught/uncaught exceptions:', exceptions)
  console.log('suspicious patterns observed:', [...new Set(suspicious)])
  console.log('mock audit:', run.hooks.fired)
  console.log('trace counts:', run.traceStats.byKind)
  console.log('integrity intact:', run.integrity.intact)
  console.log('disposal ok:', run.disposal.ok)
} finally {
  sandbox.dispose()
}
