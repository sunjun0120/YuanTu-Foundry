import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [serialPath, parallelPath] = process.argv.slice(2);
if (!serialPath || !parallelPath)
  throw Error('Usage: node scripts/compare-test-runs.mjs <serial.ndjson> <parallel.ndjson>');
async function load(file) {
  const meta = JSON.parse(await readFile(file + '.meta.json', 'utf8'));
  const records = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(meta.complete, true, `${file}: incomplete execution`);
  assert.equal(meta.passed, true, `${file}: failed execution`);
  assert.equal(
    meta.filtered,
    false,
    `${file}: filtered execution is not a full equivalence baseline`,
  );
  assert.equal(
    meta.source?.digest,
    meta.sourceAfter?.digest,
    `${file}: sources changed during run`,
  );
  assert.ok(meta.source?.digest, `${file}: missing frozen source fingerprint`);
  for (const item of meta.files) {
    assert.equal(item.cleanup?.clean, true, `${file}: ${item.file} has cleanup failures`);
    assert.equal(item.violations?.length, 0, `${file}: ${item.file} has isolation violations`);
  }
  const cases = records
    .filter((record) => record.kind === 'case')
    .map((record) =>
      JSON.stringify([
        record.file?.replaceAll('\\', '/'),
        record.name,
        record.status,
        record.skipReason,
      ]),
    )
    .sort();
  return { meta, cases };
}
const serial = await load(serialPath),
  parallel = await load(parallelPath);
assert.equal(serial.meta.schedule, 'serial');
assert.equal(parallel.meta.schedule, 'partitioned');
assert.equal(
  serial.meta.source.digest,
  parallel.meta.source.digest,
  'Compared runs do not use identical sources',
);
assert.equal(
  serial.meta.node,
  parallel.meta.node,
  'Compared runs do not use identical Node runtimes',
);
assert.deepEqual(
  serial.meta.files.map((file) => file.file).sort(),
  parallel.meta.files.map((file) => file.file).sort(),
  'Requested file sets differ',
);
assert.deepEqual(serial.meta.resources, parallel.meta.resources, 'Resource declarations differ');
assert.deepEqual(serial.cases, parallel.cases, 'Case statuses or skip reasons differ');
console.log(
  JSON.stringify(
    {
      equivalent: true,
      files: serial.meta.files.length,
      cases: serial.cases.length,
      serialWallMs: serial.meta.wallMs,
      parallelWallMs: parallel.meta.wallMs,
      speedup: serial.meta.wallMs / parallel.meta.wallMs,
      serialPhases: serial.meta.phaseWall,
      parallelPhases: parallel.meta.phaseWall,
    },
    null,
    2,
  ),
);
