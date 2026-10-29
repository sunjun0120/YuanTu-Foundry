import type { Plan, TodoItem } from '../protocol/index.ts';
import type { TodoChange } from '../protocol/todos.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Goal } from '../protocol/goals.ts';
import type { CompletionRecord } from '../protocol/completion.ts';
import type { AgentHostClient } from './host-client.ts';
import type { SubAgentView } from './session-view.ts';

/**
 * The reads a session load makes besides the transcript.
 *
 * Every one of them tolerates a Host that predates its capability: the matching panel stays empty rather than the
 * whole session failing to load.
 */

export type WorkspaceViews = Map<string, NonNullable<SubAgentView['workspace']>>;

/** Reads the latest plan, tolerating a Host that predates the plan capability. */
export async function readPlan(client: AgentHostClient, sessionId: string): Promise<Plan | null> {
  try {
    return await client.request('plan.get', { sessionId });
  } catch {
    return null;
  }
}

/**
 * The files a run marked as its deliverables, for a session load.
 *
 * Tolerant of a Host that predates the capability, like the plan and the checklist: the panel stays empty
 * rather than the whole session failing to load.
 */
export async function readDeliverables(
  client: AgentHostClient,
  sessionId: string,
): Promise<PresentedFile[]> {
  try {
    return await client.request('deliverables.get', { sessionId, byTurn: true });
  } catch {
    return [];
  }
}

/** The session's goal, for a session load; `null` when there is none or the Host predates the capability. */
export async function readGoal(client: AgentHostClient, sessionId: string): Promise<Goal | null> {
  try {
    return await client.request('goal.get', { sessionId });
  } catch {
    return null;
  }
}

/**
 * The completion contract this session is working against, for a session load.
 *
 * The record outlives the run that created it, so a window reopened after a repair — or after a crash — has to
 * read it back from the log rather than from a result it never saw. `null` is the honest answer for a session
 * with no contract, and a Host that predates the capability answers the same way.
 */
export async function readCompletion(
  client: AgentHostClient,
  sessionId: string,
): Promise<CompletionRecord | null> {
  try {
    return await client.request('completion.current', { sessionId });
  } catch {
    return null;
  }
}

/**
 * Sub-agents of the most recent run, as stored with its result. A Host that predates the capability
 * simply answers with an error, and the panel stays empty instead of failing the session load.
 */
export async function readSubAgents(
  client: AgentHostClient,
  sessionId: string,
): Promise<SubAgentView[]> {
  try {
    const summaries = await client.request('subagents.list', {
      sessionId,
      includePreviousRuns: true,
    });
    /**
     * Where each child worked, reconstructed from what the Host still knows.
     *
     * This is the *reopen* path: a session loaded after the fact has no `subagent.workspace` frames to replay, so
     * the workspace state has to be read rather than remembered. A failure is tolerated on purpose — a Host that
     * predates the capability answers "Unknown method" — and the cards are then built without the field instead of
     * the session load failing.
     */
    const workspaces = await readWorkspaceViews(
      client,
      sessionId,
      summaries.map((entry) => entry.sessionId),
    );
    return summaries.map((summary, index) => ({
      id: summary.id,
      index,
      total: summaries.length,
      role: summary.role,
      objective: summary.objective,
      childSessionId: summary.sessionId,
      status: summary.status,
      rounds: summary.rounds,
      toolCalls: summary.toolCalls,
      ...(summary.status !== 'interrupted' && summary.usage ? { usage: summary.usage } : {}),
      // The card's clock, restored with the card: a child that ran for six minutes says six minutes on a
      // reload, and one whose turn was cut off by a restart stops there instead of counting the downtime.
      durationMs: summary.durationMs ?? 0,
      runningSince: summary.runningSince ?? null,
      text: '',
      // The report is why a card is worth restoring: the status alone says a child ran, and the
      // findings say what it found.
      ...(summary.report ? { report: summary.report } : {}),
      ...(summary.error ? { error: summary.error } : {}),
      ...(workspaces.get(summary.sessionId)
        ? { workspace: workspaces.get(summary.sessionId)! }
        : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * The workspace each child ran in, keyed by child session id.
 *
 * Two requests per child, and both are allowed to fail independently: the *binding* is where it worked and the
 * *result* is what it produced, and a child that produced nothing still has a place it worked. A failure returns no
 * entry at all rather than a `shared` one, which is the difference between "we do not know" and "this is not
 * isolated" — and only one of those is safe to show a person as reassurance.
 */
export async function readWorkspaceViews(
  client: AgentHostClient,
  parentSessionId: string,
  childSessionIds: readonly string[],
): Promise<WorkspaceViews> {
  const found: WorkspaceViews = new Map();
  const results = new Map<
    string,
    { id: string; digest: string; status: string; paths: string[] }
  >();
  try {
    for (const result of await client.request('workspace.results', {
      sessionId: parentSessionId,
    })) {
      // The newest result per child wins, which is the one still outstanding: an earlier import has already been
      // accepted, and a card that offered it again would be offering work the parent already has.
      // The Host orders durable results oldest first; take the latest even after it conflicts or is imported.
      results.set(result.childSessionId, {
        id: result.id,
        digest: result.digest,
        status: result.status,
        paths: [...result.paths],
      });
    }
  } catch {
    // A Host without the method, or a session with no results at all.
  }
  for (const childSessionId of childSessionIds) {
    if (!childSessionId) continue;
    try {
      const answer = await client.request('workspaces.get', { sessionId: childSessionId });
      found.set(childSessionId, {
        kind: answer.binding.kind,
        executionRoot: answer.binding.executionRoot,
        state: answer.binding.state,
        ...(answer.problems.length ? { problem: answer.problems.join('; ') } : {}),
        ...(answer.dependencyWarnings?.length
          ? {
              dependencyWarning: answer.dependencyWarnings
                .map((warning) => warning.message)
                .join('; '),
            }
          : {}),
        ...(results.get(childSessionId) ? { result: results.get(childSessionId)! } : {}),
      });
    } catch {
      // Some Hosts cannot answer; saying nothing is the honest response.
    }
  }
  return found;
}

/**
 * The checklist as last written, for a session load, plus what the last write changed about it. A Host that
 * predates the capability answers with an error, and the panel stays empty instead of failing the load.
 */
export async function readTodos(
  client: AgentHostClient,
  sessionId: string,
): Promise<{ todos: TodoItem[]; change: TodoChange | null }> {
  try {
    return await client.request('todos.get', { sessionId });
  } catch {
    return { todos: [], change: null };
  }
}
