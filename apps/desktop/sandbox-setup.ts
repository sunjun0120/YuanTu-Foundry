import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolEnvironment } from '../../packages/tools/environment.ts';
import { parseAccountStatus } from '../../packages/tools/sandbox-account.ts';

export type SandboxSetupCommand =
  | { type: 'status' }
  | { type: 'initialize'; acknowledge: true }
  | { type: 'uninstall'; acknowledge: true }
  | { type: 'read-add' | 'read-remove'; path: string; acknowledge: true };
export interface SandboxSetupView {
  supported: boolean;
  ready: boolean;
  installed: boolean;
  reason: 'platform' | 'unavailable' | null;
  state?: 'uninitialized' | 'ready' | 'damaged';
  problems?: string[];
}
export type SandboxSetupReply = { ok: true; view: SandboxSetupView } | { ok: false; error: string };
/** Bound the UI's wait, without pretending a detached elevated initializer can be cancelled. */
export async function waitForSandboxInitialization(
  pending: Promise<unknown> | undefined,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!pending) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function parseSandboxSetupCommand(input: unknown): SandboxSetupCommand {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (
      (value.type === 'read-add' || value.type === 'read-remove') &&
      value.acknowledge === true &&
      typeof value.path === 'string' &&
      value.path.trim().length > 0 &&
      value.path.length <= 32768 &&
      !value.path.includes('\0') &&
      Object.keys(value).every((key) => ['type', 'path', 'acknowledge'].includes(key))
    )
      return { type: value.type, path: value.path.trim(), acknowledge: true };
    if (value.type === 'status' && Object.keys(value).length === 1) return { type: 'status' };
    if (
      (value.type === 'initialize' || value.type === 'uninstall') &&
      value.acknowledge === true &&
      Object.keys(value).every((key) => key === 'type' || key === 'acknowledge')
    )
      return { type: value.type, acknowledge: true };
  }
  throw new Error('Invalid sandbox initialization request');
}
export interface SandboxSetupOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  execute?: (file: string, args: string[], timeout: number) => Promise<{ stdout: string }>;
  changed?: () => Promise<void>;
  changing?: () => Promise<void>;
}
/** Account maintenance uses a captured helper and fixed operations; opening settings never requests UAC. */
export class WindowsAccountSandboxSetup {
  private readonly options: SandboxSetupOptions;
  private readonly execute: NonNullable<SandboxSetupOptions['execute']>;
  private pending = false;
  constructor(options: SandboxSetupOptions) {
    this.options = { ...options };
    this.execute =
      options.execute ??
      (async (file, args, timeout) => {
        const result = await promisify(execFile)(file, args, {
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 65536,
          timeout,
          env: toolEnvironment(),
        });
        return { stdout: result.stdout };
      });
  }
  async status(): Promise<SandboxSetupView> {
    const base: SandboxSetupView = {
      supported: this.options.platform === 'win32',
      ready: false,
      installed: false,
      reason: null,
    };
    if (!base.supported) return { ...base, reason: 'platform' };
    try {
      const status = parseAccountStatus(
        (await this.execute(this.options.helperPath, ['account-status'], 15000)).stdout,
      );
      const initialized =
        status.accounts.some((account) => account.sid !== null) || status.group !== null;
      return {
        ...base,
        ready: true,
        installed: status.ready,
        reason: null,
        state: status.ready
          ? 'ready'
          : initialized || !status.problems.includes('accounts-missing')
            ? 'damaged'
            : 'uninitialized',
        problems: status.problems,
      };
    } catch {
      return { ...base, reason: 'unavailable' };
    }
  }
  private async mutate(
    operation: 'account-setup' | 'account-uninstall',
  ): Promise<SandboxSetupView> {
    if (this.pending) throw new Error('Sandbox maintenance is already in progress');
    this.pending = true;
    try {
      const before = await this.status();
      if (!before.ready) throw new Error(`Sandbox maintenance is unavailable: ${before.reason}`);
      await this.options.changing?.();
      try {
        // Killing the UAC parent cannot cancel the elevated child: do not set a timeout.
        await this.execute(this.options.helperPath, [operation], 0);
      } finally {
        // A cancelled/partly failed repair can also have changed accounts or passwords.
        await this.options.changed?.();
      }
      const after = await this.status();
      if (
        !after.ready ||
        (operation === 'account-setup' ? !after.installed : after.state !== 'uninitialized')
      )
        throw new Error('Account maintenance completed without a verified status');
      return after;
    } finally {
      this.pending = false;
    }
  }
  initialize(): Promise<SandboxSetupView> {
    return this.mutate('account-setup');
  }
  uninstall(): Promise<SandboxSetupView> {
    return this.mutate('account-uninstall');
  }
  async allowRead(path: string, remove: boolean): Promise<SandboxSetupView> {
    if (this.pending) throw new Error('Sandbox maintenance is already in progress');
    this.pending = true;
    try {
      const before = await this.status();
      if (!before.ready || (!remove && before.state === 'uninitialized'))
        throw new Error('Sandbox accounts must be ready before changing read access');
      try {
        await this.execute(
          this.options.helperPath,
          [remove ? 'read-ungrant' : 'read-grant', '--root', path],
          0,
        );
      } finally {
        await this.options.changed?.();
      }
      return await this.status();
    } finally {
      this.pending = false;
    }
  }
}
