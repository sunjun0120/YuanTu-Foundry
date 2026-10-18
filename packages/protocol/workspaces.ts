/**
 * The vocabulary of sub-agent workspace isolation.
 *
 * A session keeps belonging to the *logical* project it was created for (`Session.workspace`), and what a run's
 * file tools, commands, instructions and spill actually touch is resolved from a separate, durable binding. The
 * two are different statements and this module is where that difference is written down: a project is where a
 * session lives, an execution root is the directory a child works in while its parent's own directory stays as
 * the parent left it.
 *
 * Everything a store or an RPC peer hands back is re-checked here rather than trusted. A binding read out of
 * SQLite, or sent over the client seam, is data: an unrecognised state, a relative path, a truncated digest or a
 * fork-forming first state would otherwise be interpreted as if this build had written it.
 */

/**
 * How a delegation decides a child's execution directory.
 *
 * `auto` is what the product ships once isolation has been accepted: read-only exploration shares the
 * delegator's directory (it cannot change anything, so a copy would only cost disk), and anything that may write
 * gets its own worktree. `shared` keeps the pre-isolation behaviour verbatim and exists so an operator can ask
 * for it deliberately; `worktree` isolates every child, including read-only ones.
 */
export const WORKSPACE_MODES = ['auto', 'shared', 'worktree'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}
/**
 * Where a managed workspace is in its life.
 *
 * `preparing` exists as a durable state *before* any child session does, which is what makes an interrupted
 * allocation recoverable instead of an orphan directory: a row in `preparing` is a directory this service may
 * still own, and one with no session is not a child anybody can address.
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
 * Which states a state may move to, in one table.
 *
 * A transition that is not here is refused by the store rather than written, so a crash-recovery pass cannot
 * accidentally resurrect an archived workspace as `ready` or hand a `preparing` row to a tool. `blocked` is reachable
 * from both live states because either can fail validation, and `archived`/`removed` are terminal except for an
 * explicit restore, which starts over at `preparing`.
 *
 * `ready → preparing` is on the list because an explicit restore is not only for an *archived* workspace: a binding
 * whose directory was removed or replaced behind its back is still `ready` in its row, and rebuilding it has to pass
 * through the same `preparing` state a fresh allocation does. That is what keeps "this directory exists and has been
 * validated" a single fact, rather than one rule for allocation and a second, weaker one for recovery.
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
 * How a binding came to exist.
 *
 * `shared` is not "isolation that failed": it is the statement that the child runs in the delegator's own
 * directory, which is exactly what every delegation did before this feature and what an explicit `shared` run
 * still asks for. A reader that showed it as isolated would be promising a protection that is not there.
 */
export type WorkspaceKind = 'shared' | 'worktree';
export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return value === 'shared' || value === 'worktree';
}

/**
 * One durable directory assignment.
 *
 * `sessionId` is null exactly while the row is `preparing`: the directory exists before the child session does,
 * because a child session that cannot get a directory must not exist at all. `projectRoot` is the logical
 * project (`Session.workspace`, unchanged) and `executionRoot` is where the work happens; for a shared binding
 * the two are the same directory, which is what lets every existing session be read as a shared binding without
 * rewriting its history.
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
 * A frozen picture of the delegator's directory at one moment.
 *
 * The bytes captured here — including files that were staged and then modified again, deletions and untracked
 * files — are the baseline every child of one delegation call sees. `baseCommit` is a synthetic commit built
 * from a private index, so the user's own index and HEAD are never touched, and `manifestHash` is what makes the
 * manifest itself comparable across processes.
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
 * One frozen set of changes a child produced.
 *
 * `comparisonTree` is what the result is a difference *against*: the frozen baseline for a first export, and the
 * subtree of the last successful import for every later one. That is what keeps a second export from re-offering
 * changes the parent already accepted, and it moves only after an import actually succeeded.
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
 * The durable receipt of one import, keyed by result, digest and target binding.
 *
 * It exists so that a repeated request is answered with what already happened instead of writing the same bytes
 * twice: the receipt is written inside the same transaction that records the file change, so "the change exists"
 * and "this result was imported" cannot disagree.
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
 * The codes a blocked workspace reports, as a closed set.
 *
 * Structured rather than prose because the callers that must act on a refusal are not people: the coordinator
 * decides whether to fail the task or fall back to a shared read-only child, the Host decides whether the user
 * needs to be told, and a test asserts the specific reason. `WORKSPACE_SOURCE_CHANGED` in particular is the
 * answer to "the directory moved while I was freezing it", which must never be reported as a generic failure.
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

/* ------------------------------------------------------------------------------------------------
 * Validation
 *
 * One implementation per rule, used by both the store (reading rows) and the protocol boundary (reading RPC).
 * Two copies is how a value written by one build and read by another ends up interpreted differently in the two
 * places that were supposed to agree about it.
 * ---------------------------------------------------------------------------------------------- */

const MAX_ID = 200;
/**
 * Whether a string is usable as an identifier, and what "usable" means here.
 *
 * Ids are generated locally (`randomUUID`, a snapshot's own digest or a service-made id) and are also read back
 * from durable rows, so the check is about shape rather than provenance: no control characters, no path
 * separators (an id is never a path fragment), and a bounded length.
 */
export function workspaceId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID)
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace identifier');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\]/.test(value))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid workspace identifier');
  return value;
}
export function optionalWorkspaceId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return workspaceId(value);
}
/**
 * A directory this runtime may act on, as an absolute path.
 *
 * Relative paths are refused rather than resolved: a binding is created from a directory the runtime already
 * resolved, so a relative one is either a bug or a hand-edited row, and guessing a base directory for it would
 * silently point a child at the wrong tree.
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
 * A Git object id, in the width this repository actually uses.
 *
 * Not a fixed 40 characters: SHA-256 repositories exist and produce 64, and a validator that only accepted 40
 * would refuse to read a perfectly good binding. Nor is it "any hex string": the length has to be a real object
 * format, or a truncated digest would be accepted as an id and later fail as a missing object.
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
  // `.` and `..` segments are what a path-traversal bug looks like after normalisation stopped helping.
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
 * The state a *new* binding starts in, and the one fact a caller must not get wrong.
 *
 * A binding is written before the session it will belong to exists, so it starts at `preparing` with no session.
 * Exported as a function rather than left to each writer because two writers disagreeing about the first state
 * would produce rows that recovery cannot classify.
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
