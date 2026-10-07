import type { Message, RunResult, SessionInfo, UserInput } from './index.ts';
import type { PermissionPolicySource } from '../core/permissions.ts';
import type { InputMode, QueuedInput } from '../core/run-queue.ts';
import type { SkillInfo } from '../resources/skills.ts';
// Type-only, and the seam is the owner of this vocabulary: `sandbox-provider.ts` imports nothing from here, so
// this is a name being borrowed rather than a dependency being taken.
import type { SandboxMode } from '../tools/sandbox-provider.ts';
export interface HostInfo {
  protocolVersion: 1;
  runtime: 'yuantu';
  workspace: string;
  capabilities: string[];
}
export interface BackgroundJobSnapshot {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  createdAt: string;
  finishedAt?: string;
  status: string;
  pid?: number;
  exitCode: number | null;
  output: string;
  nextCursor: number;
  truncated: boolean;
}
/**
 * One entry of a workspace directory.
 *
 * `path` is relative to the workspace root with forward slashes — the shape `list_files` prints and
 * `read_file` accepts — so a path taken from a tree can be handed back to `files.read` or to a tool without a
 * second translation that could disagree with the first one.
 */
export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
}
export interface WorkspaceListing {
  /** The directory this answers for, in the same relative form as `WorkspaceEntry.path`; `''` is the root. */
  path: string;
  entries: WorkspaceEntry[];
  /**
   * True when the directory holds more entries than one answer carries.
   *
   * Said out loud because the alternative — a list that just stops — reads as "this is everything", and a
   * folder that looks finished while files are missing from it is the defect a file tree must not have.
   */
  truncated: boolean;
}
export interface WorkspacePreview {
  path: string;
  /** Bytes on disk, so a preview can say how much of the file it is showing rather than just stopping. */
  bytes: number;
  /**
   * How the file can be shown: as text, as an image, or not at all.
   *
   * There is deliberately no fourth "maybe": bytes that are not valid text are reported as unsupported
   * instead of being decoded with replacement characters, because mojibake looks like content and
   * "unsupported" does not.
   */
  kind: 'text' | 'image' | 'unsupported';
  /** Present when `kind` is `text`; UTF-8, cut at the preview budget. */
  text?: string;
  /** Base64 bytes, present when `kind` is `image`. */
  data?: string;
  /** The type sniffed from the bytes, present when `kind` is `image`; never derived from the file name. */
  mimeType?: import('./index.ts').ImageAttachment['mimeType'];
  /** True when `text` is shorter than the file it came from. */
  truncated?: boolean;
  /**
   * Why a file cannot be previewed, when it cannot.
   *
   * A code rather than a sentence, because the Host does not localise and the panel has to say this in the
   * reader's own language.
   */
  reason?: 'binary' | 'too-large' | 'not-a-file';
}
/**
 * How much one answer carries, as part of the contract rather than as a detail of the handler.
 *
 * A listing and a preview are the two places where "as much as there is" is unbounded — a directory of half a
 * million files, a 4GB log — and a client that cannot see the bound cannot tell a complete answer from a cut
 * one. Both limits are answered for by `truncated` and `bytes` in the results above.
 */
export const FILE_TREE_ENTRY_LIMIT = 1000;
export const FILE_PREVIEW_BYTES = 128 * 1024;
export interface HostMethods {
  /**
   * What runtime invariants this process registered, and whether the last run broke any.
   *
   * `describe()` is deliberately the centre of this: a registry nobody can enumerate is a registry whose
   * contents are a guess. This is the read side of the seam, not a control plane — an invariant is
   * registered by the code that owns the promise, never by a client.
   */
  'invariants.list': {
    params: Record<string, never>;
    result: {
      invariants: {
        name: string;
        owner: string;
        description: string;
        scope: import('./invariants.ts').InvariantScope;
      }[];
      /** Violations reported by the most recent run, so "does it hold right now?" is answerable. */
      violations: import('./invariants.ts').InvariantViolation[];
    };
  };
  'background.list': {
    params: { sessionId?: string };
    result: BackgroundJobSnapshot[];
  };
  'background.state': {
    params: { sessionId: string };
    result: import('../core/background-deliveries.ts').BackgroundState;
  };
  'background.policy': {
    params: {
      sessionId: string;
      policy: import('../core/background-deliveries.ts').BackgroundPolicyInput;
      reset?: boolean;
    };
    result: import('../core/background-deliveries.ts').BackgroundState;
  };
  'background.poll': {
    params: { sessionId: string; id: string; cursor?: number; waitMs?: number };
    result: BackgroundJobSnapshot;
  };
  'background.stop': {
    params: { sessionId: string; id: string };
    result: BackgroundJobSnapshot;
  };
  'background.clear': {
    params: { sessionId?: string };
    result: { cleared: number };
  };
  'changes.list': {
    params: { sessionId: string };
    result: import('../storage/sqlite.ts').StoredFileChange[];
  };
  'changes.undo': { params: { sessionId: string; id: string }; result: { undone: true } };
  /**
   * Select one session's backend, or the default for sessions without a selection.
   *
   * Active runs refuse a policy change; each run and tool invocation pins its policy. A selection for another
   * idle session cannot alter the policy of the active run. Existing processes retain their creation policy.
   */
  'sandbox.set': {
    params: { mode: SandboxMode; sessionId?: string };
    result: { mode: SandboxMode };
  };
  'resources.list': {
    params: Record<string, never>;
    result: { instructions: string[]; skills: SkillInfo[]; extensions: string[] };
  };
  /**
   * One directory of the workspace, for a client that wants to show the workspace itself.
   *
   * Read-only, and answered by the Host rather than by a shell that happens to know the workspace path: the
   * file tools' own containment rule (realpath inside the root, no links, no credential or internal names) is
   * what decides every entry, and a reader on the other side of the wire would be a second copy of that rule.
   * The copy that drifts is the one that lists `.env`.
   */
  'files.list': {
    params: { path?: string };
    result: WorkspaceListing;
  };
  /** One file's bytes, in the single form a preview can show them without inventing content. */
  'files.read': {
    params: { path: string };
    result: WorkspacePreview;
  };
  'run.enqueue': {
    params: UserInput & { sessionId: string; mode: InputMode };
    result: { item: QueuedInput };
  };
  /**
   * The session's inbox: what is waiting for it, and what nobody ever sent.
   *
   * Read when a client opens a session rather than only while events arrive, because the interesting case is
   * the one with no events: a run that died or ended with input still queued leaves the fact in the log and
   * nothing on the wire. `running` says which half the list is — the live queue when a run holds it, the
   * undelivered leftovers when nothing does.
   */
  'run.queue.get': {
    params: { sessionId: string };
    result: { running: boolean; items: QueuedInput[] };
  };
  'run.queue.clear': { params: { sessionId: string }; result: { cleared: true } };
  'host.info': { params: { protocolVersions?: number[] }; result: HostInfo };
  'runtime.ready': { params: Record<string, never>; result: { ready: true } };
  'permission.update': {
    params: { policy: PermissionPolicySource; sessionId?: string };
    result: { applied: true; resolvedApprovals: number };
  };
  'session.create': { params: Record<string, never>; result: SessionInfo };
  'session.list': { params: { query?: string }; result: SessionInfo[] };
  'session.rename': { params: { sessionId: string; title: string }; result: SessionInfo };
  'session.delete': { params: { sessionId: string }; result: { deleted: true } };
  'session.get': {
    params: {
      sessionId: string;
      offset?: number;
      view?: 'display';
      chunkOffset?: number;
      tail?: number;
      endOffset?: number;
    };
    result: {
      session: SessionInfo;
      messages: Message[];
      /** Absolute bounds of this display window; older clients may omit them. */
      offset?: number;
      totalMessages?: number;
      nextOffset?: number;
      messageChunk?: { index: number; part: string; nextChunkOffset?: number };
      statistics?: import('./statistics.ts').SessionStatistics;
      /**
       * The run's recent step boundaries, oldest first.
       *
       * A step whose `endedAt` is `null` was opened and never closed, which after a crash is the step that was
       * in flight; `run.interrupted` in the audit names the same number. Present on the first page only, like
       * the statistics: it describes the session rather than the window of history being paged.
       */
      steps?: readonly import('./steps.ts').StepRecord[];
    };
  };
  /**
   * The session's process record: approvals and questions with their answers, and the requests the provider
   * refused for size. `afterSeq` is the cursor a client got from its previous read, so this is how a client
   * catches up instead of reading the log again.
   */
  'session.audit': {
    params: { sessionId: string; afterSeq?: number; limit?: number };
    result: { entries: import('./index.ts').SessionEventView[]; nextSeq: number };
  };
  /**
   * The durable log from a cursor: what a client missed, without re-reading the session.
   *
   * This is the other half of the cursor every live frame carries (`AgentEvent.seq`). A client that has been
   * disconnected — or that simply wants to check its own view against the record — asks for everything after
   * the last seq it saw and folds the answer; it never has to read the whole history, and it never has to
   * guess whether it missed anything. `latestSeq` is where the log now ends, so a client can tell "I am caught
   * up" from "there is more" without a second call, and `nextSeq` is the cursor for the next page.
   */
  'session.events': {
    params: { sessionId: string; afterSeq?: number; limit?: number };
    result: {
      entries: import('./index.ts').SessionEventView[];
      nextSeq: number;
      latestSeq: number;
      /** True when a page was cut short, so the caller keeps reading rather than assuming it is level. */
      more: boolean;
    };
  };
  'run.start': {
    params: UserInput & {
      sessionId: string;
      taskId?: string;
      /**
       * `plan` runs the read-only planning phase; the agent must answer with `submit_plan` and the
       * host refuses every approval, so nothing can be written. Execution is a separate run.
       */
      phase?: 'plan';
      /** Execute the approved plan. Rejected unless its status and hash still match. */
      planId?: string;
    };
    result: RunResult;
  };
  'plan.get': { params: { sessionId: string }; result: import('./index.ts').Plan | null };
  /**
   * The files the session's runs have marked as their deliverables, newest last.
   *
   * `deliverable.presented` carries the live change; this is what rebuilds the list after a reload, and it is
   * the presentation record rather than the filesystem: a path here is something a run *said* was finished.
   */
  'deliverables.get': {
    params: { sessionId: string };
    result: import('./deliverables.ts').PresentedFile[];
  };
  /**
   * The session's goal, or null when it has none.
   *
   * `goal.changed` carries the live change; this is what a reopened window asks, because a goal outlives the run
   * that declared it and is the one piece of session state that says what the whole session is for.
   */
  'goal.get': {
    params: { sessionId: string };
    result: import('./goals.ts').Goal | null;
  };
  /**
   * Sub-agents of the session's most recent run, stored with its result. Progress events carry the
   * live state; this is what rebuilds the panel after a reload.
   */
  'subagents.list': {
    params: { sessionId: string };
    result: import('./index.ts').SubAgentSummary[];
  };
  /**
   * The session's checklist as the model last wrote it. `todo.written` carries it live; this is what
   * rebuilds the panel after a reload.
   */
  'todos.get': {
    params: { sessionId: string };
    /**
     * The list, plus what the most recent write changed about it.
     *
     * `change` is `null` when nothing has been written or when the last write was not a change, so a client
     * that reloads can render the same "what just happened to the plan" line it showed live instead of
     * needing to keep the previous version in memory across a restart.
     */
    result: {
      todos: import('./index.ts').TodoItem[];
      change: import('./todos.ts').TodoChange | null;
    };
  };
  'plan.approve': {
    params: { sessionId: string; planId: string; hash: string };
    result: import('./index.ts').Plan;
  };
  'plan.reject': {
    params: { sessionId: string; planId: string; reason?: string };
    result: import('./index.ts').Plan;
  };
  'task.create': {
    params: {
      sessionId: string;
      title: string;
      description?: string;
      acceptance?: import('./index.ts').Acceptance[];
      steps?: import('./index.ts').TaskStep[];
    };
    result: import('./index.ts').Task;
  };
  'task.get': { params: { sessionId: string; taskId: string }; result: import('./index.ts').Task };
  'task.list': {
    params: { sessionId: string; status?: import('./index.ts').TaskStatus };
    result: import('./index.ts').Task[];
  };
  'task.update': {
    params: {
      sessionId: string;
      taskId: string;
      title?: string;
      expectedUpdatedAt?: string;
      description?: string;
      acceptance?: import('./index.ts').Acceptance[];
      steps?: import('./index.ts').TaskStep[];
    };
    result: import('./index.ts').Task;
  };
  'task.attempts': {
    params: { sessionId: string; taskId: string };
    result: import('./index.ts').TaskAttempt[];
  };
  'task.steps': {
    params: { sessionId: string; taskId: string };
    result: import('./index.ts').TaskStepCheckpoint[];
  };
  'task.approval.respond': {
    params: { sessionId: string; taskId: string; approvalId: string; allow: boolean };
    result: import('./index.ts').Task;
  };
  'task.trigger': {
    params: {
      sessionId: string;
      taskId: string;
      trigger: import('./index.ts').TaskTrigger | null;
    };
    result: import('./index.ts').Task;
  };
  'task.propose': {
    params: { sessionId: string; taskId: string };
    result: import('./index.ts').Task;
  };
  'task.confirm': {
    params: { sessionId: string; taskId: string; indices: number[]; expectedUpdatedAt: string };
    result: import('./index.ts').Task;
  };
  'task.verify': {
    params: { sessionId: string; taskId: string };
    result: { task: import('./index.ts').Task; attempt: import('./index.ts').TaskAttempt };
  };
  'task.retry': {
    params: { sessionId: string; taskId: string; prompt?: string };
    result: RunResult;
  };
  'run.cancel': { params: { sessionId: string }; result: { cancelled: boolean } };
  'context.compact': {
    params: { sessionId: string };
    /**
     * `reason` is present exactly when `compacted` is false for a reason the caller could act on — a session with
     * nothing to compact says nothing extra, while one whose request envelope was never recorded (or was recorded
     * truncated) is told why, because the alternative is a button that does nothing and explains nothing.
     */
    result: { compacted: boolean; coveredMessages: number; reason?: string };
  };
  'approval.respond': {
    params: { approvalId: string; allow: boolean };
    result: { accepted: true };
  };
  /**
   * Answers a live `question.required`. `answers` carries one entry per question the human filled in;
   * `cancelled` is the "do not answer" path, which settles the tool as unanswered instead of stalled.
   */
  'question.respond': {
    params: {
      questionId: string;
      answers?: import('./index.ts').QuestionAnswer[];
      cancelled?: boolean;
    };
    result: { accepted: true };
  };
}
export type HostMethod = keyof HostMethods;
