/**
 * Hand-written lifts for instructions the generic AST translator refuses.
 *
 * `15-lift.mjs` translates a handler by walking its own source against the
 * operand values the instruction carries. On this target it lifts every one of
 * the 7,564 distinct instruction shapes and refuses none, so this table is
 * empty on purpose: a lift added here would only be reachable by an opcode the
 * translator already handles, and a table that is never consulted cannot make
 * the output wrong.
 *
 * Keep it empty unless `15-lift.mjs` starts reporting `refused (opaque) > 0`.
 * When that happens, add the smallest entry that covers the refused shape and
 * record the opcode in the stage log — an invented lift is worse than an
 * honest `__native(opN, …)` call, which at least says it is unlifted.
 */

/** @type {Record<number, (operands: number[], t: unknown) => unknown[]>} */
export const NATIVE_LIFTS = Object.freeze({})
