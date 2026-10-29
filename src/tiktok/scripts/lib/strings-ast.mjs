/**
 * Replace the bundle's string-decryption idiom with its decrypted literal.
 *
 * The SDK never stores a readable string. Every literal is a pair
 * `(ciphertext, key)` in the table `T`, decoded at run time by `m` and memoised
 * in `S` under the composite key `T[cipher] + ":" + T[key]`:
 *
 *   S[T[233] + ":" + T[3]] || (S[T[233] + ":" + T[3]] = m(T[233], T[3]))
 *
 * `scripts/05-strings.mjs` already proved, from the bytecode's own operands,
 * what每个 index decodes to (1041 of 1044 entries verified). This module spends
 * that knowledge: it rewrites the three syntactic shapes the decoder appears in
 * and leaves everything else untouched.
 *
 * Safety rules, all of which favour leaving code alone:
 *
 *   1. A call is only rewritten when its first argument is a numeric table slot
 *      with a verified plaintext. An unresolved pair stays a call.
 *   2. A memo guard is only collapsed to a literal when the guarded value is
 *      already a string literal — i.e. after rule 1 rewrote the decoder call.
 *   3. A memo *read* is only rewritten when its key expression contains exactly
 *      one ciphertext slot that has a verified plaintext. A key built from
 *      anything else stays a read.
 *
 * The result is the same value the interpreter would compute, just without the
 * cache. No string is invented: every literal emitted here is a `plain` field
 * from `tmp/strings.json`.
 */

/** Slots that are XOR keys rather than ciphertext, per `tmp/strings.md`. */
const KEY_SLOTS = new Set([1, 3, 5])

/** `T[<number>]` -> the number, else null. */
function tableSlot(node) {
  if (
    node &&
    node.type === 'MemberExpression' &&
    node.computed &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'T' &&
    node.property?.type === 'NumericLiteral'
  ) {
    return node.property.value
  }
  return null
}

/** `S[<key>]` -> the key expression, else null. */
function memoKey(node) {
  if (
    node &&
    node.type === 'MemberExpression' &&
    node.computed &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'S'
  ) {
    return node.property
  }
  return null
}

/**
 * First ciphertext slot inside a memo key expression.
 *
 * `T[a] + ":" + T[b]` is the canonical key; anything else that still contains a
 * single ciphertext slot (a `":"` prefix, a two-slot concatenation) resolves the
 * same way. When the expression mentions more than one ciphertext slot the
 * decode result is a different string than any single slot's plaintext, so it is
 * refused rather than guessed.
 */
function cipherSlotOf(keyExpr) {
  const slots = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    const slot = tableSlot(n)
    if (slot !== null) {
      slots.push(slot)
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v)
    }
  }
  walk(keyExpr)
  const ciphers = slots.filter((s) => !KEY_SLOTS.has(s))
  if (ciphers.length !== 1) return null
  return ciphers[0]
}

const literal = (value) => ({ type: 'StringLiteral', value })

/**
 * Rewrite the AST in place and return it.
 *
 * @param {object} ast Babel File node
 * @param {Record<string, string>} plainByIndex index -> decrypted string
 * @returns {object} the same File node, annotated with `stringSubstitutionReport`
 */
export function substituteStringIdioms(ast, plainByIndex) {
  const report = { decodeCalls: 0, memoGuards: 0, memoReads: 0, unresolved: 0 }
  const whole = ast.program

  const plainOf = (slot) => {
    const v = plainByIndex?.[slot]
    return typeof v === 'string' ? v : null
  }

  /**
   * Recursive rewrite, POST-ORDER: children are rewritten first, then the node
   * itself is considered.
   *
   * Order matters. A memo guard arrives as
   *
   *   S[key] || (S[key] = m(T[a], T[b]))
   *
   * and only becomes collapsible after the decoder call inside it has been
   * replaced by a literal. A pre-order walk visits the guard first, finds a call
   * rather than a literal, leaves it, and then rewrites the assignment *target*
   * `S[key]` into a string literal — producing `"text" = ...`, which does not
   * parse. Post-order avoids that class entirely.
   *
   * `noMemoRead` marks positions that must never be reduced to a literal: the
   * target of an assignment (where a literal is not an lvalue), and the
   * `++`/`--` operand.
   */
  function visit(node, noMemoRead = false) {
    if (!node || typeof node !== 'object') return node

    if (node.type === 'AssignmentExpression') {
      node.right = visit(node.right, false)
      node.left = visit(node.left, true)
      return node
    }
    if (node.type === 'UpdateExpression') {
      node.argument = visit(node.argument, true)
      return node
    }
    // A memo guard must be judged as a pair. Visiting its left side as an
    // ordinary read collapses `S[key]` to the literal before the guard rule can
    // compare the two keys, so the rule never fires and the assignment — the
    // only write to the memo — is left behind a literal that short-circuits it:
    // `"imul" || (S[c] = "imul")`. The left is therefore visited with
    // `noMemoRead` and rule 1 below decides the whole expression.
    if (node.type === 'LogicalExpression' && node.operator === '||') {
      node.left = visit(node.left, true)
      node.right = visit(node.right, false)
      const guardKey = memoKey(node.left)
      const guarded = node.right
      const assignmentKey = guarded?.type === 'AssignmentExpression' ? memoKey(guarded.left) : null
      if (
        guardKey &&
        assignmentKey &&
        JSON.stringify(guardKey) === JSON.stringify(assignmentKey) &&
        guarded.right?.type === 'StringLiteral'
      ) {
        report.memoGuards++
        return guarded
      }
      return node
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] && typeof v[i] === 'object' && typeof v[i].type === 'string') v[i] = visit(v[i], false)
        }
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        node[k] = visit(v, false)
      }
    }

    // 1. memo guard: `S[key] || (S[key] = "literal")` -> `(S[key] = "literal")`
    //
    // Keeping the assignment, rather than collapsing to the bare literal, is
    // what makes the rewrite sound for every *reader* of the memo. Collapsing
    // removed the only write, so a later `S[key]` whose key this pass could not
    // resolve read `undefined` — that is exactly how `Math.imul` became
    // `Math[undefined]` and threw. The assignment yields the same value as the
    // literal, so the expression's value is unchanged.
    if (node.type === 'LogicalExpression' && node.operator === '||') {
      const leftKey = memoKey(node.left)
      const right = node.right
      const rightKey = right?.type === 'AssignmentExpression' ? memoKey(right.left) : null
      if (
        leftKey &&
        rightKey &&
        JSON.stringify(leftKey) === JSON.stringify(rightKey) &&
        right.right?.type === 'StringLiteral'
      ) {
        report.memoGuards++
        return right
      }
    }

    // 2. decoder call: `m(T[<cipher>], T[<key>])` -> "plain"
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'm' &&
      node.arguments.length === 2
    ) {
      const slot = tableSlot(node.arguments[0])
      const plain = slot === null ? null : plainOf(slot)
      if (plain !== null) {
        report.decodeCalls++
        return literal(plain)
      }
      report.unresolved++
    }

    // 3. memo read: `S[T[<cipher>] + ":" + T[<key>]]` -> "plain"
    const key = memoKey(node)
    if (key) {
      if (noMemoRead) return node
      const slot = cipherSlotOf(key)
      const plain = slot === null ? null : plainOf(slot)
      if (plain !== null) {
        report.memoReads++
        return literal(plain)
      }
      report.unresolved++
    }

    return node
  }

  visit(whole)
  ast.stringSubstitutionReport = report
  return ast
}
