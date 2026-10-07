#!/usr/bin/env node
import { BackgroundCommands } from '../../packages/tools/background.ts';
import { negotiateHostVersion, HostProtocolError } from '../../packages/protocol/host-wire.ts';
import { commandRecords } from '../../packages/core/command-jobs.ts';
import type { BackgroundJobSnapshot } from '../../packages/protocol/rpc.ts';
import {
  admitBackground,
  backgroundAuthority,
  type BackgroundAuthority,
  backgroundState,
  finishBackground,
  reconcileBackground,
  setBackgroundPolicy,
} from '../../packages/core/background-deliveries.ts';
import { TerminalSessions } from '../../packages/tools/terminal.ts';
import { reconcilePendingFileChanges, undoFileChange } from '../../packages/tools/file-undo.ts';
// The class that owns the workspace's path rules. `files.list`/`files.read` reuse it rather than restating
// its containment and ignore rules, so a client's file tree and the model's own tools cannot disagree about
// which paths exist.
import { Workspace } from '../../packages/tools/files.ts';
import { resolveSandboxConfig, type SandboxMode } from '../../packages/tools/sandbox.ts';
import { executionPolicy as callExecutionPolicy } from '../../packages/tools/execution-policy.ts';
import {
  FILE_PREVIEW_BYTES,
  FILE_TREE_ENTRY_LIMIT,
  type WorkspaceEntry,
} from '../../packages/protocol/rpc.ts';
import { createInterface, type Interface } from 'node:readline';
import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { PermissionPolicy, readPermissionPolicy } from '../../packages/core/permissions.ts';
import { parseArgs } from '../shared/args.ts';
import {
  assertEnvironment,
  parseSetting,
  resolveRunLimits,
} from '../../packages/protocol/settings.ts';
import {
  openStore,
  createAgent,
  modelInfoFor,
  resolveWorkspace,
  safeError,
  executionEnvironment,
  applySandboxDefaults,
} from '../shared/runtime.ts';
import type {
  Approval,
  AgentEvent,
  Message,
  RunResult,
  Approver,
  ApprovalDecisionSource,
  QuestionAnswer,
  QuestionOutcome,
  QuestionRequest,
  Questioner,
  Task,
  TaskAttempt,
  TaskTriggerSource,
} from '../../packages/protocol/index.ts';
import type { StepRecord } from '../../packages/protocol/steps.ts';
import type { Agent } from '../../packages/core/agent.ts';
import { SubAgentResidency } from '../../packages/core/residency.ts';
import { pendingTaskDeliveries } from '../../packages/core/task-deliveries.ts';
import {
  validateImages,
  MAX_INPUT_BYTES,
  MAX_IMAGE_BYTES,
  sniffImageType,
} from '../../packages/protocol/images.ts';
import { loadInstructions } from '../../packages/resources/instructions.ts';
import { discoverSkills } from '../../packages/resources/skills.ts';
import { extensionTools } from '../../packages/resources/extensions.ts';
import { proposeTask } from '../../packages/core/task-planner.ts';
import { generateSessionTitle } from '../../packages/core/session-title.ts';
import { runGoalRounds } from '../../packages/core/goal-driver.ts';
import {
  GOAL_CONTINUATIONS_PER_REQUEST,
  exhaustedGoalVerdict,
} from '../../packages/protocol/goals.ts';
import { createProvider, readConfig } from '../../packages/providers/index.ts';
import { emptyStatistics, addUsage } from '../../packages/protocol/statistics.ts';
import { prepareContext, withoutSummarySection } from '../../packages/core/context.ts';
import { TokenCalibration, calibrationRoute } from '../../packages/core/calibration.ts';
import { estimateMessageTokens } from '../../packages/core/budget.ts';
import { spillResult } from '../../packages/tools/spill.ts';
import {
  contextBoundaries,
  foldContextEnvelopes,
  isMachineContext,
} from '../../packages/protocol/context.ts';
import { loadHookRegistry } from '../shared/hooks.ts';
import { verifyTaskAcceptance, type TaskBaselines } from '../../packages/core/task-acceptance.ts';
import { TaskScheduler } from './scheduler.ts';
import { DeferredApprovalError } from '../../packages/core/approval-deferred.ts';
import { InvariantRegistry } from '../../packages/core/invariants.ts';
import { logTablesAgreeInvariant } from '../../packages/storage/invariants.ts';
import { auditEntries } from '../../packages/storage/events.ts';
import { emittedEventTypesInvariant } from '../../packages/protocol/invariants.ts';
import { pipelineStagesInvariant } from '../../packages/tools/pipeline.ts';
import type { InvariantViolation } from '../../packages/protocol/invariants.ts';

async function main(): Promise<void> {
  // The Host is the process that owns the run's limits, so it is also the process that refuses to start on a
  // mistyped YUANTU_* name — silently ignoring one is how a run ends up using a budget nobody asked for.
  assertEnvironment();
  // The command sandbox is chosen from the platform before anything reads it, so the default is a real backend
  // rather than "no isolation" (see `applySandboxDefaults`). A carrier that passes `YUANTU_SANDBOX` explicitly
  // — the desktop does — keeps its own choice.
  applySandboxDefaults();
  const { options, positionals } = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'YuanTu Agent Host: JSONL stdin/stdout. Options: --workspace <dir> --db <file> --listen [host:]port.\n',
    );
    return;
  }
  if (positionals.length) throw new Error('Agent Host accepts options only');
  const workspace = resolveWorkspace(options.workspace ?? process.cwd());
  const launchSandbox = resolveSandboxConfig();
  let defaultSandboxMode = launchSandbox.mode;
  const sessionSandboxes = new Map<string, SandboxMode>();
  let permissionPolicy = readPermissionPolicy(
    options.permissionPolicy ?? process.env.YUANTU_PERMISSION_POLICY,
  );
  const store = openStore(options);
  /**
   * Converge the runs a dead Host left in flight, before serving anything.
   *
   * This is what makes a crash survivable from the client's side: the session is usable, deletable and
   * editable again, its unresolved calls carry "outcome unknown" instead of waiting forever, and each
   * session's own log records that its run was interrupted.
   */
  store.reconcileInterruptedRuns(workspace);
  store.recoverInterruptedTasks(workspace);
  // Sub-agent sessions are hidden from the session list and have no tasks, so a run they left behind
  // would never be converged by anything else.
  store.reconcileChildRuns(workspace);
  store.recoverInterruptedStreams(workspace);
  // Tasks an operator put on a schedule are put back on the queue so an interrupted attempt
  // resumes from its last completed step instead of waiting for a human.
  store.resumableTasks(workspace);
  const background = new BackgroundCommands(workspace);
  /**
   * The host's terminals, one manager for the process.
   *
   * Deliberately created here and not in the run: a terminal is the one piece of run state that is *meant* to
   * outlive its run — a REPL, a debugger or an interactive rebase that a later run continues — so the manager
   * belongs to the process that owns the pty, and the run reaches it through its session scope.
   */
  const terminals = new TerminalSessions(workspace);
  // One hook set for the whole host lifetime, shared with every per-run tool registry: session hooks
  // have to outlive a run, and a per-run registry is rebuilt on each `run.start`.
  const hooks = await loadHookRegistry(options.hooks ?? process.env.YUANTU_HOOKS_MODULE, workspace);
  /**
   * The process's runtime invariant registry.
   *
   * Built here because the host is what owns the process and outlives every run, and populated with the
   * built-ins from the three packages that ship one. Each publisher states its own scope; the registrations
   * that need per-run state (the tool pipeline trace) are made by the run itself.
   */
  const invariants = new InvariantRegistry({
    timeoutMs: resolveRunLimits(options).invariantTimeoutMs,
  });
  invariants.register(logTablesAgreeInvariant(store));
  invariants.register(emittedEventTypesInvariant());
  invariants.register(pipelineStagesInvariant());
  /** Violations from the last run, so `invariants.list` can answer "does it currently hold?". */
  let lastViolations: InvariantViolation[] = [];
  // Sessions already announced to `sessionStart`. The host first learns about an existing session on
  // its first run, so that is where a resumed session is announced.
  const announced = new Set<string>();
  const announceSession = async (sessionId: string, resumed: boolean): Promise<void> => {
    if (announced.has(sessionId)) return;
    announced.add(sessionId);
    const failures = await hooks.sessionStart(
      { sessionId, workspace, resumed },
      new AbortController().signal,
    );
    for (const failure of failures) process.stderr.write(`sessionStart hook failed: ${failure}\n`);
  };
  /**
   * Where this Host's carrier is, once one is attached.
   *
   * The Host was written as "something that owns stdin/stdout", which is a statement about a *desktop* carrier
   * rather than about an agent host: a browser cannot spawn a process or pipe into one, so a second carrier
   * needs the same protocol over a link it can actually open. Nothing above this line changes — the dispatch
   * table, the run loop, the store and the protocol version are identical — because only the carrier moves.
   */
  const stdioCarrier = options.listen === undefined;
  let output: ((line: string) => void) | null = null;
  let input: Interface | null = null;
  let socket: Socket | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  const send = (data: unknown) => {
    const line = JSON.stringify(data) + '\n';
    if (output) output(line);
    // Unreachable while the protocol is request-driven: the scheduler is started only once a carrier is
    // attached, so nothing can emit before there is somewhere to emit to. Said out loud anyway, because a
    // silently dropped event is exactly what a carrier change could introduce.
    else if (!closing) process.stderr.write('[host] dropped a message: no carrier is connected\n');
  };
  const active = new Map<
    string,
    { controller: AbortController; task?: Promise<RunResult>; agent?: Agent }
  >();
  const approvals = new Map<string, { approval: Approval; resolve: (allow: boolean) => void }>();
  /**
   * Questions waiting for an answer, keyed by the id the client answers with.
   *
   * The Host holds the pending question rather than the tool, because the answer arrives on a *later*
   * request from a different place (the desktop's question panel, the CLI's prompt) than the tool call that
   * asked it. The same shape as `approvals`, with an outcome instead of a boolean.
   */
  const questions = new Map<
    string,
    { resolve: (outcome: QuestionOutcome) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const requestIds = new Set<string>();
  const tasks = new Set<Promise<void>>();
  // How often the scheduler re-checks for due tasks. Only the tick cadence is configurable; the
  // schedule itself always lives on the task row.
  const workflowIntervalMs = Number(process.env.YUANTU_WORKFLOW_INTERVAL_MS) || undefined;
  let closing = false;
  let restoring = false;
  let manualCompaction: AbortController | undefined;
  const waking = new Set<string>();
  let wakeQueued = false;
  let automaticReady = false;
  const currentAuthority = (sessionId: string): BackgroundAuthority => ({
    sandboxMode: sessionSandboxes.get(sessionId) ?? defaultSandboxMode,
    permissionPolicy: permissionPolicy?.toJSON() ?? null,
  });
  const captureAuthority = (sessionId: string, permissionOnly = false) => {
    const { mode, paused, maxWakeups, maxRunMs } = backgroundState(store, sessionId).policy;
    const authority = currentAuthority(sessionId);
    if (permissionOnly && !sessionSandboxes.has(sessionId))
      authority.sandboxMode =
        backgroundAuthority(store, sessionId)?.sandboxMode ?? authority.sandboxMode;
    setBackgroundPolicy(store, sessionId, { mode, paused, maxWakeups, maxRunMs }, false, authority);
  };
  const queueWake = () => {
    if (wakeQueued || closing || !output || !automaticReady) return;
    wakeQueued = true;
    queueMicrotask(() => {
      wakeQueued = false;
      if (closing || active.size || restoring || manualCompaction || !automaticReady) return;
      for (const session of store.list('', workspace)) {
        if (session.parentSessionId) continue;
        reconcileBackground(store, session.id);
        const authority = backgroundAuthority(store, session.id);
        if (!authority) continue;
        const accepted = admitBackground(store, session.id);
        if (!accepted) continue;
        waking.add(session.id);
        const wakeTask = dispatch(
          'run.start',
          {
            sessionId: session.id,
            prompt:
              'Review the newly settled background work announced in context. Read its result using job_output or collect_subagents, then report or continue within the existing user request and permissions.',
          },
          { ...accepted, authority },
        )
          .then(
            (result) =>
              finishBackground(
                store,
                session.id,
                accepted.ids,
                String((result as RunResult).status),
              ),
            (error) =>
              finishBackground(store, session.id, accepted.ids, `failed: ${safeError(error)}`),
          )
          .catch((error) => {
            process.stderr.write(`[background] ${safeError(error)}\n`);
          })
          .finally(() => {
            tasks.delete(wakeTask);
            waking.delete(session.id);
            queueWake();
          });
        tasks.add(wakeTask);
        break;
      }
    });
  };
  const stopObservingBackground = store.observeEvents(
    () => queueWake(),
    new Set([
      'command.settled',
      'command.collected',
      'subagent.finished',
      'subagent.interrupted',
      'subagent.collected',
      'background.policy',
      'goal.changed',
    ]),
  );
  /**
   * Resident sub-agents for this Host process.
   *
   * A Host is long-lived, which is where residency is worth its cost: a run can ask a child it delegated to
   * for a follow-up, and the next run in that session can talk to the same child instead of delegating the
   * same ground again. The residency is disposed child-first on shutdown, before the store closes, so a
   * child's tools are released while its session can still be written to.
   */
  const residency = new SubAgentResidency();
  const shutdown = () => {
    if (closing) return;
    closing = true;
    stopObservingBackground();
    scheduler.stop();
    for (const run of active.values()) run.controller.abort();
    manualCompaction?.abort();
    for (const pending of approvals.values()) pending.resolve(false);
    approvals.clear();
    // A question outlives nothing: the run that asked it is being aborted, so the wait settles as
    // unavailable rather than leaving a promise nobody will ever resolve.
    for (const pending of questions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ answered: false, answers: [], reason: 'cancelled' });
    }
    questions.clear();
    // Unloading happens after the runs above were aborted: an activation's in-flight turn is stopped by its
    // own run's abort, and disposal then waits for it to unwind before releasing that child's tools.
    void residency.disposeAll().catch(() => undefined);
    input?.close();
    if (stdioCarrier) process.stdin.destroy();
    else {
      socket?.destroy();
      server?.close();
    }
  };
  /**
   * Task triggers fire runs through the same dispatch path as a user request, so approvals,
   * permission policy, budgets and cleanup all behave identically whether a human or the clock
   * started the work.
   */
  const scheduler = new TaskScheduler({
    store,
    workspace,
    canRun: () => automaticReady && !closing && active.size === 0 && !restoring,
    ...(workflowIntervalMs ? { intervalMs: workflowIntervalMs } : {}),
    run: async (scheduled) => {
      if (
        scheduled.task.pendingApproval?.state === 'approved' &&
        scheduled.task.pendingApproval.phase === 'acceptance'
      ) {
        const verified = (await dispatch('task.verify', {
          sessionId: scheduled.task.sessionId,
          taskId: scheduled.task.id,
          resumeApproval: true,
        })) as { task: Task; attempt: TaskAttempt };
        return {
          status: verified.task.status === 'completed' ? 'completed' : 'needs_review',
          ...(verified.attempt.error ? { error: verified.attempt.error } : {}),
        };
      }
      return (await dispatch('run.start', {
        sessionId: scheduled.task.sessionId,
        taskId: scheduled.task.id,
        prompt: scheduled.task.description || scheduled.task.title,
        trigger: scheduled.source,
        ...(scheduled.resume ? { resume: true } : {}),
      })) as RunResult;
    },
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const required = (params: Record<string, unknown>, key: string) => {
    const value = params[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${key}`);
    return value;
  };
  const ownedSession = (sessionId: string) => {
    const session = store.get(sessionId);
    let owner: string;
    try {
      owner = resolveWorkspace(session.workspace);
    } catch {
      throw new Error('Session belongs to a different workspace');
    }
    if (owner !== workspace) throw new Error('Session belongs to a different workspace');
    return session;
  };
  const durableBackground = (
    sessionId: string,
    id?: string,
    cursor = 0,
  ): BackgroundJobSnapshot[] => {
    const hidden = new Set(
      store
        .events(sessionId)
        .filter((e) => e.type === 'background.hidden')
        .flatMap((e) => (e.data.ids as string[]) ?? []),
    );
    return [...commandRecords(store, sessionId).values()]
      .filter((r) => r.status && (id ? r.id === id : !hidden.has(r.id)))
      .map((r) => {
        if (cursor > r.outputChars) throw Error('Invalid output cursor');
        const offset = Math.max(0, r.outputChars - r.output.length),
          start = Math.max(cursor, offset);
        return {
          id: r.id,
          sessionId,
          command: r.command,
          cwd: r.cwd,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          status: r.status!,
          exitCode: r.exitCode ?? null,
          output: r.output.slice(start - offset),
          nextCursor: r.outputChars,
          truncated: cursor < offset,
        };
      });
  };
  /**
   * The tasks as a client reads them, with the schedule's unhappy half filled in.
   *
   * `waiting` is not on the row: the record is a `task.due` event written when the Host was too busy to start the
   * moment the schedule named (`packages/core/task-deliveries.ts`), and it stops being owed the moment that task
   * runs. Decorating here rather than storing it keeps one answer to "is this late?" — the row's own `lastRunAt`
   * is what settles it, and a copy on the task would be a second truth about the same fact.
   */
  const withWaiting = (
    target: ReturnType<typeof openStore>,
    sessionId: string,
    tasks: Task[],
  ): Task[] => {
    const pending = pendingTaskDeliveries(target, sessionId);
    if (!pending.length) return tasks;
    return tasks.map((task) => {
      const owed = pending.find((delivery) => delivery.tasks.some((named) => named.id === task.id));
      return owed ? { ...task, waiting: { since: owed.dueAt, reason: owed.reason } } : task;
    });
  };
  /**
   * Scheduling observes runs; it must never control or crash them. `notify` can reject before its
   * own guards run — for example when listing scheduled tasks throws on a busy database — and a
   * bare `void scheduler.notify(...)` turns that into an unhandled rejection, which terminates the
   * Host process and reaches the user as an unexplained crash.
   */
  const notifyScheduler = (event: Parameters<typeof scheduler.notify>[0]): void => {
    void scheduler.notify(event).catch((error) => {
      process.stderr.write(`scheduler notify failed: ${safeError(error)}\n`);
    });
  };
  // Verification commands run outside an active run cannot rely on the streaming approval
  // flow, so they still honor the permission policy and --allow-command, and otherwise fail
  // closed rather than executing an unauthorized host command.
  const approvalSources = new WeakMap<object, ApprovalDecisionSource>();
  const verifyApprover: Approver = async (approval, signal) => {
    signal.throwIfAborted();
    const decision = permissionPolicy?.decide(approval);
    if (decision === 'deny' || decision === 'allow') {
      approvalSources.set(approval.toolCall, 'policy');
      return decision === 'allow';
    }
    if (
      decision !== 'ask' &&
      ((approval.kind === 'write' && options.allowWrite) ||
        (approval.kind === 'command' && options.allowCommand))
    ) {
      approvalSources.set(approval.toolCall, 'launch-options');
      return true;
    }
    approvalSources.set(approval.toolCall, 'unavailable');
    return false;
  };
  verifyApprover.decisionSource = (approval) => approvalSources.get(approval.toolCall);
  async function dispatch(
    method: string,
    params: Record<string, unknown>,
    wake?: { ids: string[]; maxRunMs: number; authority: BackgroundAuthority },
  ): Promise<unknown> {
    switch (method) {
      case 'host.info':
        return {
          protocolVersion: negotiateHostVersion(params),
          runtime: 'yuantu',
          workspace,
          capabilities: [
            'runtime.ready',
            'sessions',
            'session-management',
            'streaming',
            'message-turns',
            'approval',
            'cancel',
            'images',
            'steer',
            'follow-up',
            'context-summary',
            'resources',
            'session-pages',
            'tasks',
            'task-attempts',
            'task-verify',
            'task-retry',
            'background-jobs',
            'plan-approval',
            'subagents',
            /**
             * The live cursor and the replay that goes with it. Advertised rather than assumed: a client that
             * reconnects to a Host which does not offer it has to re-read the session, and saying so is how the
             * carrier decides what to do instead of asking for a method that is not there.
             */
            'event-cursor',
            'session-events',
          ],
        };
      case 'runtime.ready': {
        if (Object.keys(params).length) throw new Error('Invalid runtime readiness parameters');
        automaticReady = true;
        queueWake();
        return { ready: true };
      }
      case 'background.list': {
        const sessionId =
          typeof params.sessionId === 'string' && params.sessionId.trim()
            ? params.sessionId
            : undefined;
        if (sessionId) ownedSession(sessionId);
        const live = background.list(sessionId);
        return sessionId
          ? [
              ...live,
              ...durableBackground(sessionId).filter((r) => !live.some((j) => j.id === r.id)),
            ]
          : live;
      }
      case 'background.poll': {
        // Polling observes output; only model job_output/collect marks a producer collected.
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        const cursor = params.cursor === undefined ? 0 : Number(params.cursor);
        const waitMs = params.waitMs === undefined ? 0 : Number(params.waitMs);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid output cursor');
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5000)
          throw new Error('Invalid background wait');
        const id = required(params, 'id');
        if (!background.list(sessionId).some((j) => j.id === id)) {
          const durable = durableBackground(sessionId, id, cursor)[0];
          if (durable) return durable;
        }
        return background.poll(required(params, 'id'), sessionId, cursor, waitMs);
      }
      case 'background.stop': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return background.stopById(required(params, 'id'), sessionId);
      }
      case 'background.state': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return reconcileBackground(store, sessionId);
      }
      case 'background.policy': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (params.reset !== undefined && typeof params.reset !== 'boolean')
          throw Error('Invalid budget reset');
        if (params.reset === true && active.has(sessionId))
          throw Error('Stop the run before resetting its budget');
        const policy = setBackgroundPolicy(
          store,
          sessionId,
          params.policy,
          params.reset === true,
          currentAuthority(sessionId),
        );
        if ((policy.paused || policy.mode === 'notify') && waking.has(sessionId))
          active.get(sessionId)?.controller.abort();
        return reconcileBackground(store, sessionId);
      }
      case 'background.clear': {
        const sessionId =
          typeof params.sessionId === 'string' && params.sessionId.trim()
            ? params.sessionId
            : undefined;
        if (sessionId) ownedSession(sessionId);
        if (sessionId) {
          const ids = durableBackground(sessionId).map((r) => r.id);
          if (ids.length) store.recordEvent(sessionId, 'background.hidden', { ids });
          background.clear(sessionId);
          return { cleared: ids.length };
        }
        return { cleared: background.clear(sessionId) };
      }
      case 'resources.list':
        return {
          instructions: loadInstructions(workspace).files,
          skills: discoverSkills(workspace),
          extensions: extensionTools(workspace).map((t) => t.name),
        };
      /**
       * The workspace, one directory at a time, for a client that shows the workspace itself.
       *
       * Read-only by construction: nothing here writes, and every path goes through `Workspace`, which is the
       * containment rule the file tools already run under — realpath inside the root, no links, and the same
       * ignore list that hides `.git`, `node_modules` and credential names. Answering this in the Electron
       * main process instead would be a second copy of that decision on the far side of the IPC boundary, and
       * the copy that drifts is the one that lists `.env`.
       */
      case 'files.list': {
        const files = new Workspace(workspace);
        const requested = typeof params.path === 'string' && params.path.trim() ? params.path : '.';
        // The requested directory is resolved first, so `..`, an absolute path and a hidden name are refused
        // here instead of being filtered out one entry at a time.
        const directory = await files.resolve(requested);
        const relative = path.relative(workspace, directory).split(path.sep).join('/');
        const entries: WorkspaceEntry[] = [];
        let truncated = false;
        const listing = await readdir(directory, { withFileTypes: true });
        const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        // Project trees put folders first and compare embedded numbers by value (file2 before file10).
        // Sort before the entry cap so every client receives the same ordered prefix.
        for (const entry of listing.sort(
          (first, second) =>
            Number(second.isDirectory()) - Number(first.isDirectory()) ||
            names.compare(first.name, second.name) ||
            first.name.localeCompare(second.name),
        )) {
          // A link or a device: the resolver refuses the first below, and the second is a file whose read can
          // block — a tree that offers one can hang the Host, which is worse than not offering it.
          if (!entry.isDirectory() && !entry.isFile()) continue;
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          // Every child is offered to the same resolver, so the tree can only ever show paths the model may
          // open: a name this refuses is exactly a name `read_file` would refuse too.
          try {
            await files.resolve(child);
          } catch {
            continue;
          }
          if (entries.length >= FILE_TREE_ENTRY_LIMIT) {
            truncated = true;
            break;
          }
          entries.push({
            name: entry.name,
            path: child,
            kind: entry.isDirectory() ? 'directory' : 'file',
          });
        }
        return { path: relative, entries, truncated };
      }
      /**
       * One file's bytes, in the only form a preview can show them without inventing content.
       *
       * The bytes decide what this is — the signature for an image, a NUL in the window for "not text" — never
       * the name. An extension is a claim, and a `.png` that is really a JPEG is the one file a preview must
       * not hand to an `<img>`: a broken image reads as a broken file rather than as a mislabelled one.
       */
      case 'files.read': {
        const target = required(params, 'path');
        const files = new Workspace(workspace);
        const file = await files.resolve(target);
        const relative = path.relative(workspace, file).split(path.sep).join('/');
        const handle = await open(file, 'r');
        try {
          const info = await handle.stat();
          // A directory opens and then refuses to be read, and a device file can block the read; both are
          // "there is nothing here to show", not a path the client got wrong.
          if (!info.isFile())
            return { path: relative, bytes: info.size, kind: 'unsupported', reason: 'not-a-file' };
          const window = Buffer.alloc(Math.min(info.size, FILE_PREVIEW_BYTES + 1));
          const { bytesRead } = await handle.read(window, 0, window.length, 0);
          const head = window.subarray(0, bytesRead);
          const mimeType = sniffImageType(head);
          if (mimeType) {
            if (info.size > MAX_IMAGE_BYTES)
              return { path: relative, bytes: info.size, kind: 'unsupported', reason: 'too-large' };
            const bytes = Buffer.alloc(info.size);
            if (info.size) await handle.read(bytes, 0, info.size, 0);
            return {
              path: relative,
              bytes: info.size,
              kind: 'image',
              mimeType,
              data: bytes.toString('base64'),
            };
          }
          // The same window `Workspace.read` refuses: bytes with a NUL in them are not text, and decoding them
          // would produce replacement characters that look like the file's content. Taken from the bytes
          // already in hand rather than by reading the file a second time, which is how the two would come to
          // disagree about what the file holds.
          if (head.includes(0))
            return { path: relative, bytes: info.size, kind: 'unsupported', reason: 'binary' };
          return {
            path: relative,
            bytes: info.size,
            kind: 'text',
            text: head.subarray(0, FILE_PREVIEW_BYTES).toString('utf8'),
            // Without this a preview that stops at the budget reads as the whole file.
            ...(info.size > FILE_PREVIEW_BYTES ? { truncated: true } : {}),
          };
        } finally {
          await handle.close();
        }
      }
      case 'run.enqueue': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        const agent = active.get(sessionId)?.agent;
        if (!agent) throw new Error('Session is not running');
        if (params.mode !== 'steer' && params.mode !== 'follow-up')
          throw new Error('Invalid input mode');
        return {
          item: agent.enqueue(
            sessionId,
            { prompt: required(params, 'prompt'), images: validateImages(params.images) },
            params.mode,
          ),
        };
      }
      case 'run.queue.get': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        const agent = active.get(sessionId)?.agent;
        // With no run holding the session there is no agent either, and the answer comes from the log: what
        // nobody ever delivered. Asking the store directly is what lets a reopened session show that at all.
        return agent
          ? agent.inboxOf(sessionId)
          : { running: false, items: store.pendingInputs(sessionId) };
      }
      case 'run.queue.clear': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        const agent = active.get(sessionId)?.agent;
        if (agent) agent.clearQueue(sessionId);
        else store.discardPendingInputs(sessionId, 'user');
        return { cleared: true };
      }
      case 'changes.list': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.fileChanges(sessionId);
      }
      case 'invariants.list':
        return { invariants: invariants.describe(), violations: lastViolations };
      case 'subagents.list': {
        const id = required(params, 'sessionId');
        ownedSession(id);
        return store.subagents(id);
      }
      case 'todos.get': {
        const id = required(params, 'sessionId');
        ownedSession(id);
        return { todos: store.todos(id), change: store.todoChange(id) };
      }
      case 'plan.get': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.latestPlan(sessionId);
      }
      /**
       * The two pieces of session state a reopened window has to restore that are not messages.
       *
       * Both are folds of the durable log (`projections.ts`), so a Host that never saw the run that wrote them
       * answers exactly like the one that did: the files a run marked as its deliverables, and the goal the
       * session is working toward. They are asked for separately for the same reason the checklist is — they
       * outlive the run that wrote them, and a reload has to bring them back.
       */
      case 'deliverables.get': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.deliverables(sessionId);
      }
      case 'goal.get': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.goal(sessionId);
      }
      case 'plan.approve': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before approving a plan');
        // The hash is the text the human reviewed, so an edit between review and approval is refused.
        return store.approvePlan(sessionId, required(params, 'planId'), required(params, 'hash'));
      }
      case 'plan.reject': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before rejecting a plan');
        return store.rejectPlan(
          sessionId,
          required(params, 'planId'),
          typeof params.reason === 'string' ? params.reason : undefined,
        );
      }
      case 'changes.undo': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before undo');
        restoring = true;
        try {
          await undoFileChange(store, sessionId, required(params, 'id'), workspace);
          return { undone: true };
        } finally {
          restoring = false;
        }
      }
      case 'sandbox.set': {
        const mode = params.mode;
        if (mode !== 'host' && mode !== 'docker' && mode !== 'sbx' && mode !== 'windows')
          throw new Error('Invalid sandbox mode; use host, docker, sbx, or windows');
        if (params.sessionId !== undefined && typeof params.sessionId !== 'string')
          throw new Error('Invalid sandbox session identity');
        if (typeof params.sessionId === 'string') {
          ownedSession(params.sessionId);
          if (active.has(params.sessionId))
            throw new Error('Wait for this session run before changing its execution policy');
          sessionSandboxes.set(params.sessionId, mode);
          captureAuthority(params.sessionId);
        } else {
          if (active.size)
            throw new Error('Wait for active runs before changing the default execution policy');
          defaultSandboxMode = mode;
        }
        return { mode };
      }
      case 'session.create': {
        const created = store.create(workspace);
        await announceSession(created.id, false);
        notifyScheduler({ name: 'session.created', sessionId: created.id });
        return created;
      }
      case 'session.list':
        if (params.query !== undefined && typeof params.query !== 'string')
          throw new Error('Invalid search query');
        return store.list(params.query as string | undefined, workspace);
      case 'session.rename':
      case 'session.delete': {
        const id = required(params, 'sessionId');
        ownedSession(id);
        if (active.size || restoring)
          throw new Error('Host is busy; wait before changing sessions');
        if (method === 'session.rename') return store.rename(id, required(params, 'title'));
        restoring = true;
        try {
          await background.close(id);
          // A terminal holds a real process, so a deleted session must not leave a shell running behind it —
          // the same rule the background commands follow, for a stronger reason.
          await terminals.closeAllAndWait(id);
          /**
           * Checked before the session goes away, because the check reads its log. A `session-close`
           * violation cannot stop anything — the session is being deleted on purpose — so it is reported on
           * stderr, where an operator sees the promises this deployment is not keeping.
           */
          const closingViolations = await invariants.run('session-close', { sessionId: id });
          for (const violation of closingViolations)
            process.stderr.write(
              `invariant violated on session close: ${violation.name} (${violation.owner}): ${violation.detail}\n`,
            );
          store.delete(id);
          if (announced.delete(id)) {
            const failures = await hooks.sessionEnd(
              { sessionId: id, reason: 'delete' },
              new AbortController().signal,
            );
            for (const failure of failures)
              process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
          }
          return { deleted: true };
        } finally {
          restoring = false;
        }
      }
      case 'session.get': {
        const id = required(params, 'sessionId');
        const session = ownedSession(id),
          history = store.messages(id);
        if (params.offset === undefined) {
          if (params.view !== undefined || params.chunkOffset !== undefined)
            throw new Error('Paged history requires an offset');
          return {
            session,
            messages: history,
            statistics: store.statistics(id),
            steps: store.stateOf<readonly StepRecord[]>('steps', id),
          };
        }
        const offset = params.offset;
        if (
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > history.length ||
          (params.view !== undefined && params.view !== 'display') ||
          (params.chunkOffset !== undefined &&
            (params.view !== 'display' ||
              typeof params.chunkOffset !== 'number' ||
              !Number.isSafeInteger(params.chunkOffset) ||
              params.chunkOffset < 0))
        )
          throw new Error('Invalid history offset');
        // Display history never transports opaque Responses continuation state. The full state stays
        // in the durable transcript for the next model call; the UI only needs visible message data.
        const displayMessage = (message: Message): Message => {
          if (params.view !== 'display' || message.role !== 'assistant') return message;
          const { providerState: _providerState, ...visible } = message;
          return visible;
        };
        let end = offset,
          bytes = 0;
        while (end < history.length && end - offset < 100) {
          const message = displayMessage(history[end]!);
          const serialized = JSON.stringify(message);
          const size = Buffer.byteLength(serialized);
          if (bytes + size > 15_000_000) {
            if (end !== offset) break;
            if (params.view !== 'display')
              throw new Error('History message exceeds transport page limit');
            const start = params.chunkOffset ?? 0;
            if (start >= serialized.length) throw new Error('Invalid history chunk offset');
            // A chunk is sliced from the serialized message, so every field (including images and
            // tool metadata) survives reconstruction. One million UTF-16 units stay well under the Host
            // frame bound even when JSON escaping expands every character.
            const next = Math.min(serialized.length, start + 1_000_000);
            return {
              session,
              messages: [],
              ...(offset === 0 ? { statistics: store.statistics(id) } : {}),
              messageChunk: {
                index: offset,
                part: serialized.slice(start, next),
                ...(next < serialized.length ? { nextChunkOffset: next } : {}),
              },
              ...(next === serialized.length && offset + 1 < history.length
                ? { nextOffset: offset + 1 }
                : {}),
            };
          }
          if (params.chunkOffset !== undefined) throw new Error('Invalid history chunk offset');
          bytes += size;
          end++;
        }
        return {
          session,
          messages: history.slice(offset, end).map(displayMessage),
          ...(offset === 0 ? { statistics: store.statistics(id) } : {}),
          // The step record travels with the first page, like the statistics: it describes the session, not the
          // window of history that happens to be loaded.
          ...(offset === 0 ? { steps: store.stateOf<readonly StepRecord[]>('steps', id) } : {}),
          ...(end < history.length ? { nextOffset: end } : {}),
        };
      }
      case 'session.audit': {
        const id = required(params, 'sessionId');
        ownedSession(id);
        const afterSeq = params.afterSeq ?? 0;
        const limit = params.limit ?? 200;
        if (
          typeof afterSeq !== 'number' ||
          !Number.isSafeInteger(afterSeq) ||
          afterSeq < 0 ||
          typeof limit !== 'number' ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 500
        )
          throw new Error('Invalid audit cursor');
        const entries = auditEntries(store.events(id, afterSeq), limit);
        // The cursor is the last record *returned*, not the last one that exists: a client that stops reading
        // here continues from exactly where it stopped, and a page that came back empty does not move it.
        return { entries, nextSeq: entries.at(-1)?.seq ?? afterSeq };
      }
      case 'session.events': {
        const id = required(params, 'sessionId');
        ownedSession(id);
        const afterSeq = params.afterSeq ?? 0;
        const limit = params.limit ?? 500;
        if (
          typeof afterSeq !== 'number' ||
          !Number.isSafeInteger(afterSeq) ||
          afterSeq < 0 ||
          typeof limit !== 'number' ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 500
        )
          throw new Error('Invalid session cursor');
        // One page more than the client asked for, so "is there more?" is answered by the read itself rather
        // than by a second query: a client that is told `more` keeps reading, and one that is not knows it is
        // level with the log.
        const page = store.events(id, afterSeq, limit + 1);
        const entries = page.slice(0, limit);
        // `latestSeq` comes from the log's high-water mark, not from the page: a client asking with a cursor at
        // the end must be able to tell "caught up" from "there is more" without reading again.
        return {
          entries,
          nextSeq: entries.at(-1)?.seq ?? afterSeq,
          latestSeq: store.lastSeq(id),
          more: page.length > limit,
        };
      }
      case 'context.compact': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before compacting');
        const history = store.messages(sessionId);
        const covered = store.contextSurface(sessionId)?.coveredMessages ?? 0;
        const boundary = contextBoundaries(history).at(-1) ?? 0;
        if (history.length < 2 || boundary <= covered)
          return { compacted: false, coveredMessages: covered };
        /**
         * The envelope this compaction will replay, which has to be the last round's *real* one.
         *
         * This path used to pass `system: ''` and `tools: []`, and the two things that follow from it are both
         * defects rather than simplifications. A summary request is the round's own prefix plus one instruction —
         * that is the whole reason its shape exists (see the note on `summaryInstruction`) — and a request built on
         * an empty envelope shares neither the system prompt nor the schemas with anything, so the provider caches
         * nothing: the user pays full price for a summary of a conversation that was just sent cached. The second
         * is the capacity check: the batch is measured against the request that will carry it, and measuring it
         * against an empty envelope admits batches the real request cannot send.
         *
         * So the record written by the run that produced this transcript is what gets replayed, and when there is
         * none the honest answer is to not summarise: `compacted: false` with the reason, rather than a request
         * whose prefix is known not to match. The prompt is stripped of its own `<conversation_summary>` section
         * because `prepareContext` appends that from the surface, and the recorded prompt already contains it.
         */
        const replay = foldContextEnvelopes(store.events(sessionId))
          .filter((entry) => entry.system !== undefined && entry.tools !== undefined)
          .at(-1);
        if (!replay || replay.systemTruncated)
          return {
            compacted: false,
            coveredMessages: covered,
            reason: replay
              ? 'the last request envelope was recorded with a truncated prompt, so a summary request could not replay it byte for byte'
              : 'no request envelope is recorded for this session, so a summary request could not replay the round it compresses',
          };
        restoring = true;
        const controller = new AbortController();
        manualCompaction = controller;
        // The same defaults the kernel uses, from the same owner (see `packages/protocol/settings.ts`).
        const limits = resolveRunLimits(options);
        const config = readConfig();
        /**
         * The session's own correction, and the shortening the run would have applied.
         *
         * Manual compaction used to be measured and priced as if it were the first request of a fresh session: no
         * calibration (so the batch was sized against a factor of one, however wrong this route's estimate had
         * proved to be) and no shrink seam (so old tool results were replayed in full, which is exactly what makes
         * a batch too large to summarise). Both are the run's own seams, built from the same values and the same
         * store, so the compaction a person asks for is priced like the rounds around it.
         */
        const route = calibrationRoute(modelInfoFor(config));
        const routeInfo = modelInfoFor(config);
        const calibration = TokenCalibration.from(
          store.newestPayload(sessionId, 'context.calibration'),
          route,
        );
        try {
          await prepareContext({
            store,
            sessionId,
            system: withoutSummarySection(replay.system!),
            tools: replay.tools!,
            provider: createProvider(config),
            // A manual compaction is a model answer like any other, so its record says which route produced it —
            // the same two facts the run's own compactions record, taken from the same place.
            protocol: routeInfo.protocol,
            model: routeInfo.model,
            limit: limits.maxContextChars,
            signal: controller.signal,
            maxOutputTokens: limits.maxOutputTokens,
            maxContextTokens: limits.maxContextTokens,
            summaryTimeoutMs: limits.summaryTimeoutMs,
            // The recorded key, but only for the request that was recorded. A key names a cache entry, so handing
            // it to a prompt that is not the one behind it would ask the provider for somebody else's prefix — and
            // the prompt can differ: the surface's summary is appended fresh, and a compaction since this envelope
            // was written has moved it on. When it does differ, the honest answer is no key at all: the summary
            // request then caches nothing rather than reading an entry that is not its own.
            cacheKeyFor: (systemText) =>
              systemText === replay.system ? replay.cacheKey : undefined,
            calibration,
            shrink: {
              policy: {
                keepRecent: limits.toolResultKeepRecent,
                tokens: limits.toolResultShrinkTokens,
              },
              spill: ({ message, content }) =>
                spillResult({
                  workspace,
                  sessionId,
                  key: message.role === 'tool' ? message.toolCallId : 'message',
                  content,
                }),
              measure: (text) =>
                estimateMessageTokens(
                  { role: 'tool', toolCallId: '', content: text, isError: false },
                  calibration.factor,
                ),
            },
            shrinkPercent: limits.contextShrinkPercent,
            onUsage: () => {},
            onCompaction: () => {},
            forceCompact: true,
          });
          /**
           * What the compaction's own request taught this route, recorded where the next run reads it.
           *
           * `prepareContext` folds the provider's reported usage into the calibration it was given; without this
           * write the measurement would die with the call, and the next run would size its requests against the
           * value that preceded it.
           */
          if (route !== undefined)
            store.recordEvent(sessionId, 'context.calibration', {
              route,
              factor: calibration.factor,
              samples: calibration.observed,
              parts: calibration.parts,
            });
          return {
            compacted: true,
            coveredMessages: store.contextSurface(sessionId)!.coveredMessages,
          };
        } finally {
          manualCompaction = undefined;
          restoring = false;
        }
      }
      case 'run.cancel': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        const run = active.get(sessionId);
        const policy = backgroundState(store, sessionId).policy;
        if (policy.mode === 'auto')
          setBackgroundPolicy(store, sessionId, {
            mode: policy.mode,
            paused: true,
            maxWakeups: policy.maxWakeups,
            maxRunMs: policy.maxRunMs,
          });
        run?.controller.abort();
        await background.close(sessionId);
        return { cancelled: !!run };
      }
      case 'approval.respond': {
        const id = required(params, 'approvalId'),
          entry = approvals.get(id);
        if (!entry) throw new Error('Approval is no longer pending');
        if (typeof params.allow !== 'boolean') throw new Error('allow must be a boolean');
        entry.resolve(params.allow);
        approvals.delete(id);
        return { accepted: true };
      }
      case 'question.respond': {
        const entry = questions.get(required(params, 'questionId'));
        if (!entry) throw new Error('Question is no longer pending');
        const cancelled = params.cancelled === true;
        if (!cancelled && params.answers !== undefined && !Array.isArray(params.answers))
          throw new Error('answers must be an array');
        const answers = Array.isArray(params.answers) ? (params.answers as QuestionAnswer[]) : [];
        // Resolving goes through the pending entry, which owns the cleanup: deleting it here first would
        // make the settle path see an unknown id, return, and leave the run waiting forever.
        entry.resolve(
          cancelled
            ? { answered: false, answers: [], reason: 'cancelled' }
            : { answered: true, answers },
        );
        return { accepted: true };
      }
      case 'permission.update': {
        const next = new PermissionPolicy(params.policy);
        if (params.sessionId !== undefined) ownedSession(required(params, 'sessionId'));
        permissionPolicy = next;
        if (typeof params.sessionId === 'string') captureAuthority(params.sessionId, true);
        else for (const session of store.list('', workspace)) captureAuthority(session.id, true);
        let resolvedApprovals = 0;
        for (const pending of [...approvals.values()]) {
          const decision = next.decide(pending.approval);
          if (decision === 'allow' || decision === 'deny') {
            resolvedApprovals++;
            pending.resolve(decision === 'allow');
          }
        }
        return { applied: true, resolvedApprovals };
      }
      case 'task.create': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.createTask(sessionId, {
          title: required(params, 'title'),
          ...(typeof params.description === 'string' ? { description: params.description } : {}),
          ...(Array.isArray(params.acceptance) ? { acceptance: params.acceptance as never } : {}),
          ...(Array.isArray(params.steps) ? { steps: params.steps as never } : {}),
        });
      }
      case 'task.get': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return withWaiting(store, sessionId, [
          store.getTask(sessionId, required(params, 'taskId')),
        ])[0];
      }
      case 'task.list': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return withWaiting(
          store,
          sessionId,
          store.listTasks(
            sessionId,
            typeof params.status === 'string' ? (params.status as never) : undefined,
          ),
        );
      }
      case 'task.steps': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.taskStepCheckpoints(sessionId, required(params, 'taskId'));
      }
      case 'task.approval.respond': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (typeof params.allow !== 'boolean') throw new Error('allow must be a boolean');
        const task = store.resolveTaskApproval(
          sessionId,
          required(params, 'taskId'),
          params.allow,
          required(params, 'approvalId'),
        );
        if (params.allow) void scheduler.tick();
        return task;
      }
      case 'task.trigger': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before editing tasks');
        const taskId = required(params, 'taskId');
        // `null` clears the trigger; an absent field would be indistinguishable from "unchanged".
        return store.updateTask(sessionId, taskId, {
          trigger: (params.trigger ?? null) as never,
        });
      }
      case 'task.update': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before editing tasks');
        const update = { ...params } as Record<string, unknown>;
        delete update.sessionId;
        delete update.taskId;
        delete update.status;
        const expectedUpdatedAt =
          typeof update.expectedUpdatedAt === 'string' ? update.expectedUpdatedAt : undefined;
        delete update.expectedUpdatedAt;
        const taskId = required(params, 'taskId');
        const task = store.getTask(sessionId, taskId);
        return store.replaceTaskDefinition(
          sessionId,
          taskId,
          { ...task, ...update },
          expectedUpdatedAt,
        );
      }
      case 'task.attempts': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        return store.listTaskAttempts(sessionId, required(params, 'taskId'));
      }
      case 'task.propose': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before planning');
        const task = store.getTask(sessionId, required(params, 'taskId'));
        if (task.status === 'in_progress') throw new Error('Task is running');
        restoring = true;
        let runId: string | undefined;
        const statistics = emptyStatistics();
        const started = performance.now();
        let resultText = '',
          errorText: string | undefined;
        try {
          runId = store.beginRun(sessionId);
          const proposal = await proposeTask(
            createProvider(readConfig()),
            task,
            AbortSignal.timeout(Math.min(options.requestTimeoutMs ?? 120000, 120000)),
            (text) => {
              if (text && !statistics.firstTokenCount) {
                statistics.firstTokenMs = performance.now() - started;
                statistics.firstTokenCount = 1;
              }
            },
            executionEnvironment(),
          );
          addUsage(statistics, proposal.usage);
          resultText = proposal.draft.description;
          return store.replaceTaskDefinition(sessionId, task.id, proposal.draft, task.updatedAt);
        } catch (error) {
          statistics.usageComplete = false;
          errorText = safeError(error);
          throw error;
        } finally {
          statistics.modelMs = performance.now() - started;
          try {
            if (runId)
              store.finishRun({
                runId,
                sessionId,
                status: errorText ? 'failed' : 'completed',
                text: resultText,
                usage: {
                  inputTokens: statistics.inputTokens,
                  outputTokens: statistics.outputTokens,
                },
                statistics,
                ...(errorText ? { error: errorText } : {}),
              });
          } finally {
            restoring = false;
          }
        }
      }
      case 'task.confirm': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring)
          throw new Error('Host is busy; wait before manual confirmation');
        const taskId = required(params, 'taskId');
        const task = store.getTask(sessionId, taskId);
        if (required(params, 'expectedUpdatedAt') !== task.updatedAt)
          throw new Error('Task changed; reload before confirming');
        if (
          !task.latestRunId ||
          !task.verification ||
          !['needs_review', 'completed'].includes(task.status)
        )
          throw new Error('Execute the current task definition before manual confirmation');
        if (!Array.isArray(params.indices) || !params.indices.length || params.indices.length > 64)
          throw new Error('Select manual criteria explicitly');
        const indices = [...new Set(params.indices)];
        for (const index of indices) {
          if (
            !Number.isInteger(index) ||
            (index as number) < 0 ||
            !task.acceptance[index as number] ||
            task.acceptance[index as number]!.check
          )
            throw new Error('Only manual criteria can be confirmed');
          task.acceptance[index as number]!.met = true;
        }
        const baselines = store.latestRunAttemptBaselines(sessionId, taskId) as TaskBaselines;
        const attempt = store.startTaskAttempt(sessionId, taskId, { kind: 'review', baselines });
        restoring = true;
        try {
          const verified = await verifyTaskAcceptance(
            workspace,
            task,
            baselines,
            undefined,
            verifyApprover,
          );
          return store.finishTaskAttempt(sessionId, taskId, attempt.id, {
            status: verified.passed ? 'completed' : 'needs_review',
            verification: verified.evidence,
            acceptance: verified.acceptance,
            steps: verified.steps,
            ...(verified.error ? { error: verified.error } : {}),
          });
        } catch (error) {
          store.finishTaskAttempt(sessionId, taskId, attempt.id, {
            status: 'blocked',
            error: safeError(error),
          });
          throw error;
        } finally {
          restoring = false;
        }
      }
      case 'task.verify': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('Host is busy; wait before verifying');
        const taskId = required(params, 'taskId');
        const task = store.getTask(sessionId, taskId);
        const baselines = store.latestRunAttemptBaselines(sessionId, taskId) as TaskBaselines;
        const attempt = store.startTaskAttempt(sessionId, taskId, {
          kind: 'verify',
          baselines,
        });
        restoring = true;
        try {
          const acceptanceEffects = new Map<string, string>();
          const approvalForVerification: Approver =
            params.resumeApproval === true
              ? async (approval, signal) => {
                  signal.throwIfAborted();
                  const decision = permissionPolicy?.decide(approval);
                  if (decision === 'deny') return false;
                  if (store.consumeTaskApproval(sessionId, taskId, approval)) return true;
                  if (
                    decision === 'allow' ||
                    (decision !== 'ask' &&
                      ((approval.kind === 'write' && options.allowWrite) ||
                        (approval.kind === 'command' && options.allowCommand)))
                  )
                    return true;
                  store.deferTaskApproval(sessionId, taskId, approval);
                  throw new DeferredApprovalError();
                }
              : verifyApprover;
          const verified = await verifyTaskAcceptance(
            workspace,
            task,
            baselines,
            undefined,
            async (approval, signal) => {
              const allowed = await approvalForVerification(approval, signal);
              if (allowed)
                acceptanceEffects.set(
                  approval.toolCall.id.slice('acceptance:'.length),
                  store.beginTaskEffect(sessionId, taskId, attempt.id, approval.toolCall.name),
                );
              return allowed;
            },
          );
          // Verification must not promote a task that was never actually run: without a prior
          // run attempt there is no evidence the steps were executed, so completion stays gated.
          const completed = verified.passed && Boolean(task.latestRunId);
          const updated = store.finishTaskAttempt(sessionId, taskId, attempt.id, {
            resolvedEffectIds: verified.evidence.checks.flatMap((check) =>
              check.command && !check.command.timedOut
                ? [acceptanceEffects.get(check.id)].filter((id): id is string => Boolean(id))
                : [],
            ),
            status: completed ? 'completed' : 'needs_review',
            verification: verified.evidence,
            ...(verified.error ? { error: verified.error } : {}),
            ...(!completed
              ? {
                  error:
                    verified.error ?? 'Task has not been run; run it before verifying completion',
                }
              : {}),
            acceptance: verified.acceptance,
            steps: verified.steps,
          });
          return {
            task: updated,
            attempt: store.getTaskAttempt(sessionId, taskId, attempt.id),
          };
        } catch (error) {
          store.finishTaskAttempt(sessionId, taskId, attempt.id, {
            status: error instanceof DeferredApprovalError ? 'needs_review' : 'blocked',
            error: safeError(error),
          });
          throw error;
        } finally {
          restoring = false;
        }
      }
      case 'task.retry': {
        const sessionId = required(params, 'sessionId');
        ownedSession(sessionId);
        const taskId = required(params, 'taskId');
        const latestRun = store
          .listTaskAttempts(sessionId, taskId)
          .filter((attempt) => attempt.kind === 'run')
          .at(-1);
        const prompt =
          typeof params.prompt === 'string' && params.prompt.trim()
            ? params.prompt
            : latestRun?.prompt;
        if (!prompt) throw new Error('Task has no prior run prompt; provide prompt');
        return dispatch('run.start', {
          sessionId,
          taskId,
          prompt,
          ...(store.getTask(sessionId, taskId).approvalOutcomeUnknown ? { resume: true } : {}),
        });
      }
      case 'run.start': {
        const sessionId = required(params, 'sessionId'),
          prompt = required(params, 'prompt');
        ownedSession(sessionId);
        if (active.size || restoring) throw new Error('This Host already has an active run');
        const requestedTask =
          typeof params.taskId === 'string' ? store.getTask(sessionId, params.taskId) : undefined;
        const unattendedTaskId =
          requestedTask &&
          typeof params.trigger === 'string' &&
          ['interval', 'daily', 'event', 'recovery', 'at', 'after', 'weekly', 'cron'].includes(
            params.trigger,
          )
            ? requestedTask.id
            : undefined;
        if (
          requestedTask?.pendingApproval &&
          !unattendedTaskId &&
          requestedTask.pendingApproval.state !== 'rejected'
        )
          throw new Error('Review the pending task approval before a manual retry');
        /**
         * Plan mode, phase one: a read-only planning run. The plan row is created up front so an
         * interrupted planning run leaves a visible `planning` record instead of nothing, and the
         * run is told to answer with `submit_plan`.
         *
         * The phase is asked of the *session* when the request does not name one, because plan mode outlives the
         * request that started it: a plan left `planning` by a stopped run, a crash, or a restart means nobody has
         * decided anything yet, so the next run of that session continues planning. Deciding from the request
         * alone made the same session read-only through the CLI's `resume` and read-write through a client that
         * does not send `phase` — the write it then made would have been refused a moment earlier. A request that
         * names a plan to *execute* is a decision and is left alone (`planId` is checked below, and only an
         * approved plan can be executed).
         */
        const explicitPlan = params.phase === 'plan';
        if (params.phase !== undefined && params.phase !== 'plan')
          throw new Error('Invalid run phase');
        const continuing =
          explicitPlan || typeof params.planId === 'string' ? null : store.planMode(sessionId);
        const planPhase = explicitPlan || continuing !== null;
        const plannedTaskId = planPhase ? undefined : requestedTask?.id;
        if (planPhase && (requestedTask || typeof params.planId === 'string'))
          throw new Error('A planning run cannot execute a task or an approved plan');
        // Plan mode, phase two: executing an approved plan. Both the status and the body digest are
        // re-checked here, because approval and execution are separate requests and the plan can be
        // edited in between — that edit would otherwise run unreviewed work.
        const approvedPlan =
          typeof params.planId === 'string'
            ? store.executablePlan(sessionId, params.planId)
            : undefined;
        const controller = new AbortController();
        const entry: { controller: AbortController; task?: Promise<RunResult>; agent?: Agent } = {
          controller,
        };
        // Reserve the slot before the first await. The reconciliation below does real filesystem
        // I/O, so a check-then-set across it let a concurrent run.start (a duplicate dispatch, or
        // a scheduler tick) pass the same `active.size` guard; the loser then ran its `finally` and
        // deleted the winner's entry, leaving a live run uncancellable and re-admitting new runs.
        active.set(sessionId, entry);
        const wakePolicy = wake?.authority.permissionPolicy
          ? new PermissionPolicy(wake.authority.permissionPolicy)
          : undefined;
        const wakeTimer = wake
          ? setTimeout(
              () => controller.abort(new Error('Background wake time budget exhausted')),
              wake.maxRunMs,
            )
          : undefined;
        try {
          if (!wake) captureAuthority(sessionId);
          await announceSession(sessionId, true);
          /**
           * Name a new session as soon as its request is admitted. This uses the configured provider before
           * file reconciliation, agent setup, or the first reply; a failed call leaves the user-text fallback.
           *
           * "Has anybody asked this session anything yet" is asked of the *person's* messages: a runtime snapshot
           * is a user-role message the runtime wrote to itself, and counting one as a question meant a session
           * whose first turn announced a snapshot never got a model title at all — and the fallback named it
           * after the snapshot.
           */
          const askedByUser = store
            .messages(sessionId)
            .some(
              (message) =>
                message.role === 'user' &&
                !isMachineContext(message.displayContent ?? message.content),
            );
          if (
            !wake &&
            parseSetting(process.env, 'YUANTU_SESSION_TITLES') !== false &&
            store.canGenerateTitle(sessionId) &&
            !askedByUser
          ) {
            try {
              const generated = await generateSessionTitle(
                createProvider(readConfig()),
                prompt,
                controller.signal,
              );
              if (generated) store.setGeneratedTitle(sessionId, generated.title, generated.usage);
            } catch {
              // Title generation is optional; the first user message supplies the fallback.
            }
          }
          await reconcilePendingFileChanges(store, sessionId, workspace);
        } catch (error) {
          clearTimeout(wakeTimer);
          active.delete(sessionId);
          throw error;
        }
        let runId = '';
        const emit = (event: AgentEvent) => {
          runId = event.runId;
          // Kept for `invariants.list`: the run reports its own failure, but a host outlives the run and an
          // operator asking "does this deployment currently satisfy its promises" needs an answer afterwards.
          if (event.type === 'invariant.violated')
            lastViolations = (event.data.violations ?? []) as InvariantViolation[];
          // The Host adds the id below; avoid publishing a duplicate unanswerable event.
          if (event.type !== 'approval.required' && event.type !== 'question.required')
            send({ event });
        };
        const approve: Approver = (approval: Approval, signal: AbortSignal): Promise<boolean> => {
          signal.throwIfAborted();
          const decision = (wake ? wakePolicy : permissionPolicy)?.decide(approval);
          if (decision === 'deny') {
            approvalSources.set(approval.toolCall, 'policy');
            return Promise.resolve(false);
          }
          if (
            unattendedTaskId &&
            store.consumeTaskApproval(sessionId, unattendedTaskId, approval)
          ) {
            approvalSources.set(approval.toolCall, 'task-approval');
            return Promise.resolve(true);
          }
          if (decision === 'allow') {
            approvalSources.set(approval.toolCall, 'policy');
            return Promise.resolve(true);
          }
          if (
            decision !== 'ask' &&
            ((approval.kind === 'write' && options.allowWrite) ||
              (approval.kind === 'command' && options.allowCommand))
          ) {
            approvalSources.set(approval.toolCall, 'launch-options');
            return Promise.resolve(true);
          }
          signal.throwIfAborted();
          if (unattendedTaskId) {
            store.deferTaskApproval(sessionId, unattendedTaskId, approval);
            return Promise.reject(new DeferredApprovalError());
          }
          if (wake) {
            approvalSources.set(approval.toolCall, 'unavailable');
            return Promise.resolve(false);
          }
          return new Promise((resolve) => {
            const approvalId = randomUUID();
            const abort = () => finish(false);
            const timer = setTimeout(() => finish(false, 'unavailable'), 120_000);
            const finish = (allow: boolean, source: ApprovalDecisionSource = 'user') => {
              approvalSources.set(approval.toolCall, source);
              clearTimeout(timer);
              signal.removeEventListener('abort', abort);
              approvals.delete(approvalId);
              resolve(allow);
            };
            approvals.set(approvalId, {
              approval: structuredClone(approval),
              resolve: finish,
            });
            signal.addEventListener('abort', abort, { once: true });
            send({
              event: {
                type: 'approval.required',
                sessionId,
                runId,
                data: { approvalId, approval },
              },
            });
          });
        };
        approve.decisionSource = (approval) => approvalSources.get(approval.toolCall);
        /**
         * Asking the human, the one interactive seam a run keeps even when it may not write.
         *
         * A scheduled run has nobody to ask, so it answers "unavailable" immediately rather than holding the
         * run open for the whole timeout: the model is told to proceed on a stated assumption, and the
         * scheduler does not sit behind a question no one will ever see.
         */
        const ask: Questioner = (
          request: QuestionRequest,
          signal: AbortSignal,
        ): Promise<QuestionOutcome> => {
          signal.throwIfAborted();
          if (unattendedTaskId || wake)
            return Promise.resolve({ answered: false, answers: [], reason: 'unavailable' });
          // The Host's own bound on the wait, from the same settings owner the kernel reads.
          const questionTimeoutMs = resolveRunLimits(options).questionTimeoutMs;
          return new Promise((resolve) => {
            const questionId = randomUUID();
            const finish = (outcome: QuestionOutcome) => {
              const pending = questions.get(questionId);
              if (!pending) return;
              clearTimeout(pending.timer);
              questions.delete(questionId);
              signal.removeEventListener('abort', abort);
              resolve(outcome);
            };
            const abort = () => finish({ answered: false, answers: [], reason: 'cancelled' });
            const timer = setTimeout(
              () => finish({ answered: false, answers: [], timedOut: true, reason: 'timeout' }),
              questionTimeoutMs,
            );
            questions.set(questionId, { resolve: finish, timer });
            signal.addEventListener('abort', abort, { once: true });
            send({
              event: {
                type: 'question.required',
                sessionId,
                runId,
                data: { questionId, request },
              },
            });
          });
        };
        try {
          // Idle residents are reaped on the way into a run rather than by a timer: a Host that has been
          // idle for hours should not be holding language servers it cannot use, and reaping here keeps the
          // process free of background timers whose only purpose is bookkeeping.
          residency.reapIdle();
          if (!sessionSandboxes.has(sessionId)) sessionSandboxes.set(sessionId, defaultSandboxMode);
          const agent = createAgent(
            store,
            workspace,
            options,
            approve,
            // The desktop can change the permission mode between runs, so the policy is read per run
            // (before the tool schema for that run is built) rather than captured once at startup.
            () => (wake ? wakePolicy : permissionPolicy),
            emit,
            background,
            sessionId,
            hooks,
            residency,
            ask,
            invariants,
            terminals,
            () =>
              callExecutionPolicy(
                wake?.authority.sandboxMode ??
                  sessionSandboxes.get(sessionId) ??
                  defaultSandboxMode,
                {
                  image: launchSandbox.image,
                },
              ),
          );
          entry.agent = agent;
          // Created after the busy-guard above but before the run, so the row and the run that fills
          // it cannot disagree about which is current. A continued plan is the row it is continuing
          // rather than a second one beside it.
          const planId = explicitPlan
            ? store.createPlan(sessionId).id
            : (continuing?.planId ?? null);
          const firstRound = agent.run({
            sessionId,
            prompt,
            taskId: plannedTaskId,
            // A run the clock started is not the user's turn: it may report on the session's goal but not change
            // who is in charge of it (see `HUMAN_ONLY_GOAL_ACTIONS`). A manual retry of the same task is the
            // user's own request and keeps the default.
            ...(unattendedTaskId || wake ? { authority: 'automatic' as const } : {}),
            ...(planId ? { planPhase: true, planId } : {}),
            ...(approvedPlan ? { approvedPlan } : {}),
            ...(typeof params.trigger === 'string'
              ? { taskTrigger: params.trigger as TaskTriggerSource }
              : {}),
            ...(params.resume === true ? { resumeTask: true } : {}),
            images: validateImages(params.images),
            signal: controller.signal,
          });
          entry.task = firstRound;
          let outcome = await firstRound;
          /**
           * Rounds the session's own goal starts.
           *
           * A goal is the session's statement of what it is trying to achieve, and nothing here used to start the
           * run that would continue it: the client asked again, or nobody did. With an active goal the request
           * that finished round one keeps going — each continuation is an ordinary run (its own steps, tools,
           * retries and wall clock), the goal's own round budget bounds how many, and the loop stops on a
           * terminal goal, a spent budget, or a round that did not finish.
           *
           * Three kinds of run are deliberately left out. A planning run hands its decision to a human. A task
           * run's rounds belong to that task attempt and the acceptance evidence it produces, so extending one
           * invisibly would corrupt what the task's verification is checking. An approved-plan run executes
           * exactly the plan a person approved. In all three the goal is still read afterwards — the next
           * ordinary run in that session continues it.
           *
           * The request's reply is the *last* round's result rather than the first one's: a client that asked for
           * work wants the answer the session arrived at, and the rounds in between are not hidden — each is a
           * run of its own, so the carrier sees every one of them start and every message land.
           */
          if (!wake && !planId && !plannedTaskId && !approvedPlan) {
            const rounds = await runGoalRounds({
              /**
               * The host's own bound, not the goal's ceiling.
               *
               * Passing `GOAL_CEILINGS.maxGoalRounds` here made the "second bound" the goal's own number wearing
               * a different name: `max_goal_rounds` is a record the model may raise through `update_goal`, so a
               * continuation round that raised it to the ceiling also decided how many rounds this loop would
               * run unattended. See `GOAL_CONTINUATIONS_PER_REQUEST`.
               */
              maxContinuations: GOAL_CONTINUATIONS_PER_REQUEST,
              signal: controller.signal,
              goalOf: () => store.goal(sessionId),
              onRound: (continuation) => {
                process.stderr.write(`[goal] round ${continuation.round}\n`);
              },
              // The goal spent its rounds and is still active, which is a state that tells everyone reading it
              // that more rounds are coming. Recording the verdict is what stops that being a lie.
              onExhausted: (goal) => {
                const verdict = exhaustedGoalVerdict(goal, new Date().toISOString());
                if (!verdict) return;
                store.recordEvent(sessionId, 'goal.changed', { action: 'blocked', goal: verdict });
                emit({
                  type: 'goal.changed',
                  sessionId,
                  runId,
                  // The frame carries the log position of the fact it announces, exactly as the kernel's own
                  // `goal.changed` frames do, so the live view and the durable record stay ordered together.
                  seq: store.lastSeq(sessionId),
                  data: { action: 'blocked', goal: verdict },
                });
              },
              runOnce: async (prompt) => {
                // Another round of the same goal, started by the runtime rather than by the user: it may carry
                // the work forward and report on the goal, but not re-aim it or undo a pause.
                outcome = await agent.run({
                  sessionId,
                  prompt,
                  signal: controller.signal,
                  authority: 'automatic',
                });
                return { status: outcome.status };
              },
            });
            if (rounds.continuations > 0)
              process.stderr.write(
                `[goal] stopped after ${rounds.continuations} round(s): ${rounds.stopped}\n`,
              );
          }
          return outcome;
        } finally {
          clearTimeout(wakeTimer);
          try {
            if (controller.signal.aborted) await background.close(sessionId);
          } finally {
            active.delete(sessionId);
            queueWake();
            // Announce completion only after the slot is free, otherwise a task triggered by this
            // event would be skipped as "Host busy" and silently never run.
            const taskId = typeof params.taskId === 'string' ? params.taskId : undefined;
            notifyScheduler({
              name: 'run.finished',
              sessionId,
              ...(taskId ? { taskId } : {}),
            });
            if (taskId) {
              try {
                if (store.getTask(sessionId, taskId).status === 'completed')
                  notifyScheduler({ name: 'task.completed', sessionId, taskId });
              } catch {
                /* A task deleted while running is not a completion. */
              }
            }
          }
        }
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
  async function handle(line: string): Promise<void> {
    let id: string | undefined,
      registered = false;
    try {
      if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error('Request exceeds 16MB limit');
      const request = JSON.parse(line) as Record<string, unknown>;
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new Error('Request must be an object');
      if (typeof request.id !== 'string' || !request.id)
        throw new Error('id must be a nonempty string');
      id = request.id;
      if (requestIds.has(id)) throw new Error('Duplicate pending request ID');
      requestIds.add(id);
      registered = true;
      if (typeof request.method !== 'string') throw new Error('method must be a string');
      const params = request.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params))
        throw new Error('params must be an object');
      const result = await dispatch(request.method, params as Record<string, unknown>);
      send({ id, result });
    } catch (error) {
      send({
        id: id ?? null,
        error: {
          message: safeError(error),
          code: error instanceof HostProtocolError ? error.code : 'HOST_REQUEST_FAILED',
        },
      });
    } finally {
      if (id && registered) requestIds.delete(id);
    }
  }
  /**
   * Serve the same protocol on a socket, and wait for the one carrier this Host serves.
   *
   * One connection at a time is a deliberate limit rather than an implementation detail: the Host holds the
   * approvals, the active runs, the question map and the workspace lock for the sessions it serves, and two
   * clients on one Host would share every one of those. A second connection is told so and closed instead of
   * being silently accepted into a state it does not own. When the carrier goes away the Host shuts down,
   * exactly as it does on stdin EOF: a Host is owned by the carrier that started it.
   */
  const acceptCarrier = async (listen: string): Promise<Interface> => {
    const separator = listen.lastIndexOf(':');
    const host = separator > 0 ? listen.slice(0, separator) : '127.0.0.1';
    const port = Number(separator > 0 ? listen.slice(separator + 1) : listen);
    return await new Promise<Interface>((resolve, reject) => {
      server = createServer((candidate) => {
        if (socket) {
          candidate.write(
            JSON.stringify({
              id: null,
              error: {
                message:
                  'Agent Host already has a connected client; one connection at a time (the approvals, runs and workspace lock are per Host)',
              },
            }) + '\n',
          );
          candidate.end();
          return;
        }
        socket = candidate;
        output = (line) => candidate.write(line);
        const lines = createInterface({ input: candidate, crlfDelay: Infinity });
        lines.once('close', () => {
          // A carrier that went away ends the read loop, which runs the same shutdown path stdin EOF does.
          if (closing) return;
          void lines.close();
        });
        process.stderr.write(
          `[host] carrier connected from ${candidate.remoteAddress ?? 'local'}\n`,
        );
        resolve(lines);
      });
      server.on('error', (error) => reject(error));
      server.listen(port, host, () => {
        const address = server?.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        // The port is reported on stdout because port 0 is a legitimate request ("any free port") and the
        // carrier has no other way to learn what it got.
        process.stdout.write(
          `YuanTu Agent Host listening on ${host}:${bound} (JSONL, one client at a time).\n`,
        );
      });
    });
  };
  try {
    // Started only once the read loop is live, so a trigger that fires immediately can dispatch
    // through the same path as any other request.
    if (stdioCarrier) {
      input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      output = (line) => process.stdout.write(line);
    } else input = await acceptCarrier(options.listen!);
    // Read through the one reader of environment settings, and compare against the boolean it returns:
    // `YUANTU_WORKFLOWS` is declared a boolean, so testing for the *string* `'off'` (which the environment
    // validator rejects outright) meant `YUANTU_WORKFLOWS=false` started the scheduler rather than stopping it.
    if (parseSetting(process.env, 'YUANTU_WORKFLOWS') !== false) scheduler.start();
    queueWake();
    for await (const line of input) {
      if (closing) break;
      if (!line.trim()) continue;
      const task = handle(line);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
  } finally {
    shutdown();
    await Promise.allSettled([...tasks]);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    // Every still-announced session ends with the host, so a hook can flush state it opened.
    for (const sessionId of announced) {
      const failures = await hooks
        .sessionEnd({ sessionId, reason: 'shutdown' }, new AbortController().signal)
        .catch((error: unknown) => [safeError(error)]);
      for (const failure of failures) process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
      // The last chance to check a promise about a session, before the store that holds its log closes.
      const violations = await invariants.run('session-close', { sessionId });
      for (const violation of violations)
        process.stderr.write(
          `invariant violated on session close: ${violation.name} (${violation.owner}): ${violation.detail}\n`,
        );
    }
    announced.clear();
    try {
      // Terminals first: a pty holds a process, and closing it is what releases the shell, whatever the
      // background commands are still doing.
      try {
        await terminals.closeAllAndWait();
      } finally {
        await background.close();
      }
    } finally {
      store.close();
      await hooks.close().catch(() => undefined);
    }
  }
}
await main().catch((error) => {
  process.stderr.write(safeError(error) + '\n');
  process.exitCode = 1;
});
