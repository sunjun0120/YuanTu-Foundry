#!/usr/bin/env node
/**
 * Freeze the production sources this plan changes, so "before" is an identity rather than a memory.
 *
 * The content comes from `git show HEAD:<path>`, never from the working tree — and that distinction is the whole
 * point. Run *after* the change, a working-tree copy would freeze the new code and call it the baseline, which is
 * the one thing a baseline may never be. HEAD is the state this work started from; the manifest records how many
 * paths the working tree had modified at freeze time, so a reader can see how much of the checkout was already in
 * motion.
 *
 * Two things this is not. It is not a snapshot of the whole tree: the checkout carries other tasks' uncommitted
 * work, session databases and scratch directories, and copying them would freeze somebody else's afternoon into a
 * measurement. And it is not `git archive HEAD` either: the allowlist is explicit, each file is verified against
 * the bytes it was taken from, and every one is recorded by SHA-256 in a manifest that is the actual artifact.
 *
 * Usage:
 *   node scripts/freeze-retrieval-baseline.mjs [--out=.scratch/retrieval-baseline] [--label=pre-change]
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { out: '.scratch/retrieval-baseline', label: 'pre-change' };
for (const arg of args) {
  if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
  else if (arg.startsWith('--label=')) options.label = arg.slice('--label='.length);
  else throw new Error(`Unsupported argument: ${arg}`);
}

/**
 * The files this plan owns.
 *
 * Deliberately narrow: the retrieval surfaces themselves, the tool modules that expose them, and the two
 * consumers whose behaviour the plan changes. A file this work does not touch has no business being pinned to a
 * baseline, and the narrower the list, the easier it is to notice when somebody changes one of them.
 */
const ALLOWLIST = [
  'packages/tools/files.ts',
  'packages/tools/file-search.ts',
  'packages/tools/search-worker.ts',
  'packages/tools/repo-map.ts',
  'packages/catalog/index.ts',
  'packages/knowledge/store.ts',
  'packages/core/prompt/notices.ts',
  'packages/protocol/settings.ts',
  'apps/desktop/tool-card-model.ts',
  'apps/desktop/tool-cards.ts',
  'apps/desktop/i18n.ts',
];

const out = path.resolve(options.out);
if (existsSync(out)) {
  // A freeze that silently overwrites the previous one is not a freeze.
  console.error(`Refusing to overwrite ${out}. Remove it, or pass a different --out.`);
  process.exit(1);
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const head = await git(['rev-parse', 'HEAD']);
const dirty = (await git(['status', '--porcelain=v1'])).split('\n').filter(Boolean).length;
const files = [];
const modifiedAtFreeze = [];

for (const file of ALLOWLIST) {
  // The committed bytes, which is what "before this work" means. A path that did not exist at HEAD is recorded
  // as such rather than silently skipped.
  let bytes;
  try {
    bytes = await gitBytes(['show', `HEAD:${file}`]);
  } catch {
    modifiedAtFreeze.push({ path: file, state: 'absent-at-head' });
    continue;
  }
  const target = path.join(out, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const copyHash = digest(await readFile(target));
  const sourceHash = digest(bytes);
  if (sourceHash !== copyHash) {
    // The plan asks for exactly this check: a copy that does not match its source is a baseline that measures
    // something nobody has seen.
    await rm(out, { recursive: true, force: true });
    console.error(`Copy verification failed for ${file}; the snapshot was removed.`);
    process.exit(1);
  }
  files.push({ path: file, sha256: sourceHash, bytes: bytes.length });
  const working = await git(['diff', '--name-only', '--', file]);
  if (working.trim()) modifiedAtFreeze.push({ path: file, state: 'modified-in-working-tree' });
}

const manifest = {
  label: options.label,
  frozenAt: new Date().toISOString(),
  source: 'git show HEAD:<path>',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  head,
  workingTreeModifiedPaths: dirty,
  modifiedAtFreeze,
  createdByThisWork: [
    'packages/search/',
    'packages/tools/search-backend.ts',
    'packages/tools/retrieval-metadata.ts',
  ],
  files,
};
await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Froze ${String(files.length)} file(s) from HEAD ${head.slice(0, 12)} into ${path.relative(root, out)}`,
);
for (const file of files) console.log(`  ${file.sha256.slice(0, 12)}  ${file.path}`);
if (modifiedAtFreeze.length)
  console.log(
    `Note: ${String(modifiedAtFreeze.length)} allowlisted path(s) already differed in the working tree at freeze time.`,
  );

function git(argv) {
  return new Promise((resolve, reject) =>
    execFile('git', argv, { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}
function gitBytes(argv) {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      argv,
      { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
