import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Declaration contract (docs/EVALUATION-TOOLS.md D9.4).
 *
 * D9.4 accepts either a JSDoc type gate or `.d.ts` declarations for the public
 * API; the project ships declarations. This test is the anti-drift gate: a
 * declaration that lists a name the runtime does not export, or that misses a
 * name the runtime does export, is a lie a consumer pays for at compile time.
 *
 * Three things are pinned:
 *  1. `types/ai4reverse.d.ts` declares exactly the value exports of the entry
 *     point (`tools/index.js`);
 *  2. every `exports` subpath carries a `types` condition that exists on disk;
 *  3. every subpath barrel's runtime exports are declared in that subpath's
 *     declaration file.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TYPES_DIR = resolve(ROOT, 'types')

/**
 * Names a `.d.ts` file exports.
 *
 * Handles the three shapes the declarations use: `export declare
 * function|const|class X`, `export interface|type X`, and
 * `export { A, B as C } from '...'` / `export type { ... } from '...'`.
 *
 * @param {string} source declaration file text
 * @returns {{values: Set<string>, types: Set<string>, all: Set<string>}}
 */
function exportedNames(source) {
  /** @type {Set<string>} */
  const values = new Set()
  /** @type {Set<string>} */
  const types = new Set()

  for (const match of source.matchAll(
    /^export\s+declare\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    values.add(match[1])
  }
  for (const match of source.matchAll(/^export\s+(?:interface|type|namespace)\s+([A-Za-z_$][\w$]*)/gm)) {
    types.add(match[1])
  }
  // `export { a, b as c } from './x.js'` — the local name is the exported one.
  // Exported *types* re-exported this way (`export { SandboxError }`) are values
  // here: the runtime name is what consumers can import.
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"][^'"]+['"])?/gm)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (!name) continue
      if (/^export\s+type\s+\{/.test(match[0])) types.add(name)
      else values.add(name)
    }
  }

  return { values, types, all: new Set([...values, ...types]) }
}

const readTypes = (file) => readFile(resolve(TYPES_DIR, file), 'utf8')

test('the entry declaration declares exactly the entry point value exports', async () => {
  const api = await import('../tools/index.js')
  const runtime = new Set(Object.keys(api).sort())
  const { values } = exportedNames(await readTypes('ai4reverse.d.ts'))

  const missing = [...runtime].filter((name) => !values.has(name))
  assert.deepEqual(missing, [], `types/ai4reverse.d.ts is missing ${missing.join(', ')}`)

  const phantom = [...values].filter((name) => !runtime.has(name))
  assert.deepEqual(phantom, [], `types/ai4reverse.d.ts declares non-existent exports: ${phantom.join(', ')}`)

  assert.ok(runtime.size >= 60, `expected the documented public surface, saw ${runtime.size}`)
})

test('every exports subpath has a types condition that exists on disk', async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.types, pkg.exports['.'].types, 'package.json "types" must match exports["."].types')

  const declarations = new Set(
    (await readdir(TYPES_DIR)).filter((file) => file.endsWith('.d.ts')),
  )

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    assert.equal(typeof entry, 'object', `exports["${subpath}"] must be a conditions object`)
    assert.equal(typeof entry.types, 'string', `exports["${subpath}"] has no types condition`)
    assert.match(entry.types, /^\.\/types\/[\w-]+\.d\.ts$/, `exports["${subpath}"].types must live in types/`)
    const file = entry.types.replace('./types/', '')
    assert.ok(declarations.has(file), `exports["${subpath}"].types points at missing types/${file}`)
    // The runtime target stays importable, and is not a declaration file.
    assert.equal(typeof entry.import, 'string', `exports["${subpath}"] has no import condition`)
    assert.doesNotMatch(entry.import, /\.d\.ts$/, `exports["${subpath}"].import must be runtime code`)
  }

  assert.ok(pkg.files.includes('types'), 'the published file set must include types/')
  await import('../types/../tools/index.js')
})

test('every subpath declaration covers its barrel module exports', async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (subpath === '.') continue
    const barrel = await import(resolve(ROOT, entry.import))
    const runtime = Object.keys(barrel)
    assert.ok(runtime.length > 0, `${subpath} (${entry.import}) exports nothing`)

    const declaration = await readFile(resolve(ROOT, entry.types), 'utf8')
    const { all } = exportedNames(declaration)
    const missing = runtime.filter((name) => !all.has(name))
    assert.deepEqual(missing, [], `${entry.types} does not declare ${missing.join(', ')} (from ${subpath})`)
  }
})

test('the declaration files are published, self-contained and parse as ES modules', async () => {
  const files = (await readdir(TYPES_DIR)).filter((file) => file.endsWith('.d.ts')).sort()
  assert.deepEqual(files, [
    'ai4reverse.d.ts',
    'analysis.d.ts',
    'cli.d.ts',
    'hook.d.ts',
    'instrumentation.d.ts',
    'invocation.d.ts',
    'jsvmp.d.ts',
    'logging.d.ts',
    'restore.d.ts',
    'sandbox.d.ts',
    'util.d.ts',
  ])

  for (const file of files) {
    const source = await readTypes(file)
    // Declaration files are ESM: no `declare module`, no `export =`.
    assert.doesNotMatch(source, /^declare module /m, `${file} must stay a module declaration`)
    assert.doesNotMatch(source, /^export = /m, `${file} must use ESM export syntax`)
    // Relative imports resolve to a sibling declaration, never to tools/.
    for (const match of source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = match[1]
      assert.match(target, /^\.\/(ai4reverse|[a-z]+)\.js$/, `${file} imports ${target}`)
      const resolved = target.replace(/^\.\//, '').replace(/\.js$/, '.d.ts')
      assert.ok(files.includes(resolved), `${file} imports missing declaration ${resolved}`)
    }
  }
})

/**
 * Settle/limits drift gate.
 *
 * A classified stack breach inside a timer or promise callback lives on
 * `SandboxRunRecord.settle`; typing that field as `unknown` (or dropping
 * `SandboxDisposal.skipped`) hands the consumer a shape it cannot narrow, which
 * is the same lie as an undeclared export. This pins the names, not the layout.
 */
test('the run record types the event-loop settle outcome and its abandon marker', async () => {
  const source = await readTypes('ai4reverse.d.ts')
  const { types } = exportedNames(source)
  for (const name of ['SandboxSettle', 'SandboxSettleDrained', 'SandboxSettleError', 'SandboxRunRecord']) {
    assert.ok(types.has(name), `types/ai4reverse.d.ts must declare ${name}`)
  }

  /** Body of one `export interface Name { ... }` block. */
  const bodyOf = (declaration) => {
    // The brace keeps `SandboxDisposal` from matching `SandboxDisposalError`.
    const start = source.indexOf(`export interface ${declaration} {`)
    assert.ok(start >= 0, `missing declaration for ${declaration}`)
    const end = source.indexOf('\n}', start)
    return source.slice(start, end)
  }

  const record = bodyOf('SandboxRunRecord')
  assert.match(record, /settle\?: SandboxSettle/, 'SandboxRunRecord.settle must name the settle shape')
  assert.doesNotMatch(record, /settle\?: (unknown|object)\b/, 'SandboxRunRecord.settle must not be opaque')
  // The abandon decision is keyed off this additive engine marker, so it must
  // be typed: an untyped record forces the consumer back to message matching.
  assert.match(record, /\bstackExhaustion\??: boolean/, 'SandboxRunRecord must declare stackExhaustion')

  const settle = bodyOf('SandboxSettleDrained')
  for (const field of ['virtualMs', 'pendingTimers', 'jobs', 'limitsHit', 'error', 'stackExhaustion']) {
    assert.match(settle, new RegExp(`\\b${field}\\??:`), `SandboxSettleDrained must declare ${field}`)
  }

  const invocation = bodyOf('InvocationResult')
  assert.match(invocation, /\bstackExhaustion\??: boolean/, 'InvocationResult must declare stackExhaustion')
  assert.match(invocation, /\bvirtualMs\??: number/, 'InvocationResult must declare virtualMs')

  const error = bodyOf('SandboxSettleError')
  for (const field of ['origin', 'name', 'message']) {
    assert.match(error, new RegExp(`\\b${field}:`), `SandboxSettleError must declare ${field}`)
  }

  assert.match(bodyOf('SandboxDisposal'), /skipped\?: boolean/, 'SandboxDisposal.skipped must be declared')
})
