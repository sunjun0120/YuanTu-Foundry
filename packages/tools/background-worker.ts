import { stopSandbox, cleanupSandbox, type SandboxPlan } from './sandbox.ts';
import { BufferedOutput } from './background-output.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
let plan: SandboxPlan;
let child: ChildProcessWithoutNullStreams | undefined;
let stopped = false,
  finished = false;
let killing: Promise<void> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const send = (data: unknown) => {
  if (process.connected) process.send!(data, () => {});
};
const output = new BufferedOutput((message, done) => {
  if (process.connected) process.send!({ type: 'output', ...message }, () => done());
  else done();
});
const flush = () => output.flush();
const interval = setInterval(flush, 50);
interval.unref();
const stop = () => {
  stopped = true;
  if (child?.pid && !finished && !killing)
    killing = stopSandbox(child, plan).catch(() => {
      send({ type: 'cleanup-error' });
      child?.kill();
    });
};
const finish = async (code: number | null, signal: string | null, failed = false) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearInterval(interval);
  await killing;
  if (child?.pid && !killing) {
    try {
      await cleanupSandbox(plan);
    } catch {
      send({ type: 'cleanup-error' });
      failed = true;
    }
  }
  await output.drain();
  send({ type: 'exit', code, signal, stopped, failed });
  if (process.connected) process.disconnect();
};
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (raw: unknown) => {
  const msg = raw as {
    type: string;
    plan: SandboxPlan;
    command: string;
    cwd: string;
    timeout: number;
    input: string;
    eof: boolean;
    id: string;
  };
  if (msg.type === 'stop') {
    stop();
    return;
  }
  if (msg.type === 'input') {
    if (!child || finished || child.stdin.destroyed) {
      send({ type: 'input-result', id: msg.id, error: true });
      return;
    }
    child.stdin.write(msg.input, (error) => {
      send({ type: 'input-result', id: msg.id, error: !!error });
    });
    if (msg.eof) child.stdin.end();
    return;
  }
  if (msg.type !== 'start' || child) return;
  plan = msg.plan;
  child = spawn(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const collect = (text: string) => output.write(text);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.stdin.on('error', () => {});
  child.on('spawn', () => {
    send({ type: 'ready', pid: child!.pid });
    if (stopped) stop();
  });
  child.on('error', () => {
    void finish(null, null, true);
  });
  child.on('close', (code, signal) => {
    void finish(code, signal);
  });
  deadline = setTimeout(stop, msg.timeout);
});
