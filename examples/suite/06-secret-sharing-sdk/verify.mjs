import assert from 'node:assert/strict'
import {
  VERSION,
  SharingError,
  commitmentOf,
  combineFromString,
  combineShares,
  findInvalidShares,
  gfDiv,
  gfInv,
  gfMul,
  parseShares,
  secretToHex,
  serializeShares,
  shareFingerprint,
  splitSecret,
  splitSecretToString,
  verifyShares,
} from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}

/** Deterministic byte stream for reproducible vectors. */
function seededRandom(seed) {
  let state = seed >>> 0
  return (length) => {
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      bytes[index] = (state >>> 24) & 0xff
    }
    return bytes
  }
}

const secret = new TextEncoder().encode('ground-control-ops-key-0001')
const commitment = commitmentOf(secret)

await check('gf(256) arithmetic matches the AES field', () => {
  assert.equal(VERSION, '1.0.0')
  assert.equal(gfMul(0x57, 0x83), 0xc1)
  assert.equal(gfMul(0, 0x9a), 0)
  assert.equal(gfMul(1, 0x9a), 0x9a)
  assert.equal(gfMul(2, 0x80), 0x1b)
  assert.equal(gfMul(gfInv(0x53), 0x53), 1)
  assert.equal(gfDiv(0xc1, 0x57), 0x83)
  assert.throws(() => gfInv(0), (error) => error.code === 'DIVISION_BY_ZERO')
})

await check('deterministic 2-of-2 vector', () => {
  const vector = splitSecret(Uint8Array.of(0x42), { threshold: 2, shares: 2, random: () => Uint8Array.of(0x01) })
  assert.deepEqual(vector.shares.map((share) => share.y[0]), [0x43, 0x40])
  assert.equal(vector.commitment, commitmentOf(Uint8Array.of(0x42)))
  assert.deepEqual(Array.from(combineShares(vector.shares, { commitment: vector.commitment })), [0x42])
  assert.throws(() => combineShares([vector.shares[1]]), (error) => error.code === 'INSUFFICIENT_SHARES')
})

await check('any 3 of 5 shares reconstruct the secret', () => {
  const envelope = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(0x51a7) })
  assert.equal(envelope.shares.length, 5)
  assert.equal(envelope.commitment, commitment)
  let combinations = 0
  for (let a = 0; a < 5; a += 1) {
    for (let b = a + 1; b < 5; b += 1) {
      for (let c = b + 1; c < 5; c += 1) {
        combinations += 1
        const subset = [envelope.shares[a], envelope.shares[b], envelope.shares[c]]
        assert.equal(secretToHex(combineShares(subset, { commitment })), secretToHex(secret))
      }
    }
  }
  assert.equal(combinations, 10)
})

await check('two shares short of the threshold are rejected', () => {
  const envelope = splitSecret(secret, { threshold: 4, shares: 6, random: seededRandom(7) })
  assert.equal(verifyShares(envelope.shares.slice(0, 2), commitment), false)
  assert.throws(
    () => combineShares(envelope.shares.slice(0, 3), { commitment }),
    (error) => error instanceof SharingError && error.code === 'INSUFFICIENT_SHARES',
  )
})

await check('duplicate and malformed shares are rejected', () => {
  const envelope = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(11) })
  assert.throws(() => combineShares([envelope.shares[0], envelope.shares[0], envelope.shares[1]]), (error) => error.code === 'DUPLICATE_SHARE')
  assert.throws(() => combineShares([{ ...envelope.shares[0], index: 0 }, envelope.shares[1], envelope.shares[2]]), (error) => error.code === 'BAD_SHARE_INDEX')
  assert.throws(() => combineShares([]), (error) => error.code === 'BAD_SHARES')
  assert.throws(() => combineShares([envelope.shares[0], envelope.shares[1], { ...envelope.shares[2], y: new Uint8Array(3) }]), (error) => error.code === 'SHARE_LENGTH_MISMATCH')
})

await check('shares from a different split fail the commitment', () => {
  const first = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(21) })
  const second = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(22) })
  const mixed = [first.shares[0], first.shares[1], second.shares[2]]
  assert.equal(verifyShares(mixed, commitment), false)
  assert.throws(() => combineShares(mixed, { commitment }), (error) => error.code === 'COMMITMENT_MISMATCH')
  assert.doesNotThrow(() => combineShares(mixed), 'without a commitment the caller gets the wrong secret')
  assert.notEqual(secretToHex(combineShares(mixed)), secretToHex(secret))
})

await check('serialization roundtrips and preserves reconstruction', () => {
  const envelope = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(31) })
  const encoded = serializeShares(envelope)
  assert.match(encoded, /^sss1\.3\.5\./)
  const parsed = parseShares(encoded)
  assert.equal(parsed.threshold, 3)
  assert.equal(parsed.count, 5)
  assert.equal(parsed.commitment, commitment)
  assert.equal(secretToHex(combineFromString(encoded)), secretToHex(secret))
  assert.equal(secretToHex(combineShares(parsed.shares, { commitment: parsed.commitment })), secretToHex(secret))
  assert.equal(splitSecretToString(secret, { threshold: 2, shares: 3, random: seededRandom(32) }).startsWith('sss1.2.3.'), true)
})

await check('corrupted serialized shares fail their checksum', () => {
  const envelope = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(41) })
  const encoded = serializeShares(envelope)
  const fields = encoded.split('.')
  assert.throws(() => parseShares([fields[0], fields[1], fields[2], 'AAAA', fields[4]].join('.')), (error) => error.code === 'BAD_COMMITMENT')
  const entries = fields[4].split(',')
  const [index, payload, fingerprint] = entries[0].split(':')
  entries[0] = `${index}:${payload.slice(0, -2)}AA:${fingerprint}`
  assert.throws(() => parseShares([...fields.slice(0, 4), entries.join(',')].join('.')), (error) => error.code === 'BAD_SHARE_CHECKSUM')
  assert.throws(() => parseShares('sss2.3.5.x.y'), (error) => error.code === 'BAD_FORMAT')
  assert.throws(() => parseShares(''), (error) => error.code === 'BAD_ENVELOPE')
})

await check('invalid share diagnostics locate a corrupted shareholder', () => {
  const envelope = splitSecret(secret, { threshold: 3, shares: 5, random: seededRandom(51) })
  const shares = envelope.shares.map((share) => ({ ...share, y: new Uint8Array(share.y) }))
  shares[3].y[0] ^= 0x80
  shares[3].fingerprint = shareFingerprint(shares[3])
  const report = findInvalidShares(shares, envelope.commitment)
  assert.deepEqual(report.invalid, [3])
  assert.equal(report.valid, false)
  assert.equal(report.tested, 10)
  assert.deepEqual(findInvalidShares(envelope.shares, envelope.commitment).invalid, [])
})

await check('fresh randomness yields different shares for the same secret', () => {
  const a = splitSecret(secret, { threshold: 2, shares: 3, random: seededRandom(61) })
  const b = splitSecret(secret, { threshold: 2, shares: 3, random: seededRandom(62) })
  assert.notDeepEqual(a.shares.map((share) => Array.from(share.y)), b.shares.map((share) => Array.from(share.y)))
  assert.equal(secretToHex(combineShares([b.shares[0], b.shares[2]], { commitment: b.commitment })), secretToHex(secret))
})

await check('string secrets and invalid options are handled', () => {
  const envelope = splitSecret('vault-passphrase', { threshold: 2, shares: 4, random: seededRandom(71) })
  assert.equal(Buffer.from(combineShares(envelope.shares.slice(1, 3), { commitment: envelope.commitment })).toString('utf8'), 'vault-passphrase')
  assert.throws(() => splitSecret('', { threshold: 2, shares: 2 }), (error) => error.code === 'BAD_SECRET')
  assert.throws(() => splitSecret('x', { threshold: 1, shares: 2 }), (error) => error.code === 'BAD_THRESHOLD')
  assert.throws(() => splitSecret('x', { threshold: 4, shares: 3 }), (error) => error.code === 'BAD_SHARE_COUNT')
  assert.throws(() => splitSecret('x', { threshold: 2, shares: 256 }), (error) => error.code === 'BAD_SHARE_COUNT')
})

console.log(`checks: ${passed}/${total}`)
