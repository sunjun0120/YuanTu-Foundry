/**
 * Rewrite the whole-turn snapshots (`tests/snapshots/*.json`) from a real run.
 *
 * A separate entry point rather than an env var in the test script, because `VAR=1 node …` is not how Windows
 * spells it and the test runner has to keep its own arguments.
 *
 * This is a deliberate act: the point of a snapshot is that a change to it is a reviewed change. Run it, then
 * read `git diff tests/snapshots` and check that every line is something you meant to happen.
 *
 * It formats what it wrote, because the recorder cannot: the test writes `JSON.stringify(snapshot, null, 2)`,
 * which expands a one-element array (`"toolCalls": [\n  "read_file"\n]`) where Prettier collapses it
 * (`"toolCalls": ["read_file"]`). That is a real papercut rather than a style opinion — `npm run check` starts
 * with `format:check`, so an unformatted snapshot turned the next full run red with a warning about JSON the
 * author never typed and a diff of 20 bytes they had to explain.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIsolation } from './test-isolation/environment.mjs';
import { settleProcesses } from './test-isolation/processes.mjs';

const output = mkdtempSync(path.join(tmpdir(), 'yuantu-snapshot-update-'));
const isolation = await createIsolation(output, 'tests/turn-snapshot.test.ts');

try {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', 'tests/turn-snapshot.test.ts'],
    { stdio: 'inherit', env: { ...isolation.env, FOUNDRY_TEST_GENERATE_SNAPSHOTS: '1' } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Snapshot generation failed: ${result.status}`);
  const violations = existsSync(isolation.violationPath)
    ? readFileSync(isolation.violationPath, 'utf8').trim()
    : '';
  if (violations) throw new Error(`Snapshot isolation violations: ${violations}`);
  const cleanup = await settleProcesses(isolation);
  if (!cleanup.clean)
    throw new Error(`Snapshot process cleanup failed: ${JSON.stringify(cleanup)}`);
  cpSync(isolation.env.FOUNDRY_TEST_ARTIFACTS, 'tests/snapshots', { recursive: true });
} finally {
  rmSync(output, { recursive: true, force: true });
}

const require = createRequire(import.meta.url);
const formatted = spawnSync(
  process.execPath,
  [require.resolve('prettier/bin/prettier.cjs'), '--write', 'tests/snapshots'],
  { stdio: 'inherit' },
);
if (formatted.error) throw formatted.error;
process.exit(formatted.status ?? 1);
