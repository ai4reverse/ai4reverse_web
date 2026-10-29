/**
 * The interpreter's fixed registers and how to recognise their declarations.
 *
 * `Y` seeds registers 0..6 before a single instruction runs: `null`,
 * `undefined`, `true`, `false`, the return sentinel, `this` and `arguments`.
 * The lift stage reproduces that as a declaration at the top of every function.
 *
 * Those declarations are load-bearing in a way ordinary temporaries are not. A
 * dead-store pass may delete a temporary whose value nobody reads; deleting one
 * of these leaves a name that *is* still read (the function's arguments and the
 * return slot are used precisely because they were seeded), and the function
 * throws `ReferenceError` on its first call instead of running.
 *
 * `22-nest.mjs` prefixes every register with its owning function (`f12_rUndef`),
 * so the check has to accept that prefix too.
 */

const FIXED = ['rNull', 'rUndef', 'rTrue', 'rFalse', 'rRet', 'rThis', 'rArgs']

const FIXED_SET = new Set(FIXED)

/** `f12_rUndef` -> `rUndef`; `rArgs` -> `rArgs`; anything else -> null. */
export function prologueName(name) {
  if (typeof name !== 'string') return null
  if (FIXED_SET.has(name)) return name
  const match = /^f\d+_(r[A-Za-z]\w*)$/.exec(name)
  if (match && FIXED_SET.has(match[1])) return match[1]
  return null
}

/** True when this identifier names one of the seeded registers. */
export function isPrologueRegister(name) {
  return prologueName(name) !== null
}

/** True when the whole declarator list is prologue-only (never removable). */
export function isPrologueDeclarator(declarator) {
  return declarator?.id?.type === 'Identifier' && isPrologueRegister(declarator.id.name)
}
