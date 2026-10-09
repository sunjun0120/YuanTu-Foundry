import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

/**
 * The three parse-and-drop defects this file pins, all of them the same shape: the ACP entry accepts the
 * shared CLI options, and an operator reads `--db` / `--permission-policy` / `--hooks` as options of *this*
 * program. They used to be parsed and then dropped, so a policy file that says "this run may not write"
 * produced a run that wrote, and a `--db` produced sessions somewhere else entirely. A refusal is an
 * acceptable answer for an adapter; a silent no-op is not, and neither is a promise the adapter does not keep.
 */
test(
  'ACP adapter forwards --db and --permission-policy instead of dropping them',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acp-options-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const policy = path.join(root, 'deny-write.json');
    await writeFile(
      policy,
      JSON.stringify({ version: 1, rules: [{ effect: 'deny', kind: 'write' }] }),
    );
    const database = path.join(root, 'custom.sqlite');
    let step = 0;
    const url = await httpFixture(t, (_, res) => {
      if (step++ === 0)
        sendFrames(
          res,
          frames('尝试写入', [
            { id: 'write', name: 'write_file', input: { path: 'effect.txt', content: 'denied' } },
          ]),
        );
      else sendFrames(res, frames('结束'));
    });
    const child = spawn(
      process.execPath,
      [
        process.env.ACP_ENTRY_PATH ?? path.join(projectRoot, 'apps/agent-acp/main.ts'),
        '--workspace',
        root,
        '--db',
        database,
        '--permission-policy',
        policy,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          YUANTU_MODEL: 'fixture',
          YUANTU_API_KEY: 'acp-options-secret',
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
    let permissions = 0;
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate() {},
        requestPermission() {
          permissions++;
          return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: root, mcpServers: [] });
    /**
     * `--db` proof: the session is recorded where the operator said, and the workspace keeps no database of
     * its own. Asserting only that the file appeared would pass while the adapter wrote both.
     */
    assert.ok((await readFile(database)).length > 0);
    await assert.rejects(readFile(path.join(root, '.yuantu', 'sessions.sqlite')));
    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '写一个文件' }],
    });
    assert.equal(result.stopReason, 'end_turn');
    /**
     * `--permission-policy` proof: the kernel's own `deny` decides *before* the approval layer, so no
     * permission request reaches the client and the file does not exist. Counting the requests is what
     * separates "the policy refused it" from "nobody approved it", which is the distinction the dropped
     * option destroyed.
     */
    assert.equal(permissions, 0);
    await assert.rejects(readFile(path.join(root, 'effect.txt'), 'utf8'));
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
    assert.doesNotMatch(stderr, /acp-options-secret/);
  },
);
test(
  'ACP adapter refuses attachments instead of ignoring --image',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acp-image-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const image = path.join(root, 'shot.png');
    await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const child = spawn(
      process.execPath,
      [
        process.env.ACP_ENTRY_PATH ?? path.join(projectRoot, 'apps/agent-acp/main.ts'),
        '--workspace',
        root,
        '--image',
        image,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, /does not accept attachments/);
  },
);
