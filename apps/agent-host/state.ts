import type { Agent } from '../../packages/core/agent.ts';
import { parseSetting } from '../../packages/protocol/settings.ts';
import { underSessionPolicy, sessionLifecycleReadOnly } from './session-policy.ts';
import type { BackgroundAuthority } from '../../packages/core/background-deliveries.ts';
import type { PermissionPolicy } from '../../packages/core/permissions.ts';
import { SubAgentResidency } from '../../packages/core/residency.ts';
import type {
  Approval,
  ApprovalDecisionSource,
  Approver,
  QuestionOutcome,
  RunResult,
} from '../../packages/protocol/index.ts';
import type { InvariantViolation } from '../../packages/protocol/invariants.ts';
import type { SandboxMode } from '../../packages/tools/sandbox.ts';
import type { FileEffect, NetworkEffect } from '../../packages/protocol/execution.ts';
import type { TaskEvent } from '../../packages/protocol/task-trigger.ts';
import type { HostLaunch } from './cli.ts';
import type { HostCarrier } from './carrier.ts';
import type { TaskScheduler } from './scheduler.ts';
import type { HostServices } from './services.ts';
import { canonicalKey } from '../../packages/platform/workspace-paths.ts';
import { ResourceLocks, type Lease, type LockClaim, type LockMode } from './resource-locks.ts';

/** One admitted run: how to stop it, the result it will settle to, and the agent it is driving. */
export interface ActiveRun {
  controller: AbortController;
  task?: Promise<RunResult>;
  agent?: Agent;
  /**
   * The directory the run executes in, read once at admission so the claims it implies do not need the store.
   * Absent on an entry made without admission (tests that reserve a slot directly); the claim then reads it.
   */
  root?: string;
}

/**
 * An exclusive operation outside a run, cancellable by its owning session or by shutdown.
 *
 * `sessionId` is absent for an operation addressed by workspace binding (archive, restore or remove of an
 * orphan) — it has no session to be cancelled from, but shutdown still has to reach it.
 */
export interface ManualOperation {
  sessionId?: string;
  controller: AbortController;
}

/** An approval the run is waiting on, keyed by the id the client answers with. */
export interface PendingApproval {
  /** The session whose run is waiting, so a policy change re-decides only that session's approvals. */
  sessionId: string;
  approval: Approval;
  resolve: (allow: boolean) => void;
}

/** A question the run is waiting on, with the timer that settles it unanswered. */
export interface PendingQuestion {
  resolve: (outcome: QuestionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * What a background wake grants the run it starts.
 *
 * A wake is the one run nobody asked a person for, so it carries its own authority — the sandbox and permission
 * policy captured when the work was admitted — and its own wall clock, rather than inheriting the session's
 * current ones. The ids are the producers it was admitted for, and they are what gets settled when it ends.
 */
export interface WakeGrant {
  ids: string[];
  maxRunMs: number;
  authority: BackgroundAuthority;
}

/** The Host's one request entry point. Late-bound on the context; see the ordering note on `HostContext`. */
export type Dispatcher = (
  method: string,
  params: Record<string, unknown>,
  wake?: WakeGrant,
) => Promise<unknown>;

/**
 * Everything the Host's handlers share.
 *
 * A plain interface plus a factory rather than a class, because the pieces are not owned by one object: `shutdown`
 * reads the same slots a handler writes, and the carrier and the scheduler are built *after* this state exists and
 * then stored back into it. A class would have to grow an accessor per slot, and the point of the object is that
 * every reader sees the same mutable field.
 *
 * The late-bound slots at the bottom are the price of three genuine cycles — a wake dispatches a run, the
 * scheduler starts a run by dispatching, and a dispatch answers on the carrier — so exactly one participant in
 * each cycle has to be written into a slot that already exists. `main` fills all of them before the read loop
 * starts; nothing can observe them unset, because nothing can send a request before then.
 */
export interface HostContext {
  /** The parsed command line, including the `--listen` address when the carrier is a socket. */
  options: HostLaunch['options'];
  /** The one workspace this Host serves; every session it accepts has to resolve to it. */
  workspace: string;
  /** The sandbox the process launches in, before any per-session override. */
  launchSandbox: HostLaunch['launchSandbox'];
  /** How often the scheduler re-checks for due tasks, or undefined for its own default. */
  workflowIntervalMs: number | undefined;

  store: HostServices['store'];
  background: HostServices['background'];
  terminals: HostServices['terminals'];
  hooks: HostServices['hooks'];
  invariants: HostServices['invariants'];
  /** Resident sub-agents, disposed on shutdown once every run has been aborted. */
  residency: SubAgentResidency;

  /** The sandbox a session without its own override runs in; `sandbox.set` changes it. */
  defaultSandboxMode: SandboxMode;
  defaultSandboxFiles: FileEffect;
  defaultSandboxNetwork?: NetworkEffect;
  /** Per-session sandbox overrides. A session absent here still reads the process default. */
  sessionSandboxes: Map<string, SandboxMode>;
  sessionSandboxFiles: Map<string, FileEffect>;
  sessionSandboxNetwork: Map<string, NetworkEffect | undefined>;
  /** The permission policy a session without its own override reads; `permission.update` without a session changes it. */
  permissionPolicy: PermissionPolicy | undefined;
  /** Per-session permission overrides. A session absent here still reads the process default. */
  sessionPermissionPolicies: Map<string, PermissionPolicy>;
  /** Violations from the last run to report any, so `invariants.list` can answer "does it currently hold?". */
  lastViolations: InvariantViolation[];
  /**
   * The same answer per session. With several sessions running at once, the Host-wide "last" is whichever run
   * happened to report most recently, which says nothing about the session an operator is asking about.
   */
  sessionViolations: Map<string, InvariantViolation[]>;
  /** How many different sessions may hold a run at once (`YUANTU_HOST_MAX_RUNS`); a session itself is serial. */
  maxActiveRuns: number;
  /**
   * Sessions running a model request outside a run (`task.propose`, `context.compact`).
   *
   * They are not runs — no agent loop, no run row claimed here — but they spend the same model capacity, so they
   * count against `maxActiveRuns` and make a concurrent `run.start` wait for the next free slot.
   */
  modelSlots?: Set<string>;
  /**
   * Sessions already announced to `sessionStart`. The host first learns about an existing session on
   * its first run, so that is where a resumed session is announced.
   */
  announced: Set<string>;
  /** The run each session holds. At most one per session and at most `maxActiveRuns` in all. */
  active: Map<string, ActiveRun>;
  approvals: Map<string, PendingApproval>;
  /** Questions waiting for an answer, keyed by the id the client answers with. */
  questions: Map<string, PendingQuestion>;
  /** Request ids currently being served, so a duplicate cannot be answered twice. */
  requestIds: Set<string>;
  /** In-flight requests and optional title calls, drained before their resources close. */
  tasks: Set<Promise<void>>;
  closing: boolean;
  /**
   * Locks held by operations outside a run (undo, verification, import, compaction …).
   *
   * Runs take no lease here: the claims a run implies are derived from `active` (see `runClaims`), so a run cannot
   * forget to release them. Each operation claims only what it touches — its session, the directory it writes, a
   * workspace binding — rather than the whole Host; `docs/host-resource-locks.md` has the table.
   */
  locks: ResourceLocks;
  /** Operations outside a run that Stop and shutdown can reach. Several may run at once, in different sessions. */
  manualOperations: Set<ManualOperation>;
  /** Sessions a background wake is currently running for. Per session: wakes of different sessions may overlap. */
  waking: Set<string>;
  /** A wake pass is already queued for this microtask; Host-wide because the pass itself scans every session. */
  wakeQueued: boolean;
  /** True once a carrier has said it is ready; nothing wakes before that. */
  automaticReady: boolean;
  /**
   * Why an approval was decided the way it was, keyed by the tool call that asked.
   *
   * A `WeakMap` on the call object rather than a field on the approval: the source is read *after* the decision,
   * by the verification path, and it must not keep an approval alive to do it.
   */
  approvalSources: WeakMap<object, ApprovalDecisionSource>;

  /** Last admitted or finished run's read-only phase, including in-run approval transitions. */
  sessionLifecyclePhases: Map<string, boolean>;
  /** Announce once, but refresh the lifecycle phase whenever a run is admitted. */
  announceSession: (sessionId: string, resumed: boolean, planning?: boolean) => Promise<void>;

  /** The carrier this Host answers on: stdin/stdout, or the one accepted socket. */
  carrier: HostCarrier;
  scheduler: TaskScheduler;
  /** Fire a scheduler event without letting its rejection become an unhandled crash. */
  notifyScheduler: (event: TaskEvent) => void;
  /** Ask whether any background work now deserves a wake run. Coalesced per microtask. */
  queueWake: () => void;
  /** Write the session's current sandbox and permission policy onto its background policy row. */
  captureAuthority: (sessionId: string, permissionOnly?: boolean) => void;
  /** The authority a wake for this session would run under, without writing anything. */
  currentAuthority: (sessionId: string) => BackgroundAuthority;
  /** Stop watching the store's events; called once, on the way down. */
  stopObservingBackground: () => void;
  /**
   * The approver verification commands use.
   *
   * Built once for the process rather than per verification, because what it does is read the *live* permission
   * policy: two verifications must not be able to disagree about which policy was in force.
   */
  verifyApprover: Approver;
  /** The dispatcher, once the handler table exists. */
  dispatch: Dispatcher;
  /** One line of the carrier's JSONL, answered on the same carrier. */
  handle: (line: string) => Promise<void>;
}

/**
 * Different sessions one Host runs at once unless `YUANTU_HOST_MAX_RUNS` says otherwise.
 *
 * Two rather than one so a long run no longer holds back another session's scheduled task or wake; not more,
 * because every slot shares the same model rate gate and the same working tree.
 */
export const DEFAULT_HOST_MAX_RUNS = 2;

/**
 * A slot `main` fills before the Host serves its first request.
 *
 * The carrier, the scheduler and the dispatcher are mutually referential, so one participant in each cycle has to
 * be written into a slot that already exists rather than handed to a constructor. Declaring the slot non-optional
 * keeps that ordering out of every reader: a handler answering on the carrier has no reason to ask whether the
 * carrier is there, and a `?` it would never take is a branch no test can reach.
 */
const lateBound = <Slot>(): Slot => undefined as unknown as Slot;

/**
 * Build the Host's shared state, including the one hook-driven callback that belongs to it.
 *
 * `announceSession` is made here rather than late-bound because it needs nothing that is built later: it reads the
 * hook registry, the workspace and the announced set, all of which exist by the time this returns. It is the one
 * place a session is announced, so the dedupe and the failure reporting cannot disagree with each other.
 */
export function createHostState(launch: HostLaunch, services: HostServices): HostContext {
  const { options, workspace, launchSandbox, permissionPolicy } = launch;
  const { store, hooks } = services;
  const announced = new Set<string>();
  const state: HostContext = {
    options,
    workspace,
    launchSandbox,
    // How often the scheduler re-checks for due tasks. Only the tick cadence is configurable; the
    // schedule itself always lives on the task row.
    workflowIntervalMs: parseSetting(process.env, 'YUANTU_WORKFLOW_INTERVAL_MS') as
      number | undefined,
    store,
    background: services.background,
    terminals: services.terminals,
    hooks,
    invariants: services.invariants,
    residency: new SubAgentResidency(),
    defaultSandboxMode: launchSandbox.mode,
    defaultSandboxFiles: launchSandbox.files ?? 'workspace-write',
    defaultSandboxNetwork: launchSandbox.network,
    sessionSandboxes: new Map<string, SandboxMode>(),
    sessionSandboxFiles: new Map<string, FileEffect>(),
    sessionSandboxNetwork: new Map<string, NetworkEffect | undefined>(),
    permissionPolicy,
    sessionPermissionPolicies: new Map<string, PermissionPolicy>(),
    lastViolations: [],
    sessionViolations: new Map<string, InvariantViolation[]>(),
    maxActiveRuns:
      (parseSetting(process.env, 'YUANTU_HOST_MAX_RUNS') as number | undefined) ??
      DEFAULT_HOST_MAX_RUNS,
    modelSlots: new Set<string>(),
    announced,
    active: new Map<string, ActiveRun>(),
    approvals: new Map<string, PendingApproval>(),
    /**
     * The Host holds the pending question rather than the tool, because the answer arrives on a *later*
     * request from a different place (the desktop's question panel, the CLI's prompt) than the tool call that
     * asked it. The same shape as `approvals`, with an outcome instead of a boolean.
     */
    questions: new Map<string, PendingQuestion>(),
    requestIds: new Set<string>(),
    tasks: new Set<Promise<void>>(),
    closing: false,
    locks: new ResourceLocks(),
    manualOperations: new Set<ManualOperation>(),
    waking: new Set<string>(),
    wakeQueued: false,
    automaticReady: false,
    approvalSources: new WeakMap<object, ApprovalDecisionSource>(),
    sessionLifecyclePhases: new Map<string, boolean>(),
    announceSession: async (
      sessionId: string,
      resumed: boolean,
      planning?: boolean,
    ): Promise<void> => {
      if (planning !== undefined) state.sessionLifecyclePhases.set(sessionId, planning);
      if (announced.has(sessionId)) return;
      announced.add(sessionId);
      const failures = await underSessionPolicy(state, sessionId, () =>
        hooks.sessionStart(
          { sessionId, workspace, resumed, readOnly: sessionLifecycleReadOnly(state, sessionId) },
          new AbortController().signal,
        ),
      );
      for (const failure of failures)
        process.stderr.write(`sessionStart hook failed: ${failure}\n`);
    },
    carrier: lateBound(),
    scheduler: lateBound(),
    notifyScheduler: lateBound(),
    queueWake: lateBound(),
    captureAuthority: lateBound(),
    currentAuthority: lateBound(),
    stopObservingBackground: lateBound(),
    verifyApprover: lateBound(),
    dispatch: lateBound(),
    handle: lateBound(),
  };
  hooks.observeStop((context) => {
    if (announced.has(context.sessionId) && typeof context.readOnly === 'boolean')
      state.sessionLifecyclePhases.set(context.sessionId, context.readOnly);
  });
  return state;
}

/** The Host as a whole. Every run and operation holds it shared; only orphan maintenance takes it alone. */
export const hostClaim = (mode: LockMode): LockClaim => ({ key: 'host', mode });
/** One session. Always exclusive: a session runs one thing at a time, whether a run or an operation. */
export const sessionClaim = (sessionId: string): LockClaim => ({
  key: `session:${sessionId}`,
  mode: 'exclusive',
});
/** One execution directory, by canonical path so two spellings of the same directory are one key. */
export const rootClaim = (root: string, mode: LockMode): LockClaim => ({
  key: `root:${canonicalKey(root)}`,
  mode,
});
/** One workspace binding. */
export const bindingClaim = (bindingId: string): LockClaim => ({
  key: `binding:${bindingId}`,
  mode: 'exclusive',
});

/** The directory `sessionId` executes in; the project itself when the binding cannot be read. */
export function executionRoot(ctx: HostContext, sessionId: string): string {
  try {
    return ctx.store.workspaceBinding(sessionId).executionRoot;
  } catch {
    return ctx.workspace;
  }
}

/**
 * What a run of `sessionId` holds: the Host and its directory shared, its session alone.
 *
 * Shared on the directory is what lets two sessions on the same project run together, exactly as they did before
 * this table existed; an operation that must not see the directory change under it is what takes it alone.
 */
export function runClaims(ctx: HostContext, sessionId: string, root?: string): LockClaim[] {
  return [
    hostClaim('shared'),
    sessionClaim(sessionId),
    rootClaim(root ?? executionRoot(ctx, sessionId), 'shared'),
  ];
}

/** What an operation that checks and then writes files in `root` for `sessionId` holds. */
export function fileClaims(sessionId: string, root: string): LockClaim[] {
  return [hostClaim('shared'), sessionClaim(sessionId), rootClaim(root, 'exclusive')];
}

function heldByRuns(ctx: HostContext): LockClaim[] {
  return [...ctx.active].flatMap(([sessionId, run]) => runClaims(ctx, sessionId, run.root));
}

/** The held claim `claims` collides with, counting both leases and active runs. */
export function lockConflict(
  ctx: HostContext,
  claims: readonly LockClaim[],
): LockClaim | undefined {
  return ctx.locks.conflict(claims, heldByRuns(ctx));
}

/** Refuse with `busy` unless every claim is free right now; for operations that finish without an await. */
export function assertUnlocked(ctx: HostContext, claims: readonly LockClaim[], busy: string): void {
  if (lockConflict(ctx, claims)) throw new Error(busy);
}

/**
 * Take `claims` now, or refuse with `busy`; the caller releases the lease in its own `finally`.
 *
 * For the handlers whose existing `try`/`finally` already brackets the work; everything else uses `withLocks`.
 */
export function acquireLocks(ctx: HostContext, claims: readonly LockClaim[], busy: string): Lease {
  const lease = ctx.locks.tryAcquire(claims, heldByRuns(ctx));
  if (!lease) throw new Error(busy);
  return lease;
}

/**
 * Run `body` holding `claims`, or refuse with `busy`.
 *
 * The lease is taken synchronously, before the body's first await, for the same reason `run.start` reserves its
 * slot first: a check-then-set across an await would let a second request pass the same check. With `operation`,
 * the body is also registered as a manual operation, so Stop for that session and shutdown can abort it through
 * the signal it is handed.
 */
export async function withLocks<T>(
  ctx: HostContext,
  request: { claims: readonly LockClaim[]; busy: string; operation?: { sessionId?: string } },
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lease = acquireLocks(ctx, request.claims, request.busy);
  const controller = new AbortController();
  const manual = request.operation ? { ...request.operation, controller } : undefined;
  if (manual) ctx.manualOperations.add(manual);
  try {
    return await body(controller.signal);
  } finally {
    if (manual) ctx.manualOperations.delete(manual);
    lease.release();
  }
}

function modelSlotCount(ctx: HostContext): number {
  return ctx.modelSlots?.size ?? 0;
}

/**
 * Reserve one model slot for a request outside a run.
 *
 * `task.propose` and `context.compact` call a provider just as a run does; counting them against the same ceiling
 * keeps a burst of those requests from multiplying the Host's model concurrency. The returned function releases the
 * slot and is idempotent, so it can sit in a `finally` beside the lease.
 */
export function acquireModelSlot(ctx: HostContext, sessionId: string): () => void {
  if (ctx.active.size + modelSlotCount(ctx) >= ctx.maxActiveRuns)
    throw new Error(
      ctx.maxActiveRuns === 1
        ? 'This Host already has an active run'
        : `This Host already has an active run in each of its ${ctx.maxActiveRuns} run slots`,
    );
  const slots = (ctx.modelSlots ??= new Set<string>());
  if (slots.has(sessionId)) throw new Error('This session already has a model request in progress');
  slots.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.delete(sessionId);
  };
}

/**
 * Whether the Host has room for one more run at all: nothing holds the Host alone and a slot is free.
 *
 * Automatic starters (the scheduler, background wakes) ask this before they spend anything on a candidate, so a
 * full Host leaves due work waiting rather than claiming it and then failing admission.
 */
export function runSlotFree(ctx: HostContext): boolean {
  return (
    ctx.active.size + modelSlotCount(ctx) < ctx.maxActiveRuns &&
    !lockConflict(ctx, [hostClaim('shared')])
  );
}

/** Whether `sessionId` could be admitted now: the Host has room and nothing holds what its run would claim. */
export function sessionCanRun(ctx: HostContext, sessionId: string): boolean {
  return (
    runSlotFree(ctx) && !ctx.active.has(sessionId) && !lockConflict(ctx, runClaims(ctx, sessionId))
  );
}

/**
 * Why `run.start` for `sessionId` must be refused right now, or `undefined` when it may be admitted.
 *
 * The refusals are kept apart because they ask different things of the caller: a busy session clears only when
 * that session's own run or operation ends, while a held directory and a full Host clear on their own. Each still
 * says "already has an active run", the phrase clients have matched on since the Host was globally serial.
 */
export function admissionRefusal(ctx: HostContext, sessionId: string): string | undefined {
  if (ctx.active.has(sessionId)) return 'This session already has an active run';
  const held = lockConflict(ctx, runClaims(ctx, sessionId));
  if (held)
    return held.key.startsWith('session:')
      ? 'This session already has an active run (an exclusive operation is in progress)'
      : 'This Host already has an active run (an exclusive operation is in progress)';
  if (ctx.active.size + modelSlotCount(ctx) >= ctx.maxActiveRuns)
    return ctx.maxActiveRuns === 1
      ? 'This Host already has an active run'
      : `This Host already has an active run in each of its ${ctx.maxActiveRuns} run slots`;
  return undefined;
}
