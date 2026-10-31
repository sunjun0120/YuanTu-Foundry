import type { AgentEventType, Usage } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { PendingSubagentMessage } from '../../storage/projections.ts';
import { addUsage } from '../../protocol/statistics.ts';
import { settlementNotices } from '../subagents/settlements.ts';
import type { RunQueue } from './queue.ts';
import {
  SubAgentCoordinator,
  type AdmittedTask,
  type BatchWorkspace,
  type ResolvedSubAgentOptions,
  type SubAgentCoordinatorDeps,
} from '../subagents/delegation.ts';
import type { SubAgentProviderRegistry } from '../subagents/providers.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type {
  WorkspaceBinding,
  WorkspaceMode,
  WorkspaceSnapshot,
} from '../../protocol/workspaces.ts';
import type { WorkspaceManager } from '../../workspaces/manager.ts';
import type { WorkspaceApply } from '../../workspaces/results.ts';
import { workspaceResultTools } from '../../tools/workspaces.ts';

/**
 * The coordinator of a run's delegated children and the tools that reach it. Per run and armed into
 * the emitter so children's frames keep their watchdogs alive (`run/emit.ts`). Its seams:
 *
 * - settlement notice: durable record of what the parent was told, and the reader for earlier runs'
 *   children;
 * - inbox: messages accepted for a child but never handed over, read from the log;
 * - usage folding: child spend added to the run's totals for reporting only;
 * - steering: a queued correction ends a collect wait.
 */
export interface CoordinatorOptions {
  store: SessionStore;
  sessionId: string;
  workspace: string;
  /** The session's project, whose memories a child reads (`SubAgentParent.project`). */
  project?: string;
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
   * The workspace service, when children are isolated. Given to the coordinator because the freeze
   * must happen inside the delegation call, between validation and scheduling.
   */
  workspaces?: WorkspaceManager | undefined;
  /**
   * The importing side, for the parent's two result-delivery tools; children never get them
   * (`RUN_SCOPED_TOOLS`).
   */
  results?: WorkspaceApply | undefined;
}

export function createCoordinator(options: CoordinatorOptions): SubAgentCoordinator {
  const { store, sessionId } = options;
  const deps: SubAgentCoordinatorDeps = {
    options: options.limits,
    signal: options.signal,
    readOnly: options.readOnly,
    // A queued correction ends a collect wait.
    steerPending: () => options.queue.hasSteer,
    emit: options.emit,
    // Fold child usage into this run's totals, for reporting only.
    onUsage: (used: Usage) => {
      options.usage.inputTokens += used.inputTokens;
      options.usage.outputTokens += used.outputTokens;
      // Include cache fields in `RunResult.usage`.
      if (used.cachedInputTokens !== undefined)
        options.usage.cachedInputTokens =
          (options.usage.cachedInputTokens ?? 0) + used.cachedInputTokens;
      if (used.cacheWriteInputTokens !== undefined)
        options.usage.cacheWriteInputTokens =
          (options.usage.cacheWriteInputTokens ?? 0) + used.cacheWriteInputTokens;
      addUsage(options.statistics, used);
    },
    /** Both sides of the settlement notice: what the parent was told, and what it was not. */
    collected: (ids: readonly string[]) =>
      store.recordEvent(sessionId, 'subagent.collected', { ids: [...ids] }),
    // All of them, not the prompt's eight; each report is still bounded per call.
    settlements: () => settlementNotices(store, sessionId, Number.POSITIVE_INFINITY),
    inbox: () => store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', sessionId),
    providers: options.providers,
    provider: options.providerName ?? 'in-process',
    parent: {
      sessionId,
      workspace: options.workspace,
      ...(options.project ? { project: options.project } : {}),
      depth: options.depth,
    },
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
   * The parent's view of its children's results. `replace` because a registry can outlive one run.
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
 * One delegation call's isolated directories. The baseline is frozen lazily, when the first task
 * needs isolation, and reused for every later task of the call. The pending promise is memoised,
 * not the value, so concurrent tasks wait on one freeze instead of freezing twice (which the store
 * would refuse as `WORKSPACE_INTEGRITY`).
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
        /** A shared task gets the delegator's own binding, not written to the store. */
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
