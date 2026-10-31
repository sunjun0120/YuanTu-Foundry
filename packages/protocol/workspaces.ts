/**
 * The vocabulary of sub-agent workspace isolation.
 *
 * A session belongs to its logical project (`Session.workspace`); what a run's tools actually touch
 * is resolved from a separate durable binding, so a child can work in its own execution root while
 * the parent's directory stays untouched. Everything read from a store or an RPC peer is
 * re-validated here.
 */

/**
 * How a delegation picks a child's execution directory. `auto` shares the directory for read-only
 * children and gives writers their own worktree; `shared` never isolates; `worktree` isolates every
 * child.
 */
export const WORKSPACE_MODES = ['auto', 'shared', 'worktree'] as const;
/**
 * How much working tree the runtime will hold evidence about. Child snapshots and completion
 * fingerprints share one budget, so a tree that can be frozen can also be verified.
 */
export const WORKSPACE_SCALE_LIMITS = {
  /** One file larger than this is not a source file these features were built for. */
  fileBytes: 64 * 1024 * 1024,
  files: 200_000,
  totalBytes: 512 * 1024 * 1024,
} as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}
/**
 * Where a managed workspace is in its life. `preparing` is durable before any child session exists,
 * so an interrupted allocation is recoverable rather than an orphan directory.
 */
export const WORKSPACE_STATES = [
  'preparing',
  'ready',
  'blocked',
  'archiving',
  'archived',
  'removing',
  'removed',
] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];
export function isWorkspaceState(value: unknown): value is WorkspaceState {
  return typeof value === 'string' && (WORKSPACE_STATES as readonly string[]).includes(value);
}
/**
 * Allowed state transitions; the store refuses anything else. `blocked` is reachable from both live
 * states; `archived` and `removed` are terminal except for an explicit restore, which goes through
 * `preparing`. `ready -> preparing` lets a binding whose directory vanished be rebuilt through the
 * same validation.
 */
export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  preparing: ['ready', 'blocked', 'removing', 'removed'],
  ready: ['blocked', 'archiving', 'removing', 'preparing'],
  blocked: ['preparing', 'ready', 'archiving', 'removing', 'removed'],
  archiving: ['archived', 'blocked'],
  archived: ['removing', 'preparing'],
  removing: ['removed', 'blocked'],
  removed: ['preparing'],
};
export function canTransition(from: WorkspaceState, to: WorkspaceState): boolean {
  return from === to || WORKSPACE_TRANSITIONS[from].includes(to);
}
/**
 * How a binding came to exist. `shared` means the child runs in the delegator's directory, with no
 * isolation; readers must not present it as isolated.
 */
export type WorkspaceKind = 'shared' | 'worktree';
export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return value === 'shared' || value === 'worktree';
}

/**
 * One durable directory assignment. `sessionId` is null exactly while `preparing`, since the
 * directory is created before the child session. For a shared binding `projectRoot` and
 * `executionRoot` are the same.
 */
export interface WorkspaceBinding {
  id: string;
  /** The child session this directory belongs to, or null while it is still being prepared. */
  sessionId: string | null;
  /** The session that delegated, or null for a binding a top-level session owns over its own project. */
  parentSessionId: string | null;
  /** The logical project, identical to `Session.workspace`. Never replaced by an execution root. */
  projectRoot: string;
  /** The directory file tools, commands, instructions and spill actually use. */
  executionRoot: string;
  /** The main repository this directory belongs to, confirmed through Git's own records. */
  repositoryRoot: string;
  kind: WorkspaceKind;
  /** The frozen input this binding was built from, or null for a shared binding over a live directory. */
  snapshotId: string | null;
  /** The synthetic commit holding the frozen baseline; may differ from the source repository's HEAD. */
  baseCommit: string | null;
  state: WorkspaceState;
}

/**
 * A frozen picture of the delegator's directory (staged, modified, deleted and untracked files),
 * the baseline for every child of one delegation. `baseCommit` comes from a private index, so the
 * user's index and HEAD are untouched.
 */
export interface WorkspaceSnapshot {
  id: string;
  projectRoot: string;
  /** The directory the bytes were read from. Equal to `projectRoot` in this build. */
  sourceRoot: string;
  /** The repository's HEAD when the snapshot was taken, as evidence rather than as the baseline. */
  sourceHead: string;
  baseCommit: string;
  baseTree: string;
  manifestHash: string;
  createdAt?: string;
}

/** Where a result sits between "the child finished" and "the parent has the change". */
export const WORKSPACE_RESULT_STATUSES = [
  'ready',
  'unsupported',
  'applying',
  'applied',
  'conflict',
  'superseded',
] as const;
export type WorkspaceResultStatus = (typeof WORKSPACE_RESULT_STATUSES)[number];
export function isWorkspaceResultStatus(value: unknown): value is WorkspaceResultStatus {
  return (
    typeof value === 'string' && (WORKSPACE_RESULT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * One frozen set of changes a child produced. `comparisonTree` is the baseline for the first export
 * and the last successful import afterwards, so accepted changes are not offered again.
 */
export interface WorkspaceResult {
  id: string;
  bindingId: string;
  childSessionId: string;
  parentSessionId: string;
  snapshotId: string;
  comparisonTree: string;
  resultTree: string;
  digest: string;
  paths: string[];
  status: WorkspaceResultStatus;
  createdAt?: string;
}

/**
 * The durable receipt of one import, written in the same transaction as the file change, so a
 * repeated request returns what already happened.
 */
export interface WorkspaceApplyReceipt {
  id: string;
  resultId: string;
  digest: string;
  targetBindingId: string;
  changeId: string;
  createdAt: string;
}

/**
 * The codes a blocked workspace reports, as a closed set for callers that branch on them.
 * `WORKSPACE_SOURCE_CHANGED` (the directory changed while freezing) must never be reported as
 * generic.
 */
export type WorkspaceFailureCode =
  | 'WORKSPACE_POLICY_UNSUPPORTED'
  | 'WORKSPACE_NOT_A_REPOSITORY'
  | 'WORKSPACE_NO_HEAD'
  | 'WORKSPACE_SUBMODULE_UNSUPPORTED'
  | 'WORKSPACE_SPARSE_UNSUPPORTED'
  | 'WORKSPACE_UNMERGED_INDEX'
  | 'WORKSPACE_SOURCE_CHANGED'
  | 'WORKSPACE_PROTECTED_CREDENTIAL'
  | 'WORKSPACE_UNSUPPORTED_FILE_TYPE'
  | 'WORKSPACE_TOO_LARGE'
  | 'WORKSPACE_DEPENDENCIES_MISSING'
  | 'WORKSPACE_BUSY'
  | 'WORKSPACE_MISSING'
  | 'WORKSPACE_IDENTITY_MISMATCH'
  | 'WORKSPACE_CONFLICT'
  | 'WORKSPACE_UNSUPPORTED_RESULT'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_BINDING_NOT_ATTACHED'
  | 'WORKSPACE_INTEGRITY';

export class WorkspaceFailure extends Error {
  readonly code: WorkspaceFailureCode;
  /** Extra machine-readable detail: the paths in conflict, the files that are too large, and so on. */
  readonly detail: Record<string, unknown>;
  constructor(code: WorkspaceFailureCode, message: string, detail: Record<string, unknown> = {}) {
    super(`${message} (${code})`);
    this.name = 'WorkspaceFailure';
    this.code = code;
    this.detail = detail;
  }
}
export function isWorkspaceFailure(error: unknown): error is WorkspaceFailure {
  return error instanceof WorkspaceFailure;
}

/** A refusal reads as one line, with the code the caller branches on at the end. */
export function workspaceFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ------------------------------------------------------------------------------------------------
 * Validation
 *
 * One implementation per rule, shared by the store and the RPC boundary.
 * ----------------------------------------------------------------------------------------------
 */

const MAX_ID = 200;
/** A usable identifier: no control characters, no path separators, bounded length. */
export function workspaceId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID)
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace identifier');
  if (/[\u0000-\u001f\u007f/\\]/.test(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace identifier');
  return value;
}
export function optionalWorkspaceId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return workspaceId(value);
}
/**
 * An absolute directory path. Relative paths are refused, never resolved against a guessed base.
 */
export function workspacePath(value: unknown, field = 'path'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096)
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Invalid workspace ${field}`);
  if (value.includes('\u0000'))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Invalid workspace ${field}`);
  if (!/^([a-zA-Z]:[\\/]|[\\/]{1,2})/.test(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Workspace ${field} must be absolute`);
  return value;
}
/**
 * A Git object id: 40 (SHA-1) or 64 (SHA-256) hex characters, so truncated digests are rejected.
 */
export function gitObjectId(value: unknown, field = 'object'): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Invalid git ${field}`);
  return value;
}
/** Git writes tree, blob and commit ids in the same format, so one validator answers all three. */
export function gitTreeId(value: unknown, field = 'tree'): string {
  return gitObjectId(value, field);
}
export function gitCommitId(value: unknown, field = 'commit'): string {
  return gitObjectId(value, field);
}
/** A content digest this build wrote: hex, and long enough to be a real hash. */
export function workspaceDigest(value: unknown, field = 'digest'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32,128}$/.test(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Invalid workspace ${field}`);
  return value;
}
/** A repository-relative path, in the one spelling the manifest and the diff both use. */
export function relativeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4_096)
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace path');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.includes('\\'))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace path');
  if (value.includes('\u0000'))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace path');
  // Empty, `.` and `..` segments indicate path traversal.
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace path');
  return value;
}

export function workspaceMode(value: unknown, field = 'mode'): WorkspaceMode {
  if (!isWorkspaceMode(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Invalid workspace ${field}`);
  return value;
}
export function workspaceState(value: unknown): WorkspaceState {
  if (!isWorkspaceState(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace state');
  return value;
}
export function workspaceKind(value: unknown): WorkspaceKind {
  if (!isWorkspaceKind(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace kind');
  return value;
}
export function workspaceResultStatus(value: unknown): WorkspaceResultStatus {
  if (!isWorkspaceResultStatus(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace result status');
  return value;
}

/** One binding, as a store row or an RPC frame hands it over. */
export function workspaceBindingFrom(value: unknown): WorkspaceBinding {
  if (!value || typeof value !== 'object')
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace binding');
  const raw = value as Record<string, unknown>;
  const kind = workspaceKind(raw.kind);
  const snapshotId = optionalWorkspaceId(raw.snapshotId);
  const baseCommit =
    raw.baseCommit === null || raw.baseCommit === undefined ? null : gitCommitId(raw.baseCommit);
  if (kind === 'worktree' && (!snapshotId || !baseCommit))
    throw new WorkspaceFailure(
      'WORKSPACE_INTEGRITY',
      'An isolated binding must name its snapshot and baseline',
    );
  return {
    id: workspaceId(raw.id),
    sessionId: optionalWorkspaceId(raw.sessionId),
    parentSessionId: optionalWorkspaceId(raw.parentSessionId),
    projectRoot: workspacePath(raw.projectRoot, 'project root'),
    executionRoot: workspacePath(raw.executionRoot, 'execution root'),
    repositoryRoot: workspacePath(raw.repositoryRoot, 'repository root'),
    kind,
    snapshotId,
    baseCommit,
    state: workspaceState(raw.state),
  };
}

export function workspaceSnapshotFrom(value: unknown): WorkspaceSnapshot {
  if (!value || typeof value !== 'object')
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace snapshot');
  const raw = value as Record<string, unknown>;
  return {
    id: workspaceId(raw.id),
    projectRoot: workspacePath(raw.projectRoot, 'project root'),
    sourceRoot: workspacePath(raw.sourceRoot, 'source root'),
    sourceHead: gitCommitId(raw.sourceHead, 'head'),
    baseCommit: gitCommitId(raw.baseCommit),
    baseTree: gitTreeId(raw.baseTree),
    manifestHash: workspaceDigest(raw.manifestHash, 'manifest hash'),
    ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
  };
}

export function workspaceResultFrom(value: unknown): WorkspaceResult {
  if (!value || typeof value !== 'object')
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace result');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.paths))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace result paths');
  return {
    id: workspaceId(raw.id),
    bindingId: workspaceId(raw.bindingId),
    childSessionId: workspaceId(raw.childSessionId),
    parentSessionId: workspaceId(raw.parentSessionId),
    snapshotId: workspaceId(raw.snapshotId),
    comparisonTree: gitTreeId(raw.comparisonTree, 'comparison tree'),
    resultTree: gitTreeId(raw.resultTree, 'result tree'),
    digest: workspaceDigest(raw.digest),
    paths: raw.paths.map(relativeWorkspacePath),
    status: workspaceResultStatus(raw.status),
    ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
  };
}

export function workspaceApplyReceiptFrom(value: unknown): WorkspaceApplyReceipt {
  if (!value || typeof value !== 'object')
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace apply receipt');
  const raw = value as Record<string, unknown>;
  return {
    id: workspaceId(raw.id),
    resultId: workspaceId(raw.resultId),
    digest: workspaceDigest(raw.digest),
    targetBindingId: workspaceId(raw.targetBindingId),
    changeId: workspaceId(raw.changeId),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

/**
 * The state a new binding starts in: `preparing` with no session. A function so every writer
 * agrees.
 */
export function newWorkspaceBindingState(): {
  state: WorkspaceState;
  sessionId: null;
} {
  return { state: 'preparing', sessionId: null };
}

export interface DependencyWarning {
  code: 'WORKSPACE_DEPENDENCIES_MISSING';
  message: string;
  paths: string[];
}

/** One file this version will move, as the result record describes it. */
export interface WorkspaceResultFile {
  path: string;
  kind: 'create' | 'edit' | 'delete';
  /** Size of the bytes involved, for the caller's own reporting. */
  beforeBytes: number;
  afterBytes: number;
  beforeBlob: string | null;
  afterBlob: string | null;
}
