/**
 * Parsing entry point for the restoration pipeline.
 *
 * Malware arrives as script, module, expression fragment, or malformed soup.
 * We therefore try a tolerant script parse first (the overwhelming majority of
 * samples are classic scripts), then module, then a module/script fallback.
 * The chosen source type is reported so a later generate() call can round-trip.
 */
import { parse as babelParse } from '@babel/parser'
import { ParseError } from '../util/errors.js'

export const BASE_PLUGINS = Object.freeze([
  'asyncGenerators',
  'bigInt',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'classStaticBlock',
  'dynamicImport',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'importMeta',
  'logicalAssignment',
  'nullishCoalescingOperator',
  'numericSeparator',
  'objectRestSpread',
  'optionalCatchBinding',
  'optionalChaining',
  'topLevelAwait',
  'privateIn',
  'regexpUnicodeSets',
  'throwExpressions',
])

/**
 * Babel reason codes that mean the text can only be a module. With
 * `errorRecovery` babel keeps the import/export declaration and records one of
 * these instead of throwing, so the AST alone would look like a valid script.
 */
const MODULE_ONLY_REASON_CODES = new Set(['ImportOutsideModule', 'ImportMetaOutsideModule'])

/**
 * True when a recovered parse really needs the module goal.
 * @param {object} ast
 * @returns {boolean}
 */
function needsModule(ast) {
  if (ast.program?.sourceType === 'module') return false
  if ((ast.errors ?? []).some((error) => MODULE_ONLY_REASON_CODES.has(error.reasonCode))) return true
  return (ast.program?.body ?? []).some((node) => node.type === 'ImportDeclaration' || node.type.startsWith('Export'))
}

/**
 * @param {string} code
 * @param {object} [options]
 * @param {'script'|'module'|'unambiguous'} [options.sourceType]
 * @param {boolean} [options.allowReturnOutsideFunction]
 * @param {boolean} [options.errorRecovery]
 * @param {string[]} [options.plugins]
 * @param {boolean} [options.ranges]
 * @param {string} [options.filename]
 * @returns {{ast: object, sourceType: 'script'|'module', comments: object[], errors: object[]}}
 */
export function parse(code, options = {}) {
  const {
    sourceType = 'script',
    allowReturnOutsideFunction = true,
    errorRecovery = true,
    plugins = BASE_PLUGINS,
    ranges = true,
    filename,
  } = options

  const attempt = (type) => {
    try {
      const ast = babelParse(String(code), {
        sourceType: type,
        allowReturnOutsideFunction,
        allowAwaitOutsideFunction: true,
        allowNewTargetOutsideFunction: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
        errorRecovery,
        attachComment: true,
        ranges,
        plugins,
        sourceFilename: filename,
      })
      return { ast, errors: [...(ast.errors ?? [])] }
    } catch (error) {
      return { ast: null, errors: [{ sourceType: type, message: error.message }] }
    }
  }

  const order =
    sourceType === 'unambiguous' ? ['script', 'module'] : sourceType === 'module' ? ['module', 'script'] : ['script', 'module']

  const failures = []
  let candidate = null

  for (const type of order) {
    const result = attempt(type)
    if (!result.ast) {
      failures.push(...result.errors)
      continue
    }
    // A recovered script parse can "succeed" on module syntax. Such an AST is a
    // candidate, not a winner: keep trying the module goal, and only accept the
    // recovered script when no later attempt produces a better parse.
    if (needsModule(result.ast)) {
      candidate ??= result
      continue
    }
    return {
      ast: result.ast,
      sourceType: result.ast.program.sourceType === 'module' ? 'module' : 'script',
      comments: result.ast.comments ?? [],
      errors: result.errors,
    }
  }

  if (candidate) {
    return {
      ast: candidate.ast,
      sourceType: candidate.ast.program.sourceType === 'module' ? 'module' : 'script',
      comments: candidate.ast.comments ?? [],
      errors: candidate.errors,
    }
  }

  throw new ParseError(`unable to parse source (${failures.length} attempts)`, {
    details: { attempts: failures },
  })
}
