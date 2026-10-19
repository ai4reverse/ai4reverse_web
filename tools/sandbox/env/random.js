import { createSeededRandom } from '../../util/random.js'

/**
 * Deterministic `Math.random`.
 *
 * Real browsers expose a CSPRNG-backed PRNG; a sandbox must expose a *seeded*
 * one so the same sample produces the same trace. Malware frequently derives
 * C2 identifiers, padding and XOR keys from `Math.random`, so reproducibility is
 * an analysis requirement, not a nicety.
 *
 * The replacement is a host function: identical `name`, `length` and
 * `[native code]` source, indistinguishable from the engine's implementation.
 */

export const meta = { id: 'random', order: 28, requires: ['globals'] }

export function install(bridge) {
  const { ctx, profile } = bridge
  const rng = createSeededRandom(`${profile.seed}::math.random`)
  const math = ctx.getProp(ctx.global, 'Math')
  if (!math || math.disposed) throw new Error('Math is unavailable; cannot seed Math.random')
  const random = bridge.fn('random', 0, () => ctx.newNumber(rng.next()))
  bridge.install(math, 'random', random, {
    enumerable: false,
    configurable: true,
    writable: true,
  })
  math.dispose()
  bridge.emit('sandbox', 'emit', { event: 'math.random.seeded', seed: profile.seed })
}
