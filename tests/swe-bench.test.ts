import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createTools } from '../packages/catalog/index.ts';
import { executionPolicy } from '../packages/sandbox/execution-policy.ts';
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tempRoot } from './temp-fixture.ts';
import type { SweManifest } from '../benchmarks/swe-bench/schema.ts';

const exec = promisify(execFile);
const harness = new URL('../benchmarks/swe-bench/', import.meta.url);
async function moduleFor(name: string): Promise<any> {
  return import(new URL(name, harness).href).catch(() => ({}));
}
const fakeRecords = () =>
  Array.from({ length: 30 }, (_, i) => ({
    instance_id: `owner__repo${i % 3}-${i}`,
    repo: `owner/repo${i % 3}`,
    difficulty: i % 2 ? '<15 min fix' : '15 min - 1 hour',
    base_commit: 'a'.repeat(40),
    problem_statement: `Fix issue ${i}`,
  }));

test('SWE subset is byte deterministic, stratified and binds complete records', async () => {
  const { selectSubset, serializeSubset, recordHash } = await moduleFor('select-subset.mjs');
  assert.equal(typeof selectSubset, 'function', 'deterministic selector is required');
  const options = { revision: 'a'.repeat(40), seed: 20261023, size: 12, smokeSize: 5 };
  const records = fakeRecords();
  const subset = selectSubset(records, options);
  assert.equal(
    serializeSubset(subset),
    serializeSubset(selectSubset([...records].reverse(), options)),
  );
  assert.equal(subset.instances.length, 12);
  assert.equal(new Set(subset.instances.map((r: any) => r.repo)).size, 3);
  const smoke = subset.instances.filter((r: any) => subset.smoke.includes(r.instance_id));
  assert.equal(smoke.length, 5);
  assert.equal(new Set(smoke.map((r: any) => r.repo)).size, 3);
  assert.ok(smoke.every((r: any) => ['<15 min fix', '15 min - 1 hour'].includes(r.difficulty)));
  for (const item of subset.instances) {
    const record = records.find((r) => r.instance_id === item.instance_id);
    assert.equal(item.sha256, recordHash(record));
    assert.notEqual(item.sha256, recordHash({ ...record, problem_statement: 'changed' }));
  }
  assert.throws(() => selectSubset([...records, records[0]], options), /duplicate/i);
  assert.throws(() => selectSubset(records, { ...options, size: 2 }), /size/i);
});

test('SWE materialization pins base commit and confines git configuration to the cache', async (t) => {
  const { materializeRepo } = await moduleFor('repos.mjs');
  assert.equal(typeof materializeRepo, 'function', 'repository materialization is required');
  const root = await tempRoot(t, 'yuantu-swe-repo-');
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (args: string[]) => exec('git', args, { cwd: source, windowsHide: true });
  await git(['init']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(source, 'module.py'), 'value = 1\n');
  await git(['add', '.']);
  await git(['-c', 'core.autocrlf=false', 'commit', '-m', 'first']);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(source, 'module.py'), 'value = 2\n');
  await git(['commit', '-am', 'second']);
  const directory = path.join(root, 'work');
  const record = { repo: 'fixture/source', base_commit: base, instance_id: 'fixture__source-1' };
  const cache = path.join(root, 'repos');
  await materializeRepo({ record, cacheDirectory: cache, directory, source });
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim(), base);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: directory })).stdout, '');
  assert.equal(await readFile(path.join(directory, 'module.py'), 'utf8'), 'value = 1\n');
  assert.equal((await lstat(path.join(directory, '.git'))).isDirectory(), true);
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['core.longpaths', 'true'],
  ]) {
    assert.equal(
      (
        await exec('git', [
          '--git-dir',
          path.join(cache, 'fixture__source.git'),
          'config',
          '--local',
          key!,
        ])
      ).stdout.trim(),
      value,
    );
  }
  await assert.rejects(materializeRepo({ record, cacheDirectory: cache, directory, source }));
  await assert.rejects(
    materializeRepo({
      record: { ...record, repo: '../escape' },
      cacheDirectory: cache,
      directory: path.join(root, 'other'),
      source,
    }),
  );
});

test('the output allowance is declared, not capped at 8192', async () => {
  const { validateSweManifest } = await moduleFor('schema.ts');
  const valid: SweManifest = JSON.parse(
    await readFile(new URL('manifest.example.json', harness), 'utf8'),
  );
  // 8192 was the ceiling this harness enforced, and the product never had it: the point of B4 is that a bigger
  // allowance is a condition a batch may declare, so each of these has to be a legal manifest.
  for (const maxOutputTokens of [8192, 16384, 32768])
    validateSweManifest({ ...valid, maxOutputTokens });
  for (const maxOutputTokens of [0, -1, valid.maxContextTokens])
    assert.throws(() => validateSweManifest({ ...valid, maxOutputTokens }));
});

test('SWE manifest and CLI reject credentials, unknown keys and unauthorized live execution', async () => {
  const { validateSweManifest, requireSweLiveAuthorization } = await moduleFor('schema.ts');
  assert.equal(typeof validateSweManifest, 'function');
  const valid: SweManifest = JSON.parse(
    await readFile(new URL('manifest.example.json', harness), 'utf8'),
  );
  validateSweManifest(valid);
  for (const patch of [
    { apiKey: 'must-not-persist' },
    { model: undefined },
    { runtime: { kind: 'commit', revision: 'main' } },
    { subset: { ...valid.subset, token: 'secret' } },
    { executionMode: 'commands' },
    { approvedLiveBudget: { authorized: true, maxAttempts: 0 } },
    { endpointUrl: 'https://example.invalid/v1?api_key=secret' },
    { instances: ['fixture__source-1', 'fixture__source-1'] },
    { maxKnownTokensPerSample: -1 },
  ])
    assert.throws(() => validateSweManifest({ ...valid, ...patch }));
  assert.throws(() => requireSweLiveAuthorization(valid, 5), /authoriz/i);
  assert.throws(
    () =>
      requireSweLiveAuthorization(
        { ...valid, approvedLiveBudget: { authorized: true, maxAttempts: 4 } },
        5,
      ),
    /budget/i,
  );
  const { parseArguments } = await moduleFor('run.mjs');
  assert.equal(typeof parseArguments, 'function');
  const required = ['--manifest=m.json', '--out=out', '--batch-id=fixture'];
  for (const flags of [
    ['--live', '--dry-run'],
    ['--live=yes'],
    ['--oops=x'],
    ['--out=other'],
    ['--instances=a,a'],
    ['--runtime=main'],
  ])
    assert.throws(() => parseArguments([...required, ...flags]));
  assert.throws(() => parseArguments(['--manifest=m.json']));
  assert.equal(parseArguments(required).live, false);
});

test('SWE patch collection includes new, modified, deleted and test files but excludes runtime files', async (t) => {
  const { collectPatch, approvalAllowed } = await moduleFor('adapter.mjs');
  assert.equal(typeof collectPatch, 'function');
  const root = await tempRoot(t, 'yuantu-swe-patch-');
  const git = (args: string[]) =>
    exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true });
  await git(['init']);
  await writeFile(path.join(root, 'change.py'), 'old = 1\n');
  await writeFile(path.join(root, 'remove.py'), 'remove = 1\n');
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'base',
  ]);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal((await collectPatch(root, base)).failureClass, 'empty-patch');
  await writeFile(path.join(root, 'change.py'), 'old = 2\n');
  await rm(path.join(root, 'remove.py'));
  await writeFile(path.join(root, 'new.py'), 'new = 1\n');
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests/test_new.py'), 'assert True\n');
  await mkdir(path.join(root, '.yuantu'));
  await writeFile(path.join(root, '.yuantu/private.txt'), 'never include runtime output');
  const patch = await collectPatch(root, base);
  assert.equal(patch.files, 4);
  assert.equal(patch.changedTests, true);
  assert.match(patch.patch, /new file mode/);
  assert.match(patch.patch, /deleted file mode/);
  assert.ok(!patch.patch.includes('.yuantu'));
  const approval = (name: string, args: any, kind = 'write') => ({
    kind,
    toolCall: { name, arguments: args },
  });
  assert.equal(await approvalAllowed(approval('edit_file', { path: 'change.py' }), root), true);
  assert.equal(await approvalAllowed(approval('edit_file', { path: './change.py' }), root), true);
  for (const name of [
    'run_command',
    'start_command',
    'terminal_open',
    'terminal_send',
    'run_validation',
    'web_fetch',
    'browser_open',
    'git_commit',
  ])
    assert.equal(
      await approvalAllowed(approval(name, { path: 'change.py' }, 'command'), root),
      false,
    );
  for (const name of ['.git/config', '.GiT/config', '../outside', 'C:\\outside', '.yuantu/secret'])
    assert.equal(await approvalAllowed(approval('write_file', { path: name }), root), false);
  assert.equal(
    await approvalAllowed(approval('move_file', { from: 'new.py', to: '../escape' }), root),
    false,
  );
});

test('SWE dry-run freezes a commit, writes all blocked predictions and refuses directory reuse', async (t) => {
  const { executeBatch } = await moduleFor('run.mjs');
  assert.equal(typeof executeBatch, 'function');
  const { selectSubset, serializeSubset } = await moduleFor('select-subset.mjs');
  const { hash } = await moduleFor('../coding-evaluation/materialize.mjs');
  const root = await tempRoot(t, 'yuantu-swe-dry-');
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'packages'), { recursive: true });
  await mkdir(path.join(source, 'node_modules'));
  await writeFile(path.join(source, 'packages/runtime.ts'), 'export {};\n');
  await writeFile(path.join(source, 'package.json'), '{"type":"module","dependencies":{}}');
  await writeFile(path.join(source, 'package-lock.json'), '{"packages":{}}');
  const git = (args: string[]) => exec('git', args, { cwd: source, windowsHide: true });
  await git(['init']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'runtime',
  ]);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const records = fakeRecords().map((r) => ({
    ...r,
    repo: 'fixture/source',
    base_commit: revision,
  }));
  // Selection itself needs three repositories for the smoke set; only the selected fixture instance is executed here.
  const selectionRecords = fakeRecords().map((r) => ({ ...r, base_commit: revision }));
  const subset = selectSubset(selectionRecords, { revision: 'a'.repeat(40), size: 12 });
  const chosen = subset.instances[0];
  const dataset = path.join(root, 'dataset.jsonl');
  await writeFile(dataset, selectionRecords.map((r) => JSON.stringify(r)).join('\n'));
  const subsetFile = path.join(root, 'subset.json');
  await writeFile(subsetFile, serializeSubset(subset));
  const valid = JSON.parse(await readFile(new URL('manifest.example.json', harness), 'utf8'));
  const manifest = {
    ...valid,
    batchId: 'fixture-dry',
    runtime: { kind: 'commit', revision },
    subset: { path: subsetFile, sha256: hash(await readFile(subsetFile)) },
    datasetPath: dataset,
    instances: [chosen.instance_id],
  };
  const out = path.join(root, 'out');
  const result = await executeBatch(manifest, {
    out,
    live: false,
    sourceDirectory: source,
    repoSource: source,
    cacheDirectory: path.join(root, 'repos'),
  });
  assert.equal(result.requests, 0);
  assert.equal(result.exitCode, 0);
  const rows = (await readFile(path.join(out, 'results.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'blocked');
  assert.equal(rows[0].failureClass, 'offline-not-executed');
  assert.equal(
    JSON.parse(await readFile(path.join(out, 'predictions.jsonl'), 'utf8')).model_patch,
    '',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(out, 'manifest.resolved.json'), 'utf8')).endpointUrl,
    null,
  );
  await assert.rejects(
    executeBatch(manifest, {
      out,
      live: false,
      sourceDirectory: source,
      repoSource: source,
      cacheDirectory: path.join(root, 'repos'),
    }),
    /exist/i,
  );
  await assert.rejects(
    executeBatch(manifest, { out: path.join(root, 'live'), live: true, sourceDirectory: source }),
    /authoriz/i,
  );
  assert.ok(records.length > 0);
});

test('SWE evidence JSON redacts strings without consuming structural quotes', async () => {
  const { stringifyEvidence } = await moduleFor('adapter.mjs');
  assert.equal(typeof stringifyEvidence, 'function');
  const value = {
    text: 'password=public-fixture',
    nested: [{ text: 'Bearer public-fixture' }, 'api_key=public-fixture'],
    explicit: 'fixture-provider-credential',
    count: 14,
    absent: null,
  };
  const encoded = stringifyEvidence(value, ['fixture-provider-credential'], 2);
  assert.deepEqual(JSON.parse(encoded), {
    text: 'password=[REDACTED]',
    nested: [{ text: 'Bearer [REDACTED]' }, 'api_key=[REDACTED]'],
    explicit: '[REDACTED]',
    count: 14,
    absent: null,
  });
  assert.equal(value.text, 'password=public-fixture', 'original evidence must stay immutable');
  assert.ok(!encoded.includes('fixture-provider-credential'));
});

test('SWE real Host fixture reads, edits, denies commands and emits an applicable official prediction', async (t) => {
  const { runSweSample, collectPatch } = await moduleFor('adapter.mjs');
  const { prediction, writePredictions } = await moduleFor('predictions.mjs');
  assert.equal(typeof runSweSample, 'function');
  const { captureSourceManifest, copyFiles, hash } = await moduleFor(
    '../coding-evaluation/materialize.mjs',
  );
  const { copyLockedDependencies } = await moduleFor('../coding-evaluation/dependencies.mjs');
  const root = await tempRoot(t, 'yuantu-swe-host-');
  const captured = await captureSourceManifest(process.cwd());
  const runtimeDirectory = path.join(root, 'runtime');
  const files = captured.files.filter(
    (f: any) =>
      f.path.startsWith('packages/') ||
      f.path.startsWith('apps/agent-host/') ||
      f.path.startsWith('apps/shared/') ||
      ['package.json', 'package-lock.json'].includes(f.path),
  );
  await copyFiles(process.cwd(), runtimeDirectory, files);
  const runtime = await captureSourceManifest(runtimeDirectory);
  await copyLockedDependencies({
    sourceDirectory: process.cwd(),
    targetDirectory: runtimeDirectory,
  });
  const frozen = { runtimeDirectory, runtimeHash: runtime.hash, runtimeFiles: runtime.files };
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (args: string[]) =>
    exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd: source, windowsHide: true });
  await git(['init']);
  await writeFile(
    path.join(source, 'module.py'),
    'password = "public fixture"\nsecret = "public fixture"\nvalue = 1\n# password=public-fixture',
  );
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'base',
  ]);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const record = {
    instance_id: 'fixture__source-1',
    repo: 'fixture/source',
    base_commit: base,
    problem_statement: 'Set value to 2.',
    hints_text: 'HIDDEN_HINT',
    test_patch: 'HIDDEN_TEST',
    patch: 'HIDDEN_GOLD',
    FAIL_TO_PASS: ['HIDDEN_FAILURE'],
  };
  const { materializeRepo } = await moduleFor('repos.mjs');
  const directory = path.join(root, 'work');
  await materializeRepo({ record, cacheDirectory: path.join(root, 'repos'), directory, source });
  let calls = 0;
  let hanging = false;
  let fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(payload.model, 'swe-bench-fixture');
      assert.equal(request.headers.authorization, 'Bearer swe-bench-fake-key');
      assert.ok(payload.tools?.length, 'auxiliary model titles must be disabled');
      assert.ok(!JSON.stringify(payload).includes('HIDDEN_'));
      if (hanging && payload.tools?.length) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        return;
      }
      const step = payload.tools?.length ? calls++ : -1;
      const tool =
        step === 0
          ? { name: 'read_file', arguments: { path: 'module.py' } }
          : step === 1
            ? {
                name: 'edit_file',
                arguments: { path: 'module.py', old_text: 'value = 1', new_text: 'value = 2' },
              }
            : step === 2
              ? { name: 'run_command', arguments: { command: 'echo forbidden > command-ran.txt' } }
              : null;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `fixture-${step}`,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          }
        : { content: 'Updated module.py; tests cannot run in this evaluation.' };
      for (const data of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: payload.model, ...data })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    } catch (error) {
      fixtureError = error;
      response.writeHead(500);
      response.end('fixture failure');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const valid = JSON.parse(await readFile(new URL('manifest.example.json', harness), 'utf8'));
  const manifest = {
    ...valid,
    model: 'swe-bench-fixture',
    endpointId: 'numeric-loopback-fixture',
    endpointUrl: `http://127.0.0.1:${address.port}/v1`,
    instanceTimeoutMs: 20000,
  };
  const evidenceDirectory = path.join(root, 'evidence');
  const result = await runSweSample(
    {
      manifest,
      frozen,
      record,
      directory,
      evidenceDirectory,
      offlineProbe: true,
      providerKey: 'swe-bench-fake-key',
    },
    new AbortController().signal,
  );
  assert.equal(fixtureError, undefined);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.failureClass, null, JSON.stringify(result));
  assert.ok(calls >= 4);
  assert.equal(
    await readFile(path.join(directory, 'module.py'), 'utf8'),
    'password = "public fixture"\nsecret = "public fixture"\nvalue = 2\n# password=public-fixture',
    JSON.stringify({
      interactions: result.interactions,
      tools: result.events.filter((item: any) => /tool/.test(item.event.type)),
    }),
  );
  await assert.rejects(access(path.join(directory, 'command-ran.txt')));
  const commandId = result.events.find(
    (item: any) =>
      item.event.type === 'tool.started' && item.event.data.call.name === 'run_command',
  )?.event.data.call.id;
  assert.ok(commandId);
  assert.ok(
    result.events.some(
      (item: any) =>
        item.event.type === 'tool.finished' &&
        item.event.data.callId === commandId &&
        item.event.data.isError &&
        // The harness's approval policy denies commands, and a policy refusal now says so instead of calling it
        // "denied by user" (see `decisionSource` in the registry).
        /denied|not available|blocked by the session's permission policy/i.test(
          item.event.data.content,
        ),
    ),
  );
  assert.ok(!JSON.stringify(result).includes('swe-bench-fake-key'));
  const patch = await collectPatch(directory, base);
  assert.equal(
    result.patch.patch,
    patch.patch,
    'saved model patch must preserve valid source bytes',
  );
  const file = path.join(root, 'predictions.jsonl');
  await writePredictions(file, [
    prediction(record.instance_id, 'a'.repeat(40), manifest.model, patch.patch),
  ]);
  const rows = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instance_id, record.instance_id);
  assert.equal(rows[0].model_name_or_path, `yuantu@aaaaaaa+${manifest.model}`);
  await writeFile(path.join(root, 'patch.diff'), rows[0].model_patch);
  await git(['apply', '--check', path.join(root, 'patch.diff')]);
  assert.equal((await captureSourceManifest(runtimeDirectory)).hash, frozen.runtimeHash);
  assert.equal(hash(await readFile(path.join(evidenceDirectory, 'patch.diff'))), hash(patch.patch));
  assert.equal(
    (await readFile(path.join(evidenceDirectory, 'session.sqlite'))).includes(
      Buffer.from('swe-bench-fake-key'),
    ),
    false,
  );
  hanging = true;
  const cancelled = await runSweSample(
    {
      // This deadline includes starting the standalone Host. Leave time for that under parallel load so the
      // timeout exercises cancellation of the held model response, rather than expiring before session.create.
      manifest: { ...manifest, instanceTimeoutMs: 30_000 },
      frozen,
      record,
      directory,
      evidenceDirectory: path.join(root, 'cancel-evidence'),
      offlineProbe: true,
      providerKey: 'swe-bench-fake-key',
    },
    new AbortController().signal,
  );
  assert.equal(fixtureError, undefined);
  assert.equal(cancelled.timedOut, true);
  assert.equal(cancelled.cleanupConfirmed, true);
  assert.equal(cancelled.cancellation?.acknowledged, true);
  assert.equal(cancelled.cancellation?.runSlotReleased, true);
});

test('SWE Git collection cannot execute a host clean filter or inherit credentials', async (t) => {
  const { collectPatch } = await moduleFor('adapter.mjs');
  const { gitEnvironment } = await moduleFor('repos.mjs');
  const root = await tempRoot(t, 'yuantu-swe-filter-');
  const directory = path.join(root, 'repo');
  await mkdir(directory);
  const git = (args: string[]) =>
    exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd: directory, windowsHide: true });
  await git(['init']);
  await writeFile(path.join(directory, 'module.py'), 'value = 1\n');
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'base',
  ]);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const marker = path.join(root, 'filter-ran.txt'),
    script = path.join(root, 'filter.cjs'),
    config = path.join(root, 'global.gitconfig');
  await writeFile(
    script,
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write(fs.readFileSync(0));\n`,
  );
  await git([
    'config',
    '--file',
    config,
    'filter.fixture.clean',
    `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`,
  ]);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  await writeFile(path.join(directory, '.gitattributes'), '*.py filter=fixture\n');
  await writeFile(path.join(directory, 'module.py'), 'value = 2\n');
  await collectPatch(directory, base);
  await assert.rejects(access(marker), 'host clean filter must never execute');
  const env = gitEnvironment({
    PATH: process.env.PATH,
    YUANTU_API_KEY: 'fake-credential',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'filter.fixture.clean',
    GIT_CONFIG_VALUE_0: 'must-not-execute',
  });
  assert.equal(env.YUANTU_API_KEY, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
});

test('SWE patches retain source assignments and block explicit model credentials', async () => {
  const { safeModelPatch } = await moduleFor('predictions.mjs');
  assert.equal(typeof safeModelPatch, 'function');
  const patch = '-password = "old"\n+password = "new"\n secret = "public source"\n';
  assert.equal(safeModelPatch(patch, ['fake-provider-key']), patch);
  assert.throws(
    () => safeModelPatch(patch + '+key = "fake-provider-key"\n', ['fake-provider-key']),
    /credential/i,
  );
});

test('SWE comparison identity includes shared implementation and actual runtime environment', async () => {
  const { comparisonConfig } = await moduleFor('run.mjs');
  const manifest = JSON.parse(await readFile(new URL('manifest.example.json', harness), 'utf8'));
  const config = await comparisonConfig(manifest, ['o__r-1'], { revision: 'a'.repeat(40) });
  assert.equal(config.runtimeEnvironment.node, process.version);
  assert.equal(config.runtimeEnvironment.platform, process.platform);
  assert.deepEqual(
    config.sharedModules.map((r: any) => r.name),
    [
      '../coding-evaluation/adapters.mjs',
      '../coding-evaluation/dependencies.mjs',
      '../coding-evaluation/metrics.mjs',
      '../coding-evaluation/materialize.mjs',
    ],
  );
});

test('SWE statistical reports use Wilson intervals and exact paired McNemar tests', async () => {
  const { wilson, exactMcNemar, summarize, compareBatches } = await moduleFor('report.mjs');
  assert.equal(typeof wilson, 'function');
  assert.ok(Math.abs(wilson(0, 50).upper - 0.0713475991) < 1e-8);
  assert.equal(wilson(0, 50).lower, 0);
  assert.ok(Math.abs(wilson(25, 50).lower - 0.3664451432) < 1e-8);
  assert.equal(wilson(0, 0), null);
  for (const [b, c, p] of [
    [0, 0, 1],
    [1, 0, 1],
    [5, 0, 0.0625],
    [8, 0, 0.0078125],
    [1, 9, 0.021484375],
  ])
    assert.equal(exactMcNemar(b, c), p);
  const comparison = {
    model: 'fixture',
    promptCache: 'auto',
    subsetHash: 'a',
    instances: ['o__r-1', 'o__r-2', 'o__r-3', 'o__r-4'],
  };
  const manifest = { comparison, configHash: 'same', instances: comparison.instances };
  const make = (resolved: number[]) =>
    comparison.instances.map((id, i) => ({
      instanceId: id,
      configHash: 'same',
      runtime: 'a',
      status: 'generated',
      failureClass: null,
      rounds: i + 1,
      tokens: { inputTokens: 20, outputTokens: 10, complete: true },
      durationMs: 100 + i,
      patch: { bytes: i ? 3 : 0, files: i ? 1 : 0, changedTests: i === 1 },
      evaluation: { status: resolved.includes(i) ? 'resolved' : i === 3 ? 'error' : 'unresolved' },
    }));
  const a = make([0, 1]),
    b = make([0, 2]);
  const paired = compareBatches({ manifest, rows: a }, { manifest, rows: b });
  assert.deepEqual(paired.table, { bothResolved: 1, onlyA: 1, onlyB: 1, neitherResolved: 1 });
  assert.equal(paired.pValue, 1);
  const summary = summarize(a, manifest);
  assert.equal(summary.total, 4);
  assert.equal(summary.resolved, 2);
  assert.equal(summary.error, 1);
  assert.equal(summary.graded, 3);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.emptyPatches, 1);
  assert.equal(summary.changedTests, 1);
  assert.equal(summary.rounds.median, 2.5);
  assert.throws(
    () =>
      compareBatches(
        { manifest, rows: a },
        { manifest: { ...manifest, configHash: 'different' }, rows: b },
      ),
    /config/i,
  );
  assert.throws(() => summarize([a[0], a[0]], manifest), /instance/i);
  assert.throws(() => summarize(a.slice(1), manifest), /instance/i);
});

test('SWE ingestion binds official evidence to exact predictions and keeps ungraded errors in denominator', async (t) => {
  const { ingestBatch } = await moduleFor('ingest.mjs');
  const { hash } = await moduleFor('../coding-evaluation/materialize.mjs');
  assert.equal(typeof ingestBatch, 'function');
  const root = await tempRoot(t, 'yuantu-swe-ingest-');
  const batch = path.join(root, 'batch'),
    evaluation = path.join(root, 'evaluation');
  await mkdir(batch);
  await mkdir(evaluation);
  const ids = ['fixture__source-1', 'fixture__source-2', 'fixture__source-3'];
  const modelName = 'yuantu@aaaaaaa+fixture';
  const predictions = ids.map((id) => ({
    instance_id: id,
    model_name_or_path: modelName,
    model_patch: 'patch',
  }));
  const predictionsBytes = predictions.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(path.join(batch, 'predictions.jsonl'), predictionsBytes);
  const manifest = {
    instances: ids,
    configHash: 'config',
    subset: { sha256: 'subset' },
    comparison: { datasetRevision: 'revision' },
  };
  await writeFile(path.join(batch, 'manifest.resolved.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(batch, 'results.jsonl'),
    ids
      .map((id) => JSON.stringify({ instanceId: id, configHash: 'config', patch: { bytes: 5 } }))
      .join('\n') + '\n',
  );
  const source = {
    predictionsSha256: hash(predictionsBytes),
    subsetHash: 'subset',
    datasetRevision: 'revision',
    runId: 'fixture',
    evaluatorVersion: '5.0.2',
    instanceIds: ids,
  };
  await writeFile(path.join(evaluation, 'evaluation-source.json'), JSON.stringify(source));
  await writeFile(
    path.join(evaluation, 'results.json'),
    JSON.stringify({
      resolved_ids: [ids[0]],
      unresolved_ids: [ids[1]],
      error_ids: [ids[2]],
      empty_patch_ids: [],
      failure_reasons: { [ids[2]!]: 'container startup failure' },
    }),
  );
  for (const [i, resolved] of [
    [0, true],
    [1, false],
  ] as const) {
    const dir = path.join(evaluation, 'logs/run_evaluation/fixture', modelName, ids[i]!);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'report.json'), JSON.stringify({ [ids[i]!]: { resolved } }));
    await writeFile(path.join(dir, 'patch.diff'), 'patch');
  }
  const officialSummaries: {
    instanceId: string;
    path: string;
    sha256: string;
    exitCode: number;
  }[] = [];
  for (const [i, id] of ids.entries()) {
    const file = path.join('parts', id, 'official.json');
    const bytes = JSON.stringify({
      resolved_ids: i === 0 ? [id] : [],
      unresolved_ids: i === 1 ? [id] : [],
      error_ids: i === 2 ? [id] : [],
      empty_patch_ids: [],
    });
    await mkdir(path.dirname(path.join(evaluation, file)), { recursive: true });
    await writeFile(path.join(evaluation, file), bytes);
    officialSummaries.push({ instanceId: id, path: file, sha256: hash(bytes), exitCode: 0 });
  }
  const baselineSummary = JSON.parse(await readFile(path.join(evaluation, 'results.json'), 'utf8'));
  baselineSummary.official_summaries = officialSummaries;
  await writeFile(path.join(evaluation, 'results.json'), JSON.stringify(baselineSummary));
  const rows = await ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation });
  assert.deepEqual(
    rows.map((r: any) => r.evaluation.status),
    ['resolved', 'unresolved', 'error'],
  );
  assert.equal(rows[2].evaluation.reason, 'container startup failure');
  assert.equal(rows[0].evaluation.reportSha256.length, 64);
  const original = await readFile(path.join(batch, 'results.evaluated.jsonl'), 'utf8');
  await ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation });
  assert.equal(await readFile(path.join(batch, 'results.evaluated.jsonl'), 'utf8'), original);
  await t.test('rejects a modified official summary original', async () => {
    const file = path.join(evaluation, officialSummaries[0]!.path);
    const originalBytes = await readFile(file);
    await writeFile(file, '{}');
    try {
      await assert.rejects(
        ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation }),
        /summary|hash/i,
      );
    } finally {
      await writeFile(file, originalBytes);
    }
  });
  await t.test('rejects a report for a different patch', async () => {
    const file = path.join(
      evaluation,
      'logs/run_evaluation/fixture',
      modelName,
      ids[0]!,
      'patch.diff',
    );
    await writeFile(file, 'different patch');
    try {
      await assert.rejects(
        ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation }),
        /patch/i,
      );
    } finally {
      await writeFile(file, 'patch');
    }
  });
  await t.test('an empty prediction cannot be graded resolved', async () => {
    const modified = predictions.map((p, i) => ({ ...p, model_patch: i ? p.model_patch : '' }));
    const bytes = modified.map((p) => JSON.stringify(p)).join('\n') + '\n';
    await writeFile(path.join(batch, 'predictions.jsonl'), bytes);
    await writeFile(
      path.join(evaluation, 'evaluation-source.json'),
      JSON.stringify({ ...source, predictionsSha256: hash(bytes) }),
    );
    try {
      await assert.rejects(
        ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation }),
        /empty|patch/i,
      );
    } finally {
      await writeFile(path.join(batch, 'predictions.jsonl'), predictionsBytes);
      await writeFile(path.join(evaluation, 'evaluation-source.json'), JSON.stringify(source));
    }
  });
  await writeFile(
    path.join(evaluation, 'evaluation-source.json'),
    JSON.stringify({ ...source, predictionsSha256: 'wrong' }),
  );
  await assert.rejects(
    ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation }),
    /prediction/i,
  );
  await writeFile(path.join(evaluation, 'evaluation-source.json'), JSON.stringify(source));
  await writeFile(
    path.join(evaluation, 'results.json'),
    JSON.stringify({
      resolved_ids: [ids[0]],
      unresolved_ids: [ids[0]],
      error_ids: [],
      empty_patch_ids: [],
    }),
  );
  await assert.rejects(
    ingestBatch({ batchDirectory: batch, evaluationDirectory: evaluation }),
    /conflict/i,
  );
});

test('SWE evaluator invocation matches pinned v5 CLI and rejects unbound dataset rows', async () => {
  const { evaluationArguments, validateEvaluationInputs } = await moduleFor('evaluate.mjs');
  assert.equal(typeof evaluationArguments, 'function');
  assert.deepEqual(
    evaluationArguments({
      dataset: '/data.jsonl',
      predictions: '/predictions.jsonl',
      runId: 'fixture',
      instanceId: 'o__r-1',
      reportDirectory: '/reports',
    }),
    [
      'eval',
      '/data.jsonl',
      '-p',
      '/predictions.jsonl',
      '--run-id',
      'fixture',
      '-i',
      'o__r-1',
      '-j',
      '1',
      '--report-dir',
      '/reports',
    ],
  );
  const { recordHash } = await moduleFor('select-subset.mjs');
  const record = fakeRecords()[0]!;
  const subset = {
    revision: 'a'.repeat(40),
    instances: [{ instance_id: record.instance_id, sha256: recordHash(record) }],
  };
  const preds = [
    { instance_id: record.instance_id, model_name_or_path: 'fixture', model_patch: 'patch' },
  ];
  assert.equal(validateEvaluationInputs(preds, [record], subset).length, 1);
  assert.throws(
    () => validateEvaluationInputs([...preds, ...preds], [record], subset),
    /duplicate/i,
  );
  assert.throws(
    () => validateEvaluationInputs(preds, [{ ...record, problem_statement: 'changed' }], subset),
    /hash/i,
  );
  assert.throws(
    () => validateEvaluationInputs([{ ...preds[0], model_patch: undefined }], [record], subset),
    /patch/i,
  );
});

test('SWE saved reports regenerate byte-identically and estimate token thresholds from observations', async (t) => {
  const { writeReport } = await moduleFor('report.mjs');
  const root = await tempRoot(t, 'yuantu-swe-report-');
  const manifest = {
    batchId: 'fixture',
    configHash: 'same',
    instances: ['o__r-1', 'o__r-2'],
    comparison: { model: 'fixture', promptCache: 'auto' },
  };
  const rows = manifest.instances.map((id, i) => ({
    instanceId: id,
    runtime: 'a',
    configHash: 'same',
    live: true,
    rounds: i + 1,
    durationMs: 100,
    tokens: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, complete: true },
    patch: { bytes: 10, changedTests: false },
    evaluation: {
      status: i ? 'unresolved' : 'resolved',
      reason: null,
      report: 'logs/report.json',
      reportSha256: 'hash',
    },
  }));
  await writeFile(path.join(root, 'manifest.resolved.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'results.evaluated.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const first = await writeReport({ batchDirectory: root });
  const report = await readFile(path.join(root, 'report.md'), 'utf8');
  const summary = await readFile(path.join(root, 'summary.json'), 'utf8');
  assert.equal(first.summary.suggestedMaxKnownTokensPerSample, 90);
  await writeReport({ batchDirectory: root });
  assert.equal(await readFile(path.join(root, 'report.md'), 'utf8'), report);
  assert.equal(await readFile(path.join(root, 'summary.json'), 'utf8'), summary);
  assert.ok(report.includes('logs/report.json'));
  assert.ok(report.includes('no-commands'));
});

test('SWE independent snapshot has complete base blobs, no lazy fetch, and stable patches', async (t) => {
  const { materializeRepo, git } = await moduleFor('repos.mjs');
  const { collectPatch } = await moduleFor('adapter.mjs');
  const root = await tempRoot(t, 'yuantu-swe-independent-');
  const source = path.join(root, 'upstream');
  await mkdir(source);
  await git(source, ['init']);
  await git(source, ['config', 'user.name', 'Fixture']);
  await git(source, ['config', 'user.email', 'fixture@example.invalid']);
  await git(source, ['config', 'uploadpack.allowFilter', 'true']);
  await writeFile(path.join(source, 'file.py'), 'old-history-only\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'old']);
  const oldBlob = (await git(source, ['rev-parse', 'HEAD:file.py'])).trim();
  await writeFile(path.join(source, 'file.py'), 'base-version\n');
  await git(source, ['commit', '-am', 'base']);
  const base = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const cacheDirectory = path.join(root, 'cache');
  await mkdir(cacheDirectory);
  const cache = path.join(cacheDirectory, 'fixture__source.git');
  const url = pathToFileURL(source).href;
  await git(root, ['clone', '--bare', '--filter=blob:none', url, cache]);
  assert.equal((await git(cache, ['config', 'remote.origin.promisor'])).trim(), 'true');
  // The old blob really is missing from this partial cache, before any checkout can hydrate it.
  assert.match(
    await git(cache, ['rev-list', '--objects', '--all', '--missing=print']),
    new RegExp(`\\?${oldBlob}`),
  );
  const directory = path.join(root, 'work');
  const materialized = await materializeRepo({
    record: { repo: 'fixture/source', base_commit: base },
    cacheDirectory,
    directory,
    source: url,
  });
  assert.equal(materialized.materialization.historyDepth, 0);
  assert.ok(materialized.materialization.metadataBytes > 0);
  assert.equal((await lstat(path.join(directory, '.git'))).isDirectory(), true);
  const common = (await git(directory, ['rev-parse', '--git-common-dir'])).trim();
  assert.equal(path.resolve(directory, common), path.join(directory, '.git'));
  await assert.rejects(access(path.join(directory, '.git/objects/info/alternates')));
  assert.equal((await git(directory, ['remote'])).trim(), '');
  assert.doesNotMatch(
    await git(directory, ['config', '--local', '--list']),
    /promisor|partialclone/i,
  );
  await assert.rejects(
    git(directory, ['cat-file', '-p', oldBlob]),
    /Not a valid object|bad object|could not get object info/i,
  );
  // Verify every base-tree blob locally; the snapshot has no remote for fetching.
  const objects = (await git(directory, ['ls-tree', '-r', base])).trim().split('\n');
  for (const line of objects) await git(directory, ['cat-file', '-p', line.split(/\s+/)[2]]);
  const tools = createTools(directory);
  try {
    for (const name of ['git_status', 'git_log']) {
      const result = await tools.execute(
        { id: name, name, arguments: {} },
        {
          signal: new AbortController().signal,
          executionPolicy: executionPolicy('host'),
          approve: async () => false,
        },
      );
      assert.equal(result.isError, false, result.content);
    }
  } finally {
    await tools.close();
  }
  const legacy = path.join(root, 'linked');
  await git(cache, ['worktree', 'add', '--detach', legacy, base]);
  for (const folder of [legacy, directory]) {
    await writeFile(path.join(folder, 'file.py'), 'changed-version\n');
    await writeFile(path.join(folder, 'new.py'), 'new-version\n');
  }
  const prior = await collectPatch(legacy, base),
    next = await collectPatch(directory, base);
  assert.equal(next.patch, prior.patch);
  assert.equal(
    createHash('sha256').update(next.patch).digest('hex'),
    createHash('sha256').update(prior.patch).digest('hex'),
  );
  assert.doesNotMatch(next.patch, /diff --git a\/\.git/);
  await rm(directory, { recursive: true });
  assert.equal(
    (await git(cache, ['worktree', 'list', '--porcelain']))
      .replaceAll('\\', '/')
      .includes(directory.replaceAll('\\', '/')),
    false,
  );
  await git(cache, ['worktree', 'remove', '--force', legacy]);
});
