import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

test(
  'official ACP client creates, streams, approves, loads and cancels a real Host session',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acp-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let step = 0;
    let waiting!: () => void;
    const providerWaiting = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const url = await httpFixture(t, (_, res) => {
      if (step++ === 0)
        sendFrames(
          res,
          frames('开始', [
            { id: 'write', name: 'write_file', input: { path: 'test.txt', content: 'ACP' } },
          ]),
        );
      else if (step === 2) sendFrames(res, frames('完成'));
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': waiting\n\n');
        waiting();
      }
    });
    const child = spawn(
      process.execPath,
      [
        process.env.ACP_ENTRY_PATH ?? path.join(projectRoot, 'apps/agent-acp/main.ts'),
        '--workspace',
        root,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          YUANTU_MODEL: 'fixture',
          YUANTU_API_KEY: 'acp-secret',
          YUANTU_BASE_URL: url,
          YUANTU_MAX_CONTEXT_TOKENS: '128000',
          YUANTU_SESSION_TITLES: '0',
        },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const updates: SessionNotification[] = [];
    let permissions = 0;
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate(event) {
          updates.push(event);
        },
        requestPermission(request) {
          permissions++;
          assert.ok(request.options.some((option) => option.kind === 'reject_once'));
          return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    await assert.rejects(client.newSession({ cwd: root, mcpServers: [] }), /initialize/);
    const info = await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.agentCapabilities?.loadSession, true);
    await assert.rejects(
      client.newSession({
        cwd: root,
        mcpServers: [{ name: 'unsupported', command: 'node', args: [], env: [] }],
      }),
      /MCP/,
    );
    await assert.rejects(
      client.newSession({ cwd: path.dirname(root), mcpServers: [] }),
      /workspace/,
    );
    const session = await client.newSession({ cwd: root, mcpServers: [] });
    await assert.rejects(
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'image', data: '', mimeType: 'image/png' }],
      }),
    );
    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'write test.txt' }],
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(permissions, 1);
    assert.equal(await readFile(path.join(root, 'test.txt'), 'utf8'), 'ACP');
    assert.ok(updates.some((event) => event.update.sessionUpdate === 'agent_message_chunk'));
    assert.ok(
      updates.some(
        (event) =>
          event.update.sessionUpdate === 'tool_call_update' && event.update.status === 'completed',
      ),
    );
    updates.length = 0;
    await client.loadSession({ cwd: root, sessionId: session.sessionId, mcpServers: [] });
    assert.ok(updates.some((event) => event.update.sessionUpdate === 'user_message_chunk'));
    assert.ok(
      updates.some(
        (event) =>
          event.update.sessionUpdate === 'agent_message_chunk' &&
          event.update.content.type === 'text' &&
          event.update.content.text === '完成',
      ),
    );
    const pending = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'wait' }],
    });
    await providerWaiting;
    await client.cancel({ sessionId: session.sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
    assert.doesNotMatch(stderr, /acp-secret/);
  },
);
