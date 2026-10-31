/**
 * Text length in code points, the unit budgets are stated in (`.length` counts UTF-16 units and
 * invites splitting surrogate pairs). Shared by `prune.ts` and `shrink.ts`; kept separate to avoid
 * an import cycle.
 */
export function codePointLength(text: string): number {
  return [...text].length;
}
