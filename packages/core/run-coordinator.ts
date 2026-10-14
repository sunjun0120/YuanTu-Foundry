import type { AgentEventType, Usage } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { PendingSubagentMessage } from '../storage/projections.ts';
import { addUsage } from '../protocol/statistics.ts';
import { settlementNotices } from './settlements.ts';
import type { RunQueue } from './run-queue.ts';
import {
  SubAgentCoordinator,
  type AdmittedTask,
  type BatchWorkspace,
  type ResolvedSubAgentOptions,
  type SubAgentCoordinatorDeps,
} from './subagents.ts';
import type { SubAgentProviderRegistry } from './subagent-providers.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { WorkspaceBinding, WorkspaceMode, WorkspaceSnapshot } from '../protocol/workspaces.ts';
import type { WorkspaceManager } from '../workspaces/manager.ts';
import type { WorkspaceApply } from '../workspaces/results.ts';
import { workspaceResultTools } from '../tools/workspaces.ts';

/**
 * The coordinator of a run's delegated children, and the tools that reach it.
 *
 * A coordinator is per-run state — its budget, counters and event ids belong to this run alone — so it is built
 * per run and armed into the emitter, which is what lets the children's own frames keep their stall watchdogs
 * alive (see `run-emit.ts`). The tools it contributes are replaced into the run's registry here rather than by
 * the caller, because "which tools a delegation offers" is the same decision as "which coordinator exists".
 *
 * The four seams it is given are all answers this module cannot produce itself:
 *
 * - **settlement notice** — both halves of it, the durable record that the parent was told and the reader that
 *   goes back to the log for children of runs that are already over. The in-memory flag on a scheduled task dies
 *   with the run, so the notice has to be written down to survive it.
 * - **inbox** — messages this session accepted for a child and never handed over. Same promise, other direction:
 *   a settlement is work that finished and was never read, an inbox entry is a message that was accepted and never
 *   delivered, and both are answered from the log rather than from anything in memory.
 * - **usage folding** — a child's spending is added to the run's totals as it is reported, for the numbers a
 *   person reads rather than for any admission test: a child is bounded by its own rounds and window, not by its
 *   parent's allowance.
 * - **steering** — a correction waiting in the queue ends a collect wait, because the user's next instruction
 *   outranks reading a report that is already on its way.
 */
export interface CoordinatorOptions {
  store: SessionStore;
  sessionId: string;
  workspace: string;
  depth: number;
  /** The resolved delegation limits: the coordinator's own admission rules come from here. */
  limits: ResolvedSubAgentOptions;
  signal: AbortSignal;
  /** Whether the run may change anything; the coordinator refuses writes on a read-only run. */
  readOnly: boolean;
  queue: RunQueue;
  /** The coordinator's own low-volume events (started, finished, settled), which this run's feed carries. */
  emit: (type: AgentEventType, data: Record<string, unknown>) => void;
  /** Folded in place, so a child's tokens reach `RunResult.usage` and `statistics`. */
  usage: Usage;
  statistics: SessionStatistics;
  providers: SubAgentProviderRegistry;
  /** Which registered provider this run delegates through. Defaults to `in-process`. */
  providerName?: string | undefined;
  /** The models this host can run a child on, for the discovery tool. Absent means no tool. */
  models?: (() => readonly { model: string; note?: string }[]) | undefined;
  /** The run's tool registry: the coordinator's tools are replaced into it. */
  tools: ToolRegistry;
  /** Arms the emitter that watches children's progress. */
  arm: (coordinator: SubAgentCoordinator) => void;
  /** How this run's tasks choose a directory; absent means every child shares the delegator's. */
  workspaceMode?: WorkspaceMode | undefined;
  /**
   * The workspace service, when this host isolates its children.
   *
   * Given to the coordinator rather than used here, because the freeze has to happen inside the delegation call —
   * after capability validation and before anything is scheduled — and only the coordinator knows where those two
   * moments are.
   */
  workspaces?: WorkspaceManager | undefined;
  /**
   * The importing side, for the two tools that take delivery of a child's result.
   *
   * Given to the coordinator because those tools belong to the *parent*: they are registered into this run's registry
   * and removed from every child's copy (`RUN_SCOPED_TOOLS`), which is what keeps a child from importing its
   * siblings' work into a directory of its own.
   */
  results?: WorkspaceApply | undefined;
}

export function createCoordinator(options: CoordinatorOptions): SubAgentCoordinator {
  const { store, sessionId } = options;
  const deps: SubAgentCoordinatorDeps = {
    options: options.limits,
    signal: options.signal,
    readOnly: options.readOnly,
    // A correction waiting in the queue ends a collect wait: the user's next instruction outranks reading a
    // report that is already on its way.
    steerPending: () => options.queue.hasSteer,
    emit: options.emit,
    // Child usage is folded into this run's totals as it is reported — for the numbers a person reads, not for
    // any admission test: a child is bounded by its own rounds and window, not by the parent's.
    onUsage: (used: Usage) => {
      options.usage.inputTokens += used.inputTokens;
      options.usage.outputTokens += used.outputTokens;
      // Same reason as the main request's `onUsage`: the cache fields are part of what the provider reported, and
      // `RunResult.usage` is where a reader looks for them.
      if (used.cachedInputTokens !== undefined)
        options.usage.cachedInputTokens =
          (options.usage.cachedInputTokens ?? 0) + used.cachedInputTokens;
      if (used.cacheWriteInputTokens !== undefined)
        options.usage.cacheWriteInputTokens =
          (options.usage.cacheWriteInputTokens ?? 0) + used.cacheWriteInputTokens;
      addUsage(options.statistics, used);
    },
    /**
     * Both sides of the settlement notice: what the parent has already been told, and what it has not.
     */
    collected: (ids: readonly string[]) =>
      store.recordEvent(sessionId, 'subagent.collected', { ids: [...ids] }),
    settlements: () => settlementNotices(store, sessionId),
    inbox: () => store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', sessionId),
    providers: options.providers,
    provider: options.providerName ?? 'in-process',
    parent: { sessionId, workspace: options.workspace, depth: options.depth },
    ...(options.models ? { models: options.models } : {}),
    ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
    ...(options.workspaces
      ? { workspaceForBatch: (input) => batchWorkspace(options.workspaces!, sessionId, input) }
      : {}),
  };
  const coordinator = new SubAgentCoordinator(deps);
  // From here the emitter can arm the delegated children's stall watchdogs; before it, there are none.
  options.arm(coordinator);
  options.tools.replace(coordinator.tool());
  options.tools.replace(coordinator.forkTool());
  options.tools.replace(coordinator.collectTool());
  /**
   * The parent's own view of what its children produced.
   *
   * `replace` rather than `register`, and on the same argument as the delegation tools: a registry can outlive one
   * run (an embedded host reuses it), so this run's closure — which knows this session and its results — has to take
   * over from the previous run's instead of colliding with it.
   */
  if (options.results)
    for (const tool of workspaceResultTools({
      store,
      results: options.results,
      sessionId,
    }))
      options.tools.replace(tool);
  return coordinator;
}

/**
 * One delegation call's worth of isolated directories.
 *
 * The baseline is frozen the first time any task in the call needs an isolated one, and every later task of the
 * same call allocates from that same snapshot — which is what makes the plan's "one frozen input per call" true for
 * children that started minutes apart because they were queued behind the concurrency cap. Freezing lazily rather
 * than at admission is deliberate: a call whose tasks are all read-only under `auto` shares the delegator's
 * directory and must not pay for a snapshot nobody will use.
 *
 * The *promise* is what is remembered, not the snapshot it settles to. Two isolated tasks of one call reach
 * `forTask` in the same tick — `execute` allocates the binding immediately before the child starts, and a call
 * admits its tasks together — so a memo of the finished value would let both of them pass the emptiness check and
 * freeze the source twice. That is not a performance detail: the second freeze re-publishes the same snapshot id
 * with a fresh `commit-tree` timestamp, and the store refuses a second record for one id that carries different
 * contents. The batch then fails with `WORKSPACE_INTEGRITY` and a task that was never run is reported as a failed
 * child. Remembering the pending promise makes the second caller a waiter on the first freeze rather than a second
 * freezer, which is what "one frozen input per call" has to mean when the call is concurrent.
 */
async function batchWorkspace(
  workspaces: WorkspaceManager,
  parentSessionId: string,
  input: { tasks: readonly AdmittedTask[]; signal: AbortSignal },
): Promise<BatchWorkspace> {
  const allocated = new Map<AdmittedTask, WorkspaceBinding>();
  let frozen: Promise<WorkspaceSnapshot> | null = null;
  const source = () => workspaces.resolve(parentSessionId);
  const snapshot = (): Promise<WorkspaceSnapshot> => {
    frozen ??= workspaces.freeze({
      parentSessionId,
      sourceBinding: source(),
      signal: input.signal,
    });
    return frozen;
  };
  return {
    async forTask(task) {
      const existing = allocated.get(task);
      if (existing) return existing;
      if (task.workspaceMode !== 'worktree') {
        /**
         * A shared task is given a binding too, and it is the delegator's own.
         *
         * Not a formality: the child's turns need to know which root they execute in, and "the same as the parent"
         * is a binding like any other. It is *not* written to the store — it is already there, or it is the
         * synthesised one for a historical session.
         */
        const binding = source();
        allocated.set(task, binding);
        return binding;
      }
      const binding = await workspaces.allocate({
        parentSessionId,
        taskId: task.objective.slice(0, 60),
        snapshot: await snapshot(),
        signal: input.signal,
      });
      allocated.set(task, binding);
      return binding;
    },
  };
}
