import type {
  AgentEvent,
  Approval,
  Message,
  Plan,
  QuestionAnswer,
  QuestionRequest,
  RunResult,
  ToolCall,
  ImageAttachment,
} from '../protocol/index.ts';
import type { AgentHostClient } from './host-client.ts';
import { readDisplayHistory } from './display-history.ts';
import { deepFreeze } from './freeze.ts';
import { approvalKey } from './approval-key.ts';
import type { InputMode, QueuedInput } from '../core/run-queue.ts';
import { validateUserInput } from '../protocol/images.ts';
import type {
  CompletionRepairPolicy,
  CompletionSpec,
  PlanVerification,
  RunVerification,
} from '../protocol/completion.ts';
import { isTodoItem } from '../protocol/index.ts';
import { emptyStatistics, addStatistics, type SessionStatistics } from '../protocol/statistics.ts';
import { todoDiff } from '../protocol/todos.ts';
import { isPresentedFile, presentFiles } from '../protocol/deliverables.ts';
import { isGoal } from '../protocol/goals.ts';
import {
  readCompletion,
  readDeliverables,
  readGoal,
  readPlan,
  readSubAgents,
  readTodos,
  readWorkspaceViews,
} from './session-history.ts';
import {
  foldCompletion,
  foldForecast,
  foldSubAgentFinished,
  foldSubAgentProgress,
  foldSubAgentTool,
  foldSubAgentWorkspaceProgress,
  startedSubAgent,
  subAgentWorkspace,
  toolResultMessage,
} from './session-event-fold.ts';

/** The newest page a run-end sync reads; a run that added more than this falls back to the full window read. */
const INCREMENTAL_TAIL = 100;
import type {
  MessageDelta,
  OtherRun,
  PendingApproval,
  PendingQuestion,
  SessionSnapshot,
  StatisticsDelta,
  SubAgentDelta,
  SubAgentView,
} from './session-view.ts';
/** The completion fields a run request carries to the host, exactly as `run.start` names them. */
type RunContract =
  | { completion: CompletionSpec; completionRepairPolicy?: CompletionRepairPolicy }
  | { resumeCompletionId: string; completionRepairPolicy?: CompletionRepairPolicy };

export type {
  ContextBudgetView,
  MessageDelta,
  OtherRun,
  PendingApproval,
  PendingQuestion,
  SessionSnapshot,
  StatisticsDelta,
  SubAgentDelta,
  SubAgentView,
} from './session-view.ts';

/** The frozen copy of `value` held in `cache`, made the first time it is asked for. */
function frozenCopy<T extends object>(cache: WeakMap<T, T>, value: T): T {
  let frozen = cache.get(value);
  if (!frozen) {
    frozen = deepFreeze(structuredClone(value));
    cache.set(value, frozen);
  }
  return frozen;
}
/**
 * `client`, with every request it makes tied to `signal`, for helpers that take a client and know nothing about
 * cancellation. Everything else on the client is the client's own.
 */
function scopedClient(client: AgentHostClient, signal: AbortSignal): AgentHostClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'request')
        return (method: Parameters<AgentHostClient['request']>[0], params: never) =>
          target.request(method, params, { signal });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
    completion: null,
    running: false,
    loading: false,
    status: 'idle',
    tools: [],
    approvals: [],
    questions: [],
    error: null,
  };
  private listeners = new Set<(state: SessionSnapshot) => void>();
  private changeListeners = new Set<() => void>();
  private stateRevision = 0;
  private deltaListeners = new Set<(delta: MessageDelta) => void>();
  private subagentDeltaListeners = new Set<(delta: SubAgentDelta) => void>();
  private statisticsDeltaListeners = new Set<(delta: StatisticsDelta) => void>();
  private unsubscribe: () => void;
  private unsubscribeStatus: () => void;
  private disposed = false;
  private runId: string | null = null;
  /** The send this controller is waiting on for the session on screen. */
  private active: Promise<RunResult> | null = null;
  private aborter: AbortController | null = null;
  /**
   * Sends that were started here and are still settling, though their session is no longer on screen.
   *
   * Opening another session does not stop a run: the Host keeps it going, and the request that started it keeps
   * waiting for its result. Its aborter is kept only so `dispose` can still release the request.
   */
  private detached = new Set<AbortController>();
  /** Live runs of sessions other than the one on screen, keyed by session; see `SessionSnapshot.otherRuns`. */
  private others = new Map<string, OtherRun>();
  private olderLoad: symbol | null = null;
  /**
   * Where the transcript in `state.messages` stops being the Host's: the offset just past the last message a
   * history read put there. Messages after it are this controller's own (an optimistic bubble, live output) and
   * are replaced by the next read; messages before it are the Host's and, the transcript being append-only, stay
   * true. That is what lets a run's end read only what the run added. See `history`.
   */
  private committed: { sessionId: string; end: number } | null = null;
  /** Which session read is the current one; see `staleRead`. */
  private loadGeneration = 0;
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
  /** Frozen copies of messages already handed out by `frozenSnapshot`, keyed by this controller's own object. */
  private frozenMessages = new WeakMap<Message, Message>();
  /** The same for sub-agent cards, which are edited in place: `editSubAgent` drops a card's copy before an edit. */
  private frozenSubAgents = new WeakMap<SubAgentView, SubAgentView>();
  /**
   * The same state as `snapshot`, frozen, with every message shared with the previous call's view.
   *
   * A message is never edited once it is in `state.messages` — reads replace the array, events push to it — so
   * the copy made the first time it was handed out stays right. Cloning the whole transcript (base64 images
   * included) for every tool call was what a long session paid per publish; this clones only what is new, and a
   * consumer can tell an unchanged prefix by reference.
   */
  get frozenSnapshot(): Readonly<SessionSnapshot> {
    const { messages, subagents, ...rest } = this.state;
    const view = structuredClone(rest) as SessionSnapshot;
    view.messages = messages.map((message) => frozenCopy(this.frozenMessages, message));
    // A child that streams for minutes grows its card's text; a card left alone is not copied again for it.
    view.subagents = subagents.map((card) => frozenCopy(this.frozenSubAgents, card));
    return deepFreeze(view);
  }
  /*
   * Scalar reads that do not clone. `snapshot` deep-copies every message (base64 images included), so a caller
   * that only needs to know which session is open, or whether it is busy, must not pay for the whole state —
   * the carrier asks these on every Host event, streamed tokens included.
   */
  /**
   * Moves whenever the state may have changed: on every publish, every delta, and every Host event this
   * controller looks at. Equal revisions mean an earlier `snapshot` is still the current one, so a consumer that
   * keeps one (the carrier) need not clone the whole state again to say the same thing.
   */
  get revision(): number {
    return this.stateRevision;
  }
  get sessionId(): string | null {
    return this.state.sessionId;
  }
  get running(): boolean {
    return this.state.running;
  }
  get loading(): boolean {
    return this.state.loading;
  }
  /** A copy of the one live sub-agent card that matches, without cloning the rest of the state. */
  findSubAgent(match: (entry: Readonly<SubAgentView>) => boolean): SubAgentView | undefined {
    const found = this.state.subagents.find(match);
    return found ? structuredClone(found) : undefined;
  }
  subscribe(listener: (state: SessionSnapshot) => void): () => void {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  /**
   * Told that the state changed, without being handed a copy of it.
   *
   * For a consumer that builds its own view from `snapshot` (the carrier): `subscribe` clones the whole state per
   * listener per change, and such a consumer would throw that copy away and clone again.
   */
  subscribeChanges(listener: () => void): () => void {
    this.assertActive();
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
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
    this.stateRevision++;
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
    this.stateRevision++;
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
    this.stateRevision++;
    for (const listener of this.statisticsDeltaListeners) {
      try {
        listener(delta);
      } catch {
        /* A consumer's error must not interrupt the stream. */
      }
    }
  }
  /**
   * The card that matches, about to be edited in place: its frozen copy is dropped so the next `frozenSnapshot`
   * copies it again. Every edit of a card goes through here; the cards nobody touched stay shared.
   */
  private editSubAgent(match: (entry: SubAgentView) => boolean): SubAgentView | undefined {
    const view = this.state.subagents.find(match);
    if (view) this.frozenSubAgents.delete(view);
    return view;
  }
  private publish(): void {
    this.stateRevision++;
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* UI errors must not stall run cleanup. */
      }
    }
    for (const listener of this.changeListeners) {
      try {
        listener();
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
  /**
   * Switching sessions only has to wait for a read in progress, not for a run.
   *
   * The run of the session being left goes on in the Host; this controller stops showing it and keeps following
   * it as one of `otherRuns`, so its approvals and questions are still there when the session is opened again.
   */
  private assertCanSwitch(): void {
    this.assertActive();
    if (this.state.loading) throw new Error('Session is already loading');
    this.detachForeground();
  }
  private detachForeground(): void {
    const sessionId = this.state.sessionId;
    if (this.aborter && this.active) this.detached.add(this.aborter);
    this.active = null;
    this.aborter = null;
    if (!sessionId || !this.state.running || !this.runId) return;
    this.others.set(sessionId, {
      sessionId,
      runId: this.runId,
      approvals: structuredClone(this.state.approvals),
      questions: structuredClone(this.state.questions),
    });
  }
  private publishOthers(): void {
    this.state.otherRuns = structuredClone([...this.others.values()]);
  }
  async create(): Promise<string> {
    this.assertCanSwitch();
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
    this.assertCanSwitch();
    this.state.loading = true;
    this.publish();
    try {
      await this.read(sessionId);
    } finally {
      this.state.loading = false;
      this.publish();
    }
  }
  /**
   * The transcript window to show, read from the Host.
   *
   * `incremental` is the run-end sync: the transcript is append-only (the fold only ever pushes), so the part this
   * controller already holds up to `committed.end` is still right, and only the newest page has to be read. When
   * that page does not reach back to `committed.end` (a run that added more than a page), or anything about the
   * window looks inconsistent, the full read below is the answer instead — a guess is never kept.
   */
  private async history(
    sessionId: string,
    incremental = false,
    client: AgentHostClient = this.client,
  ): Promise<{
    messages: Message[];
    providerDegraded: boolean | undefined;
    runEndings: readonly import('../protocol/run-cancellation.ts').RunEnding[] | undefined;
    statistics: SessionStatistics;
    historyStart: number;
    /** The run the session had active when the transcript was read, when the Host says. */
    activeRun: string | null | undefined;
  }> {
    const base = this.state.historyStart;
    const known =
      incremental &&
      this.committed?.sessionId === sessionId &&
      this.state.sessionId === sessionId &&
      base !== undefined
        ? this.committed.end
        : null;
    if (known !== null && base !== undefined) {
      const page = await readDisplayHistory(client, sessionId, Infinity, 0, {
        tail: INCREMENTAL_TAIL,
      });
      const start = page.startOffset;
      const end = start + page.messages.length;
      const keep = known - base;
      if (
        start <= known &&
        end >= known &&
        keep >= 0 &&
        keep <= this.state.messages.length &&
        this.state.sessionId === sessionId &&
        this.state.historyStart === base
      )
        return {
          messages:
            start <= base
              ? page.messages
              : [...this.state.messages.slice(0, keep), ...page.messages.slice(known - start)],
          statistics: page.statistics ?? emptyStatistics(),
          historyStart: Math.min(start, base),
          activeRun: page.activeRun,
          providerDegraded: page.providerDegraded,
          runEndings: page.runEndings,
        };
    }
    const tail = Math.max(100, this.state.sessionId === sessionId ? this.state.messages.length : 0);
    const history = await readDisplayHistory(client, sessionId, Infinity, 0, { tail });
    return {
      messages: history.messages,
      statistics: history.statistics ?? emptyStatistics(),
      historyStart: history.startOffset,
      activeRun: history.activeRun,
      providerDegraded: history.providerDegraded,
      runEndings: history.runEndings,
    };
  }
  /** Put a history read on screen, and remember how much of it is the Host's. */
  private applyTranscript(
    sessionId: string,
    transcript: {
      messages: Message[];
      statistics: SessionStatistics;
      historyStart: number;
      providerDegraded?: boolean;
      runEndings?: readonly import('../protocol/run-cancellation.ts').RunEnding[];
    },
  ): void {
    this.state.messages = transcript.messages;
    this.state.runEndings = transcript.runEndings ?? [];
    this.state.providerDegraded = transcript.providerDegraded ?? false;
    this.state.historyStart = transcript.historyStart;
    this.state.messageRevision++;
    this.state.statistics = transcript.statistics;
    this.committed = {
      sessionId,
      end: transcript.historyStart + transcript.messages.length,
    };
  }
  async loadOlder(): Promise<void> {
    this.assertIdle();
    const sessionId = this.state.sessionId;
    const endOffset = this.state.historyStart ?? 0;
    if (!sessionId || endOffset === 0) return;
    const revision = this.state.messageRevision;
    const operation = Symbol('older-history');
    this.olderLoad = operation;
    this.state.loading = true;
    this.publish();
    try {
      const history = await readDisplayHistory(
        this.client,
        sessionId,
        Infinity,
        Math.max(0, endOffset - 100),
        { endOffset },
      );
      if (
        this.disposed ||
        this.olderLoad !== operation ||
        this.state.sessionId !== sessionId ||
        this.state.messageRevision !== revision ||
        this.state.historyStart !== endOffset ||
        this.state.running
      )
        return;
      this.state.messages.unshift(...history.messages);
      this.state.historyStart = history.startOffset;
      this.state.messageRevision++;
    } finally {
      if (this.olderLoad === operation) {
        this.olderLoad = null;
        this.state.loading = false;
      }
      this.publish();
    }
  }
  /**
   * Whether a step of a session read still belongs to the read that is current.
   *
   * A read is a sequence of requests, and every one of them is a place where the read can be overtaken: the
   * controller can be disposed, and a later read of another session can begin. Either way the answer in hand
   * describes a session this controller no longer shows, and writing it would put one session's history under
   * another session's name. The generation is bumped by each read, so an older one's answers are simply dropped.
   */
  private staleRead(generation: number): boolean {
    return this.disposed || generation !== this.loadGeneration;
  }
  /**
   * What the Host says about the session's live run, in one answer.
   *
   * `runId` is the Host's own word for which run holds the session, and it is the identity the live frames carry.
   * An older Host answers without it — and a Host that predates the method answers with an error — so the run
   * named by the session info is the fallback. That fallback is deliberately the *only* other source: a Host
   * that cannot say which run is running does not licence this client to apply whichever run's frame arrives.
   */
  private async runSnapshot(
    sessionId: string,
    client: AgentHostClient = this.client,
  ): Promise<{
    running: boolean;
    items: QueuedInput[];
    runId: string | null;
    /** Whether the Host answered the question at all; a Host that predates it cannot. */
    answered: boolean;
    /** What the live run waits on, when the Host says; `null` from a Host that predates the field. */
    pending: { approvals: PendingApproval[]; questions: PendingQuestion[] } | null;
    /** Where the log stood when the Host answered, when it says (see `noteCursor`). */
    latestSeq?: number;
  }> {
    let reply: unknown;
    try {
      reply = await client.request('run.queue.get', { sessionId });
    } catch (error) {
      // A read that was overtaken is over; it must not carry on as though the Host had no answer.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // No answer at all: nothing is known about a live run from this question, and the session info decides.
      return { running: false, items: [], runId: null, answered: false, pending: null };
    }
    // A reply that is not the answer's shape is no answer: a Host that will not say what it holds cannot be read
    // as holding nothing, and it certainly cannot be read as naming a run.
    if (!reply || typeof reply !== 'object')
      return { running: false, items: [], runId: null, answered: false, pending: null };
    const answer = reply as {
      running?: unknown;
      items?: unknown;
      runId?: unknown;
      pending?: { approvals?: unknown; questions?: unknown };
      latestSeq?: unknown;
    };
    const runId = typeof answer.runId === 'string' && answer.runId ? answer.runId : null;
    return {
      running: answer.running === true,
      items: Array.isArray(answer.items) ? (answer.items as QueuedInput[]) : [],
      runId,
      answered: true,
      pending:
        answer.pending &&
        typeof answer.pending === 'object' &&
        Array.isArray(answer.pending.approvals) &&
        Array.isArray(answer.pending.questions)
          ? {
              approvals: structuredClone(answer.pending.approvals as PendingApproval[]),
              questions: structuredClone(answer.pending.questions as PendingQuestion[]),
            }
          : null,
      ...(Number.isSafeInteger(answer.latestSeq) ? { latestSeq: Number(answer.latestSeq) } : {}),
    };
  }
  /**
   * Read a session from the Host, abandoning whatever read was in flight before it.
   *
   * Opening session B while A is still loading used to leave A's questions running to completion, one after the
   * other, while B's waited behind them. The previous read is aborted here — its requests stop being waited for
   * — and an aborted read ends quietly: it was overtaken, which `staleRead` already treats as a normal ending.
   */
  private async read(sessionId: string): Promise<void> {
    const generation = ++this.loadGeneration;
    this.readAbort?.abort();
    const abort = new AbortController();
    this.readAbort = abort;
    try {
      await this.readSession(sessionId, generation, scopedClient(this.client, abort.signal));
    } catch (error) {
      if (this.staleRead(generation)) return;
      throw error;
    } finally {
      if (this.readAbort === abort) this.readAbort = undefined;
    }
  }
  /** The read in flight, so the next one can abandon it. */
  private readAbort: AbortController | undefined;
  private async readSession(
    sessionId: string,
    generation: number,
    client: AgentHostClient,
  ): Promise<void> {
    this.olderLoad = null;
    /**
     * Everything but the live run, asked at once.
     *
     * These used to be asked one after another — seven round trips before the session appeared — although none
     * of them depends on another's answer. The plan lives outside the message history (a plan proposed in an
     * earlier run is still awaiting a decision after a reload); sub-agent cards are rebuilt from the stored run
     * result; the checklist, deliverables, goal and completion are session state, written during a run but still
     * true after it ends, so a reload has to bring them back from the log.
     */
    const [
      { messages, statistics, historyStart, activeRun, providerDegraded, runEndings },
      plan,
      subagents,
      checklist,
      deliverables,
      goal,
      completion,
    ] = await Promise.all([
      this.history(sessionId, false, client),
      readPlan(client, sessionId),
      readSubAgents(client, sessionId),
      readTodos(client, sessionId),
      readDeliverables(client, sessionId),
      readGoal(client, sessionId),
      readCompletion(client, sessionId),
    ]);
    if (this.staleRead(generation)) return;
    /**
     * The live run is read *last*, after every other query has been answered.
     *
     * It is the one part of a session that moves while the read is running, and the read ends by asking for it
     * so the identity this client adopts is the one the Host holds now rather than the one it held when the
     * transcript was fetched.
     */
    const snapshot = await this.runSnapshot(sessionId, client);
    if (this.staleRead(generation)) return;
    /**
     * A run that ended, or began, while those queries were in flight.
     *
     * The transcript read at the start cannot contain the turn of a run that finished after it: adopting the
     * run's end without re-reading would leave a window showing a session that stopped mid-sentence. The
     * history page says which run was active when it was read, so the two answers are compared — and when they
     * disagree (or the run is gone) the transcript is read once more, which is what makes the state at the end
     * of a read a state that was true at one moment.
     */
    const seenRun = activeRun ?? null;
    /**
     * Whether the session is running, and which run it is.
     *
     * The queue answer is the primary source because it is the one that knows about the live run. A Host that
     * cannot answer it at all leaves the session info as the only witness — and a session info naming an active
     * run is evidence that one holds the session, since that is what the field means and the Host clears it when
     * a run ends. Where the Host names the run, that name wins: it is the identity the frames themselves carry.
     */
    const running = snapshot.answered ? snapshot.running : seenRun !== null;
    const liveRun = running ? (snapshot.runId ?? seenRun) : null;
    const moved = seenRun !== liveRun || (running && liveRun === null);
    let transcript = { messages, statistics, historyStart, providerDegraded, runEndings };
    if (moved) {
      const reread = await this.history(sessionId, false, client);
      if (this.staleRead(generation)) return;
      transcript = reread;
    }
    this.runId = liveRun;
    this.stateRevision++;
    /**
     * What the run is waiting on a person for.
     *
     * The Host's answer is the source when it gives one: approvals and questions otherwise reach a client only as
     * live frames, so a client that opened the session after they were asked — a second window, a reconnect —
     * used to show a running session with nothing to answer while the wait ran out into a denial. A run this
     * client was following in the background is the fallback for a Host that predates the field.
     */
    const followed = this.others.get(sessionId);
    this.others.delete(sessionId);
    const pending = !running
      ? { approvals: [], questions: [] }
      : snapshot.pending
        ? snapshot.pending
        : followed && followed.runId === liveRun
          ? followed
          : { approvals: [], questions: [] };
    this.state = {
      queue: structuredClone(snapshot.items),
      compacting: false,
      budget: null,
      instructions: [],
      sessionId,
      messages: transcript.messages,
      runEndings: transcript.runEndings ?? [],
      providerDegraded: transcript.providerDegraded ?? false,
      historyStart: transcript.historyStart,
      messageRevision: this.state.messageRevision + 1,
      statistics: transcript.statistics,
      runStatistics: null,
      statisticsActivity: null,
      liveMessage: null,
      subagents,
      todos: checklist.todos,
      todoChange: checklist.change,
      plan,
      deliverables,
      goal,
      completion,
      running,
      loading: this.state.loading,
      status: running ? 'running' : 'idle',
      tools: [],
      approvals: pending.approvals,
      questions: pending.questions,
      otherRuns: structuredClone([...this.others.values()]),
      error: null,
    };
    this.committed = {
      sessionId,
      end: transcript.historyStart + transcript.messages.length,
    };
    /**
     * Live frames report a run's own cumulative usage, so the session's stored statistics are what they are added
     * to. A client that watched the run from its start set this when `run.started` arrived; one that opened the
     * session in the middle of it has to set it here, or the first frame it applies would be added to the last
     * session's numbers. The store's statistics count finished runs, so this is the same base either way.
     */
    if (running) this.statisticsBase = structuredClone(transcript.statistics);
    // A re-read ends level with the log, and saying so is what keeps the check in `catchUp` honest: a client
    // that only ever watched frames would consider itself behind after every reload, and re-read forever. The
    // queue answer carries the position when the Host says it, which saves asking `session.events` for it; it was
    // read after everything but a moved run's re-read, so at worst it is behind and the next check re-reads.
    if (snapshot.latestSeq !== undefined && this.canResume())
      this.client.noteCursor(sessionId, snapshot.latestSeq);
    else await this.noteCursor(sessionId);
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
  /** Re-reads the plan after an approval decision so the panel reflects the new status. */
  async refreshPlan(): Promise<void> {
    this.assertActive();
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    this.state.plan = await readPlan(this.client, sessionId);
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
  /**
   * Executes an approved plan; the host re-checks the approval and the body digest.
   *
   * With `verification` the run is judged against the plan's own steps plus the checks a person added, so its end
   * can be `verified` rather than only `completed`. The steps are restated from the plan the window shows, and the
   * host refuses them unless they are the approved ones byte for byte — a stale panel cannot run a different plan.
   */
  async executePlan(planId: string, verification?: PlanVerification): Promise<RunResult> {
    this.assertActive();
    const plan = this.state.plan;
    let contract: RunContract | undefined;
    if (verification) {
      if (!plan || plan.id !== planId)
        throw new Error('The plan to verify is not the one this session shows');
      contract = {
        completion: {
          version: 1,
          objective: plan.title,
          constraints: verification.constraints ?? [],
          steps: plan.steps.map((step, index) => ({
            id: `plan:${plan.id}:${String(index)}`,
            description: step.description,
            status: 'pending' as const,
          })),
          acceptance: verification.acceptance.map((item) => ({ ...item, met: false })),
          inputs: verification.inputs ?? [],
        },
        ...(verification.repairPolicy ? { completionRepairPolicy: verification.repairPolicy } : {}),
      };
    }
    return this.sendInternal(
      plan?.title || 'Execute the approved plan',
      undefined,
      undefined,
      { planId },
      contract,
    );
  }
  /**
   * Sends a request. `verification` turns it into a run with a completion contract — stated here, or the session's
   * recorded one resumed — while an omitted one keeps the ordinary chat turn, which is never reported as verified.
   */
  async send(
    prompt: string,
    images?: ImageAttachment[],
    taskId?: string,
    verification?: RunVerification,
  ): Promise<RunResult> {
    if (verification && taskId)
      throw new Error('A task already carries the acceptance definition for this run');
    const contract: RunContract | undefined = verification
      ? {
          ...('completion' in verification
            ? { completion: verification.completion }
            : { resumeCompletionId: verification.resumeCompletionId }),
          ...(verification.repairPolicy
            ? { completionRepairPolicy: verification.repairPolicy }
            : {}),
        }
      : undefined;
    return this.sendInternal(prompt, images, taskId, undefined, contract);
  }
  private async sendInternal(
    prompt: string,
    images?: ImageAttachment[],
    taskId?: string,
    plan?: { phase: 'plan' } | { planId: string },
    contract?: RunContract,
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
    const aborter = this.aborter;
    const pending = this.performSend(
      this.state.sessionId,
      prompt,
      aborter.signal,
      input.images,
      taskId,
      plan,
      contract,
    );
    this.active = pending;
    try {
      return await pending;
    } finally {
      this.detached.delete(aborter);
      // A send whose session was left settles without touching the session now on screen.
      if (this.active === pending) {
        this.active = null;
        this.aborter = null;
        if (!this.state.running && this.runId)
          await this.refreshFinishedHistory(this.state.sessionId!, this.runId);
        if (!this.runId && !this.state.running) this.state.loading = false;
        this.publish();
      }
    }
  }
  private async performSend(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    images?: ImageAttachment[],
    taskId?: string,
    plan?: { phase: 'plan' } | { planId: string },
    contract?: RunContract,
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
        ...(contract ?? {}),
      });
      ownedRunId = result.runId;
      if (owns()) {
        this.state.status = result.status;
        this.state.error = result.error ?? null;
      }
      // A session that was left is read again when it is opened; reading it now would only be thrown away.
      if (!this.disposed && this.client.status === 'ready' && this.state.sessionId === sessionId) {
        const transcript = await this.history(sessionId, true);
        const workspaces = owns()
          ? await readWorkspaceViews(
              this.client,
              sessionId,
              this.state.subagents.map((child) => child.childSessionId ?? ''),
            )
          : new Map();
        if (owns()) {
          this.applyTranscript(sessionId, transcript);
          this.refreshWorkspaceViews(workspaces);
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
      if (!this.disposed && this.client.status === 'ready' && this.state.sessionId === sessionId) {
        try {
          const transcript = await this.history(sessionId);
          if (owns()) this.applyTranscript(sessionId, transcript);
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
  async approve(id: string, allow: boolean, remember = false): Promise<void> {
    this.assertActive();
    const pending = this.state.approvals.find((item) => item.id === id);
    if (!pending) throw new Error('Approval is no longer pending');
    // Remembered before responding: a later identical request may arrive while this answer is in flight.
    if (allow && remember) this.rememberApproval(pending.approval);
    /*
     * Identical requests already waiting are one decision. Parallel calls (the same test command in two
     * branches, a verification check behind a manual run) used to stack as separate cards that a person had to
     * answer one by one with the same click; the window draws them as one card with a count, and the answer
     * given to it is the answer to every copy. Only exact matches are folded (`approvalKey`).
     */
    const key = approvalKey(pending.approval);
    const answered = [
      pending,
      ...this.state.approvals.filter(
        (item) => item.id !== id && approvalKey(item.approval) === key,
      ),
    ];
    for (const item of answered)
      await this.client.request('approval.respond', { approvalId: item.id, allow });
    const settled = new Set(answered.map((item) => item.id));
    this.state.approvals = this.state.approvals.filter((item) => !settled.has(item.id));
    this.publish();
  }
  /**
   * The approvals a person allowed for the rest of this session, per session, by exact tool call.
   *
   * Keyed by the call's name and arguments rather than by its tool or command family: a remembered `npm test`
   * must not also allow `npm publish`, and byte-for-byte comparison is the only rule that keeps that promise
   * without a second parser for command lines.
   */
  private remembered = new Map<string, Set<string>>();
  private rememberApproval(approval: Approval): void {
    const key = approvalKey(approval);
    const session = this.state.sessionId ?? '';
    const remembered = this.remembered.get(session) ?? new Set<string>();
    remembered.add(key);
    this.remembered.set(session, remembered);
  }
  private isRemembered(approval: Approval): boolean {
    return this.remembered.get(this.state.sessionId ?? '')?.has(approvalKey(approval)) === true;
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
    for (const aborter of this.detached) aborter.abort();
    this.detached.clear();
    this.unsubscribe();
    this.unsubscribeStatus();
    this.listeners.clear();
    this.changeListeners.clear();
    this.deltaListeners.clear();
    this.subagentDeltaListeners.clear();
    this.statisticsDeltaListeners.clear();
  }
  private clearLive(): void {
    this.stateRevision++;
    this.state.statisticsActivity = null;
    this.state.queue = [];
    this.state.compacting = false;
    this.state.running = false;
    this.state.liveMessage = null;
    this.state.tools = [];
    this.state.approvals = [];
    this.state.questions = [];
  }
  private refreshWorkspaceViews(
    workspaces: Map<string, NonNullable<SubAgentView['workspace']>>,
  ): void {
    for (const child of this.state.subagents) {
      const workspace = child.childSessionId ? workspaces.get(child.childSessionId) : undefined;
      if (!workspace) continue;
      this.frozenSubAgents.delete(child);
      child.workspace = workspace;
    }
  }
  private async refreshFinishedHistory(sessionId: string, finishedRun: string): Promise<void> {
    const owns = () =>
      this.state.sessionId === sessionId && this.runId === finishedRun && !this.state.running;
    try {
      const transcript = await this.history(sessionId, true);
      if (this.disposed || !owns()) return;
      const workspaces = await readWorkspaceViews(
        this.client,
        sessionId,
        this.state.subagents.map((child) => child.childSessionId ?? ''),
      );
      if (this.disposed || !owns()) return;
      this.applyTranscript(sessionId, transcript);
      this.refreshWorkspaceViews(workspaces);
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
  /**
   * Follow the runs of sessions that are not on screen: when they start and end, and what they wait on.
   *
   * Only those facts. A turn of another session is never folded here: the transcript of a session opened later
   * is read from the Host, which is the only source of it.
   */
  private onOtherEvent(event: AgentEvent): void {
    const sessionId = event.sessionId;
    const run = this.others.get(sessionId);
    switch (event.type) {
      case 'run.started':
        this.others.set(sessionId, { sessionId, runId: event.runId, approvals: [], questions: [] });
        break;
      case 'run.finished':
        if (!run || run.runId !== event.runId) return;
        this.others.delete(sessionId);
        break;
      case 'approval.required':
        if (!run || run.runId !== event.runId) return;
        run.approvals.push({
          id: String(event.data.approvalId),
          approval: structuredClone(event.data.approval as Approval),
        });
        break;
      case 'question.required':
        if (!run || run.runId !== event.runId) return;
        run.questions.push({
          id: String(event.data.questionId),
          request: structuredClone(event.data.request as QuestionRequest),
        });
        break;
      case 'approval.decided':
      case 'question.answered':
      case 'tool.finished': {
        if (!run || run.runId !== event.runId) return;
        const callId =
          event.type === 'tool.finished'
            ? event.data.callId
            : event.type === 'approval.decided'
              ? (event.data.approval as Approval | undefined)?.toolCall?.id
              : (event.data.request as QuestionRequest | undefined)?.callId;
        const approvals = run.approvals.filter((item) => item.approval.toolCall.id !== callId);
        const questions = run.questions.filter((item) => item.request.callId !== callId);
        if (approvals.length === run.approvals.length && questions.length === run.questions.length)
          return;
        run.approvals = approvals;
        run.questions = questions;
        break;
      }
      default:
        return;
    }
    this.stateRevision++;
    this.publishOthers();
    this.publish();
  }
  private onEvent(event: AgentEvent): void {
    if (this.disposed) return;
    if (event.sessionId !== this.state.sessionId) {
      this.onOtherEvent(event);
      return;
    }
    this.stateRevision++;
    if (event.type === 'run.started') {
      this.state.providerDegraded = false;
      this.olderLoad = null;
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
    /**
     * A frame is applied only when it belongs to the run this client is watching.
     *
     * The one exception is the end of a run whose identity the client never learned: a Host too old to name the
     * run it holds leaves a session that is running with no id to compare against, and refusing its `run.finished`
     * would leave the window saying "running" for as long as it stayed open. Ending is safe to apply without the
     * identity — it clears the live state and re-reads the transcript from the log, which is authoritative
     * whatever the frame's run turned out to be — where applying a *turn* from an unidentified run would mix
     * another run's words into this session's transcript.
     */
    if (event.runId !== this.runId && !(this.runId === null && event.type === 'run.finished'))
      return;
    if (event.data.statistics) {
      this.state.statistics = addStatistics(
        this.statisticsBase,
        event.data.statistics as SessionStatistics,
      );
      this.state.runStatistics = event.data.statistics as SessionStatistics;
      this.state.statisticsActivity = event.data.activity as SessionSnapshot['statisticsActivity'];
    }
    switch (event.type) {
      case 'provider.degraded':
        this.state.providerDegraded = true;
        break;
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
          runStatistics: this.state.runStatistics ?? null,
          activity: this.state.statisticsActivity,
        });
        return;
      case 'context.compacted':
        this.state.compacting = false;
        break;
      /**
       * A compaction that failed leaves the previous summary in force: the run carries on with the context it
       * had, and the failure carries the reason (and the count that summary covered) but no usage. So the only
       * thing the client owes it is to stop saying the window is being compacted — there is no new summary to
       * fetch and no transcript to change.
       */
      case 'context.compaction.failed':
        this.state.compacting = false;
        break;
      case 'context.forecast':
        this.state.budget = foldForecast(event.data);
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
        this.state.messages.push(toolResultMessage(event.data));
        this.state.messageRevision++;
        break;
      case 'approval.required': {
        const approval = structuredClone(event.data.approval as Approval);
        const approvalId = String(event.data.approvalId);
        /*
         * A request the person already allowed for this session is answered here, without a second card.
         *
         * This is the same decision they made, not a new one: the key is the exact tool call, so a different
         * command still asks. If the answer cannot be delivered the card comes back rather than the request
         * disappearing — a silent drop would leave the run waiting on an approval nobody can see.
         */
        if (this.isRemembered(approval)) {
          void this.client.request('approval.respond', { approvalId, allow: true }).catch(() => {
            this.state.approvals.push({ id: approvalId, approval });
            this.publish();
          });
          break;
        }
        this.state.approvals.push({ id: approvalId, approval });
        break;
      }
      case 'question.required':
        this.state.questions.push({
          id: String(event.data.questionId),
          request: structuredClone(event.data.request as QuestionRequest),
        });
        break;
      case 'todo.written': {
        // The event carries the whole list, so the client never has to merge deltas or re-read the session
        // to find out what the model dropped. The change is computed against the list the previous write left
        // here — the same function the store's fold uses, so a reload and a live update say the same thing.
        if (!Array.isArray(event.data.todos)) break;
        const todos = event.data.todos.filter(isTodoItem);
        this.state.todoChange = todoDiff(this.state.todos, todos);
        this.state.todos = structuredClone(todos);
        break;
      }
      case 'plan.proposed': {
        this.state.plan = event.data.plan as Plan;
        break;
      }
      case 'deliverable.presented':
        // The fold, not a merge: the event carries the whole list this run has presented, and `presentFiles` is
        // the same function the store's projection uses, so a live window and a reloaded one agree.
        if (!Array.isArray(event.data.files)) break;
        this.state.deliverables = presentFiles(
          this.state.deliverables,
          event.data.files.filter(isPresentedFile),
        );
        break;
      case 'goal.changed':
        // Every change — create, edit, pause, resume, complete, block, and the round a run is admitted to —
        // carries the whole goal, so the panel is a replacement and never a patch.
        if (isGoal(event.data.goal)) this.state.goal = structuredClone(event.data.goal);
        break;
      case 'completion.updated': {
        const completion = foldCompletion(this.state.completion, event, this.state.sessionId);
        if (completion) this.state.completion = completion;
        break;
      }
      case 'plan.approved':
        // The approval is the human's answer, and the plan row is the durable record; the panel reads the same
        // status here so it stops offering a decision that has been made.
        if (this.state.plan) this.state.plan = { ...this.state.plan, status: 'approved' };
        break;
      case 'subagent.started': {
        this.state.subagents.push(startedSubAgent(event.data));
        break;
      }
      case 'subagent.delta': {
        const view = this.editSubAgent((entry) => entry.id === event.data.id);
        if (!view) break;
        // Same contract as streamed assistant text: keep the snapshot accurate, deliver the slice on
        // the delta channel, and skip the publish — a child streams for as long as it runs.
        const text = String(event.data.text);
        view.text += text;
        this.emitSubAgentDelta({ id: view.id, text });
        return;
      }
      case 'subagent.tool': {
        const view = this.editSubAgent((entry) => entry.id === event.data.id);
        if (!view) break;
        foldSubAgentTool(view, event.data);
        break;
      }
      case 'subagent.progress': {
        const view = this.editSubAgent((entry) => entry.id === event.data.id);
        if (!view) break;
        // Same contract as the streamed text: keep the snapshot accurate and deliver the numbers on the
        // delta channel, because a working child reports them once a second and a full snapshot per second
        // would copy the whole session — every message and every attached image — for two rows of a table.
        foldSubAgentProgress(view, event.data);
        this.emitSubAgentDelta({
          id: view.id,
          durationMs: view.durationMs,
          runningSince: view.runningSince,
          ...(view.usage ? { usage: view.usage } : {}),
        });
        return;
      }
      case 'subagent.workspace.progress': {
        const view = this.editSubAgent(
          (entry) =>
            entry.id === String(event.data.id) ||
            entry.childSessionId === String(event.data.childSessionId),
        );
        if (!view) break;
        foldSubAgentWorkspaceProgress(view, event.data);
        if (view.workspaceProgress)
          this.emitSubAgentDelta({ id: view.id, workspaceProgress: view.workspaceProgress });
        return;
      }
      case 'subagent.workspace': {
        /**
         * Where this child worked, and what it produced.
         *
         * The live card is built from the child's own frames, and this is the one fact those frames cannot carry: the
         * directory is a decision of the *parent's* workspace service, and the result exists only once the turn has
         * ended and been frozen. It arrives as its own frame for the same reason — see the event's own note.
         *
         * A card that has not appeared yet is not an error worth reporting: a frame can outrun the `started` frame it
         * belongs to when a child finishes fast, and the durable read after the run is what fills the card in then.
         */
        const view = this.editSubAgent(
          (entry) =>
            entry.id === String(event.data.id) ||
            entry.childSessionId === String(event.data.childSessionId),
        );
        if (!view) break;
        view.workspace = subAgentWorkspace(event.data);
        delete view.workspaceProgress;
        break;
      }
      case 'subagent.finished': {
        const view = this.editSubAgent((entry) => entry.id === event.data.id);
        if (!view) break;
        foldSubAgentFinished(view, event.data);
        break;
      }
      case 'run.finished': {
        const result = event.data.result as RunResult;
        if (result.statistics) {
          this.state.statistics = addStatistics(this.statisticsBase, result.statistics);
          this.state.runStatistics = result.statistics;
        }
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
