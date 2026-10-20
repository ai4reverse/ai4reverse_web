import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = `${ROOT}examples/mega`

function effectiveBytes(source) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, '')
  return text
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1').trim())
    .filter(Boolean)
    .join('\n').length
}

async function loadWorks() {
  const entries = await readdir(BASE, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory() && /^\d{2}-[a-z0-9-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const works = []
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(`${BASE}/${directory}/work.json`, 'utf8'))
    works.push({ directory, root: `${BASE}/${directory}`, manifest })
  }
  return works
}

test('mega suite has 18 single-file pure-JS works with the expected type mix', async () => {
  const works = await loadWorks()
  assert.equal(works.length, 18)
  assert.deepEqual(
    works.map(({ manifest }) => manifest.id),
    Array.from({ length: 18 }, (_, index) => String(index + 1).padStart(2, '0')),
  )
  assert.equal(new Set(works.map(({ manifest }) => manifest.slug)).size, 18)
  assert.equal(new Set(works.map(({ manifest }) => manifest.title)).size, 18)
  const counts = works.reduce((accumulator, { manifest }) => {
    accumulator[manifest.type] = (accumulator[manifest.type] ?? 0) + 1
    return accumulator
  }, {})
  assert.deepEqual(counts, { virus: 8, sdk: 8, app: 2 })

  for (const { directory, root, manifest } of works) {
    assert.ok(['virus', 'sdk', 'app'].includes(manifest.type), directory)
    assert.ok(['commercial', 'military'].includes(manifest.grade), directory)
    assert.ok(manifest.summary.length > 20, directory)
    assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0, directory)
    assert.equal(manifest.entry, `${manifest.slug}.js`, directory)

    const files = await readdir(root)
    const jsFiles = files.filter((file) => file.endsWith('.js'))
    assert.deepEqual(jsFiles, [manifest.entry], `${directory} must contain exactly one JS file`)
    for (const file of ['work.json', 'README.md', manifest.entry]) {
      const info = await stat(`${root}/${file}`)
      assert.ok(info.size > 0, `${directory}/${file} empty`)
    }
    for (const file of files) {
      assert.ok(['work.json', 'README.md', manifest.entry].includes(file), `${directory}/${file} not allowed`)
    }

    assert.deepEqual(manifest.protection, {
      blackhole: true,
      fortressJsvmp: true,
      dynamic: true,
      polymorphic: true,
      adversarial: true,
    })
    assert.ok(manifest.crypto.whitebox >= 3, directory)
    assert.ok(manifest.crypto.customCiphers >= 3, directory)
    assert.ok(manifest.crypto.encodings >= 3, directory)
    assert.equal(manifest.crypto.mixed, true, directory)
    assert.equal(manifest.environment.renderingEngine, true, directory)

    const source = await readFile(`${root}/${manifest.entry}`, 'utf8')
    for (const [label, pattern] of [
      ['require', /\brequire\s*\(/],
      ['import', /\bimport\s+(?:[\w*{]|\()/],
      ['export', /\bexport\s+(?:default|const|let|var|function|class|\{)/],
      ['module.exports', /\bmodule\.exports\b|\bexports\.[\w$]+\s*=/],
      ['node protocol', /['"]node:/],
      ['WebAssembly', /\bWebAssembly\.(?:instantiate|compile|Module)\b/],
    ]) {
      assert.doesNotMatch(source, pattern, `${directory} contains ${label}`)
    }
    const readme = await readFile(`${root}/README.md`, 'utf8')
    assert.match(readme, /作品定位/, directory)
    assert.match(readme, /检验|验证/, directory)
  }
})

test('mega suite effective code is at least 50MB with no stub packages', async () => {
  const works = await loadWorks()
  let total = 0
  for (const { directory, root, manifest } of works) {
    const source = await readFile(`${root}/${manifest.entry}`, 'utf8')
    const bytes = effectiveBytes(source)
    assert.ok(bytes >= 2_800_000, `${directory} only ${(bytes / 1048576).toFixed(2)}MB`)
    total += bytes
  }
  assert.ok(total >= 50_000_000, `effective code ${(total / 1048576).toFixed(2)}MB < 50MB`)
})

test('mega index documents every work', async () => {
  const works = await loadWorks()
  const index = await readFile(`${BASE}/README.md`, 'utf8')
  for (const { directory, manifest } of works) {
    assert.ok(index.includes(directory), `index missing ${directory}`)
    assert.ok(index.includes(manifest.title), `index missing ${manifest.title}`)
    assert.ok(index.includes(manifest.category), `index missing ${manifest.category}`)
  }
})

test('every mega work passes purity, capability and byte contracts', async () => {
  const { stdout } = await exec(process.execPath, [`${BASE}/run-all.mjs`, '--json'], {
    cwd: ROOT,
    timeout: 3_600_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.total, 18)
  assert.equal(result.passed, 18, JSON.stringify(result.failures, null, 2))
  assert.equal(result.failed, 0)
  assert.ok(result.totalEffectiveBytes >= 50_000_000)
  assert.equal(result.belowMinimum, false)
  for (const work of result.results) {
    assert.equal(work.ok, true, `${work.id}: ${work.issues?.join('; ')}`)
    const metrics = work.metrics
    assert.ok(metrics.whitebox >= 3, work.id)
    assert.ok(metrics.customCiphers >= 3, work.id)
    assert.ok(metrics.encodings >= 3, work.id)
    assert.ok(metrics.jsvmpOps >= 1000, work.id)
    assert.ok(metrics.envChecks >= 50, work.id)
    assert.ok(metrics.polymorphicVariants >= 10, work.id)
    assert.equal(metrics.documentAll, true, work.id)
    assert.ok(metrics.antiDebug >= 1, work.id)
  }
})
