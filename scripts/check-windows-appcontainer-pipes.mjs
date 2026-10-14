import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareAppContainerDiagnostic,
  markAppContainerStarted,
  stopAppContainer,
  cleanupAppContainer,
} from '../packages/tools/sandbox-appcontainer.ts';
import { APPCONTAINER_CHILD_STDIO_PROBE } from '../packages/tools/appcontainer-runtime.ts';
import { assertWindowsRuntime, inspectWindowsRuntime } from './windows-runtime.mjs';

const execute = promisify(execFile);

export function assessPipeScenario(name, result) {
  if (result.exitCode !== 0 || result.cancelled || !Array.isArray(result.stages)) return false;
  const has = (stage, matches = () => true) =>
    result.stages.some((s) => s.stage === stage && matches(s));
  const text = (stage) =>
    result.stages
      .filter((s) => s.stage === stage)
      .map((s) => s.text ?? '')
      .join('');
  switch (name) {
    case 'inherit-sync':
      return has('returned', (s) => s.status === 0 && !s.error) && result.stdout === 'inherited';
    case 'pipe-async':
      return (
        has('spawn-event') &&
        text('stdout') === 'pipe-output' &&
        text('stderr') === 'pipe-error' &&
        has('close', (s) => s.code === 0)
      );
    case 'pipe-sync-output':
      return has('returned', (s) => s.status === 0 && !s.error && s.stdout === 'pipe-output');
    case 'pipe-sync-input':
      return has('returned', (s) => s.passed === true);
    case 'named-pipe-local':
      return has('connect-ready') && text('stdout') === 'local-output' && has('close');
    case 'named-pipe-global':
      return has('listen-error', (s) => ['EACCES', 'EADDRINUSE'].includes(s.code));
    default:
      return false;
  }
}

function scenarios() {
  const pipeRoot = '\\\\.\\pipe\\';
  return [
    [
      'inherit-sync',
      `mark('before-spawn');const c=cp.spawnSync(process.execPath,['-e','process.stdout.write("inherited")'],{stdio:'inherit',timeout:2000});mark('returned',{status:c.status,error:c.error?.code,pid:c.pid});`,
    ],
    [
      'pipe-async',
      `mark('before-spawn');const c=cp.spawn(process.execPath,['-e','process.stdout.write("pipe-output");process.stderr.write("pipe-error")']);mark('spawn-returned');c.on('spawn',()=>{mark('spawn-event',{pid:c.pid});c.stdin.end()});c.on('error',e=>mark('spawn-error',{code:e.code}));c.stdout.on('data',b=>mark('stdout',{text:String(b)}));c.stderr.on('data',b=>mark('stderr',{text:String(b)}));c.on('close',code=>mark('close',{code}));`,
    ],
    [
      'pipe-sync-output',
      `mark('before-spawn');const c=cp.spawnSync(process.execPath,['-e','process.stdout.write("pipe-output")'],{encoding:'utf8',timeout:2000});mark('returned',{status:c.status,error:c.error?.code,stdout:c.stdout,stderr:c.stderr,pid:c.pid});`,
    ],
    [
      'pipe-sync-input',
      `mark('before-spawn');try{${APPCONTAINER_CHILD_STDIO_PROBE};mark('returned',{passed:true})}catch(e){mark('returned',{passed:false,error:String(e)})}`,
    ],
    ...[true, false].map((local) => [
      local ? 'named-pipe-local' : 'named-pipe-global',
      `const net=require('node:net');const name=${JSON.stringify(pipeRoot + (local ? 'LOCAL\\' : '') + 'yuantu-diagnostic-' + randomUUID())};mark('before-listen',{local:${local},name});const server=net.createServer(socket=>socket.end('local-output'));server.on('error',e=>mark('listen-error',{code:e.code}));server.listen(name,()=>{mark('listen-ready');const c=net.connect(name);c.on('connect',()=>mark('connect-ready'));c.on('data',b=>mark('stdout',{text:String(b)}));c.on('error',e=>{mark('connect-error',{code:e.code});server.close()});c.on('close',()=>{mark('close');server.close()})});`,
    ]),
  ];
}

export async function runPipeDiagnostics() {
  assertWindowsRuntime(await inspectWindowsRuntime(process.execPath), { enhanced: true });
  const state = path.join(os.userInfo().homedir, '.yuantu/sandbox-state/windows');
  const records = async () =>
    (
      await readdir(state).catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      })
    ).filter((n) => /\.(lock|json)$/.test(n));
  if ((await records()).length)
    throw Error('Existing sandbox lease/journal; refusing pipe diagnostics');
  const output = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../.scratch/windows-sandbox-pipes',
  );
  await mkdir(output, { recursive: true });
  const reportPath = path.join(output, `${Date.now()}-${process.pid}.json`);
  const report = {
    scope:
      'Diagnostic profiles and temporary ACL grants; no WFP initialization or network acceptance',
    runtime: {
      node: process.versions.node,
      uv: process.versions.uv,
      executable: process.execPath,
      sha256: createHash('sha256')
        .update(await readFile(process.execPath))
        .digest('hex'),
    },
    compatible: false,
    stateBefore: await records(),
    results: [],
  };
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
  for (const [name, source] of scenarios()) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-pipe-diagnostic-'));
    const script = `const fs=require('node:fs'),cp=require('node:child_process');const mark=(stage,data={})=>fs.appendFileSync('stages.jsonl',JSON.stringify({stage,time:Date.now(),...data})+'\\n');const recordAppContainerProbeStage=stage=>mark(stage);mark('guest-started',{pid:process.pid});${source};mark('script-end');`;
    let plan;
    let cancellation;
    let timer;
    let helperPid;
    const result = { name, accepted: false };
    const started = Date.now();
    try {
      plan = await prepareAppContainerDiagnostic({
        root,
        cwd: root,
        command: process.execPath,
        argv: ['-e', script],
        config: { mode: 'appcontainer', files: 'workspace-write', network: 'denied' },
      });
      markAppContainerStarted(plan);
      timer = setTimeout(() => {
        cancellation = stopAppContainer(plan);
        void cancellation.catch(() => {});
      }, 6000);
      try {
        // Emergency helper timeout is later than cooperative cancellation plus
        // its acknowledgement deadline. Missing proof still retains all grants.
        const pending = execute(plan.executable, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          windowsHide: true,
          maxBuffer: 65536,
          timeout: 20000,
        });
        helperPid = pending.child.pid;
        const reply = await pending;
        Object.assign(result, { exitCode: 0, stdout: reply.stdout, stderr: reply.stderr });
      } catch (error) {
        Object.assign(result, { exitCode: error.code, stdout: error.stdout, stderr: error.stderr });
      }
      clearTimeout(timer);
      if (cancellation) await cancellation;
      result.cancelled = Boolean(cancellation);
      result.stages = (await readFile(path.join(root, 'stages.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
    } catch (error) {
      result.error = String(error);
      throw error;
    } finally {
      clearTimeout(timer);
      try {
        if (cancellation) await cancellation;
        if (plan) await cleanupAppContainer(plan);
        const pids = [
          ...new Set(
            [helperPid, ...(result.stages ?? []).map((s) => s.pid)].filter(
              (pid) => Number.isSafeInteger(pid) && pid > 0,
            ),
          ),
        ];
        result.terminatedPids = [];
        for (const pid of pids) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') {
              result.terminatedPids.push(pid);
              continue;
            }
            throw error;
          }
          throw Error(`Diagnostic process ${pid} remains alive; retaining fixture`);
        }
        await rm(root, { recursive: true, force: true });
        result.stateRestored = true;
      } catch (error) {
        result.cleanupError = String(error);
        result.retainedRoot = root;
        throw error;
      } finally {
        result.durationMs = Date.now() - started;
        result.accepted = assessPipeScenario(name, result) && result.stateRestored === true;
        report.results.push(result);
        await save();
        console.log(JSON.stringify(result));
      }
    }
  }
  report.stateAfter = await records();
  report.compatible =
    report.results.length === 6 &&
    report.results.every((r) => r.accepted) &&
    report.stateAfter.length === 0;
  await save();
  console.log(`AppContainer pipe diagnostics report: ${reportPath}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2)
    throw Error(
      'Pipe diagnostics accept no command or path arguments; run with the candidate Node executable',
    );
  if (!(await runPipeDiagnostics()).compatible) process.exitCode = 2;
}
