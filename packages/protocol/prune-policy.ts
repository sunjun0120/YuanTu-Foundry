/** Shared by startup limit resolution and the runtime's defensive policy assertion. */
export const PRUNE_MARKER = '\n\n[... middle pruned ...]\n\n';

/** The actual model-visible notice; keep its wording and budget calculation in one place. */
export function pruneNotice(removed: number, total: number): string {
  return `\n\n[... middle pruned ...] ${removed} of ${total} characters removed to keep this conversation within budget; the full result is in the session transcript\n\n`;
}

// String/code-point lengths cannot exceed safe integer precision. Reserve the longest possible
// counts so startup validation holds for every input, including results larger than ordinary limits.
export const PRUNE_NOTICE_MAX_CHARS = [
  ...pruneNotice(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
].length;

export function assertPrunePolicyFits(policy: {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}): void {
  const marker = PRUNE_NOTICE_MAX_CHARS;
  if (policy.headChars + marker + policy.tailChars > policy.thresholdChars)
    throw new Error(
      `Prune policy keeps ${policy.headChars} head and ${policy.tailChars} tail characters plus a ` +
        `${marker}-character marker, which does not fit its ${policy.thresholdChars}-character threshold; ` +
        'the marker would push a pruned result back over the budget it was pruned for',
    );
}
