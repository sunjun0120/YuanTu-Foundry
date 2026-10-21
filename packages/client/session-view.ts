/** The view a session controller publishes: snapshot, pending interactions, sub-agent cards and live deltas. */
import type { ContextBreakdown } from '../core/budget.ts';
import type { QueuedInput } from '../core/run-queue.ts';
import type { CompletionRecord } from '../protocol/completion.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Goal } from '../protocol/goals.ts';
import type {
  Approval,
  Message,
  Plan,
  QuestionRequest,
  RunStatus,
  SubAgentRole,
  SubAgentSummaryReport,
  SubAgentTaskStatus,
  TodoItem,
  ToolCall,
  Usage,
} from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { TodoChange } from '../protocol/todos.ts';

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
 * and deciding whether this build's `IGNORABLE_SESSION_EVENTS` may skip it. Older builds still refuse event
 * types absent from their own allowlist, so that is a compatibility change the display half does not need.
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

/** A run of a session that is not the one on screen; see `SessionSnapshot.otherRuns`. */
export interface OtherRun {
  sessionId: string;
  runId: string;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
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
  /**
   * How far the child's result export has got, while it is exporting.
   *
   * The first export walks the whole working tree; this is the only number that moves until it is done. Absent
   * once the export has settled, in either direction.
   */
  workspaceProgress?: { processed: number; total: number };
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
  /** The current (or last) run's own share of `statistics`. */
  runStatistics?: SessionStatistics | null;
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
  /**
   * Where this child actually worked, when the Host can say.
   *
   * A card that said "isolated" without saying *where* would be asking a person to take the protection on faith, and
   * a card that showed an isolated child's changes in the parent's own change list would be actively misleading —
   * the parent's undo does not reach that directory. `kind: 'shared'` is therefore the honest label for a child that
   * has no directory of its own, in either of the two cases that produce one: an explicit `shared` mode, and a
   * Host that predates this capability and cannot answer at all.
   */
  workspace?: {
    kind: 'shared' | 'worktree';
    executionRoot: string;
    state: string;
    /** Why this workspace is not usable, when it is not. */
    problem?: string;
    dependencyWarning?: string;
    /** The result this child produced, while it is still outstanding. */
    result?: { id: string; digest: string; status: string; paths: string[] };
  };
  /** How far this child's result export has got, while it is exporting (see `SubAgentDelta`). */
  workspaceProgress?: { processed: number; total: number };
}
export interface SessionSnapshot {
  statistics?: SessionStatistics;
  /**
   * What the current run — or the last one this window saw — spent on its own.
   *
   * `statistics` is the whole session, and a person who ran `node -v` in a long session read "521K tok" as the
   * price of that one command. The pill shows both readings; `null` until a run has reported.
   */
  runStatistics?: SessionStatistics | null;
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
  /** Absolute index of the earliest visible message; earlier history remains in the Host. */
  historyStart?: number;
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
  /**
   * Runs of *other* sessions this client has seen start and not yet finish, with what each is waiting on.
   *
   * The Host runs several sessions at once, so switching away from a running session no longer stops watching it:
   * its approvals and questions are kept here until the session is opened again, where they become `approvals`
   * and `questions` once more. Optional for consumers built before it existed.
   */
  otherRuns?: OtherRun[];
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
  /**
   * The completion contract's evidence state, when this session carries one.
   *
   * Separate from `status` on purpose, and the separation is the point of the whole feature: `status` says how the
   * last run ended, and a run that ended because the model stopped talking is `completed` whether or not anything
   * was verified. A window that showed only `status` would show "done" for work nobody checked. `null` means no
   * contract was ever recorded — which is what every ordinary chat turn and every session from before this
   * existed reports, and it is a different statement from "unverified".
   */
  completion: CompletionRecord | null;
  error: string | null;
}
