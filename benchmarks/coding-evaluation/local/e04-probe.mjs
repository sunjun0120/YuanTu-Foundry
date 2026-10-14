import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { copyFiles, freezeInputs } from '../materialize.mjs';
import { getCase, exactReplace } from '../cases.mjs';
import { captureSourceManifest } from '../materialize.mjs';

const root = path.resolve('.');
const scratch = await mkdtemp(path.join(root, '.scratch', 'ce-e04-'));
const files = await captureSourceManifest(root);
await copyFiles(root, path.join(scratch, 'snapshot'), files.files);
const frozen = await freezeInputs({
  runtimeSource: {
    kind: 'snapshot',
    directory: path.join(scratch, 'snapshot'),
    manifestSha256: files.hash,
  },
  corpusSource: {
    kind: 'snapshot',
    directory: path.join(scratch, 'snapshot'),
    manifestSha256: files.hash,
  },
  outputDirectory: path.join(scratch, 'frozen'),
});
const source = await readFile(path.join(root, 'packages/tools/present.ts'), 'utf8');
const copied = await readFile(
  path.join(frozen.corpusDirectory, 'packages/tools/present.ts'),
  'utf8',
);
const copied2 = await readFile(
  path.join(frozen.runtimeDirectory, 'packages/tools/present.ts'),
  'utf8',
);
const seed = getCase('E04').seed;
const report = (label, text) => {
  const needle = seed.before.replaceAll('\n', text.includes('\r\n') ? '\r\n' : '\n');
  console.log(
    label,
    JSON.stringify({
      occurrences: text.split(needle).length - 1,
      crlf: text.includes('\r\n'),
      identicalToSource: text === source,
      firstIndex: text.indexOf('if (seen.has(evidence.path))'),
      slice: JSON.stringify(
        text.slice(
          text.indexOf('if (seen.has(evidence.path))') - 20,
          text.indexOf('if (seen.has(evidence.path))') + 130,
        ),
      ),
    }),
  );
};
report('source  ', source);
report('corpus  ', copied);
report('runtime ', copied2);
try {
  await exactReplace(frozen.corpusDirectory, seed.path, seed.before, seed.after);
  console.log('exactReplace on corpus: ok');
} catch (error) {
  console.log('exactReplace on corpus failed:', error.message);
}
await rm(scratch, { recursive: true, force: true });
