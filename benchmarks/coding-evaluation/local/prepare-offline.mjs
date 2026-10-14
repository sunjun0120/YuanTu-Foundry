import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { captureSourceManifest, copyFiles, newDirectory } from '../materialize.mjs';
import { executeBatch } from '../run.mjs';

const [destination, batchId] = process.argv.slice(2);
if (!destination || !batchId)
  throw new Error('usage: prepare-offline.mjs <new scratch directory> <batchId>');
const directory = path.resolve(destination);
const source = process.cwd();
await newDirectory(directory);
const captured = await captureSourceManifest(source);
const snapshot = path.join(directory, 'source');
await copyFiles(source, snapshot, captured.files);
if (
  (await captureSourceManifest(source)).hash !== captured.hash ||
  (await captureSourceManifest(snapshot)).hash !== captured.hash
)
  throw new Error('Source changed while preparing the offline snapshot');
const example = JSON.parse(
  await readFile(new URL('../manifest.example.json', import.meta.url), 'utf8'),
);
const spec = { kind: 'snapshot', directory: snapshot, manifestSha256: captured.hash };
const manifest = { ...example, batchId, runtimeSource: spec, corpusSource: spec };
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    phase: 'snapshot-prepared',
    sourceHash: captured.hash,
    files: captured.files.length,
    live: false,
  }),
);
const result = await executeBatch(manifest, {
  live: false,
  dryRun: true,
  outputDirectory: path.join(directory, 'batch'),
  dependencySourceDirectory: source,
});
console.log(
  JSON.stringify({
    planned: result.planned.length,
    recorded: result.results.length,
    requests: 0,
    outcomes: result.summary.outcomes,
    directory,
    exitCode: result.exitCode,
  }),
);
process.exitCode = result.exitCode;
