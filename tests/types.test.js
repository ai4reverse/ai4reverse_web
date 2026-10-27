import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
 * Four things are pinned:
 *  1. `types/ai4reverse.d.ts` declares exactly the value exports of the entry
 *     point (`tools/index.js`);
 *  2. every `exports` subpath carries a `types` condition that exists on disk;
 *  3. every subpath barrel's runtime exports are declared in that subpath's
 *     declaration file;
 *  4. strict NodeNext consumers compile, including expected rejection cases.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TYPES_DIR = resolve(ROOT, 'types')

// Resolve the installed compiler, never a global or an automatically downloaded one.
const require = createRequire(import.meta.url)

test('public consumers compile in strict NodeNext mode and reject invalid contracts', () => {
  const compilerPackage = require.resolve('typescript/package.json')
  const compiler = resolve(dirname(compilerPackage), require(compilerPackage).bin.tsc)
  try {
    execFileSync(process.execPath, [compiler, '--project', 'tests/fixtures/types/tsconfig.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: 'pipe',
    })
  } catch (error) {
    assert.fail(`TypeScript consumer compilation failed:\n${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`)
  }
})

test('declared artifact methods and VM fields match runtime shapes', async () => {
  const { buildVM, createArtifactStore } = await import('../tools/index.js')
  const vm = buildVM([])
  assert.deepEqual(Object.keys(vm).sort(), ['bytecode', 'code', 'dispatchTable', 'opcodes', 'run', 'sourceMap'])
  assert.equal(typeof vm.code, 'string')
  assert.equal(typeof vm.run, 'function')
  assert.throws(() => vm.run(), { code: 'TRUST_ERROR' })

  const store = createArtifactStore()
  assert.deepEqual(Object.keys(store).sort(), ['add', 'addAll', 'list', 'stats', 'summary'])
  assert.equal(store.add({ kind: 'eval-payload', data: '' }), null)
  const added = store.addAll([{ kind: 'eval-payload', data: '42' }])
  assert.equal(added[0].text, '42')
  assert.deepEqual(store.stats(), { count: 1, bytes: 2 })
  assert.equal(store.summary()[0].sha256, added[0].sha256)
  assert.equal(Object.hasOwn(store.summary()[0], 'text'), false)
})

test('environment installation returns the declared report fields', async () => {
  const { installEnvironment } = await import('../tools/index.js')
  const result = await installEnvironment({}, { only: [] })
  assert.deepEqual(Object.keys(result).sort(), ['complete', 'installed', 'missing', 'requested', 'tookMs'])
  assert.deepEqual(result.installed, [])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.requested, [])
  assert.equal(result.complete, true)
  assert.equal(typeof result.tookMs, 'number')
})

test('nonempty environment reports retain structured installation and missing records', async () => {
  const { TracelessSandbox } = await import('../tools/index.js')
  const sandbox = await TracelessSandbox.create({
    logLevel: 'silent',
    env: { only: ['misc'], strict: false },
    instrumentation: { code: { level: 'off' } },
  })
  try {
    const run = await sandbox.run('42')
    assert.equal(run.ok, true)
    const result = run.environment
    assert.deepEqual(Object.keys(result).sort(), ['complete', 'installed', 'missing', 'requested', 'tookMs'])
    assert.deepEqual(result.requested, ['misc'])
    assert.equal(result.complete, false)
    assert.equal(result.installed.length, 1)
    assert.deepEqual(Object.keys(result.installed[0]).sort(), ['id', 'ms', 'order'])
    assert.equal(result.installed[0].id, 'misc')
    assert.equal(typeof result.installed[0].order, 'number')
    assert.equal(typeof result.installed[0].ms, 'number')
    assert.deepEqual(result.missing, [
      { id: 'misc', reason: 'missing requirement globals' },
      { id: 'misc', reason: 'missing requirement navigator' },
    ])
    assert.equal(typeof result.tookMs, 'number')
    assert.equal(run.disposal.ok, true)
  } finally {
    sandbox.dispose()
  }
})

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
    'constraint.d.ts',
    'hook.d.ts',
    'instrumentation.d.ts',
    'invocation.d.ts',
    'jsvmp.d.ts',
    'logging.d.ts',
    'restore.d.ts',
    'sandbox.d.ts',
    'taint.d.ts',
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

/**
 * Stealth member drift gate.
 *
 * `Stealth` carries `[key: string]: unknown`, so a member that is not declared
 * is not a compile error — it is an `unknown` the consumer cannot call. The
 * runtime's intrinsic stack-overflow probe (`createStealth().isIntrinsicStackError`)
 * is used by the invocation layer to tell a real engine overflow from a crafted
 * error object, so it has to be callable through the public type.
 */
test('the Stealth declaration types the intrinsic stack-error probe', async () => {
  const source = await readTypes('ai4reverse.d.ts')
  const start = source.indexOf('export interface Stealth {')
  assert.ok(start >= 0, 'types/ai4reverse.d.ts must declare Stealth')
  const body = source.slice(start, source.indexOf('\n}', start))
  assert.match(body, /\bisIntrinsicStackError\(handle: object\): boolean/, 'Stealth must declare isIntrinsicStackError')
})

/**
 * Member-level drift gates.
 *
 * The export-name gate above cannot see a wrong member: declaring browser timer
 * methods on `VirtualClock`, or `filenameFor` on `Invoker`, still lists the right
 * exports. Each case compares a declaration block with the value the runtime
 * actually produces.
 */

/** Body of one `export interface Name ... { ... }` block. */
function interfaceBody(source, name) {
  const start = source.indexOf(`export interface ${name}`)
  assert.ok(start >= 0, `missing declaration for ${name}`)
  const open = source.indexOf('{', start)
  assert.ok(open > start, `malformed declaration for ${name}`)
  const end = source.indexOf('\n}', open)
  assert.ok(end > open, `unterminated declaration for ${name}`)
  return source.slice(start, end)
}

test('VirtualClock declares the timer API createVirtualClock actually returns', async () => {
  const { createVirtualClock } = await import('../tools/index.js')
  const clock = createVirtualClock()
  try {
    const body = interfaceBody(await readTypes('ai4reverse.d.ts'), 'VirtualClock')

    for (const [name, value] of Object.entries(clock)) {
      const pattern = typeof value === 'function' ? `\\b${name}\\(` : `\\b${name}:`
      assert.match(body, new RegExp(pattern), `VirtualClock must declare ${name}`)
    }

    for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
      assert.doesNotMatch(body, new RegExp(`\\b${name}\\b`), `VirtualClock must not declare ${name}`)
      assert.equal(Object.hasOwn(clock, name), false, `createVirtualClock() must not expose ${name}`)
    }
  } finally {
    clock.dispose()
  }
})

test('Invoker declares the runtime resolveFilename method, not filenameFor', async () => {
  const body = interfaceBody(await readTypes('ai4reverse.d.ts'), 'Invoker')
  assert.match(body, /\bresolveFilename\(/, 'Invoker must declare resolveFilename')
  assert.match(
    body,
    /kind\?: 'script' \| 'module' \| 'eval'/,
    'resolveFilename must accept the runtime kind',
  )
  assert.doesNotMatch(body, /\bfilenameFor\b/, 'Invoker must not declare the phantom filenameFor')
})

test('StaticFacts.strings is the sample array and stringsTotal is the count', async () => {
  const { analyzeSource } = await import('../tools/index.js')
  const analysis = analyzeSource('var first = "alpha"; var second = "beta";')
  assert.equal(analysis.ok, true)
  assert.ok(Array.isArray(analysis.facts.strings), 'analyzeSource().facts.strings must be samples')
  assert.ok(analysis.facts.strings.includes('alpha'), 'the sample list must contain "alpha"')
  assert.equal(analysis.facts.stringsTotal, 2)

  const body = interfaceBody(await readTypes('ai4reverse.d.ts'), 'StaticFacts')
  assert.match(body, /\bstrings: string\[\]/, 'StaticFacts.strings must be the sample array')
  assert.doesNotMatch(body, /\bstrings: number\b/, 'StaticFacts.strings must not be the count')
  assert.match(body, /\bstringsTotal: number\b/, 'StaticFacts.stringsTotal must be the count')
})

/**
 * The parse-failure path is still a `StaticFacts` result.
 *
 * `AnalyzeSourceResult` types both arms as `facts: StaticFacts`, so the failure
 * arm cannot hand back `strings: 0`: a consumer that narrows on `ok` would read
 * a `string[]` it can never iterate. The empty result must keep the same shape
 * as a successful extraction and report zero through `stringsTotal`.
 */
test('a parse failure returns the StaticFacts sample-array shape, not a numeric strings count', async () => {
  const { analyzeSource } = await import('../tools/index.js')
  const failed = analyzeSource('function {')
  assert.equal(failed.ok, false)
  assert.ok(Array.isArray(failed.facts.strings), 'a parse failure must still expose the sample array')
  assert.deepEqual(failed.facts.strings, [], 'a parse failure has no string samples')
  assert.equal(failed.facts.stringsTotal, 0, 'stringsTotal is the count on every StaticFacts result')
  assert.equal(failed.facts.uniqueStrings, 0)
  assert.deepEqual(failed.facts.domains, [], 'the empty facts keep the declared domains array')

  // The success arm uses the identical shape: array of samples + numeric total.
  const ok = analyzeSource('var alpha = "alpha"; var beta = "beta";')
  assert.equal(ok.ok, true)
  assert.ok(Array.isArray(ok.facts.strings), 'the success arm exposes the sample array')
  assert.equal(ok.facts.stringsTotal, 2, 'the success arm reports the count separately')
  assert.deepEqual(
    Object.keys(failed.facts).filter((key) => key === 'strings' || key === 'stringsTotal').sort(),
    Object.keys(ok.facts).filter((key) => key === 'strings' || key === 'stringsTotal').sort(),
    'both arms expose the same strings/stringsTotal keys',
  )
})

/**
 * Two shapes share the name "facts".
 *
 * `analyzeSource()` returns the extraction result: `strings` is the sample
 * array. The instrumentation layer then normalises it for run/invocation/
 * prepared records: `strings` becomes the total count and the samples move to
 * `stringSamples`. Declaring one shape for both sites makes the compile-time
 * type disagree with the runtime value (a `string[]` that is a number), so this
 * pins both halves and the normalisation actually performed by the sandbox.
 */
test('run/invocation/prepared facts declare the normalised strings count and samples', async () => {
  const { TracelessSandbox } = await import('../tools/index.js')
  const sandbox = await TracelessSandbox.create({
    logLevel: 'silent',
    instrumentation: { code: { level: 'off' } },
  })
  try {
    const run = await sandbox.run('var alpha = "alpha"; var beta = "beta"; 1')
    assert.equal(run.ok, true)
    assert.equal(run.facts.strings, 2, 'run facts expose the string count, not the sample array')
    assert.ok(Array.isArray(run.facts.stringSamples), 'run facts expose the samples separately')
    assert.ok(run.facts.stringSamples.includes('alpha'), 'the normalised sample list must keep the literals')
  } finally {
    sandbox.dispose()
  }

  const source = await readTypes('ai4reverse.d.ts')
  const normalized = interfaceBody(source, 'NormalizedStaticFacts')
  assert.match(normalized, /\bstrings: number\b/, 'NormalizedStaticFacts.strings must be the count')
  assert.match(normalized, /\bstringSamples: string\[\]/, 'NormalizedStaticFacts must declare stringSamples')

  for (const [name, pattern] of [
    ['InstrumentationPrepared', /\bfacts: NormalizedStaticFacts \| null/],
    ['SandboxRunRecord', /\bfacts\?: NormalizedStaticFacts \| null/],
    ['InvocationResult', /\bfacts\?: NormalizedStaticFacts \| null/],
  ]) {
    assert.match(interfaceBody(source, name), pattern, `${name}.facts must use the normalised shape`)
  }
  // analyzeSource() is not normalised: its facts keep the sample-array shape.
  assert.match(
    interfaceBody(source, 'AnalyzeSampleResult'),
    /\bfacts: StaticFacts \| null/,
    'AnalyzeSampleResult.facts must stay StaticFacts',
  )
  assert.match(
    source,
    /export type AnalyzeSourceResult =[\s\S]*?facts: StaticFacts;/,
    'AnalyzeSourceResult.facts must stay StaticFacts',
  )
})

test('the root run() declaration accepts a caller-owned sandbox', async () => {
  const source = await readTypes('ai4reverse.d.ts')
  const signature = source.slice(source.indexOf('export declare function run('))
  assert.ok(signature.startsWith('export declare function run('), 'must declare the root run()')
  const declaration = signature.slice(0, signature.indexOf('\n'))
  assert.match(declaration, /options\?: RunOptions/, 'run() must accept the shared run option shape')

  const body = interfaceBody(source, 'RunOptions')
  assert.match(body, /extends SandboxOptions/, 'RunOptions must reuse sandbox construction options')
  assert.match(body, /SandboxRunOptions/, 'RunOptions must reuse the per-run options')
  assert.match(body, /\bsandbox\?: TracelessSandbox/, 'root run() must accept a caller-owned sandbox')
})

test('SeededRandom declares only the members createSeededRandom returns', async () => {
  const { createSeededRandom } = await import('../tools/util/index.js')
  const random = createSeededRandom(7)
  const body = interfaceBody(await readTypes('ai4reverse.d.ts'), 'SeededRandom')

  for (const name of Object.keys(random)) {
    assert.match(body, new RegExp(`\\b${name}(<[^>]*>)?\\(`), `SeededRandom must declare ${name}`)
  }
  assert.doesNotMatch(body, /\bbool\(/, 'SeededRandom must not declare the phantom bool')
})

test('HandleBag reports the size the declarations promise', async () => {
  const { HandleBag } = await import('../tools/util/index.js')
  const bag = new HandleBag()
  assert.equal(bag.size, 0, 'a fresh bag holds no handles')
  bag.add({ dispose() {} })
  assert.equal(bag.size, 1, 'HandleBag.size must count the tracked handles')
  bag.dispose()
  assert.equal(bag.size, 0, 'a disposed bag holds no handles')
})
