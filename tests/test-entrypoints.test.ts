import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempRoot } from './temp-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
test('public test and coverage entrypoints retain the isolated scheduler', async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const name of [
    'test',
    'test:serial',
    'test:partitioned',
    'test:verbose',
    'smoke:client',
    'smoke:desktop',
  ]) {
    assert.match(scripts[name], /node scripts\/run-tests\.mjs(?:\s|$)/, name);
    assert.doesNotMatch(scripts[name], /node --test/, name);
  }
  assert.equal(scripts.coverage, 'node scripts/test-coverage.mjs');
  assert.match(
    await readFile(path.join(root, 'scripts/test-coverage.mjs'), 'utf8'),
    /scripts\/run-tests\.mjs/,
  );
  assert.match(scripts['test:serial'], /--schedule=serial/);
  assert.match(scripts['test:verbose'], /--verbose/);
  assert.match(scripts.check, /npm run test:isolation:check/);
  assert.equal(scripts['test:isolation:check'], 'node scripts/check-test-isolation.mjs');
  await assert.rejects(access(path.join(root, 'test-parallel-safe.json')), { code: 'ENOENT' });
});

test('development check entrypoints include isolation lint', async () => {
  assert.match(
    await readFile(path.join(root, 'scripts/check-changed.mjs'), 'utf8'),
    /'test:isolation:check'/,
  );
  assert.match(
    await readFile(path.join(root, 'scripts/check-related.mjs'), 'utf8'),
    /lintTestIsolation\(root\)/,
  );
});

// Pending execution while the user has paused validation. These fixtures exercise the actual
// native merger so line-only approximations and duplicate source denominators cannot pass.
test('coverage unions complementary source ranges before enforcing aggregate floors', async (t) => {
  const directory = await tempRoot(t, 'yuantu-coverage-union-');
  const raw = path.join(directory, 'raw');
  await mkdir(raw);
  const source = 'function a() { return 1; }\nfunction b() { return 2; }\na(); b();\n';
  const file = path.join(directory, 'source.js');
  await writeFile(file, source);
  const split = source.indexOf('function b');
  const end = source.indexOf('\na();');
  const profile = (first: number, second: number) => ({
    result: [
      {
        scriptId: '1',
        url: pathToFileURL(file).href,
        functions: [
          {
            functionName: '',
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
          },
          {
            functionName: 'a',
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: split - 1, count: first }],
          },
          {
            functionName: 'b',
            isBlockCoverage: true,
            ranges: [{ startOffset: split, endOffset: end, count: second }],
          },
        ],
      },
    ],
  });
  await writeFile(path.join(raw, 'coverage-1-1792137000000-0.json'), JSON.stringify(profile(1, 0)));
  await writeFile(path.join(raw, 'coverage-2-1792137000001-0.json'), JSON.stringify(profile(0, 1)));
  const result = spawnSync(
    process.execPath,
    ['--expose-internals', path.join(root, 'scripts/test-coverage.mjs'), '--aggregate', raw],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const summary = JSON.parse(await readFile(path.join(directory, 'coverage-summary.json'), 'utf8'));
  assert.equal(summary.files.length, 1);
  assert.equal(summary.totals.coveredFunctionPercent, 100);
  assert.equal(summary.totals.coveredBranchPercent, 100);
  assert.equal(summary.totals.totalFunctionCount, 2);
});

test('coverage refuses absent raw evidence instead of reporting vacuous success', async (t) => {
  const raw = await tempRoot(t, 'yuantu-coverage-missing-');
  const result = spawnSync(
    process.execPath,
    ['--expose-internals', path.join(root, 'scripts/test-coverage.mjs'), '--aggregate', raw],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No raw V8 coverage reports/);
});
