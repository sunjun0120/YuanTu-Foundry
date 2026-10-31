import type { SessionStore } from '../../storage/sqlite.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { AgentEventType, SubAgentSummaryReport, Usage } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { AgentOptions, AgentRunInput } from '../agent-options.ts';
import { redactSecrets } from '../../platform/redact.ts';
import { createChildTurns } from './child-turns.ts';
import { createCoordinator } from './coordinator.ts';
import type { RunEmit } from './emit.ts';
import type { RunQueue } from './queue.ts';
import { type ResidentTurnSettlements, createResidentMessageTool } from './residency.ts';
import { createSubAgentProviders } from './subagents.ts';
import {
  REPORT_SCHEMA,
  SUBMIT_REPORT_DESCRIPTION,
  type SubAgentCoordinator,
  normalizeReport,
  type ResolvedSubAgentOptions,
} from '../subagents/delegation.ts';
import { workflowTool } from '../subagents/workflow.ts';

/** The child's report contract is installed per turn, including removal for ordinary resident follow-ups. */
export function registerRunReport(
  tools: ToolRegistry,
  input: Pick<AgentRunInput, 'reportRequired' | 'reportSchema'>,
): { report?: SubAgentSummaryReport; data?: unknown } {
  /**
   * A delegated child ends by submitting a structured, validated report through a tool, registered
   * only for child runs. The holder exists because the value is assigned inside the tool closure.
   */
  const reportHolder: { report?: SubAgentSummaryReport; data?: unknown } = {};
  if (input.reportRequired) {
    /**
     * The fixed report contract, or the caller's schema when declared. Used as the tool's argument
     * schema, so the registry validates the answer before the tool runs.
     */
    const schema = input.reportSchema ?? REPORT_SCHEMA;
    const custom = input.reportSchema !== undefined;
    tools.replace({
      name: 'submit_report',
      description: custom
        ? 'Submit the structured result this task asked for and end this run. The arguments are the object described by this tool’s own schema: include every required field, and use the field descriptions to decide what belongs in each. Call this exactly once, when you can answer or you are blocked.'
        : SUBMIT_REPORT_DESCRIPTION,
      inputSchema: schema,
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          if (custom) {
            // Kept as submitted; it already matches the caller's schema.
            reportHolder.data = args;
            return {
              isError: false,
              content:
                'Result recorded. This sub-agent run is complete; do not call further tools.',
            };
          }
          reportHolder.report = normalizeReport(args);
          return {
            isError: false,
            content: `Report recorded (${reportHolder.report.findings.length} findings). This sub-agent run is complete; do not call further tools.`,
          };
        } catch (error) {
          return {
            isError: true,
            content: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  } else {
    /**
     * A turn that does not require a report must not offer the report tool. A resident child reuses
     * one registry, and offering it on a follow-up made the child call it repeatedly.
     */
    tools.remove('submit_report');
  }
  return reportHolder;
}

export interface RunDelegationOptions {
  agent: AgentOptions;
  store: SessionStore;
  tools: ToolRegistry;
  emit: RunEmit;
  sessionId: string;
  runId: string;
  workspace: string;
  /** The session's project; differs from `workspace` when the run works in a worktree. */
  project?: string;
  depth: number;
  limits: ResolvedSubAgentOptions;
  signal: AbortSignal;
  readOnly: boolean;
  queue: RunQueue;
  usage: Usage;
  statistics: SessionStatistics;
  residentTurns: ResidentTurnSettlements;
  taskEffectScope: AgentOptions['taskEffectScope'];
  createAgent: Parameters<typeof createChildTurns>[0]['createAgent'];
  arm(coordinator: SubAgentCoordinator): void;
  nextMessageId(): number;
}

/** Assemble child providers and tools once per parent run; the caller owns the coordinator's lifetime. */
export function createRunDelegation(options: RunDelegationOptions): SubAgentCoordinator {
  const {
    agent,
    store,
    tools,
    emit,
    sessionId,
    runId,
    workspace,
    project,
    depth,
    limits,
    signal,
    readOnly,
    queue,
    usage,
    statistics,
    residentTurns,
    taskEffectScope,
    createAgent,
    arm,
    nextMessageId,
  } = options;

  // The built-in provider: one named provider among those an embedder registers. `agentOptions` is
  // advertised only when this host can resolve a child's model.
  /**
   * The coordinator's events plus their durable record, written in one call so feed and log agree.
   * The record drops feed-only fields (`index`, `total`, truncated `text`) but keeps a bounded,
   * redacted `error`.
   */
  const subAgentEmit = (type: AgentEventType, data: Record<string, unknown>): void => {
    /**
     * A finished child carries its own work time, read from its session (the parent's log cannot
     * fold a resident child's later turns). Derived, not copied into the durable record.
     */
    if (type === 'subagent.finished') {
      const childSessionId = String(data.sessionId ?? '');
      if (childSessionId) {
        const timing = store.turnTiming(childSessionId);
        data = { ...data, durationMs: timing.settledMs, runningSince: timing.runningSince };
      }
    }
    if (type !== 'subagent.finished') {
      emit(type, data);
      return;
    }
    store.recordEvent(sessionId, 'subagent.finished', {
      runId,
      // The newest `run.finished` by index, since a resident child's log grows every turn.
      childRunId: data.sessionId
        ? store.newestPayload(String(data.sessionId), 'run.finished')?.runId
        : undefined,
      id: data.id,
      sessionId: data.sessionId,
      role: data.role,
      objective: data.objective,
      status: data.status,
      rounds: data.rounds,
      toolCalls: data.toolCalls,
      usage: data.usage,
      ...(data.report ? { report: data.report } : {}),
      ...(data.error ? { error: redactSecrets(String(data.error)).slice(0, 600) } : {}),
    });
    emit(type, data);
  };
  /**
   * Everything a child needs to run turns on an existing session, extracted from the provider so
   * the residency can cold-resume a child delegated in an earlier process. Takes the task, session,
   * depth, tag and, for a live delegation, its signal.
   */
  const childTurns = createChildTurns({
    agent: agent,
    store,
    tools,
    emit,
    sessionId: sessionId,
    taskEffectScope,
    createAgent,
    workspaceResults: agent.workspaceResults,
  });
  /**
   * The providers this run delegates through: the built-in one plus the host's. Built per run
   * because capabilities are a promise about this host (see `run/subagents.ts`).
   */
  const providers = createSubAgentProviders({
    store,
    parentSessionId: sessionId,
    workspace,
    runId,
    depth,
    residency: agent.subagentResidency,
    childTurns,
    workspaceManager: agent.workspaceManager,
    resolveProviderFor: agent.subagentProviderFor,
    forkTranscriptChars: agent.forkTranscriptChars,
    forkTranscriptMessages: agent.forkTranscriptMessages,
    extraProviders: agent.subagentProviders,
  });
  /**
   * The coordinator of this run's children, armed into the emitter for the stall watchdogs (see
   * `run/coordinator.ts`).
   */
  const coordinator = createCoordinator({
    store,
    sessionId: sessionId,
    workspace,
    ...(project ? { project } : {}),
    depth,
    limits,
    signal,
    readOnly,
    queue,
    emit: subAgentEmit,
    usage,
    statistics,
    providers,
    providerName: agent.subagentProvider,
    models: agent.subagentModels,
    tools,
    ...(agent.workspaceMode ? { workspaceMode: agent.workspaceMode } : {}),
    ...(agent.workspaceManager ? { workspaces: agent.workspaceManager } : {}),
    ...(agent.workspaceApply ? { results: agent.workspaceApply } : {}),
    arm,
  });
  /**
   * The orchestration tool, admitted via `runOne` like `delegate_task`, so scripts meet the same
   * caps.
   */
  const delegation = coordinator;
  tools.replace(
    workflowTool({
      maxAgents: limits.maxPerRun,
      // Read per call: the registry's policy is what the deployment configured for every other tool.
      defaultTimeoutMs: () => tools.deadlines?.defaultMs,
      runAgent: (prompt, options, signal) =>
        delegation.runOne(
          {
            objective: prompt,
            ...(options.model ? { model: options.model } : {}),
            ...(options.schema ? { schema: options.schema } : {}),
          },
          signal,
        ),
    }),
  );
  // Registered only when the host supplied the list.
  if (agent.subagentModels) tools.replace(coordinator.modelsTool());
  /**
   * Control tools for resident children, present only with a residency and scoped to this session's
   * direct children, so a child cannot drive its siblings.
   */
  const residency = agent.subagentResidency;
  if (residency)
    tools.replace(
      createResidentMessageTool({
        store,
        parentSessionId: sessionId,
        depth,
        residency,
        childTurns,
        resolveProviderFor: agent.subagentProviderFor,
        workspaceManager: agent.workspaceManager,
        emit: subAgentEmit,
        statistics,
        usage,
        trackTurn: (settled, interrupt) => residentTurns.track(settled, interrupt),
        // The serial lives with the run loop so ids never repeat across runs (the inbox cancels by
        // id).
        nextMessageId,
      }),
    );

  return coordinator;
}
