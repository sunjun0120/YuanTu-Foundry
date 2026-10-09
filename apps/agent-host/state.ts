import type { Agent } from '../../packages/core/agent.ts';
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
import type { TaskEvent } from '../../packages/core/task-trigger.ts';
import type { HostLaunch } from './cli.ts';
import type { HostCarrier } from './carrier.ts';
import type { TaskScheduler } from './scheduler.ts';
import type { HostServices } from './services.ts';

/** One admitted run: how to stop it, the result it will settle to, and the agent it is driving. */
export interface ActiveRun {
  controller: AbortController;
  task?: Promise<RunResult>;
  agent?: Agent;
}

/** An approval the run is waiting on, keyed by the id the client answers with. */
export interface PendingApproval {
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
  /** Per-session sandbox overrides. A session absent here still reads the process default. */
  sessionSandboxes: Map<string, SandboxMode>;
  /** The process's permission policy, replaced wholesale by `permission.update`. */
  permissionPolicy: PermissionPolicy | undefined;
  /** Violations from the last run, so `invariants.list` can answer "does it currently hold?". */
  lastViolations: InvariantViolation[];
  /**
   * Sessions already announced to `sessionStart`. The host first learns about an existing session on
   * its first run, so that is where a resumed session is announced.
   */
  announced: Set<string>;
  active: Map<string, ActiveRun>;
  approvals: Map<string, PendingApproval>;
  /** Questions waiting for an answer, keyed by the id the client answers with. */
  questions: Map<string, PendingQuestion>;
  /** Request ids currently being served, so a duplicate cannot be answered twice. */
  requestIds: Set<string>;
  /** In-flight `handle()` calls, awaited before teardown closes anything they are using. */
  tasks: Set<Promise<void>>;
  closing: boolean;
  /** True while a plan is being executed or a change undone: the Host refuses a concurrent run. */
  restoring: boolean;
  /** The manual compaction in flight, so shutdown can abort it like any other run. */
  manualCompaction: AbortController | undefined;
  /** Sessions a background wake is currently running for. */
  waking: Set<string>;
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

  /** Announce a session to `sessionStart`, once per process. */
  announceSession: (sessionId: string, resumed: boolean) => Promise<void>;

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
    workflowIntervalMs: Number(process.env.YUANTU_WORKFLOW_INTERVAL_MS) || undefined,
    store,
    background: services.background,
    terminals: services.terminals,
    hooks,
    invariants: services.invariants,
    residency: new SubAgentResidency(),
    defaultSandboxMode: launchSandbox.mode,
    sessionSandboxes: new Map<string, SandboxMode>(),
    permissionPolicy,
    lastViolations: [],
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
    restoring: false,
    manualCompaction: undefined,
    waking: new Set<string>(),
    wakeQueued: false,
    automaticReady: false,
    approvalSources: new WeakMap<object, ApprovalDecisionSource>(),
    announceSession: async (sessionId: string, resumed: boolean): Promise<void> => {
      if (announced.has(sessionId)) return;
      announced.add(sessionId);
      const failures = await hooks.sessionStart(
        { sessionId, workspace, resumed },
        new AbortController().signal,
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
  return state;
}
