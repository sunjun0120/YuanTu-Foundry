import type { Agent, AgentOptions } from '../agent.ts';
import type {
  Approval,
  Provider,
  SubAgentRole,
  SubAgentTag,
  ToolCall,
  Usage,
} from '../../protocol/index.ts';
import type { Session, SessionStore } from '../../storage/sqlite.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { WorkspaceBinding } from '../../protocol/workspaces.ts';
import type { WorkspaceResults } from '../../workspaces/results.ts';
import type { TreeWalkProgress } from '../../workspaces/snapshot.ts';
import { billableTokens, type SessionStatistics } from '../../protocol/statistics.ts';
import type { ResidentChildInput } from '../subagents/residency.ts';
import type { ChildTurns } from './subagents.ts';
import type { RunEmit } from './emit.ts';
import {
  EXPLORE_TOOLS,
  budgetMessage,
  resolveSubAgentOptions,
  subAgentRolePrompt,
  toolArgumentPreview,
} from '../subagents/delegation.ts';
import { CHILD_DENIED_TOOLS } from '../subagents/contract.ts';
import { RunQueueFull } from './queue.ts';
import { redactSecrets } from '../../platform/redact.ts';
import { nodeDependencyWarning } from '../../workspaces/dependencies.ts';

export interface ChildTurnOptions {
  agent: AgentOptions;
  store: SessionStore;
  tools: ToolRegistry;
  emit: RunEmit;
  sessionId: string;
  taskEffectScope: AgentOptions['taskEffectScope'];
  createAgent(options: AgentOptions): Pick<Agent, 'run' | 'enqueue'>;
  /**
   * Where this host freezes an isolated child's result, called once a turn has ended and its writes
   * have settled. Absent when the host manages no workspaces.
   */
  workspaceResults?: WorkspaceResults | undefined;
}

/** Build turns with the parent run's resources; resident activations own their registry. */
export function createChildTurns(options: ChildTurnOptions): ChildTurns {
  const { store, tools, taskEffectScope } = options;
  /**
   * The run this child's frames belong to; a variable because a resident child's turn closure
   * serves every later turn under new parent runs.
   */
  let emit = options.emit;
  return (input_: {
    task: {
      id: string;
      role: SubAgentRole;
      objective: string;
      model?: string;
    };
    childSession: Session;
    depth: number;
    tag: SubAgentTag;
    childProvider?: Provider;
    childSignal?: AbortSignal;
    /**
     * The shape this child's answer must take, when its caller defined one. Carried on the child: a
     * follow-up is a question, not the original task again.
     */
    reportSchema?: Record<string, unknown>;
    /**
     * This child's persona, when the delegation asked for one. Unlike the additive `rolePrompt`, a
     * persona replaces the deployment's (`AgentOptions.persona` shadows `deploymentPersona`).
     */
    persona?: string;
    /**
     * The directory this child was given, when children are isolated. Everything the turn reaches
     * (registry, instructions, spill, language servers) is built from this root.
     */
    binding?: WorkspaceBinding;
  }): { turn: ResidentChildInput['turn']; close?: () => Promise<void> } => {
    const { task, childSession, tag } = input_;
    const childProvider = input_.childProvider;
    const model = task.model;
    /**
     * The registry this child uses. A resident child owns a host-built one for its whole residency;
     * a one-shot child borrows the parent's, unless it has its own directory.
     */
    const binding = input_.binding;
    /**
     * An isolated child must build its own tools: a borrowed registry is bound to the delegator's
     * directory.
     */
    const rebuildTools = Boolean(binding && binding.executionRoot !== binding.projectRoot);
    /**
     * The tools this child may use. The read-only allowlist (`EXPLORE_TOOLS`) applies only to a
     * borrowed `forRun()` copy, where it stops a read-only child from controlling the parent's jobs
     * or language servers. A host-built registry is left as the host made it.
     */
    const buildTools = (): ToolRegistry => {
      if (options.agent.childTools) return options.agent.childTools(binding);
      if (rebuildTools)
        throw new Error(
          'An isolated sub-agent needs a childTools factory: a child cannot borrow the tool registry of the run that started it',
        );
      return tools.forRun(task.role === 'explore' ? { allow: EXPLORE_TOOLS } : {});
    };
    const ownsRegistry = Boolean(options.agent.subagentResidency) || rebuildTools;
    const childRegistry = buildTools();
    /**
     * No child may save or forget memories, whatever registry it has. Denied by name so later tools
     * with the same name are caught too.
     */
    childRegistry.restrict({ deny: CHILD_DENIED_TOOLS });
    let rounds = 0,
      toolCalls = 0;
    /**
     * The child's token budget, checked per turn against the child session's whole spend. Here
     * because resident children's follow-up turns are not watched by the coordinator.
     */
    const maxTokens = resolveSubAgentOptions(options.agent.subagents).maxTokens;
    /** One turn on this child session. A resident child replays it; a one-shot child runs it once. */
    const turn: ResidentChildInput['turn'] = async (prompt, turnSignal, reportRequired, handle) => {
      const names = new Map<string, string>();
      const overBudget = new AbortController();
      rounds = 0;
      toolCalls = 0;
      /**
       * The child's token total in two halves: settled turns from its log, and the run in flight.
       */
      let settledUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let liveUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      const child = options.createAgent({
        ...options.agent,
        ...(childProvider ? { provider: childProvider } : {}),
        ...(model && options.agent.modelInfo
          ? { modelInfo: { ...options.agent.modelInfo, model: redactSecrets(model) } }
          : {}),
        tools: childRegistry,
        // A one-shot child must not close a borrowed registry; a resident child's is closed by its
        // activation.
        ownsToolResources: false,
        subagentDepth: input_.depth + 1,
        subagentTag: tag,
        ...(taskEffectScope ? { taskEffectScope } : {}),
        rolePrompt: subAgentRolePrompt(task.role),
        /**
         * A persona is per agent: the child's comes from its delegation, never from the parent.
         * `deploymentPersona` is inherited on purpose.
         */
        persona: input_.persona,
        subagentResidency: undefined,
        childTools: undefined,
        approve: Object.assign(
          (approval: Approval, approvalSignal: AbortSignal) =>
            options.agent.approve({ ...approval, subagent: tag }, approvalSignal),
          { decisionSource: options.agent.approve.decisionSource },
        ),
        question: (request, questionSignal) =>
          options.agent.question
            ? options.agent.question({ ...request, subagent: tag }, questionSignal)
            : Promise.resolve({ answered: false, answers: [], reason: 'unavailable' }),
        onEvent: (event) => {
          /**
           * The child's spend and work time, folded from its own frames for the parent's card and
           * catalog, per delivered frame. Usage is settled turns plus the run in flight, so a
           * resident child's card does not reset.
           */
          const reportProgress = (): void => {
            // Count billable tokens only, excluding cached replays, like the parent's run budget.
            const spent = billableTokens(settledUsage) + billableTokens(liveUsage);
            if (maxTokens > 0 && spent > maxTokens && !overBudget.signal.aborted)
              overBudget.abort(new Error(budgetMessage(maxTokens)));
            const timing = store.turnTiming(childSession.id);
            emit('subagent.progress', {
              id: task.id,
              durationMs: timing.settledMs,
              runningSince: timing.runningSince,
              usage: {
                inputTokens: settledUsage.inputTokens + liveUsage.inputTokens,
                outputTokens: settledUsage.outputTokens + liveUsage.outputTokens,
                cachedInputTokens:
                  (settledUsage.cachedInputTokens ?? 0) + (liveUsage.cachedInputTokens ?? 0),
              },
            });
          };
          if (event.type === 'run.started') {
            const stats = store.statistics(childSession.id);
            settledUsage = {
              inputTokens: stats.inputTokens,
              outputTokens: stats.outputTokens,
              cachedInputTokens: stats.cachedInputTokens,
            };
            liveUsage = { inputTokens: 0, outputTokens: 0 };
            reportProgress();
          } else if (event.type === 'statistics.updated') {
            const stats = event.data.statistics as SessionStatistics | undefined;
            if (stats) {
              liveUsage = {
                inputTokens: stats.inputTokens,
                outputTokens: stats.outputTokens,
                cachedInputTokens: stats.cachedInputTokens,
              };
              reportProgress();
            }
          } else if (event.type === 'run.finished') {
            // The run's end is already durable, so the fold holds the settled total.
            reportProgress();
          } else if (event.type === 'message.finished') rounds++;
          else if (event.type === 'message.delta')
            emit('subagent.delta', { id: task.id, text: event.data.text });
          else if (event.type === 'input.consumed') {
            /**
             * The child's turn consumed the message: record the receipt under the id this parent
             * gave it. Unknown ids cancel nothing.
             */
            const id = String(event.data.id ?? '');
            if (id)
              store.recordEvent(options.sessionId, 'subagent.message.consumed', {
                id,
                childId: task.id,
                childSessionId: childSession.id,
              });
          } else if (event.type === 'tool.started') {
            const call = event.data.call as ToolCall;
            names.set(call.id, call.name);
            emit('subagent.tool', {
              id: task.id,
              name: call.name,
              phase: 'started',
              args: toolArgumentPreview(call.arguments),
            });
          } else if (event.type === 'tool.finished') {
            toolCalls++;
            emit('subagent.tool', {
              id: task.id,
              name: names.get(String(event.data.callId)) ?? 'tool',
              phase: 'finished',
              isError: event.data.isError === true,
            });
          }
        },
      });
      // A resident child can be corrected while it works: the handle folds a message into this
      // turn's own queue, which the run loop consumes at its next step boundary. Attached after the
      // run has been started, so the session is already marked running and the queue will take it.
      /**
       * Either signal ends the turn: the delegation's or the activation's. The delegation signal is
       * bridged per turn, not combined with `AbortSignal.any`, because the closure is reused:
       * combining it would abort every later turn once the child had been cancelled once.
       */
      const delegationEnded = new AbortController();
      const end = () => delegationEnded.abort(input_.childSignal?.reason);
      input_.childSignal?.addEventListener('abort', end, { once: true });
      const started = child.run({
        sessionId: childSession.id,
        prompt,
        signal: AbortSignal.any(
          input_.childSignal
            ? [delegationEnded.signal, turnSignal, overBudget.signal]
            : [turnSignal, overBudget.signal],
        ),
        readOnly: task.role === 'explore',
        // A child answers through the report tool; its prose is the fallback. A follow-up turn's
        // answer is its text.
        reportRequired,
        // Only when this turn is the task; a follow-up is a question.
        ...(reportRequired && input_.reportSchema ? { reportSchema: input_.reportSchema } : {}),
        /**
         * Journal writes against the session whose directory they happened in: a shared child's go
         * to the delegator (one change list and undo), an isolated child's to its own session.
         */
        journalSessionId: binding?.kind === 'worktree' ? childSession.id : options.sessionId,
      });
      handle?.attach((message, id) => {
        try {
          child.enqueue(childSession.id, { prompt: message }, 'steer', id);
          return true;
        } catch (error) {
          /**
           * A full queue is not "the turn ended": rethrow so the message stays `queued` instead of
           * starting a second turn and wrongly recording it as handed over.
           */
          if (error instanceof RunQueueFull) throw error;
          // The turn ended between the delivery and the queue: the caller runs a new turn instead.
          return false;
        }
      });
      try {
        const result = await started;
        /**
         * Freeze the child's work as soon as its turn ends, the last moment the directory provably
         * holds one state. An export failure never fails the turn; it is published as a diagnostic.
         */
        if (binding?.kind === 'worktree' && options.workspaceResults) {
          try {
            /**
             * One progress frame per five hundred paths plus the final one, so a long export does
             * not look hung.
             */
            let reportedProgress = 0;
            const onProgress = (progress: TreeWalkProgress): void => {
              if (progress.processed !== progress.total && progress.processed % 500 !== 0) return;
              if (progress.processed <= reportedProgress) return;
              reportedProgress = progress.processed;
              emit('subagent.workspace.progress', {
                id: task.id,
                childSessionId: childSession.id,
                processed: progress.processed,
                total: progress.total,
              });
            };
            const result = await options.workspaceResults.export({
              childSessionId: childSession.id,
              signal: turnSignal,
              onProgress,
            });
            /**
             * Where the child worked and what it produced, published after the export (not on
             * `subagent.finished`, which settles earlier).
             */
            const dependencyWarning =
              binding.kind === 'worktree'
                ? await nodeDependencyWarning(binding.executionRoot, new AbortController().signal)
                : null;
            emit('subagent.workspace', {
              id: task.id,
              childSessionId: childSession.id,
              bindingId: binding.id,
              kind: binding.kind,
              executionRoot: binding.executionRoot,
              state: binding.state,
              ...(dependencyWarning ? { dependencyWarning: dependencyWarning.message } : {}),
              ...(result
                ? {
                    result: {
                      id: result.id,
                      digest: result.digest,
                      status: result.status,
                      paths: result.paths,
                    },
                  }
                : {}),
            });
          } catch (error) {
            emit('subagent.workspace.failed', {
              id: task.id,
              childSessionId: childSession.id,
              bindingId: binding.id,
              reason: redactSecrets(error instanceof Error ? error.message : String(error)),
            });
          }
        }
        // A turn the budget stopped says so, rather than the anonymous "Run cancelled" its signal produced.
        const budgetError = overBudget.signal.aborted ? budgetMessage(maxTokens) : undefined;
        /**
         * A turn held to a caller's schema that never submitted it is not completed; the prose
         * stays in `text`.
         */
        const missingAnswer =
          !budgetError &&
          reportRequired &&
          input_.reportSchema !== undefined &&
          result.status === 'completed' &&
          result.data === undefined
            ? 'The sub-agent ended without submitting the result its schema asked for; its prose answer is in the transcript.'
            : undefined;
        return {
          usage: result.usage,
          text: result.text,
          status: budgetError || missingAnswer ? 'failed' : result.status,
          ...(result.report ? { report: result.report } : {}),
          ...(result.data !== undefined ? { data: result.data } : {}),
          ...(budgetError || missingAnswer || result.error
            ? { error: budgetError ?? missingAnswer ?? result.error }
            : {}),
          rounds,
          toolCalls,
        };
      } finally {
        // Detach the bridge so the dead delegation is not kept alive.
        input_.childSignal?.removeEventListener('abort', end);
      }
    };
    const runner: ReturnType<ChildTurns> = {
      turn,
      ...(ownsRegistry ? { close: () => childRegistry.close() } : {}),
      setEmit: (next: RunEmit) => {
        emit = next;
      },
    };
    return runner;
  };
}
