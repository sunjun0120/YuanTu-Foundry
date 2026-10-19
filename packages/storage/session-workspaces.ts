import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  WorkspaceFailure,
  canTransition,
  gitCommitId,
  gitTreeId,
  optionalWorkspaceId,
  relativeWorkspacePath,
  workspaceApplyReceiptFrom,
  workspaceBindingFrom,
  workspaceDigest,
  workspaceId,
  workspacePath,
  workspaceResultFrom,
  workspaceResultStatus,
  workspaceState,
  type WorkspaceApplyReceipt,
  type WorkspaceBinding,
  type WorkspaceResult,
  type WorkspaceResultStatus,
  type WorkspaceSnapshot,
  type WorkspaceState,
} from '../protocol/workspaces.ts';
import { samePath } from '../platform/workspace-paths.ts';
import {
  ownStartedAt,
  primeProcessStartTimes,
  processAlive,
} from '../platform/process-identity.ts';

/**
 * The durable half of workspace isolation.
 *
 * Every row here describes a directory this service created or adopted, and every write is a compare-and-swap:
 * a caller says which state it believed the row was in, and the row only moves if it still is. That is what makes
 * the crash paths survivable — a reconciliation pass that ran against a stale belief loses the race and is told
 * so, instead of overwriting a state some other pass already advanced.
 *
 * Nothing in this module reads the filesystem. It answers questions about records; whether the directory those
 * records describe still exists, still belongs to this service and still holds the right bytes is decided by the
 * manager, which is the only thing that may act on an answer.
 */

export interface SessionWorkspacePort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  /** The logical project a session belongs to, which ownership checks compare against. */
  sessionProject(sessionId: string): { workspace: string; parentSessionId: string | null };
}

const BINDING_COLUMNS =
  'id,session_id AS sessionId,parent_session_id AS parentSessionId,project_root AS projectRoot,' +
  'execution_root AS executionRoot,repository_root AS repositoryRoot,kind,snapshot_id AS snapshotId,' +
  'base_commit AS baseCommit,state,created_at AS createdAt,updated_at AS updatedAt';

const SNAPSHOT_COLUMNS =
  'id,project_root AS projectRoot,source_root AS sourceRoot,source_head AS sourceHead,' +
  'base_commit AS baseCommit,base_tree AS baseTree,manifest_hash AS manifestHash,created_at AS createdAt';

const RESULT_COLUMNS =
  'id,binding_id AS bindingId,child_session_id AS childSessionId,parent_session_id AS parentSessionId,' +
  'snapshot_id AS snapshotId,comparison_tree AS comparisonTree,result_tree AS resultTree,digest,paths,status,' +
  'created_at AS createdAt';

const RECEIPT_COLUMNS =
  'id,result_id AS resultId,digest,target_binding_id AS targetBindingId,change_id AS changeId,' +
  'created_at AS createdAt';

/**
 * A row as a binding, through the protocol validator rather than a cast.
 *
 * A row is data like any other: it may have been written by a newer build, or edited by hand, and a value this
 * build cannot interpret has to be refused where it is read instead of travelling into a child's tool registry.
 */
function bindingFromRow(row: Record<string, unknown>): WorkspaceBinding {
  return workspaceBindingFrom(row);
}

function resultFromRow(row: Record<string, unknown>): WorkspaceResult {
  return workspaceResultFrom({
    ...row,
    paths: JSON.parse(String(row.paths ?? '[]')) as unknown,
  });
}

export class SessionWorkspaces {
  private readonly port: SessionWorkspacePort;
  constructor(port: SessionWorkspacePort) {
    this.port = port;
  }
  private get db(): DatabaseSync {
    return this.port.db;
  }

  /**
   * Whether the process holding this binding's operation lease is still the one that took it.
   *
   * The pid alone is not an identity: after a crash the system can hand that pid to an unrelated process, and the
   * lease then looked held forever — every archive, remove and restore of the worktree refused with
   * `WORKSPACE_BUSY`, and so did every run of its session. The owner's start time is recorded with the lease, as it
   * is for a run, and a pid that now belongs to a different process counts as dead.
   *
   * The start time is trusted only when it was written with the lease's current token. An older build renews a
   * lease with an upsert that does not know the column, which would pair its own pid with the previous owner's
   * start time; such a row is judged by the pid alone, exactly as it was before the column existed.
   */
  operationIsLive(bindingId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT owner_pid,token,owner_started_at,owner_started_token FROM workspace_operation_leases WHERE binding_id=?',
      )
      .get(workspaceId(bindingId));
    if (!row) return false;
    const startedAt =
      row.owner_started_at !== null && row.owner_started_token === row.token
        ? Number(row.owner_started_at)
        : null;
    return processAlive(Number(row.owner_pid), Number.isFinite(startedAt) ? startedAt : null);
  }

  /**
   * Answer the owner's start time before a write transaction asks for it.
   *
   * On Windows the lookup is a subprocess; asked inside `BEGIN IMMEDIATE` it would hold the database's only write
   * lock for as long as that takes (see `primeRunOwners`).
   */
  primeOperationOwner(bindingId: string): void {
    try {
      const row = this.db
        .prepare('SELECT owner_pid FROM workspace_operation_leases WHERE binding_id=?')
        .get(workspaceId(bindingId));
      if (row) primeProcessStartTimes([Number(row.owner_pid)]);
    } catch {
      // An optimisation: without it the owner is looked up inside the transaction, as before.
    }
  }

  claimOperation(bindingId: string): string {
    this.primeOperationOwner(bindingId);
    return this.port.transaction(() => {
      if (!this.bindingById(workspaceId(bindingId)))
        throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', 'Unknown workspace operation binding');
      if (this.operationIsLive(bindingId))
        throw new WorkspaceFailure('WORKSPACE_BUSY', 'Another process is managing this workspace');
      const token = randomUUID();
      this.db
        .prepare(
          `INSERT INTO workspace_operation_leases(binding_id,owner_pid,token,created_at,owner_started_at,owner_started_token)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(binding_id) DO UPDATE SET owner_pid=excluded.owner_pid,token=excluded.token,created_at=excluded.created_at,
          owner_started_at=excluded.owner_started_at,owner_started_token=excluded.owner_started_token`,
        )
        .run(bindingId, process.pid, token, new Date().toISOString(), ownStartedAt(), token);
      return token;
    });
  }

  assertOperation(bindingId: string, token: string): void {
    const row = this.db
      .prepare('SELECT owner_pid,token FROM workspace_operation_leases WHERE binding_id=?')
      .get(workspaceId(bindingId));
    if (!row || row.owner_pid !== process.pid || row.token !== token)
      throw new WorkspaceFailure(
        'WORKSPACE_BUSY',
        'Workspace cleanup no longer owns its operation lease',
      );
  }

  /**
   * Drops a binding's operation lease whoever holds it, and says who that was.
   *
   * For the one case automatic recovery cannot decide: an owner pid that is alive with no recorded start time (a
   * lease an older build wrote), or a start time the platform cannot read. A person who knows the owner is gone
   * says so; the lease is dropped and the caller records who asked. A lease this process holds is refused — it is
   * not a leftover, and dropping it would let a second operation run beside the live one.
   */
  forceReleaseOperation(bindingId: string): {
    released: boolean;
    previousOwnerPid: number | null;
    previousOwnerStartedAt: number | null;
  } {
    const id = workspaceId(bindingId);
    if (!this.bindingById(id))
      throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', 'Unknown workspace operation binding');
    const row = this.db
      .prepare(
        'SELECT owner_pid,token,owner_started_at,owner_started_token FROM workspace_operation_leases WHERE binding_id=?',
      )
      .get(id);
    if (!row) return { released: false, previousOwnerPid: null, previousOwnerStartedAt: null };
    if (Number(row.owner_pid) === process.pid)
      throw new WorkspaceFailure(
        'WORKSPACE_BUSY',
        'This process holds the workspace operation lease; it is not a leftover',
      );
    this.db.prepare('DELETE FROM workspace_operation_leases WHERE binding_id=?').run(id);
    return {
      released: true,
      previousOwnerPid: Number(row.owner_pid),
      previousOwnerStartedAt:
        row.owner_started_at !== null && row.owner_started_token === row.token
          ? Number(row.owner_started_at)
          : null,
    };
  }

  /**
   * Forgets a removed workspace: its binding, its results and their receipts. Its snapshots are released afterwards
   * by the same pass as every other snapshot this database no longer names (`dropUnusedSnapshot`).
   *
   * This is the irreversible step, which is why it is narrow: only a `removed` binding, only while the caller holds
   * its operation lease, and never while one of its results is still `applying` (startup recovery needs that one).
   * The rows go first and the caller removes the files after, so a failure there leaves bytes nobody points at — a
   * leak — rather than a record that points at nothing. Returns what the caller has to remove from the repository.
   */
  purgeRemoved(bindingId: string, token: string): { resultIds: string[] } {
    return this.port.transaction(() => {
      const id = workspaceId(bindingId);
      this.assertOperation(id, token);
      const binding = this.bindingById(id);
      if (!binding || binding.state !== 'removed')
        throw new WorkspaceFailure('WORKSPACE_BUSY', 'Only a removed workspace can be purged');
      const results = this.db
        .prepare('SELECT id,status FROM workspace_results WHERE binding_id=?')
        .all(id);
      if (results.some((row) => row.status === 'applying'))
        throw new WorkspaceFailure(
          'WORKSPACE_BUSY',
          'A result of this workspace is still being imported; let recovery finish it first',
        );
      const resultIds = results.map((row) => String(row.id));
      for (const resultId of resultIds) {
        this.db.prepare('DELETE FROM workspace_apply_receipts WHERE result_id=?').run(resultId);
        this.db.prepare('DELETE FROM workspace_results WHERE id=?').run(resultId);
      }
      this.db.prepare('DELETE FROM workspace_bindings WHERE id=?').run(id);
      return { resultIds };
    });
  }

  /** Every snapshot this database has recorded. */
  snapshotIds(): string[] {
    return this.db
      .prepare('SELECT id FROM workspace_snapshots ORDER BY created_at,id')
      .all()
      .map((row) => String(row.id));
  }

  /**
   * Drops a snapshot's record when nothing in this database names it any more, and says whether it did.
   *
   * "Names" is every way this database can still need the bytes: a binding built from it, a result compared against
   * it, or — passed in, because they are files rather than rows — a removal record of one of its workspaces. The
   * check and the delete are one transaction, so a binding recorded meanwhile either lands first and keeps the
   * snapshot or finds the record gone and records it again.
   */
  dropUnusedSnapshot(snapshotId: string, namedByRemovals: ReadonlySet<string>): boolean {
    return this.port.transaction(() => {
      if (namedByRemovals.has(snapshotId)) return false;
      const named =
        this.db
          .prepare('SELECT 1 FROM workspace_bindings WHERE snapshot_id=? LIMIT 1')
          .get(snapshotId) ??
        this.db
          .prepare('SELECT 1 FROM workspace_results WHERE snapshot_id=? LIMIT 1')
          .get(snapshotId);
      if (named) return false;
      return (
        this.db.prepare('DELETE FROM workspace_snapshots WHERE id=?').run(snapshotId).changes > 0
      );
    });
  }

  releaseOperation(bindingId: string, token: string): void {
    this.db
      .prepare(
        'DELETE FROM workspace_operation_leases WHERE binding_id=? AND owner_pid=? AND token=?',
      )
      .run(workspaceId(bindingId), process.pid, token);
  }

  /* --------------------------------------------------------------------------------------------
   * Snapshots
   * ------------------------------------------------------------------------------------------ */

  recordSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    const id = workspaceId(snapshot.id);
    const row = {
      projectRoot: workspacePath(snapshot.projectRoot, 'project root'),
      sourceRoot: workspacePath(snapshot.sourceRoot, 'source root'),
      sourceHead: gitCommitId(snapshot.sourceHead, 'head'),
      baseCommit: gitCommitId(snapshot.baseCommit),
      baseTree: gitTreeId(snapshot.baseTree),
      manifestHash: workspaceDigest(snapshot.manifestHash, 'manifest hash'),
    };
    return this.port.transaction(() => {
      const existing = this.db
        .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM workspace_snapshots WHERE id=?`)
        .get(id);
      if (existing) {
        const found = existing as Record<string, unknown>;
        /**
         * A snapshot id is its manifest, so a second write of the same id with different contents is not an
         * update — it is two different inputs claiming one identity, and the durable result of accepting it
         * would be a child working from bytes nobody froze.
         */
        for (const key of ['baseCommit', 'baseTree', 'manifestHash', 'sourceHead'] as const) {
          if (String(found[key]) !== row[key])
            throw new WorkspaceFailure(
              'WORKSPACE_INTEGRITY',
              `Snapshot ${id} already exists with different contents`,
            );
        }
        return snapshotFromRow(found);
      }
      this.db
        .prepare(
          'INSERT INTO workspace_snapshots(id,project_root,source_root,source_head,base_commit,base_tree,manifest_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          row.projectRoot,
          row.sourceRoot,
          row.sourceHead,
          row.baseCommit,
          row.baseTree,
          row.manifestHash,
          snapshot.createdAt ?? new Date().toISOString(),
        );
      return snapshotFromRow(
        this.db
          .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM workspace_snapshots WHERE id=?`)
          .get(id) as Record<string, unknown>,
      );
    });
  }

  snapshot(id: string): WorkspaceSnapshot | null {
    const row = this.db
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM workspace_snapshots WHERE id=?`)
      .get(workspaceId(id));
    return row ? snapshotFromRow(row as Record<string, unknown>) : null;
  }

  snapshots(): WorkspaceSnapshot[] {
    return this.db
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM workspace_snapshots ORDER BY created_at,id`)
      .all()
      .map((row) => snapshotFromRow(row as Record<string, unknown>));
  }

  /* --------------------------------------------------------------------------------------------
   * Bindings
   * ------------------------------------------------------------------------------------------ */

  private bindingById(id: string): WorkspaceBinding | null {
    const row = this.db
      .prepare(`SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE id=?`)
      .get(id);
    return row ? bindingFromRow(row as Record<string, unknown>) : null;
  }

  byId(id: string): WorkspaceBinding | null {
    return this.bindingById(workspaceId(id));
  }

  bySession(sessionId: string): WorkspaceBinding | null {
    const row = this.db
      .prepare(`SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE session_id=?`)
      .get(workspaceId(sessionId));
    return row ? bindingFromRow(row as Record<string, unknown>) : null;
  }

  /** Removed workspaces whose removal is older than `before` (an ISO time), oldest first. */
  removedBefore(before: string): WorkspaceBinding[] {
    return this.db
      .prepare(
        `SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE state='removed' AND updated_at<? ORDER BY updated_at,id`,
      )
      .all(before)
      .map((row) => bindingFromRow(row as Record<string, unknown>));
  }

  byState(states: readonly WorkspaceState[]): WorkspaceBinding[] {
    if (!states.length) return [];
    const checked = states.map(workspaceState);
    const placeholders = checked.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE state IN (${placeholders}) ORDER BY created_at,id`,
      )
      .all(...checked)
      .map((row) => bindingFromRow(row as Record<string, unknown>));
  }

  /**
   * The managed workspaces of one project whose session no longer exists.
   *
   * `session_id IS NULL` is the durable record of that fact rather than an accident of the foreign key: a binding
   * keeps a nullable session reference precisely so a directory outlives the session that worked in it, and the
   * results exported from it are kept for the same reason. What the null cannot do by itself is say *which project*
   * the directory belongs to, because every other workspace read starts from a session and that session is gone —
   * so this is the one query that answers "what is still here" for a caller that owns the project.
   *
   * `removed` is excluded from cleanup inventory by default. Recovery callers can include it to rediscover the
   * durable removal records after a restart. `preparing` is included on purpose — a binding written before its directory
   * existed is still a directory this service may own, and an allocation interrupted by the deletion of its parent
   * session would otherwise be exactly the unaddressable row this query exists to surface.
   */
  orphaned(projectRoot: string, includeRemoved = false): WorkspaceBinding[] {
    const project = workspacePath(projectRoot, 'project root');
    return (
      this.db
        .prepare(
          `SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE session_id IS NULL AND kind='worktree' AND (? OR state<>'removed') ORDER BY created_at,id`,
        )
        .all(includeRemoved ? 1 : 0) as Record<string, unknown>[]
    )
      .map(bindingFromRow)
      .filter((binding) =>
        // Compared through the rule every ownership check uses: the caller, the row and the filesystem spell one
        // directory three ways, and only one of those spellings is the identity.
        samePath(binding.projectRoot, project),
      );
  }

  /**
   * What session `sessionId` should execute in, synthesising the pre-isolation answer when no row exists.
   *
   * A session written before this feature has no binding, and the honest reading of it is `shared`: it ran in its
   * own project directory, and everything it did — its journal entries, its undo records — was recorded against
   * that root. Fabricating a worktree for it would point its undo at a directory that never held the change.
   *
   * A binding whose `projectRoot` no longer matches the session's own project is refused rather than returned.
   * That comparison is the ownership check the rest of this feature leans on, so it is made here, once, at the
   * point every reader goes through.
   */
  resolve(sessionId: string): WorkspaceBinding {
    const session = this.port.sessionProject(sessionId);
    const row = this.bySession(sessionId);
    if (!row) return sharedBindingFor(sessionId, session);
    if (!samePath(row.projectRoot, session.workspace))
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        `Workspace binding ${row.id} belongs to a different project than session ${sessionId}`,
      );
    if (row.parentSessionId && row.parentSessionId !== session.parentSessionId)
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        `Workspace binding ${row.id} belongs to a different parent than session ${sessionId}`,
      );
    return row;
  }

  /**
   * Writes a new binding in `preparing`, which is the only state a caller may create.
   *
   * The state is not a parameter. A caller that could write `ready` directly would be able to publish a directory
   * that was never validated, and the point of the preparing row is that it exists *before* the directory does:
   * an interrupted allocation leaves a record naming the directory this service may still own, and nothing that
   * a tool can execute in.
   */
  createBinding(input: {
    id?: string;
    sessionId?: string | null;
    parentSessionId: string;
    projectRoot: string;
    executionRoot: string;
    repositoryRoot: string;
    kind: WorkspaceBinding['kind'];
    snapshotId?: string | null;
    baseCommit?: string | null;
    /** Allocation publishes its owner in the same transaction as the preparing row. */
    operationToken?: string;
  }): WorkspaceBinding {
    const id = workspaceId(input.id ?? randomUUID());
    const sessionId = optionalWorkspaceId(input.sessionId ?? null);
    return this.port.transaction(() => {
      if (this.bindingById(id))
        throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `Workspace binding ${id} already exists`);
      const parent = this.port.sessionProject(input.parentSessionId);
      const projectRoot = workspacePath(input.projectRoot, 'project root');
      if (!samePath(parent.workspace, projectRoot))
        throw new WorkspaceFailure(
          'WORKSPACE_IDENTITY_MISMATCH',
          'A workspace binding must belong to its parent session project',
        );
      if (sessionId) {
        const child = this.port.sessionProject(sessionId);
        if (!samePath(child.workspace, projectRoot))
          throw new WorkspaceFailure(
            'WORKSPACE_IDENTITY_MISMATCH',
            'A child session must share its parent workspace',
          );
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO workspace_bindings(id,session_id,parent_session_id,project_root,execution_root,repository_root,kind,snapshot_id,base_commit,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          sessionId,
          input.parentSessionId,
          projectRoot,
          workspacePath(input.executionRoot, 'execution root'),
          workspacePath(input.repositoryRoot, 'repository root'),
          input.kind,
          optionalWorkspaceId(input.snapshotId ?? null),
          input.baseCommit === null || input.baseCommit === undefined
            ? null
            : gitCommitId(input.baseCommit),
          'preparing',
          now,
          now,
        );
      if (input.operationToken)
        this.db
          .prepare(
            'INSERT INTO workspace_operation_leases(binding_id,owner_pid,token,created_at,owner_started_at,owner_started_token) VALUES(?,?,?,?,?,?)',
          )
          .run(
            id,
            process.pid,
            workspaceId(input.operationToken),
            now,
            ownStartedAt(),
            workspaceId(input.operationToken),
          );
      return this.bindingById(id)!;
    });
  }

  /**
   * Attaches the child session that will execute in this directory, and publishes the binding as `ready`.
   *
   * Both halves happen in one transaction because the two facts are one statement: "this session exists" and "its
   * directory is usable" are exactly what a tool resolves before it writes. The parent/child relationship is
   * checked here rather than trusted, so a binding cannot be attached to a session that is not the delegator's own
   * child, and a session that already has a binding is refused instead of silently re-pointed at another tree.
   */
  attach(input: { bindingId: string; childSessionId: string }): WorkspaceBinding {
    const bindingId = workspaceId(input.bindingId);
    const childSessionId = workspaceId(input.childSessionId);
    return this.port.transaction(() => {
      const binding = this.bindingById(bindingId);
      if (!binding)
        throw new WorkspaceFailure(
          'WORKSPACE_NOT_FOUND',
          `Unknown workspace binding: ${bindingId}`,
        );
      if (binding.sessionId && binding.sessionId !== childSessionId)
        throw new WorkspaceFailure(
          'WORKSPACE_INTEGRITY',
          `Workspace binding ${bindingId} is already attached to another session`,
        );
      const child = this.port.sessionProject(childSessionId);
      if (!samePath(child.workspace, binding.projectRoot))
        throw new WorkspaceFailure(
          'WORKSPACE_IDENTITY_MISMATCH',
          'A child session must share its parent workspace',
        );
      if (binding.parentSessionId && child.parentSessionId !== binding.parentSessionId)
        throw new WorkspaceFailure(
          'WORKSPACE_IDENTITY_MISMATCH',
          `Session ${childSessionId} is not a child of the binding's parent`,
        );
      const existing = this.bySession(childSessionId);
      if (existing && existing.id !== bindingId)
        throw new WorkspaceFailure(
          'WORKSPACE_INTEGRITY',
          `Session ${childSessionId} already executes in workspace ${existing.id}`,
        );
      const next = transitionTarget(binding.state, 'ready');
      this.db
        .prepare('UPDATE workspace_bindings SET session_id=?,state=?,updated_at=? WHERE id=?')
        .run(childSessionId, next, new Date().toISOString(), bindingId);
      return this.bindingById(bindingId)!;
    });
  }

  /**
   * Moves a binding's state, refusing a move the caller's belief does not match.
   *
   * `expect` is the caller's belief, and the compare-and-swap is what makes two concurrent passes safe: the
   * second one updates no row and is told its belief was stale rather than walking the row backwards. An illegal
   * *transition* (as opposed to a stale belief) is a programming error in the caller and is reported separately,
   * because the two need different fixes.
   */
  setState(input: {
    bindingId: string;
    expect: WorkspaceState | readonly WorkspaceState[];
    to: WorkspaceState;
    sessionId?: string | null;
  }): WorkspaceBinding {
    const bindingId = workspaceId(input.bindingId);
    const expected = (Array.isArray(input.expect) ? input.expect : [input.expect]).map(
      workspaceState,
    );
    const to = workspaceState(input.to);
    return this.port.transaction(() => {
      const binding = this.bindingById(bindingId);
      if (!binding)
        throw new WorkspaceFailure(
          'WORKSPACE_NOT_FOUND',
          `Unknown workspace binding: ${bindingId}`,
        );
      if (!expected.includes(binding.state))
        throw new WorkspaceFailure(
          'WORKSPACE_INTEGRITY',
          `Workspace ${bindingId} is ${binding.state}, not ${expected.join('/')}`,
          { bindingId, state: binding.state, expected },
        );
      if (binding.sessionId && ['archiving', 'removing', 'removed'].includes(to)) {
        const session = this.db
          .prepare('SELECT active_run FROM sessions WHERE id=?')
          .get(binding.sessionId);
        const lease = this.db
          .prepare('SELECT run_id FROM session_leases WHERE session_id=?')
          .get(binding.sessionId);
        if (session?.active_run || lease)
          throw new WorkspaceFailure(
            'WORKSPACE_BUSY',
            'Stop the workspace session before archiving or removing it',
          );
      }
      const next = transitionTarget(binding.state, to);
      const sessionId =
        input.sessionId === undefined ? binding.sessionId : optionalWorkspaceId(input.sessionId);
      this.db
        .prepare(
          'UPDATE workspace_bindings SET state=?,session_id=?,updated_at=? WHERE id=? AND state=?',
        )
        .run(next, sessionId, new Date().toISOString(), bindingId, binding.state);
      return this.bindingById(bindingId)!;
    });
  }

  /* --------------------------------------------------------------------------------------------
   * Results
   * ------------------------------------------------------------------------------------------ */

  recordResult(result: WorkspaceResult): WorkspaceResult {
    const id = workspaceId(result.id);
    const status = workspaceResultStatus(result.status);
    const paths = result.paths.map(relativeWorkspacePath);
    return this.port.transaction(() => {
      const existing = this.db
        .prepare(`SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE id=?`)
        .get(id);
      if (existing) {
        const found = resultFromRow(existing as Record<string, unknown>);
        // A result is frozen by construction: the same id with a different digest is two results claiming one
        // identity, and the parent's conflict check would then be comparing against bytes that never existed.
        if (
          found.digest !== workspaceDigest(result.digest) ||
          found.resultTree !== gitTreeId(result.resultTree, 'result tree')
        )
          throw new WorkspaceFailure(
            'WORKSPACE_INTEGRITY',
            `Result ${id} already exists with different contents`,
          );
        return found;
      }
      this.db
        .prepare(
          'INSERT INTO workspace_results(id,binding_id,child_session_id,parent_session_id,snapshot_id,comparison_tree,result_tree,digest,paths,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          workspaceId(result.bindingId),
          workspaceId(result.childSessionId),
          workspaceId(result.parentSessionId),
          workspaceId(result.snapshotId),
          gitTreeId(result.comparisonTree, 'comparison tree'),
          gitTreeId(result.resultTree, 'result tree'),
          workspaceDigest(result.digest),
          JSON.stringify(paths),
          status,
          result.createdAt ?? new Date().toISOString(),
        );
      return resultFromRow(
        this.db
          .prepare(`SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE id=?`)
          .get(id) as Record<string, unknown>,
      );
    });
  }

  result(id: string): WorkspaceResult | null {
    const row = this.db
      .prepare(`SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE id=?`)
      .get(workspaceId(id));
    return row ? resultFromRow(row as Record<string, unknown>) : null;
  }

  resultsForParent(parentSessionId: string): WorkspaceResult[] {
    return this.db
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE parent_session_id=? ORDER BY created_at,id`,
      )
      .all(workspaceId(parentSessionId))
      .map((row) => resultFromRow(row as Record<string, unknown>));
  }

  resultsForChild(childSessionId: string): WorkspaceResult[] {
    return this.db
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE child_session_id=? ORDER BY created_at,id`,
      )
      .all(workspaceId(childSessionId))
      .map((row) => resultFromRow(row as Record<string, unknown>));
  }

  /**
   * Every result one binding produced.
   *
   * A child session id is not enough to ask with: deleting a session keeps the result rows but nulls the binding's
   * own reference to that session, so the binding is the only key that survives both deletions. That is what makes
   * the record of an orphan's work readable after the sessions that produced and delegated it are gone.
   */
  resultsForBinding(bindingId: string): WorkspaceResult[] {
    return this.db
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE binding_id=? ORDER BY created_at,id`,
      )
      .all(workspaceId(bindingId))
      .map((row) => resultFromRow(row as Record<string, unknown>));
  }

  /**
   * Every result in one state, for the recovery pass that has to converge them.
   *
   * `applying` is the state this exists for: an import interrupted between its first and last file write is a record
   * whose outcome depends on bytes on disk, and only a pass over *all* of them at start-up can decide each one. A
   * single result id would not do, because the process that would have named it is gone.
   */
  resultsInState(status: WorkspaceResultStatus): WorkspaceResult[] {
    return this.db
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM workspace_results WHERE status=? ORDER BY created_at,id`,
      )
      .all(workspaceResultStatus(status))
      .map((row) => resultFromRow(row as Record<string, unknown>));
  }

  setResultStatus(input: {
    resultId: string;
    expect: WorkspaceResultStatus | readonly WorkspaceResultStatus[];
    to: WorkspaceResultStatus;
  }): WorkspaceResult {
    const resultId = workspaceId(input.resultId);
    const expected = (Array.isArray(input.expect) ? input.expect : [input.expect]).map(
      workspaceResultStatus,
    );
    const to = workspaceResultStatus(input.to);
    return this.port.transaction(() => {
      const current = this.result(resultId);
      if (!current)
        throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', `Unknown workspace result: ${resultId}`);
      if (!expected.includes(current.status))
        throw new WorkspaceFailure(
          'WORKSPACE_INTEGRITY',
          `Workspace result ${resultId} is ${current.status}, not ${expected.join('/')}`,
          { resultId, status: current.status, expected },
        );
      this.db
        .prepare('UPDATE workspace_results SET status=? WHERE id=? AND status=?')
        .run(to, resultId, current.status);
      return this.result(resultId)!;
    });
  }

  /**
   * Marks every importable result of one child as superseded, which is what a follow-up turn means for them.
   *
   * `applied` is left alone: a result the parent already imported is history, and rewriting it to `superseded`
   * would erase the answer to "what did this child's last accepted change consist of". Returns what changed so a
   * caller can publish it.
   */
  supersedeResults(childSessionId: string): WorkspaceResult[] {
    const child = workspaceId(childSessionId);
    return this.port.transaction(() => {
      const stale = this.resultsForChild(child).filter((result) => result.status === 'ready');
      for (const result of stale)
        this.db
          .prepare('UPDATE workspace_results SET status=? WHERE id=? AND status=?')
          .run('superseded', result.id, 'ready');
      return stale.map((result) => ({ ...result, status: 'superseded' as const }));
    });
  }

  /* --------------------------------------------------------------------------------------------
   * Import receipts
   * ------------------------------------------------------------------------------------------ */

  /**
   * The receipt of one import, keyed by result, digest and target binding.
   *
   * The key is the *statement* being repeated: the same result imported into the same directory with the same
   * bytes. A different target is a different import (a nested delegator legitimately imports the same child's work
   * somewhere else), and a different digest is different content, which is a new request rather than a repeat.
   */
  receipt(input: {
    resultId: string;
    digest: string;
    targetBindingId: string;
  }): WorkspaceApplyReceipt | null {
    const row = this.db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM workspace_apply_receipts WHERE result_id=? AND digest=? AND target_binding_id=?`,
      )
      .get(
        workspaceId(input.resultId),
        workspaceDigest(input.digest),
        workspaceId(input.targetBindingId),
      );
    return row ? workspaceApplyReceiptFrom(row as Record<string, unknown>) : null;
  }

  receiptsForResult(resultId: string): WorkspaceApplyReceipt[] {
    return this.db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM workspace_apply_receipts WHERE result_id=? ORDER BY created_at,id`,
      )
      .all(workspaceId(resultId))
      .map((row) => workspaceApplyReceiptFrom(row as Record<string, unknown>));
  }

  /**
   * Records an import receipt, or returns the one that already exists.
   *
   * `changeId` is the journal entry the import produced, so a repeated request can be answered with the change
   * that already exists instead of writing the same bytes again. Writing the receipt and creating the change
   * belong to the same transaction at the call site — this method is called inside it, not after it.
   */
  removeReceipt(id: string, changeId: string): void {
    this.db
      .prepare('DELETE FROM workspace_apply_receipts WHERE id=? AND change_id=?')
      .run(workspaceId(id), workspaceId(changeId));
  }

  recordReceipt(input: {
    resultId: string;
    digest: string;
    targetBindingId: string;
    changeId: string;
  }): WorkspaceApplyReceipt {
    const key = {
      resultId: workspaceId(input.resultId),
      digest: workspaceDigest(input.digest),
      targetBindingId: workspaceId(input.targetBindingId),
    };
    return this.port.transaction(() => {
      const existing = this.receipt(key);
      if (existing) return existing;
      const id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO workspace_apply_receipts(id,result_id,digest,target_binding_id,change_id,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          id,
          key.resultId,
          key.digest,
          key.targetBindingId,
          workspaceId(input.changeId),
          new Date().toISOString(),
        );
      return workspaceApplyReceiptFrom(
        this.db
          .prepare(`SELECT ${RECEIPT_COLUMNS} FROM workspace_apply_receipts WHERE id=?`)
          .get(id) as Record<string, unknown>,
      );
    });
  }
}

/**
 * The binding a session had before isolation existed.
 *
 * Synthesised on read rather than written into the database: a migration that inserted a row per historical
 * session would be inventing a record this service never made, and would then have to decide what to do with a
 * session whose project directory has since moved. A synthesised binding says exactly what is true — the session
 * executes in its own project, shared with anyone else working there — and leaves no state behind to reconcile.
 */
export function sharedBindingFor(
  sessionId: string,
  session: { workspace: string; parentSessionId: string | null },
): WorkspaceBinding {
  return {
    // Prefixed so it can never collide with a generated binding id, and stable across processes because it is
    // derived from the session rather than random: two readers of one session must agree about which binding it
    // is, or a receipt recorded by one would not be found by the other.
    id: `shared:${sessionId}`,
    sessionId,
    parentSessionId: session.parentSessionId,
    projectRoot: session.workspace,
    executionRoot: session.workspace,
    repositoryRoot: session.workspace,
    kind: 'shared',
    snapshotId: null,
    baseCommit: null,
    state: 'ready',
  };
}

/** Whether a binding is one of the synthesised shared ones rather than a row this service wrote. */
export function isSyntheticBinding(binding: WorkspaceBinding): boolean {
  return binding.id.startsWith('shared:');
}

/**
 * Whether this binding has a durable row that `attach` could move.
 *
 * A shared binding does not, and that is not a detail of the id's spelling: a *historical* session's binding is
 * synthesised on read, so there is no `preparing` row to advance to `ready` and no directory this service created.
 * A caller that tried to attach one would be asking the store to finish an allocation that never happened, which is
 * exactly what it answers with `WORKSPACE_NOT_FOUND`.
 */
export function isDurableBinding(binding: WorkspaceBinding): boolean {
  return !isSyntheticBinding(binding);
}

/**
 * The transition, checked before it is written.
 *
 * `canTransition` is the protocol's table; a refusal here names both ends, because "preparing -> applied" is a
 * bug in a caller and the message has to say which caller state it was actually in.
 */
function transitionTarget(from: WorkspaceState, to: WorkspaceState): WorkspaceState {
  if (!canTransition(from, to))
    throw new WorkspaceFailure(
      'WORKSPACE_INTEGRITY',
      `Invalid workspace state transition: ${from} -> ${to}`,
      { from, to },
    );
  return to;
}

/** The snapshot projection, kept beside the binding projection so the two stay one shape. */
function snapshotFromRow(row: Record<string, unknown>): WorkspaceSnapshot {
  return {
    id: workspaceId(row.id),
    projectRoot: workspacePath(row.projectRoot, 'project root'),
    sourceRoot: workspacePath(row.sourceRoot, 'source root'),
    sourceHead: gitCommitId(row.sourceHead, 'head'),
    baseCommit: gitCommitId(row.baseCommit),
    baseTree: gitTreeId(row.baseTree),
    manifestHash: workspaceDigest(row.manifestHash, 'manifest hash'),
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
  };
}
