import { MAX_DOCUMENT_BYTES, type AttachmentReply } from './attachment-contract.ts';
import { SandboxEnvironment } from './sandbox-environment.ts';
import { Worker } from 'node:worker_threads';
import { McpSettingsStore } from './mcp-settings.ts';
import { parseMcpCommand, type McpReply } from './mcp-contract.ts';
import { parseFilesCommand, type FilesReply } from './files-contract.ts';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, clipboard, Menu } from 'electron';
import { writeFile, copyFile, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DesktopRelease,
  StagedUpgrade,
  UpgradeManifest,
} from '../../packages/maintenance/desktop-upgrade.ts';
import path from 'node:path';
import { desktopPaths } from './install-paths.ts';
import { pathToFileURL } from 'node:url';
import { mkdirSync, realpathSync, statSync, openSync, closeSync } from 'node:fs';
import { CarrierService, parseCarrierCommand } from '../../packages/carrier/index.ts';
import type { DesktopReply } from './contract.ts';
import { redactSecrets } from '../../packages/core/errors.ts';
import { ModelSettingsStore, testModelConnection } from './model-settings.ts';
import { parseSettingsCommand, type SettingsReply } from './settings-contract.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import { discoverModels } from '../../packages/providers/discovery.ts';
import { parseUiSettingsCommand, type UiSettingsReply } from './ui-settings.ts';
import { mainText, setMainLocale } from './i18n.ts';
import { UiSettingsStore } from './ui-settings-store.ts';
import { permissionPolicyForMode, type PermissionMode } from './permission-settings.ts';
import { PermissionSettingsStore } from './permission-settings-store.ts';
import {
  DEFAULT_PRESET,
  parsePermissionPresetCommand,
  permissionPreset,
  presetIdFor,
  type PermissionPresetReply,
  type PermissionPresetView,
} from './permission-presets.ts';
import type { SandboxMode } from './sandbox-settings.ts';

let window: BrowserWindow | null = null;
let service: CarrierService | null = null;
let openingService: CarrierService | null = null;
let unsubscribe: (() => void) | undefined;
let unsubscribeDelta: (() => void) | undefined;
let unsubscribeSubAgentDelta: (() => void) | undefined;
let unsubscribeStatisticsDelta: (() => void) | undefined;
let switching = false;
let quitting = false;
let quitAllowed = false;
const profileWrites = new Set<Promise<void>>();
let settingsStore: ModelSettingsStore;
let uiSettingsStore: UiSettingsStore;
let permissionSettingsStore: PermissionSettingsStore;
let sandboxEnvironment: SandboxEnvironment;
/** One session's pair: where its commands run, and how much it may do without asking. */
interface SessionChoice {
  sandbox: SandboxMode;
  permission: PermissionMode;
}
const settingsAbort = new AbortController();
let mcpAuthorize: AbortController | undefined;
const pagePath = path.join(__dirname, 'index.html');
const trustedUrl = pathToFileURL(pagePath).href;

async function desktopRelease(): Promise<DesktopRelease> {
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
async function confirmUpgradeStartup(): Promise<void> {
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
async function manualUpgrade(): Promise<void> {
  if (!window || !app.isPackaged || process.platform !== 'win32') return;
  let stopped = false;
  try {
    if (!service?.snapshot.ready || service.busy || switching || quitting)
      throw new Error(mainText('upgrade.busy'));
    const current = await desktopRelease();
    const selected = await dialog.showOpenDialog(window, {
      title: mainText('upgrade.choose', { version: current.version }),
      properties: ['openFile'],
      filters: [{ name: mainText('upgrade.installer'), extensions: ['exe'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return;
    const runtime = desktopPaths({
      packaged: true,
      resourcesPath: process.resourcesPath,
      mainDirectory: __dirname,
      userData: app.getPath('userData'),
      cwd: process.cwd(),
      env: process.env,
      args: process.argv,
    });
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
    if (!service || service.busy || switching || quitting)
      throw new Error(mainText('upgrade.busy'));
    switching = true;
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
    quitting = true;
    settingsAbort.abort();
    await Promise.all([...profileWrites]);
    await service.stop();
    stopped = true;
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
    quitAllowed = true;
    app.quit();
  } catch (error) {
    dialog.showErrorBox(
      mainText('upgrade.failed'),
      `${safeError(error)}\n${mainText('upgrade.recovery')}`,
    );
    if (stopped) {
      quitAllowed = true;
      app.quit();
    } else {
      quitting = false;
      switching = false;
    }
  }
}

/**
 * MCP credentials live in the desktop profile, never in the workspace, and the agent host child
 * must read exactly the same directory.
 */
function mcpOAuthDirectory(): string {
  return path.join(app.getPath('userData'), 'mcp-oauth');
}

function testMcpInWorker(
  root: string,
  server: import('./mcp-contract.ts').McpServer,
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
        ...sandboxEnvironment.environment(),
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

function createService(workspace: string, config?: ProviderConfig): CarrierService {
  const runtime = desktopPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname,
    userData: app.getPath('userData'),
    cwd: process.cwd(),
    env: process.env,
    args: process.argv,
  });
  return new CarrierService({
    nodePath: runtime.nodePath,
    hostPath: runtime.hostPath,
    workspace,
    env: {
      ...settingsStore.environment(config),
      ...sandboxEnvironment.environment(),
      YUANTU_PERMISSION_POLICY: permissionSettingsStore.file,
      YUANTU_MCP_OAUTH_DIR: mcpOAuthDirectory(),
    },
  });
}
function attach(next: CarrierService): CarrierService {
  unsubscribe?.();
  unsubscribeDelta?.();
  unsubscribeSubAgentDelta?.();
  unsubscribeStatisticsDelta?.();
  // A replacement Host starts with launch defaults, even when it loads the same session.
  live = undefined;
  showing = undefined;
  moving = undefined;
  following = undefined;
  service = next;
  unsubscribe = next.subscribe((state) => {
    if (state.ready && state.session.sessionId) followSession(state.session.sessionId);
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:state', state);
  });
  // Streamed text travels on its own channel so a token never serialises the whole snapshot.
  unsubscribeDelta = next.subscribeDelta((delta) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:delta', delta);
  });
  unsubscribeSubAgentDelta = next.subscribeSubAgentDelta((delta) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:subagent-delta', delta);
  });
  // Usage and activity change once a second during a model call; sending them on their own channel keeps
  // that from serialising the session (images included) across IPC every time the numbers move.
  unsubscribeStatisticsDelta = next.subscribeStatisticsDelta((delta) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:statistics-delta', delta);
  });
  return next;
}
function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : 'Desktop operation failed');
}
/**
 * The pair a session is in, and the pair the live carrier is actually enforcing.
 *
 * Two facts rather than one, because they can differ for as long as it takes to move — and because the carrier
 * is *one process serving every session* (`packages/tools/sandbox-provider.ts` reads the mode per command), so
 * "which pair is session X in" is knowledge only the desktop has. `sessions` remembers a choice for as long as
 * the window is open; a session nobody has chosen for starts at `defaultChoice()`, which is the whole of "a new
 * session resets": there is nothing to clear, because the choice was never kept anywhere else.
 */
const sessions = new Map<string, SessionChoice>();
let live: SessionChoice | undefined;
const defaultChoice = (): SessionChoice => ({
  sandbox: sandboxEnvironment.defaultMode,
  permission: permissionPreset(DEFAULT_PRESET).permission,
});
const choiceFor = (sessionId: string | undefined): SessionChoice =>
  (sessionId ? sessions.get(sessionId) : undefined) ?? defaultChoice();
/**
 * Moves the live carrier onto one pair: the sandbox over the carrier's own command (the Host enforces it from
 * the next command on), the approval floor through the service handle.
 *
 * The cached pair is committed only after both settings succeed. Invalidate it on a failure so a retry
 * reapplies both halves instead of assuming a partly completed update left enforcement unchanged.
 */
async function applyChoice(choice: SessionChoice): Promise<void> {
  const target = service;
  if (!target) throw new Error('The desktop is not connected to a carrier yet.');
  try {
    if (!live || live.sandbox !== choice.sandbox)
      await target.dispatch({ type: 'sandbox', mode: choice.sandbox });
    if (!live || live.permission !== choice.permission)
      await target.updatePermissionPolicy(permissionPolicyForMode(choice.permission));
  } catch (error) {
    live = undefined;
    throw error;
  }
  live = { ...choice };
  /**
   * The availability of the backend is asked for *after* the switch and never awaited: the answer costs a
   * process (`sbx`/`docker --version`), and what a person is waiting for is the switch — a chip that froze for a
   * second and a half before redrawing would be the interface paying for a footnote. The window is told when the
   * answer lands, which is what the push channel is for.
   */
  if (!sandboxEnvironment.known(choice.sandbox)) {
    void sandboxEnvironment
      .probe(choice.sandbox)
      .then(() => pushPresets())
      .catch((error: unknown) =>
        console.error('desktop: could not probe the sandbox backend', error),
      );
  }
}
/**
 * Follows the session the window is showing, and answers the one question this feature has: when the session
 * changes, what should the sandbox be? A session with a remembered choice gets it back; a session nobody has
 * chosen for — including every newly created one — gets the default.
 */
let showing: string | undefined;
/** A move in flight for a session; a second state update carrying the same id must not start a second one. */
let moving: string | undefined;
let following: Promise<void> | undefined;
function followSession(sessionId: string): void {
  if ((sessionId === showing && live !== undefined) || sessionId === moving) return;
  moving = sessionId;
  following = applyChoice(choiceFor(sessionId))
    .then(() => {
      showing = sessionId;
      pushPresets();
    })
    .finally(() => {
      if (moving === sessionId) moving = undefined;
    });
  void following.catch((error: unknown) => {
    // Leave `showing` unchanged after a failure so a later ready snapshot can retry the session's choice.
    console.error('desktop: could not apply the session sandbox', error);
  });
}
/** Tell the window which pair its session is in, once it is actually in it. */
function pushPresets(): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send('yuantu:presets-view', presetView());
}
/** Both knobs as the chip renders them, and which preset (if any) that pair currently is. */
function presetView(): PermissionPresetView {
  const choice = live ?? choiceFor(showing ?? service?.snapshot.session.sessionId ?? undefined);
  return {
    current: presetIdFor(choice.sandbox, choice.permission),
    sandbox: {
      mode: choice.sandbox,
      image: sandboxEnvironment.image,
      availability: sandboxEnvironment.cached(choice.sandbox),
    },
    permission: choice.permission,
  };
}

app.setName('YuanTu Agent');
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'YuanTu Agent'));
}
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  console.info('[desktop] Existing window activated.');
  app.quit();
}
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
app.on('before-quit', (event) => {
  if (quitAllowed) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  settingsAbort.abort();
  void (async () => {
    try {
      const results = await Promise.allSettled([service?.stop(), openingService?.stop()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (error) {
      dialog.showErrorBox(mainText('desktop.exitFailureTitle'), safeError(error));
    } finally {
      quitAllowed = true;
      app.quit();
    }
  })();
});
app.on('window-all-closed', () => app.quit());

void app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return;
    settingsStore = new ModelSettingsStore(
      path.join(app.getPath('userData'), 'model-settings.json'),
      {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
    );
    await settingsStore.load();
    uiSettingsStore = new UiSettingsStore(path.join(app.getPath('userData'), 'ui-settings.json'));
    await uiSettingsStore.load();
    /**
     * The language this process writes its own text in, taken from the settings file rather than from the window.
     *
     * A failure dialog can be raised before the renderer has loaded, so the main process cannot wait to be told:
     * the text it produces is read by a person either way, and the same dictionary answers both sides.
     */
    setMainLocale(uiSettingsStore.view.language);
    if (app.isPackaged && process.platform === 'win32') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: mainText('upgrade.menu'),
            submenu: [
              {
                label: mainText('upgrade.check'),
                click: () => {
                  void manualUpgrade();
                },
              },
              {
                label: mainText('upgrade.about'),
                click: () => {
                  void desktopRelease().then((release) =>
                    dialog.showMessageBox({
                      message: `YuanTu Agent ${release.version}`,
                      detail: `Channel: ${release.channel}`,
                    }),
                  );
                },
              },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
        ]),
      );
    }
    permissionSettingsStore = new PermissionSettingsStore(
      path.join(app.getPath('userData'), 'permission-policy.json'),
    );
    await permissionSettingsStore.load();
    sandboxEnvironment = new SandboxEnvironment();
    // Warmed for the default mode so the first paint of the chip can say whether that backend is usable; every
    // other mode is probed when a session moves to it, and the answer is remembered.
    void sandboxEnvironment.probe(sandboxEnvironment.defaultMode);
    const runtime = desktopPaths({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDirectory: __dirname,
      userData: app.getPath('userData'),
      cwd: process.cwd(),
      env: process.env,
      args: process.argv,
    });
    if (app.isPackaged && runtime.workspace === path.join(app.getPath('userData'), 'workspace'))
      mkdirSync(runtime.workspace, { recursive: true });
    const workspace = realpathSync(runtime.workspace);
    if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
    window = new BrowserWindow({
      width: 1220,
      height: 860,
      minWidth: 820,
      minHeight: 620,
      title: 'YuanTu Agent',
      backgroundColor: '#f8f9fb',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.removeMenu();
    window.on('close', (event) => {
      if (!quitAllowed) {
        event.preventDefault();
        app.quit();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    const initial = attach(createService(workspace));
    const assertSender = (event: Electron.IpcMainInvokeEvent) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== trustedUrl
      )
        throw new Error('Untrusted desktop sender');
    };
    let readingAttachment = false;
    ipcMain.handle('yuantu:attachment', async (event, input): Promise<AttachmentReply> => {
      try {
        assertSender(event);
        if (readingAttachment) throw new Error(mainText('attach.busy'));
        if (
          !input ||
          typeof input.name !== 'string' ||
          !(input.data instanceof Uint8Array) ||
          input.data.byteLength > MAX_DOCUMENT_BYTES
        )
          throw new Error(mainText('attach.invalid'));
        readingAttachment = true;
        try {
          return await new Promise<AttachmentReply>((resolve) => {
            const worker = new Worker(path.join(__dirname, 'attachment-worker.cjs'), {
              // The language travels with the work: a worker thread has its own copy of every module, so the one
              // message it can produce would otherwise be in the default language.
              workerData: { ...input, language: uiSettingsStore.view.language },
              resourceLimits: { maxOldGenerationSizeMb: 256 },
            });
            let settled = false;
            const finish = (reply: AttachmentReply) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              void worker.terminate();
              resolve(reply);
            };
            const timer = setTimeout(
              () => finish({ ok: false, error: mainText('attach.timeout') }),
              20000,
            );
            worker.once('message', finish);
            worker.once('error', () => finish({ ok: false, error: mainText('attach.readFailed') }));
            worker.once('exit', () =>
              finish({ ok: false, error: mainText('attach.workerExited') }),
            );
          });
        } finally {
          readingAttachment = false;
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : mainText('attach.failed'),
        };
      }
    });
    ipcMain.handle('yuantu:files', async (event, input: unknown): Promise<FilesReply> => {
      try {
        assertSender(event);
        const command = parseFilesCommand(input);
        if (!service || quitting) throw new Error(mainText('desktop.quitting'));
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
          : { ok: true, preview: await service.readWorkspaceFile({ path: command.path }) };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
    ipcMain.handle('yuantu:mcp', async (event, input: unknown): Promise<McpReply> => {
      try {
        assertSender(event);
        const command = parseMcpCommand(input);
        if (command.type === 'cancel-authorize') {
          mcpAuthorize?.abort(new Error('MCP authorization cancelled'));
          return { ok: true, message: mainText('mcpMain.cancelAuthorize') };
        }
        if (!service || quitting) throw new Error(mainText('desktop.quitting'));
        const store = new McpSettingsStore(service.snapshot.workspace, mcpOAuthDirectory());
        if (command.type === 'get') return { ok: true, view: store.view() };
        if (command.type === 'authorize' && mcpAuthorize)
          throw new Error(mainText('mcpMain.authorizeInProgress'));
        if (switching || service.busy) throw new Error(mainText('mcpMain.busy'));
        switching = true;
        try {
          if (command.type === 'test') {
            const result = await testMcpInWorker(
              service.snapshot.workspace,
              command.server,
              AbortSignal.any([settingsAbort.signal, AbortSignal.timeout(15000)]),
              command.revision,
            );
            return {
              ok: true,
              message: mainText('mcpMain.testSucceeded', { count: result.count }),
            };
          }
          if (command.type === 'authorize') {
            const controller = new AbortController();
            mcpAuthorize = controller;
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
                  settingsAbort.signal,
                  controller.signal,
                  AbortSignal.timeout(300_000),
                ]),
              );
            } finally {
              if (mcpAuthorize === controller) mcpAuthorize = undefined;
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
          switching = false;
        }
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
    /** Hold the shell operation guard across both halves of a preset update. */
    const assertPresetChangeAllowed = (): void => {
      if (!service || quitting || switching)
        throw new Error('Wait for the current desktop operation before changing the sandbox.');
    };
    ipcMain.handle(
      'yuantu:presets',
      async (event, input: unknown): Promise<PermissionPresetReply> => {
        try {
          assertSender(event);
          const command = parsePermissionPresetCommand(input);
          if (command.type === 'get') return { ok: true, view: presetView() };
          const preset = permissionPreset(command.preset);
          assertPresetChangeAllowed();
          switching = true;
          try {
            await following;
            const choice: SessionChoice = {
              sandbox: preset.sandbox,
              permission: preset.permission,
            };
            await applyChoice(choice);
            const sessionId = service?.snapshot.session.sessionId;
            if (sessionId) sessions.set(sessionId, choice);
            return {
              ok: true,
              view: presetView(),
              message: `Preset applied: ${preset.sandbox} + ${preset.permission}.`,
            };
          } finally {
            switching = false;
          }
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    ipcMain.handle(
      'yuantu:ui-settings',
      async (event, input: unknown): Promise<UiSettingsReply> => {
        try {
          assertSender(event);
          const command = parseUiSettingsCommand(input);
          if (command.type === 'get')
            return { ok: true, kind: 'settings', settings: uiSettingsStore.view };
          if (quitting || switching) throw new Error(mainText('desktop.quitting'));
          const saving = uiSettingsStore.save(command.settings);
          profileWrites.add(saving);
          try {
            await saving;
          } finally {
            profileWrites.delete(saving);
          }
          // The renderer draws the interface in this language, so the messages this process produces for it have
          // to be in the same one -- otherwise the settings page is English and its validation errors are not.
          setMainLocale(uiSettingsStore.view.language);
          return { ok: true, kind: 'settings', settings: uiSettingsStore.view };
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    ipcMain.handle('yuantu:settings', async (event, input: unknown): Promise<SettingsReply> => {
      let submittedKey = '';
      try {
        assertSender(event);
        const command = parseSettingsCommand(input);
        if (quitting) throw new Error(mainText('desktop.quitting'));
        if (command.type === 'get') return { ok: true, settings: settingsStore.view };
        submittedKey = 'values' in command ? command.values.apiKey : '';
        if (!service || switching || service.busy) throw new Error(mainText('settingsMain.busy'));
        if (command.type === 'delete') {
          switching = true;
          try {
            await settingsStore.delete(command.connectionId);
            return {
              ok: true,
              settings: settingsStore.view,
              message: mainText('settingsMain.connectionDeleted'),
            };
          } finally {
            switching = false;
          }
        }
        const preparedGroup =
          command.type === 'save-group' ? settingsStore.prepareGroup(command.values) : null;
        const config =
          command.type === 'select'
            ? settingsStore.configFor(command.connectionId)
            : command.type === 'save-group'
              ? preparedGroup!.activeConfig
              : settingsStore.prepare(command.values);
        switching = true;
        try {
          if (command.type === 'discover') {
            /**
             * The endpoint's own catalogue, read with the credential in the form.
             *
             * This is the desktop half of "capacity comes from the provider": the two numbers a run needs are
             * the ones this runtime refuses to invent, and the endpoint usually publishes them. Nothing is
             * saved and nothing is applied — the renderer fills fields the operator can still edit.
             */
            const discovered = await discoverModels(config, {
              signal: AbortSignal.any([settingsAbort.signal, AbortSignal.timeout(15_000)]),
            });
            return {
              ok: true,
              settings: settingsStore.view,
              discovered,
              message: mainText('settingsMain.modelsRead', { count: discovered.models.length }),
            };
          }
          if (command.type === 'test') {
            await testModelConnection(
              config,
              AbortSignal.any([settingsAbort.signal, AbortSignal.timeout(15_000)]),
            );
            return {
              ok: true,
              settings: settingsStore.view,
              message: mainText('settingsMain.testSucceeded'),
            };
          }
          const previous = service.snapshot;
          const next = createService(previous.workspace, config);
          openingService = next;
          try {
            await next.start(previous.session.sessionId || undefined);
            if (quitting) throw new Error(mainText('desktop.quitting'));
            if (command.type === 'select') await settingsStore.select(command.connectionId);
            else if (preparedGroup) await settingsStore.savePreparedGroup(preparedGroup);
            else await settingsStore.save(config);
            if (quitting) throw new Error(mainText('desktop.quitting'));
            let cleanupWarning = false;
            try {
              await service.stop();
            } catch {
              cleanupWarning = true;
            }
            if (quitting) throw new Error(mainText('desktop.quitting'));
            attach(next);
            await following;
            return {
              ok: true,
              settings: settingsStore.view,
              message: cleanupWarning
                ? mainText('settingsMain.savedCleanupWarning')
                : mainText('settingsMain.saved'),
            };
          } finally {
            try {
              if (service !== next) await next.stop();
            } finally {
              openingService = null;
            }
          }
        } finally {
          switching = false;
        }
      } catch (error) {
        return {
          ok: false,
          error: redactSecrets(safeError(error), { YUANTU_API_KEY: submittedKey }),
        };
      }
    });
    ipcMain.handle('yuantu:command', async (event, input: unknown): Promise<DesktopReply> => {
      try {
        assertSender(event);
        const command = parseCarrierCommand(input);
        if (command.type === 'sandbox')
          throw new Error('Change the sandbox through a confirmed permission preset.');
        if (!service || quitting) throw new Error('Desktop is shutting down');
        if (command.type === 'copyText') {
          clipboard.writeText(command.text);
          return { ok: true, state: service.snapshot };
        }
        if (command.type === 'openLink') {
          await shell.openExternal(command.url);
          return { ok: true, state: service.snapshot };
        }
        if (command.type === 'export') {
          const result = await dialog.showSaveDialog(window!, {
            title: mainText('desktop.exportTitle'),
            defaultPath: path.join(
              service.snapshot.workspace,
              command.suggestedName || 'yuantu-session.md',
            ),
            filters: [
              { name: 'Markdown', extensions: ['md'] },
              { name: mainText('desktop.textFilter'), extensions: ['txt'] },
            ],
          });
          if (!result.canceled && result.filePath)
            await writeFile(result.filePath, command.content, 'utf8');
          return { ok: true, state: service.snapshot };
        }
        if (switching && command.type !== 'snapshot') throw new Error('Workspace is changing');
        if (command.type === 'chooseWorkspace') {
          const state = service.snapshot;
          if (!state.ready || state.session.running || state.session.loading)
            throw new Error('Wait for the current operation to finish');
          switching = true;
          try {
            const result = await dialog.showOpenDialog(window!, {
              title: mainText('desktop.chooseWorkspaceTitle'),
              defaultPath: state.workspace,
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths[0] && !quitting) {
              const selected = realpathSync(result.filePaths[0]);
              if (selected !== state.workspace) {
                const next = createService(selected);
                openingService = next;
                try {
                  await next.start();
                  if (!quitting) {
                    await service.stop();
                    if (!quitting) attach(next);
                  }
                } finally {
                  if (service !== next) await next.stop();
                  openingService = null;
                }
              }
            }
            return { ok: true, state: service.snapshot };
          } finally {
            switching = false;
          }
        }
        if (command.type !== 'snapshot') await following;
        const state = await service.dispatch(command);
        if (command.type !== 'snapshot') await following;
        return { ok: true, state };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
    await window.loadFile(pagePath);
    window.show();
    // Startup failures remain visible in the chat window; no silent retries of runs.
    if (!quitting)
      await initial
        .start()
        .then(async () => {
          await confirmUpgradeStartup();
          console.info('[desktop] host.ready');
        })
        .catch((error) => {
          if (app.commandLine.hasSwitch('upgrade-journal'))
            dialog.showErrorBox(
              mainText('upgrade.failed'),
              `${safeError(error)}\n${mainText('upgrade.recovery')}`,
            );
        });
  })
  .catch((error) => {
    dialog.showErrorBox(mainText('desktop.startFailureTitle'), safeError(error));
    app.quit();
  });
