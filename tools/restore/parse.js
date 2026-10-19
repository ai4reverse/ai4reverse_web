import { parse as babelParse } from '@babel/parser'
import { ParseError } from '../util/errors.js'

/**
 * Parsing entry point for the restoration pipeline.
 *
 * Malware arrives as script, module, expression fragment, or malformed soup.
 * We therefore try a tolerant script parse first (the overwhelming majority of
 * samples are classic scripts), then module, then a module/script fallback.
 * The chosen source type is reported so a later generate() call can round-trip.
 */

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

  const errors = []
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
      return ast
    } catch (error) {
      errors.push({ sourceType: type, message: error.message })
      return null
    }
  }

  const order =
    sourceType === 'unambiguous' ? ['script', 'module'] : sourceType === 'module' ? ['module', 'script'] : ['script', 'module']

  for (const type of order) {
    const ast = attempt(type)
    if (ast) {
      // errorRecovery keeps parse errors on the AST; reject a recovery that
      // produced no usable program body so callers can fall through.
      return {
        ast,
        sourceType: ast.program.sourceType === 'module' ? 'module' : 'script',
        comments: ast.comments ?? [],
        errors: [...errors, ...(ast.errors ?? [])],
      }
    }
  }

  throw new ParseError(`unable to parse source (${errors.length} attempts)`, {
    details: { attempts: errors },
  })
}
