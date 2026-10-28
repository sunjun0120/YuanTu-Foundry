import { AsyncLocalStorage } from 'node:async_hooks';

/** Pauses one enclosing deadline; the returned function resumes it. */
export type SuspendDeadline = () => () => void;
const executionDeadlines = new AsyncLocalStorage<readonly SuspendDeadline[]>();

/**
 * Workspace authorization is preparation, not tool execution. Exclude only its awaited time from every
 * enclosing tool budget (including a program awaiting an inner command). Overlapping waits suspend a budget
 * once, and resuming preserves its remaining time. Cancellation signals remain live throughout the wait.
 *
 * The store lives below `tools` because the sandbox's account grant wait has to pause the tool budget that
 * encloses it, and the sandbox must not depend on the tool layer to do that.
 */
export async function withoutToolDeadline<T>(work: () => Promise<T>): Promise<T> {
  const resume = (executionDeadlines.getStore() ?? []).map((suspend) => suspend());
  try {
    return await work();
  } finally {
    for (const release of resume.reverse()) release();
  }
}

/** Runs `body` with `suspend` added to the deadlines `withoutToolDeadline` pauses. */
export function withSuspendableDeadline<T>(suspend: SuspendDeadline, body: () => T): T {
  const enclosing = executionDeadlines.getStore() ?? [];
  return executionDeadlines.run([...enclosing, suspend], body);
}
