import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises';
import { validateSweManifest, requireSweLiveAuthorization } from './schema.ts';
import { freezeSource, hash, newDirectory } from '../coding-evaluation/materialize.mjs';
import { copyLockedDependencies } from '../coding-evaluation/dependencies.mjs';
import { redact } from '../coding-evaluation/adapters.mjs';
import { readDataset, recordHash, DATASET } from './select-subset.mjs';
import { materializeRepo } from './repos.mjs';
import { runSweSample, assertSweRuntime, stringifyEvidence } from './adapter.mjs';
import { PROMPT_TEMPLATE } from './prompt.mjs';
import { prediction, writePredictions, safeModelPatch } from './predictions.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export function parseArguments(args) {
  const values = {},
    seen = new Set();
  for (const arg of args) {
    const match = /^--(manifest|out|batch-id|dry-run|live|instances|runtime)(?:=(.*))?$/.exec(arg);
    if (!match || seen.has(match[1])) throw new Error('Unknown or duplicate argument');
    const [, key, value] = match;
    seen.add(key);
    if (['dry-run', 'live'].includes(key)) {
      if (value !== undefined) throw new Error('Mode flags take no value');
      values[key] = true;
    } else {
      if (!value) throw new Error('Argument value required');
      values[key] = value;
    }
  }
  if (!values.manifest || !values.out || !values['batch-id'] || (values.live && values['dry-run']))
    throw new Error('Required arguments or mutually exclusive mode flags');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(values['batch-id'])) throw new Error('Invalid batch id');
  if (values.runtime && !/^[a-f0-9]{40}$/.test(values.runtime))
    throw new Error('Runtime must be a full commit SHA');
  const instances = values.instances?.split(',');
  if (
    instances &&
    (new Set(instances).size !== instances.length ||
      instances.some((id) => id !== 'smoke' && !/^[\w.-]+__[\w.-]+-\d+$/.test(id)) ||
      (instances.includes('smoke') && instances.length !== 1))
  )
    throw new Error('Invalid instances');
  return {
    manifest: values.manifest,
    out: values.out,
    batchId: values['batch-id'],
    live: values.live === true,
    dryRun: values.live !== true,
    instances,
    runtime: values.runtime,
  };
}
export async function comparisonConfig(manifest, instanceIds, subset) {
  const harnessFiles = [
    'schema.ts',
    'prompt.mjs',
    'adapter.mjs',
    'run.mjs',
    'repos.mjs',
    'predictions.mjs',
    'select-subset.mjs',
  ];
  const harnessHash = hash(
    await Promise.all(
      harnessFiles.map(async (name) => ({
        name,
        sha256: hash(await readFile(new URL(name, import.meta.url))),
      })),
    ),
  );
  const sharedModules = await Promise.all(
    ['adapters.mjs', 'dependencies.mjs', 'metrics.mjs', 'materialize.mjs'].map(async (file) => {
      const name = `../coding-evaluation/${file}`;
      return { name, sha256: hash(await readFile(new URL(name, import.meta.url))) };
    }),
  );
  const {
    batchId: _batch,
    runtime: _runtime,
    subset: _subset,
    datasetPath: _data,
    instances: _ids,
    endpointUrl,
    approvedLiveBudget: _budget,
    ...settings
  } = manifest;
  return {
    ...settings,
    endpointHash: hash(endpointUrl),
    subsetHash: manifest.subset.sha256,
    datasetRevision: subset.revision,
    instances: [...instanceIds].sort(),
    promptTemplateHash: hash(PROMPT_TEMPLATE),
    sessionTitles: false,
    harnessHash,
    sharedModules,
    runtimeEnvironment: { node: process.version, platform: process.platform, arch: process.arch },
    dependenciesHash: null,
  };
}
export async function executeBatch(value, options = {}) {
  const manifest = validateSweManifest(value);
  if (options.live && options.dryRun) throw new Error('live/dry-run are mutually exclusive');
  const live = options.live === true;
  const out = path.resolve(options.out);
  try {
    await access(out);
    throw new Error('Output directory already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const subsetBytes = await readFile(path.resolve(manifest.subset.path));
  if (hash(subsetBytes) !== manifest.subset.sha256) throw new Error('Subset hash mismatch');
  const subset = JSON.parse(subsetBytes);
  if (
    subset.dataset !== DATASET ||
    subset.split !== 'test' ||
    !/^[a-f0-9]{40}$/.test(subset.revision) ||
    !Array.isArray(subset.instances) ||
    new Set(subset.instances.map((item) => item.instance_id)).size !== subset.instances.length
  )
    throw new Error('Invalid frozen subset');
  const originalIds = manifest.instances ?? subset.instances.map((item) => item.instance_id);
  const requested =
    options.instances?.[0] === 'smoke' ? subset.smoke : (options.instances ?? originalIds);
  if (
    !Array.isArray(requested) ||
    !requested.length ||
    new Set(requested).size !== requested.length ||
    requested.some((id) => !originalIds.includes(id))
  )
    throw new Error('Instances may only narrow the authorized selection');
  const ids = [...requested].sort();
  if (live) {
    requireSweLiveAuthorization(manifest, ids.length);
    if (!process.env.YUANTU_API_KEY) throw new Error('Explicit YUANTU_API_KEY required');
  }
  const dataset = await readDataset(path.resolve(manifest.datasetPath));
  if (new Set(dataset.map((r) => r.instance_id)).size !== dataset.length)
    throw new Error('Duplicate dataset instance');
  const records = ids.map((id) => {
    const item = subset.instances.find((r) => r.instance_id === id),
      record = dataset.find((r) => r.instance_id === id);
    if (
      !item ||
      !record ||
      item.repo !== record.repo ||
      item.difficulty !== record.difficulty ||
      item.sha256 !== recordHash(record)
    )
      throw new Error('Frozen record hash mismatch');
    return record;
  });
  const comparison = await comparisonConfig(manifest, ids, subset);
  let configHash = hash(comparison);
  await newDirectory(out);
  const key = process.env.YUANTU_API_KEY;
  const save = (name, data) =>
    writeFile(path.join(out, name), stringifyEvidence(data, [key], 2), { flag: 'wx' });
  const batch = {
    version: 1,
    batchId: manifest.batchId,
    live,
    requests: 0,
    attempts: 0,
    planned: ids.length,
    subsetHash: manifest.subset.sha256,
    configHash,
    runtimeRevision: manifest.runtime.revision,
    runtimeHash: null,
    exitCode: 0,
  };
  const predictions = [];
  await writeFile(path.join(out, 'results.jsonl'), '', { flag: 'wx' });
  let frozen;
  try {
    const sourceDirectory = path.resolve(options.sourceDirectory ?? projectRoot);
    await mkdir(path.join(out, 'frozen'));
    const runtimeDirectory = path.join(out, 'frozen/runtime');
    const runtime = await freezeSource(
      { ...manifest.runtime, directory: sourceDirectory },
      runtimeDirectory,
    );
    frozen = { runtimeDirectory, runtimeHash: runtime.hash, runtimeFiles: runtime.files };
    await copyLockedDependencies({ sourceDirectory, targetDirectory: runtimeDirectory });
    const dependencies = JSON.parse(
      await readFile(path.join(runtimeDirectory, '.evaluation-dependencies.json'), 'utf8'),
    );
    comparison.dependenciesHash = dependencies.filesHash;
    configHash = hash(comparison);
    batch.configHash = configHash;
    await save('frozen/inputs.json', { ...frozen, revision: manifest.runtime.revision });
    batch.runtimeHash = runtime.hash;
  } catch (error) {
    batch.exitCode = 2;
    await save('preparation-error.json', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await save('manifest.resolved.json', {
    ...manifest,
    endpointUrl: null,
    instances: ids,
    comparison,
    configHash,
  });
  await mkdir(path.join(out, 'work'));
  await mkdir(path.join(out, 'evidence'));
  // Serial by construction. Every planned instance receives one final record, including preparation failures.
  for (const record of records) {
    const result = {
      version: 1,
      instanceId: record.instance_id,
      runtime: manifest.runtime.revision,
      runtimeHash: batch.runtimeHash,
      configHash,
      live: false,
      status: 'blocked',
      failureClass: 'offline-not-executed',
      rounds: 0,
      tokens: { inputTokens: null, outputTokens: null, cachedInputTokens: null, complete: false },
      durationMs: 0,
      requests: 0,
      patch: { files: 0, bytes: 0, changedTests: false },
    };
    let modelPatch = '';
    try {
      if (!frozen) throw new Error('runtime-preparation');
      if (options.signal?.aborted) throw new Error('batch-cancelled');
      await assertSweRuntime(frozen);
      const directory = path.join(out, 'work', record.instance_id),
        evidenceDirectory = path.join(out, 'evidence', record.instance_id);
      await materializeRepo({
        record,
        cacheDirectory:
          options.cacheDirectory ?? path.join(projectRoot, '.scratch/swe-bench/repos'),
        directory,
        source: options.repoSource,
      });
      if (live) {
        result.live = true;
        batch.attempts++;
        const adapter = await runSweSample(
          { manifest, frozen, record, directory, evidenceDirectory },
          options.signal,
        );
        modelPatch = adapter.patch.patch;
        Object.assign(result, {
          status:
            adapter.failureClass || !adapter.cleanupConfirmed || !adapter.terminalSeen
              ? 'invalid'
              : modelPatch
                ? 'generated'
                : 'failed',
          failureClass: adapter.failureClass ?? adapter.patch.failureClass,
          requests: adapter.metrics.requests ?? 0,
          rounds: adapter.rounds,
          tokens: adapter.metrics.usage,
          durationMs: adapter.timing.wallMs,
          patch: { ...adapter.patch, patch: undefined },
          cleanupConfirmed: adapter.cleanupConfirmed,
          timedOut: adapter.timedOut,
        });
        batch.requests += result.requests;
        if (result.status === 'invalid') batch.exitCode = 2;
      }
      await assertSweRuntime(frozen);
    } catch (error) {
      result.failureClass = error instanceof Error ? error.message : String(error);
      result.status = 'invalid';
      batch.exitCode = 2;
    }
    const serialized = stringifyEvidence(result, [key]);
    await appendFile(path.join(out, 'results.jsonl'), serialized + '\n');
    predictions.push(
      prediction(
        record.instance_id,
        manifest.runtime.revision,
        manifest.model,
        safeModelPatch(modelPatch, [key]),
      ),
    );
  }
  await writePredictions(path.join(out, 'predictions.jsonl'), predictions);
  await save('batch.json', batch);
  return batch;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const value = JSON.parse(await readFile(path.resolve(options.manifest), 'utf8'));
    const manifest = {
      ...value,
      batchId: options.batchId,
      ...(options.runtime ? { runtime: { kind: 'commit', revision: options.runtime } } : {}),
    };
    const controller = new AbortController(),
      cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      const batch = await executeBatch(manifest, { ...options, signal: controller.signal });
      console.log(JSON.stringify(batch));
      process.exitCode = batch.exitCode;
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  } catch (error) {
    console.error(
      redact(error instanceof Error ? error.message : String(error), [process.env.YUANTU_API_KEY]),
    );
    process.exitCode = 2;
  }
}
