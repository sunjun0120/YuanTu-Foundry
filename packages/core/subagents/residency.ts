import type { RunStatus, SubAgentSummaryReport, Usage } from '../../protocol/index.ts';
import type { RunEmit } from '../run/emit.ts';

/**
 * Residency for delegated children: a child becomes a resident activation, a durable child session
 * that, while loaded, can run further turns. This is what lets a parent ask a child a follow-up or
 * redirect it mid-turn.
 *
 * - A resident child owns its resources: it gets its own host-provided registry and closes it on
 *   disposal.
 * - Usage is attributed to the child's own session; each turn is a run row there, and the parent's
 *   log gets a `subagent.finished` per turn.
 * - Run end aborts a turn in flight but keeps the activation `idle`, so a later run can continue
 *   it.
 * - Disposal is child-first and waits for in-flight turns before closing tools.
 */

/** How long an idle activation stays loaded, and how many may be loaded at once. */
export const RESIDENCY_DEFAULTS = {
  /** Loaded activations per process. Beyond this, the least recently used idle one is unloaded. */
  maxResident: 4,
  /** Idle activations are disposed after this long. Their sessions stay durable for a cold resume. */
  idleTtlMs: 600_000,
  /**
   * How often a Host sweeps idle activations past the TTL. The cap is not enforced against running
   * children, so the sweep returns an idle Host to its resting size.
   */
  reapIntervalMs: 60_000,
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
   * How this activation receives a correction while working; installed by the agent loop for one
   * turn. The id is the parent's, so the child's receipt refers to the same message.
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
   * Runs one turn on the child session. No token grant: the child is bounded like its parent; what
   * they share is slots (count and depth).
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
  /**
   * Rebinds the emitter for the next turn, so a follow-up under a new parent run publishes under
   * the current run id.
   */
  setEmit?: (emit: RunEmit) => void;
}
export class ChildActivation {
  readonly id: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly objective: string;
  readonly depth: number;
  private readonly turn: ResidentChildInput['turn'];
  private readonly close: (() => Promise<void>) | undefined;
  private readonly rebindEmit: ResidentChildInput['setEmit'];
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
  /** How many times `interrupt` has stopped this child: what a queued turn compares against before it starts. */
  private interrupts = 0;
  constructor(input: ResidentChildInput) {
    this.id = input.id;
    this.childSessionId = input.childSessionId;
    this.parentSessionId = input.parentSessionId;
    this.objective = input.objective;
    this.depth = input.depth;
    this.turn = input.turn;
    this.close = input.close;
    this.rebindEmit = input.setEmit;
  }
  /** Points the next turn at the run that is asking for it. */
  setEmit(emit: RunEmit): void {
    this.rebindEmit?.(emit);
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
   * Runs one turn; a child session cannot run two at once. `signal` is the caller's cancellation,
   * merged with (not replacing) this activation's controller, which `interrupt()` aborts. Both are
   * per turn.
   */
  async run(
    prompt: string,
    reportRequired: boolean,
    signal?: AbortSignal,
  ): Promise<ResidentTurnResult> {
    if (this.disposed) throw new Error('This sub-agent activation has been disposed');
    /**
     * A turn waits for the previous turn to finish entirely (including result export), not just its
     * model run. Marked running before the wait so synchronous callers see the truth.
     */
    this.running = true;
    const interruptsBefore = this.interrupts;
    while (this.inflight)
      await this.inflight.then(
        () => undefined,
        () => undefined,
      );
    // A turn stopped while queued never starts.
    const refusal = this.disposed
      ? new Error('This sub-agent activation has been disposed')
      : this.interrupts !== interruptsBefore
        ? new Error('Interrupted by the parent agent')
        : signal?.aborted
          ? signal.reason instanceof Error
            ? signal.reason
            : new Error('The call that asked for this turn was cancelled')
          : undefined;
    if (refusal) {
      if (!this.inflight) this.running = false;
      throw refusal;
    }
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
   * Fold a message into the running turn at its next step boundary, optionally waiting for the
   * answer. `delivered: false` means there is no live turn; run a new one instead. `wait: false`
   * returns once queued, with the turn's promise as `done`.
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
    // Counted as well as aborted, so a turn still queued behind the running one sees the stop too.
    this.interrupts++;
    this.controller.abort(new Error('Interrupted by the parent agent'));
    return true;
  }
  /**
   * Aborts work in flight, waits for the turn to unwind, then releases the child's resources and
   * marks the activation unusable. Concurrent callers share one attempt; a successful release is
   * cached, a failed one is not, so the next `dispose` retries.
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
    // Not `async`, so concurrent callers observe the same promise.
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
   * Activations removed from the registry whose release is not yet confirmed; kept until a close
   * succeeds and reported by `disposeAll`. Keyed by activation because a child can be reloaded
   * while still releasing.
   */
  private readonly releasing = new Set<ChildActivation>();
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
   * Loads a child. The caller passes the turn runner, so this stays a registry of live children.
   * LRU eviction only unloads idle activations, whose sessions stay durable.
   */
  open(input: ResidentChildInput): ChildActivation {
    if (this.activations.has(input.childSessionId))
      throw new Error(`Sub-agent ${input.childSessionId} is already resident`);
    // Evict every idle activation past the cap, not just one.
    while (this.activations.size >= this.maxResident && this.evictIdle());
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
   * Disposes every activation, deepest first, so a parent never closes while its children are
   * alive. Failures are collected and reported together as one `AggregateError`.
   */
  async disposeAll(): Promise<void> {
    const ordered = [...this.activations.values()].sort((a, b) => b.depth - a.depth);
    this.activations.clear();
    const failures: unknown[] = [...this.releaseFailures];
    this.releaseFailures = [];
    // Retry releases an eviction or reap started but never confirmed, deepest first.
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
   * Unloads an activation: remove from the registry first, and observe the release immediately so a
   * failure is not an unhandled rejection.
   */
  private release(activation: ChildActivation): void {
    this.releasing.add(activation);
    void activation.dispose().then(
      () => {
        this.releasing.delete(activation);
      },
      (error: unknown) => {
        // The activation stays in `releasing`: nothing was released, and `disposeAll` owns the report.
        this.releaseFailures.push(error);
      },
    );
  }
  /** Unloads the least recently used idle activation; false when every loaded one is running. */
  private evictIdle(): boolean {
    const idle = [...this.activations.values()]
      .filter((activation) => activation.status === 'idle')
      .sort((a, b) => a.snapshot().lastUsedAt - b.snapshot().lastUsedAt);
    const victim = idle[0];
    if (!victim) return false;
    // Remove from the registry first; releasing resources may take a moment.
    this.activations.delete(victim.childSessionId);
    this.release(victim);
    return true;
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
