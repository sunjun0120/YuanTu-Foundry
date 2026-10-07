import type {
  AgentEvent,
  Approval,
  Message,
  Plan,
  QuestionAnswer,
  QuestionRequest,
  RunResult,
  RunStatus,
  SubAgentRole,
  SubAgentSummaryReport,
  SubAgentTaskStatus,
  TodoItem,
  ToolCall,
  Usage,
  ImageAttachment,
} from '../protocol/index.ts';
import type { AgentHostClient } from './host-client.ts';
import { readDisplayHistory } from './display-history.ts';
import type { InputMode, QueuedInput } from '../core/run-queue.ts';
import { validateUserInput } from '../protocol/images.ts';
import { emptyStatistics, addStatistics, type SessionStatistics } from '../protocol/statistics.ts';
import { todoDiff } from '../protocol/todos.ts';
import type { TodoChange } from '../protocol/todos.ts';
import { presentFiles } from '../protocol/deliverables.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Goal } from '../protocol/goals.ts';
import type { ToolResultOutput } from '../protocol/tool-result.ts';
import type { ContextBreakdown } from '../core/budget.ts';

/**
 * What the last request of this run predicted its context window would cost, split by section.
 *
 * It is the run's **own prediction**, not a recomputation: the same numbers that chose what to shorten, whether
 * to compress, and how much output to ask for, which is why it can be rendered next to the usage without the
 * two disagreeing. Cumulative usage (the statistics panel) answers "what has this session spent"; this answers
 * "what is the window being spent on right now", and the two are different questions — a catalog of tool
 * schemas can cost more than the conversation, and only this shape says so.
 *
 * Live-only by design: `context.forecast` is a real-time event and is not in the durable log, so a reopened
 * window has no forecast to show. Making it survive a reload would mean adding it to the session's event types
 * *and* to `IGNORABLE_SESSION_EVENTS` so that older builds keep folding newer logs — a compatibility change
 * that the display half does not need.
 */
export interface ContextBudgetView {
  /** Zero-based round this prediction was made for; the panel shows it one-based. */
  round: number;
  breakdown: ContextBreakdown;
  /** The calibrated estimate the request was sized against, and the raw estimate before calibration. */
  inputTokens: number;
  rawInputTokens: number;
  /** What the window had left after this request's output reservation. */
  windowRoom: number;
  /** Tool results this round presented in a shortened form, and the characters that freed. */
  shortened: number;
  freedChars: number;
  /** True when the round compressed the conversation before sending. */
  compacted: boolean;
  /** Why the request cannot be sent, or why proactive compression was off, when either is the case. */
  problem?: string;
  policyProblem?: string;
}

export interface PendingApproval {
  id: string;
  approval: Approval;
}
/**
 * A question the run is waiting on.
 *
 * It is separate from `PendingApproval` because the answer is a shape, not a boolean: the panel has to
 * render options, multi-select and free text, and the reply carries the selections back per question id.
 */
export interface PendingQuestion {
  id: string;
  request: QuestionRequest;
}
/**
 * One streamed slice of a message, delivered without republishing the whole session.
 *
 * `channel` is what keeps reasoning and the answer apart on a channel that exists to be cheap: a consumer that
 * ignores it renders reasoning as the answer, so both ends of this wire read it.
 */
export interface MessageDelta {
  messageId: string;
  text: string;
  channel?: 'reasoning';
  /**
   * The attempt that produced the buffered slice was discarded (a refused request that is being re-sent), so
   * the channel's buffer starts over. `text` is empty and the caller must drop what it accumulated.
   */
  reset?: boolean;
}
/** One streamed slice of a sub-agent's own answer, keyed by sub-agent id. */
export interface SubAgentDelta {
  id: string;
  /** Streamed answer text, absent when only the child's numbers moved. */
  text?: string;
  /**
   * The child's work time and the clock of its open turn, when those are what moved.
   *
   * They travel on this channel for the same reason the text does: a running child's numbers change once a
   * second, and republishing the whole session for them would copy every message — images included — across
   * the process boundary to redraw two numbers in one row.
   */
  durationMs?: number;
  runningSince?: number | null;
  /** The child's own cumulative usage, when it reported one. */
  usage?: Usage;
}
/**
 * Progress and cumulative usage, delivered without republishing the whole session.
 *
 * `statistics.updated` fires while a model call runs — roughly once a second, plus once per tool — and the
 * snapshot it used to publish carries every message in the session, images included. For a long session
 * that is hundreds of kilobytes copied across IPC per second for a panel that shows a handful of numbers,
 * so the numbers travel on their own channel and the session id travels with them: a delta that arrives
 * after a session switch must not be applied to the new session's panel.
 */
export interface StatisticsDelta {
  sessionId: string | null;
  statistics?: SessionStatistics;
  activity: SessionSnapshot['statisticsActivity'];
}
/** A delegated child run as the UI shows it: one card per task, live while the parent run lasts. */
export interface SubAgentView {
  id: string;
  index: number;
  total: number;
  role: SubAgentRole;
  objective: string;
  childSessionId: string;
  status: SubAgentTaskStatus | 'running';
  /** The tool the child is running right now, when it is running one. */
  tool?: string;
  /** Bounded, redacted preview of that tool's arguments, so a card can say what it is acting on. */
  toolArgs?: string;
  rounds: number;
  toolCalls: number;
  /**
   * What this child spent. The parent run pays for it, so a card that only showed rounds and tool calls
   * left the user unable to tell a cheap investigation from an expensive one.
   */
  usage?: Usage;
  /**
   * Wall time the child's ended turns took, in ms, and the epoch ms its open turn started.
   *
   * `durationMs + (runningSince === null ? 0 : Date.now() - runningSince)` is the number to show: the child's
   * own active time ticking while it works, and frozen at what it spent once it stops. Both come from the
   * child's session log, so a reload shows the same total.
   */
  durationMs?: number;
  runningSince?: number | null;
  text: string;
  /** The child's structured report, when it submitted one instead of answering in prose. */
  report?: SubAgentSummaryReport;
  error?: string;
}
export interface SessionSnapshot {
  statistics?: SessionStatistics;
  /**
   * The last request's own context prediction, while this window has heard one.
   *
   * Kept after the run ends (the last round's numbers are what a person reads) and dropped when another
   * session is loaded, because the forecast belongs to a run rather than to the session.
   */
  budget: ContextBudgetView | null;
  statisticsActivity?: {
    kind: 'model' | 'tool';
    startedAt: number;
    phase?: 'reasoning' | 'tool_call' | 'text';
    reasoningChars?: number;
    toolArgumentChars?: number;
    visibleChars?: number;
  } | null;
  queue: QueuedInput[];
  compacting: boolean;
  instructions: string[];
  sessionId: string | null;
  messages: Message[];
  messageRevision: number;
  liveMessage: { id: string; text: string; reasoning: string } | null;
  /** Sub-agents this run delegated to, in request order. */
  subagents: SubAgentView[];
  /** The session-owned checklist, as the model last wrote it. It outlives the run that wrote it. */
  todos: TodoItem[];
  /**
   * What the most recent write changed about that checklist, or `null` when it changed nothing.
   *
   * Kept next to the list rather than recomputed by the renderer, because only the side that saw the previous
   * version can say what a write did — and this side always has it: the live event arrives after the state was
   * set by the write before it, and a load asks the store, which folds it out of the log.
   */
  todoChange: TodoChange | null;
  running: boolean;
  loading: boolean;
  status: 'idle' | 'running' | RunStatus;
  tools: ToolCall[];
  approvals: PendingApproval[];
  /** Questions the run is blocked on, newest last. */
  questions: PendingQuestion[];
  /** The latest plan for this session, which drives the plan panel and its approval gate. */
  plan: Plan | null;
  /**
   * Files a run has marked as its deliverables, newest last.
   *
   * A presentation record, not a filesystem read: `present` says "this is what I produced", and the list is what
   * the session log remembers about it. It survives the run, so a reopened window shows the same list.
   */
  deliverables: PresentedFile[];
  /** What the session is working toward, when a run declared a goal. It outlives every run that works on it. */
  goal: Goal | null;
  error: string | null;
}
export class SessionController {
  private client: AgentHostClient;
  private statisticsBase = emptyStatistics();
  private state: SessionSnapshot = {
    queue: [],
    compacting: false,
    budget: null,
    instructions: [],
    sessionId: null,
    messages: [],
    messageRevision: 0,
    liveMessage: null,
    subagents: [],
    todos: [],
    todoChange: null,
    plan: null,
    deliverables: [],
    goal: null,
    running: false,
    loading: false,
    status: 'idle',
    tools: [],
    approvals: [],
    questions: [],
    error: null,
  };
  private listeners = new Set<(state: SessionSnapshot) => void>();
  private deltaListeners = new Set<(delta: MessageDelta) => void>();
  private subagentDeltaListeners = new Set<(delta: SubAgentDelta) => void>();
  private statisticsDeltaListeners = new Set<(delta: StatisticsDelta) => void>();
  private unsubscribe: () => void;
  private unsubscribeStatus: () => void;
  private disposed = false;
  private runId: string | null = null;
  private active: Promise<RunResult> | null = null;
  private aborter: AbortController | null = null;
  constructor(client: AgentHostClient) {
    this.client = client;
    this.unsubscribe = client.subscribe((event) => this.onEvent(event));
    this.unsubscribeStatus = client.subscribeStatus((status) => {
      if (status === 'failed' || status === 'stopped') {
        if (this.state.running) {
          this.state.status = 'failed';
          this.state.error = 'Agent Host disconnected; inspect session before continuing';
        }
        this.clearLive();
        this.publish();
      }
    });
  }
  get snapshot(): SessionSnapshot {
    return structuredClone(this.state);
  }
  subscribe(listener: (state: SessionSnapshot) => void): () => void {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  /**
   * Streamed assistant text, delivered as small slices instead of as a republished snapshot.
   *
   * Snapshot delivery is expensive: `snapshot` deep-clones the entire state (every message,
   * including base64 image data) and the desktop then structured-clones it again across IPC. Doing
   * that once per streamed token made long sessions and image attachments stutter badly. Structural
   * changes still go through `subscribe`; only the in-flight text uses this channel.
   */
  subscribeDelta(listener: (delta: MessageDelta) => void): () => void {
    this.assertActive();
    this.deltaListeners.add(listener);
    return () => this.deltaListeners.delete(listener);
  }
  private emitDelta(delta: MessageDelta): void {
    for (const listener of this.deltaListeners) {
      try {
        listener(delta);
      } catch {
        /* A consumer's error must not interrupt the stream. */
      }
    }
  }
  /**
   * Streamed sub-agent text. It travels on its own channel for the same reason assistant text does:
   * a child can stream for minutes while the parent is idle, and republishing the whole snapshot per
   * token would copy the entire session across IPC for each one.
   */
  subscribeSubAgentDelta(listener: (delta: SubAgentDelta) => void): () => void {
    this.assertActive();
    this.subagentDeltaListeners.add(listener);
    return () => this.subagentDeltaListeners.delete(listener);
  }
  private emitSubAgentDelta(delta: SubAgentDelta): void {
    for (const listener of this.subagentDeltaListeners) {
      try {
        listener(delta);
      } catch {
        /* A consumer's error must not interrupt the stream. */
      }
    }
  }
  /**
   * Usage and activity on their own channel: it changes once a second during a model call, and the numbers
   * are the only part of the snapshot that changed, so a full snapshot per update is all cost.
   */
  subscribeStatisticsDelta(listener: (delta: StatisticsDelta) => void): () => void {
    this.assertActive();
    this.statisticsDeltaListeners.add(listener);
    return () => this.statisticsDeltaListeners.delete(listener);
  }
  private emitStatisticsDelta(delta: StatisticsDelta): void {
    for (const listener of this.statisticsDeltaListeners) {
      try {
        listener(delta);
      } catch {
        /* A consumer's error must not interrupt the stream. */
      }
    }
  }
  private subagents(): SubAgentView[] {
    return this.state.subagents;
  }
  private publish(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* UI errors must not stall run cleanup. */
      }
    }
  }
  private assertActive(): void {
    if (this.disposed) throw new Error('Session controller is disposed');
  }
  private assertIdle(): void {
    this.assertActive();
    if (this.active || this.state.running || this.state.loading)
      throw new Error('Session is already running or loading');
  }
  async create(): Promise<string> {
    this.assertIdle();
    this.state.loading = true;
    this.publish();
    try {
      const session = await this.client.request('session.create', {});
      await this.read(session.id);
      return session.id;
    } finally {
      this.state.loading = false;
      this.publish();
    }
  }
  async load(sessionId: string): Promise<void> {
    this.assertIdle();
    this.state.loading = true;
    this.publish();
    try {
      await this.read(sessionId);
    } finally {
      this.state.loading = false;
      this.publish();
    }
  }
  private async history(
    sessionId: string,
  ): Promise<{ messages: Message[]; statistics: SessionStatistics }> {
    const history = await readDisplayHistory(this.client, sessionId);
    return { messages: history.messages, statistics: history.statistics ?? emptyStatistics() };
  }
  private async read(sessionId: string): Promise<void> {
    const { messages, statistics } = await this.history(sessionId);
    if (this.disposed) return;
    // The plan lives outside the message history, so it is fetched separately: a plan proposed in an
    // earlier run is still the plan awaiting a decision after a reload.
    const plan = await this.currentPlan(sessionId);
    if (this.disposed) return;
    // Sub-agent cards are rebuilt from the stored run result: their events are progress, not history,
    // and nothing about a child survives in the parent's transcript but its report.
    const subagents = await this.historySubAgents(sessionId);
    if (this.disposed) return;
    // The checklist is session state, not run state: it is written during a run but it is still the plan the
    // model is following after that run ends, so a reload has to bring it back.
    const checklist = await this.historyTodos(sessionId);
    if (this.disposed) return;
    // The deliverables and the goal are session state in the same sense the checklist is: written during a run,
    // still true after it ends, and restored on reload from the log rather than from the run's result.
    const deliverables = await this.historyDeliverables(sessionId);
    if (this.disposed) return;
    const goal = await this.historyGoal(sessionId);
    if (this.disposed) return;
    this.runId = null;
    this.state = {
      queue: [],
      compacting: false,
      budget: null,
      instructions: [],
      sessionId,
      messages,
      messageRevision: this.state.messageRevision + 1,
      statistics,
      statisticsActivity: null,
      liveMessage: null,
      subagents,
      todos: checklist.todos,
      todoChange: checklist.change,
      plan,
      deliverables,
      goal,
      running: false,
      loading: this.state.loading,
      status: 'idle',
      tools: [],
      approvals: [],
      questions: [],
      error: null,
    };
    // A re-read ends level with the log, and saying so is what keeps the check in `catchUp` honest: a client
    // that only ever watched frames would consider itself behind after every reload, and re-read forever.
    await this.noteCursor(sessionId);
  }
  /**
   * Whether the Host behind this client can answer a question about where the log stands.
   *
   * A Host that predates the capability answers `session.events` with an error, and a client shaped like a Host
   * but without the probe is in the same position — which is why the probe itself is asked defensively. The
   * cursor is an optimisation for finding gaps, not a fact anything depends on: without it the next check
   * re-reads the session, which is exactly what a client did before cursors existed.
   */
  private canResume(): boolean {
    try {
      return this.client.supports('session-events') === true;
    } catch {
      return false;
    }
  }
  /**
   * Record where the log stood at the end of a read.
   *
   * Best effort on purpose: a load must not fail because the cursor could not be learned. A cursor that stays
   * where it was makes the next `catchUp` re-read, which is the same outcome as never having had one.
   */
  private async noteCursor(sessionId: string): Promise<void> {
    if (!this.canResume()) return;
    try {
      const page = await this.client.request('session.events', { sessionId, limit: 1 });
      this.client.noteCursor(sessionId, page.latestSeq);
    } catch {
      /* A Host that will not say leaves the cursor where it was. */
    }
  }
  /**
   * Close the gap between what this client has seen live and what the session's log actually holds.
   *
   * A live frame carries the log position it is ordered against (`AgentEvent.seq`), which turns "did I miss
   * anything?" into a question with an answer instead of one that can only be met with a full re-read. The
   * answer used to be unobtainable: with no cursor, a client whose stream had a hole could not tell a stale
   * view from a current one, and the only safe response to any interruption was to read the session again.
   *
   * The gap is closed by re-reading rather than by folding log entries here. Folding would mean a second
   * implementation of every projection the Host derives — todos, deliverables, the goal, statistics — and a
   * second answer to each is exactly the drift the log-as-the-only-source rule exists to prevent. The return
   * value says whether the state was rebuilt: `false` means "checked, and level", and the check costs one
   * bounded request.
   */
  async catchUp(): Promise<boolean> {
    this.assertActive();
    const sessionId = this.state.sessionId;
    // A live run means frames are arriving for this session; the run's own end reconciles its state, and a
    // re-read in the middle would drop the in-flight turn the window is showing.
    if (!sessionId || this.state.running) return false;
    // A Host that cannot answer the question cannot be assumed to be level with: the safe reading of "I cannot
    // check" is "assume a gap", so the session is re-read rather than left showing whatever it last saw.
    if (!this.canResume()) {
      await this.read(sessionId);
      this.publish();
      return true;
    }
    const cursor = this.client.cursorOf(sessionId);
    const page = await this.client.request('session.events', {
      sessionId,
      afterSeq: cursor,
      limit: 1,
    });
    if (page.latestSeq <= cursor) return false;
    await this.read(sessionId);
    this.publish();
    return true;
  }
  /** Reads the latest plan, tolerating a Host that predates the plan capability. */
  private async currentPlan(sessionId: string): Promise<Plan | null> {
    try {
      return await this.client.request('plan.get', { sessionId });
    } catch {
      return null;
    }
  }
  /**
   * The files a run marked as its deliverables, for a session load.
   *
   * Tolerant of a Host that predates the capability, like the plan and the checklist: the panel stays empty
   * rather than the whole session failing to load.
   */
  private async historyDeliverables(sessionId: string): Promise<PresentedFile[]> {
    try {
      return await this.client.request('deliverables.get', { sessionId });
    } catch {
      return [];
    }
  }
  /** The session's goal, for a session load; `null` when there is none or the Host predates the capability. */
  private async historyGoal(sessionId: string): Promise<Goal | null> {
    try {
      return await this.client.request('goal.get', { sessionId });
    } catch {
      return null;
    }
  }
  /**
   * Sub-agents of the most recent run, as stored with its result. A Host that predates the capability
   * simply answers with an error, and the panel stays empty instead of failing the session load.
   */
  private async historySubAgents(sessionId: string): Promise<SubAgentView[]> {
    try {
      const summaries = await this.client.request('subagents.list', { sessionId });
      return summaries.map((summary, index) => ({
        id: summary.id,
        index,
        total: summaries.length,
        role: summary.role,
        objective: summary.objective,
        childSessionId: summary.sessionId,
        status: summary.status,
        rounds: summary.rounds,
        toolCalls: summary.toolCalls,
        ...(summary.status !== 'interrupted' && summary.usage ? { usage: summary.usage } : {}),
        // The card's clock, restored with the card: a child that ran for six minutes says six minutes on a
        // reload, and one whose turn was cut off by a restart stops there instead of counting the downtime.
        durationMs: summary.durationMs ?? 0,
        runningSince: summary.runningSince ?? null,
        text: '',
        // The report is why a card is worth restoring: the status alone says a child ran, and the
        // findings say what it found.
        ...(summary.report ? { report: summary.report } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      }));
    } catch {
      return [];
    }
  }
  /**
   * The checklist as last written, for a session load, plus what the last write changed about it. A Host that
   * predates the capability answers with an error, and the panel stays empty instead of failing the load.
   */
  private async historyTodos(
    sessionId: string,
  ): Promise<{ todos: TodoItem[]; change: TodoChange | null }> {
    try {
      return await this.client.request('todos.get', { sessionId });
    } catch {
      return { todos: [], change: null };
    }
  }
  /** Re-reads the plan after an approval decision so the panel reflects the new status. */
  async refreshPlan(): Promise<void> {
    this.assertActive();
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    this.state.plan = await this.currentPlan(sessionId);
    this.publish();
  }
  async approvePlan(planId: string, hash: string): Promise<void> {
    this.assertActive();
    const sessionId = this.state.sessionId;
    if (!sessionId) throw new Error('Create or load a session first');
    this.state.plan = await this.client.request('plan.approve', { sessionId, planId, hash });
    this.publish();
  }
  async rejectPlan(planId: string, reason?: string): Promise<void> {
    this.assertActive();
    const sessionId = this.state.sessionId;
    if (!sessionId) throw new Error('Create or load a session first');
    this.state.plan = await this.client.request('plan.reject', {
      sessionId,
      planId,
      ...(reason ? { reason } : {}),
    });
    this.publish();
  }
  /**
   * Starts the read-only planning run through the normal send lifecycle, so the plan streams to the
   * UI exactly like any other run. `plan.proposed` then fills in the snapshot's plan.
   */
  async plan(prompt: string): Promise<RunResult> {
    this.assertActive();
    return this.sendInternal(prompt, undefined, undefined, { phase: 'plan' });
  }
  /** Executes an approved plan; the host re-checks the approval and the body digest. */
  async executePlan(planId: string): Promise<RunResult> {
    this.assertActive();
    return this.sendInternal(
      this.state.plan?.title || 'Execute the approved plan',
      undefined,
      undefined,
      { planId },
    );
  }
  async send(prompt: string, images?: ImageAttachment[], taskId?: string): Promise<RunResult> {
    return this.sendInternal(prompt, images, taskId);
  }
  private async sendInternal(
    prompt: string,
    images?: ImageAttachment[],
    taskId?: string,
    plan?: { phase: 'plan' } | { planId: string },
  ): Promise<RunResult> {
    this.assertIdle();
    if (!this.state.sessionId) throw new Error('Create or load a session first');
    const input = validateUserInput({ prompt, images });
    if (this.client.status !== 'ready') throw new Error('Agent Host is not ready');
    this.aborter = new AbortController();
    this.state.messages.push({
      role: 'user',
      createdAt: new Date().toISOString(),
      content: prompt,
      ...(input.images?.length ? { images: input.images } : {}),
    });
    this.state.messageRevision++;
    this.statisticsBase = structuredClone(this.state.statistics ?? emptyStatistics());
    this.state.statisticsActivity = null;
    this.state.running = true;
    this.state.status = 'running';
    this.state.error = null;
    this.runId = null;
    this.publish();
    this.active = this.performSend(
      this.state.sessionId,
      prompt,
      this.aborter.signal,
      input.images,
      taskId,
      plan,
    );
    try {
      return await this.active;
    } finally {
      this.active = null;
      this.aborter = null;
      if (!this.state.running && this.runId)
        await this.refreshFinishedHistory(this.state.sessionId!, this.runId);
      if (!this.runId && !this.state.running) this.state.loading = false;
      this.publish();
    }
  }
  private async performSend(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    images?: ImageAttachment[],
    taskId?: string,
    plan?: { phase: 'plan' } | { planId: string },
  ): Promise<RunResult> {
    let ownedRunId: string | null | undefined;
    const owns = () =>
      this.state.sessionId === sessionId && ownedRunId !== undefined && this.runId === ownedRunId;
    try {
      const result = await this.client.run(sessionId, prompt, {
        signal,
        images,
        taskId,
        ...(plan ?? {}),
      });
      ownedRunId = result.runId;
      if (owns()) {
        this.state.status = result.status;
        this.state.error = result.error ?? null;
      }
      if (!this.disposed && this.client.status === 'ready') {
        const { messages, statistics } = await this.history(sessionId);
        if (owns()) {
          this.state.messages = messages;
          this.state.messageRevision++;
          this.state.statistics = statistics;
        }
      }
      return result;
    } catch (error) {
      // A rejected foreground request may have lost admission to an automatic run.
      // Its error and history cannot take ownership of that live run.
      if (!this.state.running || !this.runId) ownedRunId = this.runId;
      // The optimistic user bubble is only a preview. A rejected run may never have written it,
      // while a failed model call may already have written both it and a partial assistant reply.
      // Reconcile from the Host whenever it is still reachable instead of guessing which occurred.
      if (!this.disposed && this.client.status === 'ready') {
        try {
          const { messages, statistics } = await this.history(sessionId);
          if (owns()) {
            this.state.messages = messages;
            this.state.messageRevision++;
            this.state.statistics = statistics;
          }
        } catch {
          // Preserve the original run error and the visible preview if history itself is unavailable.
        }
      }
      if (owns()) {
        this.state.status = 'failed';
        this.state.error = error instanceof Error ? error.message : 'Agent run failed';
      }
      throw error;
    } finally {
      if (owns()) {
        this.clearLive();
        this.runId = null;
      }
    }
  }
  async approve(id: string, allow: boolean): Promise<void> {
    this.assertActive();
    if (!this.state.approvals.some((item) => item.id === id))
      throw new Error('Approval is no longer pending');
    await this.client.request('approval.respond', { approvalId: id, allow });
    this.state.approvals = this.state.approvals.filter((item) => item.id !== id);
    this.publish();
  }
  /** Answers a pending question; the run resumes as soon as the Host settles the wait. */
  async answerQuestion(id: string, answers: QuestionAnswer[]): Promise<void> {
    await this.settleQuestion(id, { questionId: id, answers });
  }
  /**
   * Declines to answer.
   *
   * The tool settles as unanswered and the model is told to proceed on a stated assumption, so declining is
   * a real answer — it is the only way to unblock a run whose question the user cannot or will not answer.
   */
  async dismissQuestion(id: string): Promise<void> {
    await this.settleQuestion(id, { questionId: id, cancelled: true });
  }
  private async settleQuestion(
    id: string,
    params: { questionId: string; answers?: QuestionAnswer[]; cancelled?: boolean },
  ): Promise<void> {
    this.assertActive();
    if (!this.state.questions.some((item) => item.id === id))
      throw new Error('Question is no longer pending');
    await this.client.request('question.respond', params);
    this.state.questions = this.state.questions.filter((item) => item.id !== id);
    this.publish();
  }
  async enqueue(prompt: string, mode: InputMode, images?: ImageAttachment[]): Promise<void> {
    this.assertActive();
    if (!this.state.running || !this.state.sessionId) throw new Error('Session is not running');
    await this.client.request('run.enqueue', {
      sessionId: this.state.sessionId,
      mode,
      ...validateUserInput({ prompt, images }),
    });
  }
  async clearQueue(): Promise<void> {
    this.assertActive();
    if (!this.state.sessionId) throw new Error('No active session');
    await this.client.request('run.queue.clear', { sessionId: this.state.sessionId });
  }
  async cancel(): Promise<void> {
    this.assertActive();
    if (this.state.running && this.runId && this.state.sessionId)
      await this.client.request('run.cancel', { sessionId: this.state.sessionId });
    else this.aborter?.abort();
    await this.active?.catch(() => {});
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.aborter?.abort();
    this.unsubscribe();
    this.unsubscribeStatus();
    this.listeners.clear();
    this.deltaListeners.clear();
    this.subagentDeltaListeners.clear();
  }
  private clearLive(): void {
    this.state.statisticsActivity = null;
    this.state.queue = [];
    this.state.compacting = false;
    this.state.running = false;
    this.state.liveMessage = null;
    this.state.tools = [];
    this.state.approvals = [];
    this.state.questions = [];
  }
  private async refreshFinishedHistory(sessionId: string, finishedRun: string): Promise<void> {
    const owns = () =>
      this.state.sessionId === sessionId && this.runId === finishedRun && !this.state.running;
    try {
      const { messages, statistics } = await this.history(sessionId);
      if (this.disposed || !owns()) return;
      this.state.messages = messages;
      this.state.messageRevision++;
      this.state.statistics = statistics;
    } catch {
    } finally {
      // A completion snapshot may immediately send again: release the foreground request first.
      if (owns() && !this.active) {
        this.state.loading = false;
        this.runId = null;
        this.publish();
      }
    }
  }
  private onEvent(event: AgentEvent): void {
    if (this.disposed || event.sessionId !== this.state.sessionId) return;
    if (event.type === 'run.started') {
      if (!this.state.running) {
        this.statisticsBase = structuredClone(this.state.statistics ?? emptyStatistics());
        this.state.running = true;
        this.state.loading = false;
        this.state.status = 'running';
        this.state.error = null;
      }
      this.runId = event.runId;
      this.publish();
      return;
    }
    if (!this.state.running) return;
    if (event.runId !== this.runId) return;
    if (event.data.statistics) {
      this.state.statistics = addStatistics(
        this.statisticsBase,
        event.data.statistics as SessionStatistics,
      );
      this.state.statisticsActivity = event.data.activity as SessionSnapshot['statisticsActivity'];
    }
    switch (event.type) {
      case 'resources.loaded':
        this.state.instructions = event.data.instructions as string[];
        break;
      case 'context.compacting':
        this.state.compacting = true;
        break;
      case 'statistics.updated':
        // Usage and activity changed and nothing else did: send the numbers, not the session.
        this.emitStatisticsDelta({
          sessionId: this.state.sessionId,
          statistics: this.state.statistics,
          activity: this.state.statisticsActivity,
        });
        return;
      case 'context.compacted':
        this.state.compacting = false;
        break;
      case 'context.forecast':
        /**
         * The round's own prediction, kept so a window can show what the request costs before it is sent and
         * after it is: "the request is too big" is not actionable on its own, and "the tool schemas cost more
         * than the conversation" is. Only the fields the panel renders are copied — the event also carries
         * numbers the run used to size the request, and a second full copy of them in the snapshot would be a
         * second answer to "what did this round cost".
         */
        this.state.budget = {
          round: Number(event.data.round ?? 0),
          breakdown: structuredClone(event.data.breakdown as ContextBreakdown),
          inputTokens: Number(event.data.inputTokens ?? 0),
          rawInputTokens: Number(event.data.rawInputTokens ?? 0),
          windowRoom: Number(event.data.windowRoom ?? 0),
          shortened: Number(event.data.shortened ?? 0),
          freedChars: Number(event.data.freedChars ?? 0),
          compacted: event.data.compacted === true,
          ...(event.data.problem === undefined ? {} : { problem: String(event.data.problem) }),
          ...(event.data.policyProblem === undefined
            ? {}
            : { policyProblem: String(event.data.policyProblem) }),
        };
        break;
      case 'input.queued':
      case 'queue.changed':
        this.state.queue = structuredClone(event.data.queue as QueuedInput[]);
        break;
      case 'input.consumed':
        this.state.queue = structuredClone(event.data.queue as QueuedInput[]);
        this.state.messages.push(structuredClone(event.data.message as Message));
        this.state.messageRevision++;
        break;
      case 'message.started':
        this.state.liveMessage = { id: String(event.data.messageId), text: '', reasoning: '' };
        break;
      case 'message.reasoning': {
        const messageId = String(event.data.messageId);
        const text = String(event.data.text);
        const reset = event.data.reset === true;
        if (this.state.liveMessage?.id === messageId) {
          this.state.liveMessage.reasoning = reset ? text : this.state.liveMessage.reasoning + text;
          this.emitDelta({ messageId, text, channel: 'reasoning', ...(reset ? { reset } : {}) });
          return;
        }
        break;
      }
      case 'message.delta': {
        const messageId = String(event.data.messageId);
        const text = String(event.data.text);
        if (this.state.liveMessage?.id === messageId) {
          // Keep the snapshot accurate for anyone reading it, but deliver the text through the
          // delta channel and return without publishing: a full snapshot per token is what made
          // streaming expensive, and nothing structural changed.
          this.state.liveMessage.text += text;
          this.emitDelta({ messageId, text });
          return;
        }
        break;
      }
      case 'message.finished':
        if (this.state.liveMessage?.id === event.data.messageId) {
          this.state.messages.push(structuredClone(event.data.message as Message));
          this.state.messageRevision++;
          this.state.liveMessage = null;
        }
        break;
      case 'tool.started':
        this.state.tools.push(structuredClone(event.data.call as ToolCall));
        break;
      case 'tool.finished':
        this.state.tools = this.state.tools.filter((call) => call.id !== event.data.callId);
        this.state.approvals = this.state.approvals.filter(
          (item) => item.approval.toolCall.id !== event.data.callId,
        );
        // A question whose call has finished is no longer answerable — the wait ended, most likely by
        // timing out — so the panel has to go with it rather than invite an answer nobody will read.
        this.state.questions = this.state.questions.filter(
          (item) => item.request.callId !== event.data.callId,
        );
        this.state.messages.push({
          role: 'tool',
          toolCallId: String(event.data.callId),
          content: String(event.data.content),
          isError: event.data.isError === true,
          ...(event.data.change
            ? {
                change: structuredClone(
                  event.data.change as import('../protocol/index.ts').FileChange,
                ),
              }
            : {}),
          /**
           * The structured payload and its renderer name, when the tool declared an output contract.
           *
           * Carried on the message rather than looked up from the tool catalogue, because no method ships that
           * catalogue to a carrier and a message has to be readable on its own: a window folding a session out
           * of the log sees results from runs whose tools an extension may since have unregistered, and a card
           * that needed the declaration to draw a two-minute-old result would draw nothing after a reload. The
           * event already carries it — the run emits the whole result — so this is the projection's job and
           * nothing upstream needs to know about it.
           *
           * The name is not re-checked against the closed set here. A client that dropped a name it did not
           * recognise would turn a defect in a tool into a missing feature in the interface, and afterwards the
           * two are indistinguishable; the set is enforced where names are written (the `ToolRenderer` type,
           * plus the test that reads every declaration back), and a carrier that meets an unknown name falls
           * back to the text it already has — which is also what it does when `output` is absent.
           */
          ...(event.data.output
            ? { output: structuredClone(event.data.output as ToolResultOutput) }
            : {}),
        });
        this.state.messageRevision++;
        break;
      case 'approval.required':
        this.state.approvals.push({
          id: String(event.data.approvalId),
          approval: structuredClone(event.data.approval as Approval),
        });
        break;
      case 'question.required':
        this.state.questions.push({
          id: String(event.data.questionId),
          request: structuredClone(event.data.request as QuestionRequest),
        });
        break;
      case 'todo.written':
        // The event carries the whole list, so the client never has to merge deltas or re-read the session
        // to find out what the model dropped. The change is computed against the list the previous write left
        // here — the same function the store's fold uses, so a reload and a live update say the same thing.
        this.state.todoChange = todoDiff(this.state.todos, (event.data.todos as TodoItem[]) ?? []);
        this.state.todos = structuredClone((event.data.todos as TodoItem[]) ?? []);
        break;
      case 'plan.proposed': {
        this.state.plan = event.data.plan as Plan;
        break;
      }
      case 'deliverable.presented':
        // The fold, not a merge: the event carries the whole list this run has presented, and `presentFiles` is
        // the same function the store's projection uses, so a live window and a reloaded one agree.
        this.state.deliverables = presentFiles(
          this.state.deliverables,
          event.data.files as PresentedFile[],
        );
        break;
      case 'goal.changed':
        // Every change — create, edit, pause, resume, complete, block, and the round a run is admitted to —
        // carries the whole goal, so the panel is a replacement and never a patch.
        this.state.goal = structuredClone(event.data.goal as Goal);
        break;
      case 'plan.approved':
        // The approval is the human's answer, and the plan row is the durable record; the panel reads the same
        // status here so it stops offering a decision that has been made.
        if (this.state.plan) this.state.plan = { ...this.state.plan, status: 'approved' };
        break;
      case 'subagent.started': {
        this.state.subagents.push({
          id: String(event.data.id),
          index: Number(event.data.index),
          total: Number(event.data.total),
          role: event.data.role as SubAgentRole,
          objective: String(event.data.objective),
          childSessionId: String(event.data.childSessionId),
          status: 'running',
          rounds: 0,
          toolCalls: 0,
          // The clock starts with the child's first frame rather than here: this event says a session exists,
          // and the turn it will run has not begun. A row that ticked from this moment would count the
          // provider setup as work.
          durationMs: 0,
          runningSince: null,
          text: '',
        });
        break;
      }
      case 'subagent.delta': {
        const view = this.subagents().find((entry) => entry.id === event.data.id);
        if (!view) break;
        // Same contract as streamed assistant text: keep the snapshot accurate, deliver the slice on
        // the delta channel, and skip the publish — a child streams for as long as it runs.
        const text = String(event.data.text);
        view.text += text;
        this.emitSubAgentDelta({ id: view.id, text });
        return;
      }
      case 'subagent.tool': {
        const view = this.subagents().find((entry) => entry.id === event.data.id);
        if (!view) break;
        if (event.data.phase === 'started') {
          view.tool = String(event.data.name);
          if (typeof event.data.args === 'string' && event.data.args)
            view.toolArgs = event.data.args;
        } else {
          view.tool = undefined;
          view.toolArgs = undefined;
          view.toolCalls++;
        }
        break;
      }
      case 'subagent.progress': {
        const view = this.subagents().find((entry) => entry.id === event.data.id);
        if (!view) break;
        // Same contract as the streamed text: keep the snapshot accurate and deliver the numbers on the
        // delta channel, because a working child reports them once a second and a full snapshot per second
        // would copy the whole session — every message and every attached image — for two rows of a table.
        view.durationMs = Number(event.data.durationMs ?? view.durationMs ?? 0);
        view.runningSince =
          event.data.runningSince === null || event.data.runningSince === undefined
            ? null
            : Number(event.data.runningSince);
        if (event.data.usage) view.usage = event.data.usage as Usage;
        this.emitSubAgentDelta({
          id: view.id,
          durationMs: view.durationMs,
          runningSince: view.runningSince,
          ...(view.usage ? { usage: view.usage } : {}),
        });
        return;
      }
      case 'subagent.finished': {
        const view = this.subagents().find((entry) => entry.id === event.data.id);
        if (!view) break;
        view.status = event.data.status as SubAgentView['status'];
        view.rounds = Number(event.data.rounds ?? view.rounds);
        view.toolCalls = Number(event.data.toolCalls ?? view.toolCalls);
        if (event.data.usage) view.usage = event.data.usage as Usage;
        // The turn's clock has stopped: the settled total the host read out of the child's log is what the
        // card keeps, and it must not be re-derived from a `runningSince` that outlived its own turn.
        view.durationMs = Number(event.data.durationMs ?? view.durationMs ?? 0);
        view.runningSince = null;
        view.tool = undefined;
        view.toolArgs = undefined;
        if (event.data.report) view.report = event.data.report as SubAgentSummaryReport;
        if (typeof event.data.text === 'string' && event.data.text) view.text = event.data.text;
        if (typeof event.data.error === 'string' && event.data.error) view.error = event.data.error;
        break;
      }
      case 'run.finished': {
        const result = event.data.result as RunResult;
        if (result.statistics)
          this.state.statistics = addStatistics(this.statisticsBase, result.statistics);
        this.state.status = result.status;
        this.state.error = result.error ?? null;
        this.clearLive();
        this.state.loading = true;
        void this.refreshFinishedHistory(event.sessionId, event.runId);
        break;
      }
    }
    this.publish();
  }
}
