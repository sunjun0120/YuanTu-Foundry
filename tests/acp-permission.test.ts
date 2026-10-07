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
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

for (const decision of ['reject-once', 'unknown-option', 'cancelled']) {
  test(`ACP permission ${decision} never writes a file`, { timeout: 20000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acp-deny-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let step = 0;
    const url = await httpFixture(t, (_, res) =>
      sendFrames(
        res,
        step++ === 0
          ? frames('Writing', [
              { id: 'write', name: 'write_file', input: { path: 'denied.txt', content: 'unsafe' } },
            ])
          : frames('Denied'),
      ),
    );
    const child = spawn(
      process.execPath,
      [path.join(projectRoot, 'apps/agent-acp/main.ts'), '--workspace', root],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          YUANTU_MODEL: 'fixture',
          YUANTU_API_KEY: 'fixture',
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
    const timer = setTimeout(() => child.kill(), 15000);
    t.after(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    });
    let requested!: () => void;
    const permissionRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let answer!: (value: RequestPermissionResponse) => void;
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate() {},
        requestPermission() {
          if (decision === 'cancelled') {
            requested();
            return new Promise<RequestPermissionResponse>((resolve) => {
              answer = resolve;
            });
          }
          return { outcome: { outcome: 'selected', optionId: decision } };
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    await client.initialize({ protocolVersion: 1 });
    const session = await client.newSession({ cwd: root, mcpServers: [] });
    const pending = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'write denied.txt' }],
    });
    if (decision === 'cancelled') {
      await permissionRequested;
      await client.cancel({ sessionId: session.sessionId });
      answer({ outcome: { outcome: 'cancelled' } });
    }
    assert.equal((await pending).stopReason, decision === 'cancelled' ? 'cancelled' : 'end_turn');
    await assert.rejects(readFile(path.join(root, 'denied.txt')));
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
  });
}
