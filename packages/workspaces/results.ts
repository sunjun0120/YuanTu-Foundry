import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileChange, FileSnapshot, ToolContext } from '../protocol/index.ts';
import {
  WorkspaceFailure,
  workspaceDigest,
  type WorkspaceBinding,
  type WorkspaceResult,
  type WorkspaceResultStatus,
} from '../protocol/workspaces.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { redactSecrets } from '../platform/redact.ts';
import {
  diffTrees,
  readBlob,
  repositoryIdentity,
  runWorkspaceGit,
  withRepositoryLock,
  writeTree,
} from './git.ts';
import { collectWorkingTree } from './snapshot.ts';
import type { WorkspaceResultFile } from '../protocol/workspaces.ts';
import {
  changeForResult,
  countDiff,
  digestOf,
  isUtf8Text,
  readResultManifest,
  resultRef,
  snapshotsForResult,
  withTargetLease,
  writeResultFiles,
  writeResultManifest,
  type WorkspaceResultManifest,
} from './result-files.ts';
export {
  changeForResult,
  digestOf,
  isUtf8Text,
  readResultManifest,
  resultMetadataPath,
  resultRef,
  snapshotsForResult,
  withTargetLease,
  writeResultFiles,
} from './result-files.ts';
export type { WorkspaceResultManifest } from './result-files.ts';
export type { WorkspaceResultFile } from '../protocol/workspaces.ts';

/**
 * What a child produced, and what it costs the parent to take it.
 *
 * The shape of one result is a *frozen* pair of trees and the differences between them, and the reason it is frozen
 * rather than recomputed is the whole point of the feature: the parent reviews bytes, approves them, and the bytes
 * it approved are the bytes that arrive. A result that re-read the child's directory when the parent finally got
 * around to applying it would be a promise about a moving target — and the child may well have run another turn in
 * the meantime.
 *
 * Three rules the implementation follows, each of which the tests hold it to:
 *
 * - **The difference is taken against `comparisonTree`**, which is the frozen baseline for a first export and the
 *   subtree of the last successful import afterwards. That is what stops a second export re-offering work the
 *   parent already accepted.
 * - **A result that cannot be imported is still a result.** Binary files, mode changes, symbolic links, protected
 *   paths and anything over the size limits produce a record with status `unsupported`: the child's directory and
 *   the frozen objects stay, so a person can look at the work even though this version will not move it.
 * - **A follow-up turn makes the previous result stale rather than wrong.** `superseded` is written when a new
 *   result is exported for the same child, so the parent is never offered two versions of one child's work as if
 *   they were both current.
 */

/**
 * What a caller may rely on from the results service, stated separately from its implementation.
 *
 * The seam exists so a caller — the coordinator, a tool, an embedded host — can be handed *something that exports
 * results* without also being handed the ability to apply them. The two capabilities are deliberately not one
 * interface: exporting reads a child's directory, importing writes into a parent's, so a component that only needs
 * the first cannot reach the second by accident.
 */
export interface WorkspaceResults {
  export(input: { childSessionId: string; signal: AbortSignal }): Promise<WorkspaceResult>;
  /** The frozen description of one result, or null when its manifest is gone. */
  manifest(resultId: string): Promise<WorkspaceResultManifest | null>;
}

/**
 * What the *parent* side needs: reviewing and importing a child's result.
 *
 * Deliberately separate from {@link WorkspaceResults}, because the two capabilities are handed to different callers.
 * Exporting is a read of a child's directory and is wired into the delegation seam; importing writes into a parent's
 * directory and is reachable only through an approval-gated tool. A component that only needs the first cannot reach
 * the second by accident.
 */
export interface WorkspaceApply {
  previewApply(input: {
    parentSessionId: string;
    resultId: string;
    expectedDigest: string;
    signal: AbortSignal;
  }): Promise<{
    description: string;
    change: FileChange;
    files: FileSnapshot[];
    conflicts: string[];
  }>;
  apply(input: {
    parentSessionId: string;
    resultId: string;
    expectedDigest: string;
    signal: AbortSignal;
    context: ToolContext;
  }): Promise<{ status: 'applied' | 'conflict'; changeId?: string; conflicts: string[] }>;
  /** Resolves an import that was interrupted half-way, from its own journal. */
  reconcile(signal: AbortSignal): Promise<void>;
}

/**
 * What this version will and will not move between directories.
 *
 * The plan's numbers, and they are deliberately small. Everything here is a *first version* bound rather than a
 * judgement about what a good change looks like: the point is that a result outside them is reported as
 * unsupported — with the child's work left on disk — instead of being partially imported, which is the outcome
 * that would leave a parent with half a refactor and no way to tell.
 */
export const RESULT_LIMITS = {
  /** One file's bytes, each way. */
  fileBytes: 1_048_576,
  /** Paths in one result. */
  files: 64,
  /** Every before/after byte in one result together. */
  totalBytes: 8 * 1024 * 1024,
} as const;

export interface ResultsOptions {
  store: SessionStore;
  onDiagnostic?: (message: string) => void;
}

/** A binding is only usable for results when it is one of ours and its session owns it. */
function requireIsolated(binding: WorkspaceBinding): void {
  if (binding.kind !== 'worktree')
    throw new WorkspaceFailure(
      'WORKSPACE_UNSUPPORTED_RESULT',
      'A shared workspace has nothing to export: its changes are already the delegator’s own',
    );
}

export class WorkspaceResultsService implements WorkspaceResults, WorkspaceApply {
  private readonly store: SessionStore;
  private readonly options: ResultsOptions;
  constructor(options: ResultsOptions) {
    this.store = options.store;
    this.options = options;
  }

  private diagnostic(message: string): void {
    this.options.onDiagnostic?.(message);
  }

  /**
   * Freezes what a child changed, as an immutable result.
   *
   * The order matters and is the reason this is one method rather than several: the trees are written first, then
   * the record, and only then is the previous result superseded. A crash between any two of those leaves a state
   * that is true — objects without a record are unreferenced but harmless, a record without objects is caught by
   * the digest check on read — while doing it the other way round would leave the parent able to see a result whose
   * contents did not exist.
   */
  async export(input: { childSessionId: string; signal: AbortSignal }): Promise<WorkspaceResult> {
    const { childSessionId, signal } = input;
    signal.throwIfAborted();
    const binding = this.store.workspaceBinding(childSessionId);
    requireIsolated(binding);
    await this.requireIdle(childSessionId, signal);
    await this.assertUsable(binding, signal);

    const identity = await repositoryIdentity(binding.executionRoot, signal);
    if (!identity)
      throw new WorkspaceFailure('WORKSPACE_MISSING', 'The isolated workspace is gone');
    const snapshot = this.store.workspaceSnapshot(binding.snapshotId!);
    if (!snapshot)
      throw new WorkspaceFailure(
        'WORKSPACE_MISSING',
        'The frozen baseline for this workspace is gone',
      );

    /**
     * What the result is a difference *against*.
     *
     * A first export compares against the frozen baseline; every later one compares against the subtree of the last
     * import the parent accepted. The comparison tree advances only in `apply`, so a follow-up turn produces a
     * result that contains only what has changed since the parent last took delivery — not everything the child has
     * ever done, offered again.
     */
    const previous = this.store
      .childWorkspaceResults(childSessionId)
      .filter((candidate) => candidate.status === 'applied')
      .sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''))
      .at(-1);
    const comparisonTree = previous?.resultTree ?? snapshot.baseTree;

    const entries = await collectWorkingTree(binding.executionRoot, signal);
    const currentTree = await writeTree(
      identity.repositoryRoot,
      entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        bytes: Buffer.from(entry.blob, 'base64'),
      })),
      signal,
    );
    const differences = await diffTrees(
      identity.repositoryRoot,
      comparisonTree,
      currentTree,
      signal,
    );

    const resultId = randomUUID();
    const files: WorkspaceResultFile[] = [];
    const unsupported: string[] = [];
    let total = 0;
    for (const difference of differences) {
      if (files.length >= RESULT_LIMITS.files) {
        unsupported.push(
          `${difference.path} (more than ${RESULT_LIMITS.files} paths in one result)`,
        );
        continue;
      }
      const beforeBytes = difference.beforeBlob
        ? ((await readBlob(identity.repositoryRoot, difference.beforeBlob, signal)) ??
          Buffer.alloc(0))
        : null;
      const afterBytes = difference.afterBlob
        ? ((await readBlob(identity.repositoryRoot, difference.afterBlob, signal)) ??
          Buffer.alloc(0))
        : null;
      /**
       * Why this path cannot travel, or null when it can.
       *
       * A local decision per path, because the *result's* answer is not the union of them: one path that cannot
       * travel makes the whole result unimportable, which is the plan's "no partial import" rule. Reporting it
       * this way keeps the reason attached to the path it belongs to, so the diagnostic a person reads names a
       * file rather than saying "something in this result was too large".
       */
      let refusal: string | null = null;
      if (difference.status === 'mode') refusal = 'file mode changed';
      else {
        for (const [side, bytes] of [
          ['before', beforeBytes],
          ['after', afterBytes],
        ] as const) {
          if (bytes === null) continue;
          if (bytes.length > RESULT_LIMITS.fileBytes) {
            refusal = `${side} is larger than ${RESULT_LIMITS.fileBytes} bytes`;
            break;
          }
          if (!isUtf8Text(bytes)) {
            refusal = `${side} is not UTF-8 text`;
            break;
          }
        }
      }
      if (refusal) {
        unsupported.push(`${difference.path} (${refusal})`);
        continue;
      }
      total += (beforeBytes?.length ?? 0) + (afterBytes?.length ?? 0);
      if (total > RESULT_LIMITS.totalBytes) {
        unsupported.push(
          `${difference.path} (the whole result is larger than ${RESULT_LIMITS.totalBytes} bytes)`,
        );
        continue;
      }
      files.push({
        path: difference.path,
        kind:
          difference.status === 'added'
            ? 'create'
            : difference.status === 'deleted'
              ? 'delete'
              : 'edit',
        beforeBytes: beforeBytes?.length ?? 0,
        afterBytes: afterBytes?.length ?? 0,
        beforeBlob: difference.beforeBlob,
        afterBlob: difference.afterBlob,
      });
    }

    const manifest: WorkspaceResultManifest = {
      version: 1,
      resultId,
      parentSessionId: binding.parentSessionId!,
      childSessionId,
      bindingId: binding.id,
      repositoryRoot: identity.repositoryRoot,
      comparisonTree,
      resultTree: currentTree,
      createdAt: new Date().toISOString(),
      files,
      evidence: this.evidenceFor(childSessionId),
    };
    const digest = digestOf(manifest);

    /**
     * The result's tree is referenced before the record is written, so the objects a record names are never
     * collectable. The ref names the *result*, not the child: a child may produce many results, and each one has to
     * survive on its own.
     */
    await withRepositoryLock(identity.repositoryRoot, async () => {
      await runWorkspaceGit(['update-ref', resultRef(resultId), currentTree], {
        cwd: identity.repositoryRoot,
        signal,
      });
    });
    await writeResultManifest(identity.repositoryRoot, resultId, manifest);

    const status: WorkspaceResultStatus = unsupported.length ? 'unsupported' : 'ready';
    /**
     * An unsupported result offers nothing for import — not even the paths that could have travelled.
     *
     * That is the plan's "no partial import" rule, and the reason it is a rule rather than a preference: a parent
     * that received three of a child's four files would have a tree that is neither the old state nor the new one,
     * and nothing in the change list would say which. So the record keeps the *reason* and the child's directory
     * keeps the work, and the whole result is handed to a person instead.
     */
    const offerable = status === 'ready' ? files : [];
    // Supersede before recording: a run that produced a new result has made the old one stale by definition, and
    // the reverse order would briefly present two current results for one child.
    this.store.supersedeWorkspaceResults(childSessionId);
    const result = this.store.recordWorkspaceResult({
      id: resultId,
      bindingId: binding.id,
      childSessionId,
      parentSessionId: binding.parentSessionId!,
      snapshotId: binding.snapshotId!,
      comparisonTree,
      resultTree: currentTree,
      digest,
      paths: offerable.map((file) => file.path),
      status,
      createdAt: manifest.createdAt,
    });
    if (unsupported.length)
      this.diagnostic(`workspace result ${resultId} is unsupported: ${unsupported.join('; ')}`);
    return result;
  }

  /** The durable evidence a result carries: what the child's tools did, and nothing the child said about it. */
  private evidenceFor(childSessionId: string): { tool: string; at: string }[] {
    /**
     * The child's own writes are flushed first.
     *
     * `events` folds the durable log, and a log write that is still buffered is invisible to that fold — which
     * matters here because the export runs in the same tick as the turn's end, before anything would otherwise have
     * flushed. Without this the evidence would be *usually* present and occasionally missing, which is worse than
     * absent: a reader could not tell an unverified child from a verified one.
     */
    this.store.flush(childSessionId);
    return this.store
      .events(childSessionId)
      .filter((event) => event.type === 'tool.execution.finished')
      .map((event) => ({ tool: redactSecrets(String(event.data.tool ?? 'tool')), at: event.at }))
      .slice(-50);
  }

  /**
   * Refuses to export while the child still has something writable running.
   *
   * A read of a directory that a live command is writing is not a snapshot of anything: it is a race whose result
   * would be a diff of half a build. The child's own run lease is the durable answer to "is it still working", and
   * a pending file change in its journal is the durable answer to "has a write been journalled but not settled".
   * Both are checked because they fail differently: a lease means a turn is live, a pending change means a tool call
   * was interrupted mid-write.
   */
  private async requireIdle(childSessionId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const session = this.store.get(childSessionId);
    if (session.activeRun)
      throw new WorkspaceFailure(
        'WORKSPACE_BUSY',
        'The sub-agent is still running; export its result after its turn ends',
      );
    const pending = this.store
      .fileChanges(childSessionId)
      .filter((change) => change.status === 'pending');
    if (pending.length)
      throw new WorkspaceFailure(
        'WORKSPACE_BUSY',
        'The sub-agent has a file change whose outcome is unknown; settle it before exporting',
        { paths: pending.map((change) => change.change.path) },
      );
  }

  /** Proves the directory is still the one this binding describes before anything is read out of it. */
  private async assertUsable(binding: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    const identity = await repositoryIdentity(binding.executionRoot, signal);
    if (!identity)
      throw new WorkspaceFailure(
        'WORKSPACE_MISSING',
        `The isolated workspace is gone: ${binding.executionRoot}`,
      );
    if (identity.repositoryRoot !== binding.repositoryRoot)
      throw new WorkspaceFailure(
        'WORKSPACE_IDENTITY_MISMATCH',
        'The isolated workspace now belongs to a different repository',
      );
  }

  /** The frozen description of one result, or null when its manifest is no longer on disk. */
  async manifest(resultId: string): Promise<WorkspaceResultManifest | null> {
    const result = this.store.workspaceResult(resultId);
    if (!result) return null;
    const binding = this.store.workspaceById(result.bindingId);
    // A result whose binding is gone is a record of something this service can no longer describe; the caller is
    // told "no manifest" rather than being handed a path guessed from the project root.
    if (!binding) return null;
    return readResultManifest(binding.repositoryRoot, resultId);
  }

  /**
   * Everything that can stop an import, checked without writing anything.
   *
   * This is what the approval is *about*: the caller shows a person the paths and the patch, and the person says yes
   * or no. Nothing here writes a file or a journal entry, which is why a refusal costs nothing and why a preview can
   * be taken as often as a caller likes.
   *
   * The checks, in the order they can fail: the result belongs to the calling parent, it is still importable, its
   * content is still the content the caller quoted, its source child is not still working, and every target file is
   * byte-for-byte what the result says it was. The last one is the conflict test, and it is over *all* paths at
   * once: importing three of four files would leave the parent with a tree that is neither state, and nothing in
   * the change list would say which.
   */
  async previewApply(input: {
    parentSessionId: string;
    resultId: string;
    expectedDigest: string;
    signal: AbortSignal;
  }): Promise<{
    description: string;
    change: FileChange;
    files: FileSnapshot[];
    conflicts: string[];
  }> {
    const { parentSessionId, resultId, expectedDigest, signal } = input;
    signal.throwIfAborted();
    const prepared = await this.prepareApply({ parentSessionId, resultId, expectedDigest, signal });
    const { manifest, diffs, snapshots } = prepared;
    /**
     * The conflict is recorded by the *preview*, not by the apply.
     *
     * A caller that shows a person a refusal and stops never reaches `apply`, and a result left saying `ready` would
     * be offered again on the next listing as if nothing had happened. Recording it here is what makes
     * "this result conflicts with your workspace" a durable answer rather than a message the model saw once.
     */
    if (prepared.conflicts.length)
      this.store.setWorkspaceResultStatus({
        resultId,
        expect: ['ready', 'conflict'],
        to: 'conflict',
      });
    const lines = manifest.files.map((file) => {
      const diff = diffs.find((entry) => entry.path === file.path);
      return `- ${file.kind} ${file.path} (+${diff?.added ?? 0} -${diff?.removed ?? 0})`;
    });
    return {
      description: [
        `Import ${manifest.files.length} path${manifest.files.length === 1 ? '' : 's'} from sub-agent result ${resultId}:`,
        ...lines,
        `Source child: ${manifest.childSessionId}`,
      ].join('\n'),
      change: changeForResult({ resultId, manifest, diffs }),
      files: snapshots,
      conflicts: prepared.conflicts,
    };
  }

  /**
   * Imports a result into the calling parent's directory.
   *
   * The re-check is the reason `apply` takes the same `expectedDigest` the preview was taken with: between the person
   * looking at a preview and saying yes, the child could have run another turn and the parent could have edited the
   * file. The digest answers the first — content that changed produces a different digest and the call is refused —
   * and the per-file before check answers the second. An approval is a decision about specific bytes, and this is
   * what keeps it from being spent on different ones.
   */
  async apply(input: {
    parentSessionId: string;
    resultId: string;
    expectedDigest: string;
    signal: AbortSignal;
    context: ToolContext;
  }): Promise<{ status: 'applied' | 'conflict'; changeId?: string; conflicts: string[] }> {
    const { parentSessionId, resultId, expectedDigest, signal } = input;
    signal.throwIfAborted();
    const target = this.store.workspaceBinding(parentSessionId);
    /**
     * Idempotency, keyed by the statement being repeated.
     *
     * The same result, the same content, the same target directory: that request has already happened, and the
     * answer is the change it produced rather than a second write. A different target is a different import — a
     * nested delegator legitimately imports its child's work somewhere else — and a different digest is different
     * content, which is a new request rather than a repeat.
     */
    const receipt = this.store.workspaceApplyReceipt({
      resultId,
      digest: expectedDigest,
      targetBindingId: target.id,
    });
    if (receipt) return this.confirmedImport(parentSessionId, resultId, receipt.changeId);

    /**
     * One import per target directory at a time.
     *
     * Two imports overlapping in one parent would interleave their writes, and the second one's before-check would
     * have been taken against a tree the first was in the middle of changing — which is exactly the "third byte
     * state" the grouped journal cannot classify. The lease is per *binding* rather than global, so two parents
     * importing into their own directories never wait for each other.
     */
    return await withTargetLease(target.id, async () => {
      signal.throwIfAborted();
      const again = this.store.workspaceApplyReceipt({
        resultId,
        digest: expectedDigest,
        targetBindingId: target.id,
      });
      if (again) return this.confirmedImport(parentSessionId, resultId, again.changeId);
      // Waiting for another import can change every target file. Verify inside the lease, never reuse a preview.
      const prepared = await this.prepareApply({
        parentSessionId,
        resultId,
        expectedDigest,
        signal,
      });
      if (prepared.conflicts.length) {
        this.store.setWorkspaceResultStatus({
          resultId,
          expect: ['ready', 'conflict'],
          to: 'conflict',
        });
        return { status: 'conflict' as const, conflicts: prepared.conflicts };
      }
      if (!prepared.manifest.files.length)
        throw new WorkspaceFailure(
          'WORKSPACE_UNSUPPORTED_RESULT',
          'This result has nothing to import',
        );
      // Marked before the first byte, so an interruption is recognisable: an `applying` result is one this service
      // may have to finish or refuse, and it must never be re-offered as `ready` while that is undecided.
      const changeId = this.store.beginWorkspaceApply({
        parentSessionId,
        resultId,
        digest: expectedDigest,
        targetBindingId: target.id,
        change: changeForResult({ resultId, manifest: prepared.manifest, diffs: prepared.diffs }),
        files: prepared.snapshots,
      });
      /**
       * The receipt is written *with* the journal entry — the same two calls, and the store's transaction is what
       * makes them one statement, so "the change exists" and "this result was imported" cannot disagree. A receipt
       * without a change would answer a repeat with a change id nothing can resolve; a change without a receipt
       * would let the same bytes be written twice.
       */
      try {
        await writeResultFiles({
          manifest: prepared.manifest,
          targetRoot: target.executionRoot,
          signal,
        });
      } catch (error) {
        // The journal entry stays `pending` on purpose: the bytes on disk are now a mixture of before and after,
        // and `reconcilePendingFileChanges` is the thing that can tell which path is in which state.
        this.diagnostic(
          `workspace result ${resultId} was interrupted mid-import: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
      this.store.finishWorkspaceApply(resultId, changeId);
      return { status: 'applied' as const, changeId, conflicts: [] };
    });
  }

  /**
   * Resolves imports that were interrupted half-way.
   *
   * Called at start-up and never mid-run, and it replays *nothing*: an import that was interrupted may already have
   * written some of its files, and whether it did is answered by comparing each path against the bytes the journal
   * recorded — the same question `reconcilePendingFileChanges` answers for an ordinary write, asked here about the
   * *target* binding rather than about a session's project directory.
   *
   * The three outcomes and the difference between them are what a reader is told:
   *
   * - **applied** — every path now holds the result's after bytes, so the import did complete and only the record
   *   was left behind by the interruption.
   * - **conflict** — some path holds a third state, so a person has to look; the result is not re-offered.
   * - **ready again** — nothing was written, so the approval was never spent and the parent may still apply it. That
   *   is the one case where re-offering is honest: no effect happened.
   */
  async reconcile(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (const result of this.store.workspaceResultsInState('applying')) {
      signal.throwIfAborted();
      const manifest = await this.manifest(result.id);
      if (!manifest) {
        this.store.setWorkspaceResultStatus({
          resultId: result.id,
          expect: 'applying',
          to: 'conflict',
        });
        this.diagnostic(
          `workspace result ${result.id} was interrupted and its frozen description is gone`,
        );
        continue;
      }
      /**
       * The receipt is what identifies the *import*, and its target is where the bytes were going.
       *
       * The result names the binding of the child that produced it; an import writes into the *parent's* directory,
       * which is a different binding whenever the delegator is itself isolated. The receipt is the only record that
       * ties the two together, so a result with no receipt is one whose interruption happened before anything was
       * written — and then it is simply importable again.
       */
      const receipt = this.store
        .workspaceApplyReceipts(result.id)
        .find((candidate) => candidate.digest === result.digest);
      if (!receipt) {
        this.store.setWorkspaceResultStatus({
          resultId: result.id,
          expect: 'applying',
          to: 'ready',
        });
        continue;
      }
      const importing = this.store.workspaceById(receipt.targetBindingId);
      /**
       * The change's owner is read from its own row rather than derived from the binding.
       *
       * A binding's `parentSessionId` is *not* the answer: the top-level parent's own binding is the synthesised
       * shared one, whose parent is null by definition, so deriving the owner from it makes every ordinary import
       * look like a record whose journal cannot be found. The row that holds the change is the authority on whose
       * journal it is, and it is the same row this pass is about to read the before/after bytes out of.
       *
       * The *directory* falls back to the owning session's project when the binding is synthesised: a top-level
       * parent has no binding row at all, and its execution root is its own project directory — which is exactly what
       * the shared binding said in the first place.
       */
      const owner = this.store.fileChangeOwner(receipt.changeId);
      const targetRoot =
        importing?.executionRoot ?? (owner ? this.store.get(owner).workspace : null);
      if (!owner || !targetRoot) {
        this.store.setWorkspaceResultStatus({
          resultId: result.id,
          expect: 'applying',
          to: 'conflict',
        });
        this.diagnostic(
          `workspace result ${result.id}: its target directory or its import record is no longer recorded`,
        );
        continue;
      }
      /**
       * A change record that cannot be read is a conflict rather than an exception.
       *
       * This pass runs at start-up over every interrupted import, and one unreadable record must not stop it from
       * converging the others — which is exactly what a thrown error here would do.
       */
      let snapshots: FileSnapshot[];
      try {
        snapshots = this.store.fileChangeSnapshots(owner, receipt.changeId);
      } catch (error) {
        this.store.setWorkspaceResultStatus({
          resultId: result.id,
          expect: 'applying',
          to: 'conflict',
        });
        this.diagnostic(
          `workspace result ${result.id}: its import record cannot be read (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        continue;
      }
      const conflicts: string[] = [];
      let written = 0;
      for (const snapshot of snapshots) {
        const absolute = path.join(targetRoot, ...snapshot.path.split('/'));
        /**
         * Read as *bytes*, never as text.
         *
         * `readFile` with an encoding hands back a string, and a string has no `equals` — so a comparison written
         * that way throws on the first path that exists, which the surrounding catch would report as a conflict. The
         * whole classification is a byte comparison, and reading either side as text would also make a file that is
         * not valid UTF-8 impossible to classify at all.
         */
        const current = await readFile(absolute).catch(() => null);
        const after = snapshot.after === null ? null : Buffer.from(snapshot.after);
        const before = snapshot.before === null ? null : Buffer.from(snapshot.before);
        const isAfter = current === null ? after === null : after !== null && current.equals(after);
        const isBefore =
          current === null ? before === null : before !== null && current.equals(before);
        if (isAfter) written++;
        else if (!isBefore) conflicts.push(snapshot.path);
      }
      if (conflicts.length) {
        this.store.setWorkspaceResultStatus({
          resultId: result.id,
          expect: 'applying',
          to: 'conflict',
        });
        this.diagnostic(
          `workspace result ${result.id} conflicts after an interruption: ${conflicts.join(', ')}`,
        );
        continue;
      }
      if (written === 0) {
        this.store.resetUnwrittenWorkspaceApply(receipt);
        continue;
      }
      // Every path is either still its before bytes or already its after bytes, so the import can be *finished* by
      // writing the remainder. The receipt is what makes that safe rather than a replay: it is the record that this
      // exact content was approved by a person and partly written, which is precisely what a replay must not invent.
      try {
        await writeResultFiles({ manifest, targetRoot, signal });
        this.store.finishWorkspaceApply(result.id, receipt.changeId);
      } catch (error) {
        this.store.setWorkspaceResultStatus({
          resultId: result.id,
          expect: 'applying',
          to: 'conflict',
        });
        this.diagnostic(
          `workspace result ${result.id} could not be finished: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private confirmedImport(
    parentSessionId: string,
    resultId: string,
    changeId: string,
  ): {
    status: 'applied';
    changeId: string;
    conflicts: string[];
  } {
    const result = this.store.workspaceResult(resultId);
    const journal = this.store
      .fileChanges(parentSessionId)
      .find((change) => change.id === changeId);
    if (
      result?.parentSessionId !== parentSessionId ||
      result.status !== 'applied' ||
      !journal ||
      (journal.status !== 'applied' && journal.status !== 'undone')
    )
      throw new WorkspaceFailure(
        'WORKSPACE_BUSY',
        'This import is unfinished or requires recovery; it has not been confirmed as imported',
      );
    return { status: 'applied', changeId, conflicts: [] };
  }

  /** The shared half of preview and apply: resolve, verify, and decide whether anything conflicts. */
  private async prepareApply(input: {
    parentSessionId: string;
    resultId: string;
    expectedDigest: string;
    signal: AbortSignal;
  }): Promise<{
    manifest: WorkspaceResultManifest;
    diffs: { path: string; added: number; removed: number }[];
    snapshots: FileSnapshot[];
    conflicts: string[];
  }> {
    const { parentSessionId, resultId, expectedDigest, signal } = input;
    const result = this.store.workspaceResult(resultId);
    if (!result)
      throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', `Unknown workspace result: ${resultId}`);
    /**
     * Ownership first, and stated as its own refusal.
     *
     * A result belongs to the session that delegated the child which produced it. A *sibling* delegator, or a
     * grandparent, asking for it is not a mistake in the digest or a conflict — it is a request this result was
     * never offered to, and answering it as either of the others would hide that.
     */
    if (result.parentSessionId !== parentSessionId)
      throw new WorkspaceFailure(
        'WORKSPACE_INTEGRITY',
        `Workspace result ${resultId} belongs to another parent session`,
      );
    if (result.status === 'unsupported')
      throw new WorkspaceFailure(
        'WORKSPACE_UNSUPPORTED_RESULT',
        `Workspace result ${resultId} holds changes this version will not import; review the child's directory instead`,
      );
    if (result.status === 'superseded')
      throw new WorkspaceFailure(
        'WORKSPACE_UNSUPPORTED_RESULT',
        `Workspace result ${resultId} was replaced by a later turn of the same child; apply the current result`,
      );
    const manifest = await this.manifest(resultId);
    if (!manifest)
      throw new WorkspaceFailure(
        'WORKSPACE_MISSING',
        `The frozen description of result ${resultId} is gone`,
      );
    const digest = digestOf(manifest);
    /**
     * The digest the caller quoted has to be the *stored* one and the one the manifest computes.
     *
     * Both halves matter. The first is the caller's own promise that it is applying what it reviewed; the second is
     * the record's promise that the manifest on disk is the one the record was written from — a manifest edited after
     * the fact would otherwise be applied while the record still described the old bytes.
     */
    if (digest !== expectedDigest || result.digest !== expectedDigest)
      throw new WorkspaceFailure(
        'WORKSPACE_INTEGRITY',
        'This result changed since it was reviewed; take a new preview before applying it',
        { expectedDigest, digest, stored: result.digest },
      );
    // A child that is still working may write the files being imported, and an import is not a race.
    await this.requireIdle(result.childSessionId, signal);

    const target = this.store.workspaceBinding(parentSessionId);
    const snapshots = await snapshotsForResult(manifest.repositoryRoot, manifest, signal);
    const conflicts: string[] = [];
    const diffs: { path: string; added: number; removed: number }[] = [];
    for (const snapshot of snapshots) {
      const absolute = path.join(target.executionRoot, ...snapshot.path.split('/'));
      const current = await readFile(absolute).catch(() => null);
      // "The file was not there" is a byte state like any other, and the *absence* of a create's before is what a
      // new file's import is checked against.
      const matches =
        current === null
          ? snapshot.before === null
          : snapshot.before !== null && current.equals(Buffer.from(snapshot.before));
      if (!matches) conflicts.push(snapshot.path);
      diffs.push({ path: snapshot.path, ...(await countDiff(snapshot)) });
    }
    return { manifest, diffs, snapshots, conflicts };
  }
}

/** The exports a tool result and the public seams need. */
export type { WorkspaceResult, WorkspaceBinding };
export { workspaceDigest, WorkspaceFailure };
