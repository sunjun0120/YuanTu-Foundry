import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

test(
  'public compiled SDK example streams a response and exits its Host',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-sdk-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const url = await httpFixture(t, (_, res) => sendFrames(res, frames('SDK 中文 response')));
    const child = spawn(
      process.execPath,
      ['examples/host-sdk.mjs', root, 'dist/apps/agent-host/main.js', 'hello'],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          YUANTU_MODEL: 'fixture',
          YUANTU_API_KEY: 'sdk-secret',
          YUANTU_BASE_URL: url,
          YUANTU_MAX_CONTEXT_TOKENS: '128000',
          YUANTU_SESSION_TITLES: '0',
        },
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let out = '',
      err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, err);
    assert.equal(out, 'SDK 中文 response');
    assert.match(err, /durable cursor \d+/);
    assert.doesNotMatch(out + err, /sdk-secret/);
  },
);
