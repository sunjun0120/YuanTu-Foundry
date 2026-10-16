import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const emptyCounts = () => ({
  tests: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  todo: 0,
});
export function sumCounts(summaries) {
  const counts = emptyCounts();
  for (const summary of summaries)
    for (const key of Object.keys(counts)) counts[key] += summary?.counts?.[key] ?? 0;
  return counts;
}

/** A terminal record and an actual per-file summary are required, even after exit 0. */
export async function readFileReport(target, file, root) {
  let records;
  try {
    const source = await readFile(target, 'utf8');
    if (!source.endsWith('\n')) throw Error('truncated report');
    records = source
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    return { problem: `No complete timings report for ${file}`, records: [] };
  }
  const summaries = records.filter((record) => record.kind === 'run-summary');
  if (records.at(-1)?.kind !== 'phase-summary' || summaries.length !== 1)
    return { problem: `No complete timings report for ${file}`, records };
  const absolute = path.resolve(root, file);
  const files = records.filter(
    (record) => record.kind === 'file-summary' && path.resolve(root, record.file) === absolute,
  );
  if (files.length !== 1) {
    const failed = records.some((record) => record.kind === 'case' && record.status === 'failed');
    return {
      problem: `1 test file(s) produced no per-file summary: ${path.basename(file)} (${failed ? 'failed before reporting' : 'declares no tests'})`,
      records,
    };
  }
  return {
    records,
    summary: summaries[0],
    fileSummary: files[0],
    zeroTestFiles: files[0].counts.tests === 0 ? 1 : 0,
  };
}

export function mergeReports(results, phaseWall) {
  const records = results.flatMap((result) =>
    result.report.records.filter(
      (record) => !['run-summary', 'phase-summary'].includes(record.kind),
    ),
  );
  const counts = sumCounts(results.map((result) => result.report.summary));
  records.push({
    schemaVersion: 1,
    kind: 'run-summary',
    phase: null,
    file: null,
    counts,
    durationMs: Object.values(phaseWall).reduce((a, b) => a + b, 0),
  });
  for (const [phase, durationMs] of Object.entries(phaseWall))
    records.push({
      schemaVersion: 1,
      kind: 'phase-summary',
      phase,
      file: null,
      durationMs,
      counts: sumCounts(
        results.filter((result) => result.phase === phase).map((result) => result.report.summary),
      ),
    });
  return { records, counts };
}

export async function writeMergedReport(target, merged, metadata) {
  if (!target) return;
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await writeFile(target, merged.records.map((record) => JSON.stringify(record) + '\n').join(''));
  await writeFile(`${target}.meta.json`, JSON.stringify(metadata, null, 2) + '\n');
}
