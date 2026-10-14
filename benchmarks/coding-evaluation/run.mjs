import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { validateManifest, requireLiveAuthorization } from './schema.ts';
import { freezeInputs, materializeCase, hash, newDirectory, assertFrozen } from './materialize.mjs';
import { getCase, casePreparationBlock, prepareCase } from './cases.mjs';
import { selfCheckCorpus, oracleFingerprint, verifyCase } from './verify.mjs';
import { preparePrivateDependencies } from './dependencies.mjs';
import { aggregateResults, gradeSample } from './metrics.mjs';
import { runHostSample, redact } from './adapters.mjs';
import { writeReport } from './report.mjs';
import { fakeEndpointSelfCheck } from './live-self-check.mjs';

export function parseArguments(args) {
  const options = { live: false, dryRun: true };
  const seen = new Set();
  for (const arg of args) {
    const [flag, ...parts] = arg.split('=');
    const key = flag.slice(2);
    if (
      !['manifest', 'out', 'batch-id', 'dry-run', 'live', 'cases', 'repeats'].includes(key) ||
      !arg.startsWith('--')
    )
      throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(key)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(key);
    if (['live', 'dry-run'].includes(key)) {
      if (parts.length) throw new Error('Mode flags have no values');
      options[key === 'live' ? 'live' : 'dryRun'] = true;
    } else {
      const value = parts.join('=');
      if (!value) throw new Error(`Value required: ${flag}`);
      if (key === 'batch-id') options.batchId = value;
      else if (key === 'cases') options.cases = value.split(',');
      else if (key === 'repeats') {
        if (!/^[13]$/.test(value)) throw new Error('repeats must be 1 or 3');
        options.repeats = Number(value);
      } else options[key] = value;
    }
  }
  if (seen.has('live') && seen.has('dry-run'))
    throw new Error('live/dry-run are mutually exclusive');
  if (options.live) options.dryRun = false;
  return options;
}
export function resolveManifest(value, options) {
  const original = validateManifest(value);
  const manifest = validateManifest({
    ...original,
    ...(options.batchId ? { batchId: options.batchId } : {}),
    ...(options.cases ? { cases: options.cases } : {}),
    ...(options.repeats ? { repeats: options.repeats } : {}),
    maxLiveAttempts: Math.min(
      original.maxLiveAttempts,
      (options.cases ?? original.cases).length * (options.repeats ?? original.repeats),
    ),
  });
  if (manifest.cases.some((id) => !original.cases.includes(id)))
    throw new Error('Overrides cannot expand authorized cases');
  return manifest;
}
export function plannedSamples(manifest) {
  return [...manifest.cases].sort().flatMap((caseId) =>
    Array.from({ length: manifest.repeats }, (_, index) => ({
      caseId,
      repeat: index + 1,
      variantId: 'v1',
      sampleId: `${caseId}-v1-${index + 1}`,
    })),
  );
}
function blockedSample(
  sample,
  manifest,
  frozen,
  fingerprint,
  configHash,
  evidenceDirectory,
  reason,
) {
  const caseDef = getCase(sample.caseId);
  return {
    version: 1,
    ...sample,
    batchId: manifest.batchId,
    category: caseDef.category,
    live: false,
    runtimeHash: frozen.runtimeHash,
    corpusHash: frozen.corpusHash,
    promptHash: hash(caseDef.prompt),
    oracleHash: fingerprint.hash,
    configHash,
    outcome: 'blocked',
    agentStatus: null,
    runIds: [],
    sessionIds: [],
    checks: [],
    independentPass: false,
    unassistedPass: false,
    humanInterventions: [],
    wallMs: 0,
    setupMs: 0,
    verificationMs: 0,
    cleanupMs: 0,
    firstVisibleTextMs: null,
    requests: null,
    summaryRequests: null,
    toolCalls: 0,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      complete: false,
    },
    cost: { amount: null, currency: null, source: null },
    cleanupConfirmed: true,
    failureClass: reason,
    evidenceDirectory,
  };
}
export async function executeBatch(value, options = { live: false, dryRun: true }) {
  const manifest = validateManifest(value);
  if (options.live && options.dryRun) throw new Error('live/dry-run mutually exclusive');
  if (options.live) requireLiveAuthorization(manifest); // before directories, credentials or providers
  options.signal?.throwIfAborted();
  const out = path.resolve(
    options.outputDirectory ?? path.join('.scratch', 'coding-evaluation', manifest.batchId),
  );
  await newDirectory(out);
  const planned = plannedSamples(manifest);
  const input = { ...manifest, endpointUrl: null };
  const configHash = hash(manifest);
  await writeFile(
    path.join(out, 'manifest.resolved.json'),
    JSON.stringify({ ...input, planned, configHash }, null, 2),
    { flag: 'wx' },
  );
  const fingerprint = await oracleFingerprint();
  const frozenInputs = await freezeInputs({
    runtimeSource: manifest.runtimeSource,
    corpusSource: manifest.corpusSource,
    outputDirectory: path.join(out, 'frozen'),
  });
  /**
   * One private, lockfile-bound installation, shared by every workspace in this batch.
   *
   * It lives *outside* both frozen trees on purpose. Putting it inside `frozen/corpus` would make the corpus
   * manifest cover `node_modules`, and `materializeCase` would then copy a fresh ~600MB installation into every
   * single sample —which is how the first acceptance run filled the volume. Keeping it beside them keeps the
   * corpus exactly what the plan says it is (the case source) while still giving the sample its own receipt-bound
   * installation, taken from a locked installation this machine already has: no install, no network, no ambiguity
   * about which tree supplied a module.
   */
  const dependenciesDirectory = path.join(out, 'dependencies');
  await mkdir(dependenciesDirectory, { recursive: true });
  for (const file of ['package.json', 'package-lock.json'])
    await writeFile(
      path.join(dependenciesDirectory, file),
      await readFile(path.join(frozenInputs.runtimeDirectory, file)),
      { flag: 'wx' },
    );
  const dependenciesReceipt = await preparePrivateDependencies({
    targetDirectory: dependenciesDirectory,
    sourceDirectory: path.resolve(
      options.dependencySourceDirectory ?? manifest.runtimeSource.directory,
    ),
  });
  const frozen = {
    ...frozenInputs,
    dependenciesDirectory,
    dependenciesReceipt,
  };
  /**
   * The frozen runtime shares that installation through hard links, so the Host resolves its own imports inside
   * the frozen tree and a tool that reads a package cannot reach the machine's copy. The corpus keeps none: a task
   * workspace gets its installation from `dependenciesDirectory` when it is created.
   */
  for (const directory of [frozen.runtimeDirectory])
    await preparePrivateDependencies({
      targetDirectory: directory,
      sourceDirectory: dependenciesDirectory,
      verifyContent: false,
    });
  const controls = await selfCheckCorpus(frozen, path.join(out, 'controls'), {
    signal: options.signal,
  });
  let inputIntegrityIssue =
    (await oracleFingerprint()).hash !== fingerprint.hash
      ? 'oracle-fingerprint-changed-during-batch'
      : null;
  /**
   * A live batch has to earn its provider first.
   *
   * `runHostSample` refuses a live sample without a receipt for this frozen runtime, and that refusal is the plan's
   * task 3 read literally: the same adapter path is driven end to end against a loopback fixture *before* any real
   * request exists. A failed self-check stops the batch here rather than spending the authorized budget on samples
   * whose plumbing is already known to be broken.
   */
  const offlineReceipt =
    options.live && !options.signal?.aborted && !inputIntegrityIssue
      ? await fakeEndpointSelfCheck({
          frozen,
          manifest,
          directory: path.join(out, 'self-check'),
          signal: options.signal,
        })
      : undefined;
  if (
    options.live &&
    !options.signal?.aborted &&
    !inputIntegrityIssue &&
    !offlineReceipt.checksPassed
  )
    throw new Error(
      `Fake-endpoint self-check failed; no live sample was attempted: ${offlineReceipt.error ?? JSON.stringify(offlineReceipt.observed)}`,
    );
  const results = [];
  let attempts = 0,
    haltReason = options.signal?.aborted ? 'external-cancelled-before-sample' : inputIntegrityIssue;
  for (const sample of planned) {
    const evidenceDirectory = path.join(out, 'evidence', sample.sampleId);
    await mkdir(evidenceDirectory, { recursive: true });
    const caseDef = getCase(sample.caseId);
    const control = controls.find((item) => item.caseId === sample.caseId);
    let reason =
      (options.signal?.aborted ? 'external-cancelled-before-sample' : haltReason) ??
      (await casePreparationBlock(caseDef, frozen));
    reason ??= control?.status === 'blocked' ? control.reason : null;
    reason ??= options.live
      ? control?.status !== 'full-controls-certified'
        ? `case controls are not certified (${control?.status ?? 'missing'})`
        : null
      : 'offline-not-executed';
    let result;
    if (reason)
      result = blockedSample(
        sample,
        manifest,
        frozen,
        fingerprint,
        configHash,
        evidenceDirectory,
        reason,
      );
    else {
      if (attempts >= Math.min(manifest.maxLiveAttempts, manifest.approvedLiveBudget.maxAttempts))
        result = blockedSample(
          sample,
          manifest,
          frozen,
          fingerprint,
          configHash,
          evidenceDirectory,
          'authorized-attempt-budget-exhausted',
        );
      else {
        try {
          const workspace = await materializeCase({
            frozen,
            caseId: sample.caseId,
            sampleId: sample.sampleId,
            outputDirectory: path.join(out, 'work', sample.sampleId),
          });
          const prepared = await prepareCase(caseDef, workspace);
          /**
           * The task copy gets its own private installation: the model's public checks and the grader's frozen old
           * regressions both have to run against dependencies the sample owns, never against the tree above it.
           *
           * It is *linked* rather than byte-copied. A copy of the full installation is ~600MB per sample, and 30
           * samples of that filled the workspace volume during the first acceptance run —a harness that cannot
           * complete a batch is worse than one that shares inodes. Linking is safe in the direction that matters
           * here: the receipt binds the content, the frozen installation is what it is checked against, and a write
           * through the linked name either lands in memory of a tool that only reads, or replaces the file rather
           * than mutating the shared inode.
           */
          if (caseDef.publicCheck.length)
            await preparePrivateDependencies({
              targetDirectory: workspace.directory,
              sourceDirectory: frozen.dependenciesDirectory,
              verifyContent: false,
            });
          options.signal?.throwIfAborted();
          attempts++;
          const adapter = await runHostSample(
            { manifest, prepared, frozen, caseDef, evidenceDirectory, offlineReceipt },
            options.signal ?? new AbortController().signal,
          );
          const verification = await verifyCase({
            caseDef,
            workspace,
            frozen,
            evidenceDirectory,
            timeoutMs: manifest.verificationTimeoutMs,
            scenarioEvidence: adapter.scenario,
          });
          result = gradeSample({
            sample,
            manifest,
            frozen,
            prepared,
            oracleHash: fingerprint.hash,
            configHash,
            adapter,
            verification,
            humanInterventions: [],
            live: true,
            evidenceDirectory,
          });
          if (!adapter.cleanupConfirmed || verification.tampered)
            haltReason = 'batch-stopped-unsafe-cleanup-or-tamper';
        } catch (error) {
          result = blockedSample(
            sample,
            manifest,
            frozen,
            fingerprint,
            configHash,
            evidenceDirectory,
            redact(error.message),
          );
          haltReason = options.signal?.aborted
            ? 'external-cancelled-before-sample'
            : 'batch-stopped-preparation-or-adapter-error';
        }
      }
    }
    result.live = options.live === true;
    results.push(result);
    await writeFile(path.join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2), {
      flag: 'wx',
    });
    await appendFile(path.join(out, 'results.jsonl'), JSON.stringify(result) + '\n');
  }
  await assertFrozen(frozen);
  inputIntegrityIssue ??=
    (await oracleFingerprint()).hash !== fingerprint.hash
      ? 'oracle-fingerprint-changed-during-batch'
      : null;
  const summary = aggregateResults(results, planned);
  await writeReport({
    input: path.join(out, 'results.jsonl'),
    manifest: path.join(out, 'manifest.resolved.json'),
    outputDirectory: out,
  });
  const blockedControls = controls.some((control) => control.status === 'blocked');
  const exitCode = !options.live
    ? blockedControls || inputIntegrityIssue
      ? 2
      : 0
    : !summary.complete || inputIntegrityIssue
      ? 2
      : summary.outcomes.passed === planned.length
        ? 0
        : 1;
  await writeFile(
    path.join(out, 'batch.json'),
    JSON.stringify(
      {
        version: 1,
        live: options.live === true,
        requests: options.live ? null : 0,
        attempts,
        externallyCancelled: options.signal?.aborted === true,
        inputIntegrityIssue,
        plannedCount: planned.length,
        controlStatus: controls.map(({ caseId, status, reason }) => ({ caseId, status, reason })),
        exitCode,
        frozen,
        oracleHash: fingerprint.hash,
      },
      null,
      2,
    ),
  );
  return { planned, results, summary, evidenceDirectory: out, exitCode };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('External batch cancellation'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.manifest || !options.out || !options.batchId)
      throw new Error('--manifest, --out and --batch-id required');
    const manifest = resolveManifest(
      JSON.parse(await readFile(path.resolve(options.manifest), 'utf8')),
      options,
    );
    const result = await executeBatch(manifest, {
      ...options,
      outputDirectory: path.resolve(options.out),
      signal: cancellation.signal,
    });
    console.log(
      JSON.stringify({
        live: options.live,
        plannedCount: result.planned.length,
        recordedCount: result.results.length,
        complete: result.summary.complete,
        evidenceDirectory: result.evidenceDirectory,
        exitCode: result.exitCode,
      }),
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(redact(error.message, [process.env.YUANTU_API_KEY]));
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
