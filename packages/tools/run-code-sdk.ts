/** Metadata for presenting run_code in a tool catalog; safe to import from CJS consumers. */
export const RUN_CODE = 'run_code';
/**
 * How a catalog is presented: `deferred` sends the common tools and lets the model load the rest by name
 * (`./deferred-tools.ts`); `native` is every schema, which is what a caller asking "what does this registry have"
 * wants.
 */
export type ToolMode = 'native' | 'deferred';

export const BASE_DESCRIPTION = [
  'Run a JavaScript program that calls tools itself, so several steps cost one round.',
  '`code` is the body of an async function: `await tools.<name>({ ... })` per call, then `return` the answer',
  '(a string or anything JSON-serialisable). Each call is validated, permission-checked and approved exactly as',
  'a direct call; a failed call throws, so catch what you expect. Only `tools` and `console` are injected; it runs',
  'in a separate Node process under the selected sandbox backend (no host fallback), not a full malicious-code',
  'sandbox. It cannot call run_code or see images a tool returns. Console output and, on failure, the calls made',
  'are returned. Use it for mechanical multi-step work (read several files, filter, aggregate, compare); use',
  'ordinary calls when a person should see each step.',
].join(' ');
