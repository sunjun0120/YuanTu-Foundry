import type { AgentEventType, Usage } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { PendingSubagentMessage } from '../storage/projections.ts';
import { addUsage } from '../protocol/statistics.ts';
import { settlementNotices } from './settlements.ts';
import type { RunQueue } from './run-queue.ts';
import {
  SubAgentCoordinator,
  type ResolvedSubAgentOptions,
  type SubAgentCoordinatorDeps,
} from './subagents.ts';
import type { SubAgentProviderRegistry } from './subagent-providers.ts';
import type { ToolRegistry } from '../tools/registry.ts';

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
  };
  const coordinator = new SubAgentCoordinator(deps);
  // From here the emitter can arm the delegated children's stall watchdogs; before it, there are none.
  options.arm(coordinator);
  options.tools.replace(coordinator.tool());
  options.tools.replace(coordinator.forkTool());
  options.tools.replace(coordinator.collectTool());
  return coordinator;
}
