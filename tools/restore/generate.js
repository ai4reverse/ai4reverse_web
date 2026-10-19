import { generate as babelGenerate } from '@babel/generator'
import * as t from '@babel/types'

/**
 * Single generate() wrapper used by every pass and by the CLI. Keeping one
 * implementation is what makes "统一的解析、转换、生成" (unified parse /
 * transform / generate) real rather than aspirational: output formatting,
 * escape handling and comment policy are all decided here.
 */

export const DEFAULT_GENERATE_OPTIONS = Object.freeze({
  comments: true,
  compact: false,
  concise: false,
  decoratorsBeforeExport: true,
  jsescOption: {
    minimal: true,
    quotes: 'single',
    numbers: 'decimal',
  },
  retainLines: false,
  minified: false,
})

/**
 * @param {object} ast Babel AST (File or Program)
 * @param {string} [code] original source (for source maps)
 * @param {object} [options]
 * @returns {{code: string, map: object|null, rawMappings?: unknown}}
 */
export function generate(ast, code = '', options = {}) {
  const merged = {
    ...DEFAULT_GENERATE_OPTIONS,
    ...options,
    jsescOption: { ...DEFAULT_GENERATE_OPTIONS.jsescOption, ...(options.jsescOption ?? {}) },
  }
  const result = babelGenerate(ast, merged, code)
  return {
    code: result.code,
    map: result.map && Object.keys(result.map).length > 0 ? result.map : null,
    rawMappings: result.rawMappings,
  }
}

/**
 * Render an expression node as source text.
 * @param {object} node
 * @param {object} [options]
 */
export function generateExpression(node, options = {}) {
  const file = t.file(t.program([t.expressionStatement(node)]))
  const { code } = generate(file, '', { comments: false, ...options })
  return code.replace(/;\s*$/, '')
}
