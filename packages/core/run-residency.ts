import type { AgentEventType, Provider, Tool, ToolContext, Usage } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { addUsage } from '../protocol/statistics.ts';
import { redactSecrets } from './errors.ts';
import type { SubAgentResidency } from './residency.ts';
import type { ChildTurns } from './run-subagents.ts';
import { assignedChildren, type AssignedChild } from './subagent-jobs.ts';

/**
 * The control surface for resident children: `send_message` and the durable record it keeps.
 *
 * A residency is the one delegation shape where a child outlives the turn that started it, which is what makes a
 * follow-up possible at all. Two rules make the asking honest, and both are enforced below rather than described:
 * the acceptance is written down *before* the hand-off is attempted, so an entry with no matching `handed` is
 * exactly "queued and never delivered"; and the waiting and background paths share one settlement, so "collect it
 * later" cannot quietly mean "lose the result".
 *
 * A child this process never started is *rebuilt* from the parent's own log rather than refused: its session,
 * transcript and delegation descriptor are all on disk, so a resumed turn is a continuation — rebuilt from the
 * *delegation's own* descriptor, because a child whose task named a persona or a model must not come back as
 * somebody else, and a host that cannot serve that model says so instead of answering on another one.
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
 * Waits for a turn unless the caller's own cancellation arrives first.
 *
 * The distinction this exists for is between **stopping the wait** and **stopping the turn**. A caller that is
 * merely waiting — `send_message` on a child that was started by somebody else — owns the wait and nothing
 * else: its cancellation must end its own patience, not the child's work, because the child's turn was asked
 * for by a different caller that is still entitled to the answer. Only a turn this call *started* has its
 * signal tied to the call (see `ChildActivation.run`).
 *
 * The listener is removed in the `finally` so a wait that ended for any other reason leaves nothing behind;
 * the abort branch's promise never settles afterwards, which is deliberate — nothing is waiting on it.
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
   * The children this session delegated to, as the parent's own log remembers them.
   *
   * A residency lives in memory, so after a restart every child is "gone" — while its session, its
   * transcript and the fact that it was delegated are all still on disk. That is the whole reason the
   * assignment is recorded as a durable event, and this is where it is read back.
   */
  const loggedChildren = (): AssignedChild[] => assignedChildren(store, parentSessionId);
  /**
   * Loads a child that this process never started.
   *
   * The turn runner is rebuilt from what the log knows (identity, persona, model, objective) plus the
   * child's own durable session; its transcript is what makes the resumed turn a *continuation* rather
   * than a fresh start.
   *
   * Rebuilt means *the delegation's own descriptor*, not a default one: a child whose task named a persona
   * or a model would otherwise come back as somebody else — the deployment's persona, the parent's model —
   * and nothing about the resumed turn would look wrong. A host that cannot serve the model this child was
   * delegated to says so instead of quietly answering on another one.
   *
   * The model is passed on as the *task's* model and not only as the resolved provider, because those are two
   * different statements: the provider is where the request goes, while the model is the identity the child's
   * turn runs under — its `modelInfo`, which stamps every user turn it writes and is what a reader of the
   * child's own session sees. Having only the first gave a resumed child that reached the right endpoint while
   * its transcript still said it was the parent's model.
   *
   * Nothing about spending is restored, because there was never a grant to restore: a child is bounded the
   * way its parent is — its own rounds, its own window, its own wall clock — and what a parent shares with
   * its children is the slots they occupy, not an allowance. The tokens a child has used are read from its
   * own statistics, which are durable already.
   */
  const resume = (childSessionId: string) => {
    const logged = loggedChildren().findLast((entry) => entry.childSessionId === childSessionId);
    if (!logged) return undefined;
    const childProvider = logged.model ? options.resolveProviderFor?.(logged.model) : undefined;
    if (logged.model && !childProvider)
      throw new Error(
        `This host cannot run a sub-agent on model "${logged.model}", which this child was delegated to; it was not resumed`,
      );
    const childSession = store.get(childSessionId);
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
    });
    return residency.open({
      id: logged.id,
      childSessionId,
      parentSessionId: parentSessionId,
      objective: logged.objective,
      depth,
      turn: child.turn,
      ...(child.close ? { close: child.close } : {}),
    });
  };
  const own = (childSessionId: string) => {
    const activation = residency.get(childSessionId) ?? resume(childSessionId);
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
        const activation = own(String(args.childSessionId));
        const message = String(args.message);
        const wait = args.wait !== false;
        /**
         * The role this child was delegated with, taken from the delegation's own record.
         *
         * It used to be the literal `general` here, which made every follow-up announce itself as a general
         * child whatever the delegation had said — and a child delegated as `explore` is a read-only reader, so
         * the finished record, the settlement notice and the card all reported a role the child never had.
         * `general` remains only as the fallback for a delegation recorded before the field existed.
         *
         * Read from the log, never from the message: `send_message` carries a question, and a follow-up that
         * could name its own role would be a way to ask a read-only child to come back writable.
         */
        const role =
          loggedChildren().findLast((entry) => entry.childSessionId === activation.childSessionId)
            ?.role ?? 'general';
        /**
         * The acceptance is written down *before* the hand-off is attempted.
         *
         * That order is the whole point of the inbox: the parent has accepted the message (and, with
         * `wait: false`, is about to be told so), so the record of that acceptance must not depend on the
         * hand-off succeeding. An entry with no matching `handed` is what `collect_subagents` reports back
         * as "queued and never delivered" after a crash in between.
         */
        const messageId = `msg-${activation.id}-${Date.now().toString(36)}-${options.nextMessageId()}`;
        store.recordEvent(parentSessionId, 'subagent.message.queued', {
          id: messageId,
          childId: activation.id,
          childSessionId: activation.childSessionId,
          message: redactSecrets(message).slice(0, 2000),
        });
        /**
         * One place that turns a finished turn into what the parent and the log both learn.
         *
         * Shared by the waiting and the background path on purpose: a hand-off that is not waited for must
         * produce exactly the same durable outcome (`subagent.finished` → the settlement notice) as one
         * that is, or "continue your own work and collect it later" would quietly mean "lose the result".
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
         * The hand-off is taken with `wait: false` even when this call *will* wait.
         *
         * `deliver`'s own waiting is unconditional — it resolves when the turn does — and that is exactly what
         * this tool cannot use: the wait has to end when the call is cancelled, while the turn keeps running.
         * Handing back the turn's promise is the half of the contract that is needed here, so the wait is done
         * below, where the call's signal is in hand.
         */
        const delivery = await activation.deliver(message, { wait: false, id: messageId });
        // A child that is idle has no turn to fold into: the message becomes a turn of its own. The
        // promise is kept for the background path, where nothing awaits it here. A correction whose turn
        // promise is not visible would be the one case with no outcome to report, which the waiting path
        // below refuses to pretend about.
        //
        // Only a waiting call ties its own cancellation to that new turn. A `wait: false` hand-off returns as
        // soon as the message is in the queue, and the call is then over: its signal must not be able to stop
        // work that was deliberately handed off. The run's own end still stops it, through the delegation's
        // signal rather than through this call.
        const turn =
          delivery.done ??
          (delivery.delivered
            ? undefined
            : activation.run(message, false, wait ? signal : undefined));
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
         * The hand-off is recorded only if it actually happened.
         *
         * `run` is async, so a turn it refuses (a disposed activation) shows up as a rejected promise
         * *after* this point. Asking the activation whether it is running is the synchronous fact that
         * says the turn began, and a message that never got that far stays `queued` with no `handed` —
         * which is precisely the state `collect_subagents` reports as "send it again". Writing `handed`
         * unconditionally would turn a failed hand-off into a claim that the child has it.
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
          // The outcome is recorded when it lands, not when it is asked for: the parent's next request
          // (or `collect_subagents`) is where it will read it, and a run that ends first stops the child
          // like any other background sub-agent.
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
        // The wait is the call's, the turn may not be: a correction folded into a turn somebody else started
        // keeps running when this call is cancelled, and only the waiting ends.
        const outcome = settledTurn ? await waitUnlessCancelled(settledTurn, signal) : undefined;
        if (!outcome)
          // Unreachable in practice (a delivered message always belongs to a turn whose promise the
          // residency holds), and said out loud rather than dressed up as an answer if it ever happens.
          return {
            isError: true,
            content: `Message ${messageId} reached ${activation.childSessionId}, but no live turn is collecting its answer; send it again if you need one.`,
          };
        // The follow-up's answer is in this tool result, so the parent has read it: recording delivery
        // here keeps the settlement notice from announcing a result the parent is looking at.
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
