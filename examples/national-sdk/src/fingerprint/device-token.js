/**
 * Device identity.
 *
 * The token is `HMAC-SM3(master, hardwareHash)`, where `master` comes from a
 * 32-byte install secret generated once per device. The secret is stored
 * *sealed by the implicit-key white-box SPN* (see `sealLocal`), so a copy of
 * localStorage does not yield a usable token and a different device profile
 * cannot recompute it.
 *
 * Persisted state also carries the previous fingerprint, which lets the SDK
 * report drift ("same token, different GPU") instead of silently minting a new
 * identity. Losing the state is not fatal: the SDK regenerates a secret and
 * flags `recovered: true` so the server can treat the session as a new device.
 */

import { hmacSm3, kdfSm3 } from '../core/hash.js'
import { bytesToUtf8, fromHex, radixEncode, toHex, utf8ToBytes } from '../core/bytes.js'
import { gatherEntropy } from '../core/prng.js'
import { openLocal, sealLocal } from '../core/hybrid.js'
import { collectFingerprint } from './collectors.js'
import { canonicalize, compareFingerprints, hashFingerprint } from './canonical.js'

const TOKEN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * @param {object} [scope]
 * @param {string} [namespace]
 */
export function createStorage(scope, namespace = 'nsdk') {
  const root = scope ?? (typeof globalThis !== 'undefined' ? globalThis : {})
  const keyOf = (name) => `${namespace}.${name}`
  const memory = new Map()
  let local = null
  try {
    const candidate = root.localStorage
    if (candidate && typeof candidate.getItem === 'function') {
      candidate.setItem(keyOf('__probe__'), '1')
      candidate.removeItem(keyOf('__probe__'))
      local = candidate
    }
  } catch {
    local = null
  }
  return {
    kind: local ? 'localStorage' : 'memory',
    usable: Boolean(local),
    get(name) {
      try {
        if (local) return local.getItem(keyOf(name))
      } catch {
        /* fall through to memory */
      }
      return memory.has(keyOf(name)) ? memory.get(keyOf(name)) : null
    },
    set(name, value) {
      const text = String(value)
      if (local) {
        try {
          local.setItem(keyOf(name), text)
          return true
        } catch {
          /* quota or privacy mode */
        }
      }
      memory.set(keyOf(name), text)
      return false
    },
    remove(name) {
      try {
        if (local) local.removeItem(keyOf(name))
      } catch {
        /* ignore */
      }
      memory.delete(keyOf(name))
    },
  }
}

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../guard/probe.js').createProbe>} options.probe
 * @param {ReturnType<typeof createStorage>} [options.storage]
 * @param {{keystream: (iv: Uint8Array, length: number) => Uint8Array}} options.spn
 * @param {{seal: Function, open: Function}} [options.vault] white-box vault
 * @param {string} [options.namespace]
 * @param {Uint8Array} [options.installSecret] explicit secret (tests/provisioning)
 */
export function createDeviceIdentity(options) {
  const probe = options.probe
  const spn = options.spn
  const vault = options.vault ?? null
  if (!spn && !vault) throw new TypeError('device identity requires a white-box SPN instance or a vault')
  const storage = options.storage ?? createStorage(probe.scope, options.namespace ?? 'nsdk')
  const namespace = options.namespace ?? 'nsdk'

  const collected = collectFingerprint(probe)
  const hashes = hashFingerprint(collected.fields, collected.stability)

  const stateKey = 'device.state'
  let state = null
  let recovered = false
  let openedSuite = null
  const stored = storage.get(stateKey)
  if (stored) {
    try {
      const envelope = JSON.parse(stored)
      openedSuite = envelope.suite ?? null
      const plaintext = vault ? vault.open(envelope) : openLocal(envelope, { spn })
      state = JSON.parse(bytesToUtf8(plaintext))
    } catch {
      state = null
      recovered = true
    }
  }

  if (!state || !state.secretHex) {
    const entropy = options.installSecret
      ? { bytes: Uint8Array.from(options.installSecret), source: 'provisioned' }
      : gatherEntropy(32, probe.scope)
    state = {
      version: 1,
      secretHex: toHex(entropy.bytes),
      createdAt: Date.now(),
      seen: 0,
      entropySource: entropy.source,
      fields: hashes.hardware,
      stableHash: hashes.stableHash,
    }
    recovered = Boolean(stored)
  }

  const master = kdfSm3(fromHex(state.secretHex), `nsdk/device/v1/${namespace}`)
  const kid = toHex(hmacSm3(master, utf8ToBytes('kid'))).slice(0, 16)
  const mac = hmacSm3(master, utf8ToBytes(hashes.hardwareHash))
  const token = radixEncode(mac.subarray(0, 18), TOKEN_ALPHABET)
  const previous = state.fields ?? null
  const drift = compareFingerprints(previous, hashes.hardware, collected.stability)
  const seen = Number(state.seen ?? 0) + 1

  // Persist sealed state. The nonce is fresh so two saves cannot reuse the
  // keystream; the envelope is authenticated, so a tampered copy is rejected
  // and becomes a recovered identity.
  const nonce = gatherEntropy(16, probe.scope).bytes
  const statePayload = JSON.stringify({
    version: 1,
    secretHex: state.secretHex,
    createdAt: state.createdAt,
    seen,
    entropySource: state.entropySource,
    fields: hashes.hardware,
    stableHash: hashes.stableHash,
    lastSeen: Date.now(),
  })
  const envelope = vault
    ? vault.seal(statePayload, { nonce })
    : sealLocal(statePayload, { spn, nonce, kid })
  storage.set(stateKey, JSON.stringify(envelope))

  const identity = {
    token,
    kid,
    hardwareHash: hashes.hardwareHash,
    softwareHash: hashes.softwareHash,
    stableHash: hashes.stableHash,
    fields: collected.fields,
    stability: collected.stability,
    coverage: collected.coverage,
    drift,
    recovered,
    seen,
    createdAt: state.createdAt,
    entropySource: state.entropySource ?? 'unknown',
    storage: storage.kind,
    vaultSuite: envelope.suite ?? openedSuite,
    /** Public description: never includes the install secret. */
    describe() {
      return {
        token: identity.token,
        kid: identity.kid,
        hardwareHash: identity.hardwareHash,
        softwareHash: identity.softwareHash,
        drift: identity.drift,
        recovered: identity.recovered,
        storage: identity.storage,
        vaultSuite: identity.vaultSuite,
        coverage: identity.coverage,
        fields: identity.fields,
        stability: identity.stability,
      }
    },
    /** Canonical stable fingerprint (safe to log server-side). */
    canonical() {
      return canonicalize({ hardware: hashes.hardware, software: hashes.software })
    },
  }
  return identity
}
