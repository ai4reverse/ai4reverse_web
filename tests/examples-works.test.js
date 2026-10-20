import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = `${ROOT}examples/works`

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

test('the works suite contains 30 complete works with unique identities', async () => {
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
    assert.ok(manifest.title.length > 3, directory)
    assert.ok(manifest.summary.length > 20, directory)
    assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0, directory)
    assert.ok(manifest.entry && typeof manifest.entry === 'string', directory)
    assert.ok(manifest.verify && typeof manifest.verify === 'object', directory)

    for (const file of ['work.json', manifest.entry, 'README.md']) {
      const info = await stat(`${BASE}/${directory}/${file}`)
      assert.ok(info.size > 0, `${directory}/${file} is empty`)
    }
    const readme = await readFile(`${BASE}/${directory}/README.md`, 'utf8')
    assert.match(readme, /作品定位/, directory)
    assert.match(readme, /验证与预期结果/, directory)
    assert.match(readme, /合成/, directory)

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

test('the works index documents every work', async () => {
  const works = await loadWorks()
  const index = await readFile(`${BASE}/README.md`, 'utf8')
  assert.match(index, /30 个商业级完整作品/)
  for (const { directory, manifest } of works) {
    assert.ok(index.includes(directory), `index missing ${directory}`)
    assert.ok(index.includes(manifest.title), `index missing ${manifest.title}`)
    assert.ok(index.includes(manifest.category), `index missing ${manifest.category}`)
  }
})

test('every work satisfies its declared verification contract', async () => {
  const { stdout } = await exec(process.execPath, [`${BASE}/run-all.mjs`, '--json'], {
    cwd: ROOT,
    timeout: 600_000,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.total, 30)
  assert.equal(result.passed, 30, JSON.stringify(result.failures, null, 2))
  assert.equal(result.failed, 0)
  for (const work of result.results) {
    assert.equal(work.ok, true, `${work.id}: ${work.detail?.join('; ')}`)
  }
})

test('the table runner exits zero with 30/30', async () => {
  const { stdout } = await exec(process.execPath, [`${BASE}/run-all.mjs`], {
    cwd: ROOT,
    timeout: 600_000,
  })
  assert.match(stdout, /30\/30 works verified/)
  assert.doesNotMatch(stdout, /FAIL:/)
})

test('SDK, virus and app entry contracts are enforced', async () => {
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
      assert.match(app, /tools\/index\.js|tools\/analysis|tools\/sandbox/, directory)
    }
  }
})

test('the ransomware JSVMP work is regenerated by its documented builder', async () => {
  const manifest = JSON.parse(await readFile(`${BASE}/22-ransomware-jsvmp/work.json`, 'utf8'))
  assert.equal(manifest.expect.requireVm, true)
  const sample = await readFile(`${BASE}/22-ransomware-jsvmp/sample.js`, 'utf8')
  assert.match(sample, /__ransom_vm/)
  assert.match(sample, /Generated by examples\/works\/build-ransomware-jsvmp\.mjs/)
  const builder = await readFile(`${BASE}/build-ransomware-jsvmp.mjs`, 'utf8')
  assert.match(builder, /buildVM/)
})
