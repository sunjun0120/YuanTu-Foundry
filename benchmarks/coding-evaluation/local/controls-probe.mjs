/**
 * Verify the case controls (original / degraded / reference) against a *stabilised* copy of the source tree.
 *
 * The evaluation freezes the live working tree, and that tree is edited by other sessions. A dry run started
 * against a moving tree either loses its freeze window or — worse — has samples marked tampered halfway through.
 * This probe first copies the tree to a scratch snapshot and re-checks that the copy matches the source, so the
 * only question left is whether the oracles themselves behave: original passes, degraded fails on a real
 * assertion, reference passes.
 *
 * It makes no model request and is not a substitute for `run.mjs`: it exists to separate "the grader is wrong"
 * from "the workspace would not hold still".
 */
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { captureSourceManifest, copyFiles, freezeInputs } from '../materialize.mjs';
import { preparePrivateDependencies } from '../dependencies.mjs';
import { selfCheckCorpus } from '../verify.mjs';

const [out = '.scratch/ce-controls-probe'] = process.argv.slice(2);
const root = path.resolve('.');
const output = path.resolve(out);
const snapshot = path.join(output, 'snapshot');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const first = await captureSourceManifest(root);
await copyFiles(root, snapshot, first.files);
const second = await captureSourceManifest(root);
const third = await captureSourceManifest(snapshot);
const stable = first.hash === second.hash && third.hash === first.hash;
console.log(
  JSON.stringify({
    sourceFiles: first.files.length,
    sourceHash: first.hash,
    copyHash: third.hash,
    stable,
    drifted:
      first.hash === second.hash
        ? []
        : first.files
            .filter((file, index) => file.sha256 !== second.files[index]?.sha256)
            .map((file) => file.path)
            .slice(0, 20),
  }),
);
if (!stable) {
  console.error('the source tree changed while it was being copied; controls were not run');
  process.exit(2);
}
const source = { kind: 'snapshot', directory: snapshot, manifestSha256: first.hash };
const frozen = await freezeInputs({
  runtimeSource: source,
  corpusSource: source,
  outputDirectory: path.join(output, 'frozen'),
});
/**
 * The same private-installation step `run.mjs` performs before any control runs: without it every case is blocked
 * on a missing receipt rather than on its own behaviour, which would say nothing about the graders.
 */
const dependencies = path.join(output, 'dependencies');
await mkdir(dependencies, { recursive: true });
for (const file of ['package.json', 'package-lock.json'])
  await writeFile(path.join(dependencies, file), await readFile(path.join(root, file)), {
    flag: 'wx',
  });
await preparePrivateDependencies({ targetDirectory: dependencies, sourceDirectory: root });
await preparePrivateDependencies({
  targetDirectory: frozen.runtimeDirectory,
  sourceDirectory: dependencies,
});
const started = Date.now();
const controls = await selfCheckCorpus(frozen, path.join(output, 'controls'));
for (const control of controls)
  console.log(
    JSON.stringify({
      caseId: control.caseId,
      status: control.status,
      reason: control.reason,
      variants: (control.controls ?? []).map((entry) => `${entry.variant}=${entry.passed}`),
    }),
  );
await writeFile(
  path.join(output, 'probe.json'),
  JSON.stringify(
    {
      version: 1,
      live: false,
      requests: 0,
      sourceHash: first.hash,
      controls,
      elapsedMs: Date.now() - started,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    elapsedMs: Date.now() - started,
    certified: controls.filter((control) => control.status === 'full-controls-certified').length,
    total: controls.length,
  }),
);
