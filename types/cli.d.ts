/**
 * Declarations for the `ai4reverse-web/cli` subpath.
 *
 * The CLI entry point is also the `ai4reverse` bin. `main()` resolves once the
 * command finished and sets `process.exitCode` on failure: usage errors exit 2,
 * runtime failures exit 1.
 */
export declare function main(argv?: string[]): Promise<number | void>
