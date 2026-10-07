/**
 * The gate's importable surface, typed for the tests.
 *
 * The implementation is `i18n-gate.mjs` rather than TypeScript so `npm run i18n:check` stays a plain script with no
 * build step in front of it, and `tests/i18n-gate.test.ts` imports it to break the rule on purpose. This file is what
 * makes that import checked instead of `any`: it declares the two functions the tests use, and nothing else is part
 * of the gate's contract.
 */
/** The source with comments removed, line structure preserved. Exported for the line-number case. */
export declare function withoutComments(source: string): string;
/** Every problem the gate can see, as `path:line: why` lines. Empty means the tree passes. */
export declare function scanI18n(root: string): Promise<string[]>;
