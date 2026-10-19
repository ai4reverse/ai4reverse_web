import { parse } from './parse.js'
import { generate } from './generate.js'
import { runPass } from './pass-context.js'
import { selectPasses, listPasses, isDeferredPass, PASSES } from './passes/index.js'
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
      // Cosmetic/expensive passes (`rename`) are deferred to the final round.
      if (isDeferredPass(pass) && round < Math.max(1, maxRounds)) continue
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

  // A deferred pass runs in the final round, which may never be reached when an
  // earlier round makes no changes (e.g. `only: ['rename']`).
  const deferred = passes.find(isDeferredPass)
  if (deferred && !reports.some((report) => report.id === deferred.meta.id)) {
    const result = runPass(deferred, parsed.ast, { logger, passOptions, strict })
    reports.push({ ...result, round: Math.max(1, rounds) })
    if (result.changed) changedAny = true
  }

  const generated = generate(parsed.ast, String(code), generateOptions)
  // Never hand back code that does not parse: a pass is allowed to be wrong,
  // the pipeline is not. The input source is the only honest fallback.
  const validation = checkOutput(generated.code, { sourceType: parsed.sourceType, filename })
  const outputCode = validation.ok ? generated.code : String(code)
  const beforeHash = sha256(String(code))
  const afterHash = sha256(outputCode)
  const notes = validation.ok
    ? []
    : [`output validation failed (${validation.error.message}); returned the input source unchanged`]

  return {
    code: outputCode,
    map: validation.ok ? generated.map : null,
    sourceType: parsed.sourceType,
    parseErrors: parsed.errors,
    passes: mergePassReports(reports),
    rounds,
    changed: validation.ok && (changedAny || generated.code !== String(code)),
    outputValid: validation.ok,
    outputError: validation.ok ? null : { message: validation.error.message },
    notes,
    stats: {
      durationMs: Date.now() - started,
      inputBytes: String(code).length,
      outputBytes: outputCode.length,
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
 * Validate generated restoration output by re-parsing it with the same parser
 * the pipeline uses. Restored code is forensic evidence, so the check is a
 * strict parse: text that only parses after babel's error recovery is rejected.
 *
 * @param {string} code - generated source to validate
 * @param {object} [options]
 * @param {'script'|'module'|'unambiguous'} [options.sourceType]
 * @param {string} [options.filename]
 * @returns {boolean} true when `code` parses cleanly
 */
export function validateOutput(code, options = {}) {
  return checkOutput(code, options).ok
}

/**
 * Detailed form of `validateOutput`: the pipeline needs the message to report
 * why the generated code was rejected.
 *
 * The check is a strict re-parse (`errorRecovery: false`) in both source types:
 * `parse()` is tolerant by design, and recovery means the text contains a
 * syntax error even though babel kept going. "Generated code that only parses
 * after recovery" is exactly the code this gate must refuse to return.
 *
 * @param {string} code
 * @param {object} [options]
 * @returns {{ok: boolean, error: {message: string} | null}}
 */
function checkOutput(code, options = {}) {
  const { sourceType = 'unambiguous', filename } = options
  try {
    parse(String(code), { sourceType, filename, errorRecovery: false })
    return { ok: true, error: null }
  } catch (error) {
    // Prefer the syntax detail of the first attempt over "unable to parse".
    const detail = error.details?.attempts?.[0]?.message
    return { ok: false, error: { message: detail || error.message || 'generated output does not parse' } }
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
export { selectPasses, isDeferredPass } from './passes/index.js'
