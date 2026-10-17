/** Native Windows AppContainer: isolated identities and private file capabilities, no network grants. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { toolEnvironment } from './environment.ts';
import { testResource } from '../platform/test-lifecycle.ts';
import { RetryableCleanup } from './cleanup-sequence.ts';
import { createOwnedFileLease } from './owned-file-lease.ts';
import {
  appContainerRuntimeError,
  APPCONTAINER_CHILD_STDIO_PROBE,
  appContainerProbeFailure,
  finalizeAppContainerProbe,
} from './appcontainer-runtime.ts';
import {
  insideWorkspace,
  type SandboxPlan,
  type SandboxProvider,
  type SandboxRequest,
} from './sandbox-provider.ts';

const assetRoot =
  typeof __dirname === 'string'
    ? path.resolve(__dirname, '../packages/tools/windows-sandbox')
    : fileURLToPath(new URL('./windows-sandbox/', import.meta.url));
// Capture assets before running guest code. The workspace cannot turn cleanup into new host code.
const aclSource = gzipSync(readFileSync(path.join(assetRoot, 'appcontainer-acl.ps1'))).toString(
  'base64',
);
const binarySource = (() => {
  try {
    return readFileSync(path.join(assetRoot, 'yuantu-appcontainer.exe'));
  } catch {
    return undefined;
  }
})();
const execute = promisify(execFile);
const bootstrap = String.raw`
$ErrorActionPreference='Stop'
$spec=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SANDBOX_APPCONTAINER_SPEC)))
$memory=[IO.MemoryStream]::new([byte[]][Convert]::FromBase64String($env:SANDBOX_APPCONTAINER_ACL),$false)
$gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress)
$reader=[IO.StreamReader]::new($gzip)
$script=[ScriptBlock]::Create($reader.ReadToEnd())
$reader.Dispose()
& $script -Operation $spec.operation -Root $spec.root -Journal $spec.journal -Sid $spec.sid -ReadSid $spec.readSid -Files $spec.files
`;
const powershell = () =>
  path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
async function acl(
  operation: string,
  root: string,
  journal = '-',
  sid = '',
  readSid = '',
  files = 'workspace-write',
): Promise<void> {
  testResource('windows-sandbox');
  await execute(
    powershell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(bootstrap, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...toolEnvironment(),
        SANDBOX_APPCONTAINER_ACL: aclSource,
        SANDBOX_APPCONTAINER_SPEC: Buffer.from(
          JSON.stringify({ operation, root, journal, sid, readSid, files }),
        ).toString('base64'),
      },
    },
  );
}
const stateRoot = () => path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state', 'windows');
let capturedHelper: Promise<string> | undefined;
async function helper(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('AppContainer is available only on Windows');
  testResource('windows-sandbox');
  if (!binarySource)
    throw new Error('Bundled AppContainer helper is missing; build Windows sandbox assets');
  return (capturedHelper ??= (async () => {
    const state = stateRoot();
    await mkdir(state, { recursive: true });
    if (path.resolve(await realpath(state)).toLowerCase() !== path.resolve(state).toLowerCase())
      throw new Error('AppContainer refuses redirected state paths');
    await acl('validate-control', state);
    const digest = createHash('sha256').update(binarySource).digest('hex');
    const filename = path.join(state, `appcontainer-${digest}.exe`);
    await writeFile(filename, binarySource, { flag: 'wx' }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        if (!(await readFile(filename)).equals(binarySource))
          throw new Error('AppContainer helper identity changed');
      },
    );
    await acl('validate-control', state);
    return filename;
  })());
}
async function identity(
  executable: string,
  operation: 'create' | 'capability',
  name: string,
): Promise<string> {
  const { stdout } = await execute(executable, [operation, name], {
    windowsHide: true,
    env: toolEnvironment(),
    maxBuffer: 65536,
  });
  const value = JSON.parse(stdout);
  if (
    value.version !== 1 ||
    typeof value.sid !== 'string' ||
    !value.sid.startsWith(operation === 'create' ? 'S-1-15-2-' : 'S-1-15-3-1024-')
  )
    throw new Error('Invalid AppContainer native identity response');
  return value.sid;
}
type Lease = {
  references: number;
  root: string;
  readName: string;
  writeName: string;
  journal: string;
  close: () => Promise<void>;
  closing?: Promise<void>;
};
const leases = new Map<string, Promise<Lease>>();
let processLease:
  Promise<{ references: number; close: () => Promise<void>; closing?: Promise<void> }> | undefined;
async function acquireProcess(): Promise<() => Promise<void>> {
  processLease ??= (async () => {
    const filename = path.join(stateRoot(), 'workspace-owner.lock');
    const lock = await createOwnedFileLease(filename, {
      pid: process.pid,
      backend: 'appcontainer',
    }).catch((error: NodeJS.ErrnoException) => {
      throw new Error(
        `Windows ACL lease acquisition failed (${error.code ?? 'unknown'}): ${filename}`,
        { cause: error },
      );
    });
    return {
      references: 0,
      close: lock.release,
    };
  })();
  const pending = processLease;
  let lease;
  try {
    lease = await pending;
  } catch (error) {
    if (processLease === pending) processLease = undefined;
    throw error;
  }
  if (lease.closing) {
    await lease.closing;
    return acquireProcess();
  }
  lease.references++;
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      lease.references--;
    }
    if (lease.references === 0) {
      // Cleared on failure as well as on success: a rejected release cached here would be re-awaited by
      // every later acquire, so nothing could ever retry even after the stale lease file was removed.
      lease.closing = lease.close().finally(() => {
        if (processLease === pending) processLease = undefined;
      });
      await lease.closing;
    }
  };
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}
async function acquireWorkspace(root: string, executable: string): Promise<Lease> {
  for (const existing of leases.keys())
    if (existing !== root && (contains(existing, root) || contains(root, existing)))
      throw new Error('AppContainer refuses overlapping workspace ACL leases');
  let pending = leases.get(root);
  if (!pending) {
    pending = (async () => {
      const release = await acquireProcess();
      const name = randomUUID();
      const journal = path.join(stateRoot(), `appcontainer-workspace-${name}.json`);
      const readName = `Yuantu.Workspace.Read.${name}`;
      const writeName = `Yuantu.Workspace.Write.${name}`;
      try {
        const readSid = await identity(executable, 'capability', readName);
        const writeSid = await identity(executable, 'capability', writeName);
        await acl('grant', root, journal, writeSid, readSid);
        const cleanup = new RetryableCleanup();
        return {
          references: 0,
          root,
          readName,
          writeName,
          journal,
          close: () =>
            cleanup.run([
              { id: 'acl', run: () => acl('restore', root, journal) },
              { id: 'process-lease', run: release },
            ]),
        };
      } catch (error) {
        if (!(await stat(journal).catch(() => undefined))) await release();
        throw error;
      }
    })();
    leases.set(root, pending);
  }
  let lease: Lease;
  try {
    lease = await pending;
  } catch (error) {
    if (leases.get(root) === pending) leases.delete(root);
    throw error;
  }
  if (lease.closing) {
    await lease.closing;
    return acquireWorkspace(root, executable);
  }
  lease.references++;
  return lease;
}
async function releaseWorkspace(lease: Lease): Promise<void> {
  if (lease.references > 0) lease.references--;
  if (lease.references !== 0) return;
  lease.closing = lease.close().then(() => {
    leases.delete(lease.root);
  });
  await lease.closing;
}
type Owned = {
  profile: string;
  helper: string;
  scratch: string;
  scratchJournal: string;
  control: string;
  workspace: Lease;
  pooled: boolean;
  started: boolean;
  cleanup: RetryableCleanup;
};
const owned = new WeakMap<SandboxPlan, Owned>();
const releasing = new WeakSet<SandboxPlan>();
const activeProfiles = new Set<string>();

async function poolProfile(executable: string): Promise<{ profile: string; sid: string }> {
  const { stdout } = await execute(executable, ['network-status'], {
    windowsHide: true,
    env: toolEnvironment(),
    maxBuffer: 65536,
  });
  const value = JSON.parse(stdout) as {
    version: number;
    profiles: { name: string; sid: string }[];
  };
  if (
    value.version !== 1 ||
    !Array.isArray(value.profiles) ||
    value.profiles.length === 0 ||
    value.profiles.length > 16
  )
    throw new Error('Invalid verified network identity inventory');
  for (const candidate of value.profiles) {
    if (
      !/^Yuantu\.Sandbox\.[\da-f-]{36}$/i.test(candidate.name) ||
      !/^S-1-15-2-/.test(candidate.sid)
    )
      throw new Error('Invalid verified network identity');
    if (activeProfiles.has(candidate.name)) continue;
    activeProfiles.add(candidate.name);
    return { profile: candidate.name, sid: candidate.sid };
  }
  throw new Error('All independently isolated AppContainer identities are busy');
}

export async function prepareAppContainer(request: SandboxRequest): Promise<SandboxPlan> {
  if (request.config.network === 'unrestricted')
    throw new Error(
      'AppContainer supports denied network only; unrestricted networking is not implemented',
    );
  const unavailable = await appcontainerSandboxProvider.available();
  if (unavailable) throw new Error(unavailable);
  return prepareContainer(request, true);
}

/** Diagnostic fixtures only: this runner does not promise denied networking and is never registered. */
export async function prepareAppContainerDiagnostic(request: SandboxRequest): Promise<SandboxPlan> {
  return prepareContainer(request, false);
}

async function prepareContainer(
  request: SandboxRequest,
  enforceNetwork: boolean,
): Promise<SandboxPlan> {
  if (request.config.network === 'unrestricted')
    throw new Error(
      'AppContainer supports denied network only; unrestricted networking is not implemented',
    );
  if (enforceNetwork) {
    const runtimeError = appContainerRuntimeError(process.versions.uv);
    if (runtimeError) throw new Error(runtimeError);
  }
  const executable = await helper();
  const root = await realpath(request.root);
  const cwd = await realpath(request.cwd);
  insideWorkspace(root, cwd);
  if (contains(root, stateRoot()))
    throw new Error('AppContainer workspace cannot contain trusted sandbox state');
  // Pin/canonicalize every ancestor before touching a workspace. Root drive/home is never a workload.
  if (root === path.parse(root).root || root.toLowerCase() === os.userInfo().homedir.toLowerCase())
    throw new Error('AppContainer refuses filesystem/home roots');
  // A public denied-network plan must use an administrator-installed identity.
  // Missing or modified active WFP policy fails before workspace ACL changes.
  const isolation = enforceNetwork ? await poolProfile(executable) : undefined;
  const profile = isolation?.profile ?? `Yuantu.Sandbox.${randomUUID()}`;
  const sid = isolation?.sid ?? (await identity(executable, 'create', profile));
  let control: string | undefined;
  let scratch: string | undefined;
  let scratchJournal: string | undefined;
  let workspace: Lease | undefined;
  try {
    control = await mkdtemp(path.join(stateRoot(), 'appcontainer-plan-'));
    // Guest-writable Low objects must never enter the recursively validated Medium control tree.
    // Use its trusted parent, not TEMP (which can be supplied by an untrusted workload).
    scratch = await mkdtemp(path.join(path.dirname(stateRoot()), 'appcontainer-scratch-'));
    await acl('validate-control', scratch);
    // Windows redirects AppContainer TEMP beneath LOCALAPPDATA even when TEMP is explicitly supplied.
    await mkdir(path.join(scratch, 'Packages', profile.toLowerCase(), 'AC', 'Temp'), {
      recursive: true,
    });
    scratchJournal = path.join(control, 'scratch.json');
    workspace = await acquireWorkspace(root, executable);
    await acl('grant', scratch, scratchJournal, sid);
    // A standalone Node needs no host DLL tree or home grants. It remains guest-only, never host code.
    const node = path.join(scratch, 'node.exe');
    await copyFile(process.execPath, node);
    const env = {
      ...toolEnvironment(),
      ...(request.env ?? {}),
      TEMP: scratch,
      TMP: scratch,
      TMPDIR: scratch,
      HOME: scratch,
      USERPROFILE: scratch,
      APPDATA: scratch,
      LOCALAPPDATA: scratch,
    };
    const program = request.argv
      ? path.resolve(request.command).toLowerCase() === path.resolve(process.execPath).toLowerCase()
        ? node
        : request.command
      : path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe');
    if (!path.isAbsolute(program))
      throw new Error(
        'AppContainer program paths must be absolute; resolve the executable before preparing',
      );
    const args = request.argv ? [...request.argv] : ['/d', '/s', '/c', request.command];
    const filename = path.join(control, 'request.json');
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        profile,
        network: enforceNetwork,
        executable: program,
        args,
        cwd,
        env,
        capabilities: [
          request.config.files === 'read-only' ? workspace.readName : workspace.writeName,
        ],
      }),
      { flag: 'wx' },
    );
    const plan: SandboxPlan = {
      backend: 'appcontainer' as SandboxPlan['backend'],
      processTree: 'contained',
      executable,
      args: ['run', filename],
      cwd,
      env: toolEnvironment(),
      windowsVerbatimArguments: false,
      cleanupPath: scratch,
    };
    owned.set(plan, {
      profile,
      helper: executable,
      scratch,
      scratchJournal,
      control,
      workspace,
      pooled: enforceNetwork,
      started: false,
      cleanup: new RetryableCleanup(),
    });
    return plan;
  } catch (error) {
    if (scratchJournal && (await stat(scratchJournal).catch(() => undefined)))
      await acl('restore', scratch!, scratchJournal);
    if (workspace) await releaseWorkspace(workspace);
    if (!enforceNetwork)
      await execute(executable, ['delete', profile], { windowsHide: true, env: toolEnvironment() });
    activeProfiles.delete(profile);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (control) await rm(control, { recursive: true, force: true });
    throw error;
  }
}
export async function cleanupAppContainer(plan: SandboxPlan): Promise<void> {
  const resource = owned.get(plan);
  if (!resource) return;
  await resource.cleanup.run([
    {
      id: 'termination',
      run: async () => {
        if (resource.started && !(await terminated(resource)))
          throw new Error(
            'AppContainer termination was not acknowledged; grants and identity remain leased for recovery',
          );
        releasing.add(plan);
      },
    },
    { id: 'scratch-acl', run: () => acl('restore', resource.scratch, resource.scratchJournal) },
    { id: 'workspace', run: () => releaseWorkspace(resource.workspace) },
    {
      id: 'profile',
      run: async () => {
        if (!resource.pooled)
          await execute(resource.helper, ['delete', resource.profile], {
            windowsHide: true,
            env: toolEnvironment(),
          });
      },
    },
    { id: 'scratch', run: () => rm(resource.scratch, { recursive: true, force: true }) },
    { id: 'control', run: () => rm(resource.control, { recursive: true, force: true }) },
    {
      id: 'ownership',
      run: async () => {
        activeProfiles.delete(resource.profile);
        owned.delete(plan);
      },
    },
  ]);
}

async function terminated(resource: Owned): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path.join(resource.control, 'complete.json'), 'utf8'));
    return value.version === 1 && value.terminated === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function markAppContainerStarted(plan: SandboxPlan): void {
  if (releasing.has(plan)) throw new Error('AppContainer plan was already released');
  const resource = owned.get(plan);
  if (!resource) return;
  if (resource.started) throw new Error('AppContainer plan can only be started once');
  resource.started = true;
}

export async function stopAppContainer(plan: SandboxPlan): Promise<void> {
  const resource = owned.get(plan);
  if (!resource?.started || (await terminated(resource))) return;
  await writeFile(path.join(resource.control, 'cancel'), '', { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  const deadline = Date.now() + 10000;
  while (!(await terminated(resource))) {
    if (Date.now() >= deadline)
      throw new Error('AppContainer cancellation was not acknowledged; retained owned resources');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export const appcontainerSandboxProvider: SandboxProvider = {
  mode: 'appcontainer' as SandboxProvider['mode'],
  description:
    'Windows AppContainer with private workspace capabilities, independent scratch identities, denied network and contained descendants. Public AppContainer-readable system resources remain readable.',
  capabilities: (config) => ({
    processFiles: config.files ?? 'workspace-write',
    network: 'denied',
    pathKind: 'local',
    links: 'refused',
  }),
  available: async () => {
    if (process.platform !== 'win32') return 'AppContainer is available only on Windows';
    const runtimeError = appContainerRuntimeError(process.versions.uv);
    if (runtimeError) return runtimeError;
    let directory: string | undefined;
    let plan: SandboxPlan | undefined;
    let cancelled = false;
    let result: string | null = null;
    try {
      await helper();
      directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-appcontainer-probe-'));
      plan = await prepareContainer(
        {
          root: directory,
          cwd: directory,
          command: process.execPath,
          argv: [
            '-e',
            `
const fs=require('fs'),net=require('net'),dgram=require('dgram');
const recordAppContainerProbeStage=stage=>fs.writeFileSync('probe-stage.json',JSON.stringify({version:1,stage}));
recordAppContainerProbeStage('workspace-started');
fs.writeFileSync('allowed','ok');
if(fs.readFileSync('allowed','utf8')!=='ok')throw Error('workspace file probe failed');
${APPCONTAINER_CHILD_STDIO_PROBE}
recordAppContainerProbeStage('network-started');
const checks=[];
for(const host of ['127.0.0.1','::1','1.1.1.1']) checks.push(new Promise(resolve=>{const socket=net.connect({host,port:9});let done=false;const finish=(value)=>{if(done)return;done=true;socket.destroy();resolve(value)};socket.on('connect',()=>finish(false));socket.on('error',error=>finish(['EACCES','EPERM'].includes(error.code)));socket.setTimeout(1500,()=>finish(false))}));
for(const host of ['127.0.0.1','::1']) checks.push(new Promise(resolve=>{const server=net.createServer();server.on('error',error=>resolve(['EACCES','EPERM'].includes(error.code)));server.listen(0,host,()=>server.close(()=>resolve(false)))}));
for(const [kind,host] of [['udp4','127.0.0.1'],['udp6','::1']]) {
  checks.push(new Promise(resolve=>{const socket=dgram.createSocket(kind);let done=false;const finish=(value)=>{if(done)return;done=true;try{socket.close()}catch{}resolve(value)};socket.on('error',error=>finish(['EACCES','EPERM'].includes(error.code)));socket.send(Buffer.from('probe'),9,host,error=>finish(Boolean(error&&['EACCES','EPERM'].includes(error.code))))}));
  checks.push(new Promise(resolve=>{const socket=dgram.createSocket(kind);socket.on('error',error=>{try{socket.close()}catch{}resolve(['EACCES','EPERM'].includes(error.code))});socket.bind(0,host,()=>socket.close(()=>resolve(false)))}));
}
Promise.all(checks).then(result=>{if(result.length!==9||result.some(value=>!value))throw Error('TCP/UDP loopback network denial probe failed');recordAppContainerProbeStage('complete');console.log('ok')});
`,
          ],
          config: {
            mode: 'appcontainer' as SandboxProvider['mode'],
            image: 'native',
            network: 'denied',
          },
        },
        true,
      );
      markAppContainerStarted(plan);
      const pendingPlan = plan;
      let stopping: Promise<void> | undefined;
      const cancelTimer = setTimeout(() => {
        cancelled = true;
        stopping = stopAppContainer(pendingPlan);
        void stopping.catch(() => {});
      }, 5000);
      let stdout: string;
      try {
        ({ stdout } = await execute(plan.executable, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          windowsHide: true,
          maxBuffer: 65536,
          timeout: 15000,
        }));
      } finally {
        clearTimeout(cancelTimer);
        if (stopping) await stopping;
      }
      if (stdout.trim() !== 'ok')
        throw new Error('AppContainer functional enforcement probe failed');
    } catch (error) {
      let stage: unknown;
      if (directory) {
        const record = await readFile(path.join(directory, 'probe-stage.json'), 'utf8').catch(
          () => undefined,
        );
        if (record && record.length <= 256) {
          try {
            const value = JSON.parse(record);
            if (value.version === 1) stage = value.stage;
          } catch {
            /* Missing/corrupt stages are not evidence. */
          }
        }
      }
      result = appContainerProbeFailure(stage, cancelled, error);
    }
    return finalizeAppContainerProbe(
      result,
      async () => {
        if (plan) await cleanupAppContainer(plan);
      },
      async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    );
  },
  prepare: prepareAppContainer,
  started: markAppContainerStarted,
  stop: stopAppContainer,
  cleanup: cleanupAppContainer,
};
