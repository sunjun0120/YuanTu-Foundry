import { BackgroundCommands } from '../packages/tools/background.ts';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import type { ToolContext } from '../packages/protocol/index.ts';
async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-background-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'interactive.cjs'),
    'console.log("READY");process.stdin.setEncoding("utf8");process.stdin.once("data",data=>{console.log("INPUT:"+data.trim());process.exit(7)});',
  );
  await writeFile(
    path.join(root, 'wait.cjs'),
    'require("fs").writeFileSync("job-pid.txt",String(process.pid));console.log("WAITING");setInterval(()=>{},1000);',
  );
  const ctx: ToolContext = { signal: new AbortController().signal, approve: async () => true };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.execute({ id: crypto.randomUUID(), name, arguments: args }, ctx);
    assert.equal(result.isError, false, result.content);
    return JSON.parse(result.content);
  };
  return { root, tools, ctx, call };
}
test('background manager exposes scoped list, incremental polling and explicit stop', async (t) => {
  const { root, tools } = await setup(t);
  const manager = new BackgroundCommands(root);
  t.after(() => manager.close());
  const first = createTools(root, manager, 'session-a');
  const result = await first.execute(
    { id: 'start', name: 'start_command', arguments: { command: 'node wait.cjs' } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  const job = JSON.parse(result.content);
  assert.equal(manager.list('session-a').length, 1);
  assert.equal(manager.list('session-b').length, 0);
  await assert.rejects(manager.poll(job.id, 'session-b'), /Unknown background command/);
  const snapshot = await manager.stopById(job.id, 'session-a');
  assert.equal(snapshot.status, 'cancelled');
  assert.ok(Date.parse(snapshot.finishedAt ?? '') >= Date.parse(snapshot.createdAt));
  assert.equal(manager.clear('session-a'), 1);
  await first.close();
  await tools.close();
});
test('background commands stream logs, accept stdin and preserve actual exit code', async (t) => {
  const { call } = await setup(t);
  const job = await call('start_command', { command: 'node interactive.cjs' });
  let snapshot;
  for (let i = 0; i < 50; i++) {
    snapshot = await call('job_output', { id: job.id, wait_ms: 50 });
    if (snapshot.output.includes('READY')) break;
  }
  assert.match(snapshot.output, /READY/);
  const cursor = snapshot.nextCursor;
  await call('write_command', { id: job.id, input: 'ping\n' });
  let tail = '';
  for (let i = 0; i < 50; i++) {
    snapshot = await call('job_output', { id: job.id, cursor, wait_ms: 50 });
    tail = snapshot.output;
    if (snapshot.status === 'completed') break;
  }
  assert.match(tail, /INPUT:ping/);
  assert.doesNotMatch(tail, /READY/);
  assert.equal(snapshot.exitCode, 7);
  assert.ok(Date.parse(snapshot.finishedAt ?? '') >= Date.parse(snapshot.createdAt));
});
test('background start requires approval and denied start never executes', async (t) => {
  const { tools, ctx, root } = await setup(t);
  const result = await tools.execute(
    { id: 'deny', name: 'start_command', arguments: { command: 'node wait.cjs' } },
    {
      ...ctx,
      approve: async (approval) => {
        assert.equal(approval.kind, 'command');
        return false;
      },
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /denied/i);
  await assert.rejects(readFile(path.join(root, 'job-pid.txt')), { code: 'ENOENT' });
});
test('registry close stops a managed command and records cancellation', async (t) => {
  const { call, root, tools } = await setup(t);
  const job = await call('start_command', { command: 'node wait.cjs' });
  let pid = 0;
  for (let i = 0; i < 50; i++) {
    try {
      pid = Number(await readFile(path.join(root, 'job-pid.txt'), 'utf8'));
      if (pid) break;
    } catch {}
    await call('job_output', { id: job.id, wait_ms: 50 });
  }
  assert.ok(pid > 0);
  await tools.close();
  assert.throws(() => process.kill(pid, 0));
  const result = await call('job_output', { id: job.id });
  assert.equal(result.status, 'cancelled');
});

test('shared background manager preserves jobs across registries and isolates sessions', async (t) => {
  const { root, ctx } = await setup(t);
  const manager = new BackgroundCommands(root);
  t.after(() => manager.close());
  const first = createTools(root, manager, 'a');
  const result = await first.execute(
    { id: 'start', name: 'start_command', arguments: { command: 'node wait.cjs' } },
    ctx,
  );
  assert.equal(result.isError, false, result.content);
  const job = JSON.parse(result.content);
  await first.close();
  const next = createTools(root, manager, 'a'),
    other = createTools(root, manager, 'b');
  const poll = await next.execute(
    { id: 'poll', name: 'job_output', arguments: { id: job.id, wait_ms: 100 } },
    ctx,
  );
  assert.equal(JSON.parse(poll.content).status, 'running');
  const denied = await other.execute(
    { id: 'stop', name: 'job_kill', arguments: { id: job.id } },
    ctx,
  );
  assert.equal(denied.isError, true);
  await manager.close('b');
  const still = await next.execute(
    { id: 'poll2', name: 'job_output', arguments: { id: job.id } },
    ctx,
  );
  assert.equal(JSON.parse(still.content).status, 'running');
  await manager.close('a');
});
test('background output is bounded and reports truncation with usable cursors', async (t) => {
  const { root, call } = await setup(t);
  await writeFile(path.join(root, 'noisy.cjs'), 'process.stdout.write("x".repeat(200000));');
  const job = await call('start_command', { command: 'node noisy.cjs' });
  let result;
  for (let i = 0; i < 50; i++) {
    result = await call('job_output', { id: job.id, wait_ms: 50 });
    if (result.status === 'completed') break;
  }
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 3000);
  assert.ok(result.nextCursor > 130000);
});
test('supervisor kills command when its owning process dies unexpectedly', async (t) => {
  const { root } = await setup(t);
  const moduleUrl = new URL('../packages/tools/background.ts', import.meta.url).href;
  const script =
    'import {BackgroundCommands} from ' +
    JSON.stringify(moduleUrl) +
    ';' +
    'const m=new BackgroundCommands(' +
    JSON.stringify(root) +
    ');' +
    'await m.tools("a")[0].execute({command:"node wait.cjs"},{signal:new AbortController().signal,approve:async()=>true});setInterval(()=>{},1000);';
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
  t.after(() => {
    owner.kill();
  });
  let pid = 0;
  for (let i = 0; i < 100; i++) {
    try {
      pid = Number(await readFile(path.join(root, 'job-pid.txt'), 'utf8'));
      if (pid) break;
    } catch {}
    await delay(50);
  }
  assert.ok(pid > 0);
  owner.kill();
  let alive = true;
  const { execFileSync } = await import('node:child_process');
  for (let i = 0; i < 30; i++) {
    if (process.platform === 'win32') {
      // Windows can retain an exited process object while inherited handles remain open.
      const found = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "ProcessId = ' +
            pid +
            '" | Select-Object -ExpandProperty ProcessId',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      alive = found.trim() !== '';
    } else {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    if (!alive) break;
    await delay(100);
  }
  assert.equal(alive, false, 'command must exit after supervisor loses owner IPC');
});

test('background IPC applies backpressure and bounds queued log data', async () => {
  const { BufferedOutput } = await import('../packages/tools/background-output.ts');
  const messages: { text: string; dropped: number }[] = [];
  const callbacks: (() => void)[] = [];
  const buffer = new BufferedOutput((message, done) => {
    messages.push(message);
    callbacks.push(done);
  });
  buffer.write('first');
  buffer.flush();
  for (let i = 0; i < 100; i++) {
    buffer.write('x'.repeat(10000));
    buffer.flush();
  }
  assert.equal(messages.length, 1, 'only one IPC output packet may be in flight');
  callbacks.shift()!();
  buffer.flush();
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.text.length, 65536);
  assert.equal(messages[1]!.dropped, 1000000 - 65536);
  callbacks.shift()!();
  await buffer.drain();
});
