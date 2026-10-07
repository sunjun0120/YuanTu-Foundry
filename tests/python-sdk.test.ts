import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

test(
  'Python SDK runs real Host, streams Unicode, approves writes, reloads and cancels',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-python-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let round = 0;
    const url = await httpFixture(t, (_, res) => {
      round++;
      if (round === 1)
        sendFrames(
          res,
          frames('写入', [
            { id: 'write', name: 'write_file', input: { path: '中文.txt', content: '你好' } },
          ]),
        );
      else if (round === 2) sendFrames(res, frames('完成'));
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': waiting\n\n');
      }
    });
    const child = spawn(
      process.env.PYTHON_SDK_EXECUTABLE ?? 'python',
      [
        path.join(projectRoot, 'tests/python-sdk-fixture.py'),
        process.execPath,
        path.join(projectRoot, 'apps/agent-host/main.ts'),
        root,
      ],
      {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONPATH:
            process.env.PYTHON_SDK_INSTALLED === '1' ? '' : path.join(projectRoot, 'sdk/python'),
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1',
          YUANTU_MODEL: 'fixture',
          YUANTU_API_KEY: 'python-fixture',
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
    assert.equal(await readFile(path.join(root, '中文.txt'), 'utf8'), '你好');
    assert.match(out, /PYTHON_SDK_OK/);
    assert.doesNotMatch(out + err, /python-fixture/);
  },
);

test('Python SDK failure and cancellation contract regressions', { timeout: 15000 }, async () => {
  const child = spawn(
    process.env.PYTHON_SDK_EXECUTABLE ?? 'python',
    [path.join(projectRoot, 'tests/python-sdk-unit.py')],
    {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH:
          process.env.PYTHON_SDK_INSTALLED === '1' ? '' : path.join(projectRoot, 'sdk/python'),
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /Ran 6 tests/);
  assert.doesNotMatch(output, /exception was never retrieved/i);
});
