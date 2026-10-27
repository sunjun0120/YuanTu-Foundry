/** Workspace identity travels with every snapshot, stream and command, including replies received after a switch. */
import type { CarrierSnapshot, MessageDelta, StatisticsDelta, SubAgentDelta } from './contract.ts';
import { SnapshotMirror, type SnapshotPatch, type SnapshotSection } from './snapshot-patch.ts';

export interface WorkspaceTarget {
  workspaceId: string;
  hostEpoch: number;
}
export type WorkspaceEvent = WorkspaceTarget &
  (
    | { type: 'state'; patch: SnapshotPatch; active?: boolean; selection?: number }
    | { type: 'delta'; delta: MessageDelta }
    | { type: 'subagent'; delta: SubAgentDelta }
    | { type: 'statistics'; delta: StatisticsDelta }
  );
export function workspaceTarget(value: unknown): WorkspaceTarget {
  if (!value || typeof value !== 'object') throw new Error('Workspace target is required');
  const target = value as Partial<WorkspaceTarget>;
  if (
    typeof target.workspaceId !== 'string' ||
    !/^[\w-]{1,128}$/u.test(target.workspaceId) ||
    !Number.isSafeInteger(target.hostEpoch) ||
    target.hostEpoch! < 1
  )
    throw new Error('Invalid workspace target');
  return { workspaceId: target.workspaceId, hostEpoch: target.hostEpoch! };
}
export function sameTarget(a: WorkspaceTarget | null, b: WorkspaceTarget): boolean {
  return a?.workspaceId === b.workspaceId && a.hostEpoch === b.hostEpoch;
}

/** The preload owns one patch baseline per Host; background replies never select a workspace. */
export class WorkspaceMirrors {
  private readonly entries = new Map<
    string,
    { epoch: number; mirror: SnapshotMirror; state?: CarrierSnapshot }
  >();
  private active: WorkspaceTarget | null = null;
  private selection = -1;
  get target(): WorkspaceTarget | null {
    return this.active && { ...this.active };
  }
  snapshots(): (WorkspaceTarget & { state: CarrierSnapshot })[] {
    return [...this.entries].flatMap(([workspaceId, entry]) =>
      entry.state ? [{ workspaceId, hostEpoch: entry.epoch, state: entry.state }] : [],
    );
  }
  get(target: WorkspaceTarget): CarrierSnapshot | undefined {
    const entry = this.entries.get(target.workspaceId);
    return entry?.epoch === target.hostEpoch ? entry.state : undefined;
  }
  apply(
    event: Extract<WorkspaceEvent, { type: 'state' }>,
  ): { state: CarrierSnapshot; changed: SnapshotSection[] } | null {
    const previous = this.active ? this.get(this.active) : undefined;
    let entry = this.entries.get(event.workspaceId);
    if (entry && entry.epoch > event.hostEpoch) return null;
    if (!entry || entry.epoch < event.hostEpoch) {
      entry = { epoch: event.hostEpoch, mirror: new SnapshotMirror() };
      this.entries.set(event.workspaceId, entry);
    }
    const result = entry.mirror.apply(event.patch);
    entry.state = result.state;
    const activating =
      event.active && (event.selection === undefined || event.selection >= this.selection);
    if (activating) {
      this.selection = event.selection ?? this.selection;
      this.active = { workspaceId: event.workspaceId, hostEpoch: event.hostEpoch };
      return {
        state: result.state,
        changed: [
          ...new Set([...Object.keys(previous ?? {}), ...Object.keys(result.state)]),
        ] as SnapshotSection[],
      };
    }
    return sameTarget(this.active, event) && result.changed.length ? result : null;
  }
}
