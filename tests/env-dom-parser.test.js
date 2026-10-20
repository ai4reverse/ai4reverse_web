import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'

async function parserHarness() {
  return createHarness({ modules: ['globals', 'dom', 'dom-parser'], profile: { browser: 'chrome', os: 'macos', locale: 'en-US' } })
}

test('textContent aggregates text across parsed XML and HTML trees', async () => {
  const harness = await parserHarness()
  try {
    const run = harness.run(`
      var parser = new DOMParser();
      var xml = parser.parseFromString('<a>x<b>y</b>z</a>', 'text/xml');
      var html = parser.parseFromString('<div>hello <b>world</b></div>', 'text/html');
      var plain = document.createElement('span');
      [xml.documentElement.textContent, html.querySelector('div').textContent, plain.textContent];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.deepEqual(run.value, ['xyz', 'hello world', ''])
  } finally {
    harness.dispose()
  }
})

test('malformed XML parses leniently without throwing', async () => {
  const harness = await parserHarness()
  try {
    const run = harness.run(`
      var parser = new DOMParser();
      var doc = parser.parseFromString('<root><a></b></root>', 'text/xml');
      [doc.documentElement.tagName, new XMLSerializer().serializeToString(doc)];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.value[0], 'ROOT')
    assert.equal(run.value[1], '<root><a/></root>')
  } finally {
    harness.dispose()
  }
})

test('unsupported content types throw the browser enum error', async () => {
  const harness = await parserHarness()
  try {
    const run = harness.run(`
      var error = null;
      try { new DOMParser().parseFromString('<x/>', 'text/nope') } catch (e) { error = e }
      [error.name, /not a valid enum/.test(error.message)];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.value[0], 'TypeError')
    assert.equal(run.value[1], true)
  } finally {
    harness.dispose()
  }
})

test('oversized markup is truncated instead of failing the run', async () => {
  const harness = await parserHarness()
  try {
    const run = harness.run(`
      var doc = new DOMParser().parseFromString('<r>' + 'y'.repeat(500000) + '</r>', 'text/xml');
      var exists = doc.documentElement !== null;
      [exists, typeof doc.documentElement.tagName];
    `)
    assert.equal(run.ok, true, JSON.stringify(run.error))
    assert.equal(run.value[0], true)
    assert.equal(run.value[1], "string")
  } finally {
    harness.dispose()
  }
})
