/**
 * The approval cards' readings: identical requests waiting together are one card, and a command offers one more
 * answer than a file change does — allow this exact call for the rest of the session.
 *
 * The summary text comes from `approval-view.ts`; this decides which cards exist, how many copies each stands for, and
 * which decisions each kind offers.
 */
import type { Approval } from '../../../../packages/protocol/index.ts';
import { approvalKey } from '../../../../packages/client/approval-key.ts';

export interface ApprovalEntry {
  id: string;
  approval: Approval;
  /** How many identical requests this card stands for. */
  count: number;
}

/** One card per distinct request; the controller answers every copy with one click. */
export function approvalEntries(
  approvals: readonly { id: string; approval: Approval }[],
): ApprovalEntry[] {
  const counts = new Map<string, number>();
  for (const item of approvals) {
    const key = approvalKey(item.approval);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const drawn = new Set<string>();
  const entries: ApprovalEntry[] = [];
  for (const item of approvals) {
    const key = approvalKey(item.approval);
    if (drawn.has(key)) continue;
    drawn.add(key);
    entries.push({ id: item.id, approval: item.approval, count: counts.get(key) ?? 1 });
  }
  return entries;
}

export interface ApprovalDecision {
  allow: boolean;
  remember: boolean;
}

/**
 * Deny first, then allow; a command adds "allow for this session". A diff is read once and approved once, and an
 * external service has no repeatable call to remember, so neither gets the third answer.
 */
export function approvalDecisions(kind: Approval['kind']): ApprovalDecision[] {
  return [
    { allow: false, remember: false },
    { allow: true, remember: false },
    ...(kind === 'command' ? [{ allow: true, remember: true }] : []),
  ];
}
