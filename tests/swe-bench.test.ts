import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
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
  assert.match(await readFile(path.join(directory, '.git'), 'utf8'), /^gitdir: /);
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
    'office_edit',
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
    'password = "public fixture"\nsecret = "public fixture"\nvalue = 1\n',
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
    'password = "public fixture"\nsecret = "public fixture"\nvalue = 2\n',
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
        /denied|not available/i.test(item.event.data.content),
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
      manifest: { ...manifest, instanceTimeoutMs: 5000 },
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
