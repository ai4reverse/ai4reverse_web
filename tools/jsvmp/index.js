/**
 * JSVMP subsystem public surface.
 *
 * - `spec.js` owns the canonical opcode table and assembler.
 * - `builder.js` generates self-contained JSVMP interpreter source.
 * - `analyze.js` detects and dissects JSVMP dispatchers.
 */

export * from './spec.js'
export * from './builder.js'
export { analyzeVM, extractHandlers, isJSVMP, summarizeVM } from './analyze.js'
