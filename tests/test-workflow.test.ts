import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot } from './process-fixture.ts';

const exec = promisify(execFile);

async function tree(
  t: { after: (fn: () => Promise<void>) => void },
  files: Record<string, string>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-test-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

test('quiet runner retains successful output in a log without printing each passing test', async (t) => {
  const root = await tree(t, {
    'pass.test.mjs':
      "import test from 'node:test'; test('passing case', () => console.log('fixture output'));",
  });
  const { stdout } = await exec(
    process.execPath,
    ['scripts/run-tests.mjs', path.join(root, 'pass.test.mjs')],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.match(stdout, /pass=1 fail=0/);
  assert.doesNotMatch(stdout, /passing case|fixture output/);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
  assert.match(await readFile(log, 'utf8'), /fixture output/);
});

test('quiet runner reports the failing assertion and preserves a nonzero exit code', async (t) => {
  const root = await tree(t, {
    'fail.test.mjs':
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('broken fixture', () => assert.equal(1, 2));",
  });
  await assert.rejects(
    exec(process.execPath, ['scripts/run-tests.mjs', path.join(root, 'fail.test.mjs')], {
      cwd: projectRoot,
      windowsHide: true,
    }),
    (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.match(result.stdout, /broken fixture/);
      assert.match(result.stdout, /1 !== 2/);
      assert.match(result.stdout, /fail=1/);
      const log = /Log: (.+)/.exec(result.stdout)?.[1]?.trim();
      assert.ok(log);
      t.after(() => rm(log, { force: true }));
      return true;
    },
  );
});

test('changed selection follows transitive imports and literal worker paths', async (t) => {
  const root = await tree(t, {
    'packages/example/leaf.ts': 'export const value = 1;',
    'packages/example/index.ts': "export { value } from './leaf.ts';",
    'packages/example/worker.ts': 'console.log(1);',
    'tests/consumer.test.ts': "import { value } from '../packages/example/index.ts';",
    'tests/worker.test.ts':
      "const worker = new URL('../packages/example/worker.ts', import.meta.url);",
    'tests/unrelated.test.ts': 'export {};',
  });
  const { selectTests } = await import('../scripts/select-tests.ts');
  assert.deepEqual((await selectTests(root, ['packages/example/leaf.ts'])).tests, [
    'tests/consumer.test.ts',
  ]);
  assert.deepEqual((await selectTests(root, ['packages/example/worker.ts'])).tests, [
    'tests/worker.test.ts',
  ]);
});

test('unmapped files, deleted source and shared contracts fall back to all tests', async (t) => {
  const root = await tree(t, {
    'tests/a.test.ts': 'export {};',
    'tests/b.test.ts': 'export {};',
    'packages/example/new.ts': 'export {};',
    'packages/protocol/rpc.ts': 'export {};',
  });
  const { selectTests } = await import('../scripts/select-tests.ts');
  for (const changed of [
    'package-lock.json',
    'packages/example/deleted.ts',
    'packages/example/new.ts',
    'packages/protocol/rpc.ts',
  ]) {
    const selection = await selectTests(root, [changed]);
    assert.deepEqual(selection.tests, ['tests/a.test.ts', 'tests/b.test.ts']);
    assert.equal(selection.full, true);
  }
});

test('documentation changes select no behavior tests and changed tests select themselves', async (t) => {
  const root = await tree(t, { 'tests/a.test.ts': 'export {};', 'docs/guide.md': 'Guide' });
  const { selectTests } = await import('../scripts/select-tests.ts');
  assert.deepEqual((await selectTests(root, ['docs/guide.md'])).tests, []);
  assert.deepEqual((await selectTests(root, ['tests/a.test.ts'])).tests, ['tests/a.test.ts']);
});

test('shared smoke helpers select full verification including the desktop gate', async (t) => {
  const root = await tree(t, {
    'tests/a.test.ts': "import './page-wait.mjs';",
    'tests/b.test.ts': 'export {};',
    'tests/page-wait.mjs': 'export {};',
  });
  const { selectTests, requiresDesktop } = await import('../scripts/select-tests.ts');
  const selection = await selectTests(root, ['tests/page-wait.mjs']);
  assert.equal(selection.full, true);
  assert.deepEqual(selection.tests, ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.equal(requiresDesktop(['tests/page-wait.mjs']), true);
  assert.equal(requiresDesktop(['tests/a.test.ts']), false);
});

test('quiet runner keeps skip reasons and test-name filtering visible', async (t) => {
  const root = await tree(t, {
    'skip.test.mjs':
      "import test from 'node:test'; test('optional case', { skip: 'fixture dependency absent' }, () => {}); test('chosen case', () => {}); test('excluded case', () => { throw new Error('must be filtered'); });",
  });
  const { stdout } = await exec(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      '--test-name-pattern=optional|chosen',
      path.join(root, 'skip.test.mjs'),
    ],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.match(stdout, /pass=1 fail=0 skip=1/);
  assert.match(stdout, /fixture dependency absent/);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
});

test('changed discovery includes staged, unstaged, deleted and untracked files but excludes ignored files', async (t) => {
  const root = await tree(t, {
    '.gitignore': 'ignored.txt\n',
    'staged.txt': 'before',
    'unstaged.txt': 'before',
    'deleted.txt': 'before',
  });
  const git = (args: string[]) => exec('git', args, { cwd: root, windowsHide: true });
  await git(['init', '--template=']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--no-verify',
    '-m',
    'baseline',
  ]);
  await writeFile(path.join(root, 'staged.txt'), 'after');
  await git(['add', 'staged.txt']);
  await writeFile(path.join(root, 'unstaged.txt'), 'after');
  await rm(path.join(root, 'deleted.txt'));
  await writeFile(path.join(root, 'new.txt'), 'new');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored');
  const { getChangedFiles } = await import('../scripts/select-tests.ts');
  assert.deepEqual(await getChangedFiles(root), [
    'deleted.txt',
    'new.txt',
    'staged.txt',
    'unstaged.txt',
  ]);
  await assert.rejects(getChangedFiles(root, 'nonexistent-baseline'));
});
