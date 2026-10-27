import path from 'node:path';
import { closeSync, openSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { app, dialog } from 'electron';
import type {
  DesktopRelease,
  StagedUpgrade,
  UpgradeManifest,
} from '../../packages/maintenance/desktop-upgrade.ts';
import { mainText } from './i18n.ts';
import { runtimePaths, safeError, type MainContext } from './main-context.ts';

export async function desktopRelease(): Promise<DesktopRelease> {
  const pkg = JSON.parse(await readFile(path.join(__dirname, 'package-version.json'), 'utf8')) as {
    version: string;
  };
  const release = JSON.parse(await readFile(path.join(__dirname, 'release.json'), 'utf8')) as {
    maxSchemaVersion: number;
  };
  return {
    version: app.isPackaged ? app.getVersion() : pkg.version,
    channel: 'manual',
    maxSchemaVersion: release.maxSchemaVersion,
  };
}

/** A launch by the upgrade worker reports back that the new version is the one running. */
export async function confirmUpgradeStartup(): Promise<void> {
  const file = app.commandLine.getSwitchValue('upgrade-journal');
  if (!file) return;
  const relative = path.relative(path.join(app.getPath('userData'), 'upgrades'), file);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.basename(file) !== 'upgrade.json'
  )
    throw new Error('Invalid upgrade journal path');
  const journal = JSON.parse(await readFile(file, 'utf8')) as {
    phase: string;
    manifest: { version: string };
  };
  const release = await desktopRelease();
  if (journal.phase !== 'starting' || journal.manifest.version !== release.version)
    throw new Error('Upgrade version did not match the installed application');
  await writeFile(`${file}.ready`, JSON.stringify({ version: release.version, pid: process.pid }), {
    flag: 'wx',
    mode: 0o600,
  });
}

/**
 * Check, stage and hand over a manually chosen installer, then quit so the detached worker can install it.
 */
export async function manualUpgrade(ctx: MainContext): Promise<void> {
  const window = ctx.window;
  if (!window || !app.isPackaged || process.platform !== 'win32') return;
  let stopped = false;
  const hostsBusy = (): boolean =>
    (ctx.services ?? (ctx.service ? [ctx.service] : [])).some(
      (host) =>
        !host.snapshot.ready ||
        host.busy ||
        (host.snapshot.session?.otherRuns?.length ?? 0) > 0 ||
        (host.snapshot.session?.queue?.length ?? 0) > 0 ||
        Boolean(host.snapshot.sessions?.some((session) => session.activeRun)),
    );
  try {
    if (!ctx.service?.snapshot.ready || hostsBusy() || ctx.switching || ctx.quitting)
      throw new Error(mainText('upgrade.busy'));
    const current = await desktopRelease();
    const selected = await dialog.showOpenDialog(window, {
      title: mainText('upgrade.choose', { version: current.version }),
      properties: ['openFile'],
      filters: [{ name: mainText('upgrade.installer'), extensions: ['exe'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return;
    const runtime = runtimePaths(true);
    const execute = async (node: string, helper: string, args: string[]) => {
      const result = await promisify(execFile)(node, [helper, ...args], {
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    };
    const helper = path.join(__dirname, 'upgrade-worker.cjs');
    const manifest = (await execute(runtime.nodePath, helper, [
      'check',
      selected.filePaths[0],
      JSON.stringify(current),
    ])) as UpgradeManifest;
    const confirm = await dialog.showMessageBox(window, {
      type: 'question',
      title: mainText('upgrade.title'),
      message: mainText('upgrade.confirm', { current: current.version, next: manifest.version }),
      detail: mainText('upgrade.detail'),
      buttons: [mainText('upgrade.cancel'), mainText('upgrade.install')],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirm.response !== 1) return;
    const service = ctx.service;
    if (!service || hostsBusy() || ctx.switching || ctx.quitting)
      throw new Error(mainText('upgrade.busy'));
    ctx.switching = true;
    const staged = (await execute(runtime.nodePath, helper, [
      'stage',
      selected.filePaths[0],
      app.getPath('userData'),
      JSON.stringify(current),
      JSON.stringify(manifest),
    ])) as StagedUpgrade;
    const node = path.join(staged.directory, 'maintenance-node.exe'),
      copiedHelper = path.join(staged.directory, 'upgrade-worker.cjs');
    await copyFile(runtime.nodePath, node);
    await copyFile(helper, copiedHelper);
    const stagedFile = path.join(staged.directory, 'selection.json');
    await writeFile(stagedFile, JSON.stringify(staged), { flag: 'wx', mode: 0o600 });
    const workspace = service.snapshot.workspace;
    ctx.quitting = true;
    ctx.settingsAbort.abort();
    await Promise.all([...ctx.profileWrites]);
    stopped = true;
    if (ctx.stopServices) await ctx.stopServices();
    else await service.stop();
    await execute(node, copiedHelper, [
      'prepare',
      stagedFile,
      path.dirname(app.getPath('exe')),
      path.join(workspace, '.yuantu/sessions.sqlite'),
      JSON.stringify(current),
      workspace,
    ]);
    const log = openSync(path.join(staged.directory, 'upgrade.log'), 'a', 0o600);
    try {
      const worker = spawn(node, [copiedHelper, 'install', staged.journal, String(process.pid)], {
        cwd: staged.directory,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log, log],
      });
      await new Promise<void>((resolve, reject) => {
        worker.once('spawn', () => resolve());
        worker.once('error', reject);
      });
      worker.unref();
    } finally {
      closeSync(log);
    }
    ctx.quitAllowed = true;
    app.quit();
  } catch (error) {
    dialog.showErrorBox(
      mainText('upgrade.failed'),
      `${safeError(error)}\n${mainText('upgrade.recovery')}`,
    );
    if (stopped) {
      ctx.quitAllowed = true;
      app.quit();
    } else {
      ctx.quitting = false;
      ctx.switching = false;
      ctx.renewSettingsAbort();
    }
  }
}
