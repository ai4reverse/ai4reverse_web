import { parse } from './parse.js'
import { generate } from './generate.js'
import { runPass } from './pass-context.js'
import { selectPasses, listPasses, PASSES } from './passes/index.js'
import { hashObject, sha256 } from '../util/hash.js'

/**
 * Unified code restoration pipeline: one parse, one transform pass chain, one
 * generate. All passes mutate the same Babel AST, so output formatting and
 * escape handling are decided in exactly one place (`generate.js`).
 *
 * The pipeline is deliberately conservative: a pass that cannot prove a
 * transformation is safe leaves the node alone and records a note. Every
 * change is attributable to a pass id, which is what makes the restored code
 * usable as forensic evidence.
 */
export function restore(code, options = {}) {
  const {
    filename,
    sourceType,
    logger,
    maxRounds = 2,
    passOptions = {},
    generateOptions = {},
    strict = false,
    stopOnNoChange = true,
    hooks = null,
    ...selection
  } = options

  const started = Date.now()
  const parsed = parse(code, { sourceType: sourceType ?? 'script', filename })

  // AST-level hook point: plugins may transform the tree before any pass runs.
  // The hook must return a Babel AST (mutating in place is also supported).
  if (hooks?.pipeline) {
    const transformed = hooks.pipeline('ast:transform', parsed.ast, { filename, sourceType: parsed.sourceType })
    if (transformed.value && transformed.value !== parsed.ast && transformed.value.program) {
      parsed.ast = transformed.value
    }
  }

  const passes = selectPasses(selection)
  /** @type {object[]} */
  const reports = []
  let changedAny = false
  let rounds = 0

  for (let round = 1; round <= Math.max(1, maxRounds); round += 1) {
    rounds = round
    let changedThisRound = false
    for (const pass of passes) {
      // `rename` is cosmetic and expensive; only run it on the final round.
      if (pass.meta.id === 'rename' && round < Math.max(1, maxRounds)) continue
      const result = runPass(pass, parsed.ast, {
        logger,
        passOptions: { ...passOptions, round },
        strict,
      })
      reports.push({ ...result, round })
      if (result.changed) changedThisRound = true
    }
    if (changedThisRound) changedAny = true
    if (!changedThisRound && stopOnNoChange) break
  }

  // `rename` is deferred to the final round, which may never be reached when an
  // earlier round makes no changes (e.g. `only: ['rename']`).
  const renamePass = passes.find((pass) => pass.meta.id === 'rename')
  if (renamePass && !reports.some((report) => report.id === 'rename')) {
    const result = runPass(renamePass, parsed.ast, { logger, passOptions, strict })
    reports.push({ ...result, round: Math.max(1, rounds) })
    if (result.changed) changedAny = true
  }

  const generated = generate(parsed.ast, String(code), generateOptions)
  const beforeHash = sha256(String(code))
  const afterHash = sha256(generated.code)

  return {
    code: generated.code,
    map: generated.map,
    sourceType: parsed.sourceType,
    parseErrors: parsed.errors,
    passes: mergePassReports(reports),
    rounds,
    changed: changedAny || generated.code !== String(code),
    stats: {
      durationMs: Date.now() - started,
      inputBytes: String(code).length,
      outputBytes: generated.code.length,
      passCount: passes.length,
      changedPasses: reports.filter((report) => report.changed).length,
      beforeHash,
      afterHash,
      fingerprint: hashObject({ beforeHash, afterHash, passes: reports.map((report) => report.id) }),
    },
    selection: passes.map((pass) => pass.meta.id),
  }
}

/**
 * Collapse repeated pass runs across rounds into one entry per pass.
 * @param {object[]} reports
 */
function mergePassReports(reports) {
  const byId = new Map()
  for (const report of reports) {
    const existing = byId.get(report.id)
    if (!existing) {
      byId.set(report.id, {
        id: report.id,
        changed: report.changed,
        notes: [...(report.notes ?? [])],
        durationMs: report.durationMs ?? 0,
        rounds: [report.round],
        error: report.error ?? null,
      })
      continue
    }
    existing.changed = existing.changed || report.changed
    existing.notes.push(...(report.notes ?? []))
    existing.durationMs += report.durationMs ?? 0
    existing.rounds.push(report.round)
    if (report.error) existing.error = report.error
  }
  return [...byId.values()].map((entry) => ({
    ...entry,
    notes: [...new Set(entry.notes)].slice(0, 200),
  }))
}

/**
 * Run a single named pass against source (used by tests and the CLI).
 * @param {string} id
 * @param {string} code
 * @param {object} [options]
 */
export function restoreWithPass(id, code, options = {}) {
  return restore(code, { ...options, only: [id], maxRounds: 1 })
}

export { parse, generate, listPasses, PASSES }
export { selectPasses } from './passes/index.js'
