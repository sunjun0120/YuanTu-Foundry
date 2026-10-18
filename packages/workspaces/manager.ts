import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, rmdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { SessionStore } from '../storage/sqlite.ts';
import {
  WorkspaceFailure,
  type WorkspaceBinding,
  type WorkspaceSnapshot,
} from '../protocol/workspaces.ts';
import { canonicalKey, isWithin, realPathOrNull, samePath } from '../platform/workspace-paths.ts';
import {
  isManagedWorktreePath,
  linkedWorktreeName,
  managedWorktreeRoot,
  pathExists,
  plainFileInfo,
  registeredWorktrees,
  repositoryIdentity,
  repositoryReadiness,
  runWorkspaceGit,
  withRepositoryLock,
  workspaceGit,
  writeFileExact,
  type RepositoryIdentity,
} from './git.ts';
import {
  entryBytes,
  collectWorkingTree,
  freezeSnapshot,
  readManifest,
  snapshotRef,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from './snapshot.ts';

/**
 * The workspace service: what owns the directories a sub-agent works in.
 *
 * The shape of the collaboration is one sentence. A delegation *freezes* one baseline, *allocates* a directory per
 * child from it, and the parent *imports* what each child produced — and every step of that is durable before it
 * is observable, so a process that dies in the middle leaves something a later process can finish or clean up
 * rather than an orphan directory nobody owns.
 *
 * Three rules are load bearing:
 *
 * - **The baseline is decided once per call, not once per child.** Children that were queued behind the
 *   concurrency cap must see the same bytes as the ones that started immediately, so the snapshot travels with the
 *   task rather than being read again when the child happens to start.
 * - **A directory exists before the session that will use it, and a session is never created without one.** A
 *   child session with no usable directory is a run whose writes have nowhere to go; a directory with no session is
 *   a record this service can still collect.
 * - **Identity is proven, never assumed.** The repository is resolved through Git's own `common-dir` and worktree
 *   registry, and a directory this service did not create — or one whose `.git` link points somewhere else — is
 *   never adopted and never recursively removed.
 */

export interface WorkspaceManagerOptions {
  store: SessionStore;
  /**
   * Whether managed Git metadata operations are permitted under the deployment's execution policy.
   *
   * The plan's rule, in one function: worktree management is controlled infrastructure work, and a native sandbox
   * policy that cannot say whether it can safely manage Git metadata must fail loudly (`WORKSPACE_POLICY_UNSUPPORTED`)
   * instead of quietly running outside the policy it was given. A host policy is the only one that currently
   * answers yes.
   */
  metadataWritesAllowed?: () => boolean;
  /** Where the refusal is reported, so the reason a policy blocked isolation is not lost in a log nobody reads. */
  onDiagnostic?: (message: string) => void;
}

/** The mode a task actually asked for, after `auto` is resolved against its role. */
export function resolveWorkspaceKind(
  mode: 'auto' | 'shared' | 'worktree',
  role: 'explore' | 'general',
): 'shared' | 'worktree' {
  if (mode === 'shared') return 'shared';
  if (mode === 'worktree') return 'worktree';
  // `auto`: a read-only child cannot change anything, so a copy of the tree would cost disk and buys no
  // protection; anything that may write gets its own directory.
  return role === 'explore' ? 'shared' : 'worktree';
}

export class WorkspaceManager {
  private readonly store: SessionStore;
  private readonly options: WorkspaceManagerOptions;
  constructor(options: WorkspaceManagerOptions) {
    this.store = options.store;
    this.options = options;
  }
  private async withOperation<T>(
    bindingId: string,
    signal: AbortSignal,
    work: (token: string) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const token = this.store.claimWorkspaceOperation(bindingId);
    try {
      return await work(token);
    } finally {
      this.store.releaseWorkspaceOperation(bindingId, token);
    }
  }

  /** Whether this deployment permits the Git metadata operations a worktree needs. */
  private requireMetadataWrites(): void {
    const allowed = this.options.metadataWritesAllowed?.() ?? true;
    if (allowed) return;
    // Explicit and loud: the plan forbids silently degrading to a shared workspace or opening a wider policy,
    // because either would present a lower level of protection as the one that was asked for.
    throw new WorkspaceFailure(
      'WORKSPACE_POLICY_UNSUPPORTED',
      'Managed worktrees currently require host execution with workspace-write file access; the current session policy does not permit Git metadata writes. Read-only exploration can use auto or shared mode',
    );
  }

  private diagnostic(message: string): void {
    this.options.onDiagnostic?.(message);
  }

  /**
   * The binding a session executes in.
   *
   * A session with no binding reads as `shared` over its own project: that is literally what it did before this
   * feature existed, and it keeps every historical session's journal and undo pointing at the directory that holds
   * the change.
   */
  resolve(sessionId: string): WorkspaceBinding {
    return this.store.workspaceBinding(sessionId);
  }

  /** The binding a row names, for a caller that has an id rather than a session. */
  byId(bindingId: string): WorkspaceBinding | null {
    return this.store.workspaceById(bindingId);
  }

  /**
   * The managed directories of one project whose session is gone.
   *
   * The recovery half of the rule the allocation path follows: a directory exists before the session that will use
   * it, so it has to stay reachable after that session is deleted. Nothing is acted on here — a caller names one
   * entry by id, and archiving, removing or restoring it then goes through the ordinary snapshot-before-delete
   * path, which is what keeps "the session is gone" from becoming "the work is gone".
   */
  orphaned(projectRoot: string, includeRemoved = false): WorkspaceBinding[] {
    return this.store.orphanedWorkspaceBindings(projectRoot, includeRemoved);
  }

  /** What a child session of the given role should execute in, as the mode decides. */
  kindFor(
    mode: 'auto' | 'shared' | 'worktree',
    role: 'explore' | 'general',
  ): 'shared' | 'worktree' {
    return resolveWorkspaceKind(mode, role);
  }

  /**
   * Freezes the delegator's directory once, for the whole batch.
   *
   * Called before any child is scheduled, so a failure here costs a refusal rather than a set of half-started
   * children, and the returned snapshot is handed to every task in the call — including the ones that run later.
   */
  async freeze(input: {
    parentSessionId: string;
    sourceBinding: WorkspaceBinding;
    signal: AbortSignal;
  }): Promise<WorkspaceSnapshot> {
    this.requireMetadataWrites();
    const parent = this.store.get(input.parentSessionId);
    const source = input.sourceBinding.executionRoot;
    const snapshot = await freezeSnapshot({
      projectRoot: parent.workspace,
      sourceRoot: source,
      signal: input.signal,
    });
    // Durable before it is used: a child allocated from a snapshot whose record was lost would have a directory
    // nothing could explain or restore.
    const stored = this.store.recordWorkspaceSnapshot(snapshot);
    return stored;
  }

  /**
   * Allocates one directory for one child, from a snapshot the batch already froze.
   *
   * The `preparing` row is written *before* the directory is created, which is what makes an interruption between
   * the two recoverable in the only direction that matters: a row with no directory can be retried or removed, and
   * a directory with no row could not be attributed to anything.
   */
  async allocate(input: {
    parentSessionId: string;
    /** The per-run task id, kept only for diagnostics; a model-supplied name is never a path. */
    taskId: string;
    snapshot: WorkspaceSnapshot;
    signal: AbortSignal;
  }): Promise<WorkspaceBinding> {
    this.requireMetadataWrites();
    const { signal } = input;
    signal.throwIfAborted();
    const parent = this.store.get(input.parentSessionId);
    const identity = await repositoryIdentity(input.snapshot.sourceRoot, signal);
    if (!identity)
      throw new WorkspaceFailure(
        'WORKSPACE_NOT_A_REPOSITORY',
        'The delegation source is no longer inside a Git working tree',
      );
    if (
      !samePath(identity.repositoryRoot, await this.repositoryOfProject(parent.workspace, signal))
    )
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'The workspace snapshot belongs to a different repository than this session',
      );
    /**
     * One generator, not two: the binding's id is minted here and the directory is named after it, so a recovery
     * pass finds a directory by *record* rather than by pattern. A second random value for the path would be a name
     * nothing durable explains.
     */
    const bindingId = randomUUID();
    const operationToken = randomUUID();
    const target = managedWorktreeRoot(identity.repositoryRoot, bindingId);
    const binding = this.store.createWorkspaceBinding({
      id: bindingId,
      parentSessionId: input.parentSessionId,
      projectRoot: parent.workspace,
      executionRoot: target,
      repositoryRoot: identity.repositoryRoot,
      kind: 'worktree',
      snapshotId: input.snapshot.id,
      baseCommit: input.snapshot.baseCommit,
      operationToken,
    });
    try {
      await this.createWorktree(identity, target, input.snapshot, signal);
      return this.store.setWorkspaceState({
        bindingId: binding.id,
        expect: 'preparing',
        to: 'ready',
      });
    } catch (error) {
      this.store.setWorkspaceState({ bindingId: binding.id, expect: 'preparing', to: 'blocked' });
      throw error;
    } finally {
      this.store.releaseWorkspaceOperation(binding.id, operationToken);
    }
  }

  /** Resolves which repository a project directory belongs to, refusing one that is not a working tree. */
  private async repositoryOfProject(projectRoot: string, signal?: AbortSignal): Promise<string> {
    const identity = await repositoryIdentity(projectRoot, signal);
    if (!identity)
      throw new WorkspaceFailure(
        'WORKSPACE_NOT_A_REPOSITORY',
        `${projectRoot} is not inside a Git working tree, so it cannot be isolated`,
      );
    return identity.repositoryRoot;
  }

  /**
   * Creates and fills one managed worktree.
   *
   * `git worktree add --detach --no-checkout` is the registration: detached because a child must not take a branch
   * the user might want, and `--no-checkout` because the fill below writes the *snapshot's* bytes rather than the
   * baseline commit's tree — which is what carries the uncommitted work the delegation was about, and what avoids
   * every checkout filter and hook in the repository.
   */
  private async createWorktree(
    identity: RepositoryIdentity,
    target: string,
    snapshot: WorkspaceSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const manifest = await this.manifestFor(identity.repositoryRoot, snapshot.id);
    if (!manifest)
      throw new WorkspaceFailure(
        'WORKSPACE_MISSING',
        `The snapshot metadata for ${snapshot.id} is no longer on disk`,
      );
    await withRepositoryLock(identity.repositoryRoot, async () => {
      await mkdir(path.dirname(target), { recursive: true });
      /**
       * A registration whose directory is gone is cleared first.
       *
       * This is the state a crash leaves: the row and Git's registry both still exist, the directory does not, and
       * `worktree add` refuses to reuse the name. Pruning removes registrations whose directory is missing — it
       * cannot touch a worktree that is actually there, which is why it is safe to run inside the lock and why it
       * is scoped to the one target rather than the whole repository.
       */
      if (await pathExists(target)) {
        throw new WorkspaceFailure(
          'WORKSPACE_INTEGRITY',
          `The workspace directory already exists: ${target}`,
          { path: target },
        );
      }
      await runWorkspaceGit(['worktree', 'prune'], { cwd: identity.repositoryRoot, signal });
      await runWorkspaceGit(
        ['worktree', 'add', '--detach', '--no-checkout', target, snapshot.baseCommit],
        {
          cwd: identity.repositoryRoot,
          signal,
        },
      );
    });
    await this.fillWorktree(identity, target, manifest, signal);
  }

  /** The snapshot's stored manifest, which is also its content: a snapshot without one is not usable. */
  private async manifestFor(
    repositoryRoot: string,
    snapshotId: string,
  ): Promise<SnapshotManifest | null> {
    return await readManifest(repositoryRoot, snapshotId);
  }

  /**
   * Writes the snapshot's files into a worktree and removes what the baseline does not have.
   *
   * Removal matters as much as writing: a worktree registered at a commit brings that commit's tree with it for
   * anything `--no-checkout` did not skip, and a file the snapshot does not contain would otherwise appear in the
   * child's directory as content nobody froze — which the result export would then attribute to the child.
   */
  private async fillWorktree(
    identity: RepositoryIdentity,
    target: string,
    manifest: SnapshotManifest,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
    await this.removeUnexpected(identity, target, expected, '', signal);
    for (const entry of manifest.files) {
      signal.throwIfAborted();
      const absolute = path.join(target, ...entry.path.split('/'));
      const info = await plainFileInfo(absolute);
      if (!info.ok && info.reason !== 'missing')
        throw new WorkspaceFailure(
          'WORKSPACE_UNSUPPORTED_FILE_TYPE',
          `A worktree path is not a plain file: ${entry.path}`,
        );
      await writeFileExact(absolute, entryBytes(entry));
    }
  }

  /**
   * Walks a freshly registered worktree and removes whatever the snapshot does not name.
   *
   * Bounded to paths Git registered for this worktree and skipping `.git` and `.yuantu`, so the recursion can never
   * reach a directory this service does not own. An empty directory the baseline does not have is removed too:
   * leaving it would make an empty `src/` look like something the child created.
   */
  private async removeUnexpected(
    identity: RepositoryIdentity,
    target: string,
    expected: ReadonlyMap<string, SnapshotManifestEntry>,
    prefix: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let names: string[];
    try {
      names = await readdir(path.join(target, ...prefix.split('/').filter(Boolean)));
    } catch {
      return;
    }
    for (const name of names) {
      if (!prefix && (name === '.git' || name === '.yuantu')) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(target, ...relative.split('/'));
      const info = await plainFileInfo(absolute);
      if (info.ok) {
        if (!expected.has(relative)) await rm(absolute, { force: true });
        continue;
      }
      if (info.reason === 'directory') {
        await this.removeUnexpected(identity, target, expected, relative, signal);
        // Only an empty directory is removed, so a directory the child will need but has not filled yet stays.
        await rmdir(absolute).catch(() => {});
        continue;
      }
      // A symbolic link or a special file in a fresh worktree is not something this service created, so it is left
      // alone: removing it would be acting on a path whose identity was never established.
    }
  }

  /**
   * Attaches the child session, which is the moment a binding becomes executable.
   *
   * The store makes the two facts one transaction and re-checks the parent/child relationship, so a binding cannot
   * be attached to a session that is not its delegator's own child.
   */
  attach(input: { bindingId: string; childSessionId: string }): WorkspaceBinding {
    return this.store.attachWorkspaceBinding(input);
  }

  /**
   * Proves a binding still describes what it says it does.
   *
   * Called before a child runs and again on cold recovery, because "the row says this directory" and "this
   * directory is still this service's worktree of this repository" are different statements, and only the second
   * one is safe to write into. A directory that was replaced, deleted, or re-pointed at another repository's
   * metadata is reported as `blocked` with the reason, and never falls back to the parent's directory.
   */
  async validate(binding: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (binding.kind === 'shared') {
      const project = this.store.get(binding.sessionId ?? binding.parentSessionId ?? '').workspace;
      if (!samePath(project, binding.projectRoot))
        throw new WorkspaceFailure(
          'WORKSPACE_IDENTITY_MISMATCH',
          'The binding no longer belongs to the session project',
        );
      return;
    }
    const target = binding.executionRoot;
    const real = realPathOrNull(target);
    if (!real)
      throw new WorkspaceFailure(
        'WORKSPACE_MISSING',
        `The isolated workspace directory is gone: ${target}`,
      );
    if (!samePath(real, target))
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        `The isolated workspace directory is reached through a link: ${target}`,
      );
    const identity = await repositoryIdentity(target, signal);
    if (!identity)
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        `The isolated workspace is no longer a Git working tree: ${target}`,
      );
    if (!samePath(identity.repositoryRoot, binding.repositoryRoot))
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'The isolated workspace now belongs to a different repository',
      );
    if (!isManagedWorktreePath(identity.repositoryRoot, target))
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'The isolated workspace is outside the directory layout this service manages',
      );
    const name = await linkedWorktreeName(identity, target);
    if (!name)
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'The .git link of the isolated workspace does not point back at this repository',
      );
    /**
     * Git's own registry, which is the half a record cannot supply.
     *
     * A `.git` file and a metadata directory can be written by anything; what makes a directory a worktree of *this*
     * repository is that `git worktree list` reports it, registered and not prunable. Readiness is re-checked for
     * the same reason: a checkout that became sparse or acquired a conflict after allocation is a working tree a
     * result can no longer be computed against.
     */
    const registered = await registeredWorktrees(identity, signal);
    const entry = registered.find((candidate) => samePath(candidate.path, target));
    if (!entry || entry.prunable)
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'Git does not report this directory as a registered worktree of this repository',
        { path: target },
      );
    if (entry.branch)
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        `An isolated workspace must be detached, but ${name} is on ${entry.branch}`,
      );
    const readiness = await repositoryReadiness(identity, signal);
    if (readiness.unmerged.length || readiness.sparse)
      throw new WorkspaceFailure(
        readiness.sparse ? 'WORKSPACE_SPARSE_UNSUPPORTED' : 'WORKSPACE_UNMERGED_INDEX',
        'The isolated workspace is in a state a result cannot be computed against',
      );
  }

  /**
   * Moves a binding to `blocked` after a validation failure, keeping the directory.
   *
   * The directory is deliberately kept: it may hold the only copy of a child's unfinished work, and the plan's
   * rule is that nothing is deleted without a verified snapshot and a proven ownership.
   */
  block(bindingId: string, reason: string): WorkspaceBinding {
    this.diagnostic(`workspace ${bindingId} blocked: ${reason}`);
    return this.store.setWorkspaceState({
      bindingId,
      expect: ['preparing', 'ready', 'blocked'],
      to: 'blocked',
    });
  }

  /**
   * Brings durable state and the filesystem back into agreement after a restart.
   *
   * Bounded on purpose: it resolves *this service's own* leftovers — a `preparing` row whose directory never
   * appeared, a `blocked` row whose directory has since gone — and it never replays a command, a model request or
   * an approved external operation. An `applying` result is left for the results service, which is the only thing
   * that knows how to read a half-written import.
   */
  async reconcile(signal: AbortSignal): Promise<void> {
    for (const binding of this.store.workspaceBindingsByState(['archiving', 'removing'])) {
      signal.throwIfAborted();
      try {
        await this.withOperation(binding.id, signal, async () => {
          const current = this.store.workspaceById(binding.id)!;
          if (current.state !== 'archiving' && current.state !== 'removing') return;
          this.requireIdle(current);
          const finishedRemoval =
            current.state === 'removing' &&
            !(await pathExists(current.executionRoot)) &&
            (await this.removalSnapshot(current)) !== null;
          this.store.setWorkspaceState({
            bindingId: current.id,
            expect: current.state,
            to: finishedRemoval ? 'removed' : 'blocked',
          });
        });
      } catch (error) {
        this.diagnostic(
          `workspace ${binding.id} recovery deferred: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    signal.throwIfAborted();
    for (const binding of this.store.workspaceBindingsByState(['preparing'])) {
      try {
        await this.withOperation(binding.id, signal, async () => {
          const current = this.store.workspaceById(binding.id)!;
          if (current.state !== 'preparing' || (await pathExists(current.executionRoot))) return;
          this.requireIdle(current);
          this.store.setWorkspaceState({
            bindingId: current.id,
            expect: 'preparing',
            to: 'removed',
          });
        });
      } catch (error) {
        this.diagnostic(
          `workspace ${binding.id} preparation recovery deferred: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const binding of this.store.workspaceBindingsByState(['ready', 'blocked'])) {
      signal.throwIfAborted();
      if (binding.kind === 'shared') continue;
      try {
        await this.withOperation(binding.id, signal, async () => {
          const current = this.store.workspaceById(binding.id)!;
          if (current.state !== 'ready' && current.state !== 'blocked') return;
          this.requireIdle(current);
          try {
            await this.validate(current, signal);
          } catch (error) {
            if (current.state === 'ready')
              this.block(current.id, error instanceof Error ? error.message : String(error));
            else
              this.diagnostic(
                `workspace ${current.id} is still blocked: ${error instanceof Error ? error.message : String(error)}`,
              );
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostic(`workspace ${binding.id} validation deferred: ${reason}`);
      }
    }
  }

  /**
   * Archives a workspace: its results are frozen and its git objects referenced, and only then is the directory
   * reconsidered.
   *
   * The order is the promise. A failure while freezing what the child produced leaves the original directory in
   * place, because an archived workspace whose results were not saved is a workspace whose work was destroyed to
   * save disk.
   */
  async archive(bindingId: string, signal: AbortSignal): Promise<void> {
    this.requireMetadataWrites();
    return this.withOperation(bindingId, signal, () => this.archiveOwned(bindingId, signal));
  }
  private async archiveOwned(bindingId: string, signal: AbortSignal): Promise<void> {
    this.requireMetadataWrites();
    signal.throwIfAborted();
    const binding = this.store.workspaceById(bindingId);
    if (!binding)
      throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', `Unknown workspace binding: ${bindingId}`);
    if (binding.kind === 'shared') return;
    this.requireIdle(binding);
    this.store.setWorkspaceState({ bindingId, expect: ['ready', 'blocked'], to: 'archiving' });
    try {
      await this.preserveObjects(binding, signal);
    } catch (error) {
      // Back to where it was, with the directory untouched: an archive that could not save the work must not
      // proceed to the step that would remove it.
      this.store.setWorkspaceState({ bindingId, expect: 'archiving', to: 'blocked' });
      throw error;
    }
    this.store.setWorkspaceState({ bindingId, expect: 'archiving', to: 'archived' });
  }

  private requireIdle(binding: WorkspaceBinding): void {
    if (
      binding.sessionId &&
      (this.store.get(binding.sessionId).activeRun || this.store.leaseOf(binding.sessionId))
    )
      throw new WorkspaceFailure(
        'WORKSPACE_BUSY',
        'Stop the workspace session before archiving or removing it',
      );
  }

  private removalRecord(binding: WorkspaceBinding): string {
    return path.join(binding.repositoryRoot, '.yuantu', 'workspace-removals', `${binding.id}.json`);
  }

  private async removalSnapshot(binding: WorkspaceBinding): Promise<WorkspaceSnapshot | null> {
    const file = this.removalRecord(binding);
    const info = await plainFileInfo(file);
    if (!info.ok && info.reason === 'missing') return null;
    if (
      !info.ok ||
      info.size > 4096 ||
      !samePath(path.dirname(file), realPathOrNull(path.dirname(file)) ?? '')
    )
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'Workspace removal metadata is not a plain owned file',
      );
    let record;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Workspace removal metadata is invalid');
    }
    const saved =
      typeof record?.snapshotId === 'string'
        ? this.store.workspaceSnapshot(record.snapshotId)
        : null;
    // Content-addressed snapshots may originate in the parent or another child with identical bytes.
    // The removal record carries this operation's source identity separately from the content identity.
    if (
      record?.bindingId !== binding.id ||
      !samePath(record?.executionRoot ?? '', binding.executionRoot) ||
      !saved ||
      !samePath(saved.projectRoot, binding.projectRoot)
    )
      throw new WorkspaceFailure(
        'WORKSPACE_INTEGRITY',
        'Workspace removal record does not match this binding',
      );
    return saved;
  }

  /** Remove only a proven archived worktree, after saving every source file in a recoverable snapshot. */
  async remove(bindingId: string, signal: AbortSignal): Promise<void> {
    this.requireMetadataWrites();
    return this.withOperation(bindingId, signal, (token) =>
      this.removeOwned(bindingId, signal, token),
    );
  }
  private async removeOwned(bindingId: string, signal: AbortSignal, token: string): Promise<void> {
    this.requireMetadataWrites();
    signal.throwIfAborted();
    const binding = this.store.workspaceById(bindingId);
    if (!binding || binding.kind !== 'worktree')
      throw new WorkspaceFailure(
        'WORKSPACE_NOT_FOUND',
        'Only a managed isolated workspace can be removed',
      );
    if (binding.state === 'removed') return;
    this.requireIdle(binding);
    this.store.setWorkspaceState({ bindingId, expect: 'archived', to: 'removing' });
    try {
      await this.validate(binding, signal);
      const snapshot = await freezeSnapshot({
        projectRoot: binding.projectRoot,
        sourceRoot: binding.executionRoot,
        signal,
      });
      const manifest = await readManifest(binding.repositoryRoot, snapshot.id);
      if (!manifest)
        throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Removal snapshot is missing');
      const expected = new Set(manifest.files.map((entry) => entry.path));
      const assertPreserved = async () => {
        const names = (
          await workspaceGit(['ls-files', '--cached', '--others', '-z'], {
            cwd: binding.executionRoot,
            signal,
          })
        )
          .split('\0')
          .filter(Boolean);
        const omitted: string[] = [];
        for (const name of names) {
          if (expected.has(name)) continue;
          const info = await plainFileInfo(path.join(binding.executionRoot, ...name.split('/')));
          if (info.ok || info.reason !== 'missing') omitted.push(name);
        }
        if (omitted.length)
          throw new WorkspaceFailure(
            'WORKSPACE_UNSUPPORTED_FILE_TYPE',
            `Cleanup refused: files excluded from the snapshot must be preserved separately: ${omitted.slice(0, 10).join(', ')}`,
          );
      };
      await assertPreserved();
      this.store.recordWorkspaceSnapshot(snapshot);
      const record = this.removalRecord(binding);
      await this.removalSnapshot(binding);
      await mkdir(path.dirname(record), { recursive: true });
      if (!samePath(path.dirname(record), realPathOrNull(path.dirname(record)) ?? ''))
        throw new WorkspaceFailure(
          'WORKSPACE_IDENTITY_MISMATCH',
          'Removal metadata directory was replaced',
        );
      const temporary = `${record}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            bindingId,
            executionRoot: binding.executionRoot,
            snapshotId: snapshot.id,
          }),
          { flag: 'wx' },
        );
        await rename(temporary, record);
      } finally {
        await rm(temporary, { force: true });
      }
      await withRepositoryLock(binding.repositoryRoot, async () => {
        await this.validate(binding, signal);
        await assertPreserved();
        const current = await collectWorkingTree(binding.executionRoot, signal);
        const fingerprint = (entries: SnapshotManifestEntry[]) =>
          JSON.stringify(entries.map(({ path, mode, sha256 }) => ({ path, mode, sha256 })));
        if (fingerprint(current) !== fingerprint(manifest.files))
          throw new WorkspaceFailure(
            'WORKSPACE_SOURCE_CHANGED',
            'Workspace changed after its removal snapshot was saved',
          );
        this.store.assertWorkspaceOperation(bindingId, token);
        if (this.store.workspaceById(bindingId)?.state !== 'removing')
          throw new WorkspaceFailure('WORKSPACE_BUSY', 'Workspace state changed during cleanup');
        this.requireIdle(binding);
        await runWorkspaceGit(['worktree', 'remove', '--force', binding.executionRoot], {
          cwd: binding.repositoryRoot,
          signal,
        });
      });
      this.store.setWorkspaceState({ bindingId, expect: 'removing', to: 'removed' });
    } catch (error) {
      this.store.setWorkspaceState({ bindingId, expect: 'removing', to: 'blocked' });
      throw error;
    }
  }

  /** Keeps every object a workspace's HEAD reaches, so its work survives the directory being removed. */
  private async preserveObjects(binding: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    // The baseline is already referenced by the snapshot's own ref. What a child added on top is not, so the
    // directory's HEAD is referenced under the binding's id before anything is removed.
    const head = await workspaceGit(['rev-parse', 'HEAD'], {
      cwd: binding.executionRoot,
      signal,
    }).catch(() => '');
    if (!head) return;
    await withRepositoryLock(binding.repositoryRoot, async () => {
      await runWorkspaceGit(['update-ref', `refs/yuantu/workspaces/${binding.id}`, head], {
        cwd: binding.repositoryRoot,
        signal,
      });
    });
  }

  /**
   * Recreates an archived or removed workspace from its own record.
   *
   * The identity of the workspace does not change: the same binding id, the same baseline, the same parent. What
   * changes is the directory, which is rebuilt from the frozen input — so a restore can never adopt a directory
   * somebody else created in the meantime, and cannot silently become a different workspace.
   */
  async restore(bindingId: string, signal: AbortSignal): Promise<WorkspaceBinding> {
    this.requireMetadataWrites();
    return this.withOperation(bindingId, signal, () => this.restoreOwned(bindingId, signal));
  }
  private async restoreOwned(bindingId: string, signal: AbortSignal): Promise<WorkspaceBinding> {
    this.requireMetadataWrites();
    let binding = this.store.workspaceById(bindingId);
    if (!binding)
      throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', `Unknown workspace binding: ${bindingId}`);
    if (binding.kind === 'shared') return binding;
    this.requireIdle(binding);
    if (binding.state === 'removing' || binding.state === 'archiving')
      binding = this.store.setWorkspaceState({ bindingId, expect: binding.state, to: 'blocked' });
    if (!binding.snapshotId || !binding.baseCommit)
      throw new WorkspaceFailure(
        'WORKSPACE_INTEGRITY',
        'The binding records no snapshot to restore from',
      );
    const identity = await repositoryIdentity(binding.repositoryRoot, signal);
    if (!identity)
      throw new WorkspaceFailure(
        'WORKSPACE_NOT_A_REPOSITORY',
        `The repository no longer holds a working tree: ${binding.repositoryRoot}`,
      );
    let snapshot: WorkspaceSnapshot = {
      id: binding.snapshotId,
      projectRoot: binding.projectRoot,
      sourceRoot: binding.projectRoot,
      sourceHead:
        (await this.manifestFor(identity.repositoryRoot, binding.snapshotId))?.sourceHead ?? '',
      baseCommit: binding.baseCommit,
      baseTree:
        (await this.manifestFor(identity.repositoryRoot, binding.snapshotId))?.baseTree ?? '',
      manifestHash: binding.snapshotId,
    };
    const saved = await this.removalSnapshot(binding);
    if (saved) snapshot = saved;
    const previous = binding.state;
    this.store.setWorkspaceState({ bindingId, expect: previous, to: 'preparing' });
    if (await pathExists(binding.executionRoot)) {
      // A directory is already there. It is only reused when its identity checks out; otherwise the restore stops
      // rather than replacing something this service did not create.
      try {
        await this.validate({ ...binding, state: 'ready' }, signal);
        return this.store.setWorkspaceState({ bindingId, expect: 'preparing', to: 'ready' });
      } catch (error) {
        this.store.setWorkspaceState({ bindingId, expect: 'preparing', to: 'blocked' });
        throw error;
      }
    }
    try {
      await this.createWorktree(identity, binding.executionRoot, snapshot, signal);
    } catch (error) {
      this.store.setWorkspaceState({ bindingId, expect: 'preparing', to: 'blocked' });
      throw error;
    }
    return this.store.setWorkspaceState({
      bindingId,
      expect: 'preparing',
      to: 'ready',
      sessionId: binding.sessionId,
    });
  }

  /**
   * Registers a snapshot's ref again if it is gone, for a repository whose refs were cleaned.
   *
   * Only used by recovery: a baseline whose objects are no longer referenced will be collected by Git's next
   * maintenance pass, and a restored workspace would then fail to allocate for a reason nothing in the record
   * explains.
   */
  async republishSnapshotRef(snapshot: WorkspaceSnapshot, signal: AbortSignal): Promise<void> {
    const identity = await repositoryIdentity(snapshot.projectRoot, signal);
    if (!identity) return;
    const existing = await workspaceGit(['rev-parse', '--verify', snapshotRef(snapshot.id)], {
      cwd: identity.worktreeRoot,
      signal,
      allowFailure: true,
    }).catch(() => '');
    if (existing) return;
    await withRepositoryLock(identity.repositoryRoot, async () => {
      await runWorkspaceGit(['update-ref', snapshotRef(snapshot.id), snapshot.baseCommit], {
        cwd: identity.worktreeRoot,
        signal,
      });
    });
  }
}

/**
 * Whether `candidate` is the directory `expected`, by the identity rule the rest of the feature uses.
 *
 * Exported because the same question is asked in three places — allocation, validation and the recovery pass — and
 * three spellings of "the same directory" is how one of them ends up weaker than the others.
 */
export function sameDirectory(left: string, right: string): boolean {
  const a = realPathOrNull(left);
  const b = realPathOrNull(right);
  if (!a || !b) return samePath(left, right);
  return canonicalKey(a) === canonicalKey(b);
}

/** Whether a directory is inside the managed worktree root of the given repository. */
export function insideManagedRoot(repositoryRoot: string, target: string): boolean {
  return isWithin(managedWorktreeRoot(repositoryRoot, 'x').replace(/[\\/]x$/, ''), target);
}

/** Reads a file out of a workspace, used by the results service for a diff of one path. */
export async function readWorkspaceFile(root: string, relative: string): Promise<Buffer | null> {
  return await readFile(path.join(root, ...relative.split('/'))).catch(() => null);
}
