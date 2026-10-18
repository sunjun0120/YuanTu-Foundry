import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, ipcMain, shell } from 'electron';
import { PRODUCT_SCOPE } from '../../packages/protocol/product-scope.ts';
import { mainText } from './i18n.ts';
import { safeError, type MainContext } from './main-context.ts';
import { parseMcpCommand, type McpReply, type McpServer } from './mcp-contract.ts';
import { McpSettingsStore } from './mcp-settings.ts';

/**
 * MCP credentials live in the desktop profile, never in the workspace, and the agent host child
 * must read exactly the same directory.
 */
export function mcpOAuthDirectory(): string {
  return path.join(app.getPath('userData'), 'mcp-oauth');
}

function testMcpInWorker(
  ctx: MainContext,
  root: string,
  server: McpServer,
  signal: AbortSignal,
  revision: string,
): Promise<{ count: number }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'mcp-test-worker.cjs'), {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      workerData: { root, server, revision },
      env: {
        ...process.env,
        ...ctx.sandboxEnvironment.environment(),
        YUANTU_MCP_OAUTH_DIR: mcpOAuthDirectory(),
      },
    });
    let settled = false;
    const finish = (error?: unknown, result?: { count: number }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(signal.reason ?? new Error('MCP connection test cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    worker.once(
      'message',
      (message: { ok: boolean; result?: { count: number }; error?: string }) =>
        message.ok
          ? finish(undefined, message.result)
          : finish(new Error(message.error ?? 'MCP connection test failed')),
    );
    worker.once('error', finish);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error('MCP connection test worker failed'));
    });
  });
}

/**
 * The paused MCP management channel. A paused surface is not registered at all, exactly like `yuantu:backups`:
 * the preload bridge has no `mcp` member and this channel does not exist (`tests/product-scope.test.ts`).
 */
export function registerMcpIpc(ctx: MainContext): void {
  let authorizing: AbortController | undefined;
  if (PRODUCT_SCOPE.mcpManagement)
    ipcMain.handle('yuantu:mcp', async (event, input: unknown): Promise<McpReply> => {
      try {
        ctx.assertSender(event);
        const command = parseMcpCommand(input);
        if (command.type === 'cancel-authorize') {
          authorizing?.abort(new Error('MCP authorization cancelled'));
          return { ok: true, message: mainText('mcpMain.cancelAuthorize') };
        }
        const service = ctx.service;
        if (!service || ctx.quitting) throw new Error(mainText('desktop.quitting'));
        const store = new McpSettingsStore(service.snapshot.workspace, mcpOAuthDirectory());
        if (command.type === 'get') return { ok: true, view: store.view() };
        if (command.type === 'authorize' && authorizing)
          throw new Error(mainText('mcpMain.authorizeInProgress'));
        if (ctx.switching || service.busy) throw new Error(mainText('mcpMain.busy'));
        ctx.switching = true;
        try {
          if (command.type === 'test') {
            const result = await testMcpInWorker(
              ctx,
              service.snapshot.workspace,
              command.server,
              AbortSignal.any([ctx.settingsAbort.signal, AbortSignal.timeout(15000)]),
              command.revision,
            );
            return {
              ok: true,
              message: mainText('mcpMain.testSucceeded', { count: result.count }),
            };
          }
          if (command.type === 'authorize') {
            const controller = new AbortController();
            authorizing = controller;
            try {
              await store.authorize(
                command.server,
                command.revision,
                async (url) => {
                  if (url.protocol !== 'http:' && url.protocol !== 'https:')
                    throw new Error(mainText('mcpMain.authorizeUrlInvalid'));
                  await shell.openExternal(url.href);
                },
                AbortSignal.any([
                  ctx.settingsAbort.signal,
                  controller.signal,
                  AbortSignal.timeout(300_000),
                ]),
              );
            } finally {
              if (authorizing === controller) authorizing = undefined;
            }
            return {
              ok: true,
              view: store.view(),
              message: mainText('mcpMain.authorizeSucceeded'),
            };
          }
          const view =
            command.type === 'save'
              ? store.save(command.server, command.revision)
              : command.type === 'delete'
                ? store.delete(command.id, command.revision)
                : await store.revoke(command.id, command.revision);
          return {
            ok: true,
            view,
            message:
              command.type === 'save'
                ? mainText('mcpMain.saved')
                : command.type === 'delete'
                  ? mainText('mcpMain.deleted')
                  : mainText('mcpMain.revoked'),
          };
        } finally {
          ctx.switching = false;
        }
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
}
