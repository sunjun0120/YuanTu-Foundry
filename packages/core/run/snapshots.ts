import { memoryContext } from '../../knowledge/context.ts';
import { redactSecrets } from '../../platform/redact.ts';
import { contextTail } from '../../protocol/context.ts';
import { admitGoalRound, type Goal } from '../../protocol/goals.ts';
import type { CompletionStep, Task } from '../../protocol/index.ts';
import { discoverSkills } from '../../resources/skills.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { repoMapContext } from '../../tools/repo-map.ts';
import {
  completionContractText,
  goalNoticeText,
  skillsCatalogue,
  taskDefinitionText,
} from '../prompt/notices.ts';
import { taskCompletionStepId } from '../completion/contract.ts';
import type { RunCompletion } from './completion.ts';
import type { RunEmit } from './emit.ts';
import {
  lastRuntimeSnapshot,
  runtimeSnapshotMessage,
  runtimeSnapshotText,
  type RuntimeSnapshotSource,
} from '../context/runtime.ts';

/**
 * Context that changes while the session runs, said in the conversation rather than in the prompt.
 *
 * The workspace outline changes whenever a file does, saved memory whenever it is written, an approved task's
 * steps whenever one is checkpointed — so as prompt sections they were the most reliable ways to lose the cacheable
 * prefix. What is announced is a *snapshot*: not "tell the model about an event" but "make the conversation hold the
 * current state", announced only when the conversation does not already hold it, which keeps a round's prefix
 * byte-identical to the round before it. `./runtime-context.ts` owns the shape and the reading.
 *
 * What is compared is the window the model can *see*, the transcript after the last compaction: a snapshot the
 * summary swallowed is one the model no longer has, so the next round announces it again.
 */
export interface RunAnnouncementsOptions {
  store: SessionStore;
  sessionId: string;
  workspace: string;
  emit: RunEmit;
  /** The task this run carries out, when it is a task run; re-read per round for its live steps. */
  taskId: string | undefined;
  task: Task | undefined;
  completion: RunCompletion;
}
export interface RunAnnouncements {
  /** Tell the conversation where the goal stands (`goalNoticeText`). */
  goal(goal: Goal): void;
  /** Admit this run as one round of the session's goal and announce it, when there is a goal. */
  admitGoal(): void;
  /** Announce every snapshot the visible conversation does not already hold. */
  snapshots(round: number, route?: { model: string | null; protocol?: string }): Promise<void>;
}
export function createRunAnnouncements(options: RunAnnouncementsOptions): RunAnnouncements {
  const { store, sessionId, workspace, emit, task, completion } = options;
  /**
   * The goal notice is written into the conversation rather than a system section that changes the cacheable
   * prefix. The run start and the `goals` seam both go through here, so there is one definition of what the
   * conversation is told.
   */
  const goal = (current: Goal): void => {
    const content = goalNoticeText(current);
    store.append(sessionId, { role: 'user', content });
    emit('context.injected', { source: 'goal', round: 0, notes: 1, content });
  };
  /**
   * Admission happens once per run, and it is what `roundsStarted` counts: a goal's budget is expressed in runs, so
   * the run that reads it is the run that spends one. An exhausted goal is admitted as-is rather than refused — the
   * run still happens, the user asked for it — and the notice says the budget is spent.
   */
  const admitGoal = (): void => {
    const existing = store.goal(sessionId);
    if (!existing) return;
    const admitted = admitGoalRound(existing, new Date().toISOString());
    if (admitted !== existing) {
      store.recordEvent(sessionId, 'goal.changed', { action: 'round', goal: admitted });
      emit('goal.changed', { action: 'round', goal: admitted });
    }
    goal(admitted);
  };
  const snapshots: RunAnnouncements['snapshots'] = async (round, route) => {
    const surface = store.contextSurface(sessionId);
    const history = store.messages(sessionId);
    const messages = history.slice(surface?.coveredMessages ?? 0);
    const announce = (source: RuntimeSnapshotSource, body: string): void => {
      const text = body.trim();
      if (!text) return;
      const visible =
        source === 'model' ? contextTail(history, surface?.coveredMessages ?? 0) : messages;
      if (lastRuntimeSnapshot(visible, source) === runtimeSnapshotText(source, text)) return;
      const content = runtimeSnapshotMessage(source, text);
      store.append(sessionId, { role: 'user', content });
      emit('context.injected', { source, round, notes: 1, content });
    };
    // A missing identity only needs announcing when it supersedes an earlier known one. Embedders that
    // never declared a model retain their existing context; a switch to an unknown route cannot reuse a
    // stale identity, even if a compaction has already covered the earlier announcement.
    if (route && (route.model !== null || lastRuntimeSnapshot(history, 'model') !== undefined))
      announce(
        'model',
        'Current request model (host-reported API configuration):\n' +
          JSON.stringify({
            model: route.model === null ? null : redactSecrets(route.model),
            ...(route.protocol ? { protocol: redactSecrets(route.protocol) } : {}),
          }) +
          '\nUse this snapshot when asked which model you are using. This is the API model ID, not independent verification of a gateway’s underlying model. A null model means the current ID is unknown; do not reuse an earlier ID or infer it from workspace files.',
      );
    // The task first: it is the objective this run is carrying out. Its steps are re-read so a step checkpointed
    // during the run is what the next round is told, and "picking up or starting over" is read from that same list.
    if (options.taskId) {
      const current = store.getTask(sessionId, options.taskId);
      announce(
        'task',
        taskDefinitionText(
          current,
          current.steps.some((step) => step.status === 'completed'),
        ),
      );
    }
    /**
     * The completion contract, re-announced when the conversation has lost or outgrown it: a compaction can swallow
     * the record that said what "done" means, and the contract is durable while the summary is not. It is announced
     * from the live state, so what the model reads is what the evidence says now.
     */
    if (completion.state.contractSpec && completion.state.contractId) {
      const liveSteps = task ? store.getTask(sessionId, task.id).steps : completion.state.steps;
      announce(
        'completion',
        completionContractText(
          completion.state.contractSpec,
          liveSteps.map((step, index) => ({
            id: task ? taskCompletionStepId(task.id, index) : (step as CompletionStep).id,
            description: step.description,
            status: step.status,
          })),
          completion.state.summary ?? {
            state: 'unverified',
            reason: 'no verification round has run yet',
            repairRounds: completion.state.repairRounds,
            failedCheckIds: [],
          },
          completion.state.automatic,
        ),
      );
    }
    announce('memory', memoryContext(workspace));
    // Read per round: a skill written during the run is available from the next round.
    announce('skills', skillsCatalogue(discoverSkills(workspace)));
    /**
     * The outline is refreshed at the start of a run, and within one only when the model can no longer see it.
     *
     * Every edit that adds or removes a symbol changes the outline, so re-announcing it per round appended a whole
     * new copy after most write rounds of a long coding run — stale copies the model kept paying to read. Within a
     * run the model made those changes itself and has `repo_map` for a fresh view; a compaction that swallowed the
     * last copy still gets one again. Skipping it also skips the workspace scan.
     */
    if (round > 0 && lastRuntimeSnapshot(messages, 'workspace-outline') !== undefined) return;
    const outline = await repoMapContext(workspace);
    announce(
      'workspace-outline',
      outline
        ? `Workspace outline (paths with the symbols they declare; use repo_map or read_file for detail):\n${outline}`
        : '',
    );
  };
  return { goal, admitGoal, snapshots };
}
