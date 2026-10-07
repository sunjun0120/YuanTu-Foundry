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

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', 'tests/turn-snapshot.test.ts'],
  { stdio: 'inherit', env: { ...process.env, UPDATE_SNAPSHOTS: '1' } },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const require = createRequire(import.meta.url);
const formatted = spawnSync(
  process.execPath,
  [require.resolve('prettier/bin/prettier.cjs'), '--write', 'tests/snapshots'],
  { stdio: 'inherit' },
);
if (formatted.error) throw formatted.error;
process.exit(formatted.status ?? 1);
