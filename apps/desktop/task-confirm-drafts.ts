/**
 * What a person has ticked but not yet confirmed.
 *
 * The ticks are a draft, not display state: they used to be a `Set` created inside one pass of the card loop, so any
 * rebuild of the list — a new step checkpoint, a new attempt, a language switch — silently cleared them and left the
 * confirm button looking clickable while it did nothing. They are kept here instead, keyed by session and task, and
 * reused only while the run and the acceptance definition are the same: an index into a different list of criteria
 * means something else, so a different run or a redefined criterion starts empty.
 */
import type { Acceptance, Task } from '../../packages/protocol/index.ts';

interface ConfirmDraft {
  runId: string;
  definitionKey: string;
  indices: Set<number>;
}

/**
 * The identity of an acceptance list, excluding `met`.
 *
 * `met` is deliberately absent: confirming is what flips it, and a definition that changed identity the moment it was
 * confirmed would throw away the very draft the confirmation is reporting on.
 */
export function acceptanceDefinitionKey(acceptance: readonly Acceptance[]): string {
  return JSON.stringify(
    acceptance.map((item) => {
      const check = item.check;
      return check
        ? [
            item.description,
            check.kind,
            check.path ?? null,
            check.expected ?? null,
            check.command ?? null,
            check.args ?? null,
            check.cwd ?? null,
            check.expectation ?? null,
          ]
        : [item.description, null];
    }),
  );
}

export class TaskConfirmDrafts {
  private readonly drafts = new Map<string, ConfirmDraft>();
  private static key(sessionKey: string, taskId: string): string {
    return `${sessionKey}\u0000${taskId}`;
  }
  /** The live selection for this task, reset whenever the run or the definition it indexes has changed. */
  selection(sessionKey: string, task: Task): Set<number> {
    const key = TaskConfirmDrafts.key(sessionKey, task.id);
    const runId = task.latestRunId ?? '';
    const definitionKey = acceptanceDefinitionKey(task.acceptance);
    const existing = this.drafts.get(key);
    if (!existing || existing.runId !== runId || existing.definitionKey !== definitionKey) {
      const fresh: ConfirmDraft = { runId, definitionKey, indices: new Set() };
      this.drafts.set(key, fresh);
      return fresh.indices;
    }
    // A criterion that is now met, or gone, cannot be confirmed again; the index would point elsewhere.
    for (const index of [...existing.indices])
      if (index >= task.acceptance.length || task.acceptance[index]!.met)
        existing.indices.delete(index);
    return existing.indices;
  }
  /** Keep only this session's live tasks: another session's ticks, or a deleted task's, are not a draft. */
  retain(sessionKey: string, taskIds: Iterable<string>): void {
    const prefix = `${sessionKey}\u0000`;
    const live = new Set(taskIds);
    for (const key of [...this.drafts.keys()])
      if (!key.startsWith(prefix) || !live.has(key.slice(prefix.length))) this.drafts.delete(key);
  }
}
