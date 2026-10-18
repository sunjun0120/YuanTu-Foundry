import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, dialog, ipcMain } from 'electron';
import { PRODUCT_SCOPE } from '../../packages/protocol/product-scope.ts';
import { parseBackupCommand, type BackupReply } from './backup-contract.ts';
import { DailyBackups } from './daily-backups.ts';
import type { BackupAction, BackupResult } from './database-backup-worker.ts';
import { mainText } from './i18n.ts';
import { runtimePaths, safeError, type MainContext } from './main-context.ts';

/**
 * The paused backup surface of the main process: the scheduler, its worker processes, the restore flow and the
 * `yuantu:backups` channel.
 *
 * `PRODUCT_SCOPE.backups` is false, so `start` never constructs the scheduler and `register` never registers the
 * channel (`tests/product-scope.test.ts` pins both guards in this file). The rest stays so that turning the scope
 * back on is the flag, not a refactor. `quiesce` is live either way: quitting and upgrading wait on it, and with
 * nothing started it settles at once.
 */
export class DesktopBackups {
  private daily: DailyBackups | undefined;
  private restoring: Promise<BackupReply> | undefined;
  private readonly workers = new Set<Promise<BackupResult>>();
  private readonly ctx: MainContext;
  constructor(ctx: MainContext) {
    this.ctx = ctx;
  }
  /** Manual maintenance only: legacy daily opt-in files no longer enable scheduling. */
  start(): void {
    if (PRODUCT_SCOPE.backups)
      this.daily = new DailyBackups(
        path.join(app.getPath('userData'), 'backup-settings.json'),
        (file, action, id) => this.execute(file, action, id),
      );
  }
  /** Wait for a restore, the scheduler and every backup worker to finish. */
  async quiesce(): Promise<void> {
    await this.restoring?.catch(() => {});
    await this.daily?.drain();
    await Promise.allSettled([...this.workers]);
  }
  register(): void {
    if (PRODUCT_SCOPE.backups)
      ipcMain.handle('yuantu:backups', async (event, input: unknown): Promise<BackupReply> => {
        try {
          this.ctx.assertSender(event);
          const command = parseBackupCommand(input);
          const { service } = this.ctx;
          if (this.ctx.quitting || this.ctx.switching || !service?.snapshot.ready)
            throw new Error(mainText('upgrade.busy'));
          const file = path.join(service.snapshot.workspace, '.yuantu', 'sessions.sqlite');
          if (command.type === 'get') return { ok: true, view: await this.paused().view(file) };
          if (command.type === 'create')
            return { ok: true, view: await this.paused().create(file) };
          const work = this.restore(file, command.id);
          this.restoring = work;
          try {
            return await work;
          } finally {
            if (this.restoring === work) this.restoring = undefined;
          }
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      });
  }
  private execute(file: string, action: BackupAction, id?: string): Promise<BackupResult> {
    if (this.ctx.quitting && !this.restoring)
      return Promise.reject(new Error(mainText('desktop.quitting')));
    const work = promisify(execFile)(
      runtimePaths().nodePath,
      [
        path.join(__dirname, 'database-backup-worker.cjs'),
        '--database-backup',
        file,
        action,
        ...(id ? [id] : []),
      ],
      { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 },
    ).then(({ stdout }) => JSON.parse(stdout.trim()) as BackupResult);
    this.workers.add(work);
    void work.finally(() => this.workers.delete(work)).catch(() => {});
    return work;
  }
  /**
   * The paused scheduler, or an error that names the reason it is missing.
   *
   * Every caller is inside the handler that the scope flag registers, so a throw here means the scope guard was
   * bypassed — worth an error rather than a silent no-op.
   */
  private paused(): DailyBackups {
    if (!this.daily) throw new Error('Backup management is outside the current product scope');
    return this.daily;
  }
  private async restore(file: string, id: string): Promise<BackupReply> {
    const { ctx } = this;
    const service = ctx.service;
    if (!service?.snapshot.ready || service.busy || ctx.switching || ctx.quitting || !ctx.window)
      throw new Error(mainText('upgrade.busy'));
    ctx.switching = true;
    const workspace = service.snapshot.workspace;
    let stopped = false;
    let reopening = false;
    let recoveryDirectory: string | undefined;
    try {
      await this.daily?.drain();
      await Promise.allSettled([...this.workers]);
      const verified = await this.execute(file, 'verify', id);
      const selected = verified.backups.find((item) => item.id === id)!;
      const confirm = await dialog.showMessageBox(ctx.window, {
        type: 'warning',
        title: mainText('backup.title'),
        message: mainText('backup.confirm', { date: selected.createdAt }),
        detail: mainText('backup.restoreDetail'),
        buttons: [mainText('upgrade.cancel'), mainText('backup.restore')],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirm.response !== 1)
        return { ok: true, view: await this.paused().view(file), cancelled: true };
      if (ctx.quitting || service.busy) throw new Error(mainText('upgrade.busy'));
      await service.stop();
      stopped = true;
      const restored = await this.execute(file, 'restore', id);
      recoveryDirectory = restored.recoveryDirectory;
      if (!ctx.quitting) {
        const next = ctx.createService(workspace);
        ctx.openingService = next;
        reopening = true;
        ctx.attach(next);
        await next.start();
        await ctx.following;
        stopped = false;
      }
      return {
        ok: true,
        view: await this.paused().view(file),
        recoveryDirectory: restored.recoveryDirectory,
      };
    } catch (error) {
      if (stopped && !reopening && !ctx.quitting) {
        const next = ctx.createService(workspace);
        ctx.openingService = next;
        ctx.attach(next);
        try {
          await next.start();
          await ctx.following;
        } catch {
          /* The visible Host error preserves the recovery instructions. */
        }
      }
      if (recoveryDirectory)
        throw new Error(mainText('backup.reconnectFailed', { path: recoveryDirectory }), {
          cause: error,
        });
      throw error;
    } finally {
      ctx.openingService = null;
      ctx.switching = false;
    }
  }
}
