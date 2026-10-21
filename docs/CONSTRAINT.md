# Constraint solving (`tools/constraint/`)

A z3-backed static component for questions restoration cannot answer
syntactically:

- Is this branch condition constant for every input?
- Is this `if` arm reachable at all?
- What input satisfies these conditions?
- Are two expressions equivalent in the modeled domain?
- What is z3's normal form for this bitwise/MBA expression?

It never executes the sample. It parses, translates the selected JS fragment to
z3 terms, and reports `sat` / `unsat` / `unknown` with the assumptions it used.
`unknown` is a first-class answer: a solver timeout is never reported as a
proof.

## Module map

| File | Responsibility |
| --- | --- |
| `z3.js` | Lazy, process-wide `z3-solver` WASM load; private contexts; decision predicate. |
| `translate.js` | Babel AST → z3 terms, sort/purity/exactness tracking, atom sharing, deterministic names. |
| `solve.js` | `solveConstraints`, `provePredicate`, `proveEquivalent`, `simplifyExpression`, expression parsing, model reading. |
| `analyze.js` | Composed static analysis: candidate collection, opaque predicates, path feasibility, simplifications, budgets. |
| `limits.js` | `CONSTRAINT_LIMITS` and `normalizeConstraintLimits`. |
| `errors.js` | `ConstraintError`, `ConstraintSyntaxError`, `ConstraintUnsupportedError`. |
| `render.js` | Human-readable projection used by the CLI. |
| `index.js` | Subpath barrel (`ai4reverse-web/constraint`). |

The root barrel exports `analyzeConstraints`, `solveConstraints`,
`provePredicate`, `proveEquivalent`, `simplifyExpression`,
`renderConstraintReport` and `CONSTRAINT_LIMITS`.

## Soundness model

The translator tracks four independent flags on every term:

| Flag | Meaning |
| --- | --- |
| `exact` | The term captures the JS value/truth value for **every** input. |
| `nanSafe` | `NaN` cannot change the result of the surrounding operation. |
| `integral` | Every numeric value in the term is an integer. |
| `pure` | Evaluating the source expression twice yields the same value. |

`analyzeConstraints()` only claims an opaque predicate or an unreachable branch
when the translated condition is `exact`. That matters because z3 `Int` is not
a JS number:

- `x !== x` is **not** claimed always-false. It is `false` for ordinary
  numbers and `true` for `NaN`; the translator models the equality as a
  deterministic boolean atom and reports `contingent`.
- `x + 1 > x` is **not** proven by default. It is a valid integer identity but
  may change for `Infinity`, `NaN` or a rounded double. Pass
  `assumeIntegers: true` to opt into the integer model; the finding then carries
  `assumptions: ["integers"]`.
- `x % 1 === 0` is an integer identity, not a JS identity (fractional values
  exist). It is likewise gated behind `assumeIntegers`.

The exact fragment is larger than it looks:

- `& | ^ ~ << >>` are translated through signed 32-bit bit-vectors, and `| 0`
  is `ToInt32`. These are exact for primitive values, including strings, `NaN`
  and `Infinity`. An object's `ToPrimitive`/`valueOf` call is not modelled: the
  translator never runs it, so an object with a side-effecting coercion is
  outside the exact fragment.
- `>>>` is converted back to an unsigned integer.
- `!`, `&&`, `||`, `?:`, `typeof`, and equality/comparison of exact values are
  exact. A `&&`/`||`/`?:` operand yields the **operand value** rather than a
  boolean, so a term derived from truthiness is marked as such and stays
  `contingent` when compared across sorts even though the comparison itself is
  exact.
- Cross-type equality is decided from literals and from exact numeric operands:
  `1 === true`, `1 == true`, `null == undefined`, `null === undefined` and
  `typeof x === '<non-tag>'` are claimed outright. `x === 'a'` and
  `x === undefined` are decided only under `assumeIntegers`/`assumeInt32`,
  where a symbol is declared to denote a number.
- Identifiers carry two independent interpretations: an unbounded `Int` for
  arithmetic and a 32-bit vector for bitwise operators. They are independent by
  default, which over-approximates the program (sound for validity proofs). With
  `assumeInt32: true` they are tied together through `BV2Int`, which makes model
  values coherent for bitwise constraints.
- A construct outside the fragment becomes an uninterpreted symbol per AST node
  (or one shared atom per pure expression/equality pair). An arbitrary boolean
  over-approximates any boolean-valued expression, so `p || !p` is still proven
  without pretending `p` has a known value. An arbitrary `Int`/`String` is never
  marked exact.

Fresh z3 names are unique for the lifetime of a context. Reusing `b0`/`eq0`
between two path conditions would conflate unrelated predicates and could turn a
reachable branch into a false `unsat`.

### Assumptions

| Option | Domain | Reported as |
| --- | --- | --- |
| none (default) | exact JS fragment | `assumptions: []` |
| `assumeIntegers: true` | symbolic numbers are integers (no fractions, `NaN`, `Infinity`) | `["integers"]` |
| `assumeInt32: true` | symbolic numbers are signed 32-bit integers; Int/BitVec tied | `["int32"]` (plus `"integers"` when both are set) |
| `assumeInt32: false` on `solveConstraints` | unbounded Int model; `modelBitVec` carries the vector interpretation | `["integers"]` |

`solveConstraints` chooses the domain automatically when `assumeInt32` is not
given: arithmetic-only constraints use the unbounded Int model (fast nonlinear
queries, plain integer models), while a constraint containing `& | ^ ~ << >>`
uses the tied int32 model so one `x` explains both interpretations. A model is
returned only when it is coherent (`modelSafe: true`); otherwise `model` is
`null` and, for bitwise constraints, `modelBitVec` still carries the vector
interpretation.

`analyzeConstraints` defaults to no assumptions. `solveConstraints` defaults to
`assumeInt32` so a returned model is one coherent assignment rather than two
unrelated interpretations.

## API

### Analyze a source

```js
import { analyzeConstraints } from './tools/constraint/index.js'

const report = await analyzeConstraints(source, {
  filename: 'loader.js',
  assumeIntegers: false,       // default: sound exact fragment only
  timeoutMs: 500,             // per query
  budgetMs: 5000,             // whole analysis
  maxPredicates: 200,
})

report.stats.opaque            // proven-constant conditions
report.opaquePredicates        // [{kind, role, line, column, text, variables, ...}]
report.unreachableBranches     // [{kind, path: [...], proof: 'unsat-path'}]
report.simplifications         // z3 normal forms with an equivalence check
report.truncated               // a candidate or time bound was hit
```

Candidate roles: `if-test`, `conditional-test`, `while-test`, `do-while-test`,
`for-test`, `logical`. Unreachable arms: `if-consequent`, `if-alternate`.
`enclosingConditions()` walks outward to the nearest function boundary and adds
`if`/ternary polarity, `&&`/`||` short-circuit facts, and `while`/`for` guards.
A `do...while` guard is deliberately not a path condition: it is evaluated after
the first iteration.

The solver shares one identifier symbol across a path only when the code before
the arm cannot change it. A preceding assignment/update/call, an enclosing
condition test with side effects, a loop body (a later iteration can change the
value), a property read (a getter), or a `try` block before a `catch`/`finally`
disables sharing; each condition is then translated with fresh symbols. In the
default (no numeric assumption) mode, an arithmetic/bitwise/relational
expression before the arm is also treated as a potential `valueOf`/`toPrimitive`
call and disables sharing; `assumeIntegers`/`assumeInt32` make those operations
safe. That is weaker but never turns a reachable arm into a false `unsat`.
`pathHasMutation()` is the conservative gate; function/method bodies and
instance field initializers are not scanned because defining them does not run
them, while static blocks/static field initializers are scanned because they
execute at class definition.

### Extract path conditions

```js
import { collectPathConditions, solveConstraints } from './tools/constraint/index.js'

const paths = collectPathConditions(`if (a) { if (b) { run() } }`)
paths.branches[1].consequent
// [ { text: 'a', truth: true, ... }, { text: 'b', truth: true, ... } ]

await solveConstraints(['a', '!b']) // asks whether that arm is reachable
```

`collectPathConditions` is the syntactic half of branch feasibility: enclosing
`if`/ternary polarity, short-circuit facts and loop guards, with each condition's
positive/negative `truth`. It does not run z3; pass the texts to
`solveConstraints()` (or call `analyzeConstraints()` for the solved report).

### Prove a predicate

```js
import { provePredicate } from './tools/constraint/index.js'

await provePredicate('(x & 1) === 0 || (x & 1) === 1')
// { status: 'always-true', proved: true, exact: true, assumptions: [] }

await provePredicate('x + 1 > x', { assumeIntegers: true })
// { status: 'always-true', assumptions: ['integers'] }

await provePredicate('x > 5', { assumeIntegers: true })
// { status: 'contingent', model: { x: 6 }, counterexample: { x: 0 } }
```

Statuses: `always-true`, `always-false`, `contingent`, `unknown`,
`unsupported`, `error`. A contingent result carries both a model (makes it
true) and a counterexample (makes it false) when `modelSafe:true`. When the
translation used an uninterpreted atom, a `typeof` tag or an unlinked bit-vector
interpretation, the boolean result is still sound but `model`/`counterexample`
are `null`: the solver assignment would not be a witness for the real JS
expression. The same rule gates `model` in `solveConstraints` and
`counterexample` in `proveEquivalent`.

### Solve constraints

```js
import { solveConstraints, solvePredicate } from './tools/constraint/index.js'

const result = await solveConstraints(['x * 2 === 42'])
// { status: 'sat', modelSafe: true, model: { x: 21 }, assumptions: ['integers'] }

await solveConstraints(['x > 10', 'x < 5'], { assumeIntegers: true })
// { status: 'unsat', model: null, ... }

await solvePredicate('(x & 1) === 1')
// model.x and modelBitVec.x have bit 0 set
```

Constraints may be source strings or `{ node, scope }` objects. Each is
translated as a JS condition (truthiness applies). Model values are JSON-safe:
BigInts become numbers when safe and decimal strings otherwise.

### Equivalence and simplification

```js
import { proveEquivalent, simplifyExpression } from './tools/constraint/index.js'

await proveEquivalent('x + y', 'y + x', { assumeIntegers: true })
// { status: 'equivalent', equivalent: true, proved: true }

await proveEquivalent('x + y', 'y + x')
// { status: 'equivalent', equivalent: true, proved: false, exact: false }
// equivalent in the integer model, but not a JS proof (integers were not assumed)

await proveEquivalent('x + 1', 'x + 2', { assumeIntegers: true })
// { status: 'different', counterexample: { x: 0, y: 1 } }

await simplifyExpression('(x & 1) === 0 || (x & 1) === 1')
// { simplified: '(or (= ((_ extract 0 0) v_x_bv) #b0) ...)',
//   equivalent: true, verification: 'unsat-negation' }
```

`simplifyExpression` defaults to the integer model (`assumeIntegers:true`) and
returns z3's SMT-LIB normal form, not reconstructed JS. `proved` is true only
when the translated term is exact; a model equivalence still reports
`equivalent:true` with `proved:false`.
Generating JS from a z3 AST would reintroduce the precedence/coercion guesses
the component exists to avoid. The result is checked by asking z3 whether
`original === simplified` can be false.

### Translate directly

```js
import { createZ3Context } from './tools/constraint/z3.js'
import { createTranslator, parseExpression } from './tools/constraint/index.js'

const { api, context } = await createZ3Context('my-analysis')
const translator = createTranslator(api, context, { assumeIntegers: false })
const node = parseExpression('(x & 1) === 0')
const translated = translator.translateConditionSafe(node)
translated.expr.toString()
```

`translateConditionSafe` never throws for an unsupported expression; only the
structural budget (`maxDepth`, `maxNodes`) yields `supported: false`.

## Report integration

`analyzeSample()` runs `analyzeConstraints()` unless `constraints: false` is
passed. The result appears as:

- `result.constraint` — the raw component report;
- `report.static.constraint` — a normalized, additive section with every key
  present (`enabled`, `ok`, `parse`, `stats`, `opaquePredicates`,
  `unreachableBranches`, `simplifications`, `assumptions`, `truncated`, `notes`,
  `error`, `limits`);
- a `## Constraint solving` section in the Markdown rendering.

Constraint findings are **evidence**, not verdict weights. They do not silently
move the weighted score: the example/product contracts pin their expected
levels, and an analyst reads the finding and its proof. `elapsedMs` is host
timing, so the normalized report writes `0` there and the report stays
deterministic.

## CLI

```bash
node tools/cli.js constraint sample.js
node tools/cli.js constraint sample.js --json
node tools/cli.js constraint sample.js --assume-integers
node tools/cli.js constraint sample.js --assume-int32 --timeout 1000
```

`--json` emits the full report; otherwise the renderer prints bounded tables.
Exit code `0` when the analysis ran, `1` when it failed, `2` for a usage error
(including `--assume-*` on any other command).

## Budgets and failure modes

`CONSTRAINT_LIMITS` bounds candidates, branches, path depth, expression depth,
expression nodes, per-query z3 `rlimit` (deterministic resource units),
per-query timeout, total solver time, finding text and finding count. The
`rlimit` is the deterministic budget; the wall-clock timeout is a host safety
net, so a timeout-driven `unknown` is reported rather than hidden. A bound that trips sets `truncated: true` and a note; it never turns into
a partial proof.

Limits may be passed either as a nested `limits` object or as top-level keys on
the same options bag. `solveConstraints()`, `provePredicate()`,
`proveEquivalent()` and `simplifyExpression()` honour both: the nested object
wins for most keys, while a top-level `timeoutMs` or `solverRlimit` wins over
the nested value. `analyzeConstraints()` merges the two bags with the same
top-level preference, and `collectPathConditions()` accepts only the nested
form.

- **No z3 load:** the analysis returns `ok:false` with an `error.message`; the
  rest of `analyzeSample()` continues.
- **Solver timeout:** `unknown`; not counted as `proven`.
- **Unsupported expression:** counted in `stats.unsupported`; no finding.
- **Inexact term:** not proven unless `assumeIntegers` is set.
- **Parse failure:** reported in `parse.errors`; malformed source does not throw.

## Known limitations

- No modeling of arrays, objects, strings beyond literals/concatenation,
  closures, prototypes or property reads. Such leaves are uninterpreted.
- Relational string comparison (`<`, `<=`, `>`, `>=`) is only exact for ASCII
  literals: JS compares UTF-16 code units and z3 compares code points, which
  differ for astral characters. String equality and concatenation are exact.
- No heap/alias analysis: assignments are not threaded through path conditions.
  Path constraints are therefore weaker than a full symbolic executor; an
  `unsat` answer is still sound, but reachable branches may stay unproven.
- Global reassignment is not tracked. `Math` is assumed to be the intrinsic
  unless it is lexically shadowed; `undefined`, `NaN` and `Infinity` are read as
  globals unless a binding shadows them.
- No floating-point sort: arithmetic is integer or 32-bit bit-vector. Fractional
  and `NaN` behavior is excluded by default and assumed away by
  `assumeIntegers`.
- No loop unrolling or inductive invariants. Loop guards are path conditions for
  the body, not a summary of the loop.
- z3 may return `unknown` for mixed `Int`/`BV2Int` arithmetic; the result says so
  rather than guessing.
- Exceptions and side effects are not modeled. A condition proven constant is
  constant when it evaluates without an effect that changes its operands; an
  expression that throws (a getter, `Symbol.toPrimitive`, a shadowed `Math`
  method called through a proxy) or whose repeated `valueOf` calls return
  different values is outside that statement. In the default mode a bitwise
  predicate therefore assumes deterministic primitive coercion; a preceding
  potential coercion disables path-symbol sharing.
- `proveEquivalent` compares values in the modeled domain. A JS expression that
  depends on coercion, `valueOf`, getters or exceptions is outside that domain.

## Verification

`tests/constraint.test.js` covers opaque predicates, the `NaN` reflexivity
counterexample, the integer-assumption gate, `typeof` tags, sat models,
unsat paths, contingent results, equivalence/simplification verification, fresh
name isolation across path conditions, determinism, report integration, the
disabled shape, the renderer and the CLI. `tests/types.test.js` and
`tests/api-surface.test.js` pin the subpath and declarations.
