/**
 * The schedule's own regression: what may overlap, what may not, and what happens when a reviewed
 * file changes underneath the review.
 *
 * These are pure-fixture tests. They never start the suite, so they assert the classification rules
 * directly instead of inferring them from how long a run took.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EMPTY_POLICY,
  discoverTests,
  loadPolicy,
  normalizeRepoPath,
  partitionTests,
  validatePolicy,
  type ParallelPolicy,
} from '../scripts/test-execution-policy.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function tree(t: { after: (fn: () => Promise<void>) => void }, files: Record<string, string>) {
  return (async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-policy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    return root;
  })();
}

/**
 * A hash stand-in keyed by basename, so a fixture can say "these files still match" without the
 * test re-deriving the reviewer's digests. Declared with `function` so it hoists above the fixtures
 * that use it.
 */
function hashOf(files: Record<string, string>, changed: string[] = []) {
  return async (absolutePath: string) => {
    const name = path.basename(absolutePath);
    const key = Object.keys(files).find((file) => path.basename(file) === name);
    if (!key) throw new Error(`unexpected file: ${absolutePath}`);
    return changed.includes(key) ? sha256('something else') : sha256(files[key]!);
  };
}

test('discovery is the sorted top-level tests/*.test.ts set and ignores everything else', async (t) => {
  const root = await tree(t, {
    'tests/b.test.ts': 'export {};',
    'tests/a.test.ts': 'export {};',
    'tests/a.test.mjs': 'export {};',
    'tests/helper.ts': 'export {};',
    'tests/nested/c.test.ts': 'export {};',
    'packages/z.test.ts': 'export {};',
  });
  assert.deepEqual(await discoverTests(root), ['tests/a.test.ts', 'tests/b.test.ts']);
});

test('discovery of the real repository is exactly the files the default entry point runs', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const discovered = await discoverTests(root);
  assert.ok(discovered.length > 100, `expected a large suite, got ${discovered.length}`);
  assert.deepEqual(discovered, [...discovered].sort());
  for (const file of discovered) assert.match(file, /^tests\/[^/]+\.test\.ts$/);
});

test('a file with no reviewed entry is serial, and the reason says why', async (t) => {
  const root = await tree(t, { 'tests/a.test.ts': 'export {};' });
  const partition = await partitionTests(['tests/a.test.ts', 'tests/b.test.ts'], {
    root,
    policy: EMPTY_POLICY,
    hashFile: async () => sha256(''),
  });
  assert.deepEqual(partition.parallel, []);
  assert.deepEqual(partition.serial, ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.match(partition.reasons['tests/a.test.ts']!, /not reviewed/);
});

test('a reviewed entry is parallel only while every reviewed input still matches', async (t) => {
  const files = {
    'tests/a.test.ts': "import './a-fixture.ts';",
    'tests/a-fixture.ts': 'export const one = 1;',
  };
  const root = await tree(t, files);
  const policy: ParallelPolicy = {
    version: 1,
    entries: [
      {
        file: 'tests/a.test.ts',
        reason: 'fixture review: temporary directory only',
        inputs: [
          { file: 'tests/a.test.ts', sha256: sha256(files['tests/a.test.ts']) },
          { file: 'tests/a-fixture.ts', sha256: sha256(files['tests/a-fixture.ts']) },
        ],
      },
    ],
  };
  const unchanged = await partitionTests(['tests/a.test.ts', 'tests/b.test.ts'], {
    root,
    policy,
    hashFile: hashOf(files),
  });
  assert.deepEqual(unchanged.parallel, ['tests/a.test.ts']);
  assert.deepEqual(unchanged.serial, ['tests/b.test.ts']);
  assert.equal(unchanged.reasons['tests/a.test.ts'], 'fixture review: temporary directory only');

  // A fixture the review read changes: the entry is no longer a claim about the code on disk.
  const drifted = await partitionTests(['tests/a.test.ts'], {
    root,
    policy,
    hashFile: hashOf(files, ['tests/a-fixture.ts']),
  });
  assert.deepEqual(drifted.parallel, []);
  assert.deepEqual(drifted.serial, ['tests/a.test.ts']);
  assert.match(drifted.reasons['tests/a.test.ts']!, /changed since review/);

  // A reviewed input that is gone is a change too, not a pass.
  const missing = await partitionTests(['tests/a.test.ts'], {
    root,
    policy,
    hashFile: async (absolutePath) => {
      if (absolutePath.endsWith('a-fixture.ts')) throw new Error('ENOENT');
      return sha256(files['tests/a.test.ts']);
    },
  });
  assert.deepEqual(missing.parallel, []);
  assert.match(missing.reasons['tests/a.test.ts']!, /missing/);
});

test('the two phases never overlap and together are exactly the input', async (t) => {
  const files = {
    'tests/a.test.ts': 'export {};',
    'tests/b.test.ts': 'export {};',
    'tests/c.test.ts': 'export {};',
  };
  const root = await tree(t, files);
  const policy: ParallelPolicy = {
    version: 1,
    entries: [
      {
        file: 'tests/b.test.ts',
        reason: 'fixture review: no shared resource',
        inputs: [{ file: 'tests/b.test.ts', sha256: sha256(files['tests/b.test.ts']) }],
      },
    ],
  };
  const input = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
  const { parallel, serial, reasons } = await partitionTests(input, {
    root,
    policy,
    hashFile: hashOf(files),
  });
  const union = [...parallel, ...serial].sort();
  assert.deepEqual(union, [...input].sort());
  assert.equal(new Set(union).size, union.length, 'no file appears in both phases');
  for (const file of input) assert.ok(reasons[file], `${file} has no recorded reason`);
});

test('a policy that points outside the suite, repeats itself or is malformed is a hard error', async () => {
  const discovered = ['tests/a.test.ts', 'tests/b.test.ts'];
  const digest = sha256('');
  const entry = (overrides: Record<string, unknown>) => ({
    file: 'tests/a.test.ts',
    reason: 'reviewed',
    inputs: [{ file: 'tests/a.test.ts', sha256: digest }],
    ...overrides,
  });
  assert.throws(() => validatePolicy({ version: 2, entries: [] }, discovered), /version must be 1/);
  assert.throws(() => validatePolicy({ version: 1 }, discovered), /entries must be an array/);
  assert.throws(
    () =>
      validatePolicy(
        { version: 1, entries: [entry({ file: 'tests/missing.test.ts' })] },
        discovered,
      ),
    /not a discovered test/,
  );
  assert.throws(
    () =>
      validatePolicy({ version: 1, entries: [entry({ file: '../escape.test.ts' })] }, discovered),
    /must be a top-level test file/,
  );
  assert.throws(
    () => validatePolicy({ version: 1, entries: [entry({}), entry({})] }, discovered),
    /listed twice/,
  );
  assert.throws(
    () => validatePolicy({ version: 1, entries: [entry({ reason: '  ' })] }, discovered),
    /reason/,
  );
  assert.throws(
    () => validatePolicy({ version: 1, entries: [entry({ inputs: [] })] }, discovered),
    /inputs must list/,
  );
  assert.throws(
    () =>
      validatePolicy(
        { version: 1, entries: [entry({ inputs: [{ file: 'tests/a.test.ts', sha256: 'nope' }] })] },
        discovered,
      ),
    /sha256/,
  );
  // The reviewed inputs must include the test itself: a review that read only a helper has not read
  // the file whose concurrency it is approving.
  assert.throws(
    () =>
      validatePolicy(
        { version: 1, entries: [entry({ inputs: [{ file: 'tests/helper.ts', sha256: digest }] })] },
        discovered,
      ),
    /include the test file itself/,
  );
  assert.throws(
    () =>
      validatePolicy(
        { version: 1, entries: [entry({ inputs: [{ file: '/etc/hosts', sha256: digest }] })] },
        discovered,
      ),
    /escapes the repository/,
  );
});

test('an absent policy file means everything is serial; a corrupt one is refused', async (t) => {
  const root = await tree(t, { 'tests/a.test.ts': 'export {};' });
  assert.deepEqual(await loadPolicy(root, ['tests/a.test.ts']), EMPTY_POLICY);
  await writeFile(path.join(root, 'test-parallel-safe.json'), '{ not json');
  await assert.rejects(loadPolicy(root, ['tests/a.test.ts']), /not valid JSON/);
  await writeFile(path.join(root, 'test-parallel-safe.json'), '{"version":1,"entries":[{}]}');
  await assert.rejects(loadPolicy(root, ['tests/a.test.ts']), /Invalid parallel-safe policy/);
});

test('the shipped policy is valid against the shipped suite', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const discovered = await discoverTests(root);
  const policy = await loadPolicy(root, discovered);
  assert.equal(policy.version, 1);
  // Whatever the review concluded, it must be expressible: the partition it produces covers the
  // whole suite exactly once, every entry carries a human-readable reason, and nothing is claimed
  // about a file the shipped suite does not have. `strictFiles: false` because a reviewer's entry
  // for a test that has since been deleted must fall out of the partition rather than fail the
  // whole run — the fallback is serial, which is the safe direction.
  const { parallel, serial, reasons } = await partitionTests(discovered, {
    root,
    policy,
    strictFiles: false,
  });
  assert.deepEqual([...parallel, ...serial].sort(), discovered);
  for (const entry of policy.entries) assert.ok(entry.reason.trim());
  for (const file of discovered) assert.ok(reasons[file]);
  for (const file of parallel) assert.ok(policy.entries.some((entry) => entry.file === file));
});

test('paths are normalised so a Windows separator cannot smuggle a file past the review', () => {
  assert.equal(normalizeRepoPath('.\\tests\\a.test.ts'), 'tests/a.test.ts');
  assert.equal(normalizeRepoPath('./tests/a.test.ts'), 'tests/a.test.ts');
  assert.equal(normalizeRepoPath('tests/a.test.ts'), 'tests/a.test.ts');
});
