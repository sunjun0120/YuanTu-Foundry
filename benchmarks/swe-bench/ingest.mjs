import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { hash } from '../coding-evaluation/materialize.mjs';
import { readDataset } from './select-subset.mjs';

export function namedArguments(args, required, optional = []) {
  const result = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || ![...required, ...optional].includes(match[1]) || Object.hasOwn(result, match[1]))
      throw new Error('Unknown, duplicate or missing argument');
    result[match[1]] = match[2];
  }
  if (required.some((key) => !result[key])) throw new Error('Required argument missing');
  return result;
}
export async function ingestBatch({ batchDirectory, evaluationDirectory }) {
  const batch = path.resolve(batchDirectory),
    evaluation = await realpath(path.resolve(evaluationDirectory));
  const evidenceFile = async (relative) => {
    if (typeof relative !== 'string') throw new Error('Invalid official evidence path');
    const file = await realpath(path.resolve(evaluation, relative));
    const target = path.relative(evaluation, file);
    if (!target || target.startsWith('..') || path.isAbsolute(target))
      throw new Error('Official evidence path escapes evaluation');
    return file;
  };
  const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const manifest = await json(path.join(batch, 'manifest.resolved.json'));
  const source = await json(path.join(evaluation, 'evaluation-source.json'));
  const predictionsBytes = await readFile(path.join(batch, 'predictions.jsonl'));
  const predictions = predictionsBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const ids = manifest.instances;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(source.runId ?? '')
  )
    throw new Error('Invalid evaluation identity');
  if (
    source.predictionsSha256 !== hash(predictionsBytes) ||
    source.subsetHash !== manifest.subset.sha256 ||
    source.datasetRevision !== manifest.comparison.datasetRevision ||
    source.evaluatorVersion !== '5.0.2' ||
    JSON.stringify([...source.instanceIds].sort()) !== JSON.stringify([...ids].sort()) ||
    new Set(predictions.map((r) => r.instance_id)).size !== ids.length ||
    predictions.length !== ids.length ||
    predictions.some((r) => !ids.includes(r.instance_id))
  )
    throw new Error('Evaluation provenance or predictions mismatch');
  const summaryFile = path.join(evaluation, 'results.json'),
    summaryBytes = await readFile(summaryFile),
    summary = JSON.parse(summaryBytes);
  const categories = ['resolved_ids', 'unresolved_ids', 'error_ids', 'empty_patch_ids'];
  const states = new Map();
  for (const category of categories) {
    if (!Array.isArray(summary[category])) throw new Error('Official result ID arrays required');
    for (const id of summary[category]) {
      if (!ids.includes(id) || states.has(id))
        throw new Error('Conflicting official instance classifications');
      states.set(id, category);
    }
  }
  if (!Array.isArray(summary.official_summaries))
    throw new Error('Original official summary receipts required');
  const originals = new Map();
  for (const receipt of summary.official_summaries) {
    if (!ids.includes(receipt.instanceId) || originals.has(receipt.instanceId))
      throw new Error('Conflicting original summary instance');
    const bytes = await readFile(await evidenceFile(receipt.path));
    if (hash(bytes) !== receipt.sha256) throw new Error('Original official summary hash mismatch');
    const original = JSON.parse(bytes);
    const classifications = categories.filter(
      (key) => Array.isArray(original[key]) && original[key].includes(receipt.instanceId),
    );
    if (classifications.length !== 1 || classifications[0] !== states.get(receipt.instanceId))
      throw new Error('Conflicting original and merged official summary');
    originals.set(receipt.instanceId, receipt);
  }
  const rows = await readDataset(path.join(batch, 'results.jsonl'));
  if (
    rows.length !== ids.length ||
    new Set(rows.map((r) => r.instanceId)).size !== ids.length ||
    rows.some((r) => !ids.includes(r.instanceId) || r.configHash !== manifest.configHash)
  )
    throw new Error('Batch instance/config mismatch');
  const evaluated = [];
  for (const row of rows) {
    const pred = predictions.find((r) => r.instance_id === row.instanceId);
    const model = pred.model_name_or_path.replaceAll('/', '__');
    if (model.includes('\\') || !/^[\w.-]+__[\w.-]+-\d+$/.test(row.instanceId))
      throw new Error('Unsafe official report identity');
    const reportRelative = path.join(
      'logs/run_evaluation',
      source.runId,
      model,
      row.instanceId,
      'report.json',
    );
    const reportFile = path.resolve(evaluation, reportRelative);
    const relative = path.relative(evaluation, reportFile);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Report path escapes evaluation');
    let bytes, report;
    try {
      bytes = await readFile(await evidenceFile(reportRelative));
      report = JSON.parse(bytes);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const verdict = report?.[row.instanceId]?.resolved,
      state = states.get(row.instanceId);
    const empty = pred.model_patch === '' || state === 'empty_patch_ids';
    if (empty && typeof verdict === 'boolean')
      throw new Error('An empty patch cannot have a graded official verdict');
    if (
      typeof verdict === 'boolean' &&
      ((verdict && state !== 'resolved_ids') || (!verdict && state !== 'unresolved_ids'))
    )
      throw new Error('Conflicting summary and official report');
    let evaluatedPatchSha256 = null;
    if (typeof verdict === 'boolean') {
      if (!originals.has(row.instanceId))
        throw new Error('Original official summary missing for graded instance');
      const actualPatch = await readFile(
        await evidenceFile(path.join(path.dirname(reportRelative), 'patch.diff')),
      );
      if (
        typeof pred.model_patch !== 'string' ||
        !actualPatch.equals(Buffer.from(pred.model_patch, 'utf8'))
      )
        throw new Error('Official evaluated patch differs from prediction');
      evaluatedPatchSha256 = hash(actualPatch);
    }
    const status = typeof verdict === 'boolean' ? (verdict ? 'resolved' : 'unresolved') : 'error';
    evaluated.push({
      ...row,
      evaluation: {
        status,
        reason:
          status === 'error'
            ? empty
              ? 'empty-patch-not-graded'
              : (summary.failure_reasons?.[row.instanceId] ?? 'missing-or-invalid-report')
            : null,
        report: typeof verdict === 'boolean' ? reportRelative.split(path.sep).join('/') : null,
        reportSha256: bytes ? hash(bytes) : null,
        summarySha256: hash(summaryBytes),
        originalSummary: originals.get(row.instanceId)?.path ?? null,
        originalSummarySha256: originals.get(row.instanceId)?.sha256 ?? null,
        evaluatedPatchSha256,
        predictionsSha256: source.predictionsSha256,
        evaluatorVersion: source.evaluatorVersion,
        runId: source.runId,
      },
    });
  }
  await writeFile(
    path.join(batch, 'results.evaluated.jsonl'),
    evaluated.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  return evaluated;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = namedArguments(process.argv.slice(2), ['batch', 'evaluation']);
    const rows = await ingestBatch({
      batchDirectory: args.batch,
      evaluationDirectory: args.evaluation,
    });
    console.log(
      JSON.stringify({
        instances: rows.length,
        resolved: rows.filter((r) => r.evaluation.status === 'resolved').length,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
