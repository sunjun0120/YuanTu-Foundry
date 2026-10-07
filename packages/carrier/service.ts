import { AgentHostClient, type HostClientOptions } from '../client/host-client.ts';
import { readDisplayHistory } from '../client/display-history.ts';
import {
  SessionController,
  type MessageDelta,
  type StatisticsDelta,
  type SubAgentDelta,
} from '../client/session-controller.ts';
import { redactSecrets } from '../core/errors.ts';
import { readConfig } from '../providers/config.ts';
import type { SessionInfo } from '../protocol/index.ts';
import type { HostMethods } from '../protocol/rpc.ts';
import { initialTaskDraft, normalizeTaskDraft } from '../core/task-spec.ts';
import type { PermissionPolicySource } from '../core/permissions.ts';
import type { SandboxMode } from '../tools/sandbox-provider.ts';
import { parseCarrierCommand, type CarrierSnapshot, type SubAgentTranscript } from './contract.ts';
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
/** How many 100-message history pages the sub-agent viewer will load before it stops. */
const SUBAGENT_TRANSCRIPT_PAGES = 2;

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
 * - `ConnectedHostOptions` — somebody else produced a link to an already-running Host (a web carrier behind a
 *   socket bridge, an embedded host). There is no process to restart, so a dead link is reported as failed and
 *   reconnecting is the carrier's own business.
 */
export class CarrierService {
  private client: AgentHostClient;
  private controller: SessionController;
  /**
   * Whether this carrier owns the Host process.
   *
   * Read from the options once, because it decides two things that must not disagree: whether a crash earns a
   * restart, and whether `hostPid` means anything.
   */
  private readonly supervisesHost: boolean;
  /** The environment this carrier runs under, used for configuration reads and error redaction. */
  private readonly env: NodeJS.ProcessEnv;
  /**
   * The workspace the Host serves.
   *
   * Held here rather than mutated into the caller's options object: the Host is the authority (it realpaths
   * the path and reports it in `host.info`), so the first `start()` overwrites whatever the carrier guessed.
   */
  private workspace: string;
  private sessions: SessionInfo[] = [];
  private resources: CarrierSnapshot['resources'] = {
    instructions: [],
    skills: [],
    extensions: [],
  };
  private changes: CarrierSnapshot['changes'] = [];
  private audit: CarrierSnapshot['audit'] = [];
  private background: CarrierSnapshot['background'] = [];
  private backgroundState: CarrierSnapshot['backgroundState'] = null;
  private tasks: CarrierSnapshot['tasks'] = [];
  private taskAttempts: CarrierSnapshot['taskAttempts'] = {};
  private taskSteps: CarrierSnapshot['taskSteps'] = {};
  private backgroundCursors = new Map<string, number>();
  /** The sub-agent transcript the user opened, if any. Read-only, and scoped to the open session. */
  private subagentTranscript: SubAgentTranscript | null = null;
  private subagentTranscriptOffset = 0;
  private subagentTranscriptTimer: ReturnType<typeof setInterval> | undefined;
  private subagentTranscriptRefreshing = false;
  private subagentTranscriptVersion = 0;
  private backgroundLogs = new Map<string, string>();
  private backgroundTimer: ReturnType<typeof setInterval> | undefined;
  private backgroundRefreshing = false;
  private restoring = false;
  private managing = false;
  private sessionQuery = '';
  private currentSession: SessionInfo | null = null;
  private searchVersion = 0;
  private ready = false;
  /** Live settings belong to this carrier and must survive a supervised Host restart. */
  private permissionPolicy: PermissionPolicySource | undefined;
  private sandboxMode: SandboxMode | undefined;
  private startupStage: CarrierSnapshot['startupStage'] = 'starting';
  private error: string | null = null;
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
  constructor(options: HostClientOptions) {
    // `workspace` is the spawning shape's own key; the connected shape learns it from `host.info`.
    this.supervisesHost = 'workspace' in options;
    this.env = options.env ?? {};
    this.workspace = 'workspace' in options ? options.workspace : '';
    this.client = new AgentHostClient({ ...options, deferAutomatic: true });
    this.controller = new SessionController(this.client);
    this.unsubscribers = [
      this.controller.subscribe(() => this.publish()),
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
        if (event.sessionId !== this.controller.snapshot.sessionId) return;
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
            ? 'Agent Host 意外退出，请重新启动应用。'
            : '与 Agent Host 的连接已断开；请让启动它的载体重新连接。';
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
    const sessionId = this.controller.snapshot.sessionId;
    await this.client.request('permission.update', { policy, ...(sessionId ? { sessionId } : {}) });
    this.permissionPolicy = structuredClone(policy);
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
  async readWorkspaceFile(input: { path: string }): Promise<HostMethods['files.read']['result']> {
    return this.client.request('files.read', input);
  }
  get busy(): boolean {
    return (
      this.restoring ||
      this.managing ||
      this.controller.snapshot.running ||
      this.controller.snapshot.loading
    );
  }
  get snapshot(): CarrierSnapshot {
    const env = { ...process.env, ...this.env };
    let configured = false;
    try {
      readConfig(env);
      configured = true;
    } catch {
      /* History remains available without a key. */
    }
    return {
      sessionQuery: this.sessionQuery,
      currentSession: structuredClone(this.currentSession),
      changes: structuredClone(this.changes),
      audit: structuredClone(this.audit),
      startupStage: this.startupStage,
      recovery: this.recovery ? { ...this.recovery } : null,
      resources: structuredClone(this.resources),
      workspace: this.workspace,
      model: redactSecrets(env.YUANTU_MODEL || '未配置模型', env),
      configured,
      supportsVision: env.YUANTU_SUPPORTS_VISION !== 'false',
      ready: this.ready && this.client.status === 'ready',
      host: this.client.status,
      // Only a carrier that started the Host may name its process: for a connected carrier the pid belongs to
      // whoever launched it, and reporting it would attribute that process's death to this link.
      hostPid: (this.supervisesHost ? this.client.pid : undefined) ?? null,
      sessions: structuredClone(this.sessions),
      background: this.background,
      backgroundState: this.backgroundState,
      tasks: structuredClone(this.tasks),
      taskAttempts: structuredClone(this.taskAttempts),
      taskSteps: structuredClone(this.taskSteps),
      session: this.controller.snapshot,
      subagentTranscript: structuredClone(this.subagentTranscript),
      error: this.error,
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
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* Window teardown must not interrupt Host cleanup. */
      }
    }
  }
  private backgroundRefreshVersion = 0;
  private async refreshBackground(): Promise<void> {
    if (this.backgroundRefreshing || !this.ready || this.client.status !== 'ready') return;
    const sessionId = this.controller.snapshot.sessionId;
    const version = ++this.backgroundRefreshVersion;
    if (!sessionId) {
      this.background = [];
      this.backgroundState = null;
      return;
    }
    this.backgroundRefreshing = true;
    try {
      const jobs = await this.client.request('background.list', { sessionId });
      const backgroundState = await this.client.request('background.state', { sessionId });
      const next: CarrierSnapshot['background'] = [];
      for (const summary of jobs) {
        const cursor = this.backgroundCursors.get(summary.id) ?? 0;
        try {
          const current = await this.client.request('background.poll', {
            sessionId,
            id: summary.id,
            cursor,
            waitMs: 0,
          });
          const previous = this.backgroundLogs.get(summary.id) ?? '';
          const combined = current.truncated ? current.output : previous + current.output;
          this.backgroundLogs.set(summary.id, combined.slice(-65536));
          this.backgroundCursors.set(summary.id, current.nextCursor);
          next.push({ ...current, output: this.backgroundLogs.get(summary.id)! });
        } catch {
          next.push({
            ...summary,
            output: this.backgroundLogs.get(summary.id) ?? summary.output,
            nextCursor: this.backgroundCursors.get(summary.id) ?? summary.nextCursor,
          });
        }
      }
      if (
        version !== this.backgroundRefreshVersion ||
        sessionId !== this.controller.snapshot.sessionId
      )
        return;
      this.background = next;
      this.backgroundState = backgroundState;
      const ids = new Set(next.map((job) => job.id));
      for (const id of this.backgroundCursors.keys())
        if (!ids.has(id)) this.backgroundCursors.delete(id);
      this.publish();
    } finally {
      this.backgroundRefreshing = false;
    }
  }
  private startBackgroundPolling(): void {
    clearInterval(this.backgroundTimer);
    // A poll that fails because the Host went away is not an unhandled rejection: the failure is already
    // reported once, by the connection's own status channel (`subscribeStatus`), and a process that died
    // mid-poll is exactly when this fires. Letting it escape here would take down a timer callback that no
    // caller is waiting on — which is how the connected-carrier test caught it.
    this.backgroundTimer = setInterval(() => void this.refreshBackground().catch(() => {}), 1000);
    void this.refreshBackground().catch(() => {});
  }
  private stopBackgroundPolling(): void {
    clearInterval(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.backgroundCursors.clear();
    this.backgroundLogs.clear();
    this.background = [];
    this.backgroundState = null;
  }
  private taskRefreshVersion = 0;
  private async refreshTasks(sessionId = this.controller.snapshot.sessionId): Promise<void> {
    const version = ++this.taskRefreshVersion;
    if (!sessionId) {
      this.tasks = [];
      this.taskAttempts = {};
      this.taskSteps = {};
      return;
    }
    const tasks = await this.client.request('task.list', { sessionId });
    const pairs = await Promise.all(
      tasks.map(
        async (task) =>
          [
            task.id,
            {
              attempts: await this.client.request('task.attempts', { sessionId, taskId: task.id }),
              steps: await this.client.request('task.steps', { sessionId, taskId: task.id }),
            },
          ] as const,
      ),
    );
    if (version !== this.taskRefreshVersion || sessionId !== this.controller.snapshot.sessionId)
      return;
    this.tasks = tasks;
    this.taskAttempts = Object.fromEntries(pairs.map(([id, value]) => [id, value.attempts]));
    // The step journal is the durable record of what survived an interruption, so the UI reads it
    // rather than inferring progress from the mutable step list.
    this.taskSteps = Object.fromEntries(pairs.map(([id, value]) => [id, value.steps]));
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
  private async refresh(): Promise<void> {
    const version = ++this.searchVersion;
    const all = await this.client.request('session.list', {});
    const sessions = this.sessionQuery
      ? await this.client.request('session.list', { query: this.sessionQuery })
      : all;
    const id = this.controller.snapshot.sessionId;
    if (version === this.searchVersion) {
      this.sessions = sessions;
      this.currentSession = all.find((item) => item.id === id) ?? null;
    }
    this.changes = id ? await this.client.request('changes.list', { sessionId: id }) : [];
    await this.refreshAudit(id);
    await this.refreshTasks(id);
    await this.refreshBackground();
  }
  /** Title generation finishes before run.started, so the sidebar can show it while the reply streams. */
  private async refreshSessionNames(): Promise<void> {
    const version = ++this.searchVersion;
    const all = await this.client.request('session.list', {});
    const sessions = this.sessionQuery
      ? await this.client.request('session.list', { query: this.sessionQuery })
      : all;
    if (version !== this.searchVersion) return;
    this.sessions = sessions;
    this.currentSession =
      all.find((item) => item.id === this.controller.snapshot.sessionId) ?? null;
    this.publish();
  }
  /**
   * Read the session's process record from the log.
   *
   * It is read whole (as bounded pages) rather than incrementally: the record is a handful of lines per run,
   * and a panel that has to be scrolled to the newest line is not worth a cursor on the carrier side yet. The
   * RPC's `afterSeq` is what makes the bounded read possible in the first place.
   */
  private async refreshAudit(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      this.audit = [];
      return;
    }
    const entries: CarrierSnapshot['audit'] = [];
    let afterSeq = 0;
    for (;;) {
      const page: HostMethods['session.audit']['result'] = await this.client.request(
        'session.audit',
        {
          sessionId,
          afterSeq,
          limit: 500,
        },
      );
      entries.push(...page.entries);
      if (page.entries.length < 500 || entries.length >= 5_000) break;
      afterSeq = page.nextSeq;
    }
    // A load can finish after the user moved on; publishing another session's record would be worse than
    // showing a stale one, so the answer is dropped unless it is still the open session.
    if (sessionId !== this.controller.snapshot.sessionId) return;
    this.audit = entries;
  }
  private auditRefreshing = false;
  private auditRefreshQueued = false;
  /** Same coalescing as the task refresh: a burst of decisions costs one round of RPCs. */
  private scheduleAuditRefresh(): void {
    if (this.auditRefreshing) {
      this.auditRefreshQueued = true;
      return;
    }
    this.auditRefreshing = true;
    void this.refreshAudit(this.controller.snapshot.sessionId)
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
   * Opens a sub-agent's transcript for reading.
   *
   * The ids come from the interface, so they are checked against the delegations this session actually
   * recorded — the viewer must not become a way to read any session in the workspace. The page budget
   * is deliberately small: the panel is for spot-checking what a child did, not for browsing a second
   * conversation, and the whole snapshot is deep-cloned on every publish.
   */
  private async openSubAgentTranscript(subagentId: string, childSessionId: string): Promise<void> {
    this.closeSubAgentTranscript();
    const version = this.subagentTranscriptVersion;
    const sessionId = this.controller.snapshot.sessionId;
    if (!sessionId) throw new Error('Open a session first');
    // The durable card list shows completed delegations. While the current run is still active, its child
    // exists only in the controller's live event projection, so the viewer must accept that same trusted view.
    const live = this.controller.snapshot.subagents.find(
      (entry) => entry.id === subagentId && entry.childSessionId === childSessionId,
    );
    const summary =
      live ??
      (await this.client.request('subagents.list', { sessionId })).find(
        (entry) => entry.id === subagentId && entry.sessionId === childSessionId,
      );
    if (!summary) throw new Error('That sub-agent does not belong to this session');
    const history = await readDisplayHistory(
      this.client,
      childSessionId,
      SUBAGENT_TRANSCRIPT_PAGES * 100,
    );
    if (version !== this.subagentTranscriptVersion) return;
    this.subagentTranscript = {
      subagentId,
      childSessionId,
      objective: summary.objective,
      messages: history.messages,
      truncated: history.truncated,
    };
    this.subagentTranscriptOffset = history.nextOffset;
    this.startSubAgentTranscriptPolling();
  }
  private startSubAgentTranscriptPolling(): void {
    this.stopSubAgentTranscriptPolling();
    this.subagentTranscriptTimer = setInterval(
      () => void this.refreshSubAgentTranscript().catch(() => {}),
      700,
    );
  }
  private stopSubAgentTranscriptPolling(): void {
    clearInterval(this.subagentTranscriptTimer);
    this.subagentTranscriptTimer = undefined;
  }
  private closeSubAgentTranscript(): void {
    this.subagentTranscriptVersion++;
    this.subagentTranscript = null;
    this.stopSubAgentTranscriptPolling();
  }
  private async refreshSubAgentTranscript(): Promise<void> {
    const transcript = this.subagentTranscript;
    if (!transcript || this.subagentTranscriptRefreshing || this.client.status !== 'ready') return;
    this.subagentTranscriptRefreshing = true;
    try {
      const history = await readDisplayHistory(
        this.client,
        transcript.childSessionId,
        100,
        this.subagentTranscriptOffset,
      );
      if (this.subagentTranscript !== transcript) return;
      this.subagentTranscriptOffset = history.nextOffset;
      if (!history.messages.length) return;
      transcript.messages = [...transcript.messages, ...history.messages].slice(-200);
      transcript.truncated ||= history.truncated;
      this.publish();
    } finally {
      this.subagentTranscriptRefreshing = false;
    }
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
    const sessionId = this.controller.snapshot.sessionId;
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
        } catch (error) {
          this.error = this.safeError(error);
          if (attempt < HOST_RECOVERY_ATTEMPTS) await this.recoveryDelay(attempt);
          continue;
        }
        try {
          // Restore enforcement before loading sessions or announcing readiness. Launch defaults may be
          // less restrictive than the session's current policy.
          if (this.sandboxMode !== undefined)
            await this.client.request('sandbox.set', {
              mode: this.sandboxMode,
              ...(sessionId ? { sessionId } : {}),
            });
          if (this.permissionPolicy !== undefined)
            await this.client.request('permission.update', {
              policy: this.permissionPolicy,
              ...(sessionId ? { sessionId } : {}),
            });
          // The same order the launch path uses, so a recovered window is in the state a fresh one would be.
          await this.refresh();
          this.resources = await this.client.request('resources.list', {});
          if (sessionId) await this.controller.load(sessionId);
          else if (this.sessions[0]) await this.controller.load(this.sessions[0].id);
          else await this.controller.create();
          await this.refresh();
          if (this.client.supports('runtime.ready')) await this.client.request('runtime.ready', {});
          this.ready = true;
          this.startupStage = 'ready';
          this.error = null;
          this.recovery = { attempts: attempt, pid: crashedPid };
          this.startBackgroundPolling();
          return;
        } catch (error) {
          this.error = this.safeError(error);
          await this.client.stop().catch(() => {});
          if (attempt < HOST_RECOVERY_ATTEMPTS) await this.recoveryDelay(attempt);
        }
      }
      this.startupStage = 'failed';
      this.error ||= 'Agent Host 意外退出，自动重启失败；请重新启动应用。';
    } finally {
      this.recovering = false;
      this.publish();
    }
  }
  private recoveryDelay(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, HOST_RECOVERY_DELAY_MS * attempt));
  }
  async start(sessionId?: string): Promise<void> {
    try {
      this.startupStage = 'starting';
      this.publish();
      const info = await this.client.start();
      // The Host realpaths the workspace; its answer is the authority, not the path the carrier passed in.
      this.workspace = info.workspace;
      await this.refresh();
      this.startupStage = 'resources';
      this.publish();
      this.resources = await this.client.request('resources.list', {});
      this.startupStage = 'history';
      this.publish();
      if (sessionId) await this.controller.load(sessionId);
      else if (this.sessions[0]) await this.controller.load(this.sessions[0].id);
      else {
        await this.controller.create();
        await this.refresh();
      }
      await this.refresh();
      if (this.client.supports('runtime.ready')) await this.client.request('runtime.ready', {});
      this.ready = true;
      this.startupStage = 'ready';
      this.startBackgroundPolling();
    } catch (error) {
      this.startupStage = 'failed';
      this.error = this.safeError(error);
      throw error;
    } finally {
      this.publish();
    }
  }
  safeError(error: unknown): string {
    return redactSecrets(error instanceof Error ? error.message : 'Carrier operation failed', {
      ...process.env,
      ...this.env,
    });
  }
  async dispatch(input: unknown): Promise<CarrierSnapshot> {
    const command = parseCarrierCommand(input);
    if (command.type === 'snapshot') return this.snapshot;
    if (!this.ready || this.client.status !== 'ready')
      throw new Error(
        this.recovering
          ? 'Agent Host 正在自动重启，请稍候。'
          : 'Agent Host is not ready; restart the desktop',
      );
    // Any action counts as seeing the notice: it is there to explain a window that came back by itself, not to
    // stay on screen until the app is restarted again.
    this.recovery = null;
    if (command.type === 'searchSessions') {
      const version = ++this.searchVersion;
      this.sessionQuery = command.query;
      const sessions = await this.client.request('session.list', { query: command.query });
      if (version === this.searchVersion) {
        this.sessions = sessions;
        this.publish();
      }
      return this.snapshot;
    }
    if (command.type === 'stopBackground') {
      this.error = null;
      try {
        await this.client.request('background.stop', {
          sessionId: command.sessionId,
          id: command.id,
        });
        await this.refreshBackground();
        return this.snapshot;
      } catch (error) {
        this.error = this.safeError(error);
        throw error;
      } finally {
        this.publish();
      }
    }
    if (command.type === 'backgroundPolicy') {
      const sessionId = this.controller.snapshot.sessionId;
      if (!sessionId) throw Error('Create or load a session first');
      await this.client.request('background.policy', {
        sessionId,
        policy: command.policy,
        reset: command.reset,
      });
      await this.refreshBackground();
      return this.snapshot;
    }
    if (command.type === 'pollBackground' || command.type === 'refreshBackground') {
      await this.refreshBackground();
      return this.snapshot;
    }
    if (command.type === 'clearBackground') {
      const sessionId = this.controller.snapshot.sessionId;
      if (sessionId) await this.client.request('background.clear', { sessionId });
      await this.refreshBackground();
      return this.snapshot;
    }
    if (this.restoring || this.managing) throw new Error('Session operation is in progress');
    const manages = [
      'rename',
      'deleteSession',
      'taskRefresh',
      'taskVerify',
      'taskRetry',
      'taskHistory',
      'taskSave',
      'taskApproval',
      'taskStart',
      'taskConfirm',
      'taskPropose',
      'goal',
      'plan',
      'planApprove',
      'planReject',
      'planExecute',
      'planRefresh',
    ].includes(command.type);
    if (manages) {
      if (this.busy) throw new Error('Wait for the current run or loading operation to finish');
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
        case 'deleteSession': {
          await this.client.request('session.delete', { sessionId: command.id });
          this.sessionQuery = '';
          // A transcript belongs to the session that opened it; leaving it up would show one
          // conversation's child while another is on screen.
          this.closeSubAgentTranscript();
          if (this.controller.snapshot.sessionId === command.id) {
            const remaining = await this.client.request('session.list', {});
            if (remaining[0]) await this.controller.load(remaining[0].id);
            else await this.controller.create();
          }
          break;
        }
        case 'undo': {
          const current = this.controller.snapshot;
          if (current.running || current.loading || !current.sessionId)
            throw new Error('Wait for the current operation to finish');
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
          this.closeSubAgentTranscript();
          await this.controller.create();
          break;
        case 'load':
          this.closeSubAgentTranscript();
          await this.controller.load(command.id);
          break;
        case 'sandbox':
          /**
           * The visible session owns the choice. Other sessions keep their own selections, and a run pins the
           * policy it starts with rather than consulting a mutable process-wide selection.
           */
          await this.client.request('sandbox.set', {
            mode: command.mode,
            ...(this.controller.snapshot.sessionId
              ? { sessionId: this.controller.snapshot.sessionId }
              : {}),
          });
          this.sandboxMode = command.mode;
          break;
        case 'send':
          if (!this.snapshot.configured)
            throw new Error('请打开“模型设置”，填写接口地址、模型 ID 和 API 密钥。');
          await this.controller.send(command.prompt, command.images);
          break;
        case 'enqueue':
          await this.controller.enqueue(command.prompt, command.mode, command.images);
          break;
        case 'clearQueue':
          await this.controller.clearQueue();
          break;
        case 'taskSave': {
          const sessionId = this.controller.snapshot.sessionId;
          if (!sessionId) throw new Error('No active session');
          await this.client.request('task.update', {
            sessionId,
            taskId: command.taskId,
            ...normalizeTaskDraft(command),
            expectedUpdatedAt: command.expectedUpdatedAt,
          });
          break;
        }
        case 'taskConfirm': {
          const sessionId = this.controller.snapshot.sessionId;
          if (!sessionId) throw new Error('No active session');
          await this.client.request('task.confirm', {
            sessionId,
            taskId: command.taskId,
            indices: command.indices,
            expectedUpdatedAt: command.expectedUpdatedAt,
          });
          break;
        }
        case 'taskPropose': {
          const sessionId = this.controller.snapshot.sessionId;
          if (!sessionId) throw new Error('No active session');
          try {
            await this.client.request('task.propose', { sessionId, taskId: command.taskId });
          } finally {
            await this.controller.load(sessionId);
          }
          break;
        }
        case 'taskStart': {
          const task = this.tasks.find((item) => item.id === command.taskId);
          if (!task) throw new Error('Task not found');
          normalizeTaskDraft(task);
          await this.controller.send(task.description || task.title, undefined, task.id);
          break;
        }
        case 'taskApproval': {
          const sessionId = this.controller.snapshot.sessionId;
          if (!sessionId) throw new Error('No active session');
          await this.client.request('task.approval.respond', {
            sessionId,
            taskId: command.taskId,
            approvalId: command.approvalId,
            allow: command.allow,
          });
          break;
        }
        case 'taskTrigger': {
          const sessionId = this.controller.snapshot.sessionId;
          if (!sessionId) throw new Error('No active session');
          await this.client.request('task.trigger', {
            sessionId,
            taskId: command.taskId,
            trigger: command.trigger,
          });
          break;
        }
        case 'taskRefresh':
          await this.refresh();
          break;
        case 'taskVerify': {
          this.restoring = true;
          try {
            await this.client.request('task.verify', {
              sessionId: this.controller.snapshot.sessionId!,
              taskId: command.taskId,
            });
          } finally {
            this.restoring = false;
          }
          await this.refreshTasks(this.controller.snapshot.sessionId);
          break;
        }
        case 'taskRetry': {
          if (!this.controller.snapshot.sessionId) throw new Error('No active session');
          const task = this.tasks.find((item) => item.id === command.taskId);
          if (!task) throw new Error('Task not found');
          await this.controller.send(
            command.prompt?.trim() || task.description,
            undefined,
            task.id,
          );
          await this.refresh();
          break;
        }
        case 'taskHistory':
          await this.refreshTasks(this.controller.snapshot.sessionId);
          break;

        // The palette and settings surface invoke this to pick up instruction/extension edits
        // without restarting the app; without a case here the request was silently a no-op.
        case 'refreshResources':
          this.resources = await this.client.request('resources.list', {});
          break;
        // The shell owns the save dialog and the file write; the service only answers with state.
        case 'export':
          break;
        case 'compact':
          if (!this.controller.snapshot.sessionId) throw new Error('No active session');
          await this.client.request('context.compact', {
            sessionId: this.controller.snapshot.sessionId,
          });
          break;
        case 'goal': {
          const sessionId = this.controller.snapshot.sessionId;
          if (!sessionId) throw new Error('No active session');
          const draft = initialTaskDraft(command.type, command.prompt);
          const task = await this.client.request('task.create', {
            sessionId,
            ...draft,
          });
          this.tasks = [task, ...this.tasks.filter((item) => item.id !== task.id)];
          if (this.snapshot.configured) {
            try {
              await this.client.request('task.propose', { sessionId, taskId: task.id });
            } catch (error) {
              this.error = '草稿已保存，自动规划未完成；可编辑后执行。' + this.safeError(error);
            } finally {
              await this.controller.load(sessionId);
            }
          }
          await this.refresh();
          break;
        }
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
          await this.controller.executePlan(command.planId);
          await this.controller.refreshPlan();
          break;
        case 'planRefresh':
          await this.controller.refreshPlan();
          break;
        case 'approve':
          await this.controller.approve(command.id, command.allow);
          break;
        case 'questionAnswer':
          // Answering happens *during* a run, so unlike the `manages` commands above it must not wait for
          // the run to finish — waiting is exactly what the run is doing.
          if (command.cancelled) await this.controller.dismissQuestion(command.id);
          else await this.controller.answerQuestion(command.id, command.answers ?? []);
          break;
        case 'subagentTranscript':
          await this.openSubAgentTranscript(command.subagentId, command.childSessionId);
          break;
        case 'closeSubagentTranscript':
          this.closeSubAgentTranscript();
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
          throw new Error('This command belongs to the carrier shell, not the carrier service');
      }
      await this.refresh();
      return this.snapshot;
    } catch (error) {
      this.error = this.safeError(error);
      throw error;
    } finally {
      if (manages) this.managing = false;
      this.publish();
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.backgroundRefreshVersion++;
    this.stopBackgroundPolling();
    this.closeSubAgentTranscript();
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
