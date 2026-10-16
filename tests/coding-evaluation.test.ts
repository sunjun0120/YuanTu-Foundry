import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const harness = new URL('../benchmarks/coding-evaluation/', import.meta.url);
async function moduleFor(name: string): Promise<any> {
  return import(new URL(name, harness).href).catch(() => ({}));
}
async function temporary(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coding-eval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function example() {
  return JSON.parse(await readFile(new URL('manifest.example.json', harness), 'utf8'));
}

test('manifest rejects unsafe, unknown and ambiguous configuration before execution', async () => {
  const { validateManifest } = await moduleFor('schema.ts');
  assert.equal(typeof validateManifest, 'function', 'manifest validator is required');
  const valid = await example();
  validateManifest(valid);
  for (const patch of [
    { version: undefined },
    { cases: ['E01', 'E01'] },
    { caseConcurrency: 2 },
    { runtimeSource: { kind: 'commit', revision: 'main', directory: process.cwd() } },
    { apiKey: 'fake-secret' },
    { maxOutputTokens: 9000 },
    { sandbox: 'native' },
    { runtimeSource: { kind: 'snapshot', directory: '../source', manifestSha256: '0'.repeat(64) } },
    {
      approvedLiveBudget: {
        authorized: true,
        maxAttempts: -1,
        maxCurrency: null,
        currency: null,
        pricingSha256: null,
      },
    },
  ])
    assert.throws(() => validateManifest({ ...valid, ...patch }));
});

test('freezing copies production files with stable hashes and refuses reuse, mismatches and links', async (t) => {
  const { captureSourceManifest, freezeInputs, materializeCase, assertFrozen } =
    await moduleFor('materialize.mjs');
  assert.equal(typeof freezeInputs, 'function', 'input freezing is required');
  const root = await temporary(t);
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'packages'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'packages', 'source.ts'), 'export const value = 1;\n');
  await writeFile(path.join(source, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(source, 'docs', 'answer.md'), 'hidden answer');
  const captured = await captureSourceManifest(source);
  const spec = { kind: 'snapshot', directory: source, manifestSha256: captured.hash };
  const frozen = await freezeInputs({
    runtimeSource: spec,
    corpusSource: spec,
    outputDirectory: path.join(root, 'frozen'),
  });
  assert.equal(frozen.runtimeHash, captured.hash);
  assert.equal(frozen.corpusHash, captured.hash);
  assert.deepEqual((await captureSourceManifest(source)).files, captured.files);
  await assert.rejects(
    freezeInputs({
      runtimeSource: spec,
      corpusSource: spec,
      outputDirectory: path.join(root, 'frozen'),
    }),
    /exist/i,
  );
  const workspace = await materializeCase({
    frozen,
    caseId: 'E02',
    sampleId: 'E02-v1-1',
    outputDirectory: path.join(root, 'work'),
  });
  assert.equal(
    await readFile(path.join(workspace.directory, 'packages/source.ts'), 'utf8'),
    'export const value = 1;\n',
  );
  await assert.rejects(readFile(path.join(workspace.directory, 'docs/answer.md')));
  await writeFile(path.join(workspace.directory, 'packages/source.ts'), 'changed');
  await assertFrozen(frozen);
  await writeFile(path.join(source, 'packages/source.ts'), 'changed source');
  await assert.rejects(
    freezeInputs({
      runtimeSource: spec,
      corpusSource: spec,
      outputDirectory: path.join(root, 'mismatch'),
    }),
    /hash|changed/i,
  );
  const linked = path.join(source, 'packages', 'outside');
  await symlink(root, linked, 'junction');
  await assert.rejects(captureSourceManifest(source), /link/i);
});

test('request measurement deduplicates live and durable events, parent rollups and summary usage', async () => {
  const { collectMetrics } = await moduleFor('metrics.mjs');
  assert.equal(typeof collectMetrics, 'function', 'metrics collector is required');
  const event = (sessionId: string, requestId: number, purpose = 'answer', failed = false) => ({
    atMs: 8,
    event: {
      type: 'provider.request.finished',
      sessionId,
      runId: 'r',
      data: { requestId, purpose, failed },
    },
  });
  const events = [event('p', 1), event('p', 2, 'summary'), event('c1', 1), event('c2', 1)];
  const records = ['p', 'c1', 'c2'].map((sessionId) => ({
    sessionId,
    parentSessionId: sessionId === 'p' ? null : 'p',
    runIds: ['r'],
    events: events
      .filter((e) => e.event.sessionId === sessionId)
      .map((e) => ({ ...e.event, data: { ...e.event.data, runId: 'r' } })),
    statistics: {
      inputTokens: sessionId === 'p' ? 30 : 10,
      outputTokens: sessionId === 'p' ? 12 : 4,
      cachedInputTokens: sessionId === 'p' ? 6 : 2,
      cacheWriteInputTokens: 0,
      usageComplete: true,
      cacheKnown: true,
    },
  }));
  for (const child of ['c1', 'c2'])
    records[0]!.events.push({
      type: 'subagent.finished',
      sessionId: 'p',
      runId: 'r',
      data: {
        sessionId: child,
        id: child,
        runId: 'r',
        childRunId: 'r',
        usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, cacheWriteInputTokens: 0 },
      },
    } as any);
  const input = {
    events,
    runs: [
      {
        usage: { inputTokens: 999, outputTokens: 999 },
        statistics: { inputTokens: 999, outputTokens: 999 },
      },
    ],
    sessionRecords: records,
    timing: { wallMs: 20, setupMs: 2, verificationMs: 1, cleanupMs: 2 },
  };
  const metrics = collectMetrics(input);
  assert.equal(metrics.requests, 4);
  assert.equal(metrics.summaryRequests, 1);
  assert.equal(metrics.usage.inputTokens, 30);
  assert.equal(metrics.usage.outputTokens, 12);
  assert.equal(metrics.usage.complete, true);
  assert.deepEqual(collectMetrics({ ...input, events: [...events, ...events] }), metrics);
  assert.equal(
    collectMetrics({ ...input, events: [...events, event('p', 3, 'answer', true)] }).usage.complete,
    false,
  );
});

test('aggregation preserves blocked denominators and rejects duplicate, missing and incomparable samples', async () => {
  const { aggregateResults } = await moduleFor('metrics.mjs');
  assert.equal(typeof aggregateResults, 'function', 'batch aggregation is required');
  const planned = [
    { sampleId: 'E01-v1-1', caseId: 'E01', repeat: 1, variantId: 'v1' },
    { sampleId: 'E02-v1-1', caseId: 'E02', repeat: 1, variantId: 'v1' },
  ];
  const results = planned.map((p, i) => ({
    ...p,
    version: 1,
    batchId: 'batch',
    live: true,
    category: 'coding',
    runtimeHash: 'a',
    corpusHash: 'b',
    oracleHash: 'c',
    configHash: 'd',
    promptHash: p.caseId,
    outcome: i ? 'blocked' : 'passed',
    independentPass: !i,
    unassistedPass: !i,
    humanInterventions: [],
    cleanupConfirmed: true,
    wallMs: 10,
    usage: { complete: false },
    cost: { amount: null },
  }));
  const summary = aggregateResults(results, planned);
  assert.equal(summary.plannedCount, 2);
  assert.equal(summary.completionRate, 0.5);
  assert.equal(summary.complete, false);
  assert.equal(summary.cost.amount, null);
  assert.throws(() => aggregateResults([results[0], results[0]], planned), /duplicate/i);
  assert.throws(() => aggregateResults(results.slice(0, 1), planned), /missing/i);
  assert.throws(
    () => aggregateResults([results[0], { ...results[1], corpusHash: 'different' }], planned),
    /comparab/i,
  );
  assert.throws(
    () =>
      aggregateResults(
        [{ ...results[0], humanInterventions: [{ kind: 'hint' }] }, results[1]],
        planned,
      ),
    /unassisted/i,
  );
});

test('fixed ten-case corpus rejects drift, preserves paused cases and seals exact seeds', async (t) => {
  const { getCase, prepareCase, applyReference } = await moduleFor('cases.mjs');
  assert.equal(typeof getCase, 'function', 'fixed cases are required');
  assert.equal(
    Array.from({ length: 10 }, (_, n) => getCase(`E${String(n + 1).padStart(2, '0')}`)).length,
    10,
  );
  assert.throws(() => getCase('E11'));
  const root = await temporary(t);
  await mkdir(path.join(root, 'packages/protocol'), { recursive: true });
  const original = await readFile(path.resolve('packages/protocol/failure.ts'), 'utf8');
  await writeFile(path.join(root, 'packages/protocol/failure.ts'), original);
  const workspace = { directory: root, sampleId: 'E02-v1-1', baseHash: 'base', baseFiles: [] };
  const prepared = await prepareCase(getCase('E02'), workspace);
  assert.match(
    await readFile(path.join(root, 'packages/protocol/failure.ts'), 'utf8'),
    /if \(status === 401\) return 'auth';/,
  );
  assert.equal(prepared.prompt.includes('if (status'), false);
  assert.equal(prepared.seedHash.length, 64);
  await assert.rejects(prepareCase(getCase('E02'), workspace), /seed|unique|drift/i);
  await applyReference(getCase('E02'), workspace);
  assert.equal(await readFile(path.join(root, 'packages/protocol/failure.ts'), 'utf8'), original);
  /**
   * The paused CLI surface is a **product** fact, not a harness refusal.
   *
   * E06 and E10 are still sampled through the Agent Host: the requirement cannot be met while
   * `PRODUCT_SCOPE.cli` is false, and that is exactly what the report has to say. A `blockedReason` here would
   * hide a real product limitation behind the harness — which is why `cases.mjs` deliberately has none.
   */
  for (const id of ['E06', 'E10']) {
    assert.equal(getCase(id).blockedReason, undefined, `${id} is sampled, not refused`);
    assert.ok(
      getCase(id).allowedPaths.includes('apps/shared/args.ts'),
      `${id} still owns the paused CLI surface`,
    );
  }
});

test('external oracle detects byte-cap regression and cannot trust a rewritten public test', async (t) => {
  const { executeOracle } = await moduleFor('verify.mjs');
  const { getCase, prepareCase, applyReference } = await moduleFor('cases.mjs');
  assert.equal(typeof executeOracle, 'function', 'external oracle is required');
  const root = await temporary(t);
  await mkdir(path.join(root, 'packages/tools'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(root, 'packages/tools/spill.ts'),
    await readFile(path.resolve('packages/tools/spill.ts')),
  );
  await writeFile(
    path.join(root, 'tests/spill.test.ts'),
    "import test from 'node:test'; test('always green',()=>{});\n",
  );
  const workspace = { directory: root, sampleId: 'E01-v1-1', baseHash: 'base', baseFiles: [] };
  const baseline = await executeOracle(
    getCase('E01'),
    workspace,
    path.join(root, 'evidence-original'),
  );
  assert.equal(baseline.passed, true);
  await prepareCase(getCase('E01'), workspace);
  const degraded = await executeOracle(
    getCase('E01'),
    workspace,
    path.join(root, 'evidence-degraded'),
  );
  assert.equal(degraded.passed, false);
  assert.ok(degraded.checks.some((check: any) => !check.passed && check.id.includes('byte')));
  await applyReference(getCase('E01'), workspace);
  assert.equal(
    (await executeOracle(getCase('E01'), workspace, path.join(root, 'evidence-reference'))).passed,
    true,
  );
});

test('test process accounting rejects empty, skipped, missing-assertion and timed-out acceptance', async () => {
  const { parseTestSummary } = await moduleFor('verify.mjs');
  assert.equal(typeof parseTestSummary, 'function', 'trusted regression parser is required');
  const summary = (tests = 2, pass = 2, fail = 0, skip = 0) =>
    `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skip}\n# todo 0\n`;
  assert.equal(parseTestSummary(summary(), 0, false).passed, true);
  for (const input of [
    [summary(0, 0), 0, false],
    ['', 0, false],
    [summary(2, 1, 0, 1), 0, false],
    [summary(), 0, true],
    [summary(), 1, false],
  ])
    assert.equal(parseTestSummary(...input).passed, false);
  // A skip that names a documented platform reason is the one shape that may pass — and only when the case
  // declares that exact reason for this platform.
  const documented = {
    platformSkips: { [process.platform]: ['POSIX permission bits are not a Windows concept'] },
  };
  const named = (reason: string) =>
    `# tests 13\n# pass 12\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 4 - x # SKIP${reason}\n`;
  assert.equal(
    parseTestSummary(
      named(' POSIX permission bits are not a Windows concept'),
      0,
      false,
      documented,
    ).passed,
    true,
  );
  assert.equal(parseTestSummary(named(''), 0, false, documented).passed, false);
  assert.equal(parseTestSummary(named(' some other reason'), 0, false, documented).passed, false);
  // Counts that do not add up are a summary this parser refuses to believe.
  assert.equal(
    parseTestSummary(
      '# tests 13\n# pass 13\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 4 - x # SKIP POSIX permission bits are not a Windows concept\n',
      0,
      false,
      documented,
    ).passed,
    false,
  );
});

test('offline scenario grading refuses no cancel, workload replay and fake delegation', async () => {
  const { verifyScenario } = await moduleFor('verify.mjs');
  assert.equal(typeof verifyScenario, 'function', 'scenario oracle is required');
  const cancellation = {
    readySeen: true,
    cancellationAcknowledged: true,
    ownedProcessExited: true,
    markerStopped: true,
    restartedSameSession: true,
    workloadStarts: 1,
    retentionVerified: true,
    historyReadable: true,
    cleanupConfirmed: true,
  };
  assert.equal(verifyScenario('E09', cancellation).passed, true);
  assert.equal(
    verifyScenario('E09', { ...cancellation, cancellationAcknowledged: false }).passed,
    false,
  );
  assert.equal(verifyScenario('E09', { ...cancellation, workloadStarts: 2 }).passed, false);
  assert.equal(
    verifyScenario('E10', {
      delegatedSessions: [],
      retentionVerified: true,
      cliVerified: true,
      cleanupConfirmed: true,
    }).passed,
    false,
  );
});

test('adapter handles split UTF-8 JSONL and refuses missing, duplicate or wrong terminal identities', async () => {
  const { JsonlRunCollector } = await moduleFor('adapters.mjs');
  assert.equal(typeof JsonlRunCollector, 'function', 'framed result collector is required');
  const frame =
    JSON.stringify({
      type: 'result',
      result: { sessionId: 's', runId: 'r', status: 'completed', text: '中文😀' },
    }) + '\n';
  const encoded = Buffer.from(frame);
  const collector = new JsonlRunCollector({ sessionId: 's', runId: 'r' });
  for (const byte of encoded) collector.write(Buffer.from([byte]));
  assert.equal(collector.finish(0).runs[0].text, '中文😀');
  assert.throws(() => new JsonlRunCollector().finish(0), /terminal/i);
  assert.throws(() => {
    const c = new JsonlRunCollector();
    c.write(Buffer.from(frame + frame));
    c.finish(0);
  }, /duplicate/i);
  assert.throws(() => {
    const c = new JsonlRunCollector({ sessionId: 'other' });
    c.write(encoded);
    c.finish(0);
  }, /identity/i);
  assert.throws(() => {
    const c = new JsonlRunCollector();
    c.write(encoded);
    c.finish(1);
  }, /exit/i);
  assert.throws(() => {
    const c = new JsonlRunCollector();
    c.write(encoded.subarray(0, -1));
    c.finish(0);
  }, /partial/i);
});

test('live authorization refuses missing budget/model/receipt and controlled environment removes hooks and credentials', async () => {
  const { runHostSample, controlledEnvironment, redact } = await moduleFor('adapters.mjs');
  assert.equal(typeof runHostSample, 'function', 'Host adapter is required');
  const manifest = await example();
  await assert.rejects(
    runHostSample({ manifest }, new AbortController().signal),
    /not authorized/i,
  );
  const env = controlledEnvironment(manifest, {
    PATH: 'path',
    SystemRoot: 'root',
    YUANTU_API_KEY: 'supplied',
    YUANTU_HOOKS_MODULE: 'evil',
    YUANTU_SUBAGENT_MODELS: 'expensive',
    OPENAI_API_KEY: 'other',
    HOME: 'private',
    HTTP_PROXY: 'secret-proxy',
    NODE_OPTIONS: '--require evil',
  });
  assert.equal(env.YUANTU_API_KEY, 'supplied');
  assert.equal(env.YUANTU_HOOKS_MODULE, undefined);
  assert.equal(env.HOME, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.YUANTU_SUBAGENTS, '0');
  assert.equal(
    controlledEnvironment(manifest, { PATH: 'path' }, { subagents: true }).YUANTU_SUBAGENTS,
    '1',
  );
  assert.equal(env.YUANTU_SANDBOX, 'host');
  assert.equal(redact('Bearer sk-fake-token supplied', ['supplied']).includes('supplied'), false);
});

test('runner enforces strict CLI flags, caps overrides and never turns fixture output into live success', async () => {
  const { parseArguments, plannedSamples, resolveManifest } = await moduleFor('run.mjs');
  assert.equal(typeof parseArguments, 'function', 'strict evaluation runner is required');
  const parsed = parseArguments([
    '--manifest=a.json',
    '--out=batch',
    '--batch-id=pilot',
    '--live',
    '--cases=E02,E03',
    '--repeats=1',
  ]);
  assert.equal(parsed.live, true);
  assert.throws(() => parseArguments(['--unknown=value']), /unknown/i);
  assert.throws(() => parseArguments(['--dry-run', '--live']), /exclusive/i);
  assert.throws(() => parseArguments(['--manifest=a', '--manifest=b']), /duplicate/i);
  const original = await example();
  const resolved = resolveManifest(original, parsed);
  assert.equal(resolved.maxLiveAttempts, 2);
  assert.equal(plannedSamples(original).length, 30);
  assert.equal(plannedSamples(resolved).length, 2);
  assert.equal(new Set(plannedSamples(original).map((p: any) => p.sampleId)).size, 30);
});

test('saved reports regenerate deterministically and retain all fixed-case blockers', async (t) => {
  const { writeReport } = await moduleFor('report.mjs');
  const { plannedSamples } = await moduleFor('run.mjs');
  assert.equal(typeof writeReport, 'function', 'reproducible reporting is required');
  const root = await temporary(t);
  const manifest = await example();
  const planned = plannedSamples(manifest);
  const results = planned.map((p: any) => ({
    ...p,
    version: 1,
    batchId: manifest.batchId,
    category: Number(p.caseId.slice(1)) <= 8 ? 'coding' : 'operational',
    live: false,
    runtimeHash: 'runtime',
    corpusHash: 'corpus',
    oracleHash: 'oracle',
    configHash: 'config',
    promptHash: p.caseId,
    outcome: 'blocked',
    agentStatus: null,
    independentPass: false,
    unassistedPass: false,
    humanInterventions: [],
    cleanupConfirmed: true,
    failureClass: 'offline-not-executed',
    wallMs: 0,
    usage: { complete: false },
    cost: { amount: null },
  }));
  await writeFile(
    path.join(root, 'results.jsonl'),
    results.map((r: any) => JSON.stringify(r)).join('\n') + '\n',
  );
  await writeFile(
    path.join(root, 'manifest.resolved.json'),
    JSON.stringify({ ...manifest, planned }),
  );
  const report = await writeReport({
    input: path.join(root, 'results.jsonl'),
    manifest: path.join(root, 'manifest.resolved.json'),
    outputDirectory: root,
  });
  const first = await readFile(path.join(root, 'report.md'), 'utf8');
  await writeReport({
    input: path.join(root, 'results.jsonl'),
    manifest: path.join(root, 'manifest.resolved.json'),
    outputDirectory: root,
  });
  assert.equal(await readFile(path.join(root, 'report.md'), 'utf8'), first);
  assert.equal(report.summary.plannedCount, 30);
  assert.equal(report.summary.outcomes.blocked, 30);
  assert.equal(report.summary.groups.coding.planned, 24);
  assert.equal(report.summary.groups.operational.planned, 6);
  assert.match(first, /E06/);
  assert.match(first, /真实模型.*未执行/);
});

test('private dependencies are copied from locked versions and reject linked source roots', async (t) => {
  const { copyLockedDependencies } = await moduleFor('dependencies.mjs');
  const { inventory, hash } = await moduleFor('materialize.mjs');
  const root = await temporary(t);
  const source = path.join(root, 'dependency-source'),
    target = path.join(root, 'dependency-target');
  await mkdir(path.join(source, 'node_modules/a'), { recursive: true });
  await mkdir(target);
  const lock = '{"packages":{"node_modules/a":{"version":"1.0.0"}}}';
  await writeFile(path.join(source, 'package.json'), '{"dependencies":{"a":"1.0.0"}}');
  await writeFile(path.join(source, 'package-lock.json'), lock);
  await writeFile(path.join(target, 'package-lock.json'), lock);
  await writeFile(
    path.join(source, 'node_modules/a/package.json'),
    '{"name":"a","version":"1.0.0"}',
  );
  await writeFile(path.join(source, 'node_modules/a/index.js'), 'export default 1;');
  const receipt = await copyLockedDependencies({
    sourceDirectory: source,
    targetDirectory: target,
  });
  assert.equal(
    receipt.filesHash,
    hash(await inventory(path.join(target, 'node_modules'), { includeExcluded: true })),
  );
  await writeFile(path.join(target, 'node_modules/a/index.js'), 'changed');
  assert.equal(
    await readFile(path.join(source, 'node_modules/a/index.js'), 'utf8'),
    'export default 1;',
  );
  const linked = path.join(root, 'linked-source'),
    other = path.join(root, 'other-target');
  await symlink(source, linked, 'junction');
  await mkdir(other);
  await writeFile(path.join(other, 'package-lock.json'), lock);
  await assert.rejects(
    copyLockedDependencies({ sourceDirectory: linked, targetDirectory: other }),
    /link/i,
  );
});

test('nested locked dependencies are copied once with private bytes and complete receipts', async (t) => {
  const { copyLockedDependencies } = await moduleFor('dependencies.mjs');
  const { inventory, hash } = await moduleFor('materialize.mjs');
  const root = await temporary(t),
    source = path.join(root, 'source'),
    target = path.join(root, 'target');
  const nested = 'node_modules/a/node_modules/b';
  await mkdir(path.join(source, nested), { recursive: true });
  await mkdir(target);
  const lock = JSON.stringify({
    packages: {
      'node_modules/a': { version: '1.0.0' },
      [nested]: { version: '2.0.0' },
    },
  });
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ dependencies: { a: '1.0.0' } }),
  );
  await writeFile(
    path.join(source, 'node_modules/a/package.json'),
    JSON.stringify({ version: '1.0.0', dependencies: { b: '2.0.0' } }),
  );
  await writeFile(path.join(source, nested, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  await writeFile(path.join(source, nested, 'index.js'), 'original nested bytes');
  for (const directory of [source, target])
    await writeFile(path.join(directory, 'package-lock.json'), lock);
  const receipt = await copyLockedDependencies({
    sourceDirectory: source,
    targetDirectory: target,
  });
  assert.deepEqual(
    receipt.packages.map((item: any) => item.name),
    ['a', 'a/node_modules/b'],
  );
  assert.equal(
    receipt.filesHash,
    hash(await inventory(path.join(target, 'node_modules'), { includeExcluded: true })),
  );
  await writeFile(path.join(target, nested, 'index.js'), 'private edit');
  assert.equal(
    await readFile(path.join(source, nested, 'index.js'), 'utf8'),
    'original nested bytes',
  );
});

test('real Host bridge uses only a loopback fixture and settles success/cancel with owned cleanup', async (t) => {
  const { fakeEndpointSelfCheck, assertOfflineReceipt } = await moduleFor('live-self-check.mjs');
  const { CONTINUE_PROMPT } = await moduleFor('scenario.mjs');
  const { applyReference } = await moduleFor('cases.mjs');
  const { runHostSample } = await moduleFor('adapters.mjs');
  const { captureSourceManifest, freezeInputs, materializeCase, copyFiles, hash } =
    await moduleFor('materialize.mjs');
  const { copyLockedDependencies } = await moduleFor('dependencies.mjs');
  const { getCase, prepareCase } = await moduleFor('cases.mjs');
  const root = await temporary(t);
  const captured = await captureSourceManifest(process.cwd());
  const isolated = path.join(root, 'isolated-input');
  const files = captured.files.filter(
    (file: any) =>
      (file.path.startsWith('packages/') &&
        file.path !== 'packages/client/session-controller.ts') ||
      file.path.startsWith('apps/agent-host/') ||
      file.path.startsWith('apps/shared/') ||
      ['package.json', 'package-lock.json'].includes(file.path),
  );
  await copyFiles(process.cwd(), isolated, files);
  for (const file of files)
    assert.equal(
      hash(await readFile(path.resolve(file.path))),
      file.sha256,
      `source changed: ${file.path}`,
    );
  const source = {
    kind: 'snapshot',
    directory: isolated,
    manifestSha256: (await captureSourceManifest(isolated)).hash,
  };
  const frozen = await freezeInputs({
    runtimeSource: source,
    corpusSource: source,
    outputDirectory: path.join(root, 'frozen'),
  });
  await copyLockedDependencies({
    sourceDirectory: process.cwd(),
    targetDirectory: frozen.runtimeDirectory,
  });
  let e09 = false,
    continuedEdits = 0;
  const originalSpill = await readFile(
    path.join(frozen.corpusDirectory, 'packages/tools/spill.ts'),
    'utf8',
  );
  const referenceDirectory = path.join(root, 'reference');
  await mkdir(path.join(referenceDirectory, 'packages/tools'), { recursive: true });
  await writeFile(path.join(referenceDirectory, 'packages/tools/spill.ts'), originalSpill);
  await applyReference(getCase('E09'), { directory: referenceDirectory });
  const referenceSpill = await readFile(
    path.join(referenceDirectory, 'packages/tools/spill.ts'),
    'utf8',
  );
  let received = 0;
  const server = createServer(async (request, response) => {
    received++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(payload.model, 'coding-evaluation-fixture');
    assert.equal(request.headers.authorization, 'Bearer coding-evaluation-fake-key');
    if (e09 && payload.tools?.length) {
      const continuing = JSON.stringify(payload.messages).includes(CONTINUE_PROMPT);
      const continuationStep = continuing ? continuedEdits++ : -1;
      const call = !continuing
        ? { name: 'run_command', arguments: { command: 'node evaluation-workload.cjs' } }
        : continuationStep === 0
          ? { name: 'read_file', arguments: { path: 'packages/tools/spill.ts' } }
          : continuationStep === 1
            ? {
                name: 'edit_file',
                arguments: {
                  path: 'packages/tools/spill.ts',
                  old_text: originalSpill,
                  new_text: referenceSpill,
                },
              }
            : null;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `fixture-${received}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }
        : { content: 'fixture continuation completed' };
      for (const data of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
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
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of [
      {
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: payload.model,
        choices: [{ index: 0, delta: { content: 'fixture 正文😀' }, finish_reason: null }],
      },
      {
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: payload.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    ])
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    response.end('data: [DONE]\n\n');
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
  const manifest = {
    ...(await example()),
    model: 'coding-evaluation-fixture',
    protocol: 'openai',
    endpointId: 'numeric-loopback-fixture',
    endpointUrl: `http://127.0.0.1:${address.port}/v1`,
    caseTimeoutMs: { ...(await example()).caseTimeoutMs, E02: 20000, E09: 20000 },
  };
  const receipt = await fakeEndpointSelfCheck({
    frozen,
    manifest,
    directory: path.join(root, 'self-check'),
  });
  assertOfflineReceipt(receipt, frozen.runtimeHash);
  // The self-check already runs the real Host for both outcomes and saves adapter evidence.
  // Assert that evidence directly instead of repeating both Host lifecycles and dependency scans.
  for (const variant of ['completion', 'cancellation']) {
    const hanging = variant === 'cancellation';
    const result = JSON.parse(
      await readFile(path.join(root, 'self-check', variant, 'evidence', 'adapter.json'), 'utf8'),
    );
    assert.equal(result.live, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.sessionRecords.length, 1);
    // Cancellation may report a failed request as it unwinds; completion must show a finished request.
    if (!hanging)
      assert.ok(result.events.some((item: any) => item.event.type === 'provider.request.finished'));
    assert.equal(JSON.stringify(result).includes('coding-evaluation-fake-key'), false);
    if (hanging) {
      // The Host ends a cancelled run by aborting it, so there is no terminal RunResult to match: what has to be
      // proven is that the cancellation was answered and the run slot was released.
      assert.equal(result.cancellation.acknowledged, true);
      assert.equal(result.cancellation.runSlotReleased, true);
      assert.equal(result.cancellation.terminalSettled, true);
      // A cancellation the Host answered and settled is an expected end, not an environment failure.
      assert.equal(result.failureClass, null);
      assert.equal(result.runs.length, 0);
    } else {
      assert.equal(result.cancellation, null);
      assert.equal(result.terminalSeen, true);
      assert.equal(result.runs[0].status, 'completed');
      assert.equal(result.failureClass, null);
    }
  }
  e09 = true;
  const scenarioCase = getCase('E09');
  const scenarioWorkspace = await materializeCase({
    frozen,
    caseId: 'E09',
    sampleId: 'E09-fixture',
    outputDirectory: path.join(root, 'scenario-workspace'),
  });
  const scenarioPrepared = await prepareCase(scenarioCase, scenarioWorkspace);
  const scenario = await runHostSample(
    {
      manifest,
      prepared: scenarioPrepared,
      caseDef: scenarioCase,
      frozen,
      evidenceDirectory: path.join(root, 'scenario-evidence'),
      offlineProbe: true,
      providerKey: 'coding-evaluation-fake-key',
    },
    new AbortController().signal,
  );
  assert.equal(scenario.live, false);
  assert.equal(
    scenario.scenario.readySeen,
    true,
    JSON.stringify({
      scenario: scenario.scenario,
      failureClass: scenario.failureClass,
      interactions: scenario.interactions,
    }),
  );
  assert.equal(scenario.scenario.cancellationAcknowledged, true);
  assert.equal(scenario.scenario.ownedProcessExited, true);
  assert.equal(scenario.scenario.markerStopped, true);
  assert.equal(scenario.scenario.workloadStarts, 1);
  assert.equal(scenario.scenario.restartedSameSession, true);
  assert.equal(scenario.scenario.historyReadable, true);
  assert.equal(scenario.cleanupConfirmed, true);
  assert.equal(scenario.failureClass, null);
  assert.equal(
    scenario.cancellation,
    null,
    'scheduled E09 phase cancellation is not external sample cancellation',
  );
  assert.equal(scenario.runs.at(-1).status, 'completed');
  const { executeOracle } = await moduleFor('verify.mjs');
  /**
   * What this case has to prove here is the *scenario*: the workload was owned, cancelled and not replayed, the
   * session was reopened on the same database and the history was readable. Whether the model then implemented the
   * retention requirement is a separate question, and in the offline control the fixture model edits nothing at
   * all — so the retention oracle is asserted against a clean reference workspace rather than against whatever the
   * fixture run happened to leave behind. Scoring the scenario copy would grade the fixture's noise.
   */
  const referenceWorkspace = await materializeCase({
    frozen,
    caseId: 'E09',
    sampleId: 'E09-reference',
    outputDirectory: path.join(root, 'scenario-reference'),
  });
  await prepareCase(scenarioCase, referenceWorkspace);
  await applyReference(scenarioCase, referenceWorkspace);
  const scenarioOracle = await executeOracle(
    scenarioCase,
    referenceWorkspace,
    path.join(root, 'scenario-oracle'),
  );
  assert.equal(
    scenarioOracle.passed,
    true,
    JSON.stringify(scenarioOracle.checks.filter((check: any) => !check.passed)),
  );
});

test('private dependency clones cannot mutate their receipt source through a shared inode', async (t) => {
  const { preparePrivateDependencies, copyLockedDependencies } =
    await moduleFor('dependencies.mjs');
  const root = await temporary(t);
  const source = path.join(root, 'source'),
    canonical = path.join(root, 'canonical'),
    target = path.join(root, 'target');
  const lock = JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0' } } });
  await mkdir(path.join(source, 'node_modules/example'), { recursive: true });
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ dependencies: { example: '1.0.0' } }),
  );
  await writeFile(path.join(source, 'node_modules/example/package.json'), '{"version":"1.0.0"}');
  await writeFile(path.join(source, 'node_modules/example/index.js'), 'original');
  for (const directory of [source, canonical, target]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package-lock.json'), lock);
  }
  await copyLockedDependencies({ sourceDirectory: source, targetDirectory: canonical });
  await preparePrivateDependencies({ sourceDirectory: canonical, targetDirectory: target });
  await writeFile(path.join(target, 'node_modules/example/index.js'), 'modified');
  assert.equal(
    await readFile(path.join(canonical, 'node_modules/example/index.js'), 'utf8'),
    'original',
  );
  await assert.rejects(preparePrivateDependencies({ targetDirectory: target }), /content changed/);
});

test('batch cancellation before setup leaves no output or attempted sample', async (t) => {
  const { executeBatch } = await moduleFor('run.mjs');
  const root = await temporary(t),
    output = path.join(root, 'batch');
  const manifest = await example();
  manifest.runtimeSource.directory = path.join(root, 'not-read');
  await assert.rejects(
    executeBatch(manifest, { signal: AbortSignal.abort(), outputDirectory: output }),
    /abort/i,
  );
  await assert.rejects(readFile(path.join(output, 'manifest.resolved.json')), /ENOENT/);
});

test('live receipt requires observed completion and settled cancellation from the same frozen runtime', async () => {
  const { assertOfflineReceipt } = await moduleFor('live-self-check.mjs');
  assert.equal(typeof assertOfflineReceipt, 'function');
  const receipt = {
    version: 2,
    kind: 'fake-endpoint-self-check',
    runtimeHash: 'runtime',
    checksPassed: true,
    observed: {
      completion: { terminalSeen: true, cleanupConfirmed: true, status: 'completed', requests: 1 },
      cancellation: {
        acknowledged: true,
        terminalSettled: true,
        runSlotReleased: true,
        cleanupConfirmed: true,
        requests: 1,
      },
      credentialLeaked: false,
    },
  };
  assertOfflineReceipt(receipt, 'runtime');
  for (const invalid of [
    { ...receipt, runtimeHash: 'other' },
    { ...receipt, observed: { ...receipt.observed, cancellation: undefined } },
    { ...receipt, observed: { ...receipt.observed, credentialLeaked: true } },
    {
      ...receipt,
      observed: {
        ...receipt.observed,
        cancellation: { ...receipt.observed.cancellation, terminalSettled: false },
      },
    },
  ])
    assert.throws(() => assertOfflineReceipt(invalid, 'runtime'), /self-check receipt/);
});

test('E09 retention oracle and reference preserve the full E05 behavioral contract', async (t) => {
  const { getCase, applyReference } = await moduleFor('cases.mjs');
  const { executeOracle } = await moduleFor('verify.mjs');
  const root = await temporary(t);
  await mkdir(path.join(root, 'packages/tools'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(root, 'packages/tools/spill.ts'),
    await readFile(path.resolve('packages/tools/spill.ts')),
  );
  const workspace = { directory: root, sampleId: 'E09-reference', baseFiles: [] };
  const original = await executeOracle(getCase('E09'), workspace, path.join(root, 'original'));
  assert.equal(original.passed, false);
  assert.ok(
    original.checks.some(
      (check: any) => check.id === 'retention-invalid-before-write' && !check.passed,
    ),
  );
  await applyReference(getCase('E09'), workspace);
  const reference = await executeOracle(getCase('E09'), workspace, path.join(root, 'reference'));
  assert.equal(reference.passed, true);
});

test('E09 owned workload records its parent and child, stops markers, and refuses replay and tampering', async (t) => {
  const { installWorkload, waitForWorkloadReady, inspectWorkload, assertWorkloadProtected } =
    await moduleFor('scenario.mjs');
  assert.equal(typeof installWorkload, 'function');
  const root = await temporary(t),
    workspace = { directory: root, sampleId: 'E09-control' };
  const scenario = await installWorkload(workspace);
  const child = spawn(process.execPath, [path.join(root, 'evaluation-workload.cjs')], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  t.after(async () => {
    if (child.connected) child.send('stop');
    await closed;
  });
  const ready = await waitForWorkloadReady({ ...workspace, scenario }, AbortSignal.timeout(5000));
  assert.equal(ready.parentPid, child.pid);
  assert.ok(ready.childPid > 0 && ready.childPid !== ready.parentPid);
  assert.equal((await inspectWorkload({ ...workspace, scenario })).ownedProcessExited, false);
  child.send('stop');
  await closed;
  const result = await inspectWorkload({ ...workspace, scenario });
  assert.equal(result.readySeen, true);
  assert.equal(result.ownedProcessExited, true);
  assert.equal(result.markerStopped, true);
  assert.equal(result.workloadStarts, 1);
  await assertWorkloadProtected({ ...workspace, scenario });
  await writeFile(path.join(root, 'evaluation-workload.cjs'), 'modified');
  await assert.rejects(assertWorkloadProtected({ ...workspace, scenario }), /protected workload/);
});

test('batch cancellation during offline setup accounts for every planned sample with zero attempts', async (t) => {
  const { executeBatch } = await moduleFor('run.mjs');
  const { captureSourceManifest } = await moduleFor('materialize.mjs');
  const root = await temporary(t),
    source = path.join(root, 'source'),
    output = path.join(root, 'batch');
  await mkdir(path.join(source, 'node_modules'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), '{"type":"module","dependencies":{}}');
  await writeFile(path.join(source, 'package-lock.json'), '{"packages":{}}');
  const spec = {
    kind: 'snapshot',
    directory: source,
    manifestSha256: (await captureSourceManifest(source)).hash,
  };
  const manifest = { ...(await example()), runtimeSource: spec, corpusSource: spec };
  const cancellation = new AbortController();
  const timer = setInterval(() => {
    void readFile(path.join(output, 'manifest.resolved.json')).then(
      () => cancellation.abort(),
      () => {},
    );
  }, 1);
  t.after(() => clearInterval(timer));
  const result = await executeBatch(manifest, {
    outputDirectory: output,
    signal: cancellation.signal,
  });
  clearInterval(timer);
  assert.equal(result.planned.length, 30);
  assert.equal(result.results.length, 30);
  assert.ok(
    result.results.every(
      (sample: any) =>
        sample.outcome === 'blocked' && sample.failureClass === 'external-cancelled-before-sample',
    ),
  );
  const batch = JSON.parse(await readFile(path.join(output, 'batch.json'), 'utf8'));
  assert.equal(batch.attempts, 0);
  assert.equal(batch.requests, 0);
  assert.equal(batch.externallyCancelled, true);
  assert.equal(result.exitCode, 2);
});

test('a cancellation without acknowledged settlement and cleanup remains invalid', async () => {
  const { gradeSample } = await moduleFor('metrics.mjs');
  const input: any = {
    sample: { caseId: 'E02', sampleId: 'E02-v1-1', variantId: 'v1', repeat: 1 },
    manifest: await example(),
    frozen: { runtimeHash: 'runtime', corpusHash: 'corpus' },
    prepared: { promptHash: 'prompt' },
    oracleHash: 'oracle',
    configHash: 'config',
    humanInterventions: [],
    live: true,
    adapter: {
      runs: [],
      events: [],
      sessionRecords: [],
      terminalSeen: false,
      exitCode: 0,
      timing: { wallMs: 1, setupMs: 0, verificationMs: 0, cleanupMs: 0 },
      cleanupConfirmed: true,
      cancellation: { acknowledged: true, terminalSettled: true, runSlotReleased: true },
    },
    verification: { passed: false, timedOut: false, tampered: false, checks: [] },
  };
  assert.equal(gradeSample(input).outcome, 'cancelled');
  for (const patch of [
    { acknowledged: false },
    { terminalSettled: false },
    { runSlotReleased: false },
  ])
    assert.equal(
      gradeSample({
        ...input,
        adapter: { ...input.adapter, cancellation: { ...input.adapter.cancellation, ...patch } },
      }).outcome,
      'invalid',
    );
  assert.equal(
    gradeSample({ ...input, adapter: { ...input.adapter, cleanupConfirmed: false } }).outcome,
    'invalid',
  );
});
