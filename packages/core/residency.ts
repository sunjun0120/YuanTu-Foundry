import type { RunStatus, SubAgentSummaryReport, Usage } from '../protocol/index.ts';

/**
 * Residency for delegated children.
 *
 * Delegation used to be strictly one-shot: a child ran, reported, and was gone — its session stayed in the
 * database, but nothing could ask it anything else, and the only way to use what it had learned was to
 * delegate the same ground again. Every part of that is a consequence of *where the child lived*: inside
 * one call of the parent's run, borrowing the parent's tools, with its usage folded into the parent's totals
 * because that was the only place it could be attributed.
 *
 * A residency inverts that. A child becomes a resident activation: a durable child session plus, while it is
 * loaded, the ability to run another turn on it. That is what makes "ask the child a follow-up" and "tell a
 * running child to change direction" possible at all, and it is why this module exists rather than a flag on
 * the delegation tool.
 *
 * The trade-offs are real and are therefore part of the contract:
 *
 * - **A resident child owns its own resources.** It cannot borrow the parent's tool registry, because the
 *   parent's run ends and closes it; a resident child gets its own (host-provided) registry and closes it
 *   when the activation is disposed.
 * - **Usage is attributed to the child's own session** once the parent's run is over. Each turn is a run row
 *   in the child session with its own statistics, and the parent's log gets a `subagent.finished` event per
 *   turn. The parent's totals include what it observed while it was alive — not work it did not wait for.
 * - **Run end stops work in flight, it does not forget the child.** A turn still running when the parent's
 *   run ends is aborted (that was already true: an uncollected child's work was cancelled), but the
 *   activation survives as `idle`, so a later run in the same session can ask that same child to continue.
 * - **Disposal is child-first and must reach quiescence.** A grandchild is disposed before its parent, and
 *   each activation awaits its in-flight turn before closing its tools.
 */

/** How long an idle activation stays loaded, and how many may be loaded at once. */
export const RESIDENCY_DEFAULTS = {
  /** Loaded activations per process. Beyond this, the least recently used idle one is unloaded. */
  maxResident: 4,
  /** Idle activations are disposed after this long. Their sessions stay durable for a cold resume. */
  idleTtlMs: 600_000,
} as const;
export interface ResidentChild {
  /** The delegation's task id, which is also the card id in the parent's log. */
  id: string;
  childSessionId: string;
  parentSessionId: string;
  objective: string;
  depth: number;
  status: 'running' | 'idle' | 'disposed';
  turns: number;
  usage: Usage;
  lastUsedAt: number;
}
export interface ResidentTurnResult {
  usage: Usage;
  text: string;
  status: RunStatus;
  report?: SubAgentSummaryReport;
  /** The turn's structured answer, when the task it ran declared its own schema (see `SubAgentTask.schema`). */
  data?: unknown;
  error?: string;
  rounds: number;
  toolCalls: number;
}
/** What a running turn hands back so the residency can reach the child while it is still working. */
export interface ResidentTurnHandle {
  /**
   * Called by the turn runner once the child's run is live. The callback folds a message into the turn
   * that is already in flight and returns false when the child is no longer accepting corrections.
   */
  /**
   * How this activation receives a correction while it is working: the agent loop installs it for the duration
   * of a turn, and the id is the parent's name for the message, so the child's receipt can be about the same
   * message the parent wrote down rather than about a second id nobody outside the queue has seen.
   */
  attach(steer: (message: string, id?: string) => boolean): void;
}
export interface ResidentChildInput {
  id: string;
  childSessionId: string;
  parentSessionId: string;
  objective: string;
  depth: number;
  /**
   * Runs one turn on the child session.
   *
   * There is no token grant: a child is bounded the way its parent is — by its own rounds, its own window, and
   * the wall clock — and what the parent shares with its children is the slots they occupy (how many, how deep),
   * not an allowance to spend. A grant used to be handed down here, which made a follow-up quietly cheaper than
   * the first turn and made "how much may this child cost" a number that only meant something until it was
   * spent.
   */
  turn: (
    prompt: string,
    signal: AbortSignal,
    reportRequired: boolean,
    /** Optional: a runner that cannot fold a message into its turn simply does not take the handle. */
    handle?: ResidentTurnHandle,
  ) => Promise<ResidentTurnResult>;
  /** Releases whatever the child owns (its tool registry). Called once per successful release. */
  close?: () => Promise<void>;
}
export class ChildActivation {
  readonly id: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly objective: string;
  readonly depth: number;
  private readonly turn: ResidentChildInput['turn'];
  private readonly close: (() => Promise<void>) | undefined;
  private controller = new AbortController();
  private running = false;
  private disposed = false;
  /** The release in flight or completed, so concurrent disposers share one attempt and one outcome. */
  private disposing: Promise<void> | null = null;
  private turns = 0;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private lastUsed = Date.now();
  /** The turn in flight, so a message delivered mid-turn can wait for the answer it belongs to. */
  private inflight: Promise<ResidentTurnResult> | null = null;
  /** Set by the turn runner while its run is live: this is how a correction reaches the child. */
  private steer: ((message: string, id?: string) => boolean) | null = null;
  constructor(input: ResidentChildInput) {
    this.id = input.id;
    this.childSessionId = input.childSessionId;
    this.parentSessionId = input.parentSessionId;
    this.objective = input.objective;
    this.depth = input.depth;
    this.turn = input.turn;
    this.close = input.close;
  }
  get status(): ResidentChild['status'] {
    return this.disposed ? 'disposed' : this.running ? 'running' : 'idle';
  }
  /** Tokens this child has been billed for so far, as the provider reported them. Reported, never a limit. */
  get spentTokens(): number {
    return this.usage.inputTokens + this.usage.outputTokens;
  }
  snapshot(): ResidentChild {
    return {
      id: this.id,
      childSessionId: this.childSessionId,
      parentSessionId: this.parentSessionId,
      objective: this.objective,
      depth: this.depth,
      status: this.status,
      turns: this.turns,
      usage: { ...this.usage },
      lastUsedAt: this.lastUsed,
    };
  }
  /**
   * Runs one turn. Concurrent callers are serialised by the caller (the residency), because a child session
   * cannot have two runs at once — the store's own run lock would refuse the second one anyway.
   *
   * A follow-up is a turn like the first: same child, same bounds, no leftover allowance to run out of.
   *
   * `signal` is the *caller's* cancellation, for a caller that is waiting for this turn and would otherwise
   * leave it running when it goes away (a tool call that was cut off, a Stop). It is merged with, not
   * substituted for, this activation's own controller: the controller is what `interrupt()` aborts — the
   * parent's "stop this child" — and a turn started by one caller must still stop when the parent stops it.
   * Both are per turn, so a caller that went away cannot leave the next turn pre-aborted.
   *
   * Passing nothing is the previous behaviour exactly, which is what makes this optional: an idle child asked
   * to continue by a caller with nothing to cancel is bounded the way it always was.
   */
  async run(
    prompt: string,
    reportRequired: boolean,
    signal?: AbortSignal,
  ): Promise<ResidentTurnResult> {
    if (this.disposed) throw new Error('This sub-agent activation has been disposed');
    this.running = true;
    this.controller = new AbortController();
    this.lastUsed = Date.now();
    const turnSignal = signal
      ? AbortSignal.any([this.controller.signal, signal])
      : this.controller.signal;
    try {
      const turn = this.turn(prompt, turnSignal, reportRequired, {
        attach: (steer) => {
          this.steer = steer;
        },
      });
      this.inflight = turn;
      const result = await turn;
      this.turns++;
      this.usage = {
        inputTokens: this.usage.inputTokens + result.usage.inputTokens,
        outputTokens: this.usage.outputTokens + result.usage.outputTokens,
      };
      return result;
    } finally {
      this.running = false;
      this.inflight = null;
      this.steer = null;
      this.lastUsed = Date.now();
    }
  }
  /**
   * Fold a message into the turn that is already running, and optionally wait for that turn's answer.
   *
   * This is what makes a working child reachable. Without it a follow-up could only be a *second* turn, and a
   * second turn on the same child session is refused by the store's run lock — so the honest behaviour for
   * "the child is busy" was an error, and the only way to correct a child was to interrupt it and lose the
   * turn. The message is queued by the child's own run queue, so it is folded in at the next step boundary,
   * exactly like a steer from the user.
   *
   * Returns `delivered: false` when there is no live turn to fold into, which is the caller's signal to run a
   * new turn instead.
   *
   * `wait: false` returns as soon as the message is in the child's queue, with the running turn's promise as
   * `done` for a caller that wants to record the outcome when it lands. Waiting is the default because the
   * usual caller is a parent that asked a question; not waiting is what makes a message a *hand-off* rather
   * than a round trip.
   */
  async deliver(
    message: string,
    options: { wait?: boolean; id?: string } = {},
  ): Promise<{
    delivered: boolean;
    result?: ResidentTurnResult;
    done?: Promise<ResidentTurnResult>;
  }> {
    if (!this.running || !this.steer) return { delivered: false };
    if (!this.steer(message, options.id)) return { delivered: false };
    const inflight = this.inflight;
    if (!inflight) return { delivered: true };
    if (options.wait === false) return { delivered: true, done: inflight };
    return { delivered: true, result: await inflight };
  }
  /** Aborts the turn in flight, if any. The activation stays usable afterwards. */
  interrupt(): boolean {
    if (!this.running) return false;
    this.controller.abort(new Error('Interrupted by the parent agent'));
    return true;
  }
  /**
   * Aborts anything in flight, releases what the child owns, and marks the activation unusable.
   *
   * The abort comes first and the release second, so a turn that is still unwinding cannot find its own tools
   * closed underneath it. Waiting for that turn is part of the ordering, not politeness: `close` is what the
   * child's registry is closed by, and a turn that is still calling tools when it runs would be reaching into a
   * registry somebody else has already released. The turn's own outcome belongs to whoever started it, so a
   * failed turn is waited for, not adopted as the failure of the release.
   *
   * Concurrency and retry are one decision each:
   *
   * - Callers that arrive while a release is in flight share that attempt and its outcome. A release that
   *   *succeeded* is cached, so later callers observe the same completed release instead of closing twice.
   * - A release that *failed* is not cached. The activation is still unreleased, so the next `dispose` makes a
   *   fresh attempt — whether another attempt can succeed is the close owner's contract, and caching a rejection
   *   would both hide that decision and drop the only reference to the resources still held.
   */
  dispose(): Promise<void> {
    this.interrupt();
    this.disposed = true;
    if (this.disposing) return this.disposing;
    const attempt = (async () => {
      const inflight = this.inflight;
      if (inflight)
        await inflight.then(
          () => undefined,
          () => undefined,
        );
      if (this.close) await this.close();
    })();
    // Not an `async` method: an async one would wrap the shared attempt in a fresh promise per call, and
    // "concurrent callers share one attempt" would be true of the work but not of what a caller can observe.
    const shared = attempt.then(
      () => undefined,
      (error: unknown) => {
        // A failed release is still owned, so it is not cached: the next `dispose` tries again.
        this.disposing = null;
        throw error;
      },
    );
    this.disposing = shared;
    return shared;
  }
}
export class SubAgentResidency {
  private readonly activations = new Map<string, ChildActivation>();
  /**
   * Activations taken out of the registry whose release is not confirmed yet.
   *
   * Leaving the registry is a statement about what callers can *see*, not about the child's resources: an
   * eviction that failed has released nothing, and forgetting the activation here would drop the only reference
   * to a live tool registry. They stay until a close confirms the release, and `disposeAll` reports what is left.
   */
  private readonly releasing = new Map<string, ChildActivation>();
  /** Release failures already observed, carried to `disposeAll` so a background failure is reported once. */
  private releaseFailures: unknown[] = [];
  private readonly maxResident: number;
  private readonly idleTtlMs: number;
  constructor(options: { maxResident?: number; idleTtlMs?: number } = {}) {
    this.maxResident = Math.max(1, options.maxResident ?? RESIDENCY_DEFAULTS.maxResident);
    this.idleTtlMs = Math.max(0, options.idleTtlMs ?? RESIDENCY_DEFAULTS.idleTtlMs);
  }
  get size(): number {
    return this.activations.size;
  }
  /**
   * Loads a child. The caller passes the turn runner, so the residency never needs to know how a child is
   * built — the agent loop owns that, and this module stays a registry of live children.
   *
   * The LRU eviction below unloads an *idle* activation; its session stays durable, which is the whole
   * reason unloading is cheap.
   */
  open(input: ResidentChildInput): ChildActivation {
    if (this.activations.has(input.childSessionId))
      throw new Error(`Sub-agent ${input.childSessionId} is already resident`);
    if (this.activations.size >= this.maxResident) this.evictIdle();
    const activation = new ChildActivation(input);
    this.activations.set(input.childSessionId, activation);
    return activation;
  }
  get(childSessionId: string): ChildActivation | undefined {
    return this.activations.get(childSessionId);
  }
  /** Everything loaded, optionally narrowed to one parent's children. */
  list(parentSessionId?: string): ResidentChild[] {
    return [...this.activations.values()]
      .filter((activation) => !parentSessionId || activation.parentSessionId === parentSessionId)
      .map((activation) => activation.snapshot());
  }
  /** Unloads an idle activation. Refuses a running one: unloading work in flight is `interrupt` plus wait. */
  async unload(childSessionId: string): Promise<boolean> {
    const activation = this.activations.get(childSessionId);
    if (!activation) return false;
    if (activation.status === 'running') return false;
    await activation.dispose();
    this.activations.delete(childSessionId);
    return true;
  }
  /**
   * Disposes every activation, deepest first.
   *
   * Child-first is not a detail: a grandchild's turn may still be writing to a session its parent's
   * activation is about to close tools for, and a parent must not disappear while its children are alive.
   * Depth ordering gives that without a graph walk — the delegation depth is already recorded per child.
   *
   * "Every" is the other half. A release that fails is one failed cleanup, not a reason to leave the children
   * behind it resident, and a failure an eviction or a reap already hit is part of the same report — so this
   * collects instead of throwing at the first one, and reports the whole set as one `AggregateError`.
   */
  async disposeAll(): Promise<void> {
    const ordered = [...this.activations.values()].sort((a, b) => b.depth - a.depth);
    this.activations.clear();
    const failures: unknown[] = [...this.releaseFailures];
    this.releaseFailures = [];
    // Releases an eviction or a reap began but never confirmed, in the same deepest-first order. Retrying them
    // here is what "still owned until released" means: the close contract decides whether another attempt can
    // succeed, and an attempt that fails the same way is reported once.
    const unconfirmed = [...this.releasing.values()].sort((a, b) => b.depth - a.depth);
    this.releasing.clear();
    for (const activation of [...new Set([...ordered, ...unconfirmed])]) {
      try {
        await activation.dispose();
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
    }
    // A release that failed while this ran is still this call's to report.
    for (const error of this.releaseFailures) if (!failures.includes(error)) failures.push(error);
    this.releaseFailures = [];
    if (failures.length)
      throw new AggregateError(
        failures,
        `Releasing ${failures.length} sub-agent activation(s) failed`,
      );
  }
  /**
   * Unloads an activation out of the registry, with the release observed here rather than dropped.
   *
   * Both halves matter. The registry drops it first because the map is what callers observe, and the release is
   * attached to a rejection handler immediately because a promise nobody looks at turns a failed cleanup into an
   * unhandled rejection — at the moment the process is trying to stop, which is the worst time to lose it.
   */
  private release(activation: ChildActivation): void {
    this.releasing.set(activation.childSessionId, activation);
    void activation.dispose().then(
      () => {
        if (this.releasing.get(activation.childSessionId) === activation)
          this.releasing.delete(activation.childSessionId);
      },
      (error: unknown) => {
        // The activation stays in `releasing`: nothing was released, and `disposeAll` owns the report.
        this.releaseFailures.push(error);
      },
    );
  }
  private evictIdle(): void {
    const idle = [...this.activations.values()]
      .filter((activation) => activation.status === 'idle')
      .sort((a, b) => a.snapshot().lastUsedAt - b.snapshot().lastUsedAt);
    const victim = idle[0];
    if (!victim) return;
    // Removed from the registry first, then released: the map is what callers observe, so it must reflect
    // the eviction immediately even though releasing the child's resources may take a moment.
    this.activations.delete(victim.childSessionId);
    this.release(victim);
  }
  /** Unloads activations that have been idle longer than the TTL. Returns how many were unloaded. */
  reapIdle(now = Date.now()): number {
    if (!this.idleTtlMs) return 0;
    let reaped = 0;
    for (const activation of [...this.activations.values()]) {
      if (activation.status !== 'idle') continue;
      if (now - activation.snapshot().lastUsedAt < this.idleTtlMs) continue;
      this.activations.delete(activation.childSessionId);
      this.release(activation);
      reaped++;
    }
    return reaped;
  }
}
