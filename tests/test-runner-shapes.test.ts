/**
 * The runner has to tell three shapes apart, and two of them look identical from the outside.
 *
 * A file that ran, a file a `--test-name-pattern` matched nothing in, and a file that exited before the harness
 * could summarise it all end a phase with a plausible-looking summary. What separates them is the **per-file**
 * summary: the first two write one (the filtered one with `tests: 0`), the third writes none at all. Measured on
 * this runtime before the rule was written, and asserted here so the rule keeps matching reality.
 *
 * The distinction is worth a test because the obvious rule 閳?"every file must report at least one test" 閳?is
 * wrong: it fails the filtered run a developer types to check a single case, and a gate that cries wolf gets
 * deleted. These fixtures are spawned through the real `scripts/run-tests.mjs`, so what is asserted is the
 * runner's behaviour and not a copy of its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(root, 'scripts', 'run-tests.mjs');

/** Run the real runner over one fixture and report what it said. */
function runRunner(args: string[]) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function fixtures(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-runner-shapes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = path.join(directory, 'runs.test.mjs');
  await writeFile(runs, "import test from 'node:test';\ntest('a case that runs', () => {});\n");
  const exits = path.join(directory, 'exits.test.mjs');
  await writeFile(
    exits,
    "import test from 'node:test';\nthrow new Error('top-level failure before any test');\ntest('never reached', () => {});\n",
  );
  /**
   * The fourth shape: no tests at all. The harness counts the file itself as a passing case, so this looks
   * nothing like a crash from the outside and a reader has to be told which one they are looking at.
   */
  const empty = path.join(directory, 'empty.test.mjs');
  await writeFile(empty, 'export {};\n');
  return { runs, exits, empty };
}

test('a file that runs to its summary is a passing run', async (t) => {
  const { runs } = await fixtures(t);
  const result = runRunner([runs]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Tests: 1 pass=1 fail=0/);
  assert.doesNotMatch(result.stdout, /produced no per-file summary/);
  assert.doesNotMatch(result.stdout, /reported no test cases/);
});

test('a filter that matches nothing is a passing run, and says so', async (t) => {
  const { runs } = await fixtures(t);
  const result = runRunner(['--test-name-pattern=no-such-test-anywhere', runs]);
  // This is the shape the naive rule would break: the file reports `tests: 0` because the filter selected
  // nothing, which is a correct run of that file rather than a file that went missing.
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /1 file\(s\) reported no test cases; a name\/skip filter was in effect\./,
  );
  assert.doesNotMatch(result.stdout, /produced no per-file summary/);
});

test('a file that exits before its summary is refused, whatever its exit code looked like', async (t) => {
  const { exits } = await fixtures(t);
  const result = runRunner([exits]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /produced no per-file summary/);
  assert.match(result.stderr, /exits\.test\.mjs \(failed before reporting\)/);
});

test('a file that declares no tests is refused for its own reason, not called a crash', async (t) => {
  const { empty } = await fixtures(t);
  const result = runRunner([empty]);
  // Node reports this file as a *passing* case, so a runner that only watched exit codes would call this run
  // green. There is no per-file summary, and the reason printed has to be the true one.
  assert.equal(result.code, 1);
  assert.match(result.stderr, /empty\.test\.mjs \(declares no tests\)/);
  assert.doesNotMatch(result.stderr, /failed before reporting/);
});
