import { app, type BrowserWindow } from 'electron';
import type { CarrierService } from '../../packages/carrier/index.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import { carrierErrorReply } from './carrier-errors.ts';
import { desktopPaths } from './install-paths.ts';
import type { SandboxEnvironment } from './sandbox-environment.ts';

/**
 * The main process's shared state, as the modules split out of `main.ts` see it.
 *
 * `main.ts` still owns every binding; this is a view of them with live getters (and setters for the three flags the
 * operations take turns on), so a module reads the current window or carrier at the moment it acts rather than the
 * one that existed when it was set up. `switching` is the single "an operation owns the shell" flag: whoever sets it
 * clears it in a `finally`, and every handler that would interfere checks it first.
 */
export interface MainContext {
  readonly window: BrowserWindow | null;
  readonly service: CarrierService | null;
  openingService: CarrierService | null;
  switching: boolean;
  quitting: boolean;
  quitAllowed: boolean;
  /** The session sandbox move in flight, if any; a handler that dispatches waits for it first. */
  readonly following: Promise<void> | undefined;
  readonly settingsAbort: AbortController;
  /** A fresh `settingsAbort` after an operation that aborted it gave up and left the app running. */
  renewSettingsAbort(): void;
  readonly sandboxEnvironment: SandboxEnvironment;
  readonly profileWrites: ReadonlySet<Promise<void>>;
  createService(workspace: string, config?: ProviderConfig): CarrierService;
  attach(next: CarrierService): CarrierService;
  assertSender(event: Electron.IpcMainInvokeEvent): void;
}

export function safeError(error: unknown): string {
  return carrierErrorReply(error).error;
}

/** Where the bundled Node, the Host and the workspace are for this launch. */
export function runtimePaths(packaged = app.isPackaged): ReturnType<typeof desktopPaths> {
  return desktopPaths({
    packaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname,
    userData: app.getPath('userData'),
    cwd: process.cwd(),
    env: process.env,
    args: process.argv,
  });
}
