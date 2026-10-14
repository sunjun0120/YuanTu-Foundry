import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appContainerRuntimeError } from '../../packages/tools/appcontainer-runtime.ts';
import { toolEnvironment } from '../../packages/tools/environment.ts';

export type SandboxSetupCommand = { type: 'status' } | { type: 'initialize'; acknowledge: true };
export interface SandboxSetupView {
  supported: boolean;
  ready: boolean;
  installed: boolean;
  reason: 'platform' | 'development' | 'runtime' | 'release' | null;
}
export type SandboxSetupReply = { ok: true; view: SandboxSetupView } | { ok: false; error: string };
export function parseSandboxSetupCommand(input: unknown): SandboxSetupCommand {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (value.type === 'status' && Object.keys(value).length === 1) return { type: 'status' };
    if (
      value.type === 'initialize' &&
      value.acknowledge === true &&
      Object.keys(value).every((key) => key === 'type' || key === 'acknowledge')
    )
      return { type: 'initialize', acknowledge: true };
  }
  throw new Error('Invalid sandbox initialization request');
}
export interface SandboxSetupOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  helperPath: string;
  nodePath: string;
  execute?: (file: string, args: string[], timeout: number) => Promise<{ stdout: string }>;
}
export class WindowsSandboxSetup {
  private readonly options: SandboxSetupOptions;
  private readonly execute: NonNullable<SandboxSetupOptions['execute']>;
  private pending = false;
  constructor(options: SandboxSetupOptions) {
    this.options = { ...options };
    const executeFile = promisify(execFile);
    this.execute =
      options.execute ??
      (async (file, args, timeout) => {
        const result = await executeFile(file, args, {
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 65536,
          timeout,
          env: toolEnvironment(),
        });
        return { stdout: result.stdout };
      });
  }
  private async installed(): Promise<boolean> {
    const reply: unknown = JSON.parse(
      (await this.execute(this.options.helperPath, ['network-status'], 15000)).stdout,
    );
    if (
      !reply ||
      typeof reply !== 'object' ||
      !('version' in reply) ||
      reply.version !== 1 ||
      !('profiles' in reply) ||
      !Array.isArray(reply.profiles) ||
      !reply.profiles.length ||
      reply.profiles.length > 16
    )
      throw new Error('Invalid installed network policy status');
    const names = new Set<string>();
    const sids = new Set<string>();
    for (const profile of reply.profiles) {
      if (
        !profile ||
        typeof profile !== 'object' ||
        typeof profile.name !== 'string' ||
        !/^Yuantu\.Sandbox\.[0-9a-f-]{36}$/i.test(profile.name) ||
        typeof profile.sid !== 'string' ||
        !/^S-1-15-2-\d+(?:-\d+)*$/.test(profile.sid) ||
        names.has(profile.name) ||
        sids.has(profile.sid)
      )
        throw new Error('Invalid installed network policy identity');
      names.add(profile.name);
      sids.add(profile.sid);
    }
    return true;
  }
  async status(): Promise<SandboxSetupView> {
    const view: SandboxSetupView = {
      supported: this.options.platform === 'win32',
      ready: false,
      installed: false,
      reason: null,
    };
    if (!view.supported) return { ...view, reason: 'platform' };
    if (!this.options.packaged) return { ...view, reason: 'development' };
    try {
      const uv = (
        await this.execute(this.options.nodePath, ['-p', 'process.versions.uv'], 10000)
      ).stdout.trim();
      // Identity is a setup prerequisite; version numbers cannot prove guest
      // child-pipe compatibility. The provider probes that before execution.
      if (appContainerRuntimeError(uv)) return { ...view, reason: 'runtime' };
    } catch {
      return { ...view, reason: 'runtime' };
    }
    try {
      const reply: unknown = JSON.parse(
        (await this.execute(this.options.helperPath, ['network-preflight'], 15000)).stdout,
      );
      if (
        !reply ||
        typeof reply !== 'object' ||
        !('version' in reply) ||
        reply.version !== 1 ||
        !('ready' in reply) ||
        reply.ready !== true
      )
        throw new Error('Invalid initializer preflight');
    } catch {
      return { ...view, reason: 'release' };
    }
    try {
      view.installed = await this.installed();
    } catch {
      /* Missing/damaged policy is not success. */
    }
    return { ...view, ready: true };
  }
  async initialize(): Promise<SandboxSetupView> {
    if (this.pending) throw new Error('Sandbox initialization is already in progress');
    this.pending = true;
    try {
      const view = await this.status();
      if (!view.ready) throw new Error(`Sandbox initialization is unavailable: ${view.reason}`);
      if (view.installed) return view;
      // Only the verified native helper requests elevation, using its own fixed
      // operation. Never build a shell command or pass renderer-selected paths.
      // No timeout: killing the UAC parent does not cancel an elevated child.
      await this.execute(this.options.helperPath, ['network-setup'], 0);
      try {
        await this.installed();
      } catch {
        throw new Error('Initialization completed without a verified network policy status');
      }
      return { ...view, installed: true };
    } finally {
      this.pending = false;
    }
  }
}
