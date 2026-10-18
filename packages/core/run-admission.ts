import type { ExecutionPolicy } from '../protocol/execution.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { withExecutionPolicy as underExecutionPolicy } from '../tools/execution-policy.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { redactSecrets } from '../platform/redact.ts';

/**
 * The two edges of a run's admission: the prompt hooks it passes before it exists, and the close of a run that
 * threw before its own finalization could.
 */

/**
 * Run the prompt hooks and return the prompt the run will carry.
 *
 * They run before the run row is opened, so a refused prompt leaves no run or attempt behind. A hook that itself
 * fails stops the run: these hooks exist to police or shape the request, and silently continuing would drop that
 * enforcement.
 */
export async function submitPrompt(options: {
  tools: ToolRegistry;
  executionPolicy: ExecutionPolicy | undefined;
  sessionId: string;
  prompt: string;
  readOnly: boolean;
  signal: AbortSignal;
}): Promise<string> {
  const { tools, executionPolicy, sessionId, prompt, readOnly, signal } = options;
  const submitted = await underExecutionPolicy(executionPolicy, () =>
    tools.extensions.promptSubmit({ sessionId, prompt, readOnly }, signal),
  );
  if (submitted.failures.length)
    throw new Error(
      `Prompt hook failed, so the run was not started: ${submitted.failures.join('; ')}`,
    );
  if (submitted.block) throw new Error(`Prompt rejected by extension: ${submitted.block}`);
  if (!submitted.prompt.trim()) throw new Error('Prompt hook produced an empty prompt');
  return submitted.prompt;
}

/**
 * Close a run that threw before its own finalization could.
 *
 * Only the run row is touched, and only while the session still names it as active — `startRunTask` and
 * `finalizeRun` may already have closed it, and a second `run.finished` would be a second answer to a question
 * that has one.
 */
export function abandonRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
  cause: unknown,
): void {
  try {
    if (store.get(sessionId).activeRun !== runId) return;
    store.finishRun({
      runId,
      sessionId,
      status: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      error: redactSecrets(cause instanceof Error ? cause.message : String(cause)),
    });
  } catch {
    // The original failure is the one worth reporting. The run is over even though its row could not say so,
    // and this process is the one that can vouch for that (see `SessionStore.forsakeRun`).
    store.forsakeRun(runId);
  }
}
