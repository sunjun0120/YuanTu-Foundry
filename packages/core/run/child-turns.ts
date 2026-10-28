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
import type { SessionStatistics } from '../../protocol/statistics.ts';
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
   * Where this host freezes what an isolated child produced.
   *
   * Called once a turn has ended, which is the first moment the answer is meaningful: the child has stopped writing,
   * its journalled writes have settled, and the directory holds one state rather than a moment of a build. Absent
   * for a host that manages no workspaces, and then nothing is exported and nothing is claimed.
   */
  workspaceResults?: WorkspaceResults | undefined;
}

/** Build turns with the parent run's resources; resident activations own their registry. */
export function createChildTurns(options: ChildTurnOptions): ChildTurns {
  const { store, tools, taskEffectScope } = options;
  /**
   * The run this child's frames belong to, rebound by the residency when a new parent run continues an
   * existing child. It is a variable rather than a captured constant because the same turn closure serves
   * every later turn of a resident child.
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
     * The shape this child's answer must take, when its caller defined one.
     *
     * Carried on the *child* rather than on the turn, because it belongs to the task: a resident child asked a
     * follow-up later is being asked a question, not handed the original task again.
     */
    reportSchema?: Record<string, unknown>;
    /**
     * This child's persona, when the delegation asked for one.
     *
     * A *different* statement from `rolePrompt`, which every child gets: the role says what the child may do
     * and is additive, while a persona is who is speaking and replaces the deployment's (`AgentOptions.persona`
     * shadows `deploymentPersona` in the prompt's own slot). Passing the role prompt here instead — which the
     * coordinator used to do — would have erased the harness's identity paragraph for every delegated child.
     */
    persona?: string;
    /**
     * The directory this child was given, when the run isolates its children.
     *
     * Everything the child's turn reaches — its registry, its instructions, its spill, its language servers — is
     * built from *this* root rather than the delegator's. That is the whole point of isolation at this seam: a child
     * told to work in a copy and then handed the original's tools would write into the tree it was protected from.
     */
    binding?: WorkspaceBinding;
  }): { turn: ResidentChildInput['turn']; close?: () => Promise<void> } => {
    const { task, childSession, tag } = input_;
    const childProvider = input_.childProvider;
    const model = task.model;
    /**
     * The registry this child uses.
     *
     * A resident child owns one built by the host and keeps it for its whole residency: the parent
     * run's registry dies with the run, so a child that borrowed it would lose its tools between
     * turns. A one-shot child keeps borrowing the parent's copy, which is what makes its parent's
     * language servers, background commands and MCP connections reachable without duplicating them —
     * unless it was given a directory of its own, in which case borrowing would mean reading and
     * writing the delegator's tree through tools that were built for it.
     */
    const binding = input_.binding;
    /**
     * Whether this child must build its *own* tools rather than borrow the parent's copy.
     *
     * A borrowed registry carries the parent's `workspaceRoot` and the factories that were bound to it, so every
     * file, command, language server and spill would still point at the delegator's directory. Isolation is
     * therefore a rebuilding decision at this seam and not merely a path change.
     */
    const rebuildTools = Boolean(binding && binding.executionRoot !== binding.projectRoot);
    /**
     * The tools this child may use, from whichever factory owns it.
     *
     * The read-only narrowing is applied to the registry a child *borrows*, and deliberately not to one a host
     * factory builds. A factory is asked for a registry, and the host that owns it decides what that registry
     * contains — a resident child's registry outlives the run, is never copied from the parent's, and may already
     * carry restrictions of its own. Narrowing it here would be this module overruling the host that built it,
     * which is exactly what a resident child's first tool call exposed: the registry a host had handed over came
     * back with the parent's tools *and* the read-only allowlist applied to them, so a tool the host had installed
     * on it was reported as "registered but excluded by a restriction".
     *
     * The borrowed path is where the narrowing genuinely belongs: `forRun()` is the copy the parent's own registry
     * produces, and `allow: EXPLORE_TOOLS` is what stops a read-only child from stopping its parent's background
     * jobs or language servers — tools that carry no permission and would otherwise pass the read-only filter.
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
    let rounds = 0,
      toolCalls = 0;
    /**
     * The child's token budget, enforced per turn against the child session's whole spend.
     *
     * Here rather than only in the coordinator, because a resident child's follow-up turns (`send_message`) are not
     * the coordinator's to watch: the delegation that admitted the child has settled, so a budget checked there
     * stopped applying after the first answer and a child asked again and again could spend without limit. Every
     * turn of every child passes through this function, so this is the one place both cases meet.
     */
    const maxTokens = resolveSubAgentOptions(options.agent.subagents).maxTokens;
    /** One turn on this child session. A resident child replays it; a one-shot child runs it once. */
    const turn: ResidentChildInput['turn'] = async (prompt, turnSignal, reportRequired, handle) => {
      const names = new Map<string, string>();
      const overBudget = new AbortController();
      rounds = 0;
      toolCalls = 0;
      /**
       * The child's token total, in the two halves it is made of: what its already-logged turns spent, and
       * what the run being reported now has spent. Kept apart rather than re-read as one number because the
       * settled half is a fold of the child's log and the live half is a frame in flight.
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
        // A one-shot child must not close the registry it borrowed; a resident child's registry is
        // closed by its activation, which is the only thing that knows when the residency ends.
        ownsToolResources: false,
        subagentDepth: input_.depth + 1,
        subagentTag: tag,
        ...(taskEffectScope ? { taskEffectScope } : {}),
        rolePrompt: subAgentRolePrompt(task.role),
        /**
         * A persona is **per agent**, so the child's is decided by its delegation and never inherited.
         *
         * Without this the child would carry the parent's persona, and the prompt slot would report the
         * deployment's persona as replaced by a paragraph the child was never given. `deploymentPersona` *is*
         * inherited, deliberately: it is the deployment's default, and a child of this deployment speaks with
         * it unless its delegation says otherwise.
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
           * What this child has spent and how long it has worked, folded from the child's own frames.
           *
           * The parent's card and the header catalog both show a running child's tokens and time, and
           * neither number exists on the parent's side: usage reaches it only when the child finishes, and
           * the child's turn clock belongs to the child's session. The child's own frames carry both, so
           * they are folded here into one live shape — per delivered frame, which is the same cadence
           * `subagent.delta` already runs at.
           *
           * The usage total is settled turns plus the run in flight: the child's session statistics hold
           * everything already logged, and `statistics.updated` holds the run being reported now, so a
           * resident child's second turn does not start its card back at zero.
           */
          const reportProgress = (): void => {
            const spent =
              settledUsage.inputTokens +
              liveUsage.inputTokens +
              settledUsage.outputTokens +
              liveUsage.outputTokens;
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
              },
            });
          };
          if (event.type === 'run.started') {
            const stats = store.statistics(childSession.id);
            settledUsage = { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens };
            liveUsage = { inputTokens: 0, outputTokens: 0 };
            reportProgress();
          } else if (event.type === 'statistics.updated') {
            const stats = event.data.statistics as SessionStatistics | undefined;
            if (stats) {
              liveUsage = { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens };
              reportProgress();
            }
          } else if (event.type === 'run.finished') {
            // The run's own end is durable by now (`finishRun` records it before it is announced), so the
            // fold already holds the settled total this frame is about to publish.
            reportProgress();
          } else if (event.type === 'message.finished') rounds++;
          else if (event.type === 'message.delta')
            emit('subagent.delta', { id: task.id, text: event.data.text });
          else if (event.type === 'input.consumed') {
            /**
             * The child's own turn took the message up: this is the receipt the parent's log was missing.
             *
             * The id is the one *this* parent gave the message (`send_message` passes it into the child's
             * queue), so the two records are about one message, and a child that folds a correction into its
             * transcript now says so durably instead of leaving the parent to infer it from "handed" — which
             * only ever meant "a turn's queue accepted it". An id this session never queued is ignored by the
             * fold: ids are unique, so a record that cancels nothing cannot cancel the wrong thing.
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
       * Either signal ends the turn: the delegation's (a cancelled or ended parent run) or the
       * activation's (an interrupt aimed at this child).
       *
       * The delegation's signal is bridged per turn rather than combined into the turn's own signal.
       * `AbortSignal.any` captures its inputs at construction: a resident child's turn closure is built
       * once, by the delegation, and reused by every later turn — so combining the delegation signal into
       * it meant that once a run cancelled the child, every following turn aborted the moment it started.
       * The child looked reachable (a turn ran, the counter moved) and answered "Run cancelled" forever,
       * which is the opposite of what "the activation survives as idle" promises. A listener added to an
       * already-aborted signal never fires, so a turn started after the delegation ended runs normally,
       * while a turn already in flight still stops when its delegation is cancelled.
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
        // A child answers through the report tool, so the parent gets findings it can cite; its
        // final prose is the fallback when it never gets that far. A follow-up on a resident child
        // is an ordinary turn: it was asked a question, so its answer is the text.
        reportRequired,
        // Only when this turn *is* the task: a follow-up on a resident child is a question, and holding it
        // to the original task's shape would be answering a question with a form.
        ...(reportRequired && input_.reportSchema ? { reportSchema: input_.reportSchema } : {}),
        /**
         * The child's writes are journaled against the session whose directory they happened in — which is decided
         * by the *kind* of binding, not by whether one exists.
         *
         * A shared child works in the delegator's directory, so its journal belongs to the delegator: that is what
         * keeps the session change list and undo one surface, and it is what every delegation did before isolation
         * existed. An isolated child's paths are relative to a directory the delegator's undo has never seen, so
         * writing them into the parent's journal would make the parent's undo operate on files it does not have.
         * Testing "is there a binding" instead of "is it isolated" would send every shared child's writes into its
         * own hidden session, where the parent's change list could not show them at all.
         */
        journalSessionId: binding?.kind === 'worktree' ? childSession.id : options.sessionId,
      });
      handle?.attach((message, id) => {
        try {
          child.enqueue(childSession.id, { prompt: message }, 'steer', id);
          return true;
        } catch (error) {
          /**
           * A full queue is not "the turn ended".
           *
           * Both used to arrive here as one throw, and answering "no live turn" for a full queue had the
           * caller start a second turn on a child that is already running — refused by the store's run lock —
           * and then record the message as handed over, because the child still *is* running. Letting this
           * one out keeps the message `queued`: the parent is told the child could not take it, which is the
           * truth, and `collect_subagents` reports it as something to send again.
           */
          if (error instanceof RunQueueFull) throw error;
          // The turn ended between the delivery and the queue: the caller runs a new turn instead.
          return false;
        }
      });
      try {
        const result = await started;
        /**
         * The child's work is frozen as soon as its turn is over.
         *
         * Here rather than at collect time, because this is the last moment the directory provably holds one state:
         * the turn has ended, the tools have returned, and nothing of this child's is running. Exporting later —
         * when the parent finally reads a report, which may be a run boundary away — would freeze whatever the
         * directory had become by then, including anything a follow-up turn added.
         *
         * A failure to export never fails the child's turn. The turn *happened*: its report, its usage and its
         * journal are all recorded, and a parent that was told "your child failed" because a frozen record could not
         * be written would be losing the answer it paid for. The child's outcome is reported as it is, and the
         * failure is published as a diagnostic so the reason is visible rather than silent.
         */
        if (binding?.kind === 'worktree' && options.workspaceResults) {
          try {
            /**
             * One frame per five hundred paths, plus the final one.
             *
             * A 50k-file first export spends its time in the walk, and a line that only appears when the export is
             * over is indistinguishable from a hang. The throttle is by count rather than time because the walk
             * itself is synchronous enough that a timer would only add frames between files that changed nothing.
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
             * Where the child worked, and what it produced — published as one frame, after the export.
             *
             * The result is only a fact once it has been frozen, so this cannot ride `subagent.finished`: that frame
             * is emitted during settlement, and a card that showed "awaiting import" before an export existed would
             * be offering work the parent cannot apply.
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
        return {
          usage: result.usage,
          text: result.text,
          status: budgetError ? 'failed' : result.status,
          ...(result.report ? { report: result.report } : {}),
          ...(result.data !== undefined ? { data: result.data } : {}),
          ...(budgetError || result.error ? { error: budgetError ?? result.error } : {}),
          rounds,
          toolCalls,
        };
      } finally {
        // The bridge belongs to this turn: left attached, a later delegation signal would abort nothing
        // anyway, but the listener would keep the dead delegation alive in memory for the process's life.
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
