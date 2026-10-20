/**
 * Shared Babel bindings.
 *
 * The restoration pipeline and the AST instrumentation both drive the same
 * Babel packages. Owning the interop shims here keeps that dependency pointed
 * at the util layer instead of restore internals: instrumentation imports the
 * bindings from here, and restore/pass-context re-exports them for its passes.
 */
import * as types from '@babel/types'
import traverseModule from '@babel/traverse'
import * as templateModule from '@babel/template'

export { types }
export const traverse = traverseModule.default ?? traverseModule.traverse ?? traverseModule
export const template = templateModule.default ?? templateModule
