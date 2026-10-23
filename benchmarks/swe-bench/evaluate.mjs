import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { newDirectory, hash } from '../coding-evaluation/materialize.mjs';
import { readDataset, recordHash } from './select-subset.mjs';
import { namedArguments } from './ingest.mjs';

const exec = promisify(execFile);
export function evaluationArguments({ dataset, predictions, runId, instanceId, reportDirectory }) {
  return [
    'eval',
    dataset,
    '-p',
    predictions,
    '--run-id',
    runId,
    '-i',
    instanceId,
    '-j',
    '1',
    '--report-dir',
    reportDirectory,
  ];
}
export function validateEvaluationInputs(predictions, dataset, subset) {
  if (
    !predictions.length ||
    predictions.length > 50 ||
    !/^[a-f0-9]{40}$/.test(subset.revision ?? '') ||
    new Set(predictions.map((p) => p.instance_id)).size !== predictions.length ||
    new Set(dataset.map((r) => r.instance_id)).size !== dataset.length
  )
    throw new Error('Invalid or duplicate evaluation instances');
  if (new Set(predictions.map((p) => p.model_name_or_path)).size !== 1)
    throw new Error('A prediction file must have one model/runtime identity');
  return predictions.map((pred) => {
    if (typeof pred.model_patch !== 'string') throw new Error('Prediction patch must be a string');
    if (
      !/^[\w.-]+__[\w.-]+-\d+$/.test(pred.instance_id ?? '') ||
      typeof pred.model_name_or_path !== 'string' ||
      !pred.model_name_or_path.length ||
      pred.model_name_or_path.length > 200 ||
      /[\\\x00-\x1f]/.test(pred.model_name_or_path)
    )
      throw new Error('Invalid prediction identity');
    const record = dataset.find((r) => r.instance_id === pred.instance_id),
      item = subset.instances.find((r) => r.instance_id === pred.instance_id);
    if (!record || !item || item.sha256 !== recordHash(record))
      throw new Error('Frozen evaluation record hash mismatch');
    return record;
  });
}
export async function evaluatePredictions({
  predictionsPath,
  datasetPath,
  subsetPath,
  runId,
  outputDirectory,
}) {
  if (
    process.platform !== 'linux' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    throw new Error(
      'Official Docker evaluation is restricted to a disposable GitHub-hosted Linux runner',
    );
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid run id');
  const predictions = path.resolve(predictionsPath),
    dataset = path.resolve(datasetPath),
    out = path.resolve(outputDirectory);
  const subsetBytes = await readFile(subsetPath),
    subset = JSON.parse(subsetBytes),
    predictionBytes = await readFile(predictions);
  const preds = await readDataset(predictions),
    records = validateEvaluationInputs(preds, await readDataset(dataset), subset);
  const ids = records.map((r) => r.instance_id).sort();
  await newDirectory(out);
  const env = {};
  for (const key of [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'VIRTUAL_ENV',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'DOCKER_HOST',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.PYTHONUNBUFFERED = '1';
  const help = await exec('swebench', ['eval', '--help'], { env, maxBuffer: 4_000_000 });
  await writeFile(path.join(out, 'evaluator-help.txt'), help.stdout);
  await writeFile(
    path.join(out, 'evaluation-source.json'),
    JSON.stringify(
      {
        evaluatorVersion: '5.0.2',
        predictionsSha256: hash(predictionBytes),
        subsetHash: hash(subsetBytes),
        datasetRevision: subset.revision,
        instanceIds: ids,
        runId,
        workers: 1,
        command:
          'swebench eval <pinned local dataset> -p <predictions> --run-id <id> -i <instance> -j 1 --report-dir <part>',
        helpSha256: hash(help.stdout),
      },
      null,
      2,
    ) + '\n',
  );
  const merged = {
    resolved_ids: [],
    unresolved_ids: [],
    error_ids: [],
    empty_patch_ids: [],
    submitted_ids: ids,
    failure_reasons: {},
    official_summaries: [],
  };
  const controller = new AbortController(),
    abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    for (const id of ids) {
      const part = path.join(out, 'parts', id);
      await mkdir(part, { recursive: true });
      let exitCode = 0,
        stdout = '',
        stderr = '',
        official = null,
        officialFile;
      if (!controller.signal.aborted) {
        console.log(`Evaluating ${id} (serial, official swebench 5.0.2)`);
        try {
          ({ stdout, stderr } = await exec(
            'swebench',
            evaluationArguments({
              dataset,
              predictions,
              runId,
              instanceId: id,
              reportDirectory: part,
            }),
            { cwd: out, env, signal: controller.signal, maxBuffer: 64_000_000 },
          ));
        } catch (error) {
          exitCode = typeof error.code === 'number' ? error.code : 2;
          stdout = error.stdout ?? '';
          stderr = error.stderr ?? String(error);
        }
      } else {
        exitCode = 2;
        stderr = 'Evaluation cancelled before this instance';
      }
      await writeFile(path.join(part, 'cli.log'), stdout + '\n' + stderr);
      const summaries = (await readdir(part)).filter((name) => name.endsWith('.json'));
      if (summaries.length === 1) {
        officialFile = path.join(part, summaries[0]);
        const bytes = await readFile(officialFile);
        official = JSON.parse(bytes);
        merged.official_summaries.push({
          instanceId: id,
          path: path.relative(out, officialFile).split(path.sep).join('/'),
          sha256: hash(bytes),
          exitCode,
        });
      }
      const categories = ['resolved_ids', 'unresolved_ids', 'empty_patch_ids', 'error_ids'];
      const category = categories.find((key) => official?.[key]?.includes(id)) ?? 'error_ids';
      merged[category].push(id);
      if (official?.failure_reasons?.[id])
        merged.failure_reasons[id] = official.failure_reasons[id];
      else if (category === 'error_ids')
        merged.failure_reasons[id] =
          `No valid official verdict; harness exit ${exitCode}; see parts/${id}/cli.log`;
      // Version 5.0.2 has no cache_level/clean flags. This runner belongs only to this manual job.
      // Reclaim unused images between instances rather than depending on removed CLI options.
      if (!controller.signal.aborted)
        for (const args of [
          ['container', 'prune', '--force'],
          ['image', 'prune', '--all', '--force'],
        ]) {
          try {
            await exec('docker', args, { env, maxBuffer: 8_000_000 });
          } catch (error) {
            await writeFile(path.join(part, 'cleanup-error.txt'), String(error.message));
          }
        }
      await writeFile(path.join(out, 'results.json'), JSON.stringify(merged, null, 2) + '\n');
    }
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
  return merged;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = namedArguments(process.argv.slice(2), [
      'predictions',
      'dataset',
      'subset',
      'run-id',
      'out',
    ]);
    const result = await evaluatePredictions({
      predictionsPath: args.predictions,
      datasetPath: args.dataset,
      subsetPath: args.subset,
      runId: args['run-id'],
      outputDirectory: args.out,
    });
    console.log(
      JSON.stringify({
        resolved: result.resolved_ids.length,
        unresolved: result.unresolved_ids.length,
        errors: result.error_ids.length,
        empty: result.empty_patch_ids.length,
      }),
    );
    if (result.error_ids.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
