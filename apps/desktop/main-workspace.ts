import { realpathSync } from 'node:fs';
import { ipcMain, shell } from 'electron';
import type { CarrierService } from '../../packages/carrier/index.ts';
import { carrierErrorReply } from './carrier-errors.ts';
import type { ArchivedSessionsReply, OpenWorkspacePathReply } from './contract.ts';
import { parseFilesCommand, type FilesReply } from './files-contract.ts';
import { mainText } from './i18n.ts';
import { safeError, type MainContext } from './main-context.ts';
import type { SessionChoices } from './session-choices.ts';
import { workspaceFilePath } from './workspace-file-path.ts';
import { maintainWorkspace } from './workspace-maintenance.ts';
import {
  parseWorkspaceMaintenanceCommand,
  type WorkspaceMaintenanceReply,
} from './workspace-maintenance-contract.ts';

/** How a request's `target` finds the Host it addresses; `main.ts` owns the routes. */
export interface WorkspaceRouting {
  routedService(target: unknown): CarrierService;
  choices(service: CarrierService): SessionChoices;
}

/**
 * The per-workspace requests that are a round trip to the routed Host, plus opening one of its files.
 *
 * None of them reads the workspace itself: containment and the ignore list belong to the Host that owns the
 * workspace, so the only filesystem access here is resolving the one path the person asked to open.
 */
export function registerWorkspaceIpc(
  ctx: Pick<MainContext, 'assertSender' | 'quitting' | 'switching'>,
  routing: WorkspaceRouting,
): void {
  ipcMain.handle(
    'yuantu:workspace-maintenance',
    async (event, input: unknown): Promise<WorkspaceMaintenanceReply> => {
      try {
        ctx.assertSender(event);
        const envelope = input as { target?: unknown; command?: unknown };
        const command = parseWorkspaceMaintenanceCommand(envelope?.command);
        const service = envelope.target ? routing.routedService(envelope.target) : null;
        const choices = service ? routing.choices(service) : undefined;
        if (!service || ctx.quitting || ctx.switching)
          throw new Error(mainText('desktop.quitting'));
        const current = service;
        const workspace = current.snapshot.workspace;
        if (command.type === 'list')
          return { ok: true, workspace, items: await current.orphanWorkspaces() };
        ctx.switching = true;
        try {
          const sessionId = current.snapshot.session.sessionId;
          return await maintainWorkspace({
            service: current,
            command,
            workspace,
            policyReady: choices?.following,
            isCurrent: () =>
              !ctx.quitting &&
              current === service &&
              current.snapshot.workspace === workspace &&
              current.snapshot.session.sessionId === sessionId,
          });
        } finally {
          ctx.switching = false;
        }
      } catch (error) {
        return carrierErrorReply(error);
      }
    },
  );
  ipcMain.handle(
    'yuantu:archived-sessions',
    async (event, input: unknown): Promise<ArchivedSessionsReply> => {
      try {
        ctx.assertSender(event);
        const service = routing.routedService((input as { target?: unknown })?.target);
        if (!service || ctx.quitting) throw new Error(mainText('desktop.quitting'));
        const current = service;
        const workspace = current.snapshot.workspace;
        return { ok: true, workspace, sessions: await current.archivedSessions() };
      } catch (error) {
        return carrierErrorReply(error);
      }
    },
  );
  ipcMain.handle('yuantu:files', async (event, input: unknown): Promise<FilesReply> => {
    try {
      ctx.assertSender(event);
      const envelope = input as { target?: unknown; command?: unknown };
      const command = parseFilesCommand(envelope?.command);
      const service = envelope.target ? routing.routedService(envelope.target) : null;
      if (!service || ctx.quitting) throw new Error(mainText('desktop.quitting'));
      /**
       * A round trip to the Host, and nothing else.
       *
       * This handler deliberately does not touch the filesystem: the workspace's containment rule and its
       * ignore list belong to the process that owns the workspace, and a reader here would be a second copy
       * of them — the copy that quietly lists what the file tools refuse.
       */
      return command.type === 'list'
        ? {
            ok: true,
            listing: await service.listWorkspaceFiles(
              command.path === undefined || !command.path ? {} : { path: command.path },
            ),
          }
        : {
            ok: true,
            preview: await service.readWorkspaceFile({
              path: command.path,
              ...(command.locale ? { locale: command.locale } : {}),
            }),
          };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });
  ipcMain.handle(
    'yuantu:open-workspace-path',
    async (event, input: unknown): Promise<OpenWorkspacePathReply> => {
      try {
        ctx.assertSender(event);
        const envelope = input as { target?: unknown; command?: unknown };
        const service = routing.routedService(envelope?.target);
        input = envelope.command;
        if (!service || ctx.quitting) throw new Error(mainText('desktop.quitting'));
        if (!input || typeof input !== 'object') throw new Error('Invalid path request');
        const { path: requested, action } = input as {
          path?: unknown;
          action?: unknown;
        };
        if (typeof requested !== 'string' || !requested || requested.length > 4096)
          throw new Error('Invalid workspace path');
        if (requested.includes('\0')) throw new Error('Invalid workspace path');
        if (action !== 'open' && action !== 'reveal') throw new Error('Invalid file action');
        /**
         * Resolve twice: the first check keeps `..` inside the workspace, and the real path check refuses a
         * symlink or junction that points out of it. The runtime directory is never a user-facing file.
         */
        const root = realpathSync.native(service.snapshot.workspace);
        const target = workspaceFilePath(root, requested);
        if (action === 'reveal') shell.showItemInFolder(target);
        else {
          const failure = await shell.openPath(target);
          if (failure) throw new Error(failure);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    },
  );
}
