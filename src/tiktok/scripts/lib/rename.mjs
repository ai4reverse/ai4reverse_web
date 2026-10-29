/**
 * Register naming — deliberately deferred, and why.
 *
 * `17-final.mjs` calls `nameRegisters(fn)` per function to give `r<N>` locals a
 * name describing what they hold. On this target that rename cannot run here
 * without breaking a later stage, so this module reports zero renames and
 * documents the constraint instead of guessing.
 *
 * The conflict
 * ------------
 * The seven prologue registers are already named by the lift stage
 * (`rThis`, `rArgs`, `rRet`, `rNull`, `rUndef`, `rTrue`, `rFalse`) because `Y`'s
 * prologue fixes their meaning. Every other register is a plain temporary with
 * no stable meaning — the same index holds a different value in each basic
 * block.
 *
 * Function nesting (`22-nest.mjs`) runs *after* this stage and needs to make
 * every register name unique per function (`r7` -> `f12_r7`) so that a nested
 * child can capture an ancestor's variable by name. It recognises registers by
 * the pattern `^(r\d+|mod\d+|rArgs|rRet|rThis|rUndef|rNull|rTrue|rFalse)$`.
 *
 * A descriptive name produced here (`callee`, `flag`, `text3`) would not match
 * that pattern, would not be made unique, and two functions using the same word
 * would collide the moment one is nested inside the other — a silent behaviour
 * change on the very axis this project is trying to prove. Renaming before
 * nesting is therefore unsafe.
 *
 * The naming that *is* sound after nesting is done by `scripts/24-name-final.mjs`,
 * which runs on the nested tree where every name is already function-qualified.
 */

/**
 * No-op rename hook kept so `17-final.mjs` can report the deferral explicitly.
 *
 * @param {object} _fn Babel FunctionDeclaration node
 * @returns {{renamed: number, deferred: string}}
 */
export function nameRegisters(_fn) {
  return { renamed: 0, deferred: '24-name-final.mjs' }
}
