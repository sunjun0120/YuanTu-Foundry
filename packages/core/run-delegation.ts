import type { SessionStore } from '../storage/sqlite.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentEventType, SubAgentSummaryReport, Usage } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { AgentOptions, AgentRunInput } from './agent-options.ts';
import { redactSecrets } from '../platform/redact.ts';
import { createChildTurns } from './run-child-turns.ts';
import { createCoordinator } from './run-coordinator.ts';
import type { RunEmit } from './run-emit.ts';
import type { RunQueue } from './run-queue.ts';
import { type ResidentTurnSettlements, createResidentMessageTool } from './run-residency.ts';
import { createSubAgentProviders } from './run-subagents.ts';
import {
  REPORT_SCHEMA,
  SUBMIT_REPORT_DESCRIPTION,
  type SubAgentCoordinator,
  normalizeReport,
  type ResolvedSubAgentOptions,
} from './subagents.ts';
import { workflowTool } from './workflow.ts';

/** The child's report contract is installed per turn, including removal for ordinary resident follow-ups. */
export function registerRunReport(
  tools: ToolRegistry,
  input: Pick<AgentRunInput, 'reportRequired' | 'reportSchema'>,
): { report?: SubAgentSummaryReport; data?: unknown } {
  /**
   * A delegated child ends by submitting a report, and that is a tool call for the same reason the
   * plan is: the result is structured, validated and storable. It is registered only for a child run,
   * so it can never appear in a run whose answer goes straight to the user. The holder exists because
   * the value is assigned inside the tool closure, where control-flow narrowing cannot see it.
   */
  const reportHolder: { report?: SubAgentSummaryReport; data?: unknown } = {};
  if (input.reportRequired) {
    /**
     * Which shape this child must come back with.
     *
     * The fixed report contract by default; the caller's own schema when the task declared one. The schema is
     * the tool's *argument* schema either way, which is what makes the promise real rather than aspirational:
     * the registry validates the call against it before the tool runs, so "the answer matches the schema" is
     * enforced where every other argument is, and the run cannot end with a shape nobody checked.
     */
    const schema = input.reportSchema ?? REPORT_SCHEMA;
    const custom = input.reportSchema !== undefined;
    tools.replace({
      name: 'submit_report',
      description: custom
        ? 'Submit the structured result this task asked for and end this run. The arguments are the object described by this tool’ own schema: include every required field, and use the field descriptions to decide what belongs in each. Call this exactly once, when you can answer or you are blocked.'
        : SUBMIT_REPORT_DESCRIPTION,
      inputSchema: schema,
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          if (custom) {
            // Kept as submitted: it has already been validated against the caller's schema, and re-shaping
            // somebody else's object here is how a field they asked for would quietly go missing.
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
     * A turn that does not require a report must not *offer* the report tool.
     *
     * A resident child borrows one registry across every turn it runs, so the `submit_report` a delegation
     * turn installed is still there when the same child is asked a follow-up question. Offering it was wrong
     * in the way that matters: the tool's own result says "this completes the run", so a child that was asked
     * a question answered by calling it — again and again, until it hit its round limit. Removing it makes the
     * offered tool set agree with what the run accepts, which is what `reportRequired` already meant.
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

  /**
   * The built-in provider is the closure that used to be the only way to delegate, now one named
   * provider among however many an embedder registers.
   *
   * Its declared capabilities are computed rather than aspirational: `agentOptions` is advertised
   * only when this host can actually resolve a model for a child, so a host that cannot serve a
   * requested model refuses the task instead of quietly running it on the default one.
   */
  /**
   * The coordinator's events, plus the durable record of the same facts.
   *
   * One call writes both, so the live feed and the parent's log cannot describe different things: a
   * child that finishes is announced *and* recorded at the same moment. The durable copy deliberately
   * drops the feed-only fields (`index`, `total`, and the truncated `text`) — the child's transcript
   * lives in the child's own session, and the card needs the summary, not a copy of the report text.
   *
   * `error` is kept, bounded and redacted like every other recorded reason. The card projection already
   * reads it, and without it a child that was cancelled or failed reaches its parent as a bare status: the
   * one thing a person needs after "the sub-agent did not finish" is *why*.
   */
  const subAgentEmit = (type: AgentEventType, data: Record<string, unknown>): void => {
    /**
     * A finished child carries its own work time, read from its session before anyone seals the card.
     *
     * The parent's log records one assignment and one end per turn, so the time a resident child spent in
     * its later turns has no start to subtract from and cannot be folded out of this session at all. The
     * child's own log has it — so the number is read there, here, while the child's run is still the thing
     * that just ended. It stays *derived*: the durable record below deliberately does not copy it, and a
     * reload recomputes the same value from the same events.
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
      childRunId: data.sessionId
        ? store.events(String(data.sessionId)).findLast((e) => e.type === 'run.finished')?.data
            .runId
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
   * Everything a child needs to run turns on a session that already exists.
   *
   * This used to live inside the provider's `run`, which meant it existed only while a delegation was
   * starting: a child that had been *delegated* in an earlier process could be seen in the log and in its
   * own transcript, and still nothing could run a turn on it, because the only code that knew how to build
   * one was in the call that had already returned. Extracting it is what makes a cold resume possible —
   * the residency can now open an activation for a child it did not start.
   *
   * The signature says what a turn needs and nothing else: the task it belongs to (for the persona, the
   * read-only rule and the grant), the session to run on, the depth for the lineage, the tag that names it
   * in approvals and events, and — only when a live delegation is resuming its own child — the
   * delegation's own signal.
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
   * The providers this run delegates through: the built-in in-process one plus the host's own.
   *
   * Built here, after `childTurns`, because the built-in provider *is* that closure — and per run, because
   * its advertised capabilities are a promise about this host, not about the model (see `run-subagents.ts`).
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
   * The coordinator of this run's children, armed into the emitter so their frames keep their stall
   * watchdogs alive, and the tools that reach it (see `run-coordinator.ts`).
   */
  const coordinator = createCoordinator({
    store,
    sessionId: sessionId,
    workspace,
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
   * The orchestration tool, on the same admission path as `delegate_task`.
   *
   * `runAgent` goes through `runOne`, which admits and schedules exactly like a delegation task: a script's
   * loop and a model's loop of tool calls meet the same per-run total, the same semaphore and the same
   * capability checks. That is the whole reason this is wired here rather than built inside the tool.
   *
   * `coordinator` is declared outside this block because the run's end has to settle it, and a closure cannot
   * lean on the narrowing the assignments above establish — hence the local name.
   */
  const delegation = coordinator;
  tools.replace(
    workflowTool({
      maxAgents: limits.maxPerRun,
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
  // Registered only when the host supplied the list: a discovery tool with nothing behind it would
  // teach the model to trust an answer nobody stands behind.
  if (agent.subagentModels) tools.replace(coordinator.modelsTool());
  /**
   * The control surface for resident children.
   *
   * These tools exist only when a residency does, because without one there is nothing to talk to: a
   * one-shot child is gone the moment it reports. They are scoped to this session's **direct** children,
   * which is what stops a child from driving its siblings (a grandchild is reachable from its own
   * parent, which owns that relationship) — the same reasoning that keeps `delegate_task` out of a
   * child's registry, expressed as a lineage check instead of an allowlist.
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
        emit: subAgentEmit,
        statistics,
        usage,
        trackTurn: (settled, interrupt) => residentTurns.track(settled, interrupt),
        // The serial lives with the run loop, not in the tool: an id it minted per run would repeat across
        // runs, and the inbox fold cancels an entry *by id*.
        nextMessageId,
      }),
    );

  return coordinator;
}
