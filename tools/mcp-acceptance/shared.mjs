/**
 * Shared helpers for the MCP acceptance gate.
 *
 * Everything here is deliberately small and dependency-free: the gate must run
 * on a bare Node install inside a sandbox, with `rg`, `git` and `sqlite3` as
 * its only external tools. A helper that throws on a missing binary would turn
 * an unavailable adapter into a failed acceptance, which is the opposite of
 * what we want.
 */
import { spawnSync } from 'node:child_process'

/**
 * Run a command and capture its output without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, timeout?: number}} [options]
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string}}
 */
export const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd,
    input: options.input,
  })
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Run a command and throw with stderr on failure.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, timeout?: number}} [options]
 * @returns {string}
 */
export const runOrThrow = (command, args, options = {}) => {
  const result = run(command, args, options)
  if (!result.ok) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

/**
 * Split NUL-delimited output, dropping the empty tail.
 *
 * @param {string} text
 * @returns {string[]}
 */
export const splitNul = (text) => text.split('\0').filter((entry) => entry.length > 0)

/**
 * Parse `--key value` and `--flag` arguments.
 *
 * @param {string[]} argv
 * @param {Record<string, string>} defaults
 * @returns {Record<string, string|boolean>}
 */
export const parseArgs = (argv, defaults = {}) => {
  const out = { ...defaults }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Chosen over the normal approximation because the gate routinely reports
 * proportions at 0 or 1, where the normal interval is meaningless.
 *
 * @param {number} successes
 * @param {number} total
 * @param {number} [z] 1.96 for 95 %
 * @returns {{p: number, low: number, high: number}}
 */
export const wilson = (successes, total, z = 1.96) => {
  if (total === 0) return { p: 0, low: 0, high: 0 }
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))
  return {
    p,
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  }
}

/**
 * Deterministic PRNG so a gold sample can be re-derived byte-for-byte.
 *
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
export const mulberry32 = (seed) => {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Take a deterministic sample without replacement.
 *
 * @template T
 * @param {T[]} items
 * @param {number} count
 * @param {number} seed
 * @returns {T[]}
 */
export const sample = (items, count, seed) => {
  const random = mulberry32(seed)
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = copy[index]
    copy[index] = copy[swap]
    copy[swap] = held
  }
  return copy.slice(0, Math.min(count, copy.length))
}

/**
 * Resolve the codebase-memory index for a repository root.
 *
 * The server names its databases after the absolute path with separators
 * flattened to dashes, so this is derivable without asking the server.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export const indexDbPath = (repoRoot) => {
  const flattened = repoRoot.replace(/^\//, '').replace(/[\\/]/g, '-')
  return `${process.env.HOME ?? ''}/.cache/codebase-memory-mcp/${flattened}.db`
}
