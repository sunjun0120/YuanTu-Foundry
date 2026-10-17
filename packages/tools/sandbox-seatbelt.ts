/** macOS kernel confinement. A failed setup/probe never produces a host execution plan. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolEnvironment } from './environment.ts';
import { SeatbeltScratchRegistry } from './seatbelt-scratch.ts';
import {
  insideWorkspace,
  type SandboxPlan,
  type SandboxProvider,
  type SandboxRequest,
} from './sandbox-provider.ts';
import type { FileEffect, NetworkEffect } from '../protocol/execution.ts';

const EXECUTABLE = '/usr/bin/sandbox-exec';
const PROTECTED = ['.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg'];
// macOS commonly uses case-insensitive volumes. Simple character classes also protect
// names created after inspection without depending on undocumented SBPL regex flags.
const PROTECTED_COMPONENT =
  '/[.](' +
  PROTECTED.map((name) =>
    [...name.slice(1)].map((letter) => `[${letter}${letter.toUpperCase()}]`).join(''),
  ).join('|') +
  ')(/|$)';
const PLATFORM_READS = [
  '/System/Library',
  '/System/iOSSupport/System/Library',
  '/usr/lib',
  '/usr/share',
  '/usr/bin',
  '/bin',
  '/sbin',
  '/usr/sbin',
  '/Library/Apple',
  // Apple's /usr/bin/git launcher delegates to the installed developer tools.
  // Restrict these reads to their tool/runtime trees, not all of /Library.
  '/Library/Developer/CommandLineTools/usr',
  '/Applications/Xcode.app/Contents/Developer/usr',
];
const PLATFORM_FILES = [
  '/dev/null',
  '/dev/urandom',
  '/dev/random',
  '/private/etc/localtime',
  '/private/var/db/xcode_select_link',
];
const ownedPlans = new SeatbeltScratchRegistry();
const verified = new Map<string, Promise<void>>();
const availability = new Map<string, Promise<string | null>>();

/** SBPL strings are source code: reject controls rather than depending on undocumented escape syntax. */
export function seatbeltQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error('Seatbelt paths cannot contain control characters');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

interface ProfileInput {
  root: string;
  scratch: string;
  runtimePaths: readonly string[];
  protectedPaths?: readonly string[];
  files: FileEffect;
  network: NetworkEffect;
}

/** Deliberately small grants; neither the user home nor the system temporary directory is readable/writable. */
export function seatbeltProfile(input: ProfileInput): string {
  const scratchRelative = path.posix.relative(input.root, input.scratch);
  if (
    input.root === '/' ||
    !input.root ||
    !scratchRelative ||
    (scratchRelative !== '..' && !scratchRelative.startsWith('../'))
  )
    throw new Error('Seatbelt workspace root must be a dedicated directory');
  const root = seatbeltQuote(input.root);
  const scratch = seatbeltQuote(input.scratch);
  const lines = [
    '(version 1)',
    '(deny default)',
    '(deny file-link)',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    `(allow file-read* file-map-executable (subpath ${root}) (subpath ${scratch}))`,
    `(allow file-read-metadata (path-ancestors ${root}) (path-ancestors ${scratch}))`,
    ...PLATFORM_READS.map(
      (p) => `(allow file-read* file-map-executable (subpath ${seatbeltQuote(p)}))`,
    ),
    ...PLATFORM_READS.map((p) => `(allow file-read-metadata (path-ancestors ${seatbeltQuote(p)}))`),
    ...[...PLATFORM_FILES, ...input.runtimePaths].map(
      (p) => `(allow file-read* file-map-executable (literal ${seatbeltQuote(p)}))`,
    ),
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-write* (require-all (subpath ${scratch}) (require-not (regex #"${PROTECTED_COMPONENT}"))))`,
    `(deny file-write-unlink (literal ${root}) (literal ${scratch}))`,
  ];
  if (input.files === 'workspace-write') {
    const exclusions = [
      ...new Set([
        ...PROTECTED.map((name) => path.posix.join(input.root, name)),
        ...(input.protectedPaths ?? []),
      ]),
    ].flatMap((p) => [
      `(require-not (literal ${seatbeltQuote(p)}))`,
      `(require-not (subpath ${seatbeltQuote(p)}))`,
    ]);
    lines.push(
      `(allow file-write* (require-all (subpath ${root}) (require-not (literal ${root})) (require-not (regex #"${PROTECTED_COMPONENT}")) ${exclusions.join(' ')}))`,
    );
  }
  if (input.network === 'unrestricted')
    lines.push(
      '(allow network*)',
      '(allow system-socket)',
      '(allow mach-lookup (global-name "com.apple.TrustEvaluationAgent"))',
      '(allow file-read* (subpath "/private/etc/ssl") (literal "/private/etc/resolv.conf") (literal "/private/etc/hosts"))',
    );
  return lines.join('\n');
}

export function seatbeltEnvironment(
  scratch: string,
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...toolEnvironment(source), ...overrides };
  // Loader injection acts before the intended program. Consumer variables remain trusted, loader hooks do not.
  for (const name of Object.keys(env))
    if (/^(DYLD_|LD_|NODE_OPTIONS$|NODE_PATH$)/.test(name)) delete env[name];
  Object.assign(env, {
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    XDG_CACHE_HOME: scratch,
    XDG_CONFIG_HOME: scratch,
    XDG_DATA_HOME: scratch,
    XDG_RUNTIME_DIR: scratch,
  });
  return env;
}

export async function resolveSeatbeltPaths(
  root: string,
  cwd: string,
): Promise<{ root: string; cwd: string }> {
  seatbeltQuote(root);
  seatbeltQuote(cwd);
  const canonical = await realpath(root);
  const working = await realpath(cwd);
  insideWorkspace(canonical, working);
  if (!(await stat(canonical)).isDirectory() || !(await stat(working)).isDirectory())
    throw new Error('Seatbelt root and cwd must be directories');
  if (canonical === path.parse(canonical).root)
    throw new Error('Seatbelt workspace root must be a dedicated directory');
  return { root: canonical, cwd: working };
}

async function policyInput(
  root: string,
  scratch: string,
  request: SandboxRequest,
): Promise<ProfileInput> {
  const runtimePaths = new Set<string>([await realpath(process.execPath)]);
  // Only trusted application paths, never arbitrary argv paths (which could otherwise grant secrets).
  const application =
    typeof __dirname === 'string'
      ? path.resolve(__dirname, '..')
      : fileURLToPath(new URL('../../', import.meta.url));
  const runtimeDirectories = [
    path.join(application, 'packages'),
    path.join(application, 'node_modules'),
    ...(path.basename(application.replace(/[\\/]$/, '')) === 'dist'
      ? [path.join(application, '..', 'node_modules')]
      : []),
  ];
  const subtrees: string[] = [];
  for (const directory of runtimeDirectories) {
    try {
      subtrees.push(await realpath(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Encode subtree grants separately after compilation, not by widening runtime binary literals.
  const protectedPaths = await inspectSeatbeltWorkspace(root);
  const input: ProfileInput = {
    root,
    scratch,
    runtimePaths: [...runtimePaths],
    protectedPaths,
    files: request.config.files ?? 'workspace-write',
    network: request.config.network ?? 'denied',
  };
  runtimeSubtrees.set(input, subtrees);
  return input;
}

/** A path policy cannot distinguish an existing shared inode from an ordinary allowed workspace file. */
export async function inspectSeatbeltWorkspace(root: string): Promise<string[]> {
  const pending = [root];
  const protectedPaths: string[] = [];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const children = await readdir(directory, { withFileTypes: true });
    entries += children.length;
    if (entries > 100000)
      throw new Error('Seatbelt workspace link inspection exceeds 100000 entries');
    for (let offset = 0; offset < children.length; offset += 32) {
      const inspected = await Promise.allSettled(
        children.slice(offset, offset + 32).map(async (child) => {
          const location = path.join(directory, child.name);
          const metadata = await lstat(location);
          if (metadata.isFile() && metadata.nlink > 1)
            throw new Error('Seatbelt refuses workspace files with existing hardlinks');
          if (PROTECTED.includes(child.name.toLowerCase()))
            protectedPaths.push(await realpath(location));
          if (metadata.isDirectory()) pending.push(location);
        }),
      );
      const failed = inspected.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  }
  return protectedPaths.sort();
}
const runtimeSubtrees = new WeakMap<ProfileInput, string[]>();
function compile(input: ProfileInput): string {
  return (
    seatbeltProfile(input) +
    (runtimeSubtrees.get(input) ?? [])
      .map((p) => `\n(allow file-read* file-map-executable (subpath ${seatbeltQuote(p)}))`)
      .join('')
  );
}

/** Probe cancellation targets its process group, not descendants that create another session/group. */
function run(
  profile: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXECUTABLE, ['-p', profile, command, ...args], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let expired = false;
    let killError: unknown;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            killError = error;
            child.kill('SIGKILL');
          }
        }
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      kill();
    }, 8000);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(0, 16384);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, 2048);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      kill();
      if (killError)
        reject(new Error(`Seatbelt probe process group termination failed: ${String(killError)}`));
      else if (expired) reject(new Error('Seatbelt functional probe timed out'));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function probe(input: ProfileInput, env: NodeJS.ProcessEnv): Promise<void> {
  const fixture = await mkdtemp(path.join(input.root, '.yuantu-seatbelt-probe-'));
  let external: string | undefined;
  const server = createServer((socket) => socket.end('reachable'));
  try {
    external = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-outside-'));
    const sentinel = path.join(external, 'sentinel');
    await writeFile(path.join(fixture, 'read'), 'workspace');
    await writeFile(sentinel, 'unchanged');
    await symlink(sentinel, path.join(fixture, 'outside-alias'));
    await mkdir(path.join(fixture, '.codex'));
    await writeFile(path.join(fixture, '.codex', 'seed'), 'protected');
    await symlink(path.join(fixture, '.codex'), path.join(fixture, 'metadata-alias'));
    const sentinelMode = (await stat(sentinel)).mode;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Seatbelt network probe could not listen');
    const spec = { fixture, external, sentinel, scratch: input.scratch, port: address.port };
    const script = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');const s=${JSON.stringify(spec)};const r={};function check(name,fn){try{fn();r[name]='allowed'}catch(e){r[name]=e.code}}r.read=fs.readFileSync(s.fixture+'/read','utf8');check('workspace',()=>fs.writeFileSync(s.fixture+'/write','allowed'));check('workspaceDelete',()=>fs.unlinkSync(s.fixture+'/read'));check('scratch',()=>fs.writeFileSync(s.scratch+'/probe','allowed'));check('outsideWrite',()=>fs.writeFileSync(s.external+'/write','escape'));check('outsideRead',()=>fs.readFileSync(s.sentinel));check('outsideDelete',()=>fs.unlinkSync(s.sentinel));check('outsideMode',()=>fs.chmodSync(s.sentinel,0o777));check('outsideAlias',()=>fs.readFileSync(s.fixture+'/outside-alias'));check('hardlink',()=>fs.linkSync(s.sentinel,s.fixture+'/hardlink'));check('protected',()=>fs.mkdirSync(s.fixture+'/.agents'));check('protectedMixed',()=>fs.mkdirSync(s.fixture+'/.AgEnTs'));check('scratchProtectedMixed',()=>fs.mkdirSync(s.scratch+'/.CoDeX'));check('metadataAlias',()=>fs.writeFileSync(s.fixture+'/metadata-alias/seed','escape'));const child=cp.spawnSync(process.execPath,['-e', 'try{require("node:fs").writeFileSync('+JSON.stringify(s.external+'/child')+',"escape");process.exit(1)}catch(e){process.exit(["EPERM","EACCES"].includes(e.code)?0:2)}'],{timeout:2000});r.child=child.status;const socket=net.connect({host:'127.0.0.1',port:s.port});const timer=setTimeout(()=>{r.network='timeout';socket.destroy();console.log(JSON.stringify(r))},1500);socket.once('connect',()=>{clearTimeout(timer);r.network='allowed';socket.destroy();console.log(JSON.stringify(r))});socket.once('error',e=>{clearTimeout(timer);r.network=e.code;console.log(JSON.stringify(r))});`;
    const result = await run(compile(input), process.execPath, ['-e', script], fixture, env);
    if (result.code !== 0)
      throw new Error(`Seatbelt probe could not execute: ${result.stderr.trim() || result.code}`);
    let report: Record<string, unknown>;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error('Seatbelt probe did not return a valid result');
    }
    const denied = (name: string) => report[name] === 'EPERM' || report[name] === 'EACCES';
    if (
      report.read !== 'workspace' ||
      report.scratch !== 'allowed' ||
      report.child !== 0 ||
      !denied('outsideWrite') ||
      !denied('outsideRead') ||
      !denied('outsideDelete') ||
      !denied('outsideMode') ||
      !denied('outsideAlias') ||
      !denied('hardlink') ||
      !denied('metadataAlias') ||
      !denied('protected') ||
      !denied('protectedMixed') ||
      !denied('scratchProtectedMixed') ||
      (input.files === 'workspace-write' ? report.workspace !== 'allowed' : !denied('workspace')) ||
      (input.files === 'workspace-write'
        ? report.workspaceDelete !== 'allowed'
        : !denied('workspaceDelete')) ||
      (input.network === 'denied' ? !denied('network') : report.network !== 'allowed')
    )
      throw new Error(`Seatbelt functional confinement check failed: ${JSON.stringify(report)}`);
    if ((await readFile(sentinel, 'utf8')) !== 'unchanged')
      throw new Error('Seatbelt probe modified the outside sentinel');
    if (
      (await stat(sentinel)).mode !== sentinelMode ||
      (await readFile(path.join(fixture, '.codex', 'seed'), 'utf8')) !== 'protected'
    )
      throw new Error('Seatbelt probe modified protected metadata');
    for (const name of ['write', 'child']) {
      const exists = await stat(path.join(external, name)).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists) throw new Error('Seatbelt probe escaped its writable roots');
    }
    if (input.files === 'read-only') {
      if ((await readFile(path.join(fixture, 'read'), 'utf8')) !== 'workspace')
        throw new Error('Seatbelt probe deleted a read-only workspace file');
      const exists = await stat(path.join(fixture, 'write')).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error('Seatbelt probe wrote into a read-only workspace');
    }
  } finally {
    await new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
    await rm(fixture, { recursive: true, force: true });
    if (external) await rm(external, { recursive: true, force: true });
  }
}

async function verify(input: ProfileInput, env: NodeJS.ProcessEnv): Promise<void> {
  const artifact = await stat(EXECUTABLE);
  const rootArtifact = await stat(input.root);
  const nodeArtifact = await stat(process.execPath);
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        input.root,
        input.files,
        input.network,
        input.runtimePaths,
        runtimeSubtrees.get(input),
        input.protectedPaths,
        artifact.dev,
        artifact.ino,
        artifact.size,
        artifact.mtimeMs,
        rootArtifact.dev,
        rootArtifact.ino,
        nodeArtifact.dev,
        nodeArtifact.ino,
        nodeArtifact.size,
        nodeArtifact.mtimeMs,
        seatbeltProfile({ ...input, scratch: '/__private_scratch__' }),
      ]),
    )
    .digest('hex');
  let work = verified.get(key);
  if (!work) {
    work = probe(input, env);
    verified.set(key, work);
    work.catch(() => verified.delete(key));
    if (verified.size > 64) verified.delete(verified.keys().next().value!);
  }
  await work;
}

async function prepare(request: SandboxRequest): Promise<SandboxPlan> {
  if (process.platform !== 'darwin') throw new Error('The Seatbelt sandbox only runs on macOS');
  if (request.command.includes('\0') || request.argv?.some((arg) => arg.includes('\0')))
    throw new Error('Sandbox commands cannot contain NUL');
  // sandbox-exec parses options until the program: a guest program must never become another -p profile.
  if (request.argv && (!request.command || request.command.startsWith('-')))
    throw new Error('Sandbox executable cannot be empty or begin with an option');
  const canonical = await resolveSeatbeltPaths(request.root, request.cwd);
  const createdScratch = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-'));
  let scratch = createdScratch;
  try {
    scratch = await realpath(createdScratch);
    const env = seatbeltEnvironment(scratch, process.env, request.env);
    const input = await policyInput(canonical.root, scratch, request);
    await verify(input, env);
    const plan: SandboxPlan = {
      executable: EXECUTABLE,
      args: [
        '-p',
        compile(input),
        ...(request.argv ? [request.command, ...request.argv] : ['/bin/sh', '-c', request.command]),
      ],
      cwd: canonical.cwd,
      env,
      windowsVerbatimArguments: false,
      backend: 'seatbelt',
      // Seatbelt restrictions are inherited, but Darwin has no supported NOTE_TRACK
      // descendant reaper. A process-group signal cannot confirm detached descendants stopped.
      processTree: 'process-group',
      cleanupPath: scratch,
    };
    ownedPlans.register(plan, scratch);
    return plan;
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

export const seatbeltSandboxProvider: SandboxProvider = {
  mode: 'seatbelt',
  description:
    'macOS Seatbelt: workspace and runtime reads, workspace or read-only writes, private scratch, and denied network by default.',
  capabilities: (config) => ({
    processFiles: config.files ?? 'workspace-write',
    network: config.network ?? 'denied',
    pathKind: 'local',
    links: 'refused',
  }),
  available: seatbeltAvailable,
  prepare,
  started: (plan) => ownedPlans.started(plan),
  // A stopped group is not proof that a detached descendant stopped. Keep used
  // scratch rather than racing a still-confined process that can access it.
  cleanup: (plan) => ownedPlans.cleanup(plan),
};

async function seatbeltAvailable(env?: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform !== 'darwin') return 'The Seatbelt sandbox only runs on macOS';
  try {
    const launcher = await stat(EXECUTABLE);
    const runtime = await stat(process.execPath);
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          launcher.dev,
          launcher.ino,
          launcher.size,
          launcher.mtimeMs,
          runtime.dev,
          runtime.ino,
          runtime.size,
          runtime.mtimeMs,
          seatbeltEnvironment('/__availability__', process.env, env),
        ]),
      )
      .digest('hex');
    let pending = availability.get(key);
    if (pending) return await pending;
    pending = (async () => {
      let directory: string | undefined;
      let plan: SandboxPlan | undefined;
      try {
        directory = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-available-')),
        );
        plan = await prepare({
          root: directory,
          cwd: directory,
          command: '/usr/bin/true',
          argv: [],
          config: { mode: 'seatbelt', image: '' },
          env,
        });
        return null;
      } catch (error) {
        return `The macOS Seatbelt sandbox is unavailable: ${String(error)}`;
      } finally {
        // The probe's own directory is removed even when the plan cleanup refuses: otherwise one
        // `yantu-seatbelt-available-*` directory leaks per failed probe, and the refusal is still reported.
        try {
          if (plan) await seatbeltSandboxProvider.cleanup(plan);
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    })();
    availability.set(key, pending);
    pending.then(
      (result) => {
        if (result) availability.delete(key);
      },
      () => availability.delete(key),
    );
    if (availability.size > 16) availability.delete(availability.keys().next().value!);
    return await pending;
  } catch (error) {
    return `The macOS Seatbelt sandbox is unavailable: ${String(error)}`;
  }
}
