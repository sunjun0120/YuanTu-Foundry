import { InvariantRegistry } from '../../packages/core/invariants.ts';
import { parseSetting, resolveRunLimits } from '../../packages/protocol/settings.ts';
import { emittedEventTypesInvariant } from '../../packages/protocol/invariants.ts';
import { logTablesAgreeInvariant } from '../../packages/storage/invariants.ts';
import type { SessionStore } from '../../packages/storage/sqlite.ts';
import { BackgroundCommands } from '../../packages/tools/background.ts';
import type { HookRegistry } from '../../packages/tools/hooks.ts';
import { pipelineStagesInvariant } from '../../packages/tools/pipeline.ts';
import { sweepSpills } from '../../packages/tools/spill.ts';
import { TerminalSessions } from '../../packages/tools/terminal.ts';
import { WorkspaceManager } from '../../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../../packages/workspaces/results.ts';
import { excludeRuntimeState } from '../../packages/workspaces/runtime-exclude.ts';
import { repositoryIdentity } from '../../packages/workspaces/git.ts';
import { sweepAbandonedStaging } from '../../packages/workspaces/snapshot.ts';
import type { Options } from '../shared/args.ts';
import { loadHookRegistry } from '../shared/hooks.ts';
import { openStore } from '../shared/runtime.ts';

/**
 * What one Host process owns for its whole lifetime.
 *
 * These are the pieces that outlive a run: the durable store every run appends to, the background commands and
 * terminals a *later* run is meant to reach, the hook set shared with every per-run tool registry, and the
 * process-wide invariant registry. They are grouped in one object so a handler receives them as a fact about the
 * process instead of reaching for a module singleton, which is what makes the Host testable and what keeps a
 * second Host in the same process from sharing the first one's terminals.
 */
export interface HostServices {
  store: SessionStore;
  background: BackgroundCommands;
  terminals: TerminalSessions;
  hooks: HookRegistry;
  invariants: InvariantRegistry;
}

/**
 * Open everything the Host owns, and converge the runs a dead Host left in flight before serving anything.
 *
 * The reconciliation is what makes a crash survivable from the client's side: the session is usable, deletable and
 * editable again, its unresolved calls carry "outcome unknown" instead of waiting forever, and each session's own
 * log records that its run was interrupted. All five calls run, in this order, and none of them is optional — a
 * session whose in-flight run is never converged stays busy forever, and a task whose attempt is never recovered
 * waits for a human who was never asked.
 *
 * `store.close()` is deliberately *not* here: closing is teardown, and teardown belongs to the process's exit path
 * (`lifecycle.ts`), which has to unwind in an order this function knows nothing about.
 */
/** Whether a spill directory's session exists; anything but a definite "not found" answers yes. */
export function spillOwnerExists(store: Pick<SessionStore, 'get'>): (sessionId: string) => boolean {
  return (sessionId) => {
    try {
      store.get(sessionId);
      return true;
    } catch (error) {
      return !(error instanceof Error && error.message.startsWith('Session not found:'));
    }
  };
}

export async function openHostServices(options: Options, workspace: string): Promise<HostServices> {
  const store = openStore(options);
  // The store has just created `<workspace>/.yuantu`; keep it out of the user's `git status` (best effort).
  await excludeRuntimeState(workspace).catch((error: unknown) =>
    console.error('agent-host: could not exclude .yuantu from Git', error),
  );
  store.reconcileInterruptedRuns(workspace);
  store.recoverInterruptedTasks(workspace);
  // Sub-agent sessions are hidden from the session list and have no tasks, so a run they left behind
  // would never be converged by anything else.
  store.reconcileChildRuns(workspace);
  store.recoverInterruptedStreams(workspace);
  // Tasks an operator put on a schedule are put back on the queue so an interrupted attempt
  // resumes from its last completed step instead of waiting for a human.
  store.resumableTasks(workspace);
  /**
   * The workspace service's own two convergence passes.
   *
   * `manager.reconcile` classifies the allocations a dead Host left: a `preparing` row whose directory never
   * appeared is removed, and a binding whose directory has gone or changed identity is blocked rather than
   * silently re-pointed. `results.reconcile` decides each interrupted import from the bytes its journal recorded —
   * finishing the ones whose approved content was partly written, refusing the ones that now conflict, and
   * re-offering the ones where nothing happened at all. Neither replays a command, a model request or an approval.
   *
   * Both run here rather than per run because they are facts about the *process*: exactly one Host owns these
   * directories, and a pass that ran inside every run would classify the same rows repeatedly and race itself.
   */
  const workspaces = new WorkspaceManager({ store });
  const workspaceResults = new WorkspaceResultsService({ store });
  const reconciliation = new AbortController();
  await workspaces.reconcile(reconciliation.signal);
  await workspaceResults.reconcile(reconciliation.signal);
  /**
   * Workspace housekeeping: the opt-in retention purge (off by default — a removed workspace is the last copy of
   * unimported work), then the release of every snapshot this database no longer names. Not awaited, because it may
   * walk Git for every snapshot; the manager makes every freeze and allocation wait for it instead.
   */
  const retentionDays = parseSetting(process.env, 'YUANTU_WORKSPACE_RETENTION_DAYS');
  void workspaces.startHousekeeping(
    typeof retentionDays === 'number' ? { retentionMs: retentionDays * 24 * 60 * 60 * 1000 } : {},
    reconciliation.signal,
  );
  /**
   * Spills of sessions that no longer exist, and a workspace-wide budget.
   *
   * Housekeeping, so it is not awaited: it stats every spilled file, and a workspace with many sessions made the Host
   * miss its startup deadline while it did. Only a definite "no such session" counts as an orphan — a store that is
   * closing or failing answers "exists", so a sweep that outlives its Host deletes nothing it cannot account for.
   */
  void sweepSpills({
    workspace,
    sessionExists: spillOwnerExists(store),
  }).catch(() => undefined);
  // The staging a killed freeze left in this repository; housekeeping as well, so it is not awaited either.
  void repositoryIdentity(workspace)
    .then((identity) => (identity ? sweepAbandonedStaging(identity.repositoryRoot) : 0))
    .catch(() => undefined);
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
  const hooks = await loadHookRegistry(
    options.hooks ?? (parseSetting(process.env, 'YUANTU_HOOKS_MODULE') as string | undefined),
    workspace,
  );
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
  return { store, background, terminals, hooks, invariants };
}
