import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  appcontainerSandboxProvider,
  markAppContainerStarted,
  stopAppContainer,
  cleanupAppContainer,
  prepareAppContainer,
  prepareAppContainerDiagnostic,
} from '../packages/tools/sandbox-appcontainer.ts';
import type { SandboxPlan } from '../packages/tools/sandbox-provider.ts';
import { runInNewContext } from 'node:vm';
import {
  appContainerRuntimeError,
  APPCONTAINER_CHILD_STDIO_PROBE,
} from '../packages/tools/appcontainer-runtime.ts';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32', timeout: 120000 };
async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'yuantu-appcontainer-test-'));
  const root = path.join(parent, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'read.txt'), 'workspace');
  await writeFile(path.join(parent, 'private.txt'), 'private');
  return { parent, root };
}
async function prepare(
  root: string,
  script: string,
  files: 'workspace-write' | 'read-only' = 'workspace-write',
) {
  return prepareAppContainerDiagnostic({
    root,
    cwd: root,
    command: process.execPath,
    argv: ['-e', script],
    config: { mode: 'appcontainer' as never, image: 'native', files, network: 'denied' },
  });
}
async function run(plan: SandboxPlan, onCancellation = () => {}) {
  markAppContainerStarted(plan);
  let stopping: Promise<void> | undefined;
  const timer = setTimeout(() => {
    onCancellation();
    stopping = stopAppContainer(plan);
    void stopping.catch(() => {});
  }, 8000);
  return execute(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  })
    .catch((error) => {
      // Fixture output contains only the bounded test's diagnostics, never its environment.
      console.error('AppContainer fixture launch failed:', error.stderr, error.stdout);
      throw error;
    })
    .finally(async () => {
      clearTimeout(timer);
      if (stopping) await stopping;
    });
}

test(
  'AppContainer Low scratch does not invalidate either trusted Windows control cache',
  windows,
  async () => {
    const { parent, root } = await fixture();
    let plan: SandboxPlan | undefined;
    try {
      plan = await prepare(
        root,
        "require('fs').writeFileSync(require('path').join(process.env.TEMP,'probe.txt'),'ok');console.log('ok')",
      );
      const state = path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state', 'windows');
      for (const name of ['acl.ps1', 'appcontainer-acl.ps1']) {
        const script = fileURLToPath(
          new URL(`../packages/tools/windows-sandbox/${name}`, import.meta.url),
        );
        const powershell = path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        );
        const validate = (directory: string) =>
          execute(
            powershell,
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              script,
              '-Operation',
              'validate-control',
              '-Root',
              directory,
              '-Journal',
              'unused',
            ],
            { windowsHide: true },
          );
        await validate(state);
        await assert.rejects(validate(plan.cleanupPath!), /Low integrity launcher cache/);
      }
      assert.equal((await run(plan)).stdout.trim(), 'ok');
    } finally {
      if (plan) await cleanupAppContainer(plan);
      await rm(parent, { recursive: true, force: true });
    }
    await assert.rejects(stat(plan!.cleanupPath!), { code: 'ENOENT' });
    await assert.rejects(stat(path.dirname(plan!.args[1]!)), { code: 'ENOENT' });
  },
);

test(
  'AppContainer reads workspace, writes scratch, refuses read-only and foreign file effects',
  windows,
  async () => {
    const { parent, root } = await fixture();
    let plan: SandboxPlan | undefined;
    try {
      const foreign = path.join(parent, 'private.txt');
      plan = await prepare(
        root,
        `
      const fs=require('fs'),path=require('path');
      const refused=[];
      for(const [name,fn] of [
        ['write',()=>fs.writeFileSync('read.txt','bad')],
        ['create',()=>fs.writeFileSync('new.txt','bad')],
        ['delete',()=>fs.unlinkSync('read.txt')],
        ['rename',()=>fs.renameSync('read.txt','renamed.txt')],
        ['foreign-read',()=>fs.readFileSync(${JSON.stringify(foreign)})],
        ['foreign-write',()=>fs.writeFileSync(${JSON.stringify(foreign)},'bad')],
        ['foreign-delete',()=>fs.unlinkSync(${JSON.stringify(foreign)})],
      ]){try{fn()}catch(error){if(['EACCES','EPERM'].includes(error.code))refused.push(name);else throw error}}
      fs.writeFileSync(path.join(process.env.TEMP,'scratch.txt'),'scratch');
      console.log(JSON.stringify({read:fs.readFileSync('read.txt','utf8'),refused,scratch:fs.readFileSync(path.join(process.env.TEMP,'scratch.txt'),'utf8')}));
    `,
        'read-only',
      );
      const result = JSON.parse((await run(plan)).stdout);
      assert.equal(result.read, 'workspace');
      assert.equal(result.scratch, 'scratch');
      assert.deepEqual(result.refused, [
        'write',
        'create',
        'delete',
        'rename',
        'foreign-read',
        'foreign-write',
        'foreign-delete',
      ]);
      assert.equal(await readFile(foreign, 'utf8'), 'private');
    } finally {
      if (plan) await cleanupAppContainer(plan);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  'AppContainer concurrent writer and reader retain independent policy and scratch identities',
  windows,
  async () => {
    const { parent, root } = await fixture();
    const plans: SandboxPlan[] = [];
    try {
      const writer = await prepare(
        root,
        "require('fs').writeFileSync('writer.txt','writer');console.log('written')",
      );
      plans.push(writer);
      const reader = await prepare(
        root,
        `const fs=require('fs');let denied=false;try{fs.writeFileSync('forbidden','bad')}catch(error){denied=['EACCES','EPERM'].includes(error.code)}let foreignDenied=false;try{fs.writeFileSync(${JSON.stringify(path.join(writer.cleanupPath!, 'foreign.txt'))},'bad')}catch(error){foreignDenied=['EACCES','EPERM'].includes(error.code)}console.log(JSON.stringify({denied,foreignDenied}));`,
        'read-only',
      );
      plans.push(reader);
      const [written, readonly] = await Promise.all([run(writer), run(reader)]);
      assert.equal(written.stdout.trim(), 'written');
      assert.deepEqual(JSON.parse(readonly.stdout), { denied: true, foreignDenied: true });
      await cleanupAppContainer(writer);
      const laterReader = await prepare(
        root,
        "const fs=require('fs');try{fs.writeFileSync('after-writer','bad');process.exit(2)}catch(error){if(!['EACCES','EPERM'].includes(error.code))throw error}console.log(fs.readFileSync('writer.txt','utf8'));",
        'read-only',
      );
      plans.push(laterReader);
      assert.equal((await run(laterReader)).stdout.trim(), 'writer');
    } finally {
      for (const plan of plans) await cleanupAppContainer(plan);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  'AppContainer blocks arbitrary Node IPv4/IPv6 TCP/UDP connect and bind including loopback',
  windows,
  async (t) => {
    const { parent, root } = await fixture();
    const servers = [net.createServer(), net.createServer()];
    const datagrams = [dgram.createSocket('udp4'), dgram.createSocket('udp6')];
    let plan: SandboxPlan | undefined;
    try {
      const unavailable = await appcontainerSandboxProvider.available();
      if (unavailable) {
        // Missing initialization is an enforced refusal, not network acceptance.
        await assert.rejects(
          prepareAppContainer({
            root,
            cwd: root,
            command: process.execPath,
            argv: ['-e', 'throw new Error("must not start")'],
            config: { mode: 'appcontainer' as never, image: 'native', network: 'denied' },
          }),
          /AppContainer enforcement probe (?:failed|timed out)|Invalid libuv runtime identity/,
        );
        assert.equal(await readFile(path.join(root, 'read.txt'), 'utf8'), 'workspace');
        t.skip(`Real WFP network acceptance unavailable: ${unavailable}`);
        return;
      }
      await Promise.all(
        servers.map(
          (server, index) =>
            new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(0, index ? '::1' : '127.0.0.1', resolve);
            }),
        ),
      );
      await Promise.all(
        datagrams.map(
          (socket, index) =>
            new Promise<void>((resolve, reject) => {
              socket.once('error', reject);
              socket.bind(0, index ? '::1' : '127.0.0.1', resolve);
            }),
        ),
      );
      const ports = servers.map((server) => (server.address() as net.AddressInfo).port);
      const udpPorts = datagrams.map((socket) => socket.address().port);
      const script = `
      const net=require('net'),dgram=require('dgram');
      const checks=[];
      for(const [host,port] of [['127.0.0.1',${ports[0]}],['::1',${ports[1]}],['1.1.1.1',443]]){
        checks.push(new Promise(resolve=>{const socket=net.connect({host,port});socket.on('connect',()=>{socket.destroy();resolve(false)});socket.on('error',error=>resolve(['EACCES','EPERM'].includes(error.code)));socket.setTimeout(1500,()=>{socket.destroy();resolve(false)})}));
      }
      for(const [kind,host,port] of [['udp4','127.0.0.1',${udpPorts[0]}],['udp6','::1',${udpPorts[1]}]]){
        checks.push(new Promise(resolve=>{const socket=dgram.createSocket(kind);socket.on('error',error=>{socket.close();resolve(['EACCES','EPERM'].includes(error.code))});socket.send(Buffer.from('deny'),port,host,error=>{if(!error){socket.close();resolve(false)}})}));
      }
      for(const host of ['127.0.0.1','::1']){checks.push(new Promise(resolve=>{const server=net.createServer();server.on('error',error=>resolve(['EACCES','EPERM'].includes(error.code)));server.listen(0,host,()=>{server.close();resolve(false)})}));}
      Promise.all(checks).then(results=>console.log(JSON.stringify(results)));
    `;
      plan = await prepareAppContainer({
        root,
        cwd: root,
        command: process.execPath,
        argv: ['-e', script],
        config: { mode: 'appcontainer' as never, image: 'native', network: 'denied' },
      });
      const result = JSON.parse((await run(plan)).stdout);
      assert.deepEqual(result, Array(7).fill(true));
    } finally {
      if (plan) await cleanupAppContainer(plan);
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      for (const socket of datagrams) socket.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  'AppContainer children inherit confinement and Job cleanup reaps detached descendants',
  windows,
  async () => {
    const { parent, root } = await fixture();
    let plan: SandboxPlan | undefined;
    try {
      const foreign = path.join(parent, 'private.txt');
      plan = await prepare(
        root,
        `const cp=require('child_process');const checked=cp.spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(foreign)},'bad')}catch(error){denied=['EACCES','EPERM'].includes(error.code)}console.log(denied);`)}],{stdio:'inherit'});checked.on('error',error=>{console.error(error);process.exit(2)});checked.on('close',code=>{if(code!==0)process.exit(2);const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});child.on('error',error=>{console.error(error);process.exit(3)});child.on('spawn',()=>{console.log(child.pid);child.unref()})});`,
      );
      const output = (await run(plan)).stdout.trim().split(/\r?\n/);
      assert.equal(output[0], 'true');
      const childPid = Number(output[1]);
      assert.equal(Number.isInteger(childPid) && childPid > 0, true);
      assert.throws(() => process.kill(childPid, 0));
      assert.equal(await readFile(foreign, 'utf8'), 'private');
    } finally {
      if (plan) await cleanupAppContainer(plan);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test('AppContainer refuses unrestricted networking without fallback', windows, async () => {
  await assert.rejects(
    prepareAppContainer({
      root: process.cwd(),
      cwd: process.cwd(),
      command: process.execPath,
      argv: ['-e', ''],
      config: { mode: 'appcontainer' as never, image: 'native', network: 'unrestricted' },
    }),
    /denied network only/,
  );
});

test(
  'AppContainer Node child pipe compatibility is measured inside the actual container',
  windows,
  async (t) => {
    const { parent, root } = await fixture();
    let plan: SandboxPlan | undefined;
    try {
      plan = await prepare(
        root,
        `const recordAppContainerProbeStage=stage=>require('fs').writeFileSync('child-probe-stage.json',JSON.stringify({version:1,stage,pid:process.pid}));
try { ${APPCONTAINER_CHILD_STDIO_PROBE}; console.log(JSON.stringify({passed:true})); }
catch(error) { console.log(JSON.stringify({passed:false,error:String(error)})); }`,
      );
      let evidence;
      let cancelled = false;
      try {
        evidence = JSON.parse(
          (
            await run(plan, () => {
              cancelled = true;
            })
          ).stdout.trim(),
        );
      } catch (error) {
        const phase = JSON.parse(await readFile(path.join(root, 'child-probe-stage.json'), 'utf8'));
        assert.equal(phase.stage, 'child-stdio-started');
        assert.equal(cancelled, true);
        assert.throws(() => process.kill(phase.pid, 0), { code: 'ESRCH' });
        const failure = error as {
          code?: number;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        assert.equal(failure.code, 1);
        assert.equal(failure.killed, false);
        assert.equal(failure.stdout, '');
        assert.equal(failure.stderr, '');
        t.skip(
          'Actual child stdio probe started but did not complete before contained cancellation; compatibility is not accepted',
        );
        return;
      }
      assert.equal(typeof evidence.passed, 'boolean');
      if (!evidence.passed) {
        assert.match(evidence.error, /child stdio capability probe failed/);
        t.skip(`Actual runtime capability unavailable: ${evidence.error}`);
      }
    } finally {
      if (plan) await cleanupAppContainer(plan);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test('AppContainer runtime versions are identity metadata, not capability evidence', () => {
  for (const uv of [undefined, 'unknown', '1.52', '1.52.1\n'])
    assert.match(appContainerRuntimeError(uv)!, /identity/);
  for (const uv of ['1.52.1', '1.9.9', '1.53.0', '1.54.1', '2.0.0'])
    assert.equal(appContainerRuntimeError(uv), null);
});

test('AppContainer child stdio probe rejects spawn failure, timeout, nonzero exit and broken channels', () => {
  const success = { status: 0, stdout: 'yuantu-stdin', stderr: 'yuantu-stderr' };
  const stages: string[] = [];
  const probe = (result: object) =>
    runInNewContext(APPCONTAINER_CHILD_STDIO_PROBE, {
      process: { execPath: 'C:\\runtime\\node.exe' },
      recordAppContainerProbeStage: (stage: string) => stages.push(stage),
      require: (name: string) => {
        assert.equal(name, 'node:child_process');
        return {
          spawnSync: (
            file: string,
            args: string[],
            options: { input: string; timeout: number },
          ) => {
            assert.equal(file, 'C:\\runtime\\node.exe');
            assert.equal(args[0], '-e');
            assert.equal(options.input, 'yuantu-stdin');
            assert.ok(options.timeout > 0);
            return result;
          },
        };
      },
    });
  assert.doesNotThrow(() => probe(success));
  assert.deepEqual(stages, ['child-stdio-started', 'child-spawn-returned', 'child-stdio-passed']);
  for (const result of [
    { ...success, error: { code: 'EPERM' } },
    { ...success, error: { code: 'ETIMEDOUT' }, status: null },
    { ...success, status: 1 },
    { ...success, stdout: '' },
    { ...success, stderr: '' },
  ])
    assert.throws(() => probe(result), /child stdio capability probe failed/);
});

test('AppContainer failure diagnostics distinguish an actual cancelled phase from an unknown stage', async () => {
  const runtime = await import('../packages/tools/appcontainer-runtime.ts');
  const format = (
    runtime as unknown as {
      appContainerProbeFailure: (stage: unknown, cancelled: boolean, error: unknown) => string;
    }
  ).appContainerProbeFailure;
  assert.equal(typeof format, 'function');
  assert.match(
    format('child-stdio-started', true, Error('helper exit 1')),
    /timed out during child-stdio-started/,
  );
  assert.match(
    format('network-started', false, Error('EPERM')),
    /failed during network-started.*EPERM/,
  );
  for (const stage of [null, { stage: 'fake' }, 'untrusted-path-and-secret']) {
    const result = format(stage, true, Error('helper exit 1'));
    assert.match(result, /unknown/);
    assert.doesNotMatch(result, /untrusted-path-and-secret/);
  }
});

test('AppContainer public execution refuses a failed capability probe before preparing a workload', async () => {
  const original = appcontainerSandboxProvider.available;
  appcontainerSandboxProvider.available = async () =>
    'AppContainer enforcement probe failed: child stdio capability probe failed: EPERM';
  try {
    await assert.rejects(
      prepareAppContainer({
        root: 'nonexistent-workspace-must-not-be-prepared',
        cwd: 'nonexistent-workspace-must-not-be-prepared',
        command: process.execPath,
        argv: ['-e', 'throw Error("must not execute")'],
        config: { mode: 'appcontainer' as never, image: 'native', network: 'denied' },
      }),
      /child stdio capability probe failed: EPERM/,
    );
  } finally {
    appcontainerSandboxProvider.available = original;
  }
});

test(
  'AppContainer cancellation acknowledges the entire contained tree before releasing grants',
  windows,
  async () => {
    const { parent, root } = await fixture();
    let plan: SandboxPlan | undefined;
    let completion: Promise<unknown> | undefined;
    try {
      plan = await prepare(
        root,
        `const cp=require('child_process'),fs=require('fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});child.once('spawn',()=>fs.writeFileSync('descendant.pid',String(child.pid)));child.once('error',error=>{throw error});setInterval(()=>{},1000);`,
      );
      markAppContainerStarted(plan);
      completion = execute(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        windowsHide: true,
      }).catch((error) => error);
      const deadline = Date.now() + 5000;
      let pid: number | undefined;
      while (!pid) {
        pid = await readFile(path.join(root, 'descendant.pid'), 'utf8').then(
          Number,
          () => undefined,
        );
        if (Date.now() >= deadline) throw new Error('Descendant did not report startup');
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await stopAppContainer(plan);
      await completion;
      assert.throws(() => process.kill(pid!, 0));
      await cleanupAppContainer(plan);
      assert.throws(() => markAppContainerStarted(plan!), /already released/);
    } finally {
      if (plan) {
        await stopAppContainer(plan);
        if (completion) await completion;
        await cleanupAppContainer(plan);
      }
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  'AppContainer cleanup rejects missing termination proof and ignores forged plans',
  windows,
  async () => {
    const { parent, root } = await fixture();
    const plan = await prepare(root, 'console.log("recovery")');
    try {
      await cleanupAppContainer({ ...plan });
      assert.equal(await readFile(path.join(root, 'read.txt'), 'utf8'), 'workspace');
      markAppContainerStarted(plan);
      await assert.rejects(cleanupAppContainer(plan), /not acknowledged/);
      assert.throws(() => markAppContainerStarted(plan), /only be started once/);
      // No guest has run in this fixture. Let the already marked, still owned
      // original runner execute its fixed program to obtain a real Job ack.
      const result = await execute(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        windowsHide: true,
        timeout: 5000,
      });
      assert.equal(result.stdout.trim(), 'recovery');
      await cleanupAppContainer(plan);
    } finally {
      await cleanupAppContainer(plan);
      await rm(parent, { recursive: true, force: true });
    }
  },
);
