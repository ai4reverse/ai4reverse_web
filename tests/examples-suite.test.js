import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = `${ROOT}examples/suite`

/** Conservative effective code measure: strip comments and blank lines. */
function effectiveBytes(source) {
  const withoutBlocks = String(source).replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1').trim())
    .filter(Boolean)
    .join('\n').length
}

async function codeBytes(directory) {
  let total = 0
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build'].includes(entry.name)) continue
        await walk(path)
      } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        total += effectiveBytes(await readFile(path, 'utf8'))
      }
    }
  }
  await walk(directory)
  return total
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
    works.push({ directory, manifest })
  }
  return works
}

test('suite contains 30 complete works with unique identities and the expected mix', async () => {
  const works = await loadWorks()
  assert.equal(works.length, 30)
  assert.deepEqual(
    works.map(({ manifest }) => manifest.id),
    Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, '0')),
  )
  assert.equal(new Set(works.map(({ manifest }) => manifest.slug)).size, 30)
  assert.equal(new Set(works.map(({ manifest }) => manifest.title)).size, 30)
  const counts = works.reduce((accumulator, { manifest }) => {
    accumulator[manifest.type] = (accumulator[manifest.type] ?? 0) + 1
    return accumulator
  }, {})
  assert.deepEqual(counts, { sdk: 10, virus: 12, app: 8 })

  for (const { directory, manifest } of works) {
    assert.match(directory, new RegExp(`^${manifest.id}-${manifest.slug}$`))
    assert.ok(['sdk', 'virus', 'app'].includes(manifest.type), directory)
    assert.ok(['commercial', 'military'].includes(manifest.grade), directory)
    assert.ok(manifest.summary.length > 20, directory)
    assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0, directory)
    assert.ok(manifest.entry && typeof manifest.entry === 'string', directory)
    for (const file of ['work.json', manifest.entry, 'README.md']) {
      const info = await stat(`${BASE}/${directory}/${file}`)
      assert.ok(info.size > 0, `${directory}/${file} empty`)
    }
    const readme = await readFile(`${BASE}/${directory}/README.md`, 'utf8')
    assert.match(readme, /作品定位/, directory)
    assert.match(readme, /验证与预期结果/, directory)

    if (manifest.type === 'sdk') {
      await stat(`${BASE}/${directory}/verify.mjs`)
      assert.match(manifest.verify.command, /verify\.mjs/)
    } else if (manifest.type === 'virus') {
      const expectation = manifest.expect
      assert.ok(['benign', 'suspicious', 'malicious'].includes(expectation.level), directory)
      assert.ok(Number.isFinite(expectation.minScore), directory)
      assert.ok(Array.isArray(expectation.requireIocs), directory)
      assert.ok(Array.isArray(expectation.artifactsAny), directory)
      assert.ok(Array.isArray(expectation.requireTechniques), directory)
      assert.ok(Array.isArray(expectation.requireTraceKinds), directory)
    } else {
      assert.deepEqual(manifest.verify.args, ['--self-test'])
      assert.equal(manifest.verify.expect, 'SELFTEST OK')
    }
  }
})

test('the suite index documents every work', async () => {
  const works = await loadWorks()
  const index = await readFile(`${BASE}/README.md`, 'utf8')
  for (const { directory, manifest } of works) {
    assert.ok(index.includes(directory), `index missing ${directory}`)
    assert.ok(index.includes(manifest.title), `index missing ${manifest.title}`)
    assert.ok(index.includes(manifest.category), `index missing ${manifest.category}`)
  }
})

test('suite effective code is at least 100KB', async () => {
  const works = await loadWorks()
  let total = 0
  for (const { directory } of works) total += await codeBytes(`${BASE}/${directory}`)
  assert.ok(total >= 100_000, `effective code ${total} bytes < 100000`)
  // Per-package floor: no package may be a stub.
  for (const { directory } of works) {
    const bytes = await codeBytes(`${BASE}/${directory}`)
    assert.ok(bytes >= 2500, `${directory} only ${bytes} bytes of effective code`)
  }
})

test('every work satisfies its declared verification contract and byte gate', async () => {
  const { stdout } = await exec(process.execPath, [`${BASE}/run-all.mjs`, '--json'], { cwd: ROOT, timeout: 900_000 })
  const result = JSON.parse(stdout)
  assert.equal(result.total, 30)
  assert.equal(result.passed, 30, JSON.stringify(result.failures, null, 2))
  assert.equal(result.failed, 0)
  assert.ok(result.totalEffectiveBytes >= 100_000, `runner effective bytes ${result.totalEffectiveBytes}`)
  assert.equal(result.belowMinimum, false)
  for (const work of result.results) {
    assert.equal(work.ok, true, `${work.id}: ${work.detail?.join('; ')}`)
    assert.ok(work.effective >= 2500, `${work.id} too small`)
  }
})

test('the table runner exits zero and reports the byte gate', async () => {
  const { stdout } = await exec(process.execPath, [`${BASE}/run-all.mjs`], { cwd: ROOT, timeout: 900_000 })
  assert.match(stdout, /30\/30 works verified/)
  assert.match(stdout, /effective code \d+(?:\.\d+)?KB/)
  assert.doesNotMatch(stdout, /FAIL:/)
})

test('type-specific contracts are enforced', async () => {
  const works = await loadWorks()
  for (const { directory, manifest } of works) {
    if (manifest.type === 'sdk') {
      const verify = await readFile(`${BASE}/${directory}/verify.mjs`, 'utf8')
      assert.match(verify, /checks: \$\{passed\}\/\$\{total\}/, directory)
      assert.match(verify, /assert/, directory)
    } else if (manifest.type === 'virus') {
      const sample = await readFile(`${BASE}/${directory}/${manifest.entry}`, 'utf8')
      assert.doesNotMatch(sample, /require\s*\(\s*['"]node:/, `${directory} imports Node I/O`)
      assert.doesNotMatch(sample, /from\s+['"]node:/, `${directory} imports Node I/O`)
      assert.doesNotMatch(sample, /process\.exit\s*\(/, `${directory} exits the host`)
    } else {
      const app = await readFile(`${BASE}/${directory}/${manifest.entry}`, 'utf8')
      assert.match(app, /--self-test/, directory)
      assert.match(app, /SELFTEST OK/, directory)
      // Platform integration may live in app.mjs or in its lib/ modules.
      let usesTools = /tools\/(?:index|analysis|sandbox)/.test(app)
      const libDir = `${BASE}/${directory}/lib`
      try {
        for (const file of await readdir(libDir)) {
          if (!file.endsWith('.js')) continue
          const source = await readFile(`${libDir}/${file}`, 'utf8')
          if (/tools\/(?:index|analysis|sandbox)/.test(source)) usesTools = true
        }
      } catch {
        /* no lib directory */
      }
      assert.equal(usesTools, true, `${directory} does not use platform tools`)
    }
  }
})
