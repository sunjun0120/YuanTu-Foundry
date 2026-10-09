import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connectCodeProcess } from '../packages/tools/code-process.ts';

const script = new URL('../scripts/build-program-runner.mjs', import.meta.url).href;

test(
  'standalone runner has a bounded deployment surface and performs real worker RPC',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-runner-build-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { buildProgramRunner } = await import(script);
    await buildProgramRunner(root);
    assert.deepEqual((await readdir(root)).sort(), [
      'Dockerfile',
      'code-process-entry.js',
      'code-worker.js',
      'manifest.json',
      'package.json',
    ]);
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.protocol, 1);
    assert.equal(manifest.minimumNodeMajor, 24);
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      'code-process-entry.js',
      'code-worker.js',
      'package.json',
    ]);
    for (const [file, digest] of Object.entries(manifest.files)) {
      const bytes = await readFile(path.join(root, file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
      if (file.endsWith('.js')) assert.doesNotMatch(bytes.toString(), /from ['"]\.\.?\//);
    }
    const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /ARG RUNNER_BASE\r?\nFROM \$\{RUNNER_BASE\}/);
    assert.match(dockerfile, /USER 65534:65534/);
    assert.doesNotMatch(dockerfile, /COPY \. |allow-fs-write|allow-net/);
    // Local bundle acceptance only: this test does not claim a container or its isolation was exercised.
    const child = spawn(
      process.execPath,
      [
        '--permission',
        '--allow-worker',
        '--disable-warning=SecurityWarning',
        `--allow-fs-read=${path.join(root, 'code-process-entry.js')}`,
        `--allow-fs-read=${path.join(root, 'code-worker.js')}`,
        path.join(root, 'code-process-entry.js'),
      ],
      { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    void closed.catch(() => {});
    t.after(async () => {
      child.kill();
      await closed;
    });
    const channel = await connectCodeProcess(
      {
        code: "const answer = await tools.read_file({path:'plain.txt'}); return answer + ':' + (6 * 7);",
        names: ['read_file'],
      },
      {
        child,
        closed,
        async stop() {
          child.kill();
          await closed;
        },
      },
      new AbortController().signal,
    );
    t.after(() => channel.terminate());
    const result = await new Promise<{ type: string; value: string }>((resolve, reject) => {
      channel.on('error', reject);
      channel.on('message', (message) => {
        if (message.type === 'call') {
          assert.equal(message.name, 'read_file');
          assert.deepEqual(message.args, { path: 'plain.txt' });
          channel.postMessage({
            type: 'call-result',
            id: message.id,
            ok: true,
            content: 'fixture',
          });
        } else resolve(message);
      });
    });
    assert.equal(result.type, 'result');
    assert.equal(result.value, 'fixture:42');
    await channel.terminate();
  },
);

test('runner build refuses an output directory containing unrelated files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-runner-dirty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'secret.txt'), 'private fixture');
  const { buildProgramRunner } = await import(script);
  await assert.rejects(buildProgramRunner(root), /Unexpected runner output/);
  assert.deepEqual(await readdir(root), ['secret.txt']);
});
