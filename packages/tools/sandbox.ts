import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { toolEnvironment } from './environment.ts';
import { killTree } from './process.ts';
import {
  registerSandboxProvider,
  resolveSandboxConfig,
  sandboxProvider,
  insideWorkspace,
  type SandboxCategory,
  type SandboxConfig,
  type SandboxMode,
  type SandboxPlan,
  type SandboxRequest,
} from './sandbox-provider.ts';
import { windowsSandboxProvider } from './sandbox-windows.ts';
// The seam is `sandbox-provider.ts`; this file is the three backends that ship with the project plus the public
// API, which is now a dispatch. Both are re-exported so a caller that only wants "the sandbox" keeps importing
// one module — and so the built-ins are reachable through the same seam an embedder registers through.
export {
  registerSandboxProvider,
  resolveSandboxConfig,
  sandboxModeOverride,
  sandboxProvider,
  sandboxProviders,
  setSandboxMode,
} from './sandbox-provider.ts';
export type {
  SandboxCategory,
  SandboxConfig,
  SandboxMode,
  SandboxPlan,
  SandboxProvider,
  SandboxRequest,
} from './sandbox-provider.ts';
function dockerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ])
    if (source[name]) env[name] = source[name];
  return env;
}
// Fail closed on links (including junctions), special files, likely credentials, and oversized trees.
// The selected workspace must still be trusted: arbitrary source files can contain secrets.
async function inspectWorkspace(root: string): Promise<void> {
  let count = 0;
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 100000) throw new Error('Sandbox workspace inspection limit exceeded');
      if (directory === root && ['.git', '.yuantu'].includes(entry.name)) {
        if ((await lstat(path.join(directory, entry.name))).isSymbolicLink())
          throw new Error('Sandbox internal directory cannot be a link');
        if (!entry.isDirectory()) throw new Error('Sandbox internal path must be a directory');
        continue;
      }
      const target = path.join(directory, entry.name);
      if (
        entry.name.toLowerCase() !== '.env.example' &&
        /^(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|id_(rsa|ed25519)|.*\.(pem|p12|pfx|key)|.*\.sqlite(?:3)?|.*\.db)$/i.test(
          entry.name,
        )
      )
        throw new Error('Sandbox refuses sensitive workspace file: ' + path.relative(root, target));
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error('Sandbox refuses links or special files: ' + path.relative(root, target));
      if (stat.isDirectory()) await visit(target);
    }
  };
  await visit(root);
}
async function runLifecycle(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 120000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-4096);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Sandbox setup timed out'));
    }, timeout);
    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(error.trim() || `Sandbox setup failed with exit code ${code}`));
    });
  });
}
const sbxPreflight = new Map<string, Promise<void>>();
async function requireSbx(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = dockerEnvironment(source);
  const pathKey = env.PATH ?? env.Path ?? '';
  let pending = sbxPreflight.get(pathKey);
  if (!pending) {
    pending = runLifecycle('sbx', ['--help'], env, 5000).catch(() => {
      sbxPreflight.delete(pathKey);
      throw new Error(
        'sbx is unavailable; install Docker Sandboxes or select another sandbox mode',
      );
    });
    sbxPreflight.set(pathKey, pending);
  }
  await pending;
}
/** Whether the container backends can run here. Answers with a message, because the caller's next step is a person. */
async function containerAvailable(
  mode: SandboxMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    if (mode === 'sbx') await requireSbx(env);
    else await runLifecycle('docker', ['--version'], dockerEnvironment(env), 5000);
    return null;
  } catch {
    return mode === 'sbx'
      ? 'sbx is unavailable; install Docker Sandboxes or select another sandbox mode'
      : 'Docker CLI is unavailable; install Docker or select another sandbox mode';
  }
}
/** Asks the backend that would run the command whether it can. Dispatch, so a registered backend answers this too. */
export async function checkSandboxAvailability(
  mode: SandboxMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return sandboxProvider(mode).available(env);
}
/**
 * The host backend: no isolation at all, but the same shell, cwd and sanitised environment every other
 * backend runs the command with — which is what makes "host" a plan rather than a special case upstream.
 */
async function hostPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  const win = process.platform === 'win32';
  const { command, argv, cwd } = request;
  return {
    executable: argv ? command : win ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    args: argv ? [...argv] : win ? ['/d', '/s', '/c', '"' + command + '"'] : ['-c', command],
    cwd,
    env: { ...toolEnvironment(), ...(request.env ?? {}) },
    windowsVerbatimArguments: win && !argv,
  };
}
/**
 * The container backends, `docker` and `sbx`: the same shape — preflight, workspace inspection, create, wrap —
 * with a different CLI and a different notion of where the workspace lives.
 *
 * They share one implementation on purpose: the differences are argv and a scratch copy, and splitting them
 * would duplicate the inspection and fail-closed rules that must not drift apart between backends.
 */
async function containerPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  const win = process.platform === 'win32';
  const { root, cwd, command, argv, config } = request;
  const canonical = await realpath(root);
  if (canonical === path.parse(canonical).root || canonical === (await realpath(os.homedir())))
    throw new Error('Sandbox workspace must not be a filesystem root or home directory');
  const working = await realpath(cwd);
  const relative = insideWorkspace(canonical, working);
  if (/[",\r\n]/.test(canonical)) throw new Error('Unsupported sandbox workspace path');
  if (config.mode === 'sbx') await requireSbx();
  await inspectWorkspace(canonical);
  if (config.mode === 'sbx') {
    const containerName = 'yuantu-' + randomUUID();
    const cleanupPath = await mkdtemp(path.join(os.tmpdir(), containerName + '-'));
    const primary = path.join(cleanupPath, 'empty');
    const snapshot = path.join(cleanupPath, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(primary);
    await cp(canonical, snapshot, {
      recursive: true,
      filter(source) {
        const item = path.relative(canonical, source);
        return (
          item !== '.git' &&
          !item.startsWith('.git' + path.sep) &&
          item !== '.yuantu' &&
          !item.startsWith('.yuantu' + path.sep)
        );
      },
    });
    const env = dockerEnvironment();
    try {
      await runLifecycle(
        'sbx',
        [
          'create',
          '--quiet',
          '--pull',
          'missing',
          '--cpus',
          '1',
          '--memory',
          '512m',
          '--skills',
          'off',
          '--deny-network',
          '**',
          '--deny-network',
          '0.0.0.0/0',
          '--deny-network',
          '::/0',
          '--name',
          containerName,
          'shell',
          primary,
          snapshot + ':ro',
        ],
        env,
        600_000,
      );
    } catch (error) {
      await rm(cleanupPath, { recursive: true, force: true });
      throw error;
    }
    return {
      executable: 'sbx',
      args: [
        'exec',
        '-w',
        path.join(snapshot, relative),
        containerName,
        ...(argv ? [command, ...argv] : ['/bin/sh', '-c', command]),
      ],
      cwd: canonical,
      env,
      windowsVerbatimArguments: false,
      containerName,
      backend: 'sbx',
      cleanupPath,
    };
  }
  const internalMounts = (await readdir(canonical))
    .filter((name) => ['.git', '.yuantu'].includes(name))
    .flatMap((name) => ['--tmpfs', `/workspace/${name}:ro,noexec,nosuid,nodev,size=1m`]);
  const containerName = 'yuantu-' + randomUUID();
  const args = [
    '--config',
    path.join(os.tmpdir(), containerName + '-docker-config'),
    '--host',
    win ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock',
    'run',
    '--rm',
    '--pull=never',
    '--name',
    containerName,
    '--interactive',
    '--init',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=512m',
    '--memory-swap=512m',
    '--cpus=1',
    '--user=65534:65534',
    '--no-healthcheck',
    '--log-driver=none',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount',
    `type=bind,source=${canonical},target=/workspace,readonly,bind-propagation=rprivate,bind-recursive=disabled`,
    ...internalMounts,
    '--workdir',
    '/workspace' + (relative ? '/' + relative.split(path.sep).join('/') : ''),
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--entrypoint',
    argv ? command : '/bin/sh',
    config.image,
    ...(argv ? [...argv] : ['-c', command]),
  ];
  return {
    executable: 'docker',
    args,
    cwd: canonical,
    env: dockerEnvironment(),
    windowsVerbatimArguments: false,
    containerName,
    backend: 'docker',
  };
}
/**
 * The container backends' teardown: remove the container with the same CLI prefix that created it, then the
 * scratch copy of the workspace. The `args.slice(0, 4)` knowledge lives *here*, next to the code that built
 * those four arguments, instead of in a caller that only had a plan.
 */
async function containerCleanup(plan: SandboxPlan): Promise<void> {
  if (!plan.containerName) return;
  await new Promise<void>((resolve, reject) => {
    const cleanupArgs =
      plan.backend === 'sbx'
        ? ['rm', '--force', plan.containerName!]
        : [...plan.args.slice(0, 4), 'rm', '--force', plan.containerName!];
    const child = spawn(plan.executable, cleanupArgs, {
      env: plan.env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-2048);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Sandbox container cleanup timed out'));
    }, 5000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || /No such container|not found/i.test(error)) resolve();
      else reject(new Error('Sandbox cleanup failed'));
    });
  });
  if (plan.cleanupPath) await rm(plan.cleanupPath, { recursive: true, force: true });
}
/**
 * Prepares one command for one category.
 *
 * `config` is passed by callers that must pin a backend (the hook bridge pins `host`); without it the
 * category's policy decides, which is the path every command tool takes.
 */
export async function prepareSandbox(
  root: string,
  cwd: string,
  command: string,
  argv?: readonly string[],
  config?: SandboxConfig,
  category: SandboxCategory = 'command',
  env?: NodeJS.ProcessEnv,
): Promise<SandboxPlan> {
  const resolved = config ?? resolveSandboxConfig(process.env, category);
  if (env && resolved.mode !== 'host' && resolved.mode !== 'windows')
    throw new Error('Custom process environment is unsupported by this backend');
  return sandboxProvider(resolved.mode).prepare({
    root,
    cwd,
    command,
    argv,
    config: resolved,
    env,
  });
}
/** Removes what a plan created, through the backend that made it — a backend cannot be torn down by a stranger. */
export async function cleanupSandbox(plan: SandboxPlan): Promise<void> {
  await sandboxProvider(plan.backend ?? 'host').cleanup(plan);
}
export async function stopSandbox(child: ChildProcess, plan: SandboxPlan): Promise<void> {
  // Remove container before terminating client; always report daemon cleanup failures.
  let failure: unknown;
  try {
    await cleanupSandbox(plan);
  } catch (error) {
    failure = error;
  }
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      await killTree(child.pid);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) failure = error;
    }
  }
  try {
    await cleanupSandbox(plan);
  } catch (error) {
    failure = error;
  }
  if (failure) {
    const error = new Error(String(failure));
    error.name = 'ToolCleanupError';
    throw error;
  }
}
// The three backends, registered at module load.
//
// Registration lives here rather than in an installer on purpose: every caller of the sandbox already imports
// this module, and a registry that stays empty until someone remembers to fill it is a seam that fails at the
// first `prepareSandbox`. A later `registerSandboxProvider` for the same mode replaces a built-in, which is how
// an embedder swaps in its own runner (or its own idea of what "docker" means) without patching this file.
registerSandboxProvider({
  mode: 'host',
  description:
    'No isolation: the command runs as this process, in the workspace, with the sanitised environment.',
  available: async () => null,
  prepare: hostPrepare,
  cleanup: async () => {},
});
registerSandboxProvider({
  mode: 'docker',
  description:
    'One container per command: no network, read-only workspace, dropped capabilities, non-root.',
  available: (env) => containerAvailable('docker', env),
  prepare: containerPrepare,
  cleanup: containerCleanup,
});
registerSandboxProvider({
  mode: 'sbx',
  description:
    'Docker Sandboxes: one container per command over a read-only copy of the workspace plus a scratch directory.',
  available: (env) => containerAvailable('sbx', env),
  prepare: containerPrepare,
  cleanup: containerCleanup,
});
// Windows ships its own backend rather than a fourth branch of `containerPrepare`: it confines by token and ACL
// instead of by container, so the two share no invariant beyond "the workspace is the boundary".
registerSandboxProvider(windowsSandboxProvider);
