import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createHarness } from './helpers/harness.js'
import { install as installCryptoEnv, meta as cryptoMeta } from '../tools/sandbox/env/crypto.js'

/**
 * Seeded `crypto` surface (H5).
 *
 * `tools/sandbox/env/crypto.js` promises in its header that `getRandomValues`
 * and `randomUUID` are seeded so a sample that derives its C2 key from guest
 * entropy reproduces per run, and that `subtle.digest` is real Node crypto.
 * These tests pin that promise: same seed → identical bytes/UUIDs, different
 * seed → different ones, the browser 65536-byte quota behaves like the spec,
 * digests match the host hash byte for byte, and every freshly installed
 * sandbox re-seeds from the stream head.
 */

const SEED = 0x5eed
const OTHER_SEED = 0xc0ffee
const MODULES = ['globals', 'encoding', 'crypto']
/** Fixed plaintext whose bytes feed both the guest and the host digest. */
const DIGEST_INPUT = 'ai4r-c2-key-derivation'

async function cryptoHarness(seed = SEED) {
  return createHarness({ modules: MODULES, seed })
}

/** Evaluate guest source and fail the test when it throws. */
function runGuest(harness, source) {
  const result = harness.run(source)
  assert.equal(result.ok, true, `guest threw: ${JSON.stringify(result.error)}`)
  return result.value
}

/** Draw `length` bytes from the guest crypto and return them as hex. */
function drawHex(harness, length) {
  return runGuest(
    harness,
    `(function () {
      var bytes = crypto.getRandomValues(new Uint8Array(${length}));
      var hex = '';
      for (var index = 0; index < bytes.length; index += 1) hex += ('0' + bytes[index].toString(16)).slice(-2);
      return hex;
    })()`,
  )
}

test('meta declares the crypto module contract', () => {
  assert.equal(cryptoMeta.id, 'crypto')
  assert.equal(cryptoMeta.order, 80)
  assert.deepEqual([...cryptoMeta.requires], ['globals'])
})

test('two same-seed sandboxes produce byte-identical getRandomValues output', async () => {
  const first = await cryptoHarness()
  const second = await cryptoHarness()
  try {
    const hexA = drawHex(first, 32)
    const hexB = drawHex(second, 32)

    assert.match(hexA, /^[0-9a-f]{64}$/, 'the draw must fill 32 bytes')
    assert.notEqual(hexA, '00'.repeat(32), 'the seeded stream must not be degenerate')
    assert.equal(hexA, hexB, 'same seed must reproduce the same bytes')

    const base64A = Buffer.from(hexA, 'hex').toString('base64')
    const base64B = Buffer.from(hexB, 'hex').toString('base64')
    assert.equal(base64A, base64B)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('a different seed yields different getRandomValues bytes', async () => {
  const seeded = await cryptoHarness(SEED)
  const other = await cryptoHarness(OTHER_SEED)
  try {
    const hexSeeded = drawHex(seeded, 32)
    const hexOther = drawHex(other, 32)
    assert.notEqual(hexSeeded, hexOther, 'different seeds must diverge on the first draw')
  } finally {
    seeded.dispose()
    other.dispose()
  }
})

test('randomUUID is reproducible for the same seed and differs across seeds', async () => {
  const first = await cryptoHarness()
  const second = await cryptoHarness()
  const other = await cryptoHarness(OTHER_SEED)
  try {
    const uuidA = runGuest(first, 'crypto.randomUUID()')
    const uuidB = runGuest(second, 'crypto.randomUUID()')
    const uuidOther = runGuest(other, 'crypto.randomUUID()')

    assert.match(uuidA, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a v4-shaped UUID')
    assert.equal(uuidA, uuidB, 'same seed must reproduce the same UUID')
    assert.notEqual(uuidA, uuidOther, 'a different seed must produce a different UUID')
  } finally {
    first.dispose()
    second.dispose()
    other.dispose()
  }
})

test('getRandomValues throws QuotaExceededError above 65536 bytes and accepts exactly 65536', async () => {
  const harness = await cryptoHarness()
  try {
    const over = runGuest(
      harness,
      `(function () {
        try { crypto.getRandomValues(new Uint8Array(65537)); return 'no-throw'; }
        catch (error) { return error.name + '|' + error.message; }
      })()`,
    )
    assert.match(over, /^QuotaExceededError\|/, 'the rejection must be named QuotaExceededError')
    assert.match(over, /65537/, 'the message must report the requested length')
    assert.match(over, /65536/, 'the message must report the quota')

    // Exactly at the quota the call must succeed and fill the view; the seeded
    // stream produces ~1/256 zero bytes, so "every byte was written" can only
    // be asserted as "the draw is not degenerate".
    const exact = runGuest(
      harness,
      `(function () {
        var bytes = crypto.getRandomValues(new Uint8Array(65536));
        var zeros = 0;
        for (var index = 0; index < bytes.length; index += 1) zeros += bytes[index] === 0 ? 1 : 0;
        return bytes.length + '|' + zeros;
      })()`,
    )
    assert.match(exact, /^65536\|\d+$/, 'a full-quota draw must fill the whole view')
    assert.notEqual(exact, '65536|65536', 'the draw must not be all zeros')
  } finally {
    harness.dispose()
  }
})

test('subtle.digest SHA-256 matches the host node:crypto hash for the same bytes', async () => {
  const inputBytes = Array.from(Buffer.from(DIGEST_INPUT, 'utf8'))
  const harness = await cryptoHarness()
  try {
    runGuest(
      harness,
      `globalThis.__digest = 'pending';
       crypto.subtle.digest('SHA-256', new Uint8Array([${inputBytes.join(',')}])).then(function (buffer) {
         var bytes = new Uint8Array(buffer);
         var hex = '';
         for (var index = 0; index < bytes.length; index += 1) hex += ('0' + bytes[index].toString(16)).slice(-2);
         globalThis.__digest = hex;
       }, function (error) { globalThis.__digest = 'rejected:' + error.name; });
       0`,
    )
    const drained = harness.jobs()
    assert.equal(drained.ok, true, `job queue failed: ${JSON.stringify(drained.error)}`)

    const guestHex = runGuest(harness, 'globalThis.__digest')
    const hostHex = createHash('sha256').update(Buffer.from(inputBytes)).digest('hex')
    assert.equal(guestHex, hostHex, 'the guest digest must equal the host digest byte for byte')
  } finally {
    harness.dispose()
  }
})

test('the realistic key-derivation path digest(TextEncoder().encode(...)) also matches the host', async () => {
  const harness = await cryptoHarness()
  try {
    runGuest(
      harness,
      `globalThis.__derived = 'pending';
       crypto.subtle.digest('SHA-256', new TextEncoder().encode(${JSON.stringify(DIGEST_INPUT)})).then(function (buffer) {
         var bytes = new Uint8Array(buffer);
         var hex = '';
         for (var index = 0; index < bytes.length; index += 1) hex += ('0' + bytes[index].toString(16)).slice(-2);
         globalThis.__derived = hex;
       }, function (error) { globalThis.__derived = 'rejected:' + error.name; });
       0`,
    )
    const drained = harness.jobs()
    assert.equal(drained.ok, true, `job queue failed: ${JSON.stringify(drained.error)}`)

    const guestHex = runGuest(harness, 'globalThis.__derived')
    const hostHex = createHash('sha256').update(DIGEST_INPUT, 'utf8').digest('hex')
    assert.equal(guestHex, hostHex)
  } finally {
    harness.dispose()
  }
})

test('the seeded stream is call-sequence stable: three 8-byte draws equal one 24-byte draw', async () => {
  const sliced = await cryptoHarness()
  const bulk = await cryptoHarness()
  const late = await cryptoHarness()
  try {
    const draws = runGuest(
      sliced,
      `(function () {
        var out = [];
        for (var round = 0; round < 3; round += 1) {
          var bytes = crypto.getRandomValues(new Uint8Array(8));
          var hex = '';
          for (var index = 0; index < bytes.length; index += 1) hex += ('0' + bytes[index].toString(16)).slice(-2);
          out.push(hex);
        }
        return out;
      })()`,
    )
    const bulkHex = drawHex(bulk, 24)

    assert.equal(draws.length, 3)
    assert.equal(draws.join(''), bulkHex, 'the same seed must consume one shared stream regardless of call split')

    // Per-run re-seed: each install seeds a fresh generator, so a sandbox that
    // runs after another one consumed entropy still starts at the stream head.
    assert.equal(drawHex(late, 8), draws[0], 'a fresh same-seed sandbox must re-seed from the stream head')
  } finally {
    sliced.dispose()
    bulk.dispose()
    late.dispose()
  }
})

test('an identical mixed call sequence reproduces element for element across sandboxes', async () => {
  const mixedScript = `(function () {
    var first = crypto.getRandomValues(new Uint8Array(4));
    var uuid = crypto.randomUUID();
    var second = crypto.getRandomValues(new Uint8Array(12));
    var toHex = function (bytes) {
      var hex = '';
      for (var index = 0; index < bytes.length; index += 1) hex += ('0' + bytes[index].toString(16)).slice(-2);
      return hex;
    };
    return JSON.stringify([toHex(first), uuid, toHex(second)]);
  })()`

  const first = await cryptoHarness()
  const second = await cryptoHarness()
  try {
    const sequenceA = JSON.parse(runGuest(first, mixedScript))
    const sequenceB = JSON.parse(runGuest(second, mixedScript))

    assert.deepEqual(sequenceA, sequenceB, 'the same call sequence must replay identically')
    assert.match(sequenceA[1], /^[0-9a-f-]{36}$/)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('the crypto module installs standalone on a bare harness', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    installCryptoEnv(harness.bridge)
    assert.match(runGuest(harness, 'String(crypto.getRandomValues)'), /\[native code\]/)
    assert.equal(drawHex(harness, 4).length, 8)
  } finally {
    harness.dispose()
  }
})
