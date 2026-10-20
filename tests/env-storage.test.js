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

test('overwriting a key frees its previous bytes for the quota account', async () => {
  const harness = await storageHarness()
  try {
    const run = harness.run(`
      localStorage.setItem('big', 'a'.repeat(3 * 1024 * 1024));
      var secondFailed = false;
      try { localStorage.setItem('other', 'b'.repeat(3 * 1024 * 1024)) } catch (e) { secondFailed = e.name }
      localStorage.setItem('big', 'c');
      var afterOverwrite = null;
      try { localStorage.setItem('other', 'b'.repeat(3 * 1024 * 1024)) } catch (e) { afterOverwrite = e.name }
      [secondFailed, afterOverwrite, localStorage.getItem('big')];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.value[0], 'QuotaExceededError', 'second 3MB set must hit the quota')
    assert.equal(run.value[1], null, 'overwriting frees the old bytes; the same set must now succeed')
    assert.equal(run.value[2], 'c')
  } finally {
    harness.dispose()
  }
})

test('removeItem and clear restore quota headroom', async () => {
  const harness = await storageHarness()
  try {
    const run = harness.run(`
      localStorage.setItem('a', 'x'.repeat(2 * 1024 * 1024));
      localStorage.setItem('b', 'y'.repeat(2 * 1024 * 1024));
      var filled = false;
      try { localStorage.setItem('c', 'z'.repeat(2 * 1024 * 1024)) } catch (e) { filled = e.name }
      localStorage.removeItem('a');
      var afterRemove = null;
      try { localStorage.setItem('c', 'z'.repeat(2 * 1024 * 1024)) } catch (e) { afterRemove = e.name }
      localStorage.clear();
      var afterClear = null;
      try { localStorage.setItem('c', 'z'.repeat(2 * 1024 * 1024)) } catch (e) { afterClear = e.name }
      [filled, afterRemove, afterClear, localStorage.length];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.value[0], 'QuotaExceededError')
    assert.equal(run.value[1], null, 'removeItem frees exactly that key bytes')
    assert.equal(run.value[2], null, 'clear frees everything')
    assert.equal(run.value[3], 1)
  } finally {
    harness.dispose()
  }
})

test('sessionStorage and localStorage isolate keys and quotas', async () => {
  const harness = await storageHarness()
  try {
    const run = harness.run(`
      localStorage.setItem('shared', 'local');
      sessionStorage.setItem('shared', 'session');
      sessionStorage.setItem('onlySession', '1');
      [localStorage.getItem('shared'), sessionStorage.getItem('shared'),
       localStorage.getItem('onlySession'), sessionStorage.length, localStorage.length];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.value, ['local', 'session', null, 2, 1])
  } finally {
    harness.dispose()
  }
})

test('key(i) and length stay consistent across removals', async () => {
  const harness = await storageHarness()
  try {
    const run = harness.run(`
      localStorage.setItem('k0', 'v0'); localStorage.setItem('k1', 'v1'); localStorage.setItem('k2', 'v2');
      localStorage.removeItem('k1');
      var keys = []; for (var i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
      keys;
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.value, ['k0', 'k2'])
  } finally {
    harness.dispose()
  }
})
