/**
 * Run one evaluation batch, regenerating the freeze hash if the working tree moved underneath it.
 *
 * The tree this harness freezes is the live product working tree, which other sessions also edit. A snapshot hash
 * taken a moment before `freezeInputs` re-reads and re-hashes the same files therefore goes stale for reasons that
 * have nothing to do with the batch — and the plan is clear that a changed input must *block*, not be papered over.
 *
 * So the honest repair is to take a *new* hash and start again, which is exactly what a fresh batch means here: no
 * partial results are kept and no sample is reused. The configuration is rebuilt from the same override file each
 * time, so a retry cannot silently drop or widen the authorized budget. This loops only on the "input moved between
 * hashing and freezing" failure, only on the very first step (before any sample or paid request), and only a
 * bounded number of times; then it gives up and reports the block.
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const [config, overrides, batchId, out, endpoint, model, ...runArguments] = process.argv.slice(2);
if (!config || !overrides || !batchId || !out || !endpoint || !model)
  throw new Error(
    'usage: run-batch.mjs <config> <overrides.json> <batchId> <out> <endpointUrl> <model> [run.mjs args]',
  );
const root = path.resolve('.');
const attempts = Number(process.env.CE_FREEZE_ATTEMPTS ?? 6);
const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
for (let attempt = 1; attempt <= attempts; attempt++) {
  // A partial batch directory would make the next attempt fail for the wrong reason (run.mjs refuses to reuse a
  // directory), so it is removed before every attempt rather than only after a detected failure.
  await rm(path.resolve(out), { recursive: true, force: true });
  const generated = await run([
    'benchmarks/coding-evaluation/local/make-config.mjs',
    config,
    batchId,
    endpoint,
    model,
    overrides,
  ]);
  if (generated.code !== 0) {
    process.stderr.write(generated.stderr || generated.stdout);
    process.exit(2);
  }
  process.stdout.write(generated.stdout);
  const result = await run([
    'benchmarks/coding-evaluation/run.mjs',
    `--manifest=${config}`,
    `--out=${out}`,
    `--batch-id=${batchId}`,
    ...runArguments,
  ]);
  process.stdout.write(result.stdout);
  if (
    result.code !== 2 ||
    !/changed while freezing|Snapshot manifest hash mismatch/.test(result.stderr)
  ) {
    process.stderr.write(result.stderr);
    process.exit(result.code);
  }
  process.stderr.write(
    `freeze attempt ${attempt} lost its stable window; retrying with a fresh hash\n`,
  );
}
process.stderr.write('freeze could not obtain a stable input window\n');
process.exit(2);
