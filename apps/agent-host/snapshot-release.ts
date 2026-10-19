/**
 * A snapshot release requested after a Host operation, when nothing can be delegating.
 *
 * The start-up pass is not the only moment a database stops naming a snapshot: deleting a session, removing a
 * workspace or archiving one can leave the rows and refs unreferenced until the next start. Running a release from
 * the request that caused it is safe only while no run can be in the record-but-not-yet-allocated window, so this
 * helper refuses while this Host has a run or manual operation in flight. A run that starts after the check waits in
 * `WorkspaceManager.snapshotRelease` before touching a snapshot; the pass itself holds no Host lock.
 *
 * Failures are silent by design: the work that caused the request has already succeeded, and the next start (or
 * `workspace-gc`) retries the pass. The returned count exists for tests and diagnostics.
 */
import { WorkspaceManager } from '../../packages/workspaces/manager.ts';
import { hostClaim, withLocks, type HostContext } from './state.ts';

export async function releaseSnapshotsIfIdle(ctx: HostContext): Promise<number> {
  if (ctx.active.size || ctx.manualOperations.size) return 0;
  if (!ctx.store.workspaceSnapshotIds().length) return 0;
  try {
    /**
     * The Host claim is what makes the window safe: a run that starts after the idle check is either already inside
     * this exclusive claim (and is refused, not raced) or it held the shared claim first (and this request is
     * refused). Neither side can record a snapshot and have it released before the binding that names it exists.
     */
    return await withLocks(
      ctx,
      { claims: [hostClaim('exclusive')], busy: 'Host is busy; snapshot release deferred' },
      async (signal) =>
        await new WorkspaceManager({ store: ctx.store }).releaseUnusedSnapshots(signal),
    );
  } catch {
    return 0;
  }
}
