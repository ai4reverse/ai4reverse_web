import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'

async function storageHarness() {
  return createHarness({ modules: ['globals', 'console', 'timers', 'encoding', 'storage', 'navigator', 'misc', 'anti-fingerprint'], profile: { browser: 'chrome', os: 'windows', locale: 'en-US' } })
}

test('Storage is a real interface with byte quotas and live usage', async () => {
  const harness = await storageHarness()
  try {
    const setup = harness.run(`
      globalThis.__usage = null;
      globalThis.__quotaError = null;
      localStorage.setItem('cfg', 'x'.repeat(2048));
      try { localStorage.setItem('huge', 'x'.repeat(6 * 1024 * 1024)) } catch (error) { __quotaError = error.name }
      navigator.storage.estimate().then(function (value) { __usage = value.usage });
      [typeof Storage, localStorage instanceof Storage, localStorage.length, localStorage.key(0),
       (function () { var error = null; try { new Storage() } catch (e) { error = e.name } return error })()];
    `)
    assert.equal(setup.ok, true, JSON.stringify(setup.error))
    assert.deepEqual(setup.value, ['function', true, 1, 'cfg', 'TypeError'])
    for (let index = 0; index < 20; index += 1) {
      if (!harness.jobs(10).ok) break
    }
    const reads = harness.run('[__quotaError, __usage >= 2048, sessionStorage.getItem("missing")]')
    assert.equal(reads.ok, true, JSON.stringify(reads.error))
    assert.equal(reads.value[0], 'QuotaExceededError')
    assert.equal(reads.value[1], true)
    assert.equal(reads.value[2], null)
    assert.equal(harness.run('Object.getOwnPropertySymbols(localStorage).length').value, 0)
  } finally {
    harness.dispose()
  }
})
