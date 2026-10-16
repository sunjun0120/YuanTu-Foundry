import type { HostMethods } from '../../packages/protocol/rpc.ts';
import type { CarrierIssue } from '../../packages/carrier/errors.ts';
import { workspaceId } from '../../packages/protocol/workspaces.ts';

export type WorkspaceMaintenanceCommand =
  { type: 'list' } | { type: 'archive' | 'remove' | 'restore'; bindingId: string };
export type WorkspaceMaintenanceReply =
  | { ok: true; workspace: string; items: HostMethods['workspaces.orphaned']['result'] }
  | { ok: false; error: string; errorDetail?: CarrierIssue | null };

export function parseWorkspaceMaintenanceCommand(input: unknown): WorkspaceMaintenanceCommand {
  const fail = (): never => {
    throw new Error('Invalid workspace maintenance request');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  if (value.type === 'list' && Object.keys(value).every((key) => key === 'type'))
    return { type: 'list' };
  if (
    !['archive', 'remove', 'restore'].includes(String(value.type)) ||
    Object.keys(value).some((key) => !['type', 'bindingId'].includes(key))
  )
    return fail();
  return {
    type: value.type as 'archive' | 'remove' | 'restore',
    bindingId: workspaceId(value.bindingId),
  };
}
