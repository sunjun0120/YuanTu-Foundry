import { AgentHostClient, type HostClientOptions } from '../client/host-client.ts';
import { deepFreeze } from '../client/freeze.ts';
import { readDisplayHistory } from '../client/display-history.ts';
import {
  SessionController,
  type MessageDelta,
  type StatisticsDelta,
  type SubAgentDelta,
} from '../client/session-controller.ts';
import { redactSecrets } from '../platform/redact.ts';
import { readConfig } from '../providers/config.ts';
import type { ModelCatalogConfiguration, ModelSelection } from '../protocol/model-configuration.ts';
import { credentialsPath } from '../providers/credentials.ts';
import { statSync } from 'node:fs';
import type { SessionInfo } from '../protocol/index.ts';
import type { HostMethods } from '../protocol/rpc.ts';
import type { PermissionPolicySource } from '../protocol/permission-policy.ts';
import type { SandboxMode } from '../sandbox/sandbox-provider.ts';
import type { FileEffect, NetworkEffect } from '../protocol/execution.ts';
import { parseCarrierCommand, type CarrierSnapshot } from './contract.ts';
import { CarrierError, carrierIssue } from './errors.ts';
import { BackgroundPanel } from './background-panel.ts';
import { SubAgentTranscriptViewer } from './subagent-transcript.ts';
import { runTaskCommand, type TaskCommandContext } from './task-commands.ts';
import {
  EXECUTION_COMMANDS,
  EXECUTION_POLICY_CAPABILITY,
  MANAGING_COMMANDS,
  describeSelection,
} from './command-policy.ts';
import {
  FULL_REFRESH,
  mergeAuditWindow,
  refreshScopeFor,
  type RefreshScope,
} from './refresh-scope.ts';
export { AUDIT_WINDOW, mergeAuditWindow, refreshScopeFor } from './refresh-scope.ts';
export type { RefreshScope } from './refresh-scope.ts';
/**
 * How many times the carrier restarts a Host that died on its own, and the pause between tries.
 *
 * Three is enough for the ordinary causes (a crash, an out-of-disk write, a transient spawn failure) and few
 * enough that a workspace the Host genuinely cannot open reaches the user as an error instead of a loop.
 *
 * Only a carrier that owns the Host process can do this at all; one that was handed a link has nothing to
 * restart (see `CarrierService.recoverHost`).
 */
const HOST_RECOVERY_ATTEMPTS = 3;
const HOST_RECOVERY_DELAY_MS = 250;
/** How many more sessions the sidebar shows each time it is asked for more. */
const SESSION_PAGE = 100;
/** The largest page the Host answers in one `session.list` call (`MAX_SESSION_PAGE` in the store). */
const SESSION_REQUEST_MAX = 500;
/** How many audit entries one request asks for; the carrier keeps `AUDIT_WINDOW` of them. */
const AUDIT_PAGE = 500;

/**
 * The client state machine every carrier shares: sessions, run state, transcript projection, pending
 * approvals and questions, statistics.
 *
 * It answers one question — *what should the interface see* — and it answers it from Host answers only. There
 * is no DOM, no Electron and no window API in here (a test pins that), which is what makes a second carrier
 * cheap: it wires up a transport, a shell and this class, and gets the whole state machine rather than a copy
 * of it.
 *
 * The two shapes it accepts mirror the transport seam in `packages/client/host-client.ts`:
 *
 * - `SpawnedHostOptions` — this carrier owns the Host process. It supervises it, names it in failure reports
 *   (`hostPid`), and restarts it after a crash.
 * - `ConnectedHostOptions` — somebody else produced a link to an already-running Host (a Host process a test or
 *   an embedder started itself). There is no process to restart, so a dead link is reported as failed and
 *   reconnecting is the carrier's own business.
 */
export interface CarrierOptions {
  /** Trusted connection catalog, restored before automatic work is enabled after startup or recovery. */
  modelCatalog?: ModelCatalogConfiguration;
  /**
   * Whether the snapshot carries the session's process record (`audit`); defaults to `true`.
   *
   * A carrier whose window has no panel for it passes `false`: the record is then never read from the Host, and
   * the snapshot's `audit` stays empty. Reading it was paging up to five thousand entries per session and sending
   * them to a renderer that discarded them.
   */
  audit?: boolean;
  /**
   * What the embedder must verify before a Host process is allowed to exist.
   *
   * Called first thing in `start()`, inside the same `try` as the spawn, so throwing here fails the start in the
   * one way everything else does: the error is captured into the snapshot and published to the window. The point
   * of the hook is the *before*: a Host that cannot accept its environment exits with a message about *exiting*,
   * which tells a person to restart rather than to fix the variables, and spends a process on finding that out.
   */
  startupCheck?: () => void;
}
export class CarrierService {
  /** Read a fixed transcript window for the shell without changing the visible history or selection. */
  async exportTranscript(sessionId: string) {
    const client = this.client;
    const first = await client.request('session.get', {
      sessionId,
      view: 'display',
      offset: 0,
      tail: 1,
    });
    const history = await readDisplayHistory(client, sessionId, Infinity, 0, {
      ...(first.totalMessages === undefined ? {} : { endOffset: first.totalMessages }),
    });
    return { title: first.session.title, messages: history.messages };
  }

  private client: AgentHostClient;
  private controller: SessionController;
  private readonly backgroundPanel: BackgroundPanel;
  private readonly transcript: SubAgentTranscriptViewer;
  /**
   * Whether this carrier owns the Host process.
   *
   * Read from the options once, because it decides two things that must not disagree: whether a crash earns a
   * restart, and whether `hostPid` means anything.
   */
  private readonly supervisesHost: boolean;
  /** The embedder's precondition on the environment, run before any Host process exists (see `CarrierOptions`). */
  private readonly startupCheck: (() => void) | undefined;
  /** The environment this carrier runs under, used for configuration reads and error redaction. */
  private readonly env: NodeJS.ProcessEnv;
  private modelCatalog: ModelCatalogConfiguration | undefined;
  private modelSelection: { sessionId: string; value: ModelSelection } | undefined;
  private readonly modelSecrets = new Set<string>();
  /**
   * The workspace the Host serves.
   *
   * Held here rather than mutated into the caller's options object: the Host is the authority (it realpaths
   * the path and reports it in `host.info`), so the first `start()` overwrites whatever the carrier guessed.
   */
  private workspace: string;
  private sessions: SessionInfo[] = deepFreeze([]);
  /**
   * How many sessions the sidebar shows: a window over the newest, grown by `loadMoreSessions`.
   *
   * The list used to be read whole on every refresh — twice when a search was active — and copied into every
   * snapshot, so a workspace with thousands of conversations paid for all of them on each run event. One extra row
   * is requested to learn whether more exist without counting them.
   */
  private sessionLimit = SESSION_PAGE;
  private sessionsHasMore = false;
  /**
   * The panels' state, each frozen where it is assigned: snapshots share it until it is replaced (see `snapshot`).
   */
  private resources: CarrierSnapshot['resources'] = deepFreeze({
    instructions: [],
    skills: [],
    extensions: [],
  });
  private changes: CarrierSnapshot['changes'] = deepFreeze([]);
  private audit: CarrierSnapshot['audit'] = deepFreeze([]);
  /** Whether this carrier reads the process record at all; see `CarrierOptions.audit`. */
  private readonly readsAudit: boolean;
  /** The session and seq the held audit window ends at; see `refreshAudit`. Empty means "read from the start". */
  private auditCursor: { sessionId: string; seq: number } = { sessionId: '', seq: 0 };
  private tasks: CarrierSnapshot['tasks'] = deepFreeze([]);
  private taskAttempts: CarrierSnapshot['taskAttempts'] = deepFreeze({});
  private taskSteps: CarrierSnapshot['taskSteps'] = deepFreeze({});
  private restoring = false;
  private managing = false;
  private sessionQuery = '';
  private currentSession: SessionInfo | null = null;
  private searchVersion = 0;
  private ready = false;
  /** Live settings belong to this carrier and must survive a supervised Host restart. */
  /** Permission policies by session; `''` is the default a session without its own selection reads. */
  private permissionPolicies = new Map<string, PermissionPolicySource>();
  private sandboxSelections = new Map<
    string,
    { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect }
  >();
  /**
   * Sessions whose last strict selection was never confirmed by the Host.
   *
   * A Host that answered something other than what was asked may have applied part of it, so the policy is not
   * a fact this carrier can name; execution for that session waits until a selection is confirmed.
   */
  private unconfirmedPolicies = new Set<string>();
  private startupStage: CarrierSnapshot['startupStage'] = 'starting';
  private error: string | CarrierError | null = null;
  private recovery: CarrierSnapshot['recovery'] = null;
  private recovering = false;
  /**
   * Whether the link has dropped since the last time this carrier was level with the Host.
   *
   * The one thing that says a hole is possible: with no interruption there is nothing to check for, and after
   * one the question is worth exactly one bounded request (see `SessionController.catchUp`).
   */
  private interrupted = false;
  private stopping = false;
  private listeners = new Set<(snapshot: CarrierSnapshot) => void>();
  private deltaListeners = new Set<(delta: MessageDelta) => void>();
  private subagentDeltaListeners = new Set<(delta: SubAgentDelta) => void>();
  private statisticsDeltaListeners = new Set<(delta: StatisticsDelta) => void>();
  private unsubscribers: (() => void)[];
  constructor(options: HostClientOptions & CarrierOptions) {
    const { audit, startupCheck, modelCatalog, ...clientOptions } = options;
    this.modelCatalog = modelCatalog ? structuredClone(modelCatalog) : undefined;
    for (const connection of modelCatalog?.connections ?? [])
      this.modelSecrets.add(connection.apiKey);
    this.readsAudit = audit !== false;
    this.startupCheck = startupCheck;
    // `workspace` is the spawning shape's own key; the connected shape learns it from `host.info`.
    this.supervisesHost = 'workspace' in clientOptions;
    this.env = clientOptions.env ?? {};
    this.workspace = 'workspace' in clientOptions ? clientOptions.workspace : '';
    this.client = new AgentHostClient({ ...clientOptions, deferAutomatic: true });
    this.controller = new SessionController(this.client);
    this.backgroundPanel = new BackgroundPanel({
      client: this.client,
      controller: this.controller,
      ready: () => this.ready && this.client.status === 'ready',
      publish: () => this.publish(),
    });
    this.transcript = new SubAgentTranscriptViewer({
      client: this.client,
      controller: this.controller,
      publish: () => this.publish(),
    });
    this.unsubscribers = [
      this.controller.subscribeChanges(() => {
        // A run that starts may start commands; the poll that follows it is what shows them.
        if (this.controller.running) this.backgroundPanel.wake();
        this.publish();
      }),
      // Streamed text bypasses the snapshot entirely: republishing the whole CarrierSnapshot per
      // token structured-cloned the full session (base64 images included) across IPC.
      this.controller.subscribeDelta((delta) => {
        for (const listener of this.deltaListeners) {
          try {
            listener(delta);
          } catch {
            /* Carrier-side delivery must not interrupt the stream. */
          }
        }
      }),
      this.controller.subscribeSubAgentDelta((delta) => {
        if (delta.text) this.transcript.quicken(delta.id);
        for (const listener of this.subagentDeltaListeners) {
          try {
            listener(delta);
          } catch {
            /* Carrier-side delivery must not interrupt the stream. */
          }
        }
      }),
      // Usage and activity: once a second during a model call, and previously a full CarrierSnapshot each
      // time. The numbers are the only thing that changed, so they travel on their own channel too.
      this.controller.subscribeStatisticsDelta((delta) => {
        for (const listener of this.statisticsDeltaListeners) {
          try {
            listener(delta);
          } catch {
            /* Carrier-side delivery must not interrupt the stream. */
          }
        }
      }),
      this.client.subscribe((event) => {
        if (event.type === 'session.title.updated') {
          void this.refreshSessionNames().catch(() => {});
          return;
        }
        if (event.sessionId !== this.controller.sessionId) {
          // Another session's run starting or ending changes its row (`activeRun`), not the one on screen.
          if (event.type === 'run.started' || event.type === 'run.finished')
            void this.refreshSessionNames().catch(() => {});
          return;
        }
        this.backgroundPanel.wake();
        if (event.type === 'run.started') void this.refreshSessionNames().catch(() => {});
        // The process record grows during a run, and a decision is only worth reading once it has been made:
        // refreshing it on the events that carry decisions keeps the panel current without polling.
        if (
          event.type === 'approval.decided' ||
          event.type === 'question.answered' ||
          event.type === 'context.overflow' ||
          event.type === 'run.finished'
        )
          this.scheduleAuditRefresh();
        // task.step is emitted on every step transition precisely so progress is visible while a
        // run is in flight; run.finished then captures the final state. Ignoring task.step left the
        // step list frozen until the run ended.
        if (event.type !== 'run.finished' && event.type !== 'task.step') return;
        this.scheduleTasksRefresh();
      }),
      this.client.subscribeStatus((status) => {
        // A Host that exited on its own is not the end of the session: the log outlives the process, and the
        // app's job is to start a new Host and rebuild from it. Only a stop the user asked for is terminal.
        if (status === 'failed' && !this.stopping) {
          this.interrupted = true;
          this.startupStage = 'failed';
          this.error ||= this.supervisesHost
            ? new CarrierError('hostExited')
            : new CarrierError('hostDisconnected');
          void this.recoverHost();
        } else if (
          status === 'ready' &&
          this.interrupted &&
          !this.recovering &&
          !this.supervisesHost
        ) {
          /**
           * A link that came back without a new Host: only a carrier that did not start its Host can be here,
           * because supervised recovery spawns a process and rebuilds the session as part of that. This is the
           * re-attached carrier the cursor exists for — one bounded request when the answer is "level with the
           * log", and a rebuilt session when it is not.
           */
          this.interrupted = false;
          void this.controller.catchUp().catch(() => undefined);
        }
        this.publish();
      }),
    ];
  }
  async updatePermissionPolicy(policy: PermissionPolicySource): Promise<void> {
    const sessionId = this.controller.sessionId;
    await this.client.request('permission.update', { policy, ...(sessionId ? { sessionId } : {}) });
    this.permissionPolicies.set(sessionId ?? '', structuredClone(policy));
  }
  /** Refresh the Host's account state after a fixed desktop maintenance operation. */
  async refreshSandboxAccounts(): Promise<void> {
    await this.client.request('sandbox.refresh', {});
  }
  /**
   * Send one sandbox selection, and keep only what the Host confirmed.
   *
   * The reply is the only evidence that a policy is in force — the request is not evidence at all, because a
   * Host that predates the capability ignores `files`/`network` and answers the mode alone. So a strict
   * selection (one that names files or network) is refused before it is sent unless the Host advertises that it
   * can acknowledge those fields, and afterwards every field that was asked for has to come back identical. A
   * reply that says something else means the Host may have applied part of it: the session is recorded as
   * unconfirmed and execution under it is refused until a selection is confirmed, rather than caching the
   * request and carrying on with a policy nobody can name.
   */
  private async applySelection(
    selection: { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect },
    target: { key: string; sessionId?: string },
  ): Promise<void> {
    const strict = selection.files !== undefined || selection.network !== undefined;
    if (strict && !this.client.supports(EXECUTION_POLICY_CAPABILITY))
      throw new CarrierError('policyUnsupported');
    const answer = await this.client.request('sandbox.set', {
      mode: selection.mode,
      ...(selection.files === undefined ? {} : { files: selection.files }),
      ...(selection.network === undefined ? {} : { network: selection.network }),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    });
    const confirmed = this.confirmedSelection(
      answer,
      selection,
      this.sandboxSelections.get(target.key),
    );
    if (!confirmed) {
      this.unconfirmedPolicies.add(target.key);
      throw new CarrierError('policyMismatch', {
        requested: describeSelection(selection),
        received: describeSelection(answer),
      });
    }
    this.unconfirmedPolicies.delete(target.key);
    this.sandboxSelections.set(target.key, confirmed);
  }
  /**
   * The selection the Host actually acknowledged, or `undefined` when it acknowledged something else.
   *
   * Only fields the reply carries are taken from it; a field the request did not name keeps whatever was last
   * confirmed, and is never invented from the request that was just sent.
   */
  private confirmedSelection(
    answer: HostMethods['sandbox.set']['result'],
    requested: { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect },
    previous: { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect } | undefined,
  ): { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect } | undefined {
    if (!answer || answer.mode !== requested.mode) return undefined;
    if (requested.files !== undefined && answer.files !== requested.files) return undefined;
    if (requested.network !== undefined && answer.network !== requested.network) return undefined;
    if (
      answer.files !== undefined &&
      answer.files !== 'read-only' &&
      answer.files !== 'workspace-write'
    )
      return undefined;
    if (
      answer.network !== undefined &&
      answer.network !== 'denied' &&
      answer.network !== 'unrestricted'
    )
      return undefined;
    const files = answer.files ?? previous?.files;
    const network = answer.network ?? previous?.network;
    return {
      mode: answer.mode,
      ...(files === undefined ? {} : { files }),
      ...(network === undefined ? {} : { network }),
    };
  }
  /**
   * The workspace's files, asked of the Host on the shell's behalf.
   *
   * Deliberately a plain round trip and nothing more: the Host owns the workspace and the path rules the file
   * tools enforce, so a shell that read the directory itself would be enforcing a second, weaker copy of a
   * security decision — and the copy that drifts is the one that opens what the tools refuse. A shell also
   * cannot ask for these on the snapshot: a directory listing is not session state, and copying it into every
   * snapshot would ship a tree the client already has on every token.
   */
  async listWorkspaceFiles(
    input: { path?: string } = {},
  ): Promise<HostMethods['files.list']['result']> {
    return this.client.request('files.list', input);
  }
  async readWorkspaceFile(input: {
    path: string;
    locale?: string;
  }): Promise<HostMethods['files.read']['result']> {
    return this.client.request('files.read', input);
  }
  /** On demand: inventories and preserved results must not inflate every streaming snapshot. */
  async orphanWorkspaces(): Promise<HostMethods['workspaces.orphaned']['result']> {
    if (!this.ready || this.client.status !== 'ready') throw new CarrierError('hostNotReady');
    if (!this.client.supports('workspace-orphans-v1'))
      throw new CarrierError('workspaceMaintenanceUnsupported');
    return this.client.request('workspaces.orphaned', { includeRemoved: true });
  }
  async maintainOrphanWorkspace(
    bindingId: string,
    action: 'archive' | 'remove' | 'restore',
  ): Promise<void> {
    if (!this.ready || this.client.status !== 'ready') throw new CarrierError('hostNotReady');
    if (!this.client.supports('workspace-orphans-v1'))
      throw new CarrierError('workspaceMaintenanceUnsupported');
    if (this.busy) throw new CarrierError('runBusy');
    const policySessionId = this.controller.sessionId;
    if (this.unconfirmedPolicies.has(policySessionId ?? ''))
      throw new CarrierError('policyUnconfirmed');
    if (policySessionId && !this.client.supports('workspace-orphan-policy-context-v1'))
      throw new CarrierError('workspaceMaintenanceUnsupported');
    this.managing = true;
    try {
      await this.client.request(`workspace.${action}`, {
        bindingId,
        ...(policySessionId ? { policySessionId } : {}),
      });
    } finally {
      this.managing = false;
      this.publish();
    }
  }
  /** The newest session the sidebar lists, or a new one when it lists none. */
  private async openNewestListed(): Promise<void> {
    const remaining = await this.client.request('session.list', { limit: 1, archived: false });
    if (remaining[0]) await this.controller.load(remaining[0].id);
    else await this.controller.create();
  }
  /** On demand, like the orphan inventory: the settings page asks for it, every snapshot does not carry it. */
  async archivedSessions(): Promise<SessionInfo[]> {
    if (!this.ready || this.client.status !== 'ready') throw new CarrierError('hostNotReady');
    // The settings page shows a list, not a history: bound what one request may return. The UI says "newest 500".
    return this.client.request('session.list', { archived: true, limit: 500 });
  }
  /**
   * Whether a command that changes what a session holds — delete, archive, undo, a task command — is running.
   *
   * `dispatch` refuses every other command while it is (`sessionOperationBusy`). A shell that only mirrors
   * state reads this to hold a passive follow — the preset tracking the visible session — for the command's
   * last publish instead of dispatching into that refusal: a publish made mid-command is a progress report,
   * not a settled session.
   */
  get sessionOperation(): boolean {
    return this.restoring || this.managing;
  }
  get busy(): boolean {
    return this.sessionOperation || this.controller.running || this.controller.loading;
  }
  /** The last `configured` answer and what it was computed from; see `isConfigured`. */
  private configuredMemo: { key: string; value: boolean } | null = null;
  /**
   * Whether a provider configuration resolves — asked on every snapshot, answered from the environment and the
   * credentials file. Both rarely change, so the answer is kept until one of them does: the key is the
   * environment itself plus the file's modification time, a stat rather than a read and parse.
   */
  private isConfigured(env: NodeJS.ProcessEnv): boolean {
    let stamp = -1;
    try {
      stamp = statSync(credentialsPath(env), { throwIfNoEntry: false })?.mtimeMs ?? -1;
    } catch {
      /* An unreadable location reads as "no file", which is what `readConfig` will conclude too. */
    }
    const key = `${stamp}:${JSON.stringify(env)}`;
    if (this.configuredMemo?.key === key) return this.configuredMemo.value;
    let value = false;
    try {
      readConfig(env);
      value = true;
    } catch {
      /* History remains available without a key. */
    }
    this.configuredMemo = { key, value };
    return value;
  }
  /** The frozen session view, reused while the controller reports no change since it was taken. */
  private sessionView: { revision: number; value: CarrierSnapshot['session'] } | null = null;
  private currentSessionView(): CarrierSnapshot['session'] {
    const revision = this.controller.revision;
    if (this.sessionView?.revision !== revision)
      this.sessionView = { revision, value: this.controller.frozenSnapshot };
    return this.sessionView.value;
  }
  /**
   * What the interface should show. `session` is shared between snapshots taken while the session did not move
   * (cloning every message, images included, for each background or task change was most of a publish's cost),
   * so it is frozen: a consumer that needs to change it copies it first. The panels' sections are frozen where they
   * are assigned and shared the same way, so a publish no longer clones each of them and the window's sender can
   * tell an unchanged one by reference instead of serializing it.
   */
  get snapshot(): CarrierSnapshot {
    const env = { ...process.env, ...this.env };
    const selected =
      this.modelSelection?.sessionId === this.controller.sessionId
        ? this.modelSelection.value
        : undefined;
    const configured = selected?.configured ?? this.isConfigured(env);
    return {
      sessionQuery: this.sessionQuery,
      currentSession: this.currentSession,
      changes: this.changes,
      // Frozen when it is replaced (`refreshAudit`), so every snapshot shares it until a read adds an entry.
      audit: this.audit,
      startupStage: this.startupStage,
      recovery: this.recovery ? { ...this.recovery } : null,
      resources: this.resources,
      workspace: this.workspace,
      model: selected?.model ?? redactSecrets(env.YUANTU_MODEL || '', env),
      modelConnectionId: selected?.connectionId,
      configured,
      supportsVision: selected?.supportsVision ?? env.YUANTU_SUPPORTS_VISION !== 'false',
      ready: this.ready && this.client.status === 'ready',
      host: this.client.status,
      // Only a carrier that started the Host may name its process: for a connected carrier the pid belongs to
      // whoever launched it, and reporting it would attribute that process's death to this link.
      hostPid: (this.supervisesHost ? this.client.pid : undefined) ?? null,
      sessions: this.sessions,
      sessionsHasMore: this.sessionsHasMore,
      background: this.backgroundPanel.jobs,
      backgroundState: this.backgroundPanel.state,
      tasks: this.tasks,
      taskAttempts: this.taskAttempts,
      taskSteps: this.taskSteps,
      session: this.currentSessionView(),
      // Replaced, never edited, whenever it changes (`SubAgentTranscriptViewer`), so it is shared like the panels.
      subagentTranscript: this.transcript.current,
      error: this.error instanceof CarrierError ? this.error.message : this.error,
      errorDetail: carrierIssue(this.error, (value) => this.safeError(new Error(value))),
    };
  }
  subscribe(listener: (snapshot: CarrierSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  /** Streamed assistant text on its own channel, so a token never costs a full snapshot. */
  subscribeDelta(listener: (delta: MessageDelta) => void): () => void {
    this.deltaListeners.add(listener);
    return () => this.deltaListeners.delete(listener);
  }
  /** Streamed sub-agent text, kept off the snapshot channel for the same reason. */
  subscribeSubAgentDelta(listener: (delta: SubAgentDelta) => void): () => void {
    this.subagentDeltaListeners.add(listener);
    return () => this.subagentDeltaListeners.delete(listener);
  }
  /** Usage and activity, on their own channel so a per-second update does not copy the session. */
  subscribeStatisticsDelta(listener: (delta: StatisticsDelta) => void): () => void {
    this.statisticsDeltaListeners.add(listener);
    return () => this.statisticsDeltaListeners.delete(listener);
  }
  private publish(): void {
    if (!this.listeners.size) return;
    // One snapshot per publish, shared by every listener: the getter clones each small section again.
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Window teardown must not interrupt Host cleanup. */
      }
    }
  }
  private taskRefreshVersion = 0;
  private async refreshTasks(sessionId = this.controller.sessionId): Promise<void> {
    const version = ++this.taskRefreshVersion;
    if (!sessionId) {
      this.tasks = deepFreeze([]);
      this.taskAttempts = deepFreeze({});
      this.taskSteps = deepFreeze({});
      return;
    }
    const tasks = await this.client.request('task.list', { sessionId });
    // One request for every task's history where the Host offers it; two per task where it does not.
    const history = this.client.supports('task-history-v1')
      ? await this.client.request('task.history', { sessionId })
      : null;
    const pairs = await Promise.all(
      tasks.map(
        async (task) =>
          [
            task.id,
            history
              ? (history[task.id] ?? { attempts: [], steps: [] })
              : {
                  attempts: await this.client.request('task.attempts', {
                    sessionId,
                    taskId: task.id,
                  }),
                  steps: await this.client.request('task.steps', { sessionId, taskId: task.id }),
                },
          ] as const,
      ),
    );
    if (version !== this.taskRefreshVersion || sessionId !== this.controller.sessionId) return;
    this.tasks = deepFreeze(tasks);
    this.taskAttempts = deepFreeze(
      Object.fromEntries(pairs.map(([id, value]) => [id, value.attempts])),
    );
    // The step journal is the durable record of what survived an interruption, so the UI reads it
    // rather than inferring progress from the mutable step list.
    this.taskSteps = deepFreeze(Object.fromEntries(pairs.map(([id, value]) => [id, value.steps])));
  }
  private tasksRefreshing = false;
  private tasksRefreshQueued = false;
  /** Coalesces event-driven refreshes so a burst of step transitions costs a single round of RPCs. */
  private scheduleTasksRefresh(): void {
    if (this.tasksRefreshing) {
      this.tasksRefreshQueued = true;
      return;
    }
    this.tasksRefreshing = true;
    void this.refreshTasks()
      .then(() => this.publish())
      .catch(() => {})
      .finally(() => {
        this.tasksRefreshing = false;
        if (this.tasksRefreshQueued) {
          this.tasksRefreshQueued = false;
          this.scheduleTasksRefresh();
        }
      });
  }
  private async refresh(scope: RefreshScope = FULL_REFRESH): Promise<void> {
    const id = this.controller.sessionId;
    if (scope.sessions) {
      const version = ++this.searchVersion;
      const { sessions, hasMore, current } = await this.sessionWindow(id);
      if (version === this.searchVersion) {
        this.sessions = deepFreeze(sessions);
        this.sessionsHasMore = hasMore;
        this.currentSession = deepFreeze(current);
      }
    }
    /**
     * The panels below read independent Host state and publish into separate fields, each under its own session
     * guard, so they go out together: a command waits for the slowest read rather than for the sum of them.
     */
    const reads: Promise<void>[] = [];
    if (scope.changes) reads.push(this.refreshChanges(id));
    if (scope.audit && this.readsAudit) reads.push(this.refreshAudit(id));
    if (scope.tasks) reads.push(this.refreshTasks(id));
    if (scope.background) reads.push(this.backgroundPanel.refresh());
    const settled = await Promise.allSettled(reads);
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  private async refreshChanges(id: string | null): Promise<void> {
    const version = this.searchVersion;
    const changes = id ? await this.client.request('changes.list', { sessionId: id }) : [];
    // Published under the same guard as the session list: two overlapping refreshes can cross a session switch,
    // and a stale reply landing last would show the file changes of a session the user has left.
    if (version === this.searchVersion && id === this.controller.sessionId)
      this.changes = deepFreeze(changes);
  }
  /** Refresh independently when a fallback or a background-generated title becomes available. */
  private async refreshSessionNames(): Promise<void> {
    const version = ++this.searchVersion;
    const { sessions, hasMore, current } = await this.sessionWindow(this.controller.sessionId);
    if (version !== this.searchVersion) return;
    this.sessions = deepFreeze(sessions);
    this.sessionsHasMore = hasMore;
    this.currentSession = deepFreeze(current);
    this.publish();
  }
  /**
   * The sidebar's page of sessions (searched when a query is active) and the open session's own row.
   *
   * The open session is read by id rather than found in the page: it may be older than the window, or filtered out
   * by the search, and the header still names it.
   */
  private async sessionWindow(id: string | null): Promise<{
    sessions: SessionInfo[];
    hasMore: boolean;
    current: SessionInfo | null;
  }> {
    // Filled in Host pages: the window may outgrow what one `session.list` call returns.
    const page: SessionInfo[] = [];
    while (page.length < this.sessionLimit + 1) {
      const want = Math.min(SESSION_REQUEST_MAX, this.sessionLimit + 1 - page.length);
      const next = await this.client.request('session.list', {
        ...(this.sessionQuery ? { query: this.sessionQuery } : {}),
        limit: want,
        // Archived sessions live on their own settings page, not in the sidebar.
        archived: false,
        ...(page.length ? { before: page.at(-1)!.id } : {}),
      });
      page.push(...next);
      if (next.length < want) break;
    }
    const sessions = page.slice(0, this.sessionLimit);
    const current =
      (!this.sessionQuery && sessions.find((item) => item.id === id)) ||
      (id ? ((await this.client.request('session.list', { id }))[0] ?? null) : null);
    return { sessions, hasMore: page.length > this.sessionLimit, current };
  }
  /**
   * Read the session's process record from the log, continuing from what was already read.
   *
   * It used to be read whole on every refresh — up to ten pages of five hundred entries — although a command
   * usually adds one line and the panel scrolls to the newest. The RPC's `afterSeq` was there for this: the same
   * session continues from the seq of the last entry held, and only a session this carrier has not read starts at
   * zero. The window is capped, so a long session keeps its newest entries instead of growing without bound.
   */
  private async refreshAudit(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      this.audit = deepFreeze([]);
      this.auditCursor = { sessionId: '', seq: 0 };
      return;
    }
    const continuing = this.auditCursor.sessionId === sessionId;
    let entries: CarrierSnapshot['audit'] = continuing ? [...this.audit] : [];
    let afterSeq = continuing ? this.auditCursor.seq : 0;
    for (;;) {
      const page: HostMethods['session.audit']['result'] = await this.client.request(
        'session.audit',
        {
          sessionId,
          afterSeq,
          limit: AUDIT_PAGE,
        },
      );
      entries = mergeAuditWindow(entries, page.entries);
      if (page.entries.length < AUDIT_PAGE) break;
      afterSeq = page.nextSeq;
    }
    // A load can finish after the user moved on; publishing another session's record would be worse than
    // showing a stale one, so the answer is dropped unless it is still the open session.
    if (sessionId !== this.controller.sessionId) return;
    // A read that found nothing new keeps the frozen window it had, so the window is not sent again for it.
    if (continuing && entries.length === this.audit.length && entries.at(-1) === this.audit.at(-1))
      return;
    this.audit = deepFreeze(entries);
    this.auditCursor = { sessionId, seq: entries.at(-1)?.seq ?? afterSeq };
  }
  private auditRefreshing = false;
  private auditRefreshQueued = false;
  /** Same coalescing as the task refresh: a burst of decisions costs one round of RPCs. */
  private scheduleAuditRefresh(): void {
    if (!this.readsAudit) return;
    if (this.auditRefreshing) {
      this.auditRefreshQueued = true;
      return;
    }
    this.auditRefreshing = true;
    void this.refreshAudit(this.controller.sessionId)
      .then(() => this.publish())
      .catch(() => {})
      .finally(() => {
        this.auditRefreshing = false;
        if (this.auditRefreshQueued) {
          this.auditRefreshQueued = false;
          this.scheduleAuditRefresh();
        }
      });
  }
  /**
   * Bring the app back after the Host process died on its own.
   *
   * The Host owns the run, the store and the workspace lock, so when it exits there is nothing left to
   * continue: the run that was in flight is over, and its outcome is whatever the workspace now shows. What
   * *can* be done — and what this does — is start a new Host and rebuild every view from the session log,
   * which is the only thing that is actually durable. The new Host settles the abandoned run as it starts
   * (its unresolved calls get an "outcome unknown" result, the session's own record gets a `run.interrupted`
   * line, and the stale active run is cleared), so the session is usable again rather than merely readable.
   *
   * Bounded on purpose: a Host that cannot start is a real failure, and retrying forever would hide it.
   *
   * A carrier that was handed a link does none of this. It cannot start a Host — the client reports
   * `recoverable === false` — and reconnecting belongs to whoever opened the link, so the failure is reported
   * as it stands rather than papered over with an attempt this carrier has no way to make.
   */
  private async recoverHost(): Promise<void> {
    if (this.recovering || this.stopping || !this.client.recoverable) return;
    this.recovering = true;
    const sessionId = this.controller.sessionId;
    // Read before restarting: `lastPid` becomes the *new* Host's id as soon as one is spawned, and the notice
    // has to name the process that died.
    const crashedPid = this.client.lastPid ?? null;
    try {
      for (let attempt = 1; attempt <= HOST_RECOVERY_ATTEMPTS; attempt++) {
        this.ready = false;
        this.startupStage = 'starting';
        this.publish();
        try {
          await this.client.start();
          await this.restoreModels();
        } catch (error) {
          this.error = this.captureError(error);
          if (attempt < HOST_RECOVERY_ATTEMPTS) await this.recoveryDelay(attempt);
          continue;
        }
        try {
          /**
           * A cached selection outlives the Host, but the session it belongs to may not: another client can
           * delete it while this carrier is down. Replaying one whose session is gone used to throw out of the
           * whole recovery — three attempts, and a window that never came back. The live session list is the
           * authority, it is read before anything is applied, and only selections whose session still exists
           * are replayed; the default selection (`''`) belongs to no session and is always kept. A list that
           * fails is a failed recovery, not an empty one.
           */
          const known = await this.client.request('session.list', {});
          const live = new Set(known.map((session) => session.id));
          for (const key of [...this.sandboxSelections.keys()])
            if (key && !live.has(key)) this.sandboxSelections.delete(key);
          for (const key of [...this.permissionPolicies.keys()])
            if (key && !live.has(key)) this.permissionPolicies.delete(key);
          for (const key of [...this.unconfirmedPolicies])
            if (key && !live.has(key)) this.unconfirmedPolicies.delete(key);
          // The session this carrier had open goes through the same test: a deleted one is not retried, the
          // ordinary fallback (the first live session, or a new one) is used instead.
          const open = sessionId !== null && live.has(sessionId) ? sessionId : undefined;
          // Restore enforcement before loading sessions or announcing readiness. Launch defaults may be
          // less restrictive than the session's current policy.
          const defaultSandbox = this.sandboxSelections.get('');
          if (defaultSandbox) await this.applySelection(defaultSandbox, { key: '' });
          for (const [selectedSession, selection] of [...this.sandboxSelections]) {
            if (!selectedSession) continue;
            await this.applySelection(selection, {
              key: selectedSession,
              sessionId: selectedSession,
            });
          }
          // Each session gets its own policy back; the default first, so overrides land on top of it.
          const defaultPolicy = this.permissionPolicies.get('');
          if (defaultPolicy)
            await this.client.request('permission.update', { policy: defaultPolicy });
          for (const [policySession, policy] of [...this.permissionPolicies]) {
            if (!policySession) continue;
            await this.client.request('permission.update', { policy, sessionId: policySession });
          }
          // The same order the launch path uses, so a recovered window is in the state a fresh one would be.
          await this.refresh();
          this.resources = deepFreeze(await this.client.request('resources.list', {}));
          if (open) await this.controller.load(open);
          else if (this.sessions[0]) await this.controller.load(this.sessions[0].id);
          else await this.controller.create();
          await this.refresh();
          await this.refreshModelSelection();
          if (this.client.supports('runtime.ready')) await this.client.request('runtime.ready', {});
          this.ready = true;
          this.startupStage = 'ready';
          this.error = null;
          this.recovery = { attempts: attempt, pid: crashedPid };
          this.backgroundPanel.start();
          return;
        } catch (error) {
          this.error = this.captureError(error);
          await this.client.stop().catch(() => {});
          if (attempt < HOST_RECOVERY_ATTEMPTS) await this.recoveryDelay(attempt);
        }
      }
      this.startupStage = 'failed';
      this.error ||= new CarrierError('hostRecoveryFailed');
    } finally {
      this.recovering = false;
      this.publish();
    }
  }
  private recoveryDelay(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, HOST_RECOVERY_DELAY_MS * attempt));
  }
  private async restoreModels(): Promise<void> {
    if (!this.modelCatalog) return;
    if (!this.client.supports('model-configuration-v1'))
      throw new Error('Host does not support live model configuration');
    await this.client.request('model.configure', this.modelCatalog);
  }
  private async refreshModelSelection(): Promise<void> {
    const sessionId = this.controller.sessionId;
    if (!sessionId || !this.client.supports('model-configuration-v1')) return;
    const value = await this.client.request('model.get', { sessionId });
    if (sessionId === this.controller.sessionId) this.modelSelection = { sessionId, value };
  }
  async configureModels(catalog: ModelCatalogConfiguration): Promise<void> {
    for (const connection of catalog.connections) this.modelSecrets.add(connection.apiKey);
    if (!this.client.supports('model-configuration-v1'))
      throw new Error('Host does not support live model configuration');
    await this.client.request('model.configure', catalog);
    this.modelCatalog = structuredClone(catalog);
    await this.refreshModelSelection();
    this.publish();
  }
  async selectModel(connectionId: string): Promise<ModelSelection> {
    if (this.busy || this.restoring || this.managing) throw new CarrierError('operationBusy');
    const sessionId = this.controller.sessionId;
    if (!sessionId) throw new Error('No session selected');
    const value = await this.client.request('model.select', { sessionId, connectionId });
    if (sessionId === this.controller.sessionId) this.modelSelection = { sessionId, value };
    this.publish();
    return value;
  }
  /** The connection choice is public metadata; reading it never reloads the transcript. */
  get selectedModel(): ModelSelection | undefined {
    return this.modelSelection?.sessionId === this.controller.sessionId
      ? this.modelSelection.value
      : undefined;
  }
  async start(sessionId?: string): Promise<void> {
    try {
      this.startupStage = 'starting';
      this.publish();
      // Before the first process exists: an environment the Host cannot accept is not a Host that exited.
      this.startupCheck?.();
      const info = await this.client.start();
      // The Host realpaths the workspace; its answer is the authority, not the path the carrier passed in.
      this.workspace = info.workspace;
      await this.restoreModels();
      await this.refresh();
      this.startupStage = 'resources';
      this.publish();
      this.resources = deepFreeze(await this.client.request('resources.list', {}));
      this.startupStage = 'history';
      this.publish();
      if (sessionId) await this.controller.load(sessionId);
      else if (this.sessions[0]) await this.controller.load(this.sessions[0].id);
      else {
        await this.controller.create();
        await this.refresh();
      }
      await this.refresh();
      await this.refreshModelSelection();
      if (this.client.supports('runtime.ready')) await this.client.request('runtime.ready', {});
      this.ready = true;
      this.startupStage = 'ready';
      this.backgroundPanel.start();
    } catch (error) {
      this.startupStage = 'failed';
      this.error = this.captureError(error);
      throw error;
    } finally {
      this.publish();
    }
  }
  safeError(error: unknown): string {
    const secrets = Object.fromEntries(
      [...this.modelSecrets].map((value, index) => [`MODEL_${index}_API_KEY`, value]),
    );
    return redactSecrets(error instanceof Error ? error.message : 'Carrier operation failed', {
      ...process.env,
      ...this.env,
      ...secrets,
    });
  }
  private captureError(error: unknown): string | CarrierError {
    const detail = carrierIssue(error, (value) => this.safeError(new Error(value)));
    return detail ? new CarrierError(detail.code, detail.values) : this.safeError(error);
  }
  /** What a task command may see and change of this service; see `runTaskCommand`. */
  private taskContext(): TaskCommandContext {
    return {
      client: this.client,
      controller: this.controller,
      tasks: this.tasks,
      configured: this.snapshot.configured,
      setTasks: (tasks) => {
        this.tasks = deepFreeze(tasks);
        this.publish();
      },
      setRestoring: (restoring) => {
        this.restoring = restoring;
      },
      reportError: (error) => {
        this.error = error;
      },
      safeError: (error) => this.safeError(error),
    };
  }
  async dispatch(input: unknown): Promise<CarrierSnapshot> {
    const command = parseCarrierCommand(input);
    if (command.type === 'snapshot') return this.snapshot;
    if (!this.ready || this.client.status !== 'ready')
      throw new CarrierError(this.recovering ? 'hostRecovering' : 'hostNotReady');
    if (
      EXECUTION_COMMANDS.has(command.type) &&
      this.unconfirmedPolicies.has(this.controller.sessionId ?? '')
    )
      throw new CarrierError('policyUnconfirmed');
    // Any action counts as seeing the notice: it is there to explain a window that came back by itself, not to
    // stay on screen until the app is restarted again.
    this.recovery = null;
    if (command.type === 'searchSessions') {
      this.sessionQuery = command.query;
      // A new search starts from its first page, whatever window the previous list had grown to.
      this.sessionLimit = SESSION_PAGE;
      await this.refreshSessionNames();
      return this.snapshot;
    }
    if (command.type === 'loadMoreSessions') {
      this.sessionLimit += SESSION_PAGE;
      await this.refreshSessionNames();
      return this.snapshot;
    }
    if (command.type === 'stopBackground') {
      this.error = null;
      try {
        await this.client.request('background.stop', {
          sessionId: command.sessionId,
          id: command.id,
        });
        await this.backgroundPanel.refresh();
        return this.snapshot;
      } catch (error) {
        this.error = this.captureError(error);
        throw error;
      } finally {
        this.publish();
      }
    }
    if (command.type === 'backgroundPolicy') {
      const sessionId = this.controller.sessionId;
      if (!sessionId) throw new CarrierError('sessionRequired');
      await this.client.request('background.policy', {
        sessionId,
        policy: command.policy,
        reset: command.reset,
      });
      await this.backgroundPanel.refresh();
      return this.snapshot;
    }
    if (command.type === 'pollBackground' || command.type === 'refreshBackground') {
      await this.backgroundPanel.refresh();
      return this.snapshot;
    }
    if (command.type === 'clearBackground') {
      const sessionId = this.controller.sessionId;
      if (sessionId) await this.client.request('background.clear', { sessionId });
      await this.backgroundPanel.refresh();
      return this.snapshot;
    }
    /**
     * Commands that answer something a managing command is itself waiting on.
     *
     * `/plan` is a managing command: it holds `managing` for the whole planning run, and that run can stop to
     * ask whether the plan should be approved (or to wait for a tool approval). Those answers are not mutations
     * racing the plan — they are the only way it can finish — so the managing gate must not close on them.
     * `cancel` belongs here for the same reason: a person must always be able to stop the run they are staring at.
     */
    const interactive =
      command.type === 'approve' || command.type === 'questionAnswer' || command.type === 'cancel';
    if (this.restoring || (this.managing && !interactive))
      throw new CarrierError('sessionOperationBusy');
    const manages = MANAGING_COMMANDS.has(command.type);
    if (manages) {
      if (this.busy) throw new CarrierError('runBusy');
      this.managing = true;
    }
    this.error = null;
    try {
      switch (command.type) {
        case 'rename':
          await this.client.request('session.rename', {
            sessionId: command.id,
            title: command.title,
          });
          break;
        case 'archiveSession': {
          await this.client.request('session.archive', {
            sessionId: command.id,
            archived: command.archived,
          });
          // The open session left the list, so the window moves to the newest one still in it, as a delete does.
          if (command.archived && this.controller.sessionId === command.id) {
            this.sessionQuery = '';
            this.transcript.close();
            await this.openNewestListed();
          }
          break;
        }
        case 'deleteSession': {
          await this.client.request('session.delete', { sessionId: command.id });
          this.sandboxSelections.delete(command.id);
          this.permissionPolicies.delete(command.id);
          // The unconfirmed marker goes with it: both describe a session that no longer exists.
          this.unconfirmedPolicies.delete(command.id);
          this.sessionQuery = '';
          // A transcript belongs to the session that opened it; leaving it up would show one
          // conversation's child while another is on screen.
          this.transcript.close();
          if (this.controller.sessionId === command.id) await this.openNewestListed();
          break;
        }
        case 'undo': {
          const current = {
            running: this.controller.running,
            loading: this.controller.loading,
            sessionId: this.controller.sessionId,
          };
          if (current.running || current.loading || !current.sessionId)
            throw new CarrierError('operationBusy');
          this.restoring = true;
          try {
            await this.client.request('changes.undo', {
              sessionId: current.sessionId,
              id: command.id,
            });
            await this.controller.load(current.sessionId);
          } finally {
            this.restoring = false;
          }
          break;
        }
        case 'create':
          this.transcript.close();
          await this.controller.create();
          break;
        case 'load':
          this.transcript.close();
          await this.controller.load(command.id);
          break;
        case 'loadOlder':
          await this.controller.loadOlder();
          break;
        case 'sandbox': {
          /**
           * The visible session owns the choice. Other sessions keep their own backend selections;
           * pending tools refresh before execution and started bodies keep their snapshots.
           *
           * Nothing is cached from the request: `applySelection` keeps what the Host confirmed and refuses a
           * strict selection that a Host without the capability cannot acknowledge.
           */
          const selectedSession = this.controller.sessionId;
          await this.applySelection(
            {
              mode: command.mode,
              ...(command.files === undefined ? {} : { files: command.files }),
              ...(command.network === undefined ? {} : { network: command.network }),
            },
            {
              key: selectedSession ?? '',
              ...(selectedSession ? { sessionId: selectedSession } : {}),
            },
          );
          break;
        }
        case 'send':
          if (!this.snapshot.configured) throw new CarrierError('modelNotConfigured');
          await this.controller.send(
            command.prompt,
            command.images,
            undefined,
            command.verification,
          );
          break;
        case 'enqueue':
          await this.controller.enqueue(command.prompt, command.mode, command.images);
          break;
        case 'clearQueue':
          await this.controller.clearQueue();
          break;
        case 'taskSave':
        case 'taskConfirm':
        case 'taskPropose':
        case 'taskStart':
        case 'taskApproval':
        case 'taskTrigger':
        case 'taskRefresh':
        case 'taskVerify':
        case 'taskRetry':
        case 'taskHistory':
        case 'goal':
          await runTaskCommand(this.taskContext(), command);
          break;

        // The palette and settings surface invoke this to pick up instruction/extension edits
        // without restarting the app; without a case here the request was silently a no-op.
        case 'refreshResources':
          this.resources = deepFreeze(await this.client.request('resources.list', {}));
          break;
        // The shell owns the save dialog and the file write; the service only answers with state.
        case 'export':
          break;
        case 'compact':
          if (!this.controller.sessionId) throw new CarrierError('sessionRequired');
          await this.client.request('context.compact', {
            sessionId: this.controller.sessionId,
          });
          break;
        case 'plan':
          // `/plan` is the plan-mode state machine now: a read-only run proposes a plan, and a human
          // approves it before anything executes. The old behaviour drafted a task instead.
          await this.controller.plan(command.prompt);
          await this.controller.refreshPlan();
          break;
        case 'planApprove':
          await this.controller.approvePlan(command.planId, command.hash);
          break;
        case 'planReject':
          await this.controller.rejectPlan(command.planId, command.reason);
          break;
        case 'planExecute':
          await this.controller.executePlan(command.planId, command.verification);
          await this.controller.refreshPlan();
          break;
        case 'planRefresh':
          await this.controller.refreshPlan();
          break;
        case 'approve':
          await this.controller.approve(command.id, command.allow, command.remember === true);
          break;
        case 'questionAnswer':
          // Answering happens *during* a run, so unlike the `manages` commands above it must not wait for
          // the run to finish — waiting is exactly what the run is doing.
          if (command.cancelled) await this.controller.dismissQuestion(command.id);
          else await this.controller.answerQuestion(command.id, command.answers ?? []);
          break;
        case 'subagentTranscript':
          await this.transcript.open(command.subagentId, command.childSessionId);
          break;
        case 'subagentWorkspace': {
          const parentSessionId = this.controller.sessionId;
          if (!parentSessionId) throw new CarrierError('sessionRequired');
          const children = await this.client.request('subagents.list', {
            sessionId: parentSessionId,
            includePreviousRuns: true,
          });
          if (
            !children.some(
              (child) =>
                child.id === command.subagentId && child.sessionId === command.childSessionId,
            )
          )
            throw new CarrierError('subagentNotInSession');
          const params = { sessionId: command.childSessionId };
          if (command.action === 'archive') await this.client.request('workspace.archive', params);
          else if (command.action === 'remove')
            await this.client.request('workspace.remove', params);
          else await this.client.request('workspace.restore', params);
          await this.controller.load(parentSessionId);
          break;
        }
        case 'closeSubagentTranscript':
          this.transcript.close();
          break;
        case 'cancel':
          await this.controller.cancel();
          break;
        // These four are shell intents: a clipboard, an external browser, a save dialog and a folder picker.
        // They travel in the same vocabulary so one parser validates them for every carrier, and each carrier's
        // shell answers them before the service sees them. Reaching here means the shell did not.
        case 'copyText':
        case 'openLink':
        case 'chooseWorkspace':
          throw new CarrierError('shellCommand');
      }
      await this.refresh(refreshScopeFor(command.type));
      if (this.modelSelection?.sessionId !== this.controller.sessionId)
        await this.refreshModelSelection();
      return this.snapshot;
    } catch (error) {
      this.error = this.captureError(error);
      throw error;
    } finally {
      if (manages) this.managing = false;
      this.publish();
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.backgroundPanel.stop();
    this.transcript.close();
    this.ready = false;
    this.startupStage = 'stopped';
    this.controller.dispose();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    await this.client.stop();
    this.publish();
    this.listeners.clear();
  }
}
