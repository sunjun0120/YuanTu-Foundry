import type {
  Approval,
  Message,
  QuestionRequest,
  RunResult,
  SessionInfo,
  UserInput,
} from './index.ts';
import type { PermissionPolicySource } from './permissions.ts';
import type { ModelCatalogConfiguration, ModelSelection } from './model-configuration.ts';
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
 * One entry of a workspace directory. `path` is workspace-relative with forward slashes, the form
 * `list_files` prints and `read_file` accepts, so it can be passed back unchanged.
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
   * True when the directory holds more entries than one answer carries, so a partial list never
   * reads as complete.
   */
  truncated: boolean;
}
export interface WorkspacePreview {
  path: string;
  /** Bytes on disk, so a preview can say how much of the file it is showing rather than just stopping. */
  bytes: number;
  /**
   * How the file can be shown. Bytes that are not valid text are `unsupported`, never decoded with
   * replacement characters.
   *
   * `html` is for Office documents: the Host renders a self-contained page with a CSP forbidding
   * scripts and network, and the window draws it in a sandboxed frame.
   */
  kind: 'text' | 'image' | 'html' | 'unsupported';
  /** Present when `kind` is `text`; UTF-8, cut at the preview budget. */
  text?: string;
  /** Present when `kind` is `html`: a complete page, bounded by `OFFICE_PREVIEW_BYTES`. */
  html?: string;
  /** Base64 bytes, present when `kind` is `image`. */
  data?: string;
  /** The type sniffed from the bytes, present when `kind` is `image`; never derived from the file name. */
  mimeType?: import('./index.ts').ImageAttachment['mimeType'];
  /** True when `text` is shorter than the file it came from. */
  truncated?: boolean;
  /** Why a file cannot be previewed. A code, so the panel can localise it. */
  reason?: 'binary' | 'too-large' | 'not-a-file';
}
/**
 * Per-answer bounds, part of the contract so a client can tell a complete answer from a cut one
 * (see `truncated` and `bytes`).
 */
export const FILE_TREE_ENTRY_LIMIT = 1000;
export const FILE_PREVIEW_BYTES = 128 * 1024;
/** Maximum size of a generated Office preview page. */
export const OFFICE_PREVIEW_BYTES = 4 * 1024 * 1024;
export interface HostMethods {
  /**
   * Registered runtime invariants and whether the last run broke any. Read-only: invariants are
   * registered by the code that owns them, never by a client.
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
  /** The Host process's own health: how blocked its shared event loop has been, and its run slots. */
  'host.health': {
    params: Record<string, never>;
    result: {
      /** Null when the Host was built without a loop monitor. */
      eventLoop: {
        delay: { p50: number; p99: number; max: number; mean: number };
        utilization: number;
        thresholdMs: number;
        stalls: {
          at: string;
          durationMs: number;
          sessions: string[];
          operations: number;
          requests: string[];
        }[];
      } | null;
      activeRuns: number;
      maxActiveRuns: number;
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
   * The directory a session's work actually happens in. Separate from `session.get` because the
   * binding changes as children run and are collected. `problems` reports a replaced or removed
   * directory.
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
   * Managed workspaces of this project whose session was deleted. The binding row outlives its
   * session so the directory and its results survive; archive, restore and remove accept a
   * `bindingId` from this list.
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
   * Import one result into the calling session's directory. A conflict is a result (changed paths,
   * nothing written), not an error.
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
   * Maintenance calls name their workspace by `sessionId`, or by `bindingId` only for an orphan of
   * this project whose session was deleted.
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
   * Select one session's backend, or the default. Active runs refuse the change; runs, tool
   * invocations and existing processes keep their pinned policy.
   */
  'sandbox.set': {
    params: { mode: SandboxMode; sessionId?: string; files?: FileEffect; network?: NetworkEffect };
    result: { mode: SandboxMode; files?: FileEffect; network?: NetworkEffect };
  };
  'sandbox.refresh': {
    params: Record<string, never>;
    result: { refreshed: true };
  };
  'resources.list': {
    params: Record<string, never>;
    result: { instructions: string[]; skills: SkillInfo[]; extensions: string[] };
  };
  /**
   * One workspace directory. Answered by the Host so the file tools' containment rule (realpath
   * inside the root, no links, no credential or internal names) decides every entry.
   */
  'files.list': {
    params: { path?: string };
    result: WorkspaceListing;
  };
  /** One file's bytes, in the single form a preview can show them without inventing content. */
  'files.read': {
    /** `locale` only chooses the language of a generated Office preview page; it never changes the bytes. */
    params: { path: string; locale?: string };
    result: WorkspacePreview;
  };
  'run.enqueue': {
    params: UserInput & { sessionId: string; mode: InputMode };
    result: { item: QueuedInput };
  };
  /**
   * The session's inbox: what is waiting and what was never delivered. Read on open because a run
   * that ended with queued input leaves it only in the log. `running` says whether this is the live
   * queue or leftovers.
   */
  'run.queue.get': {
    params: { sessionId: string };
    /**
     * `runId` names the run holding the session, so a client opening a running session accepts its
     * live frames. Optional for older Hosts; fall back to the session info's `activeRun`.
     */
    result: {
      running: boolean;
      items: QueuedInput[];
      runId?: string;
      /**
       * What the live run is waiting on a person for, so a client that opened late can still
       * answer. Present only while a run holds the session.
       */
      pending?: {
        approvals: { id: string; approval: Approval }[];
        questions: { id: string; request: QuestionRequest }[];
      };
      /** The session log's newest seq when this was answered, so an opening read needs no separate cursor probe. */
      latestSeq?: number;
    };
  };
  'run.queue.clear': { params: { sessionId: string }; result: { cleared: true } };
  'host.info': { params: { protocolVersions?: number[] }; result: HostInfo };
  'runtime.ready': { params: Record<string, never>; result: { ready: true } };
  'model.configure': { params: ModelCatalogConfiguration; result: { revision: number } };
  'model.select': { params: { sessionId: string; connectionId: string }; result: ModelSelection };
  'model.get': { params: { sessionId: string }; result: ModelSelection };
  'permission.update': {
    params: { policy: PermissionPolicySource; sessionId?: string };
    result: { applied: true; resolvedApprovals: number };
  };
  'session.create': { params: Record<string, never>; result: SessionInfo };
  /**
   * Newest first. `limit` (1-500) returns a page and `before` (last id of the previous page)
   * continues it; `id` narrows to one session. `archived` and `started` filter by archived state
   * and by whether anything has happened in the session.
   */
  'session.list': {
    params: {
      query?: string;
      limit?: number;
      before?: string;
      id?: string;
      archived?: boolean;
      started?: boolean;
    };
    result: SessionInfo[];
  };
  'session.rename': { params: { sessionId: string; title: string }; result: SessionInfo };
  /** Archive a session (`archived: true`) or bring it back; nothing it holds changes. */
  'session.archive': { params: { sessionId: string; archived: boolean }; result: SessionInfo };
  'session.delete': { params: { sessionId: string }; result: { deleted: true } };
  /**
   * Converge a session whose lease owner cannot be confirmed dead (capability
   * `session-recover-v1`). Automatic paths treat an uncheckable pid as alive, which can leave a
   * session stuck; this is the manual way out. The Host refuses it for a session it is running, and
   * records the caller's reason.
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
      providerDegraded?: boolean;
      statistics?: import('./statistics.ts').SessionStatistics;
      /**
       * The run's recent step boundaries, oldest first. A step with `endedAt: null` was in flight
       * at a crash. First page only.
       */
      steps?: readonly import('./steps.ts').StepRecord[];
      runEndings?: readonly import('./run-cancellation.ts').RunEnding[];
    };
  };
  /**
   * The session's process record: approvals, questions and their answers, and size refusals.
   * `afterSeq` continues from the previous read.
   */
  'session.audit': {
    params: { sessionId: string; afterSeq?: number; limit?: number };
    result: { entries: import('./index.ts').SessionEventView[]; nextSeq: number };
  };
  /**
   * The durable log after a cursor (the `AgentEvent.seq` a client last saw). `latestSeq` is where
   * the log ends; `nextSeq` continues the page.
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
       * `plan` runs the read-only planning phase: the agent must answer with `submit_plan` and
       * every approval is refused. Execution is a separate run.
       */
      phase?: 'plan';
      /** Execute the approved plan. Rejected unless its status and hash still match. */
      planId?: string;
      /** Which task trigger started this run; recorded on the task's attempt. */
      trigger?: import('./index.ts').TaskTriggerSource;
      /** Resume the task's deferred approval instead of starting its step over. */
      resume?: boolean;
      /**
       * The completion contract to verify the work against. Omitted by ordinary chat turns, so
       * "nothing claimed" and "evidence passed" stay distinct.
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
   * Files the session's runs marked as deliverables, newest last. Rebuilds the list after reload;
   * this is the presentation record, not the filesystem.
   */
  'deliverables.get': {
    params: { sessionId: string; byTurn?: boolean };
    result: import('./deliverables.ts').PresentedFile[];
  };
  /**
   * The completion contract this session works against, or null. Rebuilds the panel after reload;
   * the record holds the whole definition.
   */
  'completion.current': {
    params: { sessionId: string };
    result: import('./completion.ts').CompletionRecord | null;
  };
  /** The session's goal, or null. Rebuilds the panel after reload. */
  'goal.get': {
    params: { sessionId: string };
    result: import('./goals.ts').Goal | null;
  };
  /** Sub-agents of the session's most recent run. Rebuilds the panel after reload. */
  'subagents.list': {
    params: { sessionId: string; includePreviousRuns?: boolean };
    result: import('./index.ts').SubAgentSummary[];
  };
  /** The session's checklist as last written. Rebuilds the panel after reload. */
  'todos.get': {
    params: { sessionId: string };
    /**
     * The list plus what the last write changed (`null` if nothing or no change), so a reloaded
     * client can show the same change line.
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
   * `task.attempts` and `task.steps` for every task of a session in one round trip (capability
   * `task-history-v1`).
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
     * `resumeApproval` names the deferred approval the verification answers for (read in
     * `handlers/tasks.ts`).
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
     * `reason` is set when `compacted` is false for an actionable reason (e.g. the request envelope
     * was not recorded, or was truncated).
     */
    result: { compacted: boolean; coveredMessages: number; reason?: string };
  };
  'approval.respond': {
    params: { approvalId: string; allow: boolean };
    result: { accepted: true };
  };
  /**
   * Answers a live `question.required`. `answers` has one entry per filled question; `cancelled`
   * settles the tool as unanswered.
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
