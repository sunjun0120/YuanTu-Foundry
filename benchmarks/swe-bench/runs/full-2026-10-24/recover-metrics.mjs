import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, realpath, mkdir, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
const { collectMetrics } = await import(
  pathToFileURL(path.resolve('benchmarks/coding-evaluation/metrics.mjs'))
);
const { redact } = await import(
  pathToFileURL(path.resolve('benchmarks/coding-evaluation/adapters.mjs'))
);
const { namedArguments } = await import(
  pathToFileURL(path.resolve('benchmarks/swe-bench/ingest.mjs'))
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const optionalBytes = (file) =>
  readFile(file)
    .then((bytes) => (bytes.length ? bytes : null))
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
const args = namedArguments(process.argv.slice(2), ['batch'], ['apply']);
if (args.apply && !['true', 'false'].includes(args.apply)) throw Error('Invalid apply flag');
const root = await realpath(path.resolve(args.batch));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.resolved.json')));
if (!/^[A-Za-z0-9_-]{1,80}$/.test(manifest.batchId) || !Array.isArray(manifest.instances))
  throw Error('Invalid batch identity');
const implementationFiles = [
  'benchmarks/coding-evaluation/adapters.mjs',
  'benchmarks/coding-evaluation/metrics.mjs',
  'benchmarks/coding-evaluation/materialize.mjs',
  'benchmarks/swe-bench/ingest.mjs',
];
const implementations = [];
for (const name of implementationFiles) {
  const sha256 = sha(await readFile(path.resolve(name)));
  if (name.startsWith('benchmarks/coding-evaluation/')) {
    const expected = manifest.comparison.sharedModules.find(
      (item) => item.name === `../coding-evaluation/${path.basename(name)}`,
    );
    if (expected?.sha256 !== sha256)
      throw Error('Recovery shared implementation differs from generation record');
  }
  implementations.push({ name, sha256 });
}
const key = process.env.YUANTU_API_KEY;
if (!key) throw Error('Explicit credential required for diagnostic sanitization guard');
const inputBytes = await readFile(path.join(root, 'results.jsonl'));
const lines = inputBytes.toString('utf8').trim().split('\n').filter(Boolean);
const rows = lines.map(JSON.parse),
  receipts = [],
  replacements = new Map();
async function inside(relative) {
  const file = await realpath(path.resolve(root, relative));
  const r = path.relative(root, file);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw Error('Evidence path escapes batch');
  return file;
}
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  if (
    row.status !== 'invalid' ||
    row.failureClass !== 'host-or-environment' ||
    row.tokens?.inputTokens !== null
  )
    continue;
  if (!/^[\w.-]+__[\w.-]+-\d+$/.test(row.instanceId)) throw Error('Invalid instance id');
  const base = `evidence/${row.instanceId}`;
  try {
    if (
      row.configHash !== manifest.configHash ||
      row.runtime !== manifest.runtime.revision ||
      !manifest.instances.includes(row.instanceId)
    )
      throw Error('Original row and batch identity differ');
    const adapterBytes = await readFile(await inside(`${base}/adapter.json`));
    const adapter = JSON.parse(adapterBytes);
    if (adapter.patch?.sha256 !== row.patch?.sha256 || adapter.patch?.bytes !== row.patch?.bytes)
      throw Error('Adapter patch does not belong to original result');
    const patchBytes = await readFile(await inside(`${base}/patch.diff`));
    if (sha(patchBytes) !== row.patch.sha256 || patchBytes.length !== row.patch.bytes)
      throw Error('Saved patch differs from original result');
    const error = await readFile(await inside(`${base}/adapter-error.txt`), 'utf8');
    if (
      !/JSON/.test(error) ||
      !adapter.terminalSeen ||
      !adapter.cleanupConfirmed ||
      adapter.runs.length !== 1 ||
      adapter.sessionRecords.length
    )
      throw Error('Not a proven durable JSON redaction failure');
    const dbPath = await inside(`${base}/session.sqlite`),
      dbBytes = await readFile(dbPath),
      walBytes = await optionalBytes(`${dbPath}-wal`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let events, sessions;
    try {
      events = db
        .prepare('SELECT seq,session_id AS sessionId,type,data,at FROM session_events ORDER BY seq')
        .all()
        .map((r) => ({ ...r, data: JSON.parse(r.data) }));
      sessions = db.prepare('SELECT id,workspace,active_run,parent_session_id FROM sessions').all();
    } finally {
      db.close();
    }
    if (!dbBytes.equals(await readFile(dbPath)))
      throw Error('Evidence database changed while reading');
    if (!isDeepStrictEqual(walBytes, await optionalBytes(`${dbPath}-wal`)))
      throw Error('Evidence journal changed while reading');
    const sessionIds = [...new Set(events.map((e) => e.sessionId))];
    const finished = events.filter((e) => e.type === 'run.finished');
    if (
      sessionIds.length !== 1 ||
      finished.length !== 1 ||
      events.some((e) => e.type === 'subagent.finished')
    )
      throw Error('Ambiguous run lineage');
    const session = sessions[0];
    if (
      sessions.length !== 1 ||
      session.id !== sessionIds[0] ||
      session.active_run !== null ||
      session.parent_session_id !== null
    )
      throw Error('Session is not a closed root session');
    const workspace = String(session.workspace).replaceAll('\\', '/').replace(/\/+$/, '');
    if (
      (!workspace.startsWith('/') && !/^[A-Za-z]:\//.test(workspace)) ||
      workspace.split('/').some((part) => part === '..' || part === '.') ||
      !workspace.endsWith(`/${manifest.batchId}/work/${row.instanceId}`)
    )
      throw Error('SQLite workspace does not belong to this batch/instance');
    const run = adapter.runs[0],
      statistics = finished[0].data.statistics;
    if (
      finished[0].data.runId !== run.runId ||
      sessionIds[0] !== run.sessionId ||
      !isDeepStrictEqual(statistics, run.statistics)
    )
      throw Error('Durable and streamed terminal statistics differ');
    const failures = [];
    for (const event of events) {
      try {
        JSON.parse(redact(JSON.stringify(event), [key]));
      } catch {
        failures.push({ seq: event.seq, type: event.type });
      }
    }
    if (!failures.length) throw Error('Serialized JSON corruption was not reproduced');
    const durableSteps = events.filter((e) => e.type === 'step.finished').length;
    if (!Number.isSafeInteger(statistics.steps) || statistics.steps !== durableSteps)
      throw Error('Durable step count mismatch');
    const metrics = collectMetrics({
      events: adapter.events,
      runs: adapter.runs,
      sessionRecords: [{ sessionId: sessionIds[0], parentSessionId: null, statistics, events }],
      timing: adapter.timing,
    });
    for (const name of [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
    ])
      if (metrics.usage[name] !== statistics[name]) throw Error('Usage reconstruction mismatch');
    if (metrics.requests !== events.filter((e) => e.type === 'provider.request.finished').length)
      throw Error('Request reconstruction mismatch');
    if (row.requests !== null && row.requests !== metrics.requests)
      throw Error('Original and durable request counts differ');
    const recovered = {
      rounds: statistics.steps,
      tokens: metrics.usage,
      requests: metrics.requests,
    };
    receipts.push({
      instanceId: row.instanceId,
      originalRowSha256: sha(lines[i]),
      adapterSha256: sha(adapterBytes),
      databaseSha256: sha(dbBytes),
      databaseWalSha256: walBytes ? sha(walBytes) : null,
      workspaceBinding: {
        batchId: manifest.batchId,
        instanceId: row.instanceId,
        workspaceSha256: sha(workspace),
        rootSessionId: session.id,
      },
      patchSha256: sha(patchBytes),
      terminalEvent: { seq: finished[0].seq, sha256: sha(JSON.stringify(finished[0])) },
      serializationFailures: failures,
      originalMetrics: { rounds: row.rounds, tokens: row.tokens, requests: row.requests },
      recoveredMetrics: recovered,
      generationStatusPreserved: row.status,
      failureClassPreserved: row.failureClass,
    });
    replacements.set(row.instanceId, recovered);
  } catch (error) {
    receipts.push({
      instanceId: row.instanceId,
      recovered: false,
      reason: String(error.message).replaceAll(key, '[REDACTED]'),
    });
  }
}
const receipt = {
  version: 1,
  algorithmSha256: sha(await readFile(new URL(import.meta.url))),
  implementations,
  node: process.version,
  inputResultsSha256: sha(inputBytes),
  source: 'immutable closed SQLite and matching streamed terminal statistics; no model rerun',
  receipts,
};
const receiptText = JSON.stringify(receipt, null, 2) + '\n';
if (receiptText.includes(key)) throw Error('Credential detected in recovery receipt');
if (args.apply === 'true') {
  const evaluatedFile = await inside('results.evaluated.jsonl');
  const evaluated = (await readFile(evaluatedFile, 'utf8')).trim().split('\n').map(JSON.parse);
  if (
    evaluated.length !== rows.length ||
    new Set(evaluated.map((r) => r.instanceId)).size !== rows.length
  )
    throw Error('Evaluated instance set mismatch');
  const output =
    evaluated
      .map((row) => {
        const original = rows.find((r) => r.instanceId === row.instanceId);
        if (
          !original ||
          !row.evaluation ||
          row.configHash !== original.configHash ||
          row.runtimeHash !== original.runtimeHash ||
          row.status !== original.status ||
          row.failureClass !== original.failureClass ||
          row.patch.sha256 !== original.patch.sha256
        )
          throw Error('Evaluated source mismatch');
        const recovered = replacements.get(row.instanceId);
        if (row.metricsRecovery && !recovered)
          throw Error('Existing recovery cannot be re-verified');
        return recovered
          ? {
              ...row,
              ...recovered,
              metricsRecovery: {
                receipt: `metrics-recovery/${sha(receiptText)}.json`,
                receiptSha256: sha(receiptText),
                originalRowSha256: receipts.find((r) => r.instanceId === row.instanceId)
                  .originalRowSha256,
              },
            }
          : row;
      })
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n';
  if (output.includes(key)) throw Error('Credential detected in recovered output');
  const receiptDirectory = path.join(root, 'metrics-recovery');
  await mkdir(receiptDirectory, { recursive: true });
  const boundedReceiptDirectory = await inside('metrics-recovery');
  const immutableReceipt = path.join(boundedReceiptDirectory, `${sha(receiptText)}.json`);
  try {
    await writeFile(immutableReceipt, receiptText, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST' || (await readFile(immutableReceipt, 'utf8')) !== receiptText)
      throw error;
  }
  const next = path.join(root, 'results.evaluated.recovery.tmp');
  await writeFile(next, output);
  await rename(next, evaluatedFile);
}
await writeFile(path.join(root, 'metrics-recovery.json'), receiptText);
console.log(
  JSON.stringify({
    inspected: rows.length,
    recovered: replacements.size,
    applied: args.apply === 'true',
    receipts,
  }),
);
