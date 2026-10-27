// @test-serial windows-sandbox: Runs actual Windows Host commands through the sandbox account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';
import { quoteWindowsArgument } from '../packages/tools/windows-command.ts';
import { tempRoot } from './temp-fixture.ts';
import { useAccountTests, windowsAccountTests } from './windows-account-fixture.ts';

useAccountTests();
const windows = windowsAccountTests;
async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline)
      throw new Error('Windows Host acceptance timed out waiting for independent evidence');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test(
  'real Windows account Host commands confine writes and private reads with online network access',
  windows,
  async (t) => {
    let command = '';
    const receipts: unknown[] = [];
    const url = await httpFixture(t, (body, response, _headers, requestPath) => {
      if (requestPath.endsWith('/models')) {
        response.end('{"data":[]}');
        return;
      }
      const last = body.messages.at(-1);
      const hasResult =
        Array.isArray(last?.content) &&
        last.content.some((b: { type: string }) => b.type === 'tool_result');
      if (hasResult) receipts.push(last.content);
      sendFrames(
        response,
        hasResult
          ? frames('verified')
          : frames('', [
              { id: 'native-probe', name: 'run_command', input: { command, timeout_ms: 30000 } },
            ]),
      );
    });
    const outside = await tempRoot(t, 'yuantu-windows-host-outside-');
    await promisify(execFile)('icacls.exe', [
      outside,
      '/inheritance:r',
      '/grant:r',
      `${userInfo().username}:(OI)(CI)F`,
    ]);
    await writeFile(path.join(outside, 'sentinel'), 'host-readable-marker');
    const server = createServer((socket) => socket.end('positive-network-control'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'native', YUANTU_BASE_URL: url });
    await mkdir(path.join(host.root, '.codex'), { recursive: true });
    const script = path.join(host.root, 'probe.cjs');
    const report = path.join(host.root, 'probe-result.json');
    await writeFile(
      script,
      `
const fs=require('node:fs'),net=require('node:net');
const result={pid:process.pid,secret:process.env.YUANTU_API_KEY??null};
fs.writeFileSync('allowed.txt','inside');
for(const [name,file] of [['outsideWrite',${JSON.stringify(path.join(outside, 'forbidden'))}],['metadataWrite','.codex/forbidden']]){
 try{fs.writeFileSync(file,'escape');result[name]='allowed'}catch(error){result[name]=error.code}
}
try{result.outsideRead=fs.readFileSync(${JSON.stringify(path.join(outside, 'sentinel'))},'utf8')}catch(error){result.outsideRead=error.code}
const socket=net.connect({host:'127.0.0.1',port:${address.port}});
socket.setTimeout(3000,()=>{throw Error('network positive control timed out')});
socket.once('error',error=>{throw error});
socket.once('data',data=>{result.network=data.toString();socket.destroy();fs.writeFileSync('probe-result.json',JSON.stringify(result));console.log(JSON.stringify(result))});
`,
    );
    command = `${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(script)}`;
    const { client } = await connectClient(host);
    let sessionId: string | undefined;
    try {
      await client.start();
      const session = await client.request('session.create', {});
      sessionId = session.id;
      await client.request('permission.update', {
        sessionId,
        policy: permissionPolicyForMode('full-access'),
      });
      const confined = await client.request('sandbox.set', {
        sessionId,
        mode: 'native',
        files: 'read-only',
        network: 'denied',
      });
      assert.equal(confined.mode, 'native');
      const selected = await client.request('sandbox.set', {
        sessionId,
        mode: 'native',
        files: 'workspace-write',
        network: 'unrestricted',
      });
      assert.equal(selected.mode, 'native');
      const result = await client.run(sessionId, 'execute the account native probe', {
        completion: {
          version: 1,
          objective: 'Produce the native boundary probe evidence',
          constraints: [],
          steps: [],
          inputs: ['probe.cjs', 'probe-result.json'],
          acceptance: [
            {
              description: 'The real probe recorded its network positive control',
              met: false,
              check: {
                id: 'probe-evidence',
                kind: 'file-contains',
                path: 'probe-result.json',
                expected: 'positive-network-control',
              },
            },
          ],
        },
      });
      assert.equal(result.status, 'completed');
      assert.ok(!JSON.stringify(receipts).includes('"is_error":true'), JSON.stringify(receipts));
      const evidence = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(await readFile(path.join(host.root, 'allowed.txt'), 'utf8'), 'inside');
      assert.ok(['EACCES', 'EPERM'].includes(evidence.outsideWrite), JSON.stringify(evidence));
      assert.ok(['EACCES', 'EPERM'].includes(evidence.metadataWrite), JSON.stringify(evidence));
      assert.ok(['EACCES', 'EPERM'].includes(evidence.outsideRead), JSON.stringify(evidence));
      assert.equal(evidence.network, 'positive-network-control');
      assert.equal(evidence.secret, null);
      assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'host-readable-marker');
      await assert.rejects(readFile(path.join(outside, 'forbidden')), { code: 'ENOENT' });
    } finally {
      if (sessionId) await client.request('run.cancel', { sessionId }).catch(() => {});
      await client.stop();
    }
  },
);

test(
  'real Windows Host cancellation joins detached descendants before returning',
  windows,
  async (t) => {
    let command = '';
    let earlyReceipt: unknown;
    const url = await httpFixture(t, (body, response, _headers, requestPath) => {
      if (requestPath.endsWith('/models')) {
        response.end('{"data":[]}');
        return;
      }
      const last = body.messages.at(-1);
      if (
        Array.isArray(last?.content) &&
        last.content.some((b: { type: string }) => b.type === 'tool_result')
      ) {
        earlyReceipt = last.content;
        sendFrames(response, frames('command settled'));
        return;
      }
      sendFrames(
        response,
        frames('', [
          { id: 'native-wait', name: 'run_command', input: { command, timeout_ms: 60000 } },
        ]),
      );
    });
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'native', YUANTU_BASE_URL: url });
    const pidFile = path.join(host.root, 'descendant.pid');
    const script = path.join(host.root, 'wait.cjs');
    await writeFile(
      script,
      `const cp=require('node:child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`,
    );
    command = `${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(script)}`;
    const { client } = await connectClient(host);
    let sessionId: string | undefined;
    let running: ReturnType<typeof client.run> | undefined;
    try {
      await client.start();
      sessionId = (await client.request('session.create', {})).id;
      await client.request('permission.update', {
        sessionId,
        policy: permissionPolicyForMode('full-access'),
      });
      running = client.run(sessionId, 'start the native descendant');
      void running.catch(() => {});
      const pid = await waitFor(async () => {
        assert.equal(earlyReceipt, undefined, JSON.stringify(earlyReceipt));
        const text = await readFile(pidFile, 'utf8').catch(() => undefined);
        return text?.trim() ? Number(text) : undefined;
      });
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.doesNotThrow(() => process.kill(pid, 0));
      await client.request('run.cancel', { sessionId });
      assert.equal((await running).status, 'cancelled');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (sessionId) await client.request('run.cancel', { sessionId }).catch(() => {});
      await running?.catch(() => {});
      await client.stop();
    }
  },
);
