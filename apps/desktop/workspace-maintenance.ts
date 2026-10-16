import type { CarrierService } from '../../packages/carrier/service.ts';
import { CarrierError } from '../../packages/carrier/errors.ts';
import type {
  WorkspaceMaintenanceCommand,
  WorkspaceMaintenanceReply,
} from './workspace-maintenance-contract.ts';

/** Shell policy synchronization and project identity must settle before any maintenance write. */
export async function maintainWorkspace(options: {
  service: Pick<CarrierService, 'maintainOrphanWorkspace' | 'orphanWorkspaces'>;
  command: Exclude<WorkspaceMaintenanceCommand, { type: 'list' }>;
  workspace: string;
  policyReady: Promise<void> | undefined;
  isCurrent(): boolean;
}): Promise<Extract<WorkspaceMaintenanceReply, { ok: true }>> {
  await options.policyReady;
  if (!options.isCurrent()) throw new CarrierError('sessionOperationBusy');
  await options.service.maintainOrphanWorkspace(options.command.bindingId, options.command.type);
  return {
    ok: true,
    workspace: options.workspace,
    items: await options.service.orphanWorkspaces(),
  };
}
