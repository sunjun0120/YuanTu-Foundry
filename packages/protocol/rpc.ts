import type { Message, RunResult, SessionInfo, UserInput } from './index.ts';
import type { PermissionPolicySource } from './permissions.ts';
import type { InputMode, QueuedInput } from './inputs.ts';
import type { SkillInfo } from './skills.ts';
import type { ExecutionMode as SandboxMode, FileEffect, NetworkEffect } from './execution.ts';
/** Optional policy context selects a live owned session's permissions without assigning the orphan to it. */
type WorkspaceMaintenanceParams =
  | { sessionId: string; bindingId?: never; policySessionId?: never }
  | { bindingId: string; sessionId?: never; policySessionId?: string };
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
    result: import('./background.ts').BackgroundState;
  };
  'background.policy': {
    params: {
      sessionId: string;
      policy: import('./background.ts').BackgroundPolicyInput;
      reset?: boolean;
    };
    result: import('./background.ts').BackgroundState;
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
    result: import('./file-changes.ts').StoredFileChange[];
  };
  'changes.undo': { params: { sessionId: string; id: string }; result: { undone: true } };
  /**
   * The directory a session's work actually happens in.
   *
   * Separate from `session.get` because it is a different question with a different lifetime: a session's project is
   * fixed when it is created, while its execution binding is created, blocked, archived and restored as children run
   * and are collected. `problems` is the diagnostic half — a directory that was replaced or removed reads as broken
   * here rather than being reported as ready.
   */
  'workspaces.get': {
    params: { sessionId: string };
    result: {
      binding: import('./workspaces.ts').WorkspaceBinding;
      snapshot: import('./workspaces.ts').WorkspaceSnapshot | null;
      problems: string[];
      dependencyWarnings?: import('./workspaces.ts').DependencyWarning[];
    };
  };
  /** What this session's children produced, with the per-file detail an import preview needs. */
  'workspace.results': {
    params: { sessionId: string };
    result: (import('./workspaces.ts').WorkspaceResult & {
      files: import('./workspaces.ts').WorkspaceResultFile[];
      evidence: { tool: string; at: string }[];
    })[];
  };
  /**
   * The managed workspaces of this project whose session is gone.
   *
   * Deleting a session nulls its binding's session reference instead of deleting the row, because the directory
   * and the results exported from it have to outlive the session that produced them. That leaves a directory no
   * session-addressed method can name, so this is the one read that does not start from a session — and the
   * archive, restore and remove calls accept a `bindingId` for exactly the entries it returns.
   */
  'workspaces.orphaned': {
    params: {
      /** Include preserved removal records so a restarted client can discover recovery targets. */
      includeRemoved?: boolean;
    };
    result: {
      binding: import('./workspaces.ts').WorkspaceBinding;
      /** What is wrong with the directory right now, answered rather than thrown. */
      problems: string[];
      /** Results exported from this binding, retained after its session is deleted. */
      results: import('./workspaces.ts').WorkspaceResult[];
    }[];
  };
  /**
   * Import one result into the calling session's own directory.
   *
   * A conflict is a *result*, not an error: the client is told which paths changed underneath the result and that
   * nothing was written, which is information to act on rather than a failure to report.
   */
  'workspace.apply': {
    params: { sessionId: string; resultId: string; expectedDigest: string };
    result: {
      status: 'applied' | 'conflict';
      changeId?: string;
      conflicts: string[];
      files: { path: string; added: number; removed: number }[];
    };
  };
  /**
   * The three maintenance calls name their workspace one of two ways.
   *
   * `sessionId` is the ordinary door and keeps every guarantee it had. `bindingId` exists for the one case the
   * session door cannot serve — a directory whose session was deleted — and the Host opens it only for such an
   * orphan inside this project, never for a workspace a live session is working in.
   */
  'workspace.archive': {
    params: WorkspaceMaintenanceParams;
    result: { archived: true; bindingId: string; state: 'archived' };
  };
  'workspace.restore': {
    params: WorkspaceMaintenanceParams;
    result: { restored: true; binding: import('./workspaces.ts').WorkspaceBinding };
  };
  'workspace.remove': {
    params: WorkspaceMaintenanceParams;
    result: { removed: true; bindingId: string; state: 'removed' };
  };
  /**
   * Select one session's backend, or the default for sessions without a selection.
   *
   * Active runs refuse a policy change; each run and tool invocation pins its policy. A selection for another
   * idle session cannot alter the policy of the active run. Existing processes retain their creation policy.
   */
  'sandbox.set': {
    params: { mode: SandboxMode; sessionId?: string; files?: FileEffect; network?: NetworkEffect };
    result: { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect };
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
    /**
     * `runId` names the run holding the session, in the same answer that says it is held.
     *
     * A client that opens a session somebody is already running has to know which run it is now watching: the
     * live frames carry their run's id, and a client without the id drops every one of them as somebody else's.
     * It is optional because a Host that predates the field answers without it — the client then falls back to
     * the `activeRun` of the session info it reads anyway.
     */
    result: { running: boolean; items: QueuedInput[]; runId?: string };
  };
  'run.queue.clear': { params: { sessionId: string }; result: { cleared: true } };
  'host.info': { params: { protocolVersions?: number[]; authToken?: string }; result: HostInfo };
  'runtime.ready': { params: Record<string, never>; result: { ready: true } };
  'permission.update': {
    params: { policy: PermissionPolicySource; sessionId?: string };
    result: { applied: true; resolvedApprovals: number };
  };
  'session.create': { params: Record<string, never>; result: SessionInfo };
  /**
   * Newest first. `limit` (1–500) returns one page and `before` (the last id of the previous page) continues it;
   * `id` narrows the answer to that one session, or to nothing when it is gone. With neither, the whole list.
   */
  'session.list': {
    params: { query?: string; limit?: number; before?: string; id?: string };
    result: SessionInfo[];
  };
  'session.rename': { params: { sessionId: string; title: string }; result: SessionInfo };
  'session.delete': { params: { sessionId: string }; result: { deleted: true } };
  /**
   * Converge a session whose lease owner cannot be confirmed dead (capability `session-recover-v1`).
   *
   * Every automatic path is deliberately conservative: a pid that cannot be checked is read as alive, because
   * the alternative is letting a second writer into a session that really is running. The cost is a session that
   * no longer runs, renames, deletes or compacts, with no way out but editing the database. This method is the
   * way out, and it is only ever called for a person: the Host refuses it for a session it is running itself,
   * and the interruption it records carries the reason the caller gave.
   */
  'session.recover': {
    params: { sessionId: string };
    result: {
      sessionId: string;
      /** False when there was nothing to recover, so a retry is visibly a no-op. */
      recovered: boolean;
      settledRunId: string | null;
      previousOwnerPid: number | null;
      previousOwnerStartedAt: number | null;
      leaseDropped: boolean;
    };
  };
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
      /**
       * Which trigger started this run, when a task's own trigger did.
       *
       * Declared because the Host reads it and records it on the task's attempt: the field was consumed on the
       * wire while this interface did not mention it, so the contract could neither document nor validate it, and
       * a client written from this declaration silently dropped every scheduled start's provenance.
       */
      trigger?: import('./index.ts').TaskTriggerSource;
      /** Resume the task's deferred approval instead of starting its step over. */
      resume?: boolean;
      /**
       * The completion contract for a request or an approved plan, when the caller wants the work verified.
       *
       * Omitted by an ordinary chat turn, which is why "no evidence was claimed" and "the evidence passed" stay
       * distinguishable: only a caller that said what done means can be told it was reached.
       */
      completion?: import('./completion.ts').CompletionSpec;
      /** Continue a contract this session already recorded, by id. Conflicts with `completion` and `taskId`. */
      resumeCompletionId?: string;
      /** How much repair the run may spend before it stops, up to the ceilings the protocol fixes. */
      completionRepairPolicy?: import('./completion.ts').CompletionRepairPolicy;
      /** The file range a task's evidence covers; conflicts with an explicit `completion`. */
      completionInputs?: string[];
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
   * The completion contract this session is working against, or null when it has none.
   *
   * `completion.updated` carries the live change; this is what a reopened window asks, because a contract outlives
   * the run that created it and the answer has to survive the process. The record carries the whole definition, so
   * a reader never has to reconstruct it from a sequence of round records.
   */
  'completion.current': {
    params: { sessionId: string };
    result: import('./completion.ts').CompletionRecord | null;
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
    params: { sessionId: string; includePreviousRuns?: boolean };
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
  /**
   * `task.attempts` and `task.steps` for every task of a session, in one round trip (capability
   * `task-history-v1`). A task panel that asked per task paid two requests for each one on every refresh.
   */
  'task.history': {
    params: { sessionId: string };
    result: Record<
      string,
      {
        attempts: import('./index.ts').TaskAttempt[];
        steps: import('./index.ts').TaskStepCheckpoint[];
      }
    >;
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
    /**
     * `resumeApproval` names the deferred approval the verification is answering for.
     *
     * The Host reads it (`handlers/tasks.ts`) and this declaration did not carry it, which is the same gap as
     * `run.start`'s `trigger`: a parameter the wire accepts and the contract denies.
     */
    params: { sessionId: string; taskId: string; resumeApproval?: boolean };
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
