// tests/analysis-source.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stageSourceArchive } from '../apps/desktop/analysis-source.ts';
import { tempRoot } from './temp-fixture.ts';

/** A file the way the renderer's drag-and-drop hands one over: a real path outside the workspace. */
async function sourceFile(t: Parameters<typeof tempRoot>[0], name: string): Promise<string> {
  const directory = await tempRoot(t);
  const file = path.join(directory, name);
  await writeFile(file, 'one');
  return file;
}

test(
  'a dropped archive is copied under analysis-inputs without replacing an earlier one',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await tempRoot(t);
    const source = await sourceFile(t, 'app.tar.gz');
    const first = await stageSourceArchive(root, 'app.tar.gz', { path: source });
    await writeFile(source, 'two');
    const second = await stageSourceArchive(root, 'app.tar.gz', { path: source });
    assert.deepEqual(first, { path: 'analysis-inputs/app.tar.gz', size: 3 });
    assert.deepEqual(second, { path: 'analysis-inputs/app-1.tar.gz', size: 3 });
    assert.equal(await readFile(path.join(root, 'analysis-inputs', 'app.tar.gz'), 'utf8'), 'one');
  },
);

test(
  'a pasted archive with no path is written from its bytes',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await tempRoot(t);
    const staged = await stageSourceArchive(root, 'app.zip', { data: Buffer.from('PK') });
    assert.deepEqual(staged, { path: 'analysis-inputs/app.zip', size: 2 });
    assert.equal(await readFile(path.join(root, 'analysis-inputs', 'app.zip'), 'utf8'), 'PK');
  },
);

test(
  'names that are not archives, carry a path or are empty are refused',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await tempRoot(t);
    for (const name of ['notes.txt', '../app.zip', 'dir/app.zip', 'a:b.zip'])
      await assert.rejects(stageSourceArchive(root, name, { data: Buffer.from('x') }));
    await assert.rejects(stageSourceArchive(root, 'app.zip', { data: new Uint8Array() }));
    await assert.rejects(
      stageSourceArchive(root, 'app.zip', { path: path.join(await tempRoot(t), 'missing.zip') }),
    );
  },
);

test(
  'a source path that is not the named archive is refused before anything is read',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await tempRoot(t);
    // What a compromised renderer would send: an archive-looking name over some other file on the disk.
    const secret = await sourceFile(t, 'id_rsa');
    const other = await sourceFile(t, 'other.zip');
    await assert.rejects(stageSourceArchive(root, 'app.zip', { path: secret }));
    await assert.rejects(stageSourceArchive(root, 'app.zip', { path: other }));
    await assert.rejects(stageSourceArchive(root, 'other.zip', { path: 'other.zip' }));
    await assert.rejects(readFile(path.join(root, 'analysis-inputs', 'app.zip')));
  },
);

test(
  'a linked source file or a linked analysis-inputs directory is refused',
  { skip: process.platform === 'win32' ? 'symlink creation needs privileges on Windows' : false },
  async (t) => {
    const root = await tempRoot(t);
    const outside = await tempRoot(t);
    const linkedInputs = await tempRoot(t);
    const real = path.join(outside, 'real.zip');
    await writeFile(real, 'x');
    const link = path.join(outside, 'link.zip');
    await symlink(real, link);
    await assert.rejects(stageSourceArchive(root, 'link.zip', { path: link }));
    await symlink(outside, path.join(linkedInputs, 'analysis-inputs'));
    await assert.rejects(stageSourceArchive(linkedInputs, 'app.zip', { path: real }));
  },
);

test(
  'a Windows junction at analysis-inputs is refused',
  { skip: process.platform !== 'win32' ? 'Windows junction behavior' : false },
  async (t) => {
    const root = await tempRoot(t);
    const outside = await tempRoot(t);
    const source = await sourceFile(t, 'app.zip');
    await symlink(outside, path.join(root, 'analysis-inputs'), 'junction');
    await assert.rejects(stageSourceArchive(root, 'app.zip', { path: source }));
  },
);

test(
  'a source archive under a junction is refused',
  { skip: process.platform !== 'win32' ? 'Windows junction behavior' : false },
  async (t) => {
    const root = await tempRoot(t);
    const outside = await tempRoot(t);
    const parent = await tempRoot(t);
    await writeFile(path.join(outside, 'app.zip'), 'private');
    const link = path.join(parent, 'linked');
    await symlink(outside, link, 'junction');
    await assert.rejects(stageSourceArchive(root, 'app.zip', { path: path.join(link, 'app.zip') }));
  },
);
