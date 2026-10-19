/**
 * Declarations for the `ai4reverse-web/cli` subpath.
 *
 * The CLI entry point is also the `ai4reverse` bin. `main()` resolves once the
 * command finished and sets `process.exitCode` on failure: usage errors exit 2,
 * runtime failures exit 1.
 */

import type { SandboxSettleError } from './ai4reverse.js'

export declare function main(argv?: string[]): Promise<number | void>

/**
 * `settle` field of the JSON object printed by `ai4reverse run --json`.
 *
 * This is a projection of `SandboxRunRecord.settle`, not the record itself: the
 * loop counters and the classified stack breach are kept, the per-callback
 * bookkeeping stays in the API. `null` means the run never reached the event
 * loop, so nothing was observed — the same convention as `vm.detected: false`.
 *
 * `limitsHit` lists what the event loop hit (an empty list when nothing was
 * hit). A `'stack'` entry is the structured form of "a timer or promise
 * callback recursed past the stack limit": the script succeeded, so the run
 * stays `ok: true` while `disposal.skipped` is `true`.
 */
export interface RunSettleSummary {
  virtualMs?: number
  pendingTimers?: number
  jobs?: number
  /** Present only on a settle that was skipped, along with the `reason`. */
  skipped?: boolean
  reason?: string
  limitsHit?: string[]
  error: SandboxSettleError | null
}
