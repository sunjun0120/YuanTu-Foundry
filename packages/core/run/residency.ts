import type { AgentEventType, Provider, Tool, ToolContext, Usage } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { addUsage } from '../../protocol/statistics.ts';
import { redactSecrets } from '../../platform/redact.ts';
import type { SubAgentResidency } from '../subagents/residency.ts';
import type { ChildTurns } from './subagents.ts';
import type { WorkspaceManager } from '../../workspaces/manager.ts';
import { assignedChildren, type AssignedChild } from '../subagents/jobs.ts';

/**
 * The control surface for resident children: `send_message` and its durable record. Acceptance is
 * written before the hand-off, so `queued` without `handed` means never delivered; waiting and
 * background paths share one settlement. A child this process never started is rebuilt from the
 * parent's log, using the delegation's own descriptor (persona, model).
 */
export interface ResidentToolOptions {
  store: SessionStore;
  parentSessionId: string;
  depth: number;
  residency: SubAgentResidency;
  /** Rebuilds a turn runner for a child of this run — the same closure a first delegation uses. */
  childTurns: ChildTurns;
  /** Resolves the provider a child was delegated to, or `undefined` when this host cannot serve it. */
  resolveProviderFor?: ((model: string) => Provider | undefined) | undefined;
  /**
   * Resolves and validates a cold-resumed child's binding, so it runs in its delegated directory; a
   * missing or mismatched binding refuses the turn.
   */
  workspaceManager?: Pick<WorkspaceManager, 'resolve' | 'validate'> | undefined;
  /** The run's own frames: a finished follow-up turn is announced through this. */
  emit: (type: AgentEventType, data: Record<string, unknown>) => void;
  /** Folded in place, so a follow-up's spending reaches the run's totals. */
  statistics: SessionStatistics;
  usage: Usage;
  /** The parent joins only follow-up turns it owns before persisting its totals. */
  trackTurn?: (settled: Promise<unknown>, interrupt: () => void) => void;
  /** The process-wide message-id serial, passed in so two runs cannot mint the same id. */
  nextMessageId: () => number;
}

export class ResidentTurnSettlements {
  private readonly pending = new Map<Promise<unknown>, () => void>();
  private failure: { reason: unknown } | undefined;

  track(settled: Promise<unknown>, interrupt: () => void): void {
    this.pending.set(settled, interrupt);
    const remove = () => this.pending.delete(settled);
    void settled.then(remove, (reason: unknown) => {
      remove();
      this.failure ??= { reason };
    });
  }

  async settle(): Promise<void> {
    const pending = [...this.pending];
    for (const [, interrupt] of pending) interrupt();
    await Promise.allSettled(pending.map(([settled]) => settled));
    if (this.failure) throw this.failure.reason;
  }
}

/**
 * Waits for a turn unless the caller's cancellation arrives first. Cancelling stops the wait, not
 * the turn, which may belong to another caller. The listener is removed in `finally`.
 */
async function waitUnlessCancelled<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let stop = () => {};
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** The `send_message` tool for one run's residency, returned rather than installed: the caller owns the registry. */
export function createResidentMessageTool(options: ResidentToolOptions): Tool {
  const { store, parentSessionId, depth, residency, childTurns, statistics, usage } = options;
  /**
   * The children this session delegated to, read from the parent's log so they survive restarts.
   */
  const loggedChildren = (): AssignedChild[] => assignedChildren(store, parentSessionId);
  /**
   * Loads a child this process never started, rebuilt from the delegation's descriptor (identity,
   * persona, model, objective) plus its durable session, so the turn is a continuation. The model
   * is passed as the task's model too, so the child's transcript names the right model. Nothing
   * about spending is restored; there is no grant.
   */
  const resume = async (childSessionId: string, signal: AbortSignal) => {
    const logged = loggedChildren().findLast((entry) => entry.childSessionId === childSessionId);
    if (!logged) return undefined;
    const childProvider = logged.model ? options.resolveProviderFor?.(logged.model) : undefined;
    if (logged.model && !childProvider)
      throw new Error(
        `This host cannot run a sub-agent on model "${logged.model}", which this child was delegated to; it was not resumed`,
      );
    const childSession = store.get(childSessionId);
    /**
     * Resolve and validate the child's binding so a resumed isolated child works in, journals
     * against and exports from its own worktree, never the delegator's.
     */
    const binding = options.workspaceManager
      ? options.workspaceManager.resolve(childSessionId)
      : undefined;
    if (binding && binding.kind !== 'shared' && binding.state !== 'ready')
      throw new Error(
        `The isolated workspace for ${childSessionId} is ${binding.state}, not ready; it was not resumed`,
      );
    if (binding && options.workspaceManager)
      await options.workspaceManager.validate(binding, signal);
    /** The delegation's own descriptor, with the model only when it named one: an older record has none. */
    const task = {
      id: logged.id,
      role: logged.role,
      objective: logged.objective,
      ...(logged.model ? { model: logged.model } : {}),
    };
    const child = childTurns({
      task,
      childSession,
      depth,
      tag: { id: logged.id, role: logged.role, objective: logged.objective },
      ...(logged.persona ? { persona: logged.persona } : {}),
      ...(childProvider ? { childProvider } : {}),
      ...(binding ? { binding } : {}),
    });
    return residency.open({
      id: logged.id,
      childSessionId,
      parentSessionId: parentSessionId,
      objective: logged.objective,
      depth,
      turn: child.turn,
      ...(child.close ? { close: child.close } : {}),
      ...(child.setEmit ? { setEmit: child.setEmit } : {}),
    });
  };
  const own = async (childSessionId: string, signal: AbortSignal) => {
    let activation = residency.get(childSessionId);
    if (!activation) activation = await resume(childSessionId, signal);
    if (!activation || activation.parentSessionId !== parentSessionId)
      throw new Error(
        `No sub-agent of this session was delegated to ${childSessionId}; call job_list to see the ones it was`,
      );
    return activation;
  };
  return {
    name: 'send_message',
    description:
      'Send another message to a sub-agent of this session you already delegated to. Use it to ask a follow-up about what it found instead of delegating the same ground again, or to correct one that is still working — a working sub-agent receives the message at its next step boundary. By default this waits for the answer and returns it; set `wait: false` to hand the message over and continue your own work, then read the answer with collect_subagents or job_output. Either way the message is written to this session’s log before it is handed over, so a message that never reached the child is reported back to you instead of disappearing.',
    inputSchema: {
      type: 'object',
      properties: {
        childSessionId: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1, maxLength: 8000 },
        wait: {
          type: 'boolean',
          description:
            'Wait for the sub-agent’s answer (default true). False returns a receipt as soon as the message has been handed over.',
        },
      },
      required: ['childSessionId', 'message'],
      additionalProperties: false,
    },
    execute: async (args: Record<string, unknown>, context: ToolContext) => {
      const signal = context.signal;
      try {
        const activation = await own(String(args.childSessionId), signal);
        const message = String(args.message);
        const wait = args.wait !== false;
        /**
         * The role from the delegation's own record (`general` only for records predating the
         * field). Never from the message, so a follow-up cannot make a read-only child writable.
         */
        const role =
          loggedChildren().findLast((entry) => entry.childSessionId === activation.childSessionId)
            ?.role ?? 'general';
        /**
         * Record acceptance before attempting the hand-off; `queued` without `handed` is what
         * `collect_subagents` reports as undelivered.
         */
        const messageId = `msg-${activation.id}-${Date.now().toString(36)}-${options.nextMessageId()}`;
        store.recordEvent(parentSessionId, 'subagent.message.queued', {
          id: messageId,
          childId: activation.id,
          childSessionId: activation.childSessionId,
          message: redactSecrets(message).slice(0, 2000),
        });
        /**
         * Turns a finished turn into what the parent and the log learn, shared by waiting and
         * background paths so both produce the same durable outcome.
         */
        const settle = (outcome: Awaited<ReturnType<typeof activation.run>>): void => {
          // A correction only observes a turn. Its initiating delegation or message owns accounting and events.
          if (delivery.delivered) return;
          options.emit('subagent.finished', {
            id: activation.id,
            sessionId: activation.childSessionId,
            role,
            objective: activation.objective,
            status: outcome.status,
            rounds: outcome.rounds,
            toolCalls: outcome.toolCalls,
            usage: outcome.usage,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
          addUsage(statistics, outcome.usage);
          usage.inputTokens += outcome.usage.inputTokens;
          usage.outputTokens += outcome.usage.outputTokens;
          if (outcome.usage.cachedInputTokens !== undefined)
            usage.cachedInputTokens =
              (usage.cachedInputTokens ?? 0) + outcome.usage.cachedInputTokens;
          if (outcome.usage.cacheWriteInputTokens !== undefined)
            usage.cacheWriteInputTokens =
              (usage.cacheWriteInputTokens ?? 0) + outcome.usage.cacheWriteInputTokens;
        };
        /**
         * Always hand off with `wait: false`; this call waits below so its own cancellation can end
         * the wait without stopping the turn.
         */
        const delivery = await activation.deliver(message, { wait: false, id: messageId });
        // An idle child has no turn to fold into, so the message becomes a new turn. Only a waiting
        // call ties its cancellation to that turn; a `wait: false` hand-off must not be stoppable
        // by the finished call (the run's end still stops it).
        let turn = delivery.done;
        if (!delivery.delivered) {
          /** Rebind to the asking run's emitter before the turn starts. */
          activation.setEmit(options.emit);
          turn = activation.run(message, false, wait ? signal : undefined);
        }
        // Settlement belongs to the turn, even when its caller stops waiting before it finishes.
        const settledTurn = turn?.then((outcome) => {
          settle(outcome);
          return outcome;
        });
        // A cancelled/background caller no longer awaits this promise; retain its rejection handler.
        void settledTurn?.catch(() => {});
        if (settledTurn && !delivery.delivered)
          options.trackTurn?.(settledTurn, () => activation.interrupt());
        /**
         * Record `handed` only if the turn actually began; otherwise the message stays `queued` for
         * `collect_subagents` to report.
         */
        const handed = delivery.delivered || activation.snapshot().status === 'running';
        if (handed)
          store.recordEvent(parentSessionId, 'subagent.message.handed', {
            id: messageId,
            childId: activation.id,
            childSessionId: activation.childSessionId,
            how: delivery.delivered ? 'correction' : 'turn',
          });
        if (!wait) {
          // The outcome is recorded when it lands; a run that ends first stops the child like any
          // background sub-agent.
          if (!handed)
            return {
              isError: true,
              content: `Message ${messageId} was accepted for ${activation.childSessionId}, but the sub-agent could not take it; it stays recorded as undelivered, so collect_subagents will report it.`,
            };
          return {
            isError: false,
            content:
              `Message ${messageId} handed to ${activation.childSessionId} ` +
              (delivery.delivered
                ? 'as a correction: it is folded in at the sub-agent’s next step boundary.\n'
                : 'as a new turn.\n') +
              'Its answer is not in this result — read it with collect_subagents (or job_output on the child session) when it lands.',
          };
        }
        // Cancelling stops only this call's wait, not a turn someone else started.
        const outcome = settledTurn ? await waitUnlessCancelled(settledTurn, signal) : undefined;
        if (!outcome)
          // Unreachable in practice; say so if it ever happens.
          return {
            isError: true,
            content: `Message ${messageId} reached ${activation.childSessionId}, but no live turn is collecting its answer; send it again if you need one.`,
          };
        // The answer is in this tool result, so record it as collected.
        store.recordEvent(parentSessionId, 'subagent.collected', {
          ids: [activation.id, activation.childSessionId],
        });
        return {
          isError: outcome.status !== 'completed',
          content:
            (delivery.delivered ? 'Delivered as a correction to the turn already running.\n' : '') +
            (outcome.text ||
              outcome.error ||
              `The sub-agent finished with status ${outcome.status} and no text.`),
        };
      } catch (error) {
        return {
          isError: true,
          content: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
