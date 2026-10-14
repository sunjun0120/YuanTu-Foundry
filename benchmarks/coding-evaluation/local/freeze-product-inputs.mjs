/**
 * Freeze the *product* inputs into an immutable directory a batch can be measured against.
 *
 * Why this exists: a batch freezes its inputs from `manifest.runtimeSource.directory`, and the plan requires it to
 * stop when that input changes. On a machine where more than one session edits the working tree, a freeze taken
 * straight from the repository never holds a stable window — the first live attempt here failed every retry with
 * `Snapshot manifest hash mismatch`. Copying the production inputs once, beside the repository, and recording the
 * hash removes that race: after this returns, nothing that happens in the checkout can move the measured input.
 *
 * `node_modules` is copied as a real directory on purpose. The harness takes its private, lockfile-bound install
 * from the runtime source and refuses a linked installation, so a junction here would be rejected later.
 *
 * Usage:
 *   node benchmarks/coding-evaluation/local/freeze-product-inputs.mjs <targetDirectory> [sourceDirectory]
 * The receipt (`snapshot.json`) is written beside the target directory and is what `build-config.mjs` needs.
 */
import path from 'node:path';
import { writeFile, mkdir, cp } from 'node:fs/promises';
import { captureSourceManifest, copyFiles } from '../materialize.mjs';

const target = path.resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error('usage: freeze-product-inputs.mjs <targetDirectory> [sourceDirectory]');
const root = path.resolve(process.argv[3] ?? '.');
const source = path.resolve(root);
await mkdir(path.dirname(target), { recursive: true });

const captured = await captureSourceManifest(source);
await copyFiles(source, target, captured.files);
await cp(path.join(source, 'node_modules'), path.join(target, 'node_modules'), {
  recursive: true,
  force: false,
  errorOnExist: false,
  dereference: false,
});

const after = await captureSourceManifest(target);
if (after.hash !== captured.hash)
  throw new Error('Snapshot copy does not reproduce the source manifest hash');
const receipt = {
  version: 1,
  kind: 'product-snapshot',
  directory: target,
  manifestSha256: after.hash,
  productionFiles: after.files.length,
  takenAt: new Date().toISOString(),
  sourceDirectory: source,
};
await writeFile(path.join(target, '..', 'snapshot.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
