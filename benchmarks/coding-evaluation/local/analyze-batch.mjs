/**
 * Read-only analysis of a batch: what each sample did to its target file, and what the checks said.
 *
 * It answers the question a report alone cannot: did the model *change anything*, or did it spend its budget and
 * leave the file exactly as it was seeded? "fixed" means the work tree matches the pristine corpus (the seeded
 * defect is gone), "untouched" means it still matches the seeded input byte for byte, and "edited" means the model
 * changed something in that file without restoring it.
 *
 * It never calls a model and never writes into the batch.
 *
 * Usage:
 *   node benchmarks/coding-evaluation/local/analyze-batch.mjs <batchDirectory> <snapshotDirectory> [harnessDirectory]
 */
import path from 'node:path';
import { readFile, access } from 'node:fs/promises';

const batch = path.resolve(process.argv[2] ?? '');
const snapshot = path.resolve(process.argv[3] ?? '');
const harness = path.resolve(process.argv[4] ?? path.join(import.meta.dirname, '..'));
if (!process.argv[2] || !process.argv[3])
  throw new Error(
    'usage: analyze-batch.mjs <batchDirectory> <snapshotDirectory> [harnessDirectory]',
  );
const { getCase } = await import(
  new URL('cases.mjs', `file:///${harness.replaceAll('\\', '/')}/`).href
);

const results = (await readFile(path.join(batch, 'results.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const rows = [];
for (const result of results) {
  const caseDef = getCase(result.caseId);
  const target = caseDef.seed?.path ?? caseDef.allowedPaths[0];
  const workFile = path.join(batch, 'work', result.sampleId, target);
  let verdict = 'no-work-tree';
  if (await exists(workFile)) {
    const work = await readFile(workFile, 'utf8');
    const corpus = await readFile(path.join(snapshot, target), 'utf8');
    if (caseDef.seed) {
      const newline = corpus.includes('\r\n') ? '\r\n' : '\n';
      const seeded = corpus.replace(
        caseDef.seed.before.replaceAll('\n', newline),
        caseDef.seed.after.replaceAll('\n', newline),
      );
      verdict = work === seeded ? 'untouched' : work === corpus ? 'fixed' : 'edited';
    } else {
      verdict = work === corpus ? 'untouched' : 'edited';
    }
  }
  rows.push({
    sample: result.sampleId,
    outcome: result.outcome,
    failureClass: result.failureClass,
    requests: result.requests,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cached: result.usage.cachedInputTokens,
    wallSeconds: Math.round(result.wallMs / 1000),
    checks: `${result.checks.filter((check) => check.passed).length}/${result.checks.length}`,
    failed: result.checks
      .filter((check) => !check.passed)
      .map((check) => check.id)
      .join(','),
    target,
    verdict,
  });
}

console.log(
  'sample        outcome   checks  verdict    req  inTok    outTok  cached   wallS  failed checks',
);
for (const row of rows)
  console.log(
    [
      row.sample.padEnd(13),
      String(row.outcome).padEnd(9),
      row.checks.padEnd(7),
      row.verdict.padEnd(10),
      String(row.requests ?? '-').padStart(4),
      String(row.inputTokens ?? '-').padStart(8),
      String(row.outputTokens ?? '-').padStart(7),
      String(row.cached ?? '-').padStart(7),
      String(row.wallSeconds).padStart(6),
      row.failed.slice(0, 52),
    ].join(' '),
  );

const tally = (key) =>
  rows.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0);
console.log('');
console.log(
  `recorded=${rows.length}  inputTokens=${tally('inputTokens')}  outputTokens=${tally('outputTokens')}  cachedInput=${tally('cached')}  requests=${tally('requests')}`,
);
const verdicts = {};
for (const row of rows) verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
console.log('target-file verdicts:', JSON.stringify(verdicts));
