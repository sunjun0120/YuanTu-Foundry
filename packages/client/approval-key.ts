/**
 * What "the same approval" means when a person allows a request for the rest of a session.
 *
 * The key is the tool call's name and its arguments, serialized exactly. It is deliberately not the approval
 * id (every request has a new one), not the description (a sentence written for a person), and not the tool
 * name alone: remembering `npm test` must not also allow `npm publish`, and remembering an edit of one file
 * must not allow an edit of another.
 */
import type { Approval } from '../protocol/index.ts';

export function approvalKey(approval: Pick<Approval, 'toolCall'>): string {
  const { name, arguments: args } = approval.toolCall;
  return `${name}\u0000${stableJson(args ?? null)}`;
}

/**
 * JSON with object keys sorted, so two calls that differ only in argument order are one decision.
 *
 * `JSON.stringify` preserves insertion order, and two call sites can build the same arguments in different
 * orders; a remembered approval that stopped matching because of that would silently ask again.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(',')}}`;
}
