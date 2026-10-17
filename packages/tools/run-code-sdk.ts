import type { ToolSpec } from '../protocol/index.ts';

/** Metadata for presenting run_code in a tool catalog; safe to import from CJS consumers. */
export const RUN_CODE = 'run_code';
/**
 * `ptc` folds the catalog into one generated declaration list without changing available tools; `deferred`
 * sends the common tools and lets the model load the rest by name (`./deferred-tools.ts`).
 */
export type ToolMode = 'native' | 'ptc' | 'deferred';

const MAX_HINT_CHARS = 72;

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

/** What the tool says when the catalog is folded; the declaration list is appended by `toolSdk`. */
export const FOLDED_DESCRIPTION = `${BASE_DESCRIPTION}\n\nThe tools available inside the program:`;

/**
 * A compact declaration list for a folded catalog.
 *
 * One line per tool, with parameter names, optionality and a coarse type, plus the first sentence of the tool's
 * own description. Nested schema detail, bounds, patterns and enum members beyond the first few are omitted.
 */
export function toolSdk(specs: readonly ToolSpec[]): string {
  return specs
    .filter((spec) => spec.name !== RUN_CODE)
    .map((spec) => {
      const schema = spec.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
        required?: readonly string[];
      };
      const required = new Set(schema.required ?? []);
      const parameters = Object.entries(schema.properties ?? {}).map(
        ([name, property]) =>
          `${identifier(name)}${required.has(name) ? '' : '?'}: ${typeOf(property)}`,
      );
      const hint = firstSentence(spec.description);
      return `  tools.${spec.name}({ ${parameters.join(', ')} })${hint ? `  // ${hint}` : ''}`;
    })
    .join('\n');
}

function identifier(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function typeOf(property: Record<string, unknown>): string {
  const choices = property.enum;
  if (Array.isArray(choices) && choices.length) {
    const shown = choices.slice(0, 4).map((value) => JSON.stringify(value));
    return shown.join(' | ') + (choices.length > shown.length ? ' | …' : '');
  }
  const type = property.type;
  if (type === 'array') {
    const items = property.items;
    return `${typeof items === 'object' && items ? typeOf(items as Record<string, unknown>) : 'unknown'}[]`;
  }
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'string') return 'string';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'object';
  return 'unknown';
}

function firstSentence(description: string): string {
  const sentence =
    description
      .split(/(?<=\.)\s/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
  return sentence.length > MAX_HINT_CHARS ? sentence.slice(0, MAX_HINT_CHARS - 1) + '…' : sentence;
}
